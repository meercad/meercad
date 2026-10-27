/** Fully parametric starter models for the home screen. */
import type { Expr, MeercadDocument, SketchConstraint, SketchEntity } from "@meercad/schema";

/** Rectangle anchored at the origin with width/height dimensions. */
function rect(w: Expr, h: Expr, centered: boolean, x = 40, y = 20): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  const entities: SketchEntity[] = [
    { id: "p1", type: "point", x: centered ? -x / 2 : 0, y: centered ? -y / 2 : 0 },
    { id: "p2", type: "point", x: centered ? x / 2 : x, y: centered ? -y / 2 : 0 },
    { id: "p3", type: "point", x: centered ? x / 2 : x, y: centered ? y / 2 : y },
    { id: "p4", type: "point", x: centered ? -x / 2 : 0, y: centered ? y / 2 : y },
    { id: "l1", type: "line", p1: "p1", p2: "p2" },
    { id: "l2", type: "line", p1: "p2", p2: "p3" },
    { id: "l3", type: "line", p1: "p3", p2: "p4" },
    { id: "l4", type: "line", p1: "p4", p2: "p1" },
  ];
  const constraints: SketchConstraint[] = [
    { id: "c1", type: "horizontal", line: "l1" },
    { id: "c2", type: "horizontal", line: "l3" },
    { id: "c3", type: "vertical", line: "l2" },
    { id: "c4", type: "vertical", line: "l4" },
    { id: "c5", type: "length", line: "l1", value: w, label: [centered ? 0 : x / 2, centered ? -y / 2 - 6 : -6] },
    { id: "c6", type: "length", line: "l2", value: h, label: [centered ? x / 2 + 8 : x + 8, centered ? 0 : y / 2] },
  ];
  if (centered) {
    entities.push({ id: "d1", type: "line", p1: "p1", p2: "p3", construction: true });
    constraints.push({ id: "c7", type: "midpoint", point: "origin", line: "d1" });
  } else constraints.push({ id: "c7", type: "coincident", a: "p1", b: "origin" });
  return { entities, constraints };
}

const plate = rect("width", "depth", true, 60, 40);
const bracket: MeercadDocument = {
  format: "meercad/1",
  params: { width: "60 mm", depth: "40 mm", thickness: "4 mm", hole: "4.5 mm", inset: "10 mm", corner: "5 mm" },
  features: [
    { id: "sk1", op: "sketch", name: "Plate outline", plane: { ref: "origin.XY" }, ...plate },
    { id: "ex1", op: "extrude", name: "Plate", profile: { sketch: "sk1" }, extent: "blind", distance: "thickness", mode: "new_body" },
    {
      id: "fi1",
      op: "fillet",
      name: "Corners",
      edges: [
        { edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] },
        { edge: ["ex1.side[sk1.l2]", "ex1.side[sk1.l3]"] },
        { edge: ["ex1.side[sk1.l3]", "ex1.side[sk1.l4]"] },
        { edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l4]"] },
      ],
      radius: "corner",
    },
    {
      id: "sk2",
      op: "sketch",
      name: "Holes",
      plane: { face: { face: "ex1.end_cap" } },
      entities: [
        { id: "q1", type: "point", x: -20, y: 0 },
        { id: "h1", type: "circle", center: "q1", radius: 2.25 },
        { id: "q2", type: "point", x: 20, y: 0 },
        { id: "h2", type: "circle", center: "q2", radius: 2.25 },
      ],
      constraints: [
        { id: "c1", type: "diameter", curve: "h1", value: "hole", label: [-20, 6] },
        { id: "c2", type: "equal", a: "h1", b: "h2" },
        { id: "c3", type: "horizontal_points", a: "q1", b: "origin" },
        { id: "c4", type: "horizontal_points", a: "q2", b: "origin" },
        { id: "c5", type: "distance", a: "q1", b: "origin", axis: "x", value: "width / 2 - inset", label: [-10, -8] },
        { id: "c6", type: "distance", a: "origin", b: "q2", axis: "x", value: "width / 2 - inset", label: [10, -8] },
      ],
    },
    { id: "ex2", op: "extrude", name: "Holes", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, flip: true, mode: "cut" },
    {
      id: "ch1",
      op: "chamfer",
      name: "Countersinks",
      edges: [
        { edge: ["ex1.end_cap", "ex2.side[sk2.h1]"] },
        { edge: ["ex1.end_cap", "ex2.side[sk2.h2]"] },
      ],
      distance: "1 mm",
    },
  ],
  rollback: null,
};

