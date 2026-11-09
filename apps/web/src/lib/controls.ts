/**
 * Control schemes: every key binding and every mouse behaviour of the app, per scheme. Handlers ask
 * this module what a key or a click means instead of testing keys themselves, and badges and the
 * shortcut overview read the same tables, so a scheme picked in Settings changes all of it at once.
 *
 * Pure data and matching only (no DOM, no stored preferences): see ./keymap for the chosen scheme.
 */
import type { Navigation } from "@meercad/viewport";
import type { SketchTool } from "../sketch/state";
import { t } from "./i18n";

export type ModelAction =
  | "sketch"
  | "extrude"
  | "revolve"
  | "loft"
  | "split"
  | "rib"
  | "draft"
  | "offset_face"
  | "texture"
  | "text"
  | "standard_part"
  | "gridfinity"
  | "wall"
  | "label"
  | "primitive"
  | "box"
  | "snap_hook"
  | "lithophane"
  | "align"
  | "scale"
  | "bend"
  | "sweep"
  | "fillet"
  | "chamfer"
  | "shell"
  | "thread"
  | "gear"
  | "coil"
  | "spring"
  | "cable"
  | "screw"
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
  | "repeat"
  | "hide"
  | "unhide_all"
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
/** Sketch constraints made from the selection. */
export type ConstraintKind = "coincident" | "hv" | "vertical" | "parallel" | "perpendicular" | "tangent" | "equal" | "concentric" | "midpoint" | "collinear" | "symmetric" | "fix";
export type ConstraintAction = `constraint.${ConstraintKind}`;
/** Keys that mean the same in the model and in a sketch. */
export type CommonAction = "confirm" | "cancel" | "delete" | "select_all";
export type Action = ModelAction | SketchAction | ConstraintAction | CommonAction;

/** Bindings like "E", "Shift+E", "Mod+1", "Num7", "Alt+X". An empty list leaves the action unbound. */
export type Keymap = Record<Action, string[]>;

const BASE: Keymap = {
  confirm: ["Enter"],
  cancel: ["Escape"],
  delete: ["Delete", "Backspace"],
  select_all: ["Mod+A"],
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
  coil: [],
  spring: [],
  cable: [],
  screw: [],
  hole: ["Shift+H"],
  split: ["Shift+K"],
  rib: ["Shift+B"],
  draft: ["Shift+D"],
  offset_face: ["Shift+E"],
  texture: [],
  text: ["Shift+T"],
  standard_part: ["Shift+P"],
  gridfinity: [],
  wall: [],
  label: [],
  primitive: [],
  box: [],
  snap_hook: [],
  lithophane: [],
  align: ["Shift+A"],
  scale: [],
  bend: [],
  transform: ["M"],
  linear_pattern: ["L"],
  circular_pattern: ["O"],
  mirror: ["I"],
  boolean: ["B"],
  plane: ["N"],
  measure: ["Shift+M"],
  joints: ["J"],
  palette: ["X", "Mod+F"],
  repeat: ["Shift+R"],
  hide: [],
  unhide_all: [],
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
  "sketch.spline": ["S"],
  "sketch.point": ["P"],
  "sketch.trim": ["T"],
  "sketch.fillet": ["Shift+F"],
  "sketch.chamfer": ["Shift+B"],
  "sketch.offset": ["Shift+O"],
  "sketch.pattern": ["Shift+G"],
  "sketch.dimension": ["D"],
  "sketch.project": ["U"],
  "sketch.section": [],
  "sketch.construction": ["X"],
  "constraint.coincident": ["Shift+N"],
  "constraint.hv": ["Shift+V"],
  "constraint.vertical": [],
  // Shift+A is the center arc; I for the two upright strokes of ∥.
  "constraint.parallel": ["Shift+I"],
  "constraint.perpendicular": ["Shift+P"],
  "constraint.tangent": ["Shift+T"],
  "constraint.equal": ["Shift+E"],
  "constraint.concentric": ["Shift+C"],
  "constraint.midpoint": ["Shift+M"],
  "constraint.collinear": [],
  "constraint.symmetric": ["Shift+S"],
  "constraint.fix": ["Shift+L"],
};

export type KeyScheme = "meercad" | "fusion" | "onshape" | "solidworks" | "blender" | "plasticity";
export type MouseScheme = "meercad" | "fusion" | "onshape" | "solidworks" | "blender" | "plasticity" | "trackpad";
/**
 * What a right click (pressed and released without dragging) does. "menu": the actions for what is
 * under the pointer. "confirm": finishes what is running (the open tool, the line or spline being
 * drawn, the sketch), and shows the menu when nothing runs.
 */
export type RightClick = "menu" | "confirm";

