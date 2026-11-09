/**
 * The chosen control scheme and the other preferences. The schemes themselves (every key and mouse
 * binding) live in ./controls; handlers and badges go through the helpers here, so switching a
 * scheme in Settings changes what keys and clicks do and what the UI shows.
 */
import { create } from "zustand";
import type { Navigation } from "@meercad/viewport";
import { actionIn, KEY_SCHEMES, keymapFor, MOUSE_SCHEMES, mouseFor, type Action, type KeyScheme, type MouseScheme, type RightClick } from "./controls";
import { DEFAULT_BED, validBed, type Bed } from "./printBed";

export * from "./controls";

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
  /** The example models on the start page, and whether that section is folded open. */
  showExamples: boolean;
  examplesOpen: boolean;
  /** Lithophane pictures on screen; off makes editing such a part quicker (exports keep them). */
  showTextures: boolean;
  /** The printer's build volume (mm); null turns the "too big for the bed" warning off. */
  printBed: Bed | null;
  /** The fit measured on this device's printer (mm per side), given to new designs; null: not measured. */
  printerFit: number | null;
  /** Joint symbols (axes, turn rings, slide arrows) in the scene while the joints panel is open; off shows the motion alone. */
  showJoints: boolean;
  /**
   * 3MF exports carry the parts' materials, colours and filament slots. Off (default): plain
   * parts with their names, so a slicer (Bambu Studio) does not ask to map filaments on import.
   */
  threeMfMaterials: boolean;
}


const STORAGE_KEY = "meercad.prefs";

function load(): Prefs {
  const fallback: Prefs = { keys: "meercad", mouse: "meercad", invertZoom: false, showKeys: true, showValues: true, colorParts: true, snapGrid: true, snapGeometry: true, units: "metric", showExamples: true, examplesOpen: true, showTextures: true, printBed: DEFAULT_BED, printerFit: null, showJoints: true, threeMfMaterials: false };
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
      showExamples: raw.showExamples !== false,
      examplesOpen: raw.examplesOpen !== false,
      showTextures: raw.showTextures !== false,
      printBed: validBed(raw.printBed) === undefined ? fallback.printBed : validBed(raw.printBed)!,
      printerFit: typeof raw.printerFit === "number" && raw.printerFit >= 0 && raw.printerFit <= 1 ? raw.printerFit : null,
      showJoints: raw.showJoints !== false,
      threeMfMaterials: raw.threeMfMaterials === true,
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

export const navigationFor = (scheme: MouseScheme): Navigation => mouseFor(scheme).nav;

/** What a right click without dragging does in the active scheme. */
export const rightClick = (): RightClick => mouseFor(usePrefs.getState().mouse).rightClick;

/** The primary shortcut for an action in the active preset, for badges and tooltips. */
export function keyFor(action: Action): string | undefined {
  return keymapFor(usePrefs.getState().keys)[action][0];
}

/** Re-renders when the preset changes. */
export function useKey(action: Action): string | undefined {
  const scheme = usePrefs((s) => s.keys);
  return keymapFor(scheme)[action][0];
}

/** The first action among `actions` that this event triggers in the active preset. */
export function actionFor<A extends Action>(e: KeyboardEvent, actions: readonly A[]): A | undefined {
  return actionIn(keymapFor(usePrefs.getState().keys), e, actions);
}
