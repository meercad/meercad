/**
 * Shortcut and mouse presets. Every handler and every shortcut badge reads from here, so switching a
 * preset in Settings changes both what keys do and what the UI shows.
 */
import { create } from "zustand";
import type { Navigation } from "@meercad/viewport";
import type { SketchTool } from "../sketch/state";

export type ModelAction =
  | "sketch"
  | "extrude"
  | "revolve"
  | "loft"
  | "split"
  | "sweep"
  | "fillet"
  | "chamfer"
  | "shell"
  | "thread"
  | "gear"
  | "hole"
  | "transform"
  | "linear_pattern"
  | "circular_pattern"
  | "mirror"
  | "boolean"
  | "plane"
  | "measure"
  | "joints"
  | "palette"
  | "fit"
  | "normal"
  | "view.iso"
  | "view.front"
  | "view.back"
  | "view.top"
  | "view.bottom"
  | "view.right"
  | "view.left";
export type SketchAction = `sketch.${Exclude<SketchTool, "select">}` | "sketch.construction";
export type Action = ModelAction | SketchAction;

/** Bindings like "E", "Shift+E", "Mod+1", "Num7". An empty list leaves the action unbound. */
export type Keymap = Record<Action, string[]>;

const BASE: Keymap = {
  sketch: ["S"],
  extrude: ["E"],
  revolve: ["V"],
  loft: ["Shift+L"],
  sweep: ["W"],
  fillet: ["F"],
  chamfer: ["C"],
  shell: ["H"],
  thread: ["T"],
  gear: ["G"],
  hole: ["Shift+H"],
  split: ["Shift+K"],
  transform: ["M"],
  linear_pattern: ["L"],
  circular_pattern: ["O"],
  mirror: ["I"],
  boolean: ["B"],
  plane: ["N"],
  measure: ["Shift+M"],
  joints: ["J"],
  palette: ["X", "Mod+F"],
  fit: ["Z"],
  normal: ["Space"],
  "view.iso": ["Mod+1", "1"],
  "view.front": ["Mod+2", "2"],
  "view.back": ["Mod+3", "3"],
  "view.top": ["Mod+4", "4"],
  "view.bottom": ["Mod+5", "5"],
  "view.right": ["Mod+6", "6"],
  "view.left": ["Mod+7", "7"],
  "sketch.line": ["L"],
  "sketch.rect": ["R"],
  "sketch.rect_center": ["Shift+R"],
  "sketch.circle": ["C"],
  "sketch.arc": ["A"],
  "sketch.arc_center": ["Shift+A"],
  "sketch.polygon": ["G"],
  "sketch.point": ["P"],
  "sketch.trim": ["T"],
  "sketch.dimension": ["D"],
  "sketch.project": ["U"],
  "sketch.construction": ["X"],
};

export type KeyScheme = "meercad" | "fusion" | "onshape" | "solidworks" | "blender";
export type MouseScheme = "meercad" | "fusion" | "onshape" | "solidworks" | "blender" | "trackpad";

