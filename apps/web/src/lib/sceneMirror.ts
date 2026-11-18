/**
 * Values on the model are drawn into the picture (the viewport's scene texts), so they turn with it in
 * the same frame. Their elements on the page stay where they are, invisible, to be clicked, dragged
 * and edited; this copies an element's look (font, colours, chip) into the scene, laid in its plane or
 * facing the screen where the element is.
 */
import type { Quad, SceneTextSpec, TextLook, Viewport } from "@meercad/viewport";

type V3 = readonly [number, number, number];

/** Elements shown as a copy in the scene are hidden on the page (styles.css). */
export const IN_SCENE = "in-scene";

/** A chip without the blur behind it on the page needs a firmer fill to read as well. */
const MIN_CHIP_ALPHA = 0.97;

/** An rgb()/rgba() colour's parts, or null for any other colour. */
export function rgba(color: string): [number, number, number, number] | null {
  const m = /^rgba?\(([^)]*)\)$/.exec(color.trim());
  if (!m) return null;

  const parts = m[1]!
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some((x) => Number.isNaN(x))) return null;

  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

/** The first colour of a CSS text-shadow ("rgb(…) 0px 0px 2px, …"), or undefined for none. */
export function shadowColor(shadow: string): string | undefined {
  if (!shadow || shadow === "none") return undefined;

  return /^(rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+)/i.exec(shadow.trim())?.[1];
}

/** A fill at least `MIN_CHIP_ALPHA` opaque. */
export function firmFill(color: string): string {
  const c = rgba(color);
  if (!c || c[3] >= MIN_CHIP_ALPHA) return color;

  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${MIN_CHIP_ALPHA})`;
}

/** The look of the element's text as the page shows it (its button's, if it has one). */
export function lookOf(element: HTMLElement): TextLook | null {
  const text = element.textContent.trim();
  if (!text) return null;

  const cs = getComputedStyle(element);
  const fill = rgba(cs.backgroundColor);
  const bordered = cs.borderTopStyle !== "none" && parseFloat(cs.borderTopWidth) > 0;
  const look: TextLook = {
    text,
    font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
    color: cs.color,
  };

  const halo = shadowColor(cs.textShadow);
  if (halo) look.halo = halo;

  if ((fill && fill[3] > 0) || bordered) {
    look.chip = {
      fill: fill && fill[3] > 0 ? firmFill(cs.backgroundColor) : "rgba(0, 0, 0, 0)",
      border: bordered ? cs.borderTopColor : "rgba(0, 0, 0, 0)",
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      dashed: cs.borderTopStyle === "dashed",
    };
  }

  return look;
}

/** The element whose look is copied: the value's button, or the element itself. */
const face = (element: HTMLElement): HTMLElement =>
  element.querySelector<HTMLElement>("button:not(.unlink)") ?? element;

/** Whether the element is shown as its own (being typed into, or with a button besides its value). */
const ownView = (element: HTMLElement) => !!element.querySelector("input, textarea, select, .unlink");

/**
 * Copies `element` into the scene under `id`, lying in a plane on `corners` (its box `size` pixels;
 * hidden behind parts like the face it lies on with `hides`), or
 * facing the screen where the element is, anchored to the world point `at`. Removes the copy and shows
 * the element itself when it is being edited or cannot be copied.
 */
export function mirror(
  viewport: Viewport,
  id: string,
  element: HTMLElement,
  place: { corners: Quad; size: readonly [number, number]; hides?: boolean } | { at: V3 },
): void {
  const look = ownView(element) || element.style.display === "none" ? null : lookOf(face(element));
  const spec = look ? specFor(viewport, element, look, place) : null;
  viewport.texts.set(id, spec);
  element.classList.toggle(IN_SCENE, !!spec);
}

function specFor(
  viewport: Viewport,
  element: HTMLElement,
  look: TextLook,
  place: { corners: Quad; size: readonly [number, number]; hides?: boolean } | { at: V3 },
): SceneTextSpec | null {
  if ("corners" in place) {
    return { look, size: place.size, corners: place.corners, ...(place.hides ? { hides: true } : {}) };
  }

  const s = viewport.worldToScreen([...place.at]);
  if (!s) return null;

  const box = face(element).getBoundingClientRect();
  const canvas = viewport.canvas.getBoundingClientRect();
  if (!box.width || !box.height) return null;

  return {
    look,
    size: [box.width, box.height],
    at: place.at,
    offset: [box.left + box.width / 2 - canvas.left - s[0], box.top + box.height / 2 - canvas.top - s[1]],
  };
}

/** Removes the scene copies under `prefix` whose ids are not in `keep`. */
export function dropMirrors(viewport: Viewport, prefix: string, keep: ReadonlySet<string>): void {
  for (const id of viewport.texts.ids()) {
    if (id.startsWith(prefix) && !keep.has(id)) viewport.texts.set(id, null);
  }
}
