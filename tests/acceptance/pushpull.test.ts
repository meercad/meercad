import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);

/** 20×20×5 base with a Ø10 × 10 boss on top. */
const boss: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 20, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
  sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c1", 10, 10, 5)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "join" },
];

describe("push/pull on curved faces", () => {
  it("pulls a round face outward (adds a ring of material)", async () => {
    const s = await newSession();
    const plain = s.rebuild(doc(boss)).report;
    const r = s.rebuild(
      doc([
        ...boss,
        {
          id: "ex3",
          op: "extrude",
          profile: { face: { face: "ex2.side[sk2.c1]" } },
          extent: "blind",
          distance: 1,
          mode: "join",
        },
      ]),
    ).report;
    ok(r);
    expect(r.bodies[0]!.volume - plain.bodies[0]!.volume).toBeCloseTo(Math.PI * (36 - 25) * 10, 0);
  });

  it("pushes a round face inward (cuts a ring away)", async () => {
    const s = await newSession();
    const plain = s.rebuild(doc(boss)).report;
    const r = s.rebuild(
      doc([
        ...boss,
        {
          id: "ex3",
          op: "extrude",
          profile: { face: { face: "ex2.side[sk2.c1]" } },
          extent: "blind",
          distance: 1,
          flip: true,
          mode: "cut",
        },
      ]),
    ).report;
    ok(r);
    expect(plain.bodies[0]!.volume - r.bodies[0]!.volume).toBeCloseTo(Math.PI * (25 - 16) * 10, 0);
  });

  it("narrows and widens a hole", async () => {
    const s = await newSession();
    const plate: Feature[] = [
      boss[0]!,
      boss[1]!,
      sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c1", 10, 10, 3)),
      {
        id: "ex2",
        op: "extrude",
        profile: { sketch: "sk2" },
        extent: "through_all",
        distance: 1,
        flip: true,
        mode: "cut",
      },
    ];
    const wall = { face: { face: "ex2.side[sk2.c1]" } };
    const plain = s.rebuild(doc(plate)).report;
    const narrow = s.rebuild(
      doc([
        ...plate,
        { id: "ex3", op: "extrude", profile: wall, extent: "blind", distance: 1, mode: "join" },
      ]),
    ).report;
    ok(narrow);
    expect(narrow.bodies[0]!.volume - plain.bodies[0]!.volume).toBeCloseTo(Math.PI * (9 - 4) * 5, 0);

    const wide = s.rebuild(
      doc([
        ...plate,
        { id: "ex3", op: "extrude", profile: wall, extent: "blind", distance: 1, flip: true, mode: "cut" },
      ]),
    ).report;
    ok(wide);
    expect(plain.bodies[0]!.volume - wide.bodies[0]!.volume).toBeCloseTo(Math.PI * (16 - 9) * 5, 0);
  });

  it("widens and narrows a countersink", async () => {
    const s = await newSession();
    const plate: Feature[] = [
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 20, 20)),
      {
        id: "ex1",
        op: "extrude",
        profile: { sketch: "sk1" },
        extent: "blind",
        distance: 4,
        mode: "new_body",
      },
      sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c1", 10, 10, 2.25)),
      {
        id: "ex2",
        op: "extrude",
        profile: { sketch: "sk2" },
        extent: "through_all",
        distance: 1,
        flip: true,
        mode: "cut",
      },
      { id: "ch1", op: "chamfer", edges: [{ edge: ["ex1.end_cap", "ex2.side[sk2.c1]"] }], distance: 1 },
    ];
    const cone = { face: { face: "ch1.bevel[ex1.end_cap|ex2.side[sk2.c1]]" } };
    const plain = s.rebuild(doc(plate)).report;
    const wide = s.rebuild(
      doc([
        ...plate,
        { id: "ex3", op: "extrude", profile: cone, extent: "blind", distance: 0.5, flip: true, mode: "cut" },
      ]),
    ).report;
    ok(wide);
    expect(wide.bodies[0]!.volume).toBeLessThan(plain.bodies[0]!.volume - 5);

    const narrow = s.rebuild(
      doc([
        ...plate,
        { id: "ex3", op: "extrude", profile: cone, extent: "blind", distance: 0.3, mode: "join" },
      ]),
    ).report;
    ok(narrow);
    expect(narrow.bodies[0]!.volume).toBeGreaterThan(plain.bodies[0]!.volume + 3);
  });

  it("pushes and pulls a rounded edge", async () => {
    const s = await newSession();
    const box: Feature[] = [
      boss[0]!,
      boss[1]!,
      { id: "fi1", op: "fillet", edges: { edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] }, radius: 4 },
    ];
    const plain = s.rebuild(doc(box)).report;
    const out = s.rebuild(
      doc([
        ...box,
        {
          id: "ex2",
          op: "extrude",
          profile: { face: { face: "fi1.round[ex1.side[sk1.l1]|ex1.side[sk1.l2]]" } },
          extent: "blind",
          distance: 0.5,
          mode: "join",
        },
      ]),
    ).report;
    ok(out);
    expect(out.bodies[0]!.volume).toBeGreaterThan(plain.bodies[0]!.volume);
  });
});
