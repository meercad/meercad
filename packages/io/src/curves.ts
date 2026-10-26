/** Neutral 2D curve set used by DXF/SVG import and export (mm, Y up). */
export type Curve2 =
  | { kind: "line"; a: [number, number]; b: [number, number] }
  | { kind: "circle"; center: [number, number]; radius: number }
  /** Counter-clockwise from a0 to a1 (radians). */
  | { kind: "arc"; center: [number, number]; radius: number; a0: number; a1: number };
