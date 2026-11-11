/**
 * For the iPhone and iPad UI tests (apps/ios/uitests): the iOS app sets `window.__meercadUITest`
 * when it is started by a UI test, and then this probe puts what the test checks into an
 * accessibility label the test can read (it cannot run scripts in the page): the page's zoom, the
 * open sheets, the document's steps and variables and the parts' sizes. Never on in normal use.
 */
import type { useApp as UseApp } from "../store";

export const uiTesting = (): boolean => !!(window as unknown as { __meercadUITest?: boolean }).__meercadUITest;

export interface ProbeState {
  /** The page's own zoom: 1 unless the interface was zoomed like a web page. */
  scale: number;
  width: number;
  /** The visible part of the page (smaller than `layout` when zoomed in). */
  visible: number;
  layout: number;
  compact: boolean;
  screen: string;
  /** A rebuild is running or waiting. */
  busy: boolean;
  sideOpen: boolean;
  sketch: string | null;
  dialog: string | null;
  features: string[];
  params: Record<string, string | number>;
  bodies: { id: string; volume: number; size: number[] }[];
  errors: string[];
  toasts: string[];
  /** The rectangles of what covers the screen, to check that sheets do not hide each other. */
  rects: Record<string, [number, number, number, number] | null>;
}

export function probeState(app: typeof UseApp, busy: () => boolean = () => false): ProbeState {
  const s = app.getState();
  const rect = (sel: string): [number, number, number, number] | null => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null;
  };
  return {
    scale: +(window.visualViewport?.scale ?? 1).toFixed(3),
    width: window.innerWidth,
    visible: Math.round(window.visualViewport?.width ?? window.innerWidth),
    layout: document.documentElement.clientWidth,
    compact: document.documentElement.hasAttribute("data-compact"),
    screen: s.screen,
    busy: busy(),
    sideOpen: s.sideOpen,
    sketch: s.sketchId,
    dialog: s.dialog ? `${s.dialog.feature.op}:${s.dialog.feature.id}` : null,
    features: s.doc.features.map((f) => f.id),
    params: s.doc.params,
    bodies: (s.output?.report.bodies ?? []).map((b) => ({ id: b.id, volume: +b.volume.toFixed(3), size: [0, 1, 2].map((k) => +(b.bbox.max[k]! - b.bbox.min[k]!).toFixed(3)) })),
    errors: (s.output?.report.features ?? []).filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message ?? ""}`),
    toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent ?? ""),
    rects: { side: rect(".side"), dialog: rect(".dialog"), sketch: rect(".sketch-hud"), canvas: rect("canvas"), bar: rect(".toolbar.rail"), constraints: rect(".constraint-palette.open") },
  };
}

/** Keeps the probe element up to date (a few times a second). */
export function installProbe(app: typeof UseApp, busy: () => boolean): void {
  const el = document.createElement("div");
  el.id = "uitest-probe";
  // Read by the screen-reader tree (a static text) but not drawn: the usual "visually hidden" style.
  el.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;pointer-events:none";
  document.body.appendChild(el);
  let last = "";
  const tick = () => {
    const text = `UITEST ${JSON.stringify(probeState(app, busy))}`;
    if (text !== last) el.textContent = last = text;
  };
  setInterval(tick, 200);
  tick();
}
