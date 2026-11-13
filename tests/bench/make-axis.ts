// Writes the linear axis example (apps/web/src/examples/41-linear-axis.meercad) with its joints made as the
// app makes them.
import { writeFileSync } from "node:fs";
import { applyOp, withMotion } from "@meercad/model";
import type { DocOp, MeercadDocument } from "@meercad/schema";
import { rect, sketch } from "../acceptance/helpers.js";

const base: MeercadDocument = {
  format: "meercad/1",
  params: { travel: "240 mm", plate: "8 mm" },
  features: [],
  rollback: null,
};
const ops: DocOp[] = [
  {
    type: "add_features",
    features: [
      sketch("sk1", { ref: "origin.XY" }, rect("l", -150, -40, 300, 80)),
      {
        id: "ex1",
        op: "extrude",
        name: "Base plate",
        profile: { sketch: "sk1" },
        extent: "blind",
        distance: "plate",
        mode: "new_body",
      },
    ],
  },
  {
    type: "add_features",
    features: [
      {
        id: "np1",
        op: "standard_part",
        kind: "rail",
        size: "MGN12",
        length: "travel",
        withMoving: true,
        plane: { face: { face: "ex1.end_cap" } },
        points: [[-120, 20]],
      },
    ],
  },
  {
    type: "add_features",
    features: [
      { id: "pl1", op: "plane", name: "Screw start", base: { ref: "origin.YZ" }, offset: -130 },
      {
        id: "np2",
        op: "standard_part",
        kind: "lead_screw",
        size: "Tr8x8",
        length: "travel + 20 mm",
        withMoving: true,
        plane: { ref: "pl1" },
        points: [[-10, "plate + 14 mm"]],
      },
    ],
  },
  {
    type: "add_features",
    features: [
      {
        id: "np3",
        op: "standard_part",
        kind: "profile",
        size: "2020",
        length: 60,
        plane: { face: { face: "ex1.end_cap" } },
        points: [
          [-140, -28],
          [140, -28],
        ],
      },
      // Against the posts' inner faces, the leg on the plate pointing inwards.
      {
        id: "np4",
        op: "standard_part",
        kind: "corner_bracket",
        size: "2020",
        plane: { face: { face: "ex1.end_cap" } },
        points: [[-130, -28]],
        angle: -90,
      },
      {
        id: "np5",
        op: "standard_part",
        kind: "corner_bracket",
        size: "2020",
        plane: { face: { face: "ex1.end_cap" } },
        points: [[130, -28]],
        angle: 90,
      },
    ],
  },
];
let d = base;
for (const op of ops) for (const o of withMotion([op], d)) d = applyOp(d, o);
writeFileSync(
  new URL("../../apps/web/src/examples/41-linear-axis.meercad", import.meta.url),
  JSON.stringify(d, null, 1) + "\n",
);
console.log(
  d.features.length,
  d.mechanism?.joints.map((j) => j.id),
  d.mechanism?.couplings,
);
