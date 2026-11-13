import { readFileSync } from "node:fs";
import { KernelSession, loadOcct, type OC } from "@meercad/kernel";
import type { Feature, MeercadDocument, PlaneSpec, SketchEntity, SketchFeature } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { nudged, sameModel } from "../incremental-check.js";

let occt: Promise<OC> | null = null;
let solver: Promise<SketchSolver> | null = null;
export const getOcct = () => (occt ??= loadOcct());
export const getSolver = () => (solver ??= SketchSolver.create());

export async function newSession(): Promise<KernelSession> {
  return new KernelSession(await getOcct(), await getSolver());
}

export function corpus(name: string): MeercadDocument {
  return JSON.parse(readFileSync(new URL(`../corpus/${name}`, import.meta.url), "utf8")) as MeercadDocument;
}

export function withParams(doc: MeercadDocument, params: Record<string, string | number>): MeercadDocument {
  return { ...doc, params: { ...doc.params, ...params } };
}

export const doc = (features: Feature[], params: Record<string, string | number> = {}): MeercadDocument => ({
  format: "meercad/1",
  params,
  features,
  rollback: null,
});

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

export function sketch(
  id: string,
  plane: PlaneSpec,
  entities: SketchEntity[],
  constraints: SketchFeature["constraints"] = [],
): SketchFeature {
  return { id, op: "sketch", plane, entities, constraints };
}

/**
 * For the checks that a rebuild which keeps earlier results gives the model built from scratch.
 */
/**
 * Changes each step in turn (and back), comparing with a build from scratch each time; throws on a
 * difference.
 */
export async function checkEveryStep(
  base: MeercadDocument,
  name: string,
): Promise<{ steps: number; computed: number; scratch: number }> {
  // A kernel of its own: OCCT keeps memory of every cut and join, and the many builds from scratch
  // here would fill the kernel the other tests share.
  const oc = await loadOcct();
  const solver = await getSolver();
  const newSession = () => new KernelSession(oc, solver);
  const session = newSession();
  session.rebuild(base, { props: false });

  let current = base;
  let computed = 0,
    scratch = 0,
    steps = 0;

  for (const f of base.features) {
    for (const next of [nudged(current, f.id), base]) {
      current = next;
      session.rebuild(current, { props: false, onFeature: () => computed++ });

      const fresh = newSession();
      fresh.rebuild(current, { props: false, mesh: false, onFeature: () => scratch++ });

      const diff = sameModel(oc, session.state!, fresh.state!);
      if (diff) throw new Error(`${name}: after changing ${f.id}: ${diff}`);

      fresh.dispose();
      steps++;
    }
  }

  // A preview next to the open design takes results over the same way and leaves the design alone.
  const last = base.features.at(-1);

  if (last) {
    const tried = nudged(base, base.features[0]!.id);
    session.preview(tried, { props: false });
    session.rebuild(base, { props: false });

    const fresh = newSession();
    fresh.rebuild(base, { props: false, mesh: false });

    const diff = sameModel(oc, session.state!, fresh.state!);
    if (diff) throw new Error(`${name}: after a preview: ${diff}`);

    fresh.dispose();
  }

  session.dispose();

  return { steps, computed, scratch };
}
