/**
 * Measuring on an imported mesh in the app's Measure tool (scanMeasure.ts): a click on the side of
 * a Ø20 × 30 cylinder made of 96 facets finds the cylinder and its diameter, a click on each end
 * finds the planes and their distance; a third click starts over; a tighter tolerance fits again. The
 * wall-thickness map (thickness.ts) of a 30 × 30 × 2 plate finds its 2 mm.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { writeStl } from "@meercad/io";
import { turned, prism } from "../../../../tests/acceptance/meshes";
import { testCall } from "./mcpBridge";
import { useApp } from "../store";
import { clearScanMeasure, measureOnScan, scanOf, setScanTolerance, useScanMeasure } from "./scanMeasure";
import { hideThickness, setMinWall, showThickness, useThickness } from "./thickness";

const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const stlOf = (corners: Float64Array) =>
  writeStl([
    {
      positions: Float32Array.from(corners),
      indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i),
    },
  ]);
const rows = () => Object.fromEntries(useApp.getState().measure.result?.rows ?? []);
let cyl = "";
let plate = "";

beforeAll(async () => {
  await testCall("new_project", { name: "Scan measure" });
  cyl = (
    (await testCall("import_file", {
      name: "cyl.stl",
      base64: b64(
        stlOf(
          turned(
            [
              [0, 0],
              [10, 0],
              [10, 30],
              [0, 30],
            ],
            96,
          ),
        ),
      ),
    })) as { added: string[] }
  ).added[0]!;
  plate = (
    (await testCall("import_file", {
      name: "plate.stl",
      base64: b64(
        stlOf(
          prism(
            [
              [100, 0],
              [130, 0],
              [130, 30],
              [100, 30],
            ],
            2,
          ),
        ),
      ),
    })) as { added: string[] }
  ).added[0]!;
  useApp.setState({ measure: { active: true, picks: [], result: null } });
});

describe("measuring on a scan", () => {
  it("finds the cylinder under a click on its side, with its diameter", () => {
    expect(scanOf(cyl)).not.toBeNull();
    expect(scanOf(cyl)).toBe(scanOf(cyl));
    expect(scanOf("nope")).toBeNull();
    measureOnScan(cyl, [10, 0, 15]);
    expect(useScanMeasure.getState().shapes.map((s) => s.shape.kind)).toEqual(["cylinder"]);
    expect(rows()).toMatchObject({ Cylinder: "", Diameter: "Ø 20 mm" });
  });

  it("measures between its two ends: planes 30 mm apart", () => {
    clearScanMeasure();
    measureOnScan(cyl, [3, 3, 30]);
    measureOnScan(cyl, [3, 3, 0]);
    expect(useScanMeasure.getState().shapes.map((s) => s.shape.kind)).toEqual(["plane", "plane"]);
    expect(rows()).toMatchObject({ Distance: "30 mm" });
    // A third click starts over.
    measureOnScan(cyl, [10, 0, 15]);
    expect(useScanMeasure.getState().picks).toHaveLength(1);
  });

  it("fits again when the tolerance changes: the facets' corners lie on the round, so it stays a cylinder", () => {
    clearScanMeasure();
    measureOnScan(cyl, [10, 0, 15]);
    setScanTolerance(0.0001);
    expect(useScanMeasure.getState().shapes.map((s) => s.shape.kind)).toEqual(["cylinder"]);
    setScanTolerance(0.1);
    expect(useScanMeasure.getState().shapes.map((s) => s.shape.kind)).toEqual(["cylinder"]);
    expect(rows()).toMatchObject({ Diameter: "Ø 20 mm" });
  });

  it("drops the shapes when the Measure tool closes", () => {
    measureOnScan(cyl, [10, 0, 15]);
    useApp.setState({ measure: { active: false, picks: [], result: null } });
    expect(useScanMeasure.getState().picks).toEqual([]);
  });
});

describe("the wall thickness map", () => {
  it("finds the plate's 2 mm walls, red below a 3 mm minimum, and goes when hidden", async () => {
    showThickness(plate);
    await expect.poll(() => useThickness.getState().stats, { timeout: 30_000 }).not.toBeNull();

    const st = useThickness.getState().stats!;
    expect(st.min).toBeCloseTo(2, 3);
    expect(st.thin).toBe(0);
    setMinWall(3);
    await expect.poll(() => useThickness.getState().stats?.minWall, { timeout: 30_000 }).toBe(3);
    expect(useThickness.getState().stats!.thin).toBeGreaterThan(0.5);

    const map = useThickness.getState().maps.get(plate)!;
    expect(map.colors.length).toBe(map.positions.length);
    hideThickness();
    expect(useThickness.getState()).toMatchObject({ body: null, stats: null });
    // A part that is gone.
    showThickness("nope");
    await expect.poll(() => useThickness.getState().error).toBe("gone");
    hideThickness();
  });
});