const boxRect = rect("width", "length", true, 80, 50);
const box: MeercadDocument = {
  format: "meercad/1",
  params: { width: "80 mm", length: "50 mm", height: "30 mm", wall: "2 mm", round: "4 mm" },
  features: [
    { id: "sk1", op: "sketch", name: "Footprint", plane: { ref: "origin.XY" }, ...boxRect },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "height", mode: "new_body" },
    { id: "fi1", op: "fillet", name: "Round corners", edges: [{ edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] }, { edge: ["ex1.side[sk1.l2]", "ex1.side[sk1.l3]"] }, { edge: ["ex1.side[sk1.l3]", "ex1.side[sk1.l4]"] }, { edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l4]"] }], radius: "round" },
    { id: "fi2", op: "fillet", name: "Bottom edge", edges: { select: "edges", of: "ex1", where: { face: "start_cap" } }, radius: "wall + 1 mm" },
    { id: "sh1", op: "shell", name: "Hollow", faces: [{ face: "ex1.end_cap" }], thickness: "wall" },
  ],
  rollback: null,
};

const flange: MeercadDocument = {
  format: "meercad/1",
  params: { outer: "60 mm", bore: "20 mm", thickness: "8 mm", holes: 6, hole: "6 mm", pcd: "45 mm" },
  features: [
    {
      id: "sk1",
      op: "sketch",
      name: "Disc",
      plane: { ref: "origin.XY" },
      entities: [
        { id: "o", type: "point", x: 0, y: 0 },
        { id: "c1", type: "circle", center: "o", radius: 30 },
        { id: "c2", type: "circle", center: "o", radius: 10 },
      ],
      constraints: [
        { id: "k1", type: "coincident", a: "o", b: "origin" },
        { id: "k2", type: "diameter", curve: "c1", value: "outer", label: [24, 26] },
        { id: "k3", type: "diameter", curve: "c2", value: "bore", label: [8, 12] },
      ],
    },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "thickness", mode: "new_body" },
    {
      id: "sk2",
      op: "sketch",
      name: "Bolt hole",
      plane: { face: { face: "ex1.end_cap" } },
      entities: [
        { id: "q", type: "point", x: 22.5, y: 0 },
        { id: "h", type: "circle", center: "q", radius: 3 },
      ],
      constraints: [
        { id: "k1", type: "diameter", curve: "h", value: "hole", label: [26, 6] },
        { id: "k2", type: "horizontal_points", a: "q", b: "origin" },
        { id: "k3", type: "distance", a: "origin", b: "q", axis: "x", value: "pcd / 2", label: [11, -6] },
      ],
    },
    { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, flip: true, mode: "cut" },
    { id: "cp1", op: "circular_pattern", source: { features: ["ex2"] }, axis: { ref: "origin.Z" }, count: "holes" },
    { id: "ch1", op: "chamfer", edges: { edge: ["ex1.end_cap", "ex1.side[sk1.c1]"] }, distance: "1 mm" },
  ],
  rollback: null,
};

export const EXAMPLES: { name: string; description: string; thumbnail: string; doc: MeercadDocument }[] = [
  { name: "Mounting plate", description: "Holes, countersinks, rounded corners", thumbnail: "/examples/mounting-plate.png", doc: bracket },
  { name: "Project box", description: "Shelled enclosure with fillets", thumbnail: "/examples/project-box.png", doc: box },
  { name: "Flange", description: "Circular bolt pattern", thumbnail: "/examples/flange.png", doc: flange },
];
