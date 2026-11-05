/**
 * A textured 3D model of an area from overhead photos (a drone flight): the folder of photos goes
 * to Apple's photogrammetry on the Mac (a helper next to the app) or the iPad (the Terrain plugin),
 * which gives back a GLB in millimetres. Photos with GPS give it its true size, with north along +Y.
 * It becomes a reference model of the design: shown, not built into parts.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem } from "@capacitor/filesystem";
import { nextFeatureId } from "@meercad/model";
import type { Feature, MeercadDocument, ReferenceModel } from "@meercad/schema";
import type { SceneryView } from "@meercad/viewport";
import type { ReactNode } from "react";
import { create } from "zustand";
import { apply, currentDoc, getViewport, openProject, startSketch, startTask, toast, useApp } from "../store";
import { partName } from "./features";
import { joinedParts } from "./mechanism";
import { nativeApp } from "./native";
import { desktop, type TerrainResult } from "./persistence";
import { t } from "./i18n";
import { PHOTOGRAMMETRY } from "./eta";

interface TerrainPlugin {
  build(): Promise<(TerrainResult & { path: string; folder: string }) | { cancelled: true }>;
  cancel(): Promise<void>;
  addListener(event: "progress", fn: (e: { progress: number; step: string }) => void): Promise<{ remove(): Promise<void> }>;
}
const Terrain = registerPlugin<TerrainPlugin>("Terrain");

/** Whether this app can build models from photos: the Mac app and the iPad app. */
export const canBuildTerrain = !!desktop || (nativeApp && Capacitor.getPlatform() === "ios");

let busy = false;

/** Asks for a folder of photos, builds the model and adds it to the open design. */
export async function buildTerrain(): Promise<void> {
  if (busy) return toast(t("A model from photos is already being built."), "error");
  busy = true;
  // The model goes into the project open now, even if another one is open when it is done.
  const project = useApp.getState().project?.id;
  const task = startTask(t("Model from photos"), null, { long: true, pace: PHOTOGRAMMETRY, cancel: cancelTerrain, ...(project ? { project } : {}) });
  task.update(null, t("Choose the folder with the photos"));
  const steps: Record<string, string> = { model: t("Building the model"), writing: t("Preparing the model") };
  const progress = (e: { progress: number; step: string }) => task.update(e.step === "writing" ? null : e.progress, steps[e.step] ?? "");
  let stop: (() => void) | undefined;
  try {
    let result: TerrainResult & { folder: string };
    let bytes: Uint8Array;
    if (desktop) {
      stop = desktop.on("photos-progress", progress);
      const r = await desktop.photos.build();
      if (!r) return;
      ({ data: bytes, ...result } = r);
    } else {
      const listener = await Terrain.addListener("progress", progress);
      stop = () => void listener.remove();
      const r = await Terrain.build();
      if ("cancelled" in r) return;
      result = r;
      const file = await Filesystem.readFile({ path: `file://${r.path}` });
      bytes = Uint8Array.from(atob(file.data as string), (c) => c.charCodeAt(0));
      void Filesystem.deleteFile({ path: `file://${r.path}` }).catch(() => undefined);
    }
    if (project && useApp.getState().project?.id !== project) await openProject(project);
    addTerrain(result, bytes);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if (!/cancelled/.test(message)) toast(t("No model came from the photos: {error}", { error: message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }), "error");
  } finally {
    stop?.();
    task.done();
    busy = false;
  }
}

/** Stops a build that is running. */
export function cancelTerrain(): void {
  if (desktop) void desktop.photos.cancel();
  else void Terrain.cancel();
}

export function addTerrain(r: TerrainResult & { folder: string }, bytes: Uint8Array): void {
  const doc = useApp.getState().doc;
  const used = new Set(doc.references?.map((x) => x.id));
  let n = 1;
  while (used.has(`rf${n}`)) n++;
  let data = "";
  for (let i = 0; i < bytes.length; i += 0x8000) data += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  // A drone's own folder names say nothing ("DCIM", "100MEDIA"); a folder the user named does.
  const generic = !r.folder || /^(images?|photos?|fotos?|bilder|dcim|\d{3}[a-z_]*media.*|dji.*)$/i.test(r.folder);
  const stamp = new Date().toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const reference: ReferenceModel = { id: `rf${n}`, name: generic ? t("Area {when}", { when: stamp }) : r.folder, format: "glb", data: btoa(data), ...(r.geo ? { geo: { lat: r.geo.lat, lon: r.geo.lon, alt: r.geo.alt } } : {}) };
  if (!apply({ type: "set_reference", reference })) return;
  const size = r.size.map((v) => (v / 1000).toFixed(v >= 10_000 ? 0 : 1)).join(" × ");
  toast(
    r.measured
      ? t("Area scanned: {size} m, true size. Long-press it to mark, measure or set parts onto it.", { size })
      : r.geo
      ? t("{photos} photos → {size} m, placed by GPS (±{error} m)", { photos: r.photos, size, error: r.geo.error.toFixed(1) })
      : t("{photos} photos → model without GPS: its size is not to scale", { photos: r.photos }),
  );
}

const decoded = new Map<string, ArrayBuffer>();

/** The design's reference models as the viewport takes them (each file decoded once). */
export function sceneryOf(doc: MeercadDocument): SceneryView[] {
  const list = doc.references ?? [];
  for (const key of decoded.keys()) if (!list.some((r) => r.data === key)) decoded.delete(key);
  return list.map((r) => {
    let data = decoded.get(r.data);
    if (!data) {
      const raw = atob(r.data);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      decoded.set(r.data, (data = bytes.buffer));
    }
    return { id: r.id, data, ...(r.hidden ? { hidden: true } : {}), ...(r.scale ? { scale: r.scale } : {}) };
  });
}

