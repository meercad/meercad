/** Closed triangle meshes of simple shapes with known sizes, for the mesh conversion and rebuild tests. */

export type P = [number, number];

/** A closed surface of revolution about Z: the profile runs from a point on the axis (r = 0) to another. */
export function turned(profile: P[], around = 64): Float64Array {
  const out: number[] = [];
  const at = (p: P, k: number): [number, number, number] => {
    const a = (2 * Math.PI * k) / around;
    return [p[0] * Math.cos(a), p[0] * Math.sin(a), p[1]];
  };
  for (let i = 0; i + 1 < profile.length; i++) {
    const [p, q] = [profile[i]!, profile[i + 1]!];
    for (let k = 0; k < around; k++) {
      const [a, b, c, d] = [at(p, k), at(p, k + 1), at(q, k + 1), at(q, k)];
      // The profile runs bottom to top on the outside: (a, b, c) faces outward.
      if (p[0] > 0) out.push(...a, ...b, ...c);
      if (q[0] > 0) out.push(...a, ...c, ...d);
    }
  }
  return Float64Array.from(out);
}

/** Profile points along an arc about (0, cz), angles from -π/2 (bottom) to π/2 (top). */
export function arc(cz: number, r: number, from: number, to: number, n: number): P[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = from + ((to - from) * i) / n;
    return [Math.abs(r * Math.cos(t)) < 1e-12 ? 0 : r * Math.cos(t), cz + r * Math.sin(t)] as P;
  });
}

/** A convex outline (counter-clockwise, in XY) extruded from z = 0 to `h`, closed by two fans. */
export function prism(outline: P[], h: number): Float64Array {
  const out: number[] = [];
  const n = outline.length;
  for (let i = 1; i + 1 < n; i++) {
    const [a, b, c] = [outline[0]!, outline[i]!, outline[i + 1]!];
    out.push(a[0], a[1], h, b[0], b[1], h, c[0], c[1], h);
    out.push(a[0], a[1], 0, c[0], c[1], 0, b[0], b[1], 0);
  }
  for (let i = 0; i < n; i++) {
    const [a, b] = [outline[i]!, outline[(i + 1) % n]!];
    out.push(a[0], a[1], 0, b[0], b[1], 0, b[0], b[1], h);
    out.push(a[0], a[1], 0, b[0], b[1], h, a[0], a[1], h);
  }
  return Float64Array.from(out);
}


/** The mesh turned by `deg` about the X axis (through the origin). */
export function turnedAboutX(mesh: Float64Array, deg: number): Float64Array {
  const [c, s] = [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
  const out = Float64Array.from(mesh);
  for (let i = 0; i < out.length; i += 3) {
    const [y, z] = [out[i + 1]!, out[i + 2]!];
    out[i + 1] = y * c - z * s;
    out[i + 2] = y * s + z * c;
  }
  return out;
}

/** A half circle of `n` pieces about (cx, 0) with radius r, from angle `from` on (counter-clockwise). */
export const half = (cx: number, r: number, from: number, n = 32): P[] => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos(from + (Math.PI * i) / n), r * Math.sin(from + (Math.PI * i) / n)] as P);

/** The same mesh wound the other way round (inside out). */
export function insideOut(mesh: Float64Array): Float64Array {
  const out = Float64Array.from(mesh);
  for (let t = 0; t < out.length; t += 9) for (let k = 0; k < 3; k++) [out[t + 3 + k], out[t + 6 + k]] = [out[t + 6 + k]!, out[t + 3 + k]!];
  return out;
}
