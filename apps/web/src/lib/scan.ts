/**
 * Scanning a real object into a part, on iPhones and iPads with LiDAR (the app's native Scan
 * plugin). The scan comes back as an STL in millimetres and is imported like any mesh, as a whole
 * part. Elsewhere (Mac, browser, devices without LiDAR) scanning is not offered.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem } from "@capacitor/filesystem";
import { toast } from "../store";
import { importFile } from "../components/io";
import { nativeApp } from "./native";

interface ScanPlugin {
  capabilities(): Promise<{ scan: boolean; reason?: string }>;
  imported(o: { folder: string }): Promise<void>;
  scan(): Promise<{ path: string; folder: string; triangles: number; size: [number, number, number]; photos: number; seconds: number }>;
}
const Scan = registerPlugin<ScanPlugin>("Scan");

let available: Promise<{ scan: boolean; reason?: string }> | null = null;
/** Whether this device can scan, and why not (asked once). */
function capabilities(): Promise<{ scan: boolean; reason?: string }> {
  return (available ??= Scan.capabilities().catch((e: { message?: string }) => ({ scan: false, reason: `The scanner did not answer: ${e.message ?? String(e)}` })));
}

/** Whether to offer scanning: in the iPhone/iPad app (a device that cannot scan says why on use). */
export function canScan(): Promise<boolean> {
  return Promise.resolve(nativeApp && Capacitor.getPlatform() === "ios");
}

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

/** Scans an object and adds it to the open part (or a new project from the overview). */
export async function scanObject(): Promise<void> {
  const caps = await capabilities();
  console.info("scan capabilities", JSON.stringify(caps));
  if (!caps.scan) return toast(caps.reason || "This device cannot scan objects.", "error");
  let r: Awaited<ReturnType<ScanPlugin["scan"]>>;
  try {
    r = await Scan.scan();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.info("scan failed", err.code, err.message);
    if (err.code !== "cancelled") toast(err.message ?? "Scanning failed", "error");
    return;
  }
  const data = await Filesystem.readFile({ path: `file://${r.path}` });
  const bytes = Uint8Array.from(atob(data.data as string), (c) => c.charCodeAt(0));
  const name = `Scan ${new Date().toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.stl`;
  // A scan that did not come in stays on the device and is offered again on the next Scan.
  if (!(await importFile(new File([bytes], name, { type: "model/stl" })))) return;
  void Scan.imported({ folder: r.folder }).catch(() => undefined);
  toast(`Scan: ${r.size.map(fmt).join(" × ")} mm · ${r.triangles.toLocaleString()} triangles${r.photos ? ` · ${r.photos} photos` : ""}`);
}
