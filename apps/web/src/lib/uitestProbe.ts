/**
 * For the iPhone and iPad UI tests (apps/ios/uitests): the iOS app sets `window.__meercadUITest`
 * when it is started by a UI test, and then this probe puts what the test checks into an
 * accessibility label the test can read (it cannot run scripts in the page): the page's zoom, the
 * open sheets, the document's steps and variables and the parts' sizes. Never on in normal use.
 */
import type { useApp as UseApp } from "../store";

export { uiTesting } from "./uitestFlag";

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
  /**
   * Where the origin and the points 10 mm along X, Y and Z are on screen (page points), to aim touches in the
   * model.
   */
  axes: { o: number[]; x: number[]; y: number[]; z: number[] } | null;
  /** The open sketch's entities and how many degrees of freedom are left. */
  sketchInfo: { lines: number; circles: number; dof: number | null; regions: number[] } | null;
  measure: string[][] | null;
  /** The rectangles of what covers the screen, to check that sheets do not hide each other. */
  rects: Record<string, [number, number, number, number] | null>;
}

export function probeState(
  app: typeof UseApp,
  busy: () => boolean = () => false,
  screenOf: (p: [number, number, number]) => number[] | null = () => null,
): ProbeState {
  const state = app.getState();

  const rect = (sel: string): [number, number, number, number] | null => {
    const element = document.querySelector(sel);
    if (!element) return null;

    const rect = element.getBoundingClientRect();

    return rect.width && rect.height
      ? [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
      : null;
  };

  return {
    scale: +(window.visualViewport?.scale ?? 1).toFixed(3),
    width: window.innerWidth,
    visible: Math.round(window.visualViewport?.width ?? window.innerWidth),
    layout: document.documentElement.clientWidth,
    compact: document.documentElement.hasAttribute("data-compact"),
    screen: state.screen,
    busy: busy(),
    sideOpen: state.sideOpen,
    sketch: state.sketchId,
    dialog: state.dialog ? `${state.dialog.feature.op}:${state.dialog.feature.id}` : null,
    features: state.doc.features.map((feature) => feature.id),
    params: state.doc.params,
    bodies: (state.output?.report.bodies ?? []).map((b) => ({
      id: b.id,
      volume: Number.isFinite(b.volume) ? +b.volume.toFixed(3) : -1 /* not worked out yet (a preview) */,
      size: [0, 1, 2].map((k) => +(b.bbox.max[k]! - b.bbox.min[k]!).toFixed(3)),
    })),
    errors: (state.output?.report.features ?? [])
      .filter((status) => status.status === "error")
      .map((status) => `${status.id}: ${status.message ?? ""}`),
    toasts: [...document.querySelectorAll(".toast")].map((element) => element.textContent ?? ""),
    axes: (() => {
      const canvas = document.querySelector("canvas")?.getBoundingClientRect();

      const at = (p: [number, number, number]) => {
        const q = screenOf(p);

        return q && canvas ? [Math.round(canvas.left + q[0]!), Math.round(canvas.top + q[1]!)] : null;
      };

      const [o, x, y, z] = [at([0, 0, 0]), at([10, 0, 0]), at([0, 10, 0]), at([0, 0, 10])];

      return o && x && y && z ? { o, x, y, z } : null;
    })(),
    sketchInfo: (() => {
      const feature = state.sketchId
        ? state.doc.features.find((feature) => feature.id === state.sketchId)
        : null;
      if (!feature || feature.op !== "sketch") return null;

      const view = state.output?.report.sketches.find((sketchView) => sketchView.id === feature.id);

      return {
        lines: feature.entities.filter((entity) => entity.type === "line" && !entity.construction).length,
        circles: feature.entities.filter((entity) => entity.type === "circle").length,
        dof: view?.diagnostics.dof ?? null,
        regions: view?.regions.filter((r) => r.depth % 2 === 1).map((r) => +r.area.toFixed(3)) ?? [],
      };
    })(),
    measure: state.measure.result ? state.measure.result.rows : null,
    rects: {
      side: rect(".side"),
      dialog: rect(".dialog"),
      sketch: rect(".sketch-hud"),
      canvas: rect("canvas"),
      bar: rect(".toolbar.rail"),
      constraints: rect(".constraint-palette.open"),
    },
  };
}

/** Keeps the probe element up to date (a few times a second). */
export function installProbe(
  app: typeof UseApp,
  busy: () => boolean,
  screenOf: (p: [number, number, number]) => number[] | null,
): void {
  const element = document.createElement("div");
  element.id = "uitest-probe";
  // Read by the screen-reader tree (a static text) but not drawn: the usual "visually hidden" style.
  element.style.cssText =
    "position:fixed;left:0;top:0;width:1px;height:1px;margin:-1px;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;pointer-events:none";
  document.body.appendChild(element);

  let last = "";

  const tick = () => {
    const text = `UITEST ${JSON.stringify(probeState(app, busy, screenOf))}`;
    if (text !== last) element.textContent = last = text;
  };

  setInterval(tick, 200);
  tick();
}
