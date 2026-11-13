/**
 * Every kind of joint anchor gives the right axis, and an anchor that cannot give one says why
 * on the joint. A box with a Ø10 shaft standing on it at (100, 0).
 */
import { describe, expect, it } from "vitest";
import type { Feature, Joint, JointAnchor, MeercadDocument } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const parts: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  sketch("skc", { ref: "origin.XY" }, circle("c", 100, 0, 5)),
  { id: "exc", op: "extrude", profile: { sketch: "skc" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "gr1", op: "gear", kind: "spur", module: 1, teeth: 20, width: 4, center: [0, 100], mode: "new_body" },
];

async function frames(anchors: JointAnchor[]) {
  const joints: Joint[] = anchors.map((anchor, i) => ({
    id: `j${i}`,
    type: "revolute",
    a: "exc",
    b: "ground",
    anchor,
  }));
  const d: MeercadDocument = { ...doc(parts), mechanism: { joints } };
  const { report } = (await newSession()).rebuild(d);

  return report.joints;
}

const near = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

describe("joint anchors", () => {
  it("takes the origin axes", async () => {
    const f = await frames([
      { axis: { ref: "origin.X" } },
      { axis: { ref: "origin.Y" } },
      { axis: { ref: "origin.Z" } },
    ]);
    expect(f.map((x) => x.axis)).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(f.every((x) => !x.error && x.origin.every((v) => v === 0))).toBe(true);
  });

  it("takes a gear's axis through the middle of its width", async () => {
    const [f] = await frames([{ gear: "gr1" }]);
    expect(f!.error).toBeUndefined();
    near(f!.origin, [0, 100, 2]);
    near(f!.axis, [0, 0, 1]);
  });

  it("takes a round edge's axis through its centre, and a straight edge through its start", async () => {
    const [round, straight] = await frames([
      { edge: { edge: ["exc.end_cap", "exc.side[skc.c]"] } },
      { edge: { edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] } },
    ]);
    expect(round!.error).toBeUndefined();
    near(round!.origin, [100, 0, 10]);
    near(round!.axis.map(Math.abs), [0, 0, 1]);
    expect(straight!.error).toBeUndefined();
    expect(straight!.origin[0]).toBeCloseTo(40, 6);
    expect(straight!.origin[1]).toBeCloseTo(0, 6);
    near(straight!.axis.map(Math.abs), [0, 0, 1]);
  });

  it("says why an anchor gives no axis", async () => {
    const f = await frames([
      { gear: "zz" },
      { axisOf: { select: "faces", of: "ex1" } },
      { axisOf: { face: "ex1.end_cap" } },
      { edge: { select: "edges", of: "ex1" } },
    ]);
    expect(f.map((x) => x.error)).toEqual([
      'gear "zz" not found',
      "the axis needs exactly one round face",
      "the face is not round: pick a hole, a shaft or a round edge",
      expect.stringMatching(/the axis needs exactly one edge|one edge/),
    ]);
    // An anchor with no axis still gives a usable frame.
    expect(f.every((x) => x.axis.join() === "0,0,1")).toBe(true);
  });
});
