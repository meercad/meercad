/**
 * Printability of a part as a colour map: red where the surface hangs over more steeply than an FDM
 * printer prints without supports, blue where it rests on the build plate, green elsewhere. With
 * the best way up to print it, and turning the part so a face lies on the plate. Kept up to date
 * while the part changes, until it is closed.
 */
import {
  nextFeatureId,
  outwardSign,
  printCheck,
  rankOrientations,
  SURFACE_OVERHANG,
  SURFACE_PLATE,
  turnPoint,
  turnsToLay,
  type PrintCheck,
} from "@meercad/model";
import type { BodyMesh } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { create } from "zustand";
import { apply, currentDoc, toast, useApp } from "../store";
import { partName } from "./features";
import { joinedParts } from "./mechanism";
import { t } from "./i18n";
import { actionFor, COMMON_ACTIONS } from "./keymap";

type V3 = [number, number, number];

export interface PrintStats {
  limit: number;
  /** Surface hanging over more than the limit, mm². */
  overhangArea: number;
  /** Share of the surface that hangs over. */
  overhangShare: number;
  plateArea: number;
  /** Rough support volume, mm³. */
  supportVolume: number;
  height: number;
  /**
   * The best way up found: the direction onto the plate, and its numbers. Null while it is the current one.
   */
  best: { down: V3; supportVolume: number; overhangArea: number; plateArea: number; height: number } | null;
}

/** As it stands: -Z onto the plate. */
const AS_IT_STANDS: V3 = [0, 0, -1];

export const usePrintCheck = create<{
  body: string | null;
  picking: boolean;
  limit: number;
  down: V3;
  maps: Map<string, { positions: Float32Array; colors: Float32Array }>;
  stats: PrintStats | null;
  error?: string;
}>(() => ({
  body: null,
  picking: false,
  limit: 45,
  down: AS_IT_STANDS,
  maps: new Map(),
  stats: null,
}));

/** Shows the print check of a part, printed with `down` onto the plate (default as it stands). */
export function showPrintCheck(body: string, down: V3 = AS_IT_STANDS): void {
  usePrintCheck.setState({ body, down, stats: null, error: undefined });
  update();
}

export function hidePrintCheck(): void {
  usePrintCheck.setState({
    body: null,
    picking: false,
    down: AS_IT_STANDS,
    maps: new Map(),
    stats: null,
    error: undefined,
  });
}

export function setOverhangLimit(limit: number): void {
  usePrintCheck.setState({ limit });
  update();
}

const meshOf = (body: string): BodyMesh | undefined =>
  useApp.getState().output?.meshes.find((mesh) => mesh.bodyId === body);

/**
 * The print check of a part as it stands (or printed with `down` onto the plate), and the best orientation
 * found.
 */
export function checkPart(
  body: string,
  limit = usePrintCheck.getState().limit,
  down: V3 = AS_IT_STANDS,
): { check: PrintCheck; stats: PrintStats } | null {
  const mesh = meshOf(body);
  if (!mesh) return null;

  const check = printCheck(mesh.positions, mesh.indices, down, limit);
  const [best] = rankOrientations(mesh.positions, mesh.indices, limit);
  const l = Math.hypot(...down) || 1;
  const same = best
    ? (best.down[0] * down[0] + best.down[1] * down[1] + best.down[2] * down[2]) / l > 0.9999
    : true;
  // Only worth suggesting when it saves a noticeable share of the support (or of the overhang).
  const better = best && !same && best.check.supportVolume < check.supportVolume * 0.9 - 1 ? best : null;

  return {
    check,
    stats: {
      limit,
      overhangArea: check.overhangArea,
      overhangShare: check.area ? check.overhangArea / check.area : 0,
      plateArea: check.plateArea,
      supportVolume: check.supportVolume,
      height: check.height,
      best: better
        ? {
            down: better.down,
            supportVolume: better.check.supportVolume,
            overhangArea: better.check.overhangArea,
            plateArea: better.check.plateArea,
            height: better.check.height,
          }
        : null,
    },
  };
}

