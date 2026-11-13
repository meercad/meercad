/**
 * The Bend tool's defaults and the numbers it shows: which way to bend a part picked for it, and
 * what a bend comes to (turns, size), read from the kernel's report.
 */
import type { AxisRef, Feature } from "@meercad/schema";
import type { RebuildOutput } from "@meercad/kernel/client";
import { fmtLen as fmtLength } from "./units";
import { t } from "./i18n";

type Bend = Extract<Feature, { op: "bend" }>;
type Box = { min: number[]; max: number[] };

const AXES = ["origin.X", "origin.Y", "origin.Z"] as const;

/** The box around the parts (null when none of them is built). */
export function partsBox(out: RebuildOutput | null, bodies: string[]): Box | null {
  const boxes = (out?.report.bodies ?? []).filter((b) => bodies.includes(b.id)).map((b) => b.bbox);
  if (!boxes.length) return null;

  return {
    min: [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]!))),
    max: [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k]!))),
  };
}

/**
 * Sensible values for a mode on parts of this size: a spiral lies flat (its axis through the
 * thinnest side, so a strip lying on the bed stays on the bed), a bend or wrap goes round the
 * width (a flat strip curls up into an arc or a ring). A wrap closes the ring.
 */
export function bendDefaults(mode: Bend["mode"], box: Box): Partial<Bend> {
  const dims = [0, 1, 2].map((k) => box.max[k]! - box.min[k]!);
  const order = [0, 1, 2].sort((a, b) => dims[a]! - dims[b]!);
  const [small, middle, large] = order as [number, number, number];
  const axisIdx = mode === "spiral" ? small : middle;
  const axis: AxisRef = { ref: AXES[axisIdx]! };
  const length = dims[large]!;
  const radial = dims[mode === "spiral" ? middle : small]!;
  const round = (v: number, step: number) => Math.ceil(v / step - 1e-9) * step;

  if (mode === "spiral") {
    return { mode, axis, radius: Math.max(10, round(radial, 1)), gap: 1, angle: undefined };
  }

  if (mode === "wrap") {
    return {
      mode,
      axis,
      radius: +round(length / (2 * Math.PI), 0.01).toFixed(2),
      gap: undefined,
      angle: undefined,
    };
  }

  return { mode, axis, angle: 90, radius: undefined, gap: undefined };
}

/** What the kernel reported for a bend step (from its last good build), or null. */
export function bendInfo(out: RebuildOutput | null, id: string): Record<string, number> | null {
  return out?.report.features.find((f) => f.id === id)?.info ?? null;
}

/** One line on what the bend comes to. */
export function describeBend(mode: Bend["mode"], info: Record<string, number>): string {
  const n = (v: number, d = 1) => String(+v.toFixed(d));
  const fmtLen = (v: number) => fmtLength(Math.round(v * 10) / 10);

  if (mode === "spiral") {
    return t("{turns} turns, {outer} across; {length} long, {thick} thick", {
      turns: n(info["turns"]!),
      outer: fmtLen(2 * info["outerRadius"]!),
      length: fmtLen(info["length"]!),
      thick: fmtLen(info["thickness"]!),
    });
  }

  if (mode === "wrap") {
    return info["closed"]
      ? t("A closed ring, {d} inside", { d: fmtLen(2 * info["radius"]!) })
      : t("{angle}° of a full ring, {d} inside", {
          angle: n(info["angle"]!),
          d: fmtLen(2 * info["radius"]!),
        });
  }

  return info["closed"]
    ? t("A closed ring, radius {r} in the middle", { r: fmtLen(info["radius"]!) })
    : t("Radius {r} in the middle of the thickness", { r: fmtLen(info["radius"]!) });
}

/** A clear warning about the turns of a spiral, or null. */
export function gapProblem(f: Bend, gap: number | undefined): { text: string; error: boolean } | null {
  if (f.mode !== "spiral" || gap === undefined) return null;
  if (!(gap > 0)) return { text: t("The turns would overlap: the gap must be more than 0 mm."), error: true };
  if (gap < 0.3) return { text: t("Turns closer than 0.3 mm may fuse when printed."), error: false };

  return null;
}

/** The size of the parts before bending, along X, Y and Z, from a bend's report. */
export function unbentBox(info: Record<string, number>): Box {
  const O = [info["ox"]!, info["oy"]!, info["oz"]!],
    A = [info["ax"]!, info["ay"]!, info["az"]!];
  const L = [O[1]! * A[2]! - O[2]! * A[1]!, O[2]! * A[0]! - O[0]! * A[2]!, O[0]! * A[1]! - O[1]! * A[0]!];

  return {
    min: [0, 0, 0],
    max: [0, 1, 2].map(
      (k) =>
        info["length"]! * Math.abs(L[k]!) +
        info["thickness"]! * Math.abs(O[k]!) +
        info["width"]! * Math.abs(A[k]!),
    ),
  };
}
