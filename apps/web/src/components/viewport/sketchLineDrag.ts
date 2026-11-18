/**
 * The drag arrow of a sketch line selected on the model: pressing on the line (or the arrow) and
 * dragging moves the line across itself in its sketch, solved like a drag in the sketch editor, with
 * the model rebuilt as it goes; the whole drag is one undo step (lib/sketchDrag.ts has the rules).
 */
import type { RebuildOutput } from "@meercad/kernel/client";
import type { SketchFeature } from "@meercad/schema";
import { midpoint2, toWorld, type Vec2 } from "@meercad/sketch";
import type { Handle, Pick } from "@meercad/viewport";
import { across, freedDimensions, movingPoints, shiftedTargets, withMeasured } from "../../lib/sketchDrag";
import { preloadSolver, solveOnModel } from "../../sketch/solveOnModel";
import { apply, applyQuiet, currentDoc } from "../../store";

type V3 = [number, number, number];

/** The arrow for a selected line of a sketch, or null when the pick is no such line. */
export function sketchLineHandle(out: RebuildOutput, pick: Pick): Handle | null {
  if (pick.kind !== "sketch_curve") return null;

  const view = out.report.sketches.find((x) => x.id === pick.sketchId);
  const curve = view?.curves.find((x) => x.id === pick.curveId);
  const sketch = currentDoc().features.find(
    (x): x is SketchFeature => x.id === pick.sketchId && x.op === "sketch",
  );
  if (!view || curve?.kind !== "line" || curve.external || !sketch) return null;

  preloadSolver();

  const normal = across(curve.a, curve.b);
  const world = (p: Vec2): V3 => toWorld(view.frame, p);
  const origin = world(midpoint2(curve.a, curve.b));
  const tip = world([curve.a[0] + normal[0], curve.a[1] + normal[1]]);
  const start = world(curve.a);
  const dir = tip.map((x, i) => x - start[i]!) as V3;
  const points = new Map(view.points.map(([id, x, y]) => [id, [x, y] as Vec2]));
  const moving = movingPoints(sketch, curve.id);
  const freed = freedDimensions(sketch, new Set(moving));
  let written = false;

  const write = (offset: number) => {
    const freedIds = new Set(freed.map((x) => x.id));
    const solved = solveOnModel(
      sketch,
      sketch.constraints,
      shiftedTargets(moving, points, normal, offset),
      out,
      freedIds,
    );
    if (!solved) return;

    const op = {
      type: "edit_feature" as const,
      id: sketch.id,
      patch: {
        entities: solved.entities,
        constraints: withMeasured(sketch, freed, solved.points),
      },
    };

    // The first change of the drag is the undo step, the rest fold into it.
    if (written) applyQuiet(op);
    else written = apply(op);
  };

  return {
    id: "sketch_line",
    origin,
    dir,
    value: 0,
    twoWay: true,
    grip: [world(curve.a), world(curve.b)],
    onDrag: write,
    onEnd: (offset) => {
      if (offset !== 0) write(offset);
    },
  };
}
