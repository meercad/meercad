import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { grooveShape, threadSpec } from "@meercad/model";
import { readFileSync } from "node:fs";
import { circle, doc, newSession, sketch } from "./helpers.js";

const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);

describe("thread forms", () => {
  it("sizes every form and keeps the metric defaults", () => {
    expect(threadSpec(8, false, {})).toMatchObject({ size: "M8", d: 8, pitch: 1.25, lead: 1.25 });
    expect(threadSpec(10, false, { profile: "trapezoid" })).toMatchObject({ size: "Tr10×2", pitch: 2 });
    expect(threadSpec(40, true, { profile: "round", pitch: 4, starts: 3 })).toMatchObject({
      pitch: 4,
      lead: 12,
      starts: 3,
    });

    for (const profile of ["iso", "trapezoid", "square", "buttress", "round"] as const) {
      for (const internal of [false, true]) {
        const g = grooveShape(profile, 20, 3, internal);
        // External grooves go inwards from the major diameter, internal ones outwards from the minor.
        expect(internal ? g.root > g.crest : g.root < g.crest).toBe(true);
        expect(g.outline.length).toBeGreaterThanOrEqual(4);
      }
    }
  });

  /** Ø20 × 30 rod. */
  const rod: Feature[] = [
    sketch("sk1", { ref: "origin.XY" }, circle("c1", 0, 0, 10)),
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 30, mode: "new_body" },
  ];
  it("cuts trapezoidal, square, buttress, round and two-start threads into a rod", async () => {
    const s = await newSession();
    const full = Math.PI * 100 * 30;

    for (const [profile, starts] of [
      ["trapezoid", 1],
      ["square", 1],
      ["buttress", 1],
      ["round", 1],
      ["trapezoid", 2],
    ] as const) {
      const { report } = s.rebuild(
        doc([...rod, { id: "th1", op: "thread", face: { face: "ex1.side[sk1.c1]" }, profile, starts }]),
      );
      ok(report);

      const v = report.bodies[0]!.volume;
      // Some material goes, at most the ring down to the root.
      expect(v, profile).toBeLessThan(full * 0.95);
      expect(v, profile).toBeGreaterThan(Math.PI * 7 ** 2 * 30);
    }
  });
});

describe("screw", () => {
  it("builds hex, socket and knob screws and a threaded rod to length", async () => {
    const s = await newSession();

    for (const head of ["hex", "socket", "round", "knob", "none"] as const) {
      const { report } = s.rebuild(
        doc([{ id: "scr1", op: "screw", kind: "screw", head, diameter: 8, length: 20, mode: "new_body" }]),
      );
      ok(report);

      const bb = report.bodies[0]!.bbox;
      expect(bb.min[2], head).toBeCloseTo(0, 3);

      const k = head === "none" ? 0 : report.features[0]!.info!["height"]! - 20;
      expect(bb.max[2], head).toBeCloseTo(k + 20, 2);
      // Threaded: less than the plain shank plus a head within Ø25.
      expect(report.bodies[0]!.volume, head).toBeLessThan(Math.PI * 16 * 20 + Math.PI * 12.5 ** 2 * k);
      expect(report.features[0]!.info!["pitch"]).toBe(1.25);
    }
  });

  it("makes a nut that fits the screw (same thread, with clearance)", async () => {
    const s = await newSession();
    const screw: Feature = {
      id: "scr1",
      op: "screw",
      kind: "screw",
      diameter: 12,
      profile: "trapezoid",
      length: 20,
      clearance: 0.15,
      mode: "new_body",
    };
    const nut: Feature = {
      id: "scr2",
      op: "screw",
      kind: "nut",
      diameter: 12,
      profile: "trapezoid",
      clearance: 0.15,
      center: [0, 0],
      plane: { ref: "origin.XY" },
      mode: "new_body",
    };
    const { report } = s.rebuild(doc([screw, nut]));
    ok(report);
    expect(report.bodies).toHaveLength(2);

    const n = report.bodies.find((b) => b.id === "scr2")!;
    expect(n.bbox.max[2] - n.bbox.min[2]).toBeCloseTo(9.6, 2);
  });
});

describe("jar with lid", () => {
  it("threads the jar at its rim (both ends of the wall are open; the rim is the smaller end face)", async () => {
    const s = await newSession();
    const d = JSON.parse(
      readFileSync(new URL("../../apps/web/src/examples/45-jar-with-lid.meercad", import.meta.url), "utf8"),
    );
    const r = s.rebuild(d);
    ok(r.report);

    const m = r.meshes.find((x) => x.bodyId === "ex1")!;
    let zmin = Infinity;

    for (let i = 0; i < m.faceRanges.length; i += 3) {
      if (!m.faceTags[m.faceRanges[i + 2]!]?.includes("th1.thread")) continue;

      for (let k = m.faceRanges[i]!; k < m.faceRanges[i]! + m.faceRanges[i + 1]!; k++) {
        zmin = Math.min(zmin, m.positions[m.indices[k]! * 3 + 2]!);
      }
    }

    // The jar is 50 tall; the 10 mm thread sits at the top.
    expect(zmin).toBeGreaterThan(38);
    expect(zmin).toBeLessThan(50);
  });
});