export const KEY_SCHEMES: { id: KeyScheme; label: string; note: string; map: Keymap }[] = [
  { id: "meercad", label: "meerCAD", note: "Single letters for every tool, ⌘1–7 for views.", map: BASE },
  {
    id: "fusion",
    label: "Fusion 360",
    note: "S opens command search, P projects edges, F6 fits the view.",
    map: { ...BASE, sketch: [], palette: ["S", "Mod+F"], fit: ["F6"], "sketch.project": ["P"], "sketch.point": [] },
  },
  {
    id: "onshape",
    label: "Onshape",
    note: "Shift+letter for features, Shift+1–7 for views, F fits, N looks normal to a face.",
    map: {
      ...BASE,
      sketch: ["Shift+S"],
      extrude: ["Shift+E"],
      revolve: ["Shift+W"],
      fillet: ["Shift+F"],
      plane: [],
      fit: ["F"],
      normal: ["N"],
      "view.front": ["Shift+1"],
      "view.back": ["Shift+2"],
      "view.left": ["Shift+3"],
      "view.right": ["Shift+4"],
      "view.top": ["Shift+5"],
      "view.bottom": ["Shift+6"],
      "view.iso": ["Shift+7"],
      "sketch.rect": ["G"],
      "sketch.rect_center": ["R"],
      "sketch.polygon": [],
      "sketch.trim": ["M"],
      "sketch.construction": ["Q"],
    },
  },
  {
    id: "solidworks",
    label: "SolidWorks",
    note: "Ctrl+1–7 for views, Ctrl+8 normal to, F fits.",
    map: {
      ...BASE,
      fillet: [],
      fit: ["F"],
      normal: ["Mod+8"],
      "view.front": ["Mod+1"],
      "view.back": ["Mod+2"],
      "view.left": ["Mod+3"],
      "view.right": ["Mod+4"],
      "view.top": ["Mod+5"],
      "view.bottom": ["Mod+6"],
      "view.iso": ["Mod+7"],
    },
  },
  {
    id: "blender",
    label: "Blender",
    note: "Numpad views (Ctrl for the opposite side), Home fits.",
    map: {
      ...BASE,
      fit: ["Home"],
      "view.front": ["Num1"],
      "view.back": ["Mod+Num1"],
      "view.right": ["Num3"],
      "view.left": ["Mod+Num3"],
      "view.top": ["Num7"],
      "view.bottom": ["Mod+Num7"],
      "view.iso": ["Num0"],
    },
  },
];

export const MOUSE_SCHEMES: { id: MouseScheme; label: string; orbit: string; pan: string; zoom: string; nav: Navigation }[] = [
  {
    id: "meercad",
    label: "meerCAD",
    orbit: "Right drag",
    pan: "Middle drag or Shift + right drag",
    zoom: "Wheel",
    nav: { orbit: [{ button: "right" }], pan: [{ button: "middle" }, { button: "right", mod: "shift" }], zoom: [] },
  },
  {
    id: "fusion",
    label: "Fusion 360",
    orbit: "Shift + middle drag",
    pan: "Middle drag",
    zoom: "Wheel",
    nav: { orbit: [{ button: "middle", mod: "shift" }], pan: [{ button: "middle" }], zoom: [] },
  },
  {
    id: "onshape",
    label: "Onshape",
    orbit: "Right drag",
    pan: "Middle drag or Ctrl + right drag",
    zoom: "Wheel",
    nav: { orbit: [{ button: "right" }], pan: [{ button: "middle" }, { button: "right", mod: "ctrl" }], zoom: [] },
  },
  {
    id: "solidworks",
    label: "SolidWorks",
    orbit: "Middle drag",
    pan: "Ctrl + middle drag",
    zoom: "Wheel or Shift + middle drag",
    nav: { orbit: [{ button: "middle" }], pan: [{ button: "middle", mod: "ctrl" }], zoom: [{ button: "middle", mod: "shift" }] },
  },
  {
    id: "blender",
    label: "Blender",
    orbit: "Middle drag",
    pan: "Shift + middle drag",
    zoom: "Wheel or Ctrl + middle drag",
    nav: { orbit: [{ button: "middle" }], pan: [{ button: "middle", mod: "shift" }], zoom: [{ button: "middle", mod: "ctrl" }] },
  },
  {
    id: "trackpad",
    label: "Trackpad / no middle button",
    orbit: "Right drag (two-finger click-drag)",
    pan: "Shift + right drag",
    zoom: "Pinch or Alt + right drag",
    nav: { orbit: [{ button: "right" }], pan: [{ button: "right", mod: "shift" }], zoom: [{ button: "right", mod: "alt" }] },
  },
];

interface Prefs {
  keys: KeyScheme;
  mouse: MouseScheme;
  invertZoom: boolean;
  /** Shortcut badges on tools and menus. */
  showKeys: boolean;
  /** Dimension and size chips on the model. */
  showValues: boolean;
  /** Each part in its own colour when a design has several. */
  colorParts: boolean;
  /** Sketch points and drag handles snap to round values (the grid). */
  snapGrid: boolean;
  /** Sketch points snap to existing geometry (ends, midpoints, crossings, alignments): the magnet. */
  snapGeometry: boolean;
  /** Measuring system new designs start in (metric: mm, imperial: inches). */
  units: "metric" | "imperial";
}


