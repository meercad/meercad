import { readFileSync } from "node:fs";
import { KernelSession, loadOcct, type OC } from "@opencad/kernel";
import type { Feature, OpencadDocument, PlaneSpec, SketchEntity, SketchFeature } from "@opencad/schema";
import { SketchSolver } from "@opencad/sketch";

let occt: Promise<OC> | null = null;
let solver: Promise<SketchSolver> | null = null;
export const getOcct = () => (occt ??= loadOcct());
export const getSolver = () => (solver ??= SketchSolver.create());
export async function newSession(): Promise<KernelSession> {
  return new KernelSession(await getOcct(), await getSolver());
}

export function corpus(name: string): OpencadDocument {
  return JSON.parse(readFileSync(new URL(`../corpus/${name}`, import.meta.url), "utf8")) as OpencadDocument;
}

export function withParams(doc: OpencadDocument, params: Record<string, string | number>): OpencadDocument {
  return { ...doc, params: { ...doc.params, ...params } };
}

export const doc = (features: Feature[], params: Record<string, string | number> = {}): OpencadDocument => ({ format: "opencad/1", params, features, rollback: null });

/** Unconstrained sketch geometry helpers (coordinates are taken as drawn). */
export function rect(prefix: string, x0: number, y0: number, w: number, h: number): SketchEntity[] {
  const p = (i: number) => `${prefix}p${i}`;
  return [
    { id: p(1), type: "point", x: x0, y: y0 },
    { id: p(2), type: "point", x: x0 + w, y: y0 },
    { id: p(3), type: "point", x: x0 + w, y: y0 + h },
    { id: p(4), type: "point", x: x0, y: y0 + h },
    { id: `${prefix}1`, type: "line", p1: p(1), p2: p(2) },
    { id: `${prefix}2`, type: "line", p1: p(2), p2: p(3) },
    { id: `${prefix}3`, type: "line", p1: p(3), p2: p(4) },
    { id: `${prefix}4`, type: "line", p1: p(4), p2: p(1) },
  ];
}
export function circle(id: string, x: number, y: number, r: number): SketchEntity[] {
  return [
    { id: `${id}c`, type: "point", x, y },
    { id, type: "circle", center: `${id}c`, radius: r },
  ];
}
export function sketch(id: string, plane: PlaneSpec, entities: SketchEntity[], constraints: SketchFeature["constraints"] = []): SketchFeature {
  return { id, op: "sketch", plane, entities, constraints };
}