function update(): void {
  const { body, limit, down } = usePrintCheck.getState();
  if (!body) return;

  const mesh = meshOf(body);
  const r = mesh ? checkPart(body, limit, down) : null;
  if (!mesh || !r) return usePrintCheck.setState({ maps: new Map(), stats: null, error: "gone" });

  const n = r.check.kind.length;
  const positions = new Float32Array(n * 9);
  const colors = new Float32Array(n * 9);

  for (let k = 0; k < n; k++) {
    const rgb = r.check.kind[k] === SURFACE_OVERHANG ? RED : r.check.kind[k] === SURFACE_PLATE ? BLUE : GREEN;

    for (let c = 0; c < 3; c++) {
      const v = mesh.indices[k * 3 + c]! * 3;

      for (let a = 0; a < 3; a++) {
        positions[k * 9 + c * 3 + a] = mesh.positions[v + a]!;
        colors[k * 9 + c * 3 + a] = linear(rgb[a]!);
      }
    }
  }

  usePrintCheck.setState({
    maps: new Map([[body, { positions, colors }]]),
    stats: r.stats,
    error: undefined,
  });
}

const RED = [0.86, 0.22, 0.2];
const GREEN = [0.42, 0.74, 0.5];
const BLUE = [0.3, 0.52, 0.9];
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const css = (c: number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
/** Swatch colours for the legend. */
export const PRINT_COLORS = { overhang: css(RED), ok: css(GREEN), plate: css(BLUE) };

/** Outward normal of a flat face of a part, from its own triangles (null for a curved face). */
export function faceNormal(body: string, face: number): V3 | null {
  const mesh = meshOf(body);
  if (!mesh) return null;

  const sign = outwardSign(mesh.positions, mesh.indices);
  const P = mesh.positions,
    I = mesh.indices;
  const sum: V3 = [0, 0, 0];
  let area = 0;

  for (let r = 0; r < mesh.faceRanges.length; r += 3) {
    if (mesh.faceRanges[r + 2] !== face) continue;

    const first = mesh.faceRanges[r]!,
      count = mesh.faceRanges[r + 1]!;

    for (let i = first; i < first + count; i += 3) {
      const a = I[i]! * 3,
        b = I[i + 1]! * 3,
        c = I[i + 2]! * 3;
      const ux = P[b]! - P[a]!,
        uy = P[b + 1]! - P[a + 1]!,
        uz = P[b + 2]! - P[a + 2]!;
      const vx = P[c]! - P[a]!,
        vy = P[c + 1]! - P[a + 1]!,
        vz = P[c + 2]! - P[a + 2]!;
      const n: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (let k = 0; k < 3; k++) sum[k] = sum[k]! + (sign * n[k]!) / 2;
      area += Math.hypot(...n) / 2;
    }
  }

  const l = Math.hypot(...sum);
  // A flat face's normals all agree; a curved one's partly cancel.
  if (!area || l < area * 0.999) return null;

  return [sum[0] / l, sum[1] / l, sum[2] / l];
}

/**
 * Turns a part (with the parts joined to it) so that `down` points onto the build plate, and sets it
 * on the plate (its lowest point at Z = 0) where it stood. Two moves in the feature list: about Z,
 * then about X with the shift.
 */
export function layDown(body: string, down: V3): boolean {
  const mesh = meshOf(body);
  if (!mesh) return false;

  const name = partName(body, currentDoc().features);
  const { aboutZ, aboutX } = turnsToLay(down);
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  const lo2 = [Infinity, Infinity, Infinity],
    hi2 = [-Infinity, -Infinity, -Infinity];
  const P = mesh.positions;

  for (let i = 0; i < P.length; i += 3) {
    const p: V3 = [P[i]!, P[i + 1]!, P[i + 2]!];
    const q = turnPoint(p, aboutZ, aboutX);

    for (let k = 0; k < 3; k++) {
      ((lo[k] = Math.min(lo[k]!, p[k]!)), (hi[k] = Math.max(hi[k]!, p[k]!)));
      ((lo2[k] = Math.min(lo2[k]!, q[k]!)), (hi2[k] = Math.max(hi2[k]!, q[k]!)));
    }
  }

  const round = (v: number) => Math.round(v * 1e4) / 1e4 || 0;
  // Stays where it stood over the plate; its bottom goes to Z = 0.
  const shift: V3 = [
    round((lo[0]! + hi[0]!) / 2 - (lo2[0]! + hi2[0]!) / 2),
    round((lo[1]! + hi[1]!) / 2 - (lo2[1]! + hi2[1]!) / 2),
    round(-lo2[2]!),
  ];

  if (!aboutZ && !aboutX && shift.every((v) => Math.abs(v) < 0.001)) {
    toast(t("{part} already lies that way on the plate.", { part: name }));

    return false;
  }

  const bodies = joinedParts(body);
  const doc = currentDoc();
  const features: Feature[] = [];
  // Two new ids at once: the second counts the first.
  const id = (op: Feature["op"]) => nextFeatureId({ ...doc, features: [...doc.features, ...features] }, op);

  if (aboutZ) {
    features.push({
      id: id("transform"),
      op: "transform",
      name: t("Turn for printing"),
      bodies,
      rotate: { axis: { ref: "origin.Z" }, angle: `${aboutZ} deg` },
    } as Feature);
  }

  features.push({
    id: id("transform"),
    op: "transform",
    name: t("Lay on the plate"),
    bodies,
    ...(aboutX ? { rotate: { axis: { ref: "origin.X" }, angle: `${aboutX} deg` } } : {}),
    ...(shift.some((v) => v) ? { translate: shift } : {}),
  } as Feature);
  apply({ type: "add_features", features });

  return true;
}

/**
 * The flat area of a mesh part (an STL import, a scan) around a hit triangle's normal: the
 * area-weighted normal of all its triangles facing within about 5° of it.
 */
function meshFlatNormal(body: string, near: V3): V3 | null {
  const mesh = meshOf(body);
  if (!mesh) return null;

  const l0 = Math.hypot(...near);
  if (!l0) return null;

  const h: V3 = [near[0] / l0, near[1] / l0, near[2] / l0];
  const sign = outwardSign(mesh.positions, mesh.indices);
  const P = mesh.positions,
    I = mesh.indices;
  const sum: V3 = [0, 0, 0];

  for (let i = 0; i < I.length; i += 3) {
    const a = I[i]! * 3,
      b = I[i + 1]! * 3,
      c = I[i + 2]! * 3;
    const ux = P[b]! - P[a]!,
      uy = P[b + 1]! - P[a + 1]!,
      uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!,
      vy = P[c + 1]! - P[a + 1]!,
      vz = P[c + 2]! - P[a + 2]!;
    const n: V3 = [sign * (uy * vz - uz * vy), sign * (uz * vx - ux * vz), sign * (ux * vy - uy * vx)];
    const l = Math.hypot(...n);
    if (!l || (n[0] * h[0] + n[1] * h[1] + n[2] * h[2]) / l < 0.995) continue;

    for (let k = 0; k < 3; k++) sum[k] = sum[k]! + n[k]!;
  }

  const l = Math.hypot(...sum);

  return l ? [sum[0] / l, sum[1] / l, sum[2] / l] : null;
}

/**
 * Lays a part on one of its flat faces. On a mesh part (`meshHit`: the surface normal where it was
 * hit) the flat area around that spot counts as the face.
 */
export function layOnFace(body: string, face: number, meshHit?: V3): void {
  const n = faceNormal(body, face) ?? (meshHit ? meshFlatNormal(body, meshHit) : null);
  if (!n) return toast(t("Only a flat face can lie on the plate."), "error");

  usePrintCheck.setState({ picking: false });
  layDown(body, n);
}

/** The next face clicked or tapped goes onto the plate (Esc or a click on nothing ends it). */
export function pickFaceToLay(on = true): void {
  usePrintCheck.setState({ picking: on });
  if (!on) return;

  const keys = (event: KeyboardEvent) => {
    if (actionFor(event, COMMON_ACTIONS) === "cancel") usePrintCheck.setState({ picking: false });
  };

  window.addEventListener("keydown", keys, true);

  const stop = usePrintCheck.subscribe((s) => {
    if (s.picking) return;

    window.removeEventListener("keydown", keys, true);
    stop();
  });
}

/** Turns a part the way up it prints with the least support. */
export function printBestWayUp(body: string): void {
  const r = checkPart(body);
  if (!r) return;

  if (!r.stats.best) {
    return toast(
      t("{part} already stands the best way up for printing.", {
        part: partName(body, currentDoc().features),
      }),
    );
  }

  layDown(body, r.stats.best.down);
}

useApp.subscribe((state, prev) => {
  if (!usePrintCheck.getState().body) return;
  if (state.project?.id !== prev.project?.id || state.screen !== "editor") hidePrintCheck();
  else if (state.output !== prev.output && !state.previewing) update();
});
