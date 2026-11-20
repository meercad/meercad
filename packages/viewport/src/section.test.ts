import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  axisSection,
  clipPlane,
  faceSection,
  FACE_CLEAR,
  facingSection,
  flipSection,
  handleOrigin,
  HATCH_PX,
  keeps,
  offsetForShown,
  offsetRange,
  outline,
  planeAxes,
  sectionCenter,
  shownValue,
  unit,
  withCap,
  type Box,
} from "./section";

/** A part 80 × 50 × 30 standing on the plate, centred on the origin in x and y. */
const box: Box = { min: [-40, -25, 0], max: [40, 25, 30] };

const close = (a: readonly number[], b: readonly number[]) =>
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

describe("section plane", () => {
  it("normalises a direction, and takes Z for none", () => {
    close(unit([0, 3, 4]), [0, 0.6, 0.8]);
    expect(unit([0, 0, 0])).toEqual([0, 0, 1]);
  });

  it("spans the offsets of a box along a direction", () => {
    expect(offsetRange(box, [0, 0, 1])).toEqual([0, 30]);
    expect(offsetRange(box, [-1, 0, 0])).toEqual([-40, 40]);

    // Along a diagonal: the corners' projections.
    const [lo, hi] = offsetRange(box, [1, 1, 0]);
    expect(lo).toBeCloseTo(-65 / Math.SQRT2, 9);
    expect(hi).toBeCloseTo(65 / Math.SQRT2, 9);
  });

  it("cuts square to an axis through the middle, or keeps the other half", () => {
    expect(axisSection("z", box)).toEqual({ normal: [0, 0, 1], offset: 15 });
    expect(axisSection("x", box, true)).toEqual({ normal: [-1, -0, -0], offset: 0 });
  });

  it("cuts away the half toward the viewer, square to the axis seen most along or the one asked for", () => {
    // From the front-right-top corner (the iso view): Y is looked along most, from -Y.
    const iso = [0.6, -0.75, 0.55];
    expect(facingSection(box, iso)).toEqual({ normal: [-0, -1, -0], offset: 0 });
    expect(facingSection(box, iso, "x")).toEqual({ normal: [1, 0, 0], offset: 0 });
    // From above Z wins; from the left X, kept on the right.
    expect(facingSection(box, [0.1, 0.2, 0.9])).toEqual({ normal: [0, 0, 1], offset: 15 });
    expect(facingSection(box, [-0.9, 0.1, 0.2]).normal).toEqual([-1, -0, -0]);
    // Looking straight along X: neither Y nor Z beats it.
    expect(facingSection(box, [1, 0, 0]).normal).toEqual([1, 0, 0]);
  });

  it("lies on a face a hair in front of it, so the face stays whole", () => {
    const s = faceSection([5, 25, 7], [0, 2, 0]);
    expect(s.normal).toEqual([0, 1, 0]);
    expect(s.offset).toBeCloseTo(25 + FACE_CLEAR, 12);
    expect(faceSection([0, 0, 30], [0, 0, 1], 0)).toEqual({ normal: [0, 0, 1], offset: 30 });
  });

  it("flips to keep the other side of the same plane", () => {
    expect(flipSection({ normal: [0, 0, 1], offset: 10 })).toEqual({ normal: [-0, -0, -1], offset: -10 });
  });

  it("keeps what lies behind the plane, on it within a tolerance, and everything without a section", () => {
    const s = { normal: [0, 0, 1] as [number, number, number], offset: 10 };
    expect(keeps(s, [0, 0, 5])).toBe(true);
    expect(keeps(s, [0, 0, 10])).toBe(true);
    expect(keeps(s, [0, 0, 10.5])).toBe(false);
    expect(keeps(s, [0, 0, 10.5], 1)).toBe(true);
    expect(keeps(null, [0, 0, 1e9])).toBe(true);
  });

  it("finds two axes in the plane, square to each other and to its normal", () => {
    for (const n of [
      [0, 0, 1],
      [1, 0, 0],
      [0, -1, 0],
      [1, 2, 3],
    ]) {
      const { u, v } = planeAxes(n);
      const nn = unit(n);
      const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
      expect(dot(u, nn)).toBeCloseTo(0, 12);
      expect(dot(v, nn)).toBeCloseTo(0, 12);
      expect(dot(u, v)).toBeCloseTo(0, 12);
      expect(Math.hypot(...u)).toBeCloseTo(1, 12);
      expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    }
  });

  it("drops the box's middle onto the plane, and onto the parallel plane through the origin for the arrow", () => {
    const s = { normal: [0, 0, 1] as [number, number, number], offset: 20 };
    expect(sectionCenter(s, box)).toEqual([0, 0, 20]);
    // The arrow's value along the normal is then the offset.
    expect(handleOrigin(s, box)).toEqual([0, 0, 0]);
    close(handleOrigin({ normal: [1, 0, 0], offset: 7 }, { min: [10, 0, 0], max: [20, 4, 6] }), [0, 2, 3]);
  });

  it("outlines the plane round everything of the box, a little wider", () => {
    const corners = outline({ normal: [0, 0, 1], offset: 10 }, box);
    expect(corners).toHaveLength(4);
    for (const c of corners) expect(c[2]).toBeCloseTo(10, 12);

    const xs = corners.map((c) => Math.abs(c[0]));
    const ys = corners.map((c) => Math.abs(c[1]));
    // u, v are X and Y here in some order and sign: half sizes 40 and 25, 8 % wider.
    expect(new Set([...xs, ...ys].map((v) => +v.toFixed(6)))).toEqual(new Set([43.2, 27]));

    // Without a margin, and a flat box seen edge on still gets a rectangle a quarter as deep as wide.
    const flat = outline({ normal: [0, 1, 0], offset: 0 }, { min: [0, 0, 0], max: [40, 0, 0] }, 0);
    const span = (k: 0 | 2) => Math.max(...flat.map((c) => c[k])) - Math.min(...flat.map((c) => c[k]));
    expect(span(0)).toBeCloseTo(40, 9);
    expect(span(2)).toBeCloseTo(10, 9);
  });

  it("turns into the three.js plane that keeps the other side", () => {
    const plane = clipPlane({ normal: [0, 0, 1], offset: 10 });
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 5))).toBeGreaterThan(0);
    expect(plane.distanceToPoint(new THREE.Vector3(0, 0, 15))).toBeLessThan(0);

    const target = new THREE.Plane();
    expect(clipPlane({ normal: [1, 0, 0], offset: 2 }, target)).toBe(target);
  });

  it("shows the position along the axis, or the depth under the face it was laid on, and back", () => {
    const up = { normal: [0, 0, 1] as [number, number, number], offset: 12 };
    const down = flipSection(up);
    expect(shownValue(up, "z", 0)).toBe(12);
    expect(shownValue(down, "z", 0)).toBe(12);
    expect(offsetForShown(12, down, "z", 0)).toBe(-12);
    expect(offsetForShown(5, up, "z", 0)).toBe(5);

    const face = { normal: [0, 1, 0] as [number, number, number], offset: 22 };
    expect(shownValue(face, "face", 25)).toBe(3);
    expect(offsetForShown(3, face, "face", 25)).toBe(22);

    // Turned round: the same plane, still 3 deep.
    const turned = flipSection(face);
    expect(shownValue(turned, "face", 25, true)).toBe(3);
    expect(offsetForShown(3, turned, "face", 25, true)).toBe(-22);
  });
});

describe("cut face", () => {
  it("draws faces seen from behind darker and hatched while the view's switch is on", () => {
    const cap = { value: 1 };
    const material = withCap(new THREE.MeshPhysicalMaterial(), cap);
    const shader = {
      fragmentShader: "void main() {\n#include <opaque_fragment>\n}",
      uniforms: {},
    } as unknown as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);

    expect(shader.uniforms["sectionCap"]).toBe(cap);
    expect(shader.fragmentShader.startsWith("uniform float sectionCap;")).toBe(true);
    expect(shader.fragmentShader).toContain("!gl_FrontFacing");
    expect(shader.fragmentShader).toContain(`/ ${HATCH_PX.toFixed(1)}`);
    // After the light is worked out, before tone mapping.
    expect(shader.fragmentShader.indexOf("#include <opaque_fragment>")).toBeLessThan(
      shader.fragmentShader.indexOf("sectionCap > 0.5"),
    );
    expect(material.customProgramCacheKey()).toBe("section-cap");
  });
});
