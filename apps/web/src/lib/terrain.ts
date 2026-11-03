/**
 * A textured 3D model of an area from overhead photos (a drone flight): the folder of photos goes
 * to Apple's photogrammetry on the Mac (a helper next to the app) or the iPad (the Terrain plugin),
 * which gives back a GLB in millimetres. Photos with GPS give it its true size, with north along +Y.
 * It becomes a reference model of the design: shown, not built into parts.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem } from "@capacitor/filesystem";
import type { MeercadDocument, ReferenceModel } from "@meercad/schema";
import type { SceneryView } from "@meercad/viewport";
import { apply, openProject, startTask, toast, useApp } from "../store";
import { nativeApp } from "./native";
import { desktop, type TerrainResult } from "./persistence";
import { t } from "./i18n";

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
  const task = startTask(t("Model from photos"), null, { long: true, cancel: cancelTerrain, ...(project ? { project } : {}) });
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

function addTerrain(r: TerrainResult & { folder: string }, bytes: Uint8Array): void {
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
    r.geo
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
    return { id: r.id, data, ...(r.hidden ? { hidden: true } : {}) };
  });
}
