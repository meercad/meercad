/**
 * Sketch evaluation. Phase 0: rectangles only, constraints are stored but not solved
 * (PlaneGCS integration is Phase 1).
 */

import type { PlaneRef } from "@opencad/schema";

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface RectangleInput {
  id: string;
  type: "rectangle";
  corner: Vec2;
  size: Vec2;
}

export interface SketchInput {
  id: string;
  plane: { ref: PlaneRef };
  entities: RectangleInput[];
  constraints?: unknown[];
}

/** Closed loop; edge i runs from points[i] to points[(i+1) % n] and is named edgeNames[i]. */
export interface Loop {
  points: Vec2[];
  edgeNames: string[];
}

export interface Profile {
  /** e.g. "sk1.r1.region" */
  ref: string;
  /** Outer loop first, counter-clockwise in sketch coordinates. */
  loops: Loop[];
}

export interface PlaneFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  /** u × v */
  normal: Vec3;
}

export interface SketchResult {
  id: string;
  frame: PlaneFrame;
  profiles: Map<string, Profile>;
  warnings: string[];
}

export class SketchError extends Error {}

const FRAMES: Record<PlaneRef, PlaneFrame> = {
  "origin.XY": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  "origin.XZ": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
  "origin.YZ": { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
};

export function planeFrame(ref: PlaneRef): PlaneFrame {
  return FRAMES[ref];
}

export function toWorld(frame: PlaneFrame, [a, b]: Vec2): Vec3 {
  const { origin: o, u, v } = frame;
  return [o[0] + a * u[0] + b * v[0], o[1] + a * u[1] + b * v[1], o[2] + a * u[2] + b * v[2]];
}

export function evaluateSketch(sketch: SketchInput): SketchResult {
  const profiles = new Map<string, Profile>();
  const warnings: string[] = [];
  if (sketch.constraints?.length) {
    warnings.push(`${sketch.constraints.length} constraint(s) stored but not solved yet`);
  }
  for (const e of sketch.entities) {
    const [w, h] = e.size;
    if (Math.abs(w) < 1e-6 || Math.abs(h) < 1e-6) {
      throw new SketchError(`rectangle ${e.id} has zero size (${w} × ${h})`);
    }
    // Normalise negative sizes so the loop is CCW and edge names keep their meaning.
    const x0 = Math.min(e.corner[0], e.corner[0] + w);
    const y0 = Math.min(e.corner[1], e.corner[1] + h);
    const x1 = x0 + Math.abs(w);
    const y1 = y0 + Math.abs(h);
    const name = (side: string) => `${sketch.id}.${e.id}.${side}`;
    profiles.set(`${sketch.id}.${e.id}.region`, {
      ref: `${sketch.id}.${e.id}.region`,
      loops: [
        {
          points: [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
          ],
          edgeNames: [name("bottom"), name("right"), name("top"), name("left")],
        },
      ],
    });
  }
  return { id: sketch.id, frame: planeFrame(sketch.plane.ref), profiles, warnings };
}
