import { describe, expect, it } from "vitest";
import { clearances, exportMeshes, type RebuildReport } from "@meercad/kernel";
import {
  weldClosed,
  screwBoxSizes,
  snapBoxSizes,
  boxDefaults,
  snapHookStrain,
  DEFAULT_CLEARANCE,
} from "@meercad/model";
import {
  validateDocument,
  type BoxFeature,
  type Feature,
  type MeercadDocument,
  type SnapHookFeature,
} from "@meercad/schema";
import { readFileSync } from "node:fs";
import { doc, getOcct, newSession, rect, sketch } from "./helpers.js";

const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const body = (r: RebuildReport, id: string) => r.bodies.find((b) => b.id === id)!;
const box = (p: Partial<BoxFeature> = {}): BoxFeature => ({
  id: "bx1",
  op: "box",
  lid: "snap",
  width: 60,
  depth: 40,
  height: 30,
  ...p,
});
const jar = (p: Partial<BoxFeature> = {}): BoxFeature => ({
  id: "bx1",
  op: "box",
  lid: "screw",
  width: 60,
  height: 50,
  ...p,
});
const resolved = (f: BoxFeature) => boxDefaults(f, (_k, e) => (e === undefined ? undefined : Number(e)));

async function build(features: Feature[]) {
  const s = await newSession();
  const out = s.rebuild(doc(features));

  return { ...out, session: s };
}

const tagsOf = (meshes: { bodyId: string; faceTags: string[][] }[], id: string) =>
  new Set(meshes.find((m) => m.bodyId === id)!.faceTags.flat());

describe("boxes with a snap lid", () => {
  it("builds box and lid as two parts, the lid upside down beside the box", async () => {
    const { report, meshes } = await build([box()]);
    ok(report);

    const b = body(report, "bx1"),
      l = body(report, "bx1_lid");
    expect(b.bbox.min).toEqual([expect.closeTo(-30, 6), expect.closeTo(-20, 6), expect.closeTo(0, 6)]);
    expect(b.bbox.max).toEqual([expect.closeTo(30, 6), expect.closeTo(20, 6), expect.closeTo(30, 6)]);
    // The lid lies on the plane, its top down, 10 mm to the right of the box.
    expect(l.bbox.min[2]).toBeCloseTo(0, 6);
    expect(l.bbox.min[0]).toBeCloseTo(40, 6);
    expect(l.bbox.max[2]).toBeCloseTo(2 + 6, 6);

    for (const tag of [
      "bx1.bottom",
      "bx1.floor",
      "bx1.wall",
      "bx1.inner",
      "bx1.rim",
      "bx1.groove",
      "bx1.notch",
    ]) {
      expect(tagsOf(meshes, "bx1")).toContain(tag);
    }

    for (const tag of ["bx1.lid_top", "bx1.lid_under", "bx1.lid_side", "bx1.lid_lip", "bx1.lid_bead"]) {
      expect(tagsOf(meshes, "bx1_lid")).toContain(tag);
    }
  });

  it("builds round snap boxes with the same faces", async () => {
    const { report, meshes } = await build([box({ shape: "round", depth: undefined })]);
    ok(report);
    expect(body(report, "bx1").bbox.max[1]).toBeCloseTo(30, 3);

    for (const tag of ["bx1.wall", "bx1.groove", "bx1.rim", "bx1.notch", "bx1.bottom", "bx1.floor"]) {
      expect(tagsOf(meshes, "bx1")).toContain(tag);
    }

    for (const tag of ["bx1.lid_side", "bx1.lid_bead", "bx1.lid_lip", "bx1.lid_top", "bx1.lid_under"]) {
      expect(tagsOf(meshes, "bx1_lid")).toContain(tag);
    }
  });

  it("closes without the parts overlapping: the bead sits in the groove with play", async () => {
    const oc = await getOcct();

    for (const shape of ["rect", "round"] as const) {
      const { report, session } = await build([box({ layout: "closed", shape })]);
      ok(report);

      const pair = clearances(oc, session.state!, ["bx1", "bx1_lid"], {}, 1).find((p) => p.a !== p.b)!;
      expect(pair.overlap).toBeLessThan(1e-3);
      // The lid rests on the rim.
      expect(pair.distance).toBeLessThan(1e-4);
    }
  });

  it("snaps: the bead stands out past the box's inside wall by the snap less the clearance", () => {
    const f = resolved(box());
    const s = snapBoxSizes(f);
    const beadOut = s.lipOuter[0] / 2 + f.snap;
    expect(beadOut - s.inner[0] / 2).toBeCloseTo(f.snap - DEFAULT_CLEARANCE, 9);
  });

  it("refuses a snap deeper than the wall allows", async () => {
    const { report } = await build([box({ wall: 1, snap: 0.8 })]);
    expect(report.features.find((f) => f.id === "bx1")!.message).toMatch(/needs a wall/);
  });
});

