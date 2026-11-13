/**
 * Corners of the sketch solver and editing tools: an unknown point, a midpoint on something that is
 * no line, a line along the Y origin axis, dragging a circle's and an arc's radius to a value, an
 * offset larger than an arc's radius, and a corner whose lines have no positions.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SketchEntity } from "@meercad/schema";
import { SketchSolver } from "./solve.js";
import { cornerEdit, offsetCurves } from "./edit.js";

let solver: SketchSolver;
beforeAll(async () => {
  solver = await SketchSolver.create();
});

const pts = (...p: [string, number, number][]): SketchEntity[] =>
  p.map(([id, x, y]) => ({ id, type: "point", x, y }));

describe("solver corners", () => {
  it("names an unknown point and a midpoint on a circle", () => {
    const circle: SketchEntity[] = [
      ...pts(["c", 0, 0], ["m", 1, 1]),
      { id: "k", type: "circle", center: "c", radius: 5 },
    ];
    expect(() =>
      solver.solve({
        entities: circle,
        constraints: [{ id: "x", type: "coincident", a: "zz", b: "m" } as never],
      }),
    ).toThrow(/unknown point "zz"/);
    expect(() =>
      solver.solve({
        entities: circle,
        constraints: [{ id: "mid", type: "midpoint", point: "m", line: "k" } as never],
      }),
    ).toThrow(/midpoint mid: needs a line/);
  });

  it("keeps a line parallel to the Y origin axis", () => {
    const ents: SketchEntity[] = [
      ...pts(["a", 0, 0], ["b", 3, 10]),
      { id: "l", type: "line", p1: "a", p2: "b" },
    ];
    const s = solver.solve({
      entities: ents,
      constraints: [
        { id: "p", type: "parallel", a: "l", b: "origin.y" } as never,
        { id: "f", type: "fix", point: "a" } as never,
      ],
    });
    const line = s.curves.find((c) => c.kind === "line") as { a: [number, number]; b: [number, number] };
    expect(line.b[0] - line.a[0]).toBeCloseTo(0, 6);
  });

  it("drags a circle's and an arc's radius to the value asked", () => {
    const circle: SketchEntity[] = [...pts(["c", 0, 0]), { id: "k", type: "circle", center: "c", radius: 5 }];
    const s1 = solver.solve({ entities: circle, constraints: [] }, { dragRadius: { curve: "k", radius: 8 } });
    expect((s1.curves[0] as { radius: number }).radius).toBeCloseTo(8, 6);

    const arc: SketchEntity[] = [
      ...pts(["c", 0, 0], ["s", 5, 0], ["e", 0, 5]),
      { id: "a", type: "arc", center: "c", start: "s", end: "e" },
    ];
    const s2 = solver.solve({ entities: arc, constraints: [] }, { dragRadius: { curve: "a", radius: 7 } });
    expect((s2.curves[0] as { radius: number }).radius).toBeCloseTo(7, 6);
  });
});

describe("editing corners", () => {
  it("refuses an offset larger than an arc's radius", () => {
    const ents: SketchEntity[] = [
      ...pts(["c", 0, 0], ["s", 2, 0], ["e", 0, 2]),
      { id: "a", type: "arc", center: "c", start: "s", end: "e" },
    ];
    const positions = new Map(
      ents.flatMap((e) => (e.type === "point" ? [[e.id, [e.x, e.y] as [number, number]]] : [])),
    );
    // One way the arc grows, the other way it would shrink below nothing.
    const tries = [5, -5].map((d) => {
      try {
        offsetCurves({ entities: ents, constraints: [] }, positions, ["a"], d);

        return "ok";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(tries).toContain("ok");
    expect(tries.some((t) => /the offset is larger than a radius/.test(t))).toBe(true);
  });

  it("refuses a corner whose lines have no positions", () => {
    const ents: SketchEntity[] = [
      ...pts(["p", 0, 0], ["a", 10, 0], ["b", 0, 10]),
      { id: "l1", type: "line", p1: "p", p2: "a" },
      { id: "l2", type: "line", p1: "p", p2: "b" },
    ];
    expect(() =>
      cornerEdit({ entities: ents, constraints: [] }, new Map([["p", [0, 0]]]), "p", 2, "fillet"),
    ).toThrow(/the lines have no positions/);
  });
});
