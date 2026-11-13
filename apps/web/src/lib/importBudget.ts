/**
 * Very fine meshes made lighter before they are imported: the kernel turns every triangle into a
 * face of its own (about 0.3 ms each), so a 3MF with 1.5 million triangles would hold the app for
 * many minutes. Above the budget the app asks (the assistant does it without asking); made lighter,
 * every mesh keeps its share of the budget, the finest ones losing the most.
 */
import type { TriangleMesh } from "@meercad/io";
import { repairMesh } from "@meercad/kernel/fit";

/** Kernel time per imported triangle (measured on a Mac: 100,000 triangles 29 s; phones and tablets are slower). */
export const TRIANGLE_MS = 0.3;
/**
 * Triangles one import brings in without asking, all of a file's meshes together: about 30 s on a
 * Mac, and still far finer than a print shows.
 */
export const IMPORT_TRIANGLES = 100_000;
/** No mesh is made coarser than this. */
const FLOOR = 2_000;

export interface Lightened {
  /** Index of the mesh in the list given. */
  index: number;
  from: number;
  to: number;
}

/** The meshes within `budget` triangles together (unchanged when they are), and which ones were made lighter. */
export function withinBudget<M extends TriangleMesh>(meshes: readonly M[], budget = IMPORT_TRIANGLES): { meshes: M[]; lightened: Lightened[] } {
  const counts = meshes.map((m) => m.indices.length / 3);
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= budget) return { meshes: [...meshes], lightened: [] };
  const share = budget / total;
  const lightened: Lightened[] = [];
  const out = meshes.map((m, index) => {
    const from = counts[index]!;
    const target = Math.max(FLOOR, Math.floor(from * share));
    if (from <= target) return m;
    const corners = new Float32Array(m.indices.length * 3);
    m.indices.forEach((v, k) => corners.set(m.positions.subarray(v * 3, v * 3 + 3), k * 3));
    const r = repairMesh(corners, { target });
    lightened.push({ index, from, to: r.report.after });
    return { ...m, positions: r.positions, indices: r.indices };
  });
  return { meshes: out, lightened };
}
