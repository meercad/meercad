/**
 * Text as closed outlines for a text step: glyph outlines from an embedded font (Roboto or Roboto
 * Mono), curves flattened to short lines, in millimetres on the step's plane. `size` is the height
 * of capital letters; lines of text go downwards from the position, aligned left, centred or right.
 */

import { parse, type Font } from "opentype.js";
import { FONTS } from "./fonts.generated.js";

export type TextFont = keyof typeof FONTS;
export type Loop = [number, number][];

const cache = new Map<TextFont, Font>();

function font(name: TextFont): Font {
  let f = cache.get(name);

  if (!f) {
    const bytes = Uint8Array.from(atob(FONTS[name]), (c) => c.charCodeAt(0));
    cache.set(name, (f = parse(bytes.buffer)));
  }

  return f;
}

/** The outlines of a text, and the characters the font does not have. */
export function textLoops(
  text: string,
  o: { font?: TextFont; size: number; align?: "left" | "center" | "right" },
): { loops: Loop[]; missing: string[] } {
  const f = font(o.font ?? "sans");
  const os2 = (f.tables as { os2?: { sCapHeight?: number } }).os2;
  const cap = os2?.sCapHeight || f.ascender * 0.7;
  const fontSize = (o.size * f.unitsPerEm) / cap;
  const lineHeight = ((f.ascender - f.descender) / f.unitsPerEm) * fontSize * 1.15;
  // Curves are cut into pieces about a twentieth of the letter height long.
  const step = Math.max(o.size / 20, 0.05);
  const loops: Loop[] = [];
  const missing = new Set<string>();
  text.split("\n").forEach((line, k) => {
    for (const ch of line) if (ch.trim() && f.charToGlyphIndex(ch) === 0) missing.add(ch);

    const width = f.getAdvanceWidth(line, fontSize);
    const x0 = o.align === "center" ? -width / 2 : o.align === "right" ? -width : 0;
    const path = f.getPath(line, x0, 0, fontSize);
    let cur: Loop = [];
    let at: [number, number] = [0, 0];
    // The font's y runs downwards; the plane's upwards. Each line sits lineHeight below the last.
    const pt = (x: number, y: number): [number, number] => [x, -y - k * lineHeight];

    const close = () => {
      if (cur.length >= 3) loops.push(cur);

      cur = [];
    };

    const curve = (n: number, f: (t: number) => [number, number]) => {
      for (let i = 1; i <= n; i++) cur.push(pt(...f(i / n)));
    };

    for (const c of path.commands) {
      if (c.type === "M") {
        close();
        at = [c.x, c.y];
        cur.push(pt(c.x, c.y));
      } else if (c.type === "L") {
        at = [c.x, c.y];
        cur.push(pt(c.x, c.y));
      } else if (c.type === "Q") {
        const [x0, y0] = at;
        const n = Math.max(2, Math.ceil(Math.hypot(c.x - x0, c.y - y0) / step));
        curve(n, (t) => [
          (1 - t) ** 2 * x0 + 2 * (1 - t) * t * c.x1 + t * t * c.x,
          (1 - t) ** 2 * y0 + 2 * (1 - t) * t * c.y1 + t * t * c.y,
        ]);
        at = [c.x, c.y];
      } else if (c.type === "C") {
        const [x0, y0] = at;
        const n = Math.max(3, Math.ceil(Math.hypot(c.x - x0, c.y - y0) / step));
        const b = (t: number, p0: number, p1: number, p2: number, p3: number) =>
          (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3;
        curve(n, (t) => [b(t, x0, c.x1, c.x2, c.x), b(t, y0, c.y1, c.y2, c.y)]);
        at = [c.x, c.y];
      } else if (c.type === "Z") {
        close();
      }
    }

    close();
  });

  // Drop repeated points (a closing point equal to the first, zero-length pieces).
  const clean = loops
    .map((loop) =>
      loop.filter(
        (p, i) =>
          Math.hypot(p[0] - loop[(i + 1) % loop.length]![0], p[1] - loop[(i + 1) % loop.length]![1]) > 1e-6,
      ),
    )
    .filter((l) => l.length >= 3 && Math.abs(area(l)) > 1e-6);

  return { loops: clean, missing: [...missing] };
}

/** Signed area (counter-clockwise positive). */
export function area(loop: Loop): number {
  let a = 0;

  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i]!;
    const [x1, y1] = loop[(i + 1) % loop.length]!;
    a += x0 * y1 - x1 * y0;
  }

  return a / 2;
}

export function inside(p: [number, number], loop: Loop): boolean {
  let c = false;

  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]!;
    const [xj, yj] = loop[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }

  return c;
}

/** Outlines grouped into shapes: each outer loop with the holes directly inside it (even-odd). */
export function nest(loops: Loop[]): { outer: Loop; holes: Loop[] }[] {
  const depth = loops.map((loop, i) => loops.filter((o, j) => j !== i && inside(loop[0]!, o)).length);
  const shapes = loops.flatMap((loop, i) =>
    depth[i]! % 2 === 0
      ? [{ i, outer: area(loop) > 0 ? loop : [...loop].reverse(), holes: [] as Loop[] }]
      : [],
  );
  loops.forEach((loop, i) => {
    if (depth[i]! % 2 === 0) return;

    // The hole belongs to the innermost outer loop around it.
    const owner = shapes.filter((s) => inside(loop[0]!, loops[s.i]!) && depth[s.i] === depth[i]! - 1)[0];
    owner?.holes.push(area(loop) < 0 ? loop : [...loop].reverse());
  });

  return shapes.map(({ outer, holes }) => ({ outer, holes }));
}