// ---------------------------------------------------------------- designing on the terrain

/**
 * A part being set onto the terrain: it follows the pointer over the ground (`move`, shown as a
 * preview pose) at `offset` mm above it (below when negative), until a click puts it there.
 */
export const useTerrainPlace = create<{ body: string | null; offset: number; move: [number, number, number] | null }>(() => ({ body: null, offset: 0, move: null }));

/** Whether the design has a reference model shown, so parts can be set onto it. */
export const hasTerrain = (): boolean => (useApp.getState().doc.references ?? []).some((r) => !r.hidden);

/**
 * Starts a sketch on a level plane at the height of a point on the terrain: an outline drawn there
 * and extruded up stands on the ground at that spot.
 */
export function sketchOnTerrain(point: readonly [number, number, number]): void {
  const doc = currentDoc();
  const id = nextFeatureId(doc, "plane");
  const z = Math.round(point[2] * 10) / 10;
  if (!apply({ type: "add_features", features: [{ id, op: "plane", name: t("Ground at {z} m", { z: (z / 1000).toFixed(2) }), base: { ref: "origin.XY" }, offset: z } as Feature] })) return;
  useApp.setState({ pickingSketchPlane: false });
  startSketch({ ref: id });
}

/**
 * How far a part moves to stand on the terrain, `offset` mm above it: its lowest point onto the
 * highest ground under its footprint, so no corner sinks in. With `at`, its middle goes there.
 */
function moveOnto(body: string, at: readonly [number, number, number] | undefined, offset: number): [number, number, number] | null {
  const vp = getViewport();
  const m = useApp.getState().output?.meshes.find((x) => x.bodyId === body);
  if (!vp || !m) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, m.positions[i + k]!);
      hi[k] = Math.max(hi[k]!, m.positions[i + k]!);
    }
  const dx = at ? at[0] - (lo[0]! + hi[0]!) / 2 : 0;
  const dy = at ? at[1] - (lo[1]! + hi[1]!) / 2 : 0;
  // The ground under the footprint, on a 7 × 7 grid (corners and edges included): the surface at the
  // pointer's height (or the part's foot), so a part goes onto the floor, not the ceiling above.
  const near = at ? at[2] : lo[2]!;
  let ground = -Infinity;
  for (let i = 0; i <= 6; i++)
    for (let j = 0; j <= 6; j++) {
      const h = vp.sceneryHeight(lo[0]! + dx + ((hi[0]! - lo[0]!) * i) / 6, lo[1]! + dy + ((hi[1]! - lo[1]!) * j) / 6, near);
      if (h !== null && h > ground) ground = h;
    }
  if (ground === -Infinity) return null;
  const r = (v: number) => Math.round(v * 100) / 100;
  return [r(dx), r(dy), r(ground + offset - lo[2]!)];
}

function commitMove(body: string, move: [number, number, number]): void {
  if (move.every((v) => Math.abs(v) < 0.01)) return toast(t("{part} already stands on the terrain.", { part: partName(body, currentDoc().features) }));
  apply({ type: "add_features", features: [{ id: nextFeatureId(currentDoc(), "transform"), op: "transform", bodies: joinedParts(body), translate: move } as Feature] });
}

/** Lowers or raises a part where it is onto the terrain. */
export function setOnTerrain(body: string): void {
  const move = moveOnto(body, undefined, 0);
  if (!move) return toast(t("There is no terrain under {part}.", { part: partName(body, currentDoc().features) }), "error");
  commitMove(body, move);
}

/** The part follows the pointer over the terrain until a click (`placeAt`) or Esc. */
export function startPlacing(body: string): void {
  useTerrainPlace.setState({ body, move: null });
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") useTerrainPlace.setState({ body: null, move: null });
    // Arrow keys raise and lower it: 10 mm a step, 100 mm with Shift.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setPlaceOffset(useTerrainPlace.getState().offset + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 100 : 10));
    }
  };
  window.addEventListener("keydown", keys, true);
  const stop = useTerrainPlace.subscribe((s) => {
    if (s.body) return;
    window.removeEventListener("keydown", keys, true);
    stop();
  });
}

let lastAt: [number, number, number] | null = null;

/** Shows the part standing at a point of the terrain (pointer over the ground). */
export function previewPlace(point: readonly [number, number, number]): void {
  const { body, offset } = useTerrainPlace.getState();
  if (!body) return;
  lastAt = [point[0], point[1], point[2]];
  useTerrainPlace.setState({ move: moveOnto(body, lastAt, offset) });
}

export function setPlaceOffset(offset: number): void {
  const { body } = useTerrainPlace.getState();
  useTerrainPlace.setState({ offset, ...(body && lastAt ? { move: moveOnto(body, lastAt, offset) } : {}) });
}

/** Puts the part where it is shown, or at a tapped point. */
export function placeAt(point: readonly [number, number, number]): void {
  const { body, offset } = useTerrainPlace.getState();
  useTerrainPlace.setState({ body: null, move: null });
  lastAt = null;
  if (!body) return;
  const move = moveOnto(body, [point[0], point[1], point[2]], offset);
  if (!move) return toast(t("There is no terrain there."), "error");
  commitMove(body, move);
}

/** The entries for a part's menus while the design has a terrain. */
export function terrainItems(body: string, icons: { set: ReactNode; place: ReactNode }): { label: string; icon: ReactNode; onClick: () => void }[] {
  if (!hasTerrain()) return [];
  return [
    { label: t("Set onto the terrain"), icon: icons.set, onClick: () => setOnTerrain(body) },
    { label: t("Place on the terrain…"), icon: icons.place, onClick: () => startPlacing(body) },
  ];
}
