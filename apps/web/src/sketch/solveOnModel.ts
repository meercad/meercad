/**
 * Solving a sketch for a change made on the model (outside the sketch editor), with the main-thread
 * solver the editor uses: dragged points pull towards their targets, the result goes into the
 * document as the new point positions, so the kernel's own solve starts where the change ended.
 */
import { resolveFeature } from "@meercad/model";
import type { RebuildOutput } from "@meercad/kernel/client";
import type { SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import type { ResolvedConstraint, SketchSolver, Vec2 } from "@meercad/sketch";
import { applySolution } from "./editor/geometry";
import { getSolver } from "./solver";

/** The solver, once loaded; changes made before it is fall back to the kernel's solve alone. */
let solver: SketchSolver | null = null;

/** Starts loading the solver (a change on the model may follow). */
export function preloadSolver(): void {
  void getSolver().then((loaded) => (solver = loaded));
}

/**
 * The sketch's entities solved with `constraints`, dragged points pulled to `drag`; constraints in
 * `skip` are left out of the solve (they are being changed). Null when it cannot be solved here.
 */
export function solveOnModel(
  sketch: SketchFeature,
  constraints: readonly SketchConstraint[],
  drag: Record<string, Vec2>,
  out: RebuildOutput,
  skip: ReadonlySet<string> = new Set(),
): { entities: SketchEntity[]; points: ReadonlyMap<string, Vec2> } | null {
  const view = out.report.sketches.find((x) => x.id === sketch.id);
  if (!solver || !view) return null;

  let resolved: ResolvedConstraint[];

  try {
    const scope = new Map(Object.entries(out.report.params));
    resolved = (
      resolveFeature({ ...sketch, constraints: [...constraints] }, scope) as {
        constraints: ResolvedConstraint[];
      }
    ).constraints;
  } catch {
    return null;
  }

  const solved = solver.solve(
    {
      entities: sketch.entities,
      constraints: resolved.filter((x) => !skip.has(x.id)),
      external: view.curves.filter((x) => x.external),
    },
    { drag },
  );

  return solved.diagnostics.ok
    ? { entities: applySolution(sketch.entities, solved), points: solved.points }
    : null;
}
