import { describe, expect, it } from "vitest";
import { hasLoops, Linkage } from "./linkage.js";
import { transformPoint, type Mat4, type MotionJoint, type V3 } from "./motion.js";

const Z: V3 = [0, 0, 1];
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const rev = (id: string, a: string, b: string, origin: V3): MotionJoint => ({
  id,
  type: "revolute",
  a,
  b,
  origin,
  axis: Z,
});

/** Upper intersection of circles (c1, r1) and (c2, r2) in the plane. */
function meet(c1: [number, number], r1: number, c2: [number, number], r2: number): [number, number] {
  const dx = c2[0] - c1[0];
  const dy = c2[1] - c1[1];
  const d = Math.hypot(dx, dy);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1[0] + (a * dx) / d;
  const my = c1[1] + (a * dy) / d;

  return [mx - (h * dy) / d, my + (h * dx) / d];
}

/** Four-bar: ground pivots (0,0) and (g,0); crank c, coupler k, rocker r; drawn with the crank at 90°. */
function fourBar(g: number, c: number, k: number, r: number) {
  const A: [number, number] = [0, c];
  const B = meet(A, k, [g, 0], r);
  const joints = [
    rev("crank", "crank", "ground", [0, 0, 0]),
    rev("pinA", "coupler", "crank", [A[0], A[1], 0]),
    rev("rocker", "rocker", "ground", [g, 0, 0]),
    rev("pinB", "coupler", "rocker", [B[0], B[1], 0]),
  ];

  const rockerAngle = (crank: number) => {
    const a: [number, number] = [c * Math.cos(rad(crank)), c * Math.sin(rad(crank))];
    const b = meet(a, k, [g, 0], r);

    return deg(Math.atan2(b[1], b[0] - g));
  };

  return { joints, rockerAngle, B };
}

describe("closed-loop linkages", () => {
  it("drives a crank-rocker round and round, matching the closed form", () => {
    const { joints, rockerAngle } = fourBar(100, 30, 90, 70);
    expect(hasLoops(joints)).toBe(true);

    const L = new Linkage(joints);
    let poses: Map<string, Mat4> = new Map();
    const rest = rockerAngle(90);

    for (let step = 15; step <= 720; step += 15) {
      const r = L.solve(poses, { crank: step });
      expect(r.ok, `crank ${step}°`).toBe(true);
      poses = r.poses;
      expect(r.values["crank"]).toBeCloseTo(step, 4);

      // The rocker's turn from where it was drawn equals the closed-form angle change.
      const want = rockerAngle(90 + step) - rest;
      expect(Math.abs(((r.values["rocker"]! - want + 540) % 360) - 180)).toBeLessThan(0.05);
      expect(r.residual).toBeLessThan(1e-4);
    }
  });

  it("moves a piston as a slider-crank should", () => {
    const rr = 20;
    const l = 60;
    const xRest = Math.sqrt(l * l - rr * rr);
    const joints: MotionJoint[] = [
      rev("crank", "crank", "ground", [0, 0, 0]),
      rev("pinA", "rod", "crank", [0, rr, 0]),
      { id: "slide", type: "slider", a: "piston", b: "ground", origin: [xRest, 0, 0], axis: [1, 0, 0] },
      rev("pinB", "rod", "piston", [xRest, 0, 0]),
    ];
    const L = new Linkage(joints);
    let poses: Map<string, Mat4> = new Map();

    for (let step = 10; step <= 360; step += 10) {
      const r = L.solve(poses, { crank: step });
      expect(r.ok, `crank ${step}°`).toBe(true);
      poses = r.poses;

      const t = rad(90 + step);
      const x = rr * Math.cos(t) + Math.sqrt(l * l - rr * rr * Math.sin(t) ** 2);
      expect(r.values["slide"]).toBeCloseTo(x - xRest, 2);
      // The piston only slides: its pin stays on the X axis.
      expect(transformPoint(poses.get("piston")!, [xRest, 0, 0])[1]).toBeCloseTo(0, 5);
    }
  });

  it("stops at a dead point instead of flipping over", () => {
    // Crank longer than the linkage allows a full turn of: it can only rock.
    const { joints } = fourBar(100, 60, 50, 70);
    const L = new Linkage(joints);
    const r = L.solve(new Map(), { crank: 180 });
    expect(r.ok).toBe(false);
    // It got part of the way and every joint still closes there.
    expect(Math.abs(r.values["crank"]!)).toBeGreaterThan(1);
    expect(Math.abs(r.values["crank"]!)).toBeLessThan(180);
    expect(r.residual).toBeLessThan(1e-4);
  });

  it("follows a dragged point", () => {
    const { joints, B } = fourBar(100, 30, 90, 70);
    const L = new Linkage(joints);
    // Pull the rocker's pin a little to the left, looking down onto the plane.
    const target: V3 = [B[0] - 5, B[1], 0];
    const r = L.solve(
      new Map(),
      {},
      {
        part: "rocker",
        local: [B[0], B[1], 0],
        ray: { origin: [target[0], target[1], 100], dir: [0, 0, -1] },
      },
    );
    expect(r.ok).toBe(true);

    const p = transformPoint(r.poses.get("rocker")!, [B[0], B[1], 0]);
    expect(p[0]).toBeLessThan(B[0] - 2);
    expect(r.residual).toBeLessThan(1e-4);
  });

  it("holds a driven joint at its limit", () => {
    const { joints } = fourBar(100, 30, 90, 70);
    const limited = joints.map((joint) =>
      joint.id === "crank" ? { ...joint, limits: [-20, 40] as [number, number] } : joint,
    );
    const L = new Linkage(limited);
    const beyond = L.solve(new Map(), { crank: 75 });

    expect(beyond.values["crank"]).toBeCloseTo(40, 4);
    expect(beyond.residual).toBeLessThan(1e-4);

    const below = L.solve(new Map(), { crank: -60 });

    expect(below.values["crank"]).toBeCloseTo(-20, 4);
  });

  it("turns a coupled wheel with the crank, at the coupling's ratio", () => {
    const { joints } = fourBar(100, 30, 90, 70);
    const wheel = rev("wheel", "wheel", "ground", [200, 0, 0]);
    const L = new Linkage([...joints, wheel], [{ driver: "crank", driven: "wheel", ratio: 2 }]);
    const r = L.solve(new Map(), { crank: 20 });

    expect(r.ok).toBe(true);
    expect(r.values["crank"]).toBeCloseTo(20, 3);
    expect(r.values["wheel"]).toBeCloseTo(40, 3);
  });
});
