import type { Curve2 } from "./curves.js";

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/** Minimal AutoCAD R12 DXF with LINE/CIRCLE/ARC entities (mm). Readable by laser and CNC software. */
export function writeDxf(curves: readonly Curve2[]): string {
  const out: (string | number)[] = [
    0,
    "SECTION",
    2,
    "HEADER",
    9,
    "$INSUNITS",
    70,
    4,
    0,
    "ENDSEC",
    0,
    "SECTION",
    2,
    "ENTITIES",
  ];
  const n = (v: number) => Number(v.toFixed(6));

  for (const c of curves) {
    if (c.kind === "line") {
      out.push(0, "LINE", 8, "0", 10, n(c.a[0]), 20, n(c.a[1]), 30, 0, 11, n(c.b[0]), 21, n(c.b[1]), 31, 0);
    } else if (c.kind === "circle") {
      out.push(0, "CIRCLE", 8, "0", 10, n(c.center[0]), 20, n(c.center[1]), 30, 0, 40, n(c.radius));
    } else {
      out.push(
        0,
        "ARC",
        8,
        "0",
        10,
        n(c.center[0]),
        20,
        n(c.center[1]),
        30,
        0,
        40,
        n(c.radius),
        50,
        n(deg(c.a0)),
        51,
        n(deg(c.a1)),
      );
    }
  }

  out.push(0, "ENDSEC", 0, "EOF");

  return out.join("\n") + "\n";
}

/** Reads LINE, CIRCLE, ARC, LWPOLYLINE (incl. bulges) and POLYLINE entities. Units are taken as mm. */
export function readDxf(text: string): Curve2[] {
  const lines = text.split(/\r?\n/);
  const pairs: [number, string][] = [];

  for (let i = 0; i + 1 < lines.length; i += 2) {
    pairs.push([parseInt(lines[i]!.trim(), 10), lines[i + 1]!.trim()]);
  }

  const curves: Curve2[] = [];
  let i = pairs.findIndex(([c, v]) => c === 2 && v === "ENTITIES");
  if (i < 0) i = 0;

  const entity = (start: number): [Map<number, string[]>, number] => {
    const m = new Map<number, string[]>();
    let j = start + 1;

    for (; j < pairs.length && pairs[j]![0] !== 0; j++) {
      const [c, v] = pairs[j]!;
      m.set(c, [...(m.get(c) ?? []), v]);
    }

    return [m, j];
  };

  const num = (m: Map<number, string[]>, c: number, k = 0) => Number(m.get(c)?.[k] ?? 0);
  let poly: { pts: [number, number][]; bulges: number[]; closed: boolean } | null = null;

  const flushPoly = () => {
    if (poly) curves.push(...polyline(poly.pts, poly.bulges, poly.closed));

    poly = null;
  };

  while (i < pairs.length) {
    const [code, value] = pairs[i]!;

    if (code !== 0) {
      i++;
      continue;
    }

    if (value === "ENDSEC" || value === "EOF") break;

    const [m, next] = entity(i);

    switch (value) {
      case "LINE":
        curves.push({ kind: "line", a: [num(m, 10), num(m, 20)], b: [num(m, 11), num(m, 21)] });
        break;
      case "CIRCLE":
        curves.push({ kind: "circle", center: [num(m, 10), num(m, 20)], radius: num(m, 40) });
        break;
      case "ARC":
        curves.push({
          kind: "arc",
          center: [num(m, 10), num(m, 20)],
          radius: num(m, 40),
          a0: rad(num(m, 50)),
          a1: rad(num(m, 51)),
        });
        break;
      case "LWPOLYLINE": {
        const xs = m.get(10) ?? [];
        const ys = m.get(20) ?? [];
        const pts = xs.map((x, k) => [Number(x), Number(ys[k] ?? 0)] as [number, number]);
        // Bulges (code 42) are per vertex but optional; map them by order of appearance.
        const bulges = pts.map(() => 0);
        let vi = -1;

        for (let j = i + 1; j < next; j++) {
          const [c, v] = pairs[j]!;
          if (c === 10) vi++;
          if (c === 42 && vi >= 0) bulges[vi] = Number(v);
        }

        curves.push(...polyline(pts, bulges, (num(m, 70) & 1) === 1));
        break;
      }
      case "POLYLINE":
        flushPoly();
        poly = { pts: [], bulges: [], closed: (num(m, 70) & 1) === 1 };
        break;
      case "VERTEX":
        if (poly) {
          (poly as { pts: [number, number][] }).pts.push([num(m, 10), num(m, 20)]);
          (poly as { bulges: number[] }).bulges.push(num(m, 42));
        }

        break;
      case "SEQEND":
        flushPoly();
        break;
    }

    i = next;
  }

  flushPoly();

  return curves;
}