describe("jars with a screw lid", () => {
  it("builds a threaded jar and cap that screw together without overlapping", async () => {
    const oc = await getOcct();
    const { report, meshes, session } = await build([jar({ layout: "closed" })]);
    ok(report);

    const b = body(report, "bx1"),
      c = body(report, "bx1_lid");
    expect(b.bbox.max[0] - b.bbox.min[0]).toBeCloseTo(60, 3);
    expect(b.bbox.max[2]).toBeCloseTo(50, 6);
    expect(c.bbox.max[2]).toBeCloseTo(52, 6);

    for (const tag of [
      "bx1.thread",
      "bx1.neck",
      "bx1.shoulder",
      "bx1.wall",
      "bx1.rim",
      "bx1.floor",
      "bx1.bottom",
      "bx1.inner",
    ]) {
      expect(tagsOf(meshes, "bx1")).toContain(tag);
    }

    for (const tag of [
      "bx1.lid_thread",
      "bx1.lid_top",
      "bx1.lid_under",
      "bx1.lid_rim",
      "bx1.lid_inner",
      "bx1.lid_side",
    ]) {
      expect(tagsOf(meshes, "bx1_lid")).toContain(tag);
    }

    const pair = clearances(oc, session.state!, ["bx1", "bx1_lid"], {}, 1).find((p) => p.a !== p.b)!;
    expect(pair.overlap).toBeLessThan(1e-3);

    // The threads really are there: the ridges add material beyond the plain neck and skirt.
    const s = screwBoxSizes(resolved(jar()));
    const plainCap = Math.PI * 30 ** 2 * 2 + Math.PI * (30 ** 2 - s.skirt ** 2) * (12 - s.capGap);
    expect(c.volume).toBeGreaterThan(plainCap + 100);
  });

  it("two starts close in half the turn and still fit", async () => {
    const oc = await getOcct();
    const { report, session } = await build([jar({ layout: "closed", starts: 2, pitch: 3 })]);
    ok(report);

    const pair = clearances(oc, session.state!, ["bx1", "bx1_lid"], {}, 1).find((p) => p.a !== p.b)!;
    expect(pair.overlap).toBeLessThan(1e-3);
  });

  it("refuses a rectangular screw box and a jar too narrow for its thread", async () => {
    expect(validateDocument(doc([jar({ shape: "rect" })])).ok).toBe(false);

    const { report } = await build([jar({ width: 16 })]);
    expect(report.features.find((f) => f.id === "bx1")!.message).toMatch(/too narrow/);
  });
});

