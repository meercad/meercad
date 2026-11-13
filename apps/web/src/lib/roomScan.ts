/**
 * Scanning a room or an area with the iPhone or iPad and its LiDAR (the app's Room plugin, guided
 * live): a room becomes a design of editable parts (see roomDoc), an area a coloured model of true
 * size around the design (see terrain). The Mac has no camera for this; it opens the results.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem } from "@capacitor/filesystem";
import { newProject, toast } from "../store";
import { nativeApp } from "./native";
import type { TerrainResult } from "./persistence";
import { roomDocument, type RoomScan } from "./roomDoc";
import { addTerrain } from "./terrain";
import { lang, t } from "./i18n";

interface RoomPlugin {
  capabilities(o: { lang: string }): Promise<{ room: boolean; area: boolean }>;
  scanRoom(o: { lang: string }): Promise<RoomScan>;
  scanArea(o: { lang: string }): Promise<TerrainResult & { path: string }>;
}

const Room = registerPlugin<RoomPlugin>("Room");

/** Whether this is the iPhone or iPad app, where rooms and areas can be scanned. */
export const canScanSpaces = nativeApp && Capacitor.getPlatform() === "ios";

let caps: Promise<{ room: boolean; area: boolean }> | null = null;
const capabilities = () => (caps ??= Room.capabilities({ lang }).catch(() => ({ room: false, area: false })));

const stamp = () =>
  new Date().toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Scans a room and opens it as a new project of parts. */
export async function scanRoom(): Promise<void> {
  if (!(await capabilities()).room) {
    return toast(t("Scanning rooms needs an iPhone or iPad with LiDAR and iOS 17 or later."), "error");
  }

  let scan: RoomScan;

  try {
    scan = await Room.scanRoom({ lang });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== "cancelled") toast(err.message ?? t("Scanning failed"), "error");

    return;
  }

  if (!scan.walls.length) {
    return toast(t("No walls were found. Scan again and show every wall for a moment."), "error");
  }

  const doc = roomDocument(scan, {
    wall: (n) => t("Wall {n}", { n }),
    floor: t("Floor"),
    furniture: t("Furniture"),
    object: (c) => t(OBJECTS[c] ?? "Object"),
    door: t("Door"),
    window: t("Window"),
    opening: t("Opening"),
  });
  await newProject(doc, t("Room {when}", { when: stamp() }));
  toast(
    t(
      "{walls} walls, {openings} doors and windows, {objects} pieces of furniture. Every wall is a part you can push, move or cut.",
      {
        walls: scan.walls.length,
        openings: scan.doors.length + scan.windows.length + scan.openings.length,
        objects: scan.objects.length,
      },
    ),
  );
}

/** Scans an area (garden bed, terrace, a corner) into a textured model around the open design. */
export async function scanArea(): Promise<void> {
  if (!(await capabilities()).area) {
    return toast(t("Scanning areas needs an iPhone or iPad with LiDAR."), "error");
  }

  try {
    const r = await Room.scanArea({ lang });
    const file = await Filesystem.readFile({ path: `file://${r.path}` });
    const bytes = Uint8Array.from(atob(file.data as string), (c) => c.charCodeAt(0));
    addTerrain({ ...r, folder: "" }, bytes);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== "cancelled") toast(err.message ?? t("Scanning failed"), "error");
  }
}

/** RoomPlan's furniture kinds as names (translated through t()). */
const OBJECTS: Record<string, string> = {
  bed: "Bed",
  sofa: "Sofa",
  table: "Table",
  chair: "Chair",
  storage: "Cupboard",
  refrigerator: "Fridge",
  stove: "Stove",
  oven: "Oven",
  dishwasher: "Dishwasher",
  washer: "Washing machine",
  toilet: "Toilet",
  bathtub: "Bathtub",
  sink: "Sink",
  fireplace: "Fireplace",
  stairs: "Stairs",
  television: "Television",
};
