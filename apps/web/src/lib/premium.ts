/**
 * Premium packs: functions that are sold later on top of the free app. Until they are, the App
 * Store build hides them. Test builds (TestFlight, the WIP and development builds)
 * show them, and testers can switch each pack off in Settings to see the app as customers will.
 *
 * Only entry points are hidden. A file that already uses a pack (joints, variants, versions, a
 * scan) still opens and builds exactly as before.
 */
import { create } from "zustand";
import { registerPlugin } from "@capacitor/core";
import { desktop } from "./persistence";
import { nativeApp } from "./native";
import type { MeercadDocument } from "@meercad/schema";
import { featurePack, packsUsed, type PackId, type PackUse } from "./packUse";

export type { PackId };

export interface Pack {
  id: PackId;
  name: string;
  /** What the pack contains, for Settings. */
  contents: string;
}

/** Names are English; Settings translates them with t(). */
export const PACKS: Pack[] = [
  { id: "mechanics", name: "Mechanics", contents: "Joints and moving parts, gears, springs, interference check" },
  { id: "scan", name: "Scan and mesh", contents: "3D scan with the camera or LiDAR, meshes to editable bodies, tracing mesh sections, measuring on scans, deviation and wall thickness maps, mesh clean-up, areas from drone photos" },
  { id: "drawings", name: "Technical drawings", contents: "Drawings as PDF, SVG and DXF" },
  { id: "versions", name: "Versions and variants", contents: "Named versions in the file, variants, exporting all variants" },
];

const STORAGE_KEY = "meercad.packs";

interface PremiumState {
  /** A test build: packs are available and can be switched in Settings. */
  tester: boolean;
  /** The testers' switches; a pack that is missing here is on. */
  off: Partial<Record<PackId, true>>;
}

function loadOff(): PremiumState["off"] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(PACKS.filter((p) => raw[p.id] === false).map((p) => [p.id, true]));
  } catch {
    return {};
  }
}

// The apps start without the packs until their shell has answered (quickly, before the first
// project is open), so an App Store download never flashes them.
export const usePremium = create<PremiumState>(() => ({ tester: false, off: loadOff() }));

/** Whether a pack's functions are shown. */
export function hasPack(id: PackId): boolean {
  const s = usePremium.getState();
  return s.tester && !s.off[id];
}

/** Re-renders when the pack is switched. */
export function usePack(id: PackId): boolean {
  return usePremium((s) => s.tester && !s.off[id]);
}

/** The packs a design uses that are not on here (for a design someone shared). */
export function missingPacks(doc: MeercadDocument): PackUse[] {
  return packsUsed(doc).filter((u) => !hasPack(u.pack));
}

/** The pack needed to change this feature, when it is not on here; null when it can be changed. */
export function lockedBy(f: Parameters<typeof featurePack>[0]): Pack | null {
  const id = featurePack(f);
  return id && !hasPack(id) ? PACKS.find((p) => p.id === id)! : null;
}

export function setPack(id: PackId, on: boolean): void {
  const off = { ...usePremium.getState().off };
  if (on) delete off[id];
  else off[id] = true;
  usePremium.setState({ off });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(PACKS.map((p) => [p.id, !off[p.id]]))));
  } catch {
    // the switches just won't persist
  }
}

const Store = registerPlugin<{ environment(): Promise<{ environment: "production" | "sandbox" }> }>("Store");

/** Asks the shell where the app came from: only an App Store download is not a test build. */
async function checkTester(): Promise<boolean> {
  try {
    if (desktop) return (await desktop.info()).store !== "production";
    if (nativeApp) return (await Store.environment()).environment !== "production";
  } catch {
    // An old shell without the check is a test build.
  }
  return true;
}

/** Settles once the shell has said whether this is a test build. */
export const premiumReady: Promise<void> = checkTester().then((tester) => usePremium.setState({ tester }));
