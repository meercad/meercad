/**
 * Scanning the real world into parts, on iPhones and iPads with LiDAR (the app's native Scan
 * plugin): an object from photos all around it (fine, takes a while), an object with LiDAR (quick,
 * coarser, works from the reachable sides), or a surface with LiDAR (for parts that must fit onto or
 * into something). The scan comes back as STL in millimetres, one file per separate piece, each
 * imported like any mesh, as a whole part. Elsewhere (Mac, browser) scanning is not offered.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem } from "@capacitor/filesystem";
import { toast } from "../store";
import { importFile } from "../components/io";
import { nativeApp } from "./native";
import { lang, t, tn } from "./i18n";

type Caps = { scan: boolean; surface?: boolean; reason?: string };
export type ScanMode = "object" | "lidar" | "surface";

interface ScanPlugin {
  /** `lang`: the interface language, which the native scan screens use too. */
  capabilities(o: { lang: string }): Promise<Caps>;
  imported(o: { folder: string }): Promise<void>;
  scan(o: { mode: ScanMode; lang: string }): Promise<{ path: string; paths?: string[]; folder: string; triangles: number; size: [number, number, number]; photos: number; seconds: number }>;
}
const Scan = registerPlugin<ScanPlugin>("Scan");

let available: Promise<Caps> | null = null;
/** Whether this device can scan, and why not (asked once). */
function capabilities(): Promise<Caps> {
  return (available ??= Scan.capabilities({ lang }).catch((e: { message?: string }) => ({ scan: false, reason: t("The scanner did not answer: {error}", { error: e.message ?? String(e) }) })));
}

/** Whether to offer scanning: in the iPhone/iPad app (a device that cannot scan says why on use). */
export function canScan(): Promise<boolean> {
  return Promise.resolve(nativeApp && Capacitor.getPlatform() === "ios");
}

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

/** Scans an object or a surface and adds it to the open part (or a new project from the overview). */
export async function scanObject(mode: ScanMode = "object"): Promise<void> {
  const caps = await capabilities();
  console.info("scan capabilities", JSON.stringify(caps));
  if (mode === "object" && !caps.scan) return toast(caps.reason || t("This device cannot scan objects."), "error");
  if (mode !== "object" && !caps.surface) return toast(t("Scanning with LiDAR needs an iPhone or iPad with LiDAR."), "error");
  let r: Awaited<ReturnType<ScanPlugin["scan"]>>;
  try {
    r = await Scan.scan({ mode, lang });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.info("scan failed", err.code, err.message);
    if (err.code !== "cancelled") toast(err.message ?? t("Scanning failed"), "error");
    return;
  }
  const stamp = new Date().toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const label = { object: t("Scan"), lidar: t("LiDAR scan"), surface: t("Surface scan") }[mode];
  const paths = r.paths ?? [r.path];
  for (const [k, path] of paths.entries()) {
    const data = await Filesystem.readFile({ path: `file://${path}` });
    const bytes = Uint8Array.from(atob(data.data as string), (c) => c.charCodeAt(0));
    const name = `${label} ${stamp}${paths.length > 1 ? ` (${k + 1})` : ""}.stl`;
    // A scan that did not come in stays on the device and is offered again on the next Scan.
    if (!(await importFile(new File([bytes], name, { type: "model/stl" })))) return;
  }
  void Scan.imported({ folder: r.folder }).catch(() => undefined);
  toast(t("Scan: {size} mm · {triangles} triangles", { size: r.size.map(fmt).join(" × "), triangles: r.triangles.toLocaleString() }) + (r.photos ? ` · ${tn(r.photos, "{n} photo", "{n} photos")}` : ""));
}
