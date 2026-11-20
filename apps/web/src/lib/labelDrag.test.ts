/**
 * A dimension's value moved by dragging (labelDrag.ts): stored to 0.01 mm, put on that one
 * constraint only, and shown on a copy of the sketch while the drag goes on.
 */
import { describe, expect, it } from "vitest";
import type { SketchConstraint } from "@meercad/schema";
import { shownWithLabel, storedLabel, withLabel } from "./labelDrag";

const constraints: SketchConstraint[] = [
  { id: "c1", type: "length", line: "l1", value: 40 },
  { id: "c2", type: "horizontal", line: "l1" },
  { id: "c3", type: "diameter", curve: "k1", value: 8, label: [1, 2] },
];

describe("a dragged dimension value", () => {
  it("is stored to 0.01 mm", () => {
    expect(storedLabel([1.23456, -7.891])).toEqual([1.23, -7.89]);
  });

  it("moves only its own constraint", () => {
    const moved = withLabel(constraints, "c1", [20.004, -8.126]);
    expect(moved[0]).toEqual({ id: "c1", type: "length", line: "l1", value: 40, label: [20, -8.13] });
    expect(moved[1]).toBe(constraints[1]);
    expect(moved[2]).toBe(constraints[2]);
    expect(constraints[0]).not.toHaveProperty("label");
  });

  it("shows the sketch with the value where it is dragged, the sketch itself untouched", () => {
    const sketch = { id: "sk1", constraints };
    expect(shownWithLabel(sketch, null)).toBe(sketch);

    const shown = shownWithLabel(sketch, { id: "c3", at: [5, 6] });
    expect(shown).not.toBe(sketch);
    expect(shown.id).toBe("sk1");
    expect(shown.constraints[2]).toMatchObject({ label: [5, 6] });
    expect(sketch.constraints[2]).toMatchObject({ label: [1, 2] });
  });
});