function polyline(pts: [number, number][], bulges: number[], closed: boolean): Curve2[] {
  const out: Curve2[] = [];
  const n = closed ? pts.length : pts.length - 1;

  for (let k = 0; k < n; k++) {
    const a = pts[k]!;
    const b = pts[(k + 1) % pts.length]!;
    const bulge = bulges[k] ?? 0;

    if (Math.abs(bulge) < 1e-9) {
      out.push({ kind: "line", a, b });
      continue;
    }

    // Bulge = tan(θ/4); positive = counter-clockwise from a to b.
    const theta = 4 * Math.atan(bulge);
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
    const dir: [number, number] = [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord];
    const sign = (bulge > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1);
    const center: [number, number] = [mid[0] - dir[1] * h * sign, mid[1] + dir[0] * h * sign];
    const ang = (p: [number, number]) => Math.atan2(p[1] - center[1], p[0] - center[0]);
    out.push(
      bulge > 0
        ? { kind: "arc", center, radius: r, a0: ang(a), a1: ang(b) }
        : { kind: "arc", center, radius: r, a0: ang(b), a1: ang(a) },
    );
  }

  return out;
}

/** SVG of 2D curves (mm, Y flipped to SVG's downward axis). */
export function writeSvg(curves: readonly Curve2[], stroke = "#000"): string {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (const c of curves) {
    if (c.kind === "line") {
      grow(...c.a);
      grow(...c.b);
    } else {
      grow(c.center[0] - c.radius, c.center[1] - c.radius);
      grow(c.center[0] + c.radius, c.center[1] + c.radius);
    }
  }

  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0;

  const pad = 1;
  const w = maxX - minX + 2 * pad;
  const h = maxY - minY + 2 * pad;
  const X = (x: number) => +(x - minX + pad).toFixed(4);
  const Y = (y: number) => +(maxY - y + pad).toFixed(4);
  const parts = curves.map((c) => {
    if (c.kind === "line") {
      return `<line x1="${X(c.a[0])}" y1="${Y(c.a[1])}" x2="${X(c.b[0])}" y2="${Y(c.b[1])}"/>`;
    }

    if (c.kind === "circle") {
      return `<circle cx="${X(c.center[0])}" cy="${Y(c.center[1])}" r="${+c.radius.toFixed(4)}"/>`;
    }

    const s = [c.center[0] + c.radius * Math.cos(c.a0), c.center[1] + c.radius * Math.sin(c.a0)] as const;
    const e = [c.center[0] + c.radius * Math.cos(c.a1), c.center[1] + c.radius * Math.sin(c.a1)] as const;
    let sweep = (c.a1 - c.a0) % (2 * Math.PI);
    if (sweep <= 0) sweep += 2 * Math.PI;

    // CCW in Y-up is clockwise (sweep-flag 0) after flipping Y.
    return `<path d="M ${X(s[0])} ${Y(s[1])} A ${+c.radius.toFixed(4)} ${+c.radius.toFixed(4)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${X(e[0])} ${Y(e[1])}"/>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${+w.toFixed(3)}mm" height="${+h.toFixed(3)}mm" viewBox="0 0 ${+w.toFixed(3)} ${+h.toFixed(3)}"><g fill="none" stroke="${stroke}" stroke-width="0.1">${parts.join("")}</g></svg>\n`;
}
