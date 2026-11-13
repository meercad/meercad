/**
 * An assistant's requests about moving parts and the world outside the design, answered by the
 * app (mcpBridge.ts handle) with the real kernel: poses and the gaps they leave, a joint swept
 * until the parts touch, a motion played, the camera, a robot export, files read and written
 * through the Mac app and examples. The design: a 40 × 20 × 4 base, a lid
 * 1 mm above it on a hinge along X, and a 10 mm cube that slides along X between −30 and 20 mm.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Feature, Joint, SketchEntity } from "@meercad/schema";
import { readStl } from "@meercad/io";
import { testCall } from "./mcpBridge";
import { useMotion } from "./mechanism";

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) =>
  testCall(method, params) as Promise<T>;
const rect = (p: string, x: number, y: number, w: number, h: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y },
  { id: `${p}2`, type: "point", x: x + w, y },
  { id: `${p}3`, type: "point", x: x + w, y: y + h },
  { id: `${p}4`, type: "point", x, y: y + h },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const parts: Feature[] = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("b", 0, 0, 40, 20),
    constraints: [],
  },
  { id: "base", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 4, mode: "new_body" },
  { id: "pl", op: "plane", base: { ref: "origin.XY" }, offset: 5 },
  { id: "sk2", op: "sketch", plane: { ref: "pl" }, entities: rect("l", 0, 0, 40, 20), constraints: [] },
  { id: "lid", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 4, mode: "new_body" },
  {
    id: "sk3",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("c", 60, 0, 10, 10),
    constraints: [],
  },
  { id: "cube", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 10, mode: "new_body" },
];
const hinge: Joint = {
  id: "j1",
  type: "revolute",
  a: "lid",
  b: "base",
  anchor: { axis: { ref: "origin.X" } },
  limits: [-90, 90],
};
const slide: Joint = {
  id: "j2",
  type: "slider",
  a: "cube",
  b: "ground",
  anchor: { axis: { ref: "origin.X" } },
  limits: ["-30 mm", "20 mm"],
};
const desktop = () => (window as unknown as { meercadDesktop: Record<string, unknown> }).meercadDesktop;

beforeAll(async () => {
  await call("new_project", { name: "Moving" });
  await call("apply_ops", {
    ops: [
      { type: "add_features", features: parts },
      { type: "set_joint", joint: hinge },
      { type: "set_joint", joint: slide },
    ],
  });
});

describe("moving parts through the assistant", () => {
  it("sets a pose, says what it could not reach, and measures the gaps it leaves", async () => {
    const r = await call<{
      values: Record<string, number>;
      reached: boolean;
      problems: Record<string, string>;
    }>("set_pose", { values: { j1: 0, j2: 50 } });
    expect(r.values).toEqual({ j1: 0, j2: 20 });
    expect(r.reached).toBe(false);
    expect(Object.keys(r.problems)).toEqual(["j2"]);
    // The cube slid 18.5 mm back stands 1.5 mm from the base's end.
    await call("set_pose", { values: { j1: 0, j2: -18.5 } });

    const gaps = await call<{ pairs: { a: string; b: string; distance: number }[] }>("check_clearance");
    expect(gaps.pairs.find((p) => [p.a, p.b].sort().join() === "base,cube")!.distance).toBeCloseTo(1.5, 6);
    expect(gaps.pairs.find((p) => [p.a, p.b].sort().join() === "base,lid")!.distance).toBeCloseTo(1, 6);
    await call("set_pose", { values: { j1: 0, j2: 0 } });
  });

  it("sweeps a joint until the parts touch: the cube meets the base 20 mm back", async () => {
    const r = await call<{
      firstContact: { value: number; a: string; b: string } | null;
      stoppedAt: number | null;
    }>("check_motion", { joint: "j2", from: 0, to: -30, steps: 30 });
    expect([r.firstContact!.a, r.firstContact!.b].sort()).toEqual(["base", "cube"]);
    expect(r.firstContact!.value).toBeCloseTo(-20, 6);

    // Past its limit it stops where the limit is.
    const far = await call<{ stoppedAt: number | null }>("check_motion", {
      joint: "j2",
      from: 0,
      to: 40,
      steps: 4,
    });
    expect(far.stoppedAt).toBe(20);

    // The sweep for big designs, one joint as a list.
    const sweep = await call<Record<string, unknown>>("check_motion", {
      joints: [{ joint: "j2", from: 0, to: -30, steps: 6 }],
      parts: ["cube"],
      most: 3,
    });
    expect(JSON.stringify(sweep)).toMatch(/base/);

    const one = await call<Record<string, unknown>>("check_motion", {
      joint: "j1",
      from: 0,
      to: 10,
      steps: 2,
      fasteners: false,
    });
    expect(one).toBeTruthy();
    await expect(call("check_motion", { joint: "j1" })).rejects.toThrow(
      /give a joint with from and to, or a motion/,
    );
  });

  it("plays a motion in the app and stops it", async () => {
    await call("apply_ops", {
      ops: [
        {
          type: "set_motion",
          motion: {
            id: "m1",
            name: "Open",
            duration: 2,
            loop: true,
            keys: [
              { at: 0, values: { j1: 0 } },
              { at: 2, values: { j1: 90 } },
            ],
          },
        },
      ],
    });
    expect(await call<string>("play_motion", { motion: "m1" })).toMatch(
      /playing "Open" in the app \(2 s, looping\)/,
    );
    expect(await call<string>("play_motion", { motion: null })).toBe("stopped");
    expect(useMotion.getState().playing ?? null).toBeFalsy();

    const run = await call<Record<string, unknown>>("check_motion", { motion: "m1", steps: 4 });
    expect(run).toBeTruthy();
  });

  it("exports moved parts where they are shown, or where they were drawn", async () => {
    await call("set_pose", { values: { j1: 0, j2: -18.5 } });

    const minX = async (posed: boolean) => {
      const r = await call<{ files: Record<string, string> }>("export", {
        format: "stl",
        parts: ["cube"],
        posed,
      });
      const bytes = Uint8Array.from(atob(Object.values(r.files)[0]!), (c) => c.charCodeAt(0));
      const v = readStl(bytes).vertices;
      let m = Infinity;
      for (let i = 0; i < v.length; i += 3) m = Math.min(m, v[i]!);

      return m;
    };

    // The cube is drawn from x = 60; slid back 18.5 mm it starts at 41.5.
    expect(await minX(true)).toBeCloseTo(41.5, 4);
    expect(await minX(false)).toBeCloseTo(60, 4);
    await call("set_pose", { values: { j1: 0, j2: 0 } });
  });

  it("exports the mechanism as a robot with its links", async () => {
    const r = await call<{ links: unknown[]; warnings: string[]; files?: unknown; token?: string }>(
      "export_robot",
      { name: "box", floating: false, collision: "shapes", masses: { lid: 0.01 }, exclude: [] },
    );
    expect(r.links.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(r.warnings)).toBe(true);
  });
});

describe("the world outside the design", () => {
  it("turns the camera, or says the 3D view is not there", async () => {
    await expect(call("set_view", { view: "iso" })).rejects.toThrow(/viewport not ready/);
  });

  it("reads and writes files through the Mac app, and says when the app cannot", async () => {
    const d = desktop();
    const was = { read: d["readLocalFile"], write: d["writeLocalFile"] };
    const written: unknown[] = [];
    d["readLocalFile"] = async (path: string) => btoa(`at ${path}`);
    d["writeLocalFile"] = async (f: unknown) => void written.push(f);

    try {
      expect(await call("read_file", { path: "/tmp/x.stl" })).toEqual({ base64: btoa("at /tmp/x.stl") });
      expect(await call("write_file", { path: "/tmp/y.stl", base64: "QQ==" })).toEqual({ ok: true });
      expect(written).toEqual([{ path: "/tmp/y.stl", base64: "QQ==" }]);
      d["readLocalFile"] = undefined;
      d["writeLocalFile"] = undefined;
      await expect(call("read_file", { path: "/a" })).rejects.toThrow(/cannot read files for the assistant/);
      await expect(call("write_file", { path: "/a", base64: "" })).rejects.toThrow(
        /cannot write files for the assistant/,
      );
    } finally {
      d["readLocalFile"] = was.read;
      d["writeLocalFile"] = was.write;
    }
  });

  it("refuses a staged export that is gone", async () => {
    await expect(call("staged_files", { token: "nope", pieces: [] })).rejects.toThrow(/no longer here/);
  });

  it("lists the examples and opens one by number", async () => {
    const ex = await call<{ id: number; name: string }[] | { examples: { id: number }[] }>("list_examples");
    const list = Array.isArray(ex) ? ex : ex.examples;
    expect(list.length).toBeGreaterThan(10);

    const opened = await call<Record<string, unknown>>("open_example", { id: list[0]!.id });
    expect(opened).toBeTruthy();
  });
});