const STORAGE_KEY = "meercad.prefs";

function load(): Prefs {
  const fallback: Prefs = { keys: "meercad", mouse: "meercad", invertZoom: false, showKeys: true, showValues: true, colorParts: true, snapGrid: true, snapGeometry: true, units: "metric" };
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Prefs>;
    return {
      keys: KEY_SCHEMES.some((s) => s.id === raw.keys) ? raw.keys! : fallback.keys,
      mouse: MOUSE_SCHEMES.some((s) => s.id === raw.mouse) ? raw.mouse! : fallback.mouse,
      invertZoom: raw.invertZoom === true,
      showKeys: raw.showKeys !== false,
      showValues: raw.showValues !== false,
      colorParts: raw.colorParts !== false,
      snapGrid: raw.snapGrid !== false,
      snapGeometry: raw.snapGeometry !== false,
      units: raw.units === "imperial" ? "imperial" : "metric",
    };
  } catch {
    return fallback;
  }
}

export const usePrefs = create<Prefs>(load);

// Badges are hidden with one class on the root, so every Kbd follows without extra wiring.
const applyRootClasses = (p: Prefs) => document.documentElement.classList.toggle("hide-kbd", !p.showKeys);
applyRootClasses(usePrefs.getState());
usePrefs.subscribe(applyRootClasses);

export function setPrefs(p: Partial<Prefs>): void {
  usePrefs.setState(p);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(usePrefs.getState()));
  } catch {
    // preferences just won't persist
  }
}

export const keymapFor = (scheme: KeyScheme): Keymap => KEY_SCHEMES.find((s) => s.id === scheme)!.map;
export const navigationFor = (scheme: MouseScheme): Navigation => MOUSE_SCHEMES.find((s) => s.id === scheme)!.nav;

/** The primary shortcut for an action in the active preset, for badges and tooltips. */
export function keyFor(action: Action): string | undefined {
  return keymapFor(usePrefs.getState().keys)[action][0];
}

/** Re-renders when the preset changes. */
export function useKey(action: Action): string | undefined {
  const scheme = usePrefs((s) => s.keys);
  return keymapFor(scheme)[action][0];
}

function eventKey(e: KeyboardEvent): string {
  if (e.code.startsWith("Key")) return e.code.slice(3);
  if (e.code.startsWith("Digit")) return e.code.slice(5);
  if (e.code.startsWith("Numpad") && /\d$/.test(e.code)) return `Num${e.code.slice(6)}`;
  if (e.code === "Space") return "Space";
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

/** Whether a key event is exactly this binding (modifiers must match too). */
export function matches(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.split("+");
  const key = parts.pop()!;
  const mods = new Set(parts);
  return (
    eventKey(e) === key &&
    (e.metaKey || e.ctrlKey) === mods.has("Mod") &&
    e.shiftKey === mods.has("Shift") &&
    e.altKey === mods.has("Alt")
  );
}

/** The first action among `actions` that this event triggers in the active preset. */
export function actionFor<A extends Action>(e: KeyboardEvent, actions: readonly A[]): A | undefined {
  const map = keymapFor(usePrefs.getState().keys);
  return actions.find((a) => map[a].some((b) => matches(e, b)));
}

export const MODEL_ACTIONS: readonly ModelAction[] = [
  "sketch", "extrude", "revolve", "loft", "sweep", "fillet", "chamfer", "shell", "thread", "gear", "hole", "split", "transform", "linear_pattern", "circular_pattern", "mirror", "boolean", "plane",
  "measure", "joints", "palette", "fit", "normal", "view.iso", "view.front", "view.back", "view.top", "view.bottom", "view.right", "view.left",
];
export const SKETCH_ACTIONS: readonly SketchAction[] = [
  "sketch.line", "sketch.rect", "sketch.rect_center", "sketch.circle", "sketch.arc", "sketch.arc_center", "sketch.polygon", "sketch.point", "sketch.trim",
  "sketch.dimension", "sketch.project", "sketch.construction",
];
