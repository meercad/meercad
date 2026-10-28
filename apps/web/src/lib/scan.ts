/**
 * Scanning a real object into a part, on iPhones and iPads with LiDAR (the app's native Scan
 * plugin). The scan comes back as an STL in millimetres and is imported like any mesh, as a whole
 * part. Elsewhere (Mac, browser, devices without LiDAR) scanning is not offered.
 */
import { registerPlugin } from "@capacitor/core";
import { Filesystem } from "@capacitor/filesystem";
import { toast } from "../store";
import { importFile } from "../components/io";
import { nativeApp } from "./native";

interface ScanPlugin {
  capabilities(): Promise<{ scan: boolean }>;
  scan(): Promise<{ path: string; folder: string; triangles: number; size: [number, number, number]; photos: number; seconds: number }>;
}
const Scan = registerPlugin<ScanPlugin>("Scan");

let available: Promise<boolean> | null = null;
/** Whether this device can scan (asked once). */
export function canScan(): Promise<boolean> {
  return (available ??= nativeApp ? Scan.capabilities().then((c) => c.scan, () => false) : Promise.resolve(false));
}

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

/** Scans an object and adds it to the open part (or a new project from the overview). */
export async function scanObject(): Promise<void> {
  let r: Awaited<ReturnType<ScanPlugin["scan"]>>;
  try {
    r = await Scan.scan();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== "cancelled") toast(err.message ?? "Scanning failed", "error");
    return;
  }
  const data = await Filesystem.readFile({ path: `file://${r.path}` });
  const bytes = Uint8Array.from(atob(data.data as string), (c) => c.charCodeAt(0));
  const name = `Scan ${new Date().toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.stl`;
  await importFile(new File([bytes], name, { type: "model/stl" }));
  toast(`Scan: ${r.size.map(fmt).join(" × ")} mm · ${r.triangles.toLocaleString()} triangles · ${r.photos} photos`);
}
