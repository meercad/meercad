import { describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { doc, newSession, sketch } from "./helpers.js";

/** A closed outline of lines around (cx, cy) with its area; `i` shifts the waves from layer to layer. */
function outline(prefix: string, cx: number, cy: number, radius: number, n: number, i: number) {
  const points: [number, number][] = [];

  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    const r = radius * (1 + 0.15 * Math.sin(5 * a + 0.3 * i));
    points.push([+(cx + r * Math.cos(a)).toFixed(3), +(cy + r * Math.sin(a)).toFixed(3)]);
  }

  const entities: SketchEntity[] = [
    ...points.map(([x, y], k): SketchEntity => ({ id: `${prefix}p${k}`, type: "point", x, y })),
    ...points.map((_, k): SketchEntity => ({
      id: `${prefix}l${k}`,
      type: "line",
      p1: `${prefix}p${k}`,
      p2: `${prefix}p${(k + 1) % n}`,
    })),
  ];
  const area = points.reduce((sum, [x, y], k) => {
    const [x2, y2] = points[(k + 1) % n]!;

    return sum + (x * y2 - x2 * y) / 2;
  }, 0);

  return { entities, area };
}

/**
 * Layers stacked on planes, the first a new body and each further one joined to it (Trello, 2026-11-14:
 * 118 such layers came out at a third of their volume without a message). Each layer has a ring
 * and, every other layer, an island next to it; heights from 0.4 to 2 mm.
 */
function stack(layers: number, overlap: number) {
  const features: Feature[] = [];
  let z = 0;
  let volume = 0;
  // What the layers add by reaching into the next one, at most (where the next one is as wide, nothing).
  let extra = 0;

  for (let i = 0; i < layers; i++) {
    const height = 0.4 + (i % 5) * 0.4;
    const outer = outline("a", 0, 0, 12 - 0.3 * i, 60, i);
    const hole = outline("h", 0, 0, 5, 30, i);
    const island = i % 2 ? [outline("b", 30, 0, 3, 24, i)] : [];

    features.push({ id: `pl${i}`, op: "plane", base: { ref: "origin.XY" }, offset: +z.toFixed(4) });
    features.push(
      sketch(
        `sk${i}`,
        { ref: `pl${i}` },
        [outer, hole, ...island].flatMap((part) => part.entities),
      ),
    );
    features.push({
      id: `re${i}`,
      op: "extrude",
      profile: { sketch: `sk${i}` },
      extent: "blind",
      distance: height + overlap,
      mode: i === 0 ? "new_body" : "join",
      ...(i === 0 ? {} : { targets: ["re0"] }),
    });

    const area = outer.area - hole.area + (island[0]?.area ?? 0);
    volume += height * area;
    extra += overlap * area;
    z += height;
  }

  return { features, volume, extra };
}

describe("layers joined one by one to the same body", () => {
  it.each([
    ["lying on each other", 0],
    ["reaching 0.02 mm into the next", 0.02],
  ])("%s keep all their material", async (_name, overlap) => {
    const { features, volume, extra } = stack(14, overlap);
    const { report } = (await newSession()).rebuild(doc(features));

    expect(report.features.filter((f) => f.status !== "ok")).toEqual([]);
    expect(report.bodies.map((b) => b.id)).toEqual(["re0"]);
    expect(report.bodies[0]!.volume!).toBeGreaterThan(volume - 1e-3);
    expect(report.bodies[0]!.volume!).toBeLessThan(volume + extra + 1e-3);
  });
});
