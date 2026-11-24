/** Sketch tools: hints, the tip beside the cursor, typed fields and the centre arc's sweep. */
import { describe, expect, it } from "vitest";
import type { Vec2 } from "@meercad/sketch";
import type { SketchTool } from "../state";
import {
  drawingTip,
  ENTRY_FIELDS,
  isAngleField,
  picksGeometry,
  SNAP_LABEL,
  toolHint,
  unwrapSweep,
} from "./tools";
import type { Snap } from "./types";

const snap = (pos: Vec2, kind?: Snap["kind"]): Snap => ({ pos, ...(kind ? { kind } : {}) });

describe("hints and fields", () => {
  const tools: SketchTool[] = [
    "line",
    "rect",
    "rect_center",
    "circle",
    "arc",
    "arc_center",
    "point",
    "polygon",
    "spline",
    "trim",
    "fillet",
    "chamfer",
    "pattern",
    "offset",
    "dimension",
    "project",
    "section",
    "select",
  ];

  it("gives every tool a hint, changing as points are placed", () => {
    for (const tool of tools) {
      for (const n of [0, 1, 2]) expect(toolHint(tool, n, false)).toMatch(/\S/);
    }

    expect(toolHint("line", 0, false)).not.toBe(toolHint("line", 1, false));
    expect(new Set([0, 1, 2].map((n) => toolHint("arc", n, false))).size).toBe(3);
    expect(new Set([0, 1, 2].map((n) => toolHint("arc_center", n, false))).size).toBe(3);
    expect(toolHint("dimension", 0, true)).not.toBe(toolHint("dimension", 0, false));
    expect(toolHint("polygon", 1, false)).toContain("6 corners");
    expect(toolHint("polygon", 1, false, 8)).toContain("8 corners");
  });

  it("knows the angle fields and the tools that pick geometry", () => {
    expect(isAngleField("line", 1)).toBe(true);
    expect(isAngleField("line", 0)).toBe(false);
    expect(isAngleField("point", 0)).toBe(false);
    expect(ENTRY_FIELDS.circle).toHaveLength(1);
    expect(
      ["select", "pattern", "dimension", "trim", "line"].map((tool) => picksGeometry(tool as SketchTool)),
    ).toEqual([true, true, true, true, false]);
  });
});

describe("drawingTip", () => {
  const at = snap([3, 4]);

  it("shows the size of the shape being drawn", () => {
    expect(drawingTip("line", [snap([0, 0])], at)).toBe("5 mm  53.13°");
    expect(drawingTip("line", [snap([0, 0])], snap([0, -1]))).toBe("1 mm  270°");
    expect(drawingTip("arc", [snap([-1, 0]), snap([1, 0])], snap([0, 1]))).toBe("R 1 mm  ∠ 180°");
    expect(drawingTip("arc", [snap([0, 0]), snap([2, 0])], snap([1, 0]))).toBeNull();
    expect(drawingTip("arc", [snap([0, 0])], at)).toBe("5 mm");
    expect(drawingTip("circle", [snap([0, 0])], at)).toBe("R 5 mm");
    expect(drawingTip("arc_center", [snap([0, 0])], at)).toBe("R 5 mm");
    expect(drawingTip("polygon", [snap([0, 0])], at)).toContain("5 mm");
    expect(drawingTip("polygon", [snap([0, 0])], at)).toBe("6-gon R 5 mm");
    expect(drawingTip("polygon", [snap([0, 0])], at, 5)).toBe("5-gon R 5 mm");
    expect(drawingTip("rect", [snap([0, 0])], at)).toBe("3 × 4 mm");
    expect(drawingTip("rect_center", [snap([0, 0])], at)).toBe("6 × 8 mm");
  });

  it("names what the cursor snapped to before the first point", () => {
    expect(drawingTip("line", [], snap([0, 0], "mid"))).toBe(SNAP_LABEL.mid);
    expect(drawingTip("line", [], snap([0, 0], "grid"))).toBeNull();
    expect(drawingTip("point", [snap([0, 0])], snap([0, 0]))).toBeNull();
  });
});

describe("unwrapSweep", () => {
  const center: Vec2 = [0, 0];
  const start: Vec2 = [1, 0];
  const at = (deg: number): Vec2 => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

  it("follows the cursor round past half a turn either way", () => {
    let sweep = 0;

    for (const deg of [60, 120, 180, 240, 300]) sweep = unwrapSweep(sweep, center, start, at(deg));
    expect(sweep).toBeCloseTo((300 * Math.PI) / 180);

    sweep = 0;
    for (const deg of [-60, -120, -180, -240]) sweep = unwrapSweep(sweep, center, start, at(deg));
    expect(sweep).toBeCloseTo((-240 * Math.PI) / 180);
  });

  it("keeps the sweep instead of going past a full turn", () => {
    const almost = (350 * Math.PI) / 180;

    expect(unwrapSweep(almost, center, start, at(20))).toBe(almost);
  });

  it("unwraps a start angle far from the cursor's", () => {
    expect(unwrapSweep(0, center, at(170), at(-170))).toBeCloseTo((20 * Math.PI) / 180);
    expect(unwrapSweep(0, center, at(-170), at(170))).toBeCloseTo((-20 * Math.PI) / 180);
  });
});
