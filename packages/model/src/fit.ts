/**
 * The fit of a design: the gap a printer needs between two parts that slide or plug into each
 * other (a pin in a hole, a lid on a box, a clip in its slot). Printers differ, so it is measured
 * once with the fit test part and stored in the design (`MeercadDocument.fit`).
 *
 * Every expression can use it by name: `fit`, `fit / 2`, `diameter + fit`. Features that make
 * parts fit together start with `fit` as their gap (FIT_VAR), so changing the design's fit
 * re-sizes all of them at once. A design without a fit uses DEFAULT_FIT.
 */

import { FORMAT, type Expr, type Feature, type MeercadDocument } from "@meercad/schema";

/** The name the fit has in expressions. */
export const FIT_VAR = "fit";
/** The fit of a design that has none, mm: what most FDM printers need with a 0.4 mm nozzle. */
export const DEFAULT_FIT = 0.2;
/** Sensible range for a fit, mm: below the printer's precision nothing fits, above it parts rattle. */
export const FIT_RANGE = [0, 1] as const;

/** The design's fit as an expression (DEFAULT_FIT when it has none). */
export function fitExpr(doc: Pick<MeercadDocument, "fit">): Expr {
  return doc.fit ?? DEFAULT_FIT;
}

/** The gaps (mm, per side) the fit test part tries, one hole each. */
export const FIT_TEST_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4] as const;

/** How a gap is written on the test part and shown to people: "0.15". */
export const fitLabel = (gap: number): string => String(+gap.toFixed(2));

/**
 * The fit test part: a plate with eight holes, each `2 × gap` wider than the pin printed beside
 * it, and the gap engraved under every hole. Print both, push the pin into the holes: the
 * smallest number where it slides in without force and without wobble is the printer's fit.
 * The gap is the room per side (between the pin's face and the hole's wall), as everywhere `fit`
 * is used: a hole for a shaft gets `2 * fit` on its diameter, a lid `fit` all around.
 */
export function fitTestDocument(): MeercadDocument {
  const cols = 4;
  const pitch = 15;
  const rows = [11, -8];
  const xs = Array.from({ length: cols }, (_, i) => (i - (cols - 1) / 2) * pitch);
  const plate: Feature = {
    id: "sk1",
    op: "sketch",
    name: "Plate outline",
    plane: { ref: "origin.XY" },
    entities: [
      { id: "p1", type: "point", x: -32, y: -20 },
      { id: "p2", type: "point", x: 32, y: -20 },
      { id: "p3", type: "point", x: 32, y: 20 },
      { id: "p4", type: "point", x: -32, y: 20 },
      { id: "l1", type: "line", p1: "p1", p2: "p2" },
      { id: "l2", type: "line", p1: "p2", p2: "p3" },
      { id: "l3", type: "line", p1: "p3", p2: "p4" },
      { id: "l4", type: "line", p1: "p4", p2: "p1" },
      { id: "d1", type: "line", p1: "p1", p2: "p3", construction: true },
    ],
    constraints: [
      { id: "c1", type: "horizontal", line: "l1" },
      { id: "c2", type: "horizontal", line: "l3" },
      { id: "c3", type: "vertical", line: "l2" },
      { id: "c4", type: "vertical", line: "l4" },
      { id: "c5", type: "length", line: "l1", value: "64 mm", label: [0, -26] },
      { id: "c6", type: "length", line: "l2", value: "40 mm", label: [40, 0] },
      { id: "c7", type: "midpoint", point: "origin", line: "d1" },
    ],
  };
  const holes: Feature[] = [];
  const labels: Feature[] = [];
  FIT_TEST_STEPS.forEach((gap, i) => {
    const x = xs[i % cols]!;
    const y = rows[Math.floor(i / cols)]!;
    holes.push({
      id: `ho${i + 1}`,
      op: "hole",
      name: `Gap ${fitLabel(gap)}`,
      plane: { face: { face: "ex1.end_cap" } },
      points: [[x, y]],
      kind: "simple",
      diameter: `pin + ${2 * gap} mm`,
    });
    labels.push({
      id: `tx${i + 1}`,
      op: "text",
      name: `Label ${fitLabel(gap)}`,
      plane: { face: { face: "ex1.end_cap" } },
      text: fitLabel(gap),
      font: "sans-bold",
      align: "center",
      position: [x, y - 8.5],
      size: "3.5 mm",
      depth: "0.6 mm",
      mode: "new_body",
      flip: true,
    });
  });

  return {
    format: FORMAT,
    params: { pin: "8 mm", thickness: "5 mm", length: "14 mm" },
    features: [
      plate,
      {
        id: "ex1",
        op: "extrude",
        name: "Plate",
        profile: { sketch: "sk1" },
        extent: "blind",
        distance: "thickness",
        mode: "new_body",
      },
      ...holes,
      ...labels,
      // All numbers cut at once: one by one, every cut has to work through the letters cut before.
      {
        id: "bo1",
        op: "boolean",
        name: "Engrave the gaps",
        operation: "subtract",
        target: "ex1",
        tools: labels.map((l) => l.id),
      },
      {
        id: "sk2",
        op: "sketch",
        name: "Pin",
        plane: { ref: "origin.XY" },
        entities: [
          { id: "q", type: "point", x: 0, y: -32 },
          { id: "c", type: "circle", center: "q", radius: 4 },
        ],
        constraints: [
          { id: "k1", type: "diameter", curve: "c", value: "pin", label: [8, -26] },
          { id: "k2", type: "fix", point: "q" },
        ],
      },
      {
        id: "ex2",
        op: "extrude",
        name: "Pin",
        profile: { sketch: "sk2" },
        extent: "blind",
        distance: "length",
        mode: "new_body",
      },
      // Chamfered ends, so the first layer's squish does not decide the fit.
      {
        id: "ch1",
        op: "chamfer",
        name: "Pin ends",
        edges: [{ edge: ["ex2.end_cap", "ex2.side[sk2.c]"] }, { edge: ["ex2.start_cap", "ex2.side[sk2.c]"] }],
        distance: "0.5 mm",
      },
    ],
    rollback: null,
  };
}
