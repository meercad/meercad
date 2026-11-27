/**
 * Rounds on lofted parts, faces moved together, and the faces of STEP parts (Trello 2026-11-27,
 * found building a robot's pelvis and thigh shells).
 */
import { describe, expect, it } from "vitest";
import { exportStep, type RebuildReport } from "@meercad/kernel";
import type { Feature, Joint, MeercadDocument, SketchEntity } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const run = async (features: Feature[]) => (await newSession()).rebuild(doc(features)).report;
const PI = Math.PI;

/** Closed spline through n points of an ellipse rx × ry. */
function ellipse(prefix: string, n: number, rx: number, ry: number): SketchEntity[] {
  const points: SketchEntity[] = Array.from({ length: n }, (_, k) => ({
    id: `${prefix}p${k}`,
    type: "point",
    x: rx * Math.cos((2 * PI * k) / n),
    y: ry * Math.sin((2 * PI * k) / n),
  }));

  return [...points, { id: `${prefix}s`, type: "spline", points: points.map((p) => p.id), closed: true }];
}

/** A loft `lo1` through the profiles, `step` apart along Z. */
function loft(sections: SketchEntity[][], step: number): Feature[] {
  const features: Feature[] = [];
  sections.forEach((entities, i) => {
    if (i) features.push({ id: `pl${i}`, op: "plane", base: { ref: "origin.XY" }, offset: i * step });

    features.push(sketch(`sk${i}`, { ref: i ? `pl${i}` : "origin.XY" }, entities));
  });
  features.push({
    id: "lo1",
    op: "loft",
    profiles: sections.map((_, i) => ({ sketch: `sk${i}` })),
    mode: "new_body",
  });

  return features;
}

const around = (cap: string, radius: number): Feature => ({
  id: "fi1",
  op: "fillet",
  edges: { select: "edges", of: "lo1", where: { face: `lo1.${cap}` } },
  radius,
});

describe("rounds on a loft through closed splines", () => {
  const sections = [ellipse("a", 8, 40, 30), ellipse("b", 8, 35, 25)];

  it.each([
    ["start_cap", 1],
    ["start_cap", 3],
    ["start_cap", 6],
    ["end_cap", 3],
    ["end_cap", 6],
  ])("rounds the edge of %s with %d mm", async (cap, radius) => {
    const plain = await run(loft(sections, 40));
    const r = await run([...loft(sections, 40), around(cap, radius)]);
    ok(r);

    // A round on an outer edge takes a little away: about (1 − π/4) r² along the edge.
    const taken = plain.bodies[0]!.volume - r.bodies[0]!.volume;
    const edge = cap === "start_cap" ? 221 : 190;
    expect(taken).toBeGreaterThan(0.5 * (1 - PI / 4) * radius ** 2 * edge);
    expect(taken).toBeLessThan(2 * (1 - PI / 4) * radius ** 2 * edge);
  });

  it("still says so when no round of that size fits", async () => {
    const r = await run([...loft(sections, 40), around("end_cap", 60)]);
    expect(status(r, "fi1").status).toBe("error");
    expect(status(r, "fi1").message).toMatch(/fillet of 60 mm failed/);
  });
});

