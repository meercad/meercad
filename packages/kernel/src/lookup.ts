/**
 * Lookups over all parts of a state, put as questions (see `ask` in tracking.ts) so that a step
 * which found its parts this way is only run again when the answer changes.
 */
import { resolveEdges, resolveFaces, type FaceRef } from "@meercad/naming";
import type { EdgeSelector, FaceSelector } from "@meercad/schema";
import type { Body } from "./body.js";
import { bodyBounds, boundsOverlap, type bounds } from "./boolean.js";
import type { OC } from "./occt.js";
import { ask } from "./tracking.js";

type Bodies = ReadonlyMap<string, Body>;
type Box = ReturnType<typeof bounds>;

/** The faces a selector names, among all parts. */
export function facesIn(bodies: Bodies, sel: FaceSelector): FaceRef[] {
  return ask(bodies, (m) => {
    const refs = resolveFaces(sel, [...m.values()]);

    return { refs, parts: refs.map((faceRef) => m.get(faceRef.body)) };
  }).refs;
}

/** The edges selectors name, among all parts. */
export function edgesIn(bodies: Bodies, sels: readonly EdgeSelector[]): ReturnType<typeof resolveEdges> {
  return ask(bodies, (m) => {
    const ref = resolveEdges(sels, [...m.values()]);

    return { ref, part: m.get(ref.body) };
  }).ref;
}

/** The parts whose box reaches into `box`, in the order of the model; `skip` leaves parts out by id. */
export function partsReaching(oc: OC, bodies: Bodies, box: Box, skip?: (id: string) => boolean): Body[] {
  return ask(bodies, (m) =>
    [...m.values()].filter((b) => !skip?.(b.bodyId) && boundsOverlap(bodyBounds(oc, b), box)),
  );
}

/** How far the model reaches from the origin along any axis (at least 100). */
export function reach(oc: OC, bodies: Bodies): number {
  return ask(bodies, (m) => {
    let size = 100;

    for (const b of m.values()) {
      const bb = bodyBounds(oc, b);
      size = Math.max(size, ...bb.max.map(Math.abs), ...bb.min.map(Math.abs));
    }

    return size;
  });
}
