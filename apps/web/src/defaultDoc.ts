import type { OpencadDocument } from "@opencad/schema";

export const DEFAULT_DOC: OpencadDocument = {
  format: "opencad/1",
  params: { wall: "2 mm", w: "40 mm", d: "20 mm", h: "10 mm" },
  features: [
    {
      id: "sk1",
      op: "sketch",
      plane: { ref: "origin.XY" },
      entities: [{ id: "r1", type: "rectangle", corner: [0, 0], size: ["w", "d"] }],
    },
    { id: "ex1", op: "extrude", profile: { ref: "sk1.r1.region" }, distance: "h", mode: "new_body" },
    { id: "fi1", op: "fillet", edges: { edge: ["ex1.end_cap", "ex1.side[sk1.r1.top]"] }, radius: "wall" },
  ],
  rollback: null,
};