describe("neighbouring faces moved together", () => {
  const box: Feature[] = [
    sketch("sk1", { ref: "origin.XY" }, rect("r", 0, 0, 60, 40)),
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 30, mode: "new_body" },
  ];
  const sides = ["r1", "r2", "r3", "r4"].map((n) => ({ face: `ex1.side[sk1.${n}]` }));

  it("grows a box on all four sides into a box with its corners", async () => {
    const s = await newSession();
    const { report } = s.rebuild(doc([...box, { id: "of1", op: "offset_face", faces: sides, distance: 3 }]));
    ok(report);
    expect(report.bodies[0]!.volume).toBeCloseTo(66 * 46 * 30, 6);

    const body = s.state!.bodies.get("ex1")!;
    expect(body.faces).toHaveLength(6);

    // The moved faces keep their names, and nothing of the filled corners is left as a face of its own.
    for (const side of sides) {
      expect(body.faceTags.filter((tags) => tags.includes(side.face))).toHaveLength(1);
    }
  });

  it("rounds the grown box all round with a radius larger than the distance", async () => {
    const r = await run([
      ...box,
      { id: "of1", op: "offset_face", faces: sides, distance: 3 },
      { id: "fi1", op: "fillet", edges: { select: "edges", of: "ex1" }, radius: 4 },
    ]);
    ok(r);
  });

  it("shrinks a box on all sides as before", async () => {
    const r = await run([...box, { id: "of1", op: "offset_face", faces: sides, distance: -3 }]);
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo(54 * 34 * 30, 6);
  });

  /** An L: 40 × 40 with a 20 × 20 corner missing, 10 high. */
  const ell: Feature[] = [
    sketch("sk1", { ref: "origin.XY" }, [
      { id: "p1", type: "point", x: 0, y: 0 },
      { id: "p2", type: "point", x: 40, y: 0 },
      { id: "p3", type: "point", x: 40, y: 20 },
      { id: "p4", type: "point", x: 20, y: 20 },
      { id: "p5", type: "point", x: 20, y: 40 },
      { id: "p6", type: "point", x: 0, y: 40 },
      ...[1, 2, 3, 4, 5, 6].map((k): SketchEntity => ({
        id: `l${k}`,
        type: "line",
        p1: `p${k}`,
        p2: `p${(k % 6) + 1}`,
      })),
    ]),
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  ];
  const ellSides = [{ face: "ex1.side[*]" }];

  it("shrinks an L on all sides to the smaller L, without a spike in the inner corner", async () => {
    // Outline moved in by 4: arms 12 wide, 32 × 12 and 12 × 20 (with the spike it was 640 mm²).
    const r = await run([...ell, { id: "of1", op: "offset_face", faces: ellSides, distance: -4 }]);
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo((32 * 12 + 12 * 20) * 10, 6);
  });

  it("grows an L on all sides to the larger L, corners filled", async () => {
    const s = await newSession();
    const { report } = s.rebuild(
      doc([...ell, { id: "of1", op: "offset_face", faces: ellSides, distance: 4 }]),
    );
    ok(report);
    expect(report.bodies[0]!.volume).toBeCloseTo((48 * 28 + 28 * 20) * 10, 6);
    expect(s.state!.bodies.get("ex1")!.faces).toHaveLength(8);
  });

  it("keeps the step where only one of two neighbours moves", async () => {
    const r = await run([...box, { id: "of1", op: "offset_face", faces: [sides[0]!], distance: 3 }]);
    ok(r);
    expect(r.bodies[0]!.volume).toBeCloseTo(60 * 43 * 30, 6);
  });

  it("keeps the step at a corner too sharp to fill", async () => {
    // A wedge with a 10° tip: its two long sides would meet 3 / sin(5°) = 34 mm beyond the tip.
    const tip = 100 * Math.tan((10 * PI) / 180);
    const wedge: Feature[] = [
      sketch("sk1", { ref: "origin.XY" }, [
        { id: "p1", type: "point", x: 0, y: 0 },
        { id: "p2", type: "point", x: 100, y: 0 },
        { id: "p3", type: "point", x: 100, y: tip },
        { id: "l1", type: "line", p1: "p1", p2: "p2" },
        { id: "l2", type: "line", p1: "p2", p2: "p3" },
        { id: "l3", type: "line", p1: "p3", p2: "p1" },
      ]),
      {
        id: "ex1",
        op: "extrude",
        profile: { sketch: "sk1" },
        extent: "blind",
        distance: 10,
        mode: "new_body",
      },
    ];
    const long = [{ face: "ex1.side[sk1.l1]" }, { face: "ex1.side[sk1.l3]" }];
    const r = await run([...wedge, { id: "of1", op: "offset_face", faces: long, distance: 3 }]);
    ok(r);

    // The two slabs alone: each side's length × 3 × 10, on top of the wedge.
    const area = (100 * tip) / 2;
    expect(r.bodies[0]!.volume).toBeCloseTo((area + 3 * 100 + 3 * Math.hypot(100, tip)) * 10, 4);
  });
});