describe("snap hooks", () => {
  // A base plate and, standing on it, a wall the hook clicks into.
  const parts: Feature[] = [
    sketch("sk1", { ref: "origin.XY" }, rect("a", 0, 0, 40, 30)),
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, distance: 3, mode: "new_body" } as Feature,
    { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 3 },
    sketch("sk2", { ref: "pl1" }, rect("b", 20, 0, 2, 30)),
    { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, distance: 17, mode: "new_body" } as Feature,
  ];
  const hook = (p: Partial<SnapHookFeature> = {}): SnapHookFeature => ({
    id: "sh1",
    op: "snap_hook",
    plane: { ref: "pl1" },
    points: [[20, 15]],
    catchIn: ["ex2"],
    ...p,
  });

  it("joins the hook to the part it stands on and cuts its window into the other", async () => {
    const oc = await getOcct();
    const before = (await build(parts)).report;
    const { report, meshes, session } = await build([...parts, hook()]);
    ok(report);
    expect(report.bodies.map((b) => b.id).sort()).toEqual(["ex1", "ex2"]);

    for (const tag of ["sh1.beam", "sh1.back", "sh1.catch", "sh1.lead", "sh1.side"]) {
      expect(tagsOf(meshes, "ex1")).toContain(tag);
    }

    expect(tagsOf(meshes, "ex2")).toContain("sh1.window");
    // Beam 1.6 × 6 × 10 plus barb and root web.
    expect(body(report, "ex1").volume - body(before, "ex1").volume).toBeGreaterThan(1.6 * 6 * 10);

    // The window goes through the 2 mm wall: (6 + 2·0.2) wide, from 0.2 below the catch to 0.2 above the
    // barb.
    const top = 13 + 0.4 + 0.8 / Math.tan(Math.PI / 6);
    expect(body(before, "ex2").volume - body(report, "ex2").volume).toBeCloseTo(
      2 * 6.4 * (top + 0.2 - (13 - 0.2)),
      3,
    );

    const pair = clearances(oc, session.state!, ["ex1", "ex2"], {}, 1).find((p) => p.a !== p.b)!;
    expect(pair.overlap).toBeLessThan(1e-3);
  });

  it("several hooks, turned and on the other side of the plane", async () => {
    const { report } = await build([
      ...parts,
      hook({
        points: [
          [10, 8],
          [10, 22],
        ],
        angle: 180,
        catchIn: undefined,
        flip: true,
        mode: "new_body",
      }),
    ]);
    ok(report);

    const h = body(report, "sh1");
    expect(h.bbox.max[2]).toBeCloseTo(3 + 0.05, 6);
    expect(h.bbox.min[0]).toBeCloseTo(10 - 0.8, 6);
  });

  it("warns about a hook that bends too far and works out the strain", async () => {
    expect(snapHookStrain({ length: 10, thickness: 1.6, overhang: 0.8 })).toBeCloseTo(0.0192, 6);

    const { report } = await build([...parts, hook({ length: 4, thickness: 2.5, catchIn: undefined })]);
    expect(report.features.find((f) => f.id === "sh1")!.message).toMatch(/bends 18\.8 %/);
  });
});

describe("example: boxes and snap hooks", () => {
  it("the case's lid clicks in: its hooks sit in the windows without touching the case", async () => {
    const oc = await getOcct();
    const ex = JSON.parse(
      readFileSync(
        new URL("../../apps/web/src/examples/42-boxes-and-snap-hooks.meercad", import.meta.url),
        "utf8",
      ),
    ) as MeercadDocument;
    const session = await newSession();
    const { report, meshes } = session.rebuild(ex);
    ok(report);
    expect(report.bodies.map((b) => b.id).sort()).toEqual(["bx1", "bx1_lid", "bx2", "bx2_lid", "ex1", "ex2"]);
    expect(tagsOf(meshes, "ex1")).toContain("sh1.window");
    expect(tagsOf(meshes, "ex1")).toContain("sh2.window");
    expect(tagsOf(meshes, "ex2")).toContain("sh1.catch");

    const pair = clearances(oc, session.state!, ["ex1", "ex2"], {}, 1).find((p) => p.a !== p.b)!;
    expect(pair.overlap).toBeLessThan(1e-3);
  });
});

describe("export", () => {
  it("every box, lid and hooked part exports closed and manifold", async () => {
    const oc = await getOcct();
    const ex = JSON.parse(
      readFileSync(
        new URL("../../apps/web/src/examples/42-boxes-and-snap-hooks.meercad", import.meta.url),
        "utf8",
      ),
    ) as MeercadDocument;
    const session = await newSession();
    ok(
      session.rebuild({
        ...ex,
        features: [
          ...ex.features,
          { ...box({ id: "bx3", shape: "round", depth: undefined }), position: [0, 200] },
          { ...jar({ id: "bx4", starts: 2, pitch: 3 }), position: [200, 200] },
        ],
      }).report,
    );

    const meshes = exportMeshes(oc, session.state!);
    expect(meshes).toHaveLength(10);

    const open = meshes.filter((m) => {
      const corners = new Float32Array(m.indices.length * 3);

      for (let i = 0; i < m.indices.length; i++) {
        corners.set(m.positions.subarray(m.indices[i]! * 3, m.indices[i]! * 3 + 3), i * 3);
      }

      try {
        weldClosed(corners, 1e-4);

        return false;
      } catch {
        return true;
      }
    });
    expect(open.map((m) => m.bodyId)).toEqual([]);
  });
});
