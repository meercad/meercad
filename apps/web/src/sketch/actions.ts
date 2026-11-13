/** Sketch editing operations shared by the toolbar, keyboard shortcuts and the editor. */
import type { ComponentType, SVGProps } from "react";
import type { ConstraintType, SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import { t } from "../lib/i18n";
import type { ConstraintKind } from "../lib/controls";
import { apply, applyQuiet, currentDoc, toast, useApp } from "../store";
import {
  Coincident,
  Collinear,
  Concentric,
  EqualIcon,
  Fix,
  Horizontal,
  Midpoint,
  Parallel,
  Perpendicular,
  Symmetric,
  Tangent,
  Vertical,
} from "./icons";
import { setSketchSelection, useSketchUi, type SketchSel } from "./state";

export function activeSketch(): SketchFeature | null {
  const id = useApp.getState().sketchId;
  const feature = id ? currentDoc().features.find((x) => x.id === id) : undefined;

  return feature?.op === "sketch" ? feature : null;
}

/**
 * Writes new entities/constraints for the active sketch. `merge` folds the change into the last undo step.
 */
export function writeSketch(next: Pick<SketchFeature, "entities" | "constraints">, merge = false): boolean {
  const sketch = activeSketch();
  if (!sketch) return false;

  const op = {
    type: "edit_feature" as const,
    id: sketch.id,
    patch: { entities: next.entities, constraints: next.constraints },
  };

  return merge ? applyQuiet(op) : apply(op);
}

export function freshId(
  sk: Pick<SketchFeature, "entities" | "constraints">,
  prefix: string,
  taken: Set<string> = new Set(),
): string {
  const used = new Set([
    ...sk.entities.map((entity) => entity.id),
    ...sk.constraints.map((constraint) => constraint.id),
    ...taken,
  ]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  taken.add(`${prefix}${n}`);

  return `${prefix}${n}`;
}

/** Kind of a referenced curve id within the sketch (including projected curves "pr.0"). */
export function curveKind(
  sketch: SketchFeature,
  id: string,
  external: Map<string, string>,
): "line" | "circle" | "arc" | null {
  const entity = sketch.entities.find((x) => x.id === id);

  if (entity && (entity.type === "line" || entity.type === "circle" || entity.type === "arc")) {
    return entity.type;
  }

  return (
    (external.get(id) as "line" | "circle" | "arc" | undefined) ??
    (id === "origin.x" || id === "origin.y" ? "line" : null)
  );
}

export let externalKinds = new Map<string, string>();
export const setExternalKinds = (m: Map<string, string>) => (externalKinds = m);

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
export const CONSTRAINT_TOOLS: { type: ConstraintKind; icon: Icon; label: string; hint: string }[] = [
  {
    type: "coincident",
    icon: Coincident,
    label: t("Coincident"),
    hint: t("two points, or a point and a curve"),
  },
  {
    type: "hv",
    icon: Horizontal,
    label: t("Horiz./Vert."),
    hint: t("lines or two points; picks the nearest axis"),
  },
  { type: "vertical", icon: Vertical, label: t("Vertical"), hint: t("lines or two points") },
  { type: "parallel", icon: Parallel, label: t("Parallel"), hint: t("two lines") },
  { type: "perpendicular", icon: Perpendicular, label: t("Perpendicular"), hint: t("two lines") },
  {
    type: "tangent",
    icon: Tangent,
    label: t("Tangent"),
    hint: t("a line and an arc/circle, two arcs, or a spline and a curve at its end"),
  },
  { type: "equal", icon: EqualIcon, label: t("Equal"), hint: t("lines or circles/arcs") },
  { type: "concentric", icon: Concentric, label: t("Concentric"), hint: t("two circles/arcs") },
  { type: "midpoint", icon: Midpoint, label: t("Midpoint"), hint: t("a point and a line") },
  { type: "collinear", icon: Collinear, label: t("Collinear"), hint: t("two lines") },
  { type: "symmetric", icon: Symmetric, label: t("Symmetric"), hint: t("two points and a line") },
  { type: "fix", icon: Fix, label: t("Lock"), hint: t("points or curves") },
];

/** Creates constraints of `type` from the current selection. */
export function applyConstraint(type: string): void {
  const sketch = activeSketch();
  if (!sketch) return;

  const sel = useSketchUi.getState().selection;
  const pts = sel.filter((selection) => selection.kind === "point").map((s) => s.id);
  const curves = sel.filter((selection) => selection.kind === "curve").map((s) => s.id);
  const kinds = curves.map((c) => curveKind(sketch, c, externalKinds));
  const lines = curves.filter((_, i) => kinds[i] === "line");
  const rounds = curves.filter((_, i) => kinds[i] === "circle" || kinds[i] === "arc");
  const splines = curves.filter((c) =>
    sketch.entities.some((entity) => entity.id === c && entity.type === "spline"),
  );
  const taken = new Set<string>();
  const out: SketchConstraint[] = [];
  const id = () => freshId(sketch, "c", taken);
  const need = (msg: string) =>
    toast(
      t("{tool}: select {what}", {
        tool: CONSTRAINT_TOOLS.find((c) => c.type === type)?.label ?? "",
        what: msg,
      }),
      "error",
    );

  if (type === "concentric") {
    if (rounds.length < 2) return need(t("two circles or arcs"));

    for (let i = 1; i < rounds.length; i++) {
      out.push({ id: id(), type: "coincident", a: `${rounds[0]}.center`, b: `${rounds[i]}.center` });
    }

    if (writeSketch({ entities: sketch.entities, constraints: [...sketch.constraints, ...out] })) {
      setSketchSelection([]);
    }

    return;
  }

  if (type === "hv") {
    // Snap each line to whichever axis it is closer to.
    const solvedAt = (pid: string): [number, number] => {
      const entity = sketch.entities.find((x) => x.id === pid);

      return entity?.type === "point" ? [entity.x, entity.y] : [0, 0];
    };

    for (const l of lines) {
      const entity = sketch.entities.find((x) => x.id === l);
      if (entity?.type !== "line") continue;

      const [a, b] = [solvedAt(entity.p1), solvedAt(entity.p2)];
      out.push({
        id: id(),
        type: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? "horizontal" : "vertical",
        line: l,
      });
    }

    if (!lines.length && pts.length === 2) {
      const [a, b] = [solvedAt(pts[0]!), solvedAt(pts[1]!)];
      out.push({
        id: id(),
        type: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? "horizontal_points" : "vertical_points",
        a: pts[0]!,
        b: pts[1]!,
      });
    }

    if (!out.length) return need(t("lines or two points"));

    if (writeSketch({ entities: sketch.entities, constraints: [...sketch.constraints, ...out] })) {
      setSketchSelection([]);
    }

    return;
  }

  switch (type as ConstraintType) {
    case "coincident":
      if (pts.length >= 2) {
        for (let i = 1; i < pts.length; i++) {
          out.push({ id: id(), type: "coincident", a: pts[0]!, b: pts[i]! });
        }
      } else if (pts.length === 1 && curves.length >= 1) {
        for (const c of curves) out.push({ id: id(), type: "point_on", point: pts[0]!, curve: c });
      } else if (rounds.length === 2) {
        out.push({ id: id(), type: "coincident", a: `${rounds[0]}.center`, b: `${rounds[1]}.center` });
      } else {
        return need(t("two points, a point and a curve, or two circles (concentric)"));
      }

      break;
    case "horizontal":
    case "vertical":
      if (lines.length) {
        for (const l of lines) out.push({ id: id(), type: type as "horizontal" | "vertical", line: l });
      } else if (pts.length === 2) {
        out.push({
          id: id(),
          type: type === "horizontal" ? "horizontal_points" : "vertical_points",
          a: pts[0]!,
          b: pts[1]!,
        });
      } else {
        return need(t("lines or two points"));
      }

      break;
    case "parallel":
    case "perpendicular":
    case "collinear":
      if (lines.length < 2) return need(t("two lines"));

      for (let i = 1; i < lines.length; i++) {
        out.push({
          id: id(),
          type: type as "parallel" | "perpendicular" | "collinear",
          a: lines[0]!,
          b: lines[i]!,
        });
      }

      break;
    case "tangent":
      if (curves.length === 2 && splines.length) {
        // A spline takes a tangent only at an end it shares with the other curve.
        const ends = (c: string) => {
          const entity = sketch.entities.find((x) => x.id === c);

          return entity?.type === "spline"
            ? entity.closed
              ? []
              : [entity.points[0], entity.points[entity.points.length - 1]]
            : entity?.type === "line"
              ? [entity.p1, entity.p2]
              : entity?.type === "arc"
                ? [entity.start, entity.end]
                : [];
        };

        if (!ends(curves[0]!).some((q) => ends(curves[1]!).includes(q))) {
          return need(t("a spline and a curve that ends where it ends"));
        }
      } else if (curves.length !== 2 || !rounds.length) {
        return need(t("a line and an arc/circle, or two arcs/circles"));
      }

      out.push({ id: id(), type: "tangent", a: curves[0]!, b: curves[1]! });
      break;
    case "equal":
      if (lines.length >= 2) {
        for (let i = 1; i < lines.length; i++) {
          out.push({ id: id(), type: "equal", a: lines[0]!, b: lines[i]! });
        }
      } else if (rounds.length >= 2) {
        for (let i = 1; i < rounds.length; i++) {
          out.push({ id: id(), type: "equal", a: rounds[0]!, b: rounds[i]! });
        }
      } else {
        return need(t("two lines or two circles/arcs"));
      }

      break;
    case "midpoint":
      if (pts.length !== 1 || lines.length !== 1) return need(t("a point and a line"));

      out.push({ id: id(), type: "midpoint", point: pts[0]!, line: lines[0]! });
      break;
    case "symmetric":
      if (pts.length !== 2 || lines.length !== 1) return need(t("two points and a line"));

      out.push({ id: id(), type: "symmetric", a: pts[0]!, b: pts[1]!, axis: lines[0]! });
      break;
    case "fix": {
      const targets = [...pts];

      for (const c of curves) {
        const entity = sketch.entities.find((x) => x.id === c);
        if (entity?.type === "line") targets.push(entity.p1, entity.p2);
        if (entity?.type === "circle") targets.push(entity.center);
        if (entity?.type === "arc") targets.push(entity.center, entity.start, entity.end);
      }

      if (!targets.length) return need(t("points or curves"));

      for (const p of new Set(targets)) out.push({ id: id(), type: "fix", point: p });
      break;
    }
    default:
      return;
  }

  if (writeSketch({ entities: sketch.entities, constraints: [...sketch.constraints, ...out] })) {
    setSketchSelection([]);
  }
}

export function toggleConstruction(): void {
  const sketch = activeSketch();
  const sel = useSketchUi
    .getState()
    .selection.filter((selection) => selection.kind === "curve" || selection.kind === "point");

  if (sketch && sel.length) {
    const ids = new Set(sel.map((s) => s.id));
    const entities = sketch.entities.map((entity) =>
      ids.has(entity.id) ? ({ ...entity, construction: !entity.construction } as SketchEntity) : entity,
    );
    writeSketch({ entities, constraints: sketch.constraints });

    return;
  }

  useSketchUi.setState((s) => ({ construction: !s.construction }));
}

/** Deletes selected geometry/constraints plus everything that depended on them. */
export function deleteSelection(): void {
  const sketch = activeSketch();
  const sel = useSketchUi.getState().selection;
  if (!sketch || !sel.length) return;

  const gone = new Set(sel.filter((selection) => selection.kind !== "constraint").map((s) => s.id));
  const goneC = new Set(sel.filter((selection) => selection.kind === "constraint").map((s) => s.id));

  // Removing a point removes curves using it; removing a curve removes its now-unused points.
  for (const entity of sketch.entities) {
    if (entity.type === "line" && (gone.has(entity.p1) || gone.has(entity.p2))) gone.add(entity.id);
    if (entity.type === "circle" && gone.has(entity.center)) gone.add(entity.id);

    if (
      entity.type === "arc" &&
      (gone.has(entity.center) || gone.has(entity.start) || gone.has(entity.end))
    ) {
      gone.add(entity.id);
    }
  }

  const usedPoints = new Set<string>();

  for (const entity of sketch.entities) {
    if (gone.has(entity.id)) continue;
    if (entity.type === "line") [entity.p1, entity.p2].forEach((p) => usedPoints.add(p));
    if (entity.type === "circle") usedPoints.add(entity.center);
    if (entity.type === "arc") [entity.center, entity.start, entity.end].forEach((p) => usedPoints.add(p));
  }

  for (const entity of sketch.entities) {
    if (
      entity.type !== "point" ||
      usedPoints.has(entity.id) ||
      sel.some((selection) => selection.id === entity.id)
    ) {
      continue;
    }

    const ownedByDeleted = sketch.entities.some(
      (c) =>
        gone.has(c.id) &&
        ((c.type === "line" && (c.p1 === entity.id || c.p2 === entity.id)) ||
          (c.type === "circle" && c.center === entity.id) ||
          (c.type === "arc" && [c.center, c.start, c.end].includes(entity.id))),
    );
    if (ownedByDeleted) gone.add(entity.id);
  }

  const refs = (constraint: SketchConstraint) =>
    Object.entries(constraint)
      .filter(([k, v]) => k !== "id" && k !== "type" && typeof v === "string")
      .map(([, v]) => v as string);
  const touches = (constraint: SketchConstraint) =>
    refs(constraint).some((r) => gone.has(r) || gone.has(r.split(".")[0]!));
  const entities = sketch.entities.filter((entity) => !gone.has(entity.id));
  const constraints = sketch.constraints.filter(
    (constraint) => !goneC.has(constraint.id) && !touches(constraint),
  );
  if (writeSketch({ entities, constraints })) setSketchSelection([]);
}

export function selectAll(): void {
  const sketch = activeSketch();
  if (!sketch) return;

  setSketchSelection(
    sketch.entities
      .filter((entity) => entity.type !== "projection")
      .map((e): SketchSel => ({ kind: e.type === "point" ? "point" : "curve", id: e.id })),
  );
}