describe("faces of a STEP part", () => {
  /** A plate with a hole and a pin standing on it, written as STEP and read again as `im1`. */
  async function imported(): Promise<Feature> {
    const s = await newSession();
    s.rebuild(
      doc([
        sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 40, 20), ...circle("h", 30, 10, 3)]),
        {
          id: "ex1",
          op: "extrude",
          profile: { sketch: "sk1" },
          extent: "blind",
          distance: 5,
          mode: "new_body",
        },
        sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c", 10, 10, 4)),
        { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 12, mode: "join" },
      ]),
    );

    const step = exportStep(await getOcct(), s.state!);
    let text = "";

    for (let i = 0; i < step.length; i += 0x8000) {
      text += String.fromCharCode(...step.subarray(i, i + 0x8000));
    }

    return { id: "im1", op: "import", format: "step", fileName: "servo.step", data: btoa(text) };
  }

  it("names each face by number and by what it is", async () => {
    const s = await newSession();
    ok(s.rebuild(doc([await imported()])).report);

    const tags = s.state!.bodies.get("im1")!.faceTags;
    expect(tags.every((t) => /^im1\.face\[\d+\]$/.test(t[0]!))).toBe(true);
    // Six sides of the plate (the top with the pin's foot) and the pin's top; the pin and the hole.
    expect(
      tags
        .flat()
        .filter((t) => t.startsWith("im1.plane["))
        .sort(),
    ).toEqual([0, 1, 2, 3, 4, 5, 6].map((n) => `im1.plane[${n}]`));
    expect(
      tags
        .flat()
        .filter((t) => t.startsWith("im1.cylinder["))
        .sort(),
    ).toEqual(["im1.cylinder[0]", "im1.cylinder[1]"]);
  });

  it("gives a joint its axis from the round face at a point", async () => {
    const joints: Joint[] = [
      {
        id: "pin",
        type: "revolute",
        a: "im1",
        b: "ground",
        anchor: { axisOf: { face: "im1.cylinder[*]", near: [10, 14, 10] } },
      },
      {
        id: "hole",
        type: "revolute",
        a: "im1",
        b: "ground",
        anchor: { axisOf: { face: "im1.cylinder[*]", near: [30, 13, 2] } },
      },
    ];
    const d: MeercadDocument = { ...doc([await imported()]), mechanism: { joints } };
    const { report } = (await newSession()).rebuild(d);
    const [pin, hole] = report.joints;

    expect(pin!.error).toBeUndefined();
    expect(pin!.origin.map((v) => +v.toFixed(6))).toEqual([10, 10, 11]);
    expect(Math.abs(pin!.axis[2])).toBeCloseTo(1, 9);
    expect(hole!.error).toBeUndefined();
    expect(hole!.origin.map((v) => +v.toFixed(6))).toEqual([30, 10, 2.5]);
  });

  it("gives a free-form face its number only", async () => {
    const s = await newSession();
    s.rebuild(
      doc([
        sketch("sk1", { ref: "origin.XY" }, ellipse("a", 8, 20, 10)),
        {
          id: "ex1",
          op: "extrude",
          profile: { sketch: "sk1" },
          extent: "blind",
          distance: 5,
          mode: "new_body",
        },
      ]),
    );

    const step = exportStep(await getOcct(), s.state!);
    let text = "";

    for (let i = 0; i < step.length; i += 0x8000) {
      text += String.fromCharCode(...step.subarray(i, i + 0x8000));
    }

    const back = await newSession();
    ok(
      back.rebuild(doc([{ id: "im1", op: "import", format: "step", fileName: "x.step", data: btoa(text) }]))
        .report,
    );

    const tags = back.state!.bodies.get("im1")!.faceTags;
    expect(tags.filter((t) => t.length === 1).length).toBeGreaterThan(0);
    expect(tags.flat().filter((t) => t.startsWith("im1.plane["))).toHaveLength(2);
  });
});