export const KEY_SCHEMES: { id: KeyScheme; label: string; note: string; map: Keymap }[] = [
  { id: "meercad", label: "meerCAD", note: t("Single letters for every tool, ⌘1–7 for views."), map: BASE },
  {
    id: "fusion",
    label: "Fusion 360",
    note: t("S opens command search, P projects edges, F6 fits the view."),
    map: { ...BASE, sketch: [], palette: ["S", "Mod+F"], fit: ["F6"], "sketch.project": ["P"], "sketch.point": [] },
  },
  {
    id: "onshape",
    label: "Onshape",
    note: t("Shift+letter for features, Shift+1–7 for views, F fits, N looks normal to a face."),
    map: {
      ...BASE,
      sketch: ["Shift+S"],
      extrude: ["Shift+E"],
      revolve: ["Shift+W"],
      fillet: ["Shift+F"],
      offset_face: [],
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
    note: t("Ctrl+1–7 for views, Ctrl+8 normal to, F fits."),
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
    note: t("Numpad views (Ctrl for the opposite side), Home fits."),
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
  {
    id: "plasticity",
    label: "Plasticity",
    note: t("F searches every command, G/R move and turn, S scales, X deletes, H hides, Shift+R repeats, numpad views."),
    map: {
      ...BASE,
      delete: ["X", "Delete", "Backspace", "Shift+Backspace"],
      select_all: ["Mod+A", "A"],
      palette: ["F", "Mod+F"],
      repeat: ["Shift+R"],
      hide: ["H"],
      unhide_all: ["Alt+H"],
      sketch: ["Shift+A"],
      align: [],
      extrude: ["E"],
      fillet: ["B"],
      chamfer: ["Shift+B"],
      rib: [],
      shell: [],
      split: ["C"],
      boolean: ["Q"],
      loft: ["L"],
      linear_pattern: [],
      sweep: ["Shift+P", "P"],
      standard_part: [],
      transform: ["G", "R"],
      gear: [],
      scale: ["S"],
      mirror: ["Alt+X"],
      offset_face: ["O"],
      circular_pattern: [],
      measure: ["Mod+="],
      fit: ["/", "Home"],
      normal: ["Space"],
      "view.front": ["Num1"],
      "view.back": ["Mod+Num1"],
      "view.right": ["Num3"],
      "view.left": ["Mod+Num3"],
      "view.top": ["Num7"],
      "view.bottom": ["Mod+Num7"],
      "view.iso": ["Num0"],
      "sketch.line": ["Shift+A", "L"],
      "sketch.arc": [],
      "sketch.arc_center": [],
      "sketch.trim": ["T"],
      "sketch.fillet": ["B"],
      "sketch.chamfer": ["Shift+B"],
      "sketch.offset": ["O"],
      "sketch.project": ["I"],
      "sketch.dimension": ["D", "="],
      "sketch.construction": ["Q"],
    },
  },
];

export interface MouseSchemeInfo {
  id: MouseScheme;
  label: string;
  orbit: string;
  pan: string;
  zoom: string;
  nav: Navigation;
  rightClick: RightClick;
}

export const MOUSE_SCHEMES: MouseSchemeInfo[] = [
  {
    id: "meercad",
    label: "meerCAD",
    orbit: t("Right drag"),
    pan: t("Middle drag or Shift + right drag"),
    zoom: t("Wheel"),
    nav: { orbit: [{ button: "right" }], pan: [{ button: "middle" }, { button: "right", mod: "shift" }], zoom: [] },
    rightClick: "menu",
  },
  {
    id: "fusion",
    label: "Fusion 360",
    orbit: t("Shift + middle drag"),
    pan: t("Middle drag"),
    zoom: t("Wheel"),
    nav: { orbit: [{ button: "middle", mod: "shift" }], pan: [{ button: "middle" }], zoom: [] },
    rightClick: "menu",
  },
  {
    id: "onshape",
    label: "Onshape",
    orbit: t("Right drag"),
    pan: t("Middle drag or Ctrl + right drag"),
    zoom: t("Wheel"),
    nav: { orbit: [{ button: "right" }], pan: [{ button: "middle" }, { button: "right", mod: "ctrl" }], zoom: [] },
    rightClick: "menu",
  },
  {
    id: "solidworks",
    label: "SolidWorks",
    orbit: t("Middle drag"),
    pan: t("Ctrl + middle drag"),
    zoom: t("Wheel or Shift + middle drag"),
    nav: { orbit: [{ button: "middle" }], pan: [{ button: "middle", mod: "ctrl" }], zoom: [{ button: "middle", mod: "shift" }] },
    rightClick: "menu",
  },
  {
    id: "blender",
    label: "Blender",
    orbit: t("Middle drag"),
    pan: t("Shift + middle drag"),
    zoom: t("Wheel or Ctrl + middle drag"),
    nav: { orbit: [{ button: "middle" }], pan: [{ button: "middle", mod: "shift" }], zoom: [{ button: "middle", mod: "ctrl" }] },
    rightClick: "menu",
  },
  {
    id: "plasticity",
    label: "Plasticity",
    orbit: t("Middle drag"),
    pan: t("Right drag or Shift + middle drag"),
    zoom: t("Wheel or Ctrl + middle drag"),
    nav: { orbit: [{ button: "middle" }], pan: [{ button: "right" }, { button: "middle", mod: "shift" }], zoom: [{ button: "middle", mod: "ctrl" }] },
    rightClick: "confirm",
  },
  {
    id: "trackpad",
    label: t("Trackpad / no middle button"),
    orbit: t("Two-finger swipe or right drag"),
    pan: t("Shift + two-finger swipe or Shift + right drag"),
    zoom: t("Pinch, Ctrl + two-finger swipe or Alt + right drag"),
    nav: { orbit: [{ button: "right" }], pan: [{ button: "right", mod: "shift" }], zoom: [{ button: "right", mod: "alt" }] },
    rightClick: "menu",
  },
];

/** Whole schemes: keys and mouse together, picked with one click in Settings. */
export const CONTROL_SCHEMES: { id: KeyScheme; label: string; keys: KeyScheme; mouse: MouseScheme }[] = KEY_SCHEMES.map((k) => ({
  id: k.id,
  label: k.label,
  keys: k.id,
  mouse: k.id,
}));

export const keymapFor = (scheme: KeyScheme): Keymap => (KEY_SCHEMES.find((s) => s.id === scheme) ?? KEY_SCHEMES[0]!).map;
export const mouseFor = (scheme: MouseScheme): MouseSchemeInfo => MOUSE_SCHEMES.find((s) => s.id === scheme) ?? MOUSE_SCHEMES[0]!;

/** The key of an event in binding notation: letters, digits and numpad by position, the rest by name. */
export function eventKey(e: Pick<KeyboardEvent, "code" | "key">): string {
  if (e.code.startsWith("Key")) return e.code.slice(3);
  if (e.code.startsWith("Digit")) return e.code.slice(5);
  if (e.code.startsWith("Numpad") && /\d$/.test(e.code)) return `Num${e.code.slice(6)}`;
  if (e.code === "Space") return "Space";
  return e.key.length === 1 ? e.key.toUpperCase() : e.key;
}

type KeyEventLike = Pick<KeyboardEvent, "code" | "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

/** Whether a key event is exactly this binding (modifiers must match too). */
export function matches(e: KeyEventLike, binding: string): boolean {
  // "Mod+=" splits into Mod and "="; a lone "+" would be the key itself.
  const parts = binding.split("+");
  const key = parts.pop() || "+";
  const mods = new Set(parts);
  return (
    eventKey(e) === key &&
    (e.metaKey || e.ctrlKey) === mods.has("Mod") &&
    e.shiftKey === mods.has("Shift") &&
    e.altKey === mods.has("Alt")
  );
}

/** The first action among `actions` that this event triggers in `map`. */
export function actionIn<A extends Action>(map: Keymap, e: KeyEventLike, actions: readonly A[]): A | undefined {
  return actions.find((a) => map[a].some((b) => matches(e, b)));
}

export const COMMON_ACTIONS: readonly CommonAction[] = ["confirm", "cancel", "delete", "select_all"];
export const MODEL_ACTIONS: readonly ModelAction[] = [
  "sketch", "extrude", "revolve", "loft", "sweep", "rib", "primitive", "text", "standard_part", "gridfinity", "wall", "label", "box", "snap_hook", "lithophane", "fillet", "chamfer", "shell", "draft", "offset_face", "texture", "thread", "gear", "coil", "spring", "cable", "screw", "hole", "split", "transform", "align", "scale", "bend", "linear_pattern", "circular_pattern", "mirror", "boolean", "plane",
  "measure", "joints", "palette", "repeat", "hide", "unhide_all", "fit", "normal", "view.iso", "view.front", "view.back", "view.top", "view.bottom", "view.right", "view.left",
];
export const SKETCH_ACTIONS: readonly SketchAction[] = [
  "sketch.line", "sketch.rect", "sketch.rect_center", "sketch.circle", "sketch.arc", "sketch.arc_center", "sketch.polygon", "sketch.spline", "sketch.point", "sketch.trim", "sketch.fillet", "sketch.chamfer", "sketch.offset", "sketch.pattern",
  "sketch.dimension", "sketch.project", "sketch.section", "sketch.construction",
];
export const CONSTRAINT_ACTIONS: readonly ConstraintAction[] = [
  "constraint.coincident", "constraint.hv", "constraint.vertical", "constraint.parallel", "constraint.perpendicular", "constraint.tangent", "constraint.equal", "constraint.concentric", "constraint.midpoint", "constraint.collinear", "constraint.symmetric", "constraint.fix",
];

/** Everything a key can do outside a sketch, and inside one. Within each, a binding means one thing. */
export const MODEL_CONTEXT: readonly (CommonAction | ModelAction)[] = [...COMMON_ACTIONS, ...MODEL_ACTIONS];
export const SKETCH_CONTEXT: readonly (CommonAction | SketchAction | ConstraintAction)[] = [...COMMON_ACTIONS, ...SKETCH_ACTIONS, ...CONSTRAINT_ACTIONS];
