/**
 * The section view: a plane cuts every part open for viewing (the model is not changed). What lies on
 * the side the plane's normal points to is left out; where that opens a part, its inside shows as a
 * filled, hatched cut face in a darker tone of the part's colour.
 *
 * The cut face costs no extra geometry: the parts' faces are drawn from both sides already, and a face
 * seen from behind can only be seen through the cut, so those pixels are drawn as the cut face.
 */
import * as THREE from "three";

type Vec3 = [number, number, number];

/** Removes what lies where `normal · p > offset` (`normal` of length 1). */
export interface Section {
  normal: Vec3;
  offset: number;
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export type SectionAxis = "x" | "y" | "z";

const AXES: Record<SectionAxis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

/** `v` scaled to length 1; a zero vector gives Z. */
export function unit(v: readonly number[]): Vec3 {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);

  return l > 1e-12 ? [v[0]! / l, v[1]! / l, v[2]! / l] : [0, 0, 1];
}

/** The box's corners. */
function corners(box: Box): Vec3[] {
  const out: Vec3[] = [];

  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) out.push([x, y, z]);
    }
  }

  return out;
}

/** The offsets along `normal` the box spans: from the plane cutting nothing away to the one cutting all. */
export function offsetRange(box: Box, normal: readonly number[]): [number, number] {
  const n = unit(normal);
  const d = corners(box).map((c) => dot(n, c));

  return [Math.min(...d), Math.max(...d)];
}

/** How far a section laid on a face stands in front of it (mm). */
export const FACE_CLEAR = 1e-3;

/** A section square to an axis through the middle of the box, flipped to keep the other half. */
export function axisSection(axis: SectionAxis, box: Box, flip = false): Section {
  const a = AXES[axis];
  const normal: Vec3 = flip ? [-a[0], -a[1], -a[2]] : [...a];
  const [lo, hi] = offsetRange(box, normal);

  return { normal, offset: (lo + hi) / 2 };
}

/**
 * A section square to `axis` (else to the axis most along `toCamera`) through the middle of the box,
 * cutting away the half toward the viewer, so the cut faces the camera.
 */
export function facingSection(box: Box, toCamera: readonly number[], axis?: SectionAxis): Section {
  const index = { x: 0, y: 1, z: 2 };
  const a =
    axis ??
    (["y", "z"] as const).reduce<SectionAxis>(
      (best, k) => (Math.abs(toCamera[index[k]]!) > Math.abs(toCamera[index[best]]!) ? k : best),
      "x",
    );

  return axisSection(a, box, toCamera[index[a]]! < 0);
}

/**
 * A section lying on a flat face: through `point`, cutting away what lies in front of the face. It
 * stands `clear` (mm) in front, so the face itself is kept whole rather than flickering half cut.
 */
export function faceSection(
  point: readonly number[],
  normal: readonly number[],
  clear = FACE_CLEAR,
): Section {
  const n = unit(normal);

  return { normal: n, offset: dot(n, point) + clear };
}

/** The same plane, keeping the other side. */
export function flipSection(s: Section): Section {
  return { normal: [-s.normal[0], -s.normal[1], -s.normal[2]], offset: -s.offset };
}

/** True when `p` is kept (on the plane counts as kept, within `tol`). */
export function keeps(s: Section | null, p: readonly number[], tol = 0): boolean {
  return !s || dot(s.normal, p) <= s.offset + tol;
}

/** Two axes in the plane, square to each other and to `normal`. */
export function planeAxes(normal: readonly number[]): { u: Vec3; v: Vec3 } {
  const n = unit(normal);
  // The world axis least along the normal gives a stable first axis.
  const ref: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit([
    n[1] * ref[2] - n[2] * ref[1],
    n[2] * ref[0] - n[0] * ref[2],
    n[0] * ref[1] - n[1] * ref[0],
  ]);
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];

  return { u, v };
}

/** The box's middle dropped onto the plane. */
export function sectionCenter(s: Section, box: Box): Vec3 {
  const c: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  const k = dot(s.normal, c) - s.offset;

  return [c[0] - s.normal[0] * k, c[1] - s.normal[1] * k, c[2] - s.normal[2] * k];
}

/**
 * Where the drag arrow starts: the box's middle dropped onto the plane through the world origin, so
 * the arrow's value along the normal is the section's offset.
 */
export function handleOrigin(s: Section, box: Box): Vec3 {
  return sectionCenter({ normal: s.normal, offset: 0 }, box);
}

/** The plane's outline: a rectangle on it around everything of the box, `margin` (share) wider. */
export function outline(s: Section, box: Box, margin = 0.08): Vec3[] {
  const { u, v } = planeAxes(s.normal);
  const c = sectionCenter(s, box);
  let hu = 0;
  let hv = 0;

  for (const p of corners(box)) {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    hu = Math.max(hu, Math.abs(dot(d, u)));
    hv = Math.max(hv, Math.abs(dot(d, v)));
  }

  // A flat box seen edge on still gets a visible rectangle.
  const size = Math.max(hu, hv, 1e-3);
  hu = Math.max(hu, size * 0.25) * (1 + margin);
  hv = Math.max(hv, size * 0.25) * (1 + margin);

  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => [
    c[0] + u[0] * a! * hu + v[0] * b! * hv,
    c[1] + u[1] * a! * hu + v[1] * b! * hv,
    c[2] + u[2] * a! * hu + v[2] * b! * hv,
  ]);
}

/** three.js keeps the side a plane's normal points to: the section's plane, turned round. */
export function clipPlane(s: Section, target = new THREE.Plane()): THREE.Plane {
  return target.set(new THREE.Vector3(-s.normal[0], -s.normal[1], -s.normal[2]), s.offset);
}

/** Hatch spacing in device pixels. */
export const HATCH_PX = 7;

/**
 * Makes a part's material draw its faces seen from behind as the cut face while `cap.value` is 1 (one
 * uniform per view, shared by its parts): the part's own colour, darker, with diagonal hatching fixed
 * to the screen. At 0 it draws as before.
 */
export function withCap<M extends THREE.Material>(material: M, cap: { value: number }): M {
  material.onBeforeCompile = (shader) => {
    shader.uniforms["sectionCap"] = cap;
    shader.fragmentShader = `uniform float sectionCap;\n${shader.fragmentShader}`.replace(
      "#include <opaque_fragment>",
      `#include <opaque_fragment>
      if (sectionCap > 0.5 && !gl_FrontFacing) {
        float hatch = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / ${HATCH_PX.toFixed(1)}));
        gl_FragColor.rgb = diffuseColor.rgb * mix(0.42, 0.62, hatch);
      }`,
    );
  };

  material.customProgramCacheKey = () => "section-cap";

  return material;
}

/**
 * What the section bar shows: the plane's position along its axis, or for a plane laid on a face how
 * deep below the face it cuts (`start`: its offset on the face; `flipped`: turned round since).
 */
export function shownValue(s: Section, axis: SectionAxis | "face", start: number, flipped = false): number {
  return axis === "face" ? start - (flipped ? -s.offset : s.offset) : s.offset * axisSign(s, axis);
}

/** The offset for a value as `shownValue` shows it. */
export function offsetForShown(
  value: number,
  s: Section,
  axis: SectionAxis | "face",
  start: number,
  flipped = false,
): number {
  return axis === "face" ? (flipped ? value - start : start - value) : value * axisSign(s, axis);
}

function axisSign(s: Section, axis: SectionAxis): number {
  return s.normal[{ x: 0, y: 1, z: 2 }[axis]]! < 0 ? -1 : 1;
}
