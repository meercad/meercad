/**
 * Measuring on a scan: in the Measure tool, a click on a mesh part fits the plane, cylinder, cone
 * or sphere the surface follows there (within a tolerance), and a second click measures between
 * the two shapes. A mesh's own triangles say nothing useful on their own.
 */
import {
  compareShapes,
  nearestTriangle,
  scanMesh,
  shapeAt,
  shapeValues,
  type ScanMesh,
  type ScanShape,
  type ShapeValue,
} from "@meercad/kernel/fit";
import { create } from "zustand";
import { toast, useApp } from "../store";
import { t } from "./i18n";

type Vec3 = [number, number, number];

export const useScanMeasure = create<{
  tol: number;
  picks: { bodyId: string; point: Vec3 }[];
  shapes: { bodyId: string; shape: ScanShape }[];
}>(() => ({ tol: 0.1, picks: [], shapes: [] }));

const prepared = new WeakMap<Float32Array, ScanMesh>();

/** The welded scan of a part's display mesh (prepared once per mesh). */
export function scanOf(bodyId: string): ScanMesh | null {
  const m = useApp.getState().output?.meshes.find((x) => x.bodyId === bodyId);
  if (!m) return null;

  let s = prepared.get(m.positions);

  if (!s) {
    const corners = new Float32Array(m.indices.length * 3);

    for (let i = 0; i < m.indices.length; i++) {
      corners.set(m.positions.subarray(m.indices[i]! * 3, m.indices[i]! * 3 + 3), i * 3);
    }

    s = scanMesh(corners);
    prepared.set(m.positions, s);
  }

  return s;
}

/** A click on a mesh part in the Measure tool; a click while two shapes are shown starts over. */
export function measureOnScan(bodyId: string, point: Vec3): void {
  const { picks } = useScanMeasure.getState();
  useScanMeasure.setState({ picks: picks.length >= 2 ? [{ bodyId, point }] : [...picks, { bodyId, point }] });
  refit();
}

export function clearScanMeasure(): void {
  if (useScanMeasure.getState().picks.length) useScanMeasure.setState({ picks: [], shapes: [] });
}

export function setScanTolerance(tol: number): void {
  useScanMeasure.setState({ tol });
  refit();
}

/** Fits every pick again (after a pick or a new tolerance) and shows what they measure. */
function refit(): void {
  const { picks, tol } = useScanMeasure.getState();
  const shapes: { bodyId: string; shape: ScanShape }[] = [];

  for (const p of picks) {
    const m = scanOf(p.bodyId);
    const shape = m ? shapeAt(m, nearestTriangle(m, p.point), tol) : null;
    if (shape) shapes.push({ bodyId: p.bodyId, shape });
  }

  if (shapes.length < picks.length) {
    toast(
      t(
        "No plane, cylinder, cone or sphere fits there within {tol} mm. Raise the tolerance for rough scans.",
        { tol },
      ),
      "error",
    );
  }

  useScanMeasure.setState({ picks: picks.filter((_, i) => i < shapes.length), shapes });
  useApp.setState((s) => ({
    measure: {
      ...s.measure,
      picks: [],
      result: shapes.length ? { rows: rows(shapes.map((x) => x.shape)) } : null,
    },
  }));
}

const KIND: Record<ScanShape["kind"], string> = {
  plane: "Plane",
  cylinder: "Cylinder",
  cone: "Cone",
  sphere: "Sphere",
};

function rows(shapes: ScanShape[]): [string, string][] {
  const out: [string, string][] = [];

  for (const s of shapes) {
    const values = shapeValues(s);

    // With two shapes, each gets one line: what it is and its main size.
    if (shapes.length === 2) {
      out.push([KIND[s.kind], fmt(values[0]!)]);
    } else {
      out.push([KIND[s.kind], ""]);
      for (const v of values) out.push([v.label, fmt(v)]);
    }
  }

  if (shapes.length === 2) for (const v of compareShapes(shapes[0]!, shapes[1]!)) out.push([v.label, fmt(v)]);

  return out;
}

function fmt(v: ShapeValue): string {
  const n =
    Math.abs(v.value) >= 100
      ? v.value.toFixed(1)
      : v.value.toFixed(v.unit === "°" ? 1 : 3).replace(/\.?0+$/, "");

  return v.label === "Diameter" ? `Ø ${n} ${v.unit}` : v.unit === "°" ? `${n}°` : `${n} ${v.unit}`;
}

// Closing the Measure tool, a new model or another project drops the shapes.
useApp.subscribe((s, prev) => {
  if (!useScanMeasure.getState().picks.length) return;
  if (!s.measure.active || s.project?.id !== prev.project?.id) clearScanMeasure();
});
