/** Sketch editing operations shared by the toolbar, keyboard shortcuts and the editor. */
import type { ComponentType, SVGProps } from "react";
import type { ConstraintType, SketchConstraint, SketchEntity, SketchFeature } from "@leocad/schema";
import { apply, applyQuiet, currentDoc, toast, useApp } from "../store";
import { Coincident, Collinear, Concentric, EqualIcon, Fix, Horizontal, Midpoint, Parallel, Perpendicular, Symmetric, Tangent, Vertical } from "./icons";
import { setSketchSelection, useSketchUi, type SketchSel } from "./state";

export function activeSketch(): SketchFeature | null {
  const id = useApp.getState().sketchId;
  const f = id ? currentDoc().features.find((x) => x.id === id) : undefined;
  return f?.op === "sketch" ? f : null;
}

/** Writes new entities/constraints for the active sketch. `merge` folds the change into the last undo step. */
export function writeSketch(next: Pick<SketchFeature, "entities" | "constraints">, merge = false): boolean {
  const sk = activeSketch();
  if (!sk) return false;
  const op = { type: "edit_feature" as const, id: sk.id, patch: { entities: next.entities, constraints: next.constraints } };
  return merge ? applyQuiet(op) : apply(op);
}

export function freshId(sk: Pick<SketchFeature, "entities" | "constraints">, prefix: string, taken: Set<string> = new Set()): string {
  const used = new Set([...sk.entities.map((e) => e.id), ...sk.constraints.map((c) => c.id), ...taken]);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  taken.add(`${prefix}${n}`);
  return `${prefix}${n}`;
}

/** Kind of a referenced curve id within the sketch (including projected curves "pr.0"). */
export function curveKind(sk: SketchFeature, id: string, external: Map<string, string>): "line" | "circle" | "arc" | null {
  const e = sk.entities.find((x) => x.id === id);
  if (e && (e.type === "line" || e.type === "circle" || e.type === "arc")) return e.type;
  return (external.get(id) as "line" | "circle" | "arc" | undefined) ?? (id === "origin.x" || id === "origin.y" ? "line" : null);
}

export let externalKinds = new Map<string, string>();
export const setExternalKinds = (m: Map<string, string>) => (externalKinds = m);

type Icon = ComponentType<SVGProps<SVGSVGElement>>;
export const CONSTRAINT_TOOLS: { type: string; icon: Icon; label: string; key?: string; hint: string }[] = [
  { type: "coincident", icon: Coincident, label: "Coincident", key: "Shift+N", hint: "two points, or a point and a curve" },
  { type: "hv", icon: Horizontal, label: "Horiz./Vert.", key: "Shift+V", hint: "lines or two points; picks the nearest axis" },
  { type: "vertical", icon: Vertical, label: "Vertical", hint: "lines or two points" },
  { type: "parallel", icon: Parallel, label: "Parallel", key: "Shift+A", hint: "two lines" },
  { type: "perpendicular", icon: Perpendicular, label: "Perpendicular", key: "Shift+P", hint: "two lines" },
  { type: "tangent", icon: Tangent, label: "Tangent", key: "Shift+T", hint: "a line and an arc/circle, or two arcs" },
  { type: "equal", icon: EqualIcon, label: "Equal", key: "Shift+E", hint: "lines or circles/arcs" },
  { type: "concentric", icon: Concentric, label: "Concentric", key: "Shift+C", hint: "two circles/arcs" },
  { type: "midpoint", icon: Midpoint, label: "Midpoint", key: "Shift+M", hint: "a point and a line" },
  { type: "collinear", icon: Collinear, label: "Collinear", hint: "two lines" },
  { type: "symmetric", icon: Symmetric, label: "Symmetric", key: "Shift+S", hint: "two points and a line" },
  { type: "fix", icon: Fix, label: "Lock", key: "Shift+L", hint: "points or curves" },
];

/** Creates constraints of `type` from the current selection. */
export function applyConstraint(type: string): void {
  const sk = activeSketch();
  if (!sk) return;
  const sel = useSketchUi.getState().selection;
  const pts = sel.filter((s) => s.kind === "point").map((s) => s.id);
  const curves = sel.filter((s) => s.kind === "curve").map((s) => s.id);
  const kinds = curves.map((c) => curveKind(sk, c, externalKinds));
  const lines = curves.filter((_, i) => kinds[i] === "line");
  const rounds = curves.filter((_, i) => kinds[i] === "circle" || kinds[i] === "arc");
  const taken = new Set<string>();
  const out: SketchConstraint[] = [];
  const id = () => freshId(sk, "c", taken);
  const need = (msg: string) => toast(`${CONSTRAINT_TOOLS.find((c) => c.type === type)?.label}: select ${msg}`, "error");

  if (type === "concentric") {
    if (rounds.length < 2) return need("two circles or arcs");
    for (let i = 1; i < rounds.length; i++) out.push({ id: id(), type: "coincident", a: `${rounds[0]}.center`, b: `${rounds[i]}.center` });
    if (writeSketch({ entities: sk.entities, constraints: [...sk.constraints, ...out] })) setSketchSelection([]);
    return;
  }
  if (type === "hv") {
    // Snap each line to whichever axis it is closer to.
    const solvedAt = (pid: string): [number, number] => {
      const e = sk.entities.find((x) => x.id === pid);
      return e?.type === "point" ? [e.x, e.y] : [0, 0];
    };
    for (const l of lines) {
      const e = sk.entities.find((x) => x.id === l);
      if (e?.type !== "line") continue;
      const [a, b] = [solvedAt(e.p1), solvedAt(e.p2)];
      out.push({ id: id(), type: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? "horizontal" : "vertical", line: l });
    }
    if (!lines.length && pts.length === 2) {
      const [a, b] = [solvedAt(pts[0]!), solvedAt(pts[1]!)];
      out.push({ id: id(), type: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? "horizontal_points" : "vertical_points", a: pts[0]!, b: pts[1]! });
    }
    if (!out.length) return need("lines or two points");
    if (writeSketch({ entities: sk.entities, constraints: [...sk.constraints, ...out] })) setSketchSelection([]);
    return;
  }
  switch (type as ConstraintType) {
    case "coincident":
      if (pts.length >= 2) for (let i = 1; i < pts.length; i++) out.push({ id: id(), type: "coincident", a: pts[0]!, b: pts[i]! });
      else if (pts.length === 1 && curves.length >= 1) for (const c of curves) out.push({ id: id(), type: "point_on", point: pts[0]!, curve: c });
      else if (rounds.length === 2) out.push({ id: id(), type: "coincident", a: `${rounds[0]}.center`, b: `${rounds[1]}.center` });
      else return need("two points, a point and a curve, or two circles (concentric)");
      break;
    case "horizontal":
    case "vertical":
      if (lines.length) for (const l of lines) out.push({ id: id(), type: type as "horizontal" | "vertical", line: l });
      else if (pts.length === 2) out.push({ id: id(), type: type === "horizontal" ? "horizontal_points" : "vertical_points", a: pts[0]!, b: pts[1]! });
      else return need("lines or two points");
      break;
    case "parallel":
    case "perpendicular":
    case "collinear":
      if (lines.length < 2) return need("two lines");
      for (let i = 1; i < lines.length; i++) out.push({ id: id(), type: type as "parallel" | "perpendicular" | "collinear", a: lines[0]!, b: lines[i]! });
      break;
    case "tangent":
      if (curves.length !== 2 || !rounds.length) return need("a line and an arc/circle, or two arcs/circles");
      out.push({ id: id(), type: "tangent", a: curves[0]!, b: curves[1]! });
      break;
    case "equal":
      if (lines.length >= 2) for (let i = 1; i < lines.length; i++) out.push({ id: id(), type: "equal", a: lines[0]!, b: lines[i]! });
      else if (rounds.length >= 2) for (let i = 1; i < rounds.length; i++) out.push({ id: id(), type: "equal", a: rounds[0]!, b: rounds[i]! });
      else return need("two lines or two circles/arcs");
      break;
    case "midpoint":
      if (pts.length !== 1 || lines.length !== 1) return need("a point and a line");
      out.push({ id: id(), type: "midpoint", point: pts[0]!, line: lines[0]! });
      break;
    case "symmetric":
      if (pts.length !== 2 || lines.length !== 1) return need("two points and a line");
      out.push({ id: id(), type: "symmetric", a: pts[0]!, b: pts[1]!, axis: lines[0]! });
      break;
    case "fix": {
      const targets = [...pts];
      for (const c of curves) {
        const e = sk.entities.find((x) => x.id === c);
        if (e?.type === "line") targets.push(e.p1, e.p2);
        if (e?.type === "circle") targets.push(e.center);
        if (e?.type === "arc") targets.push(e.center, e.start, e.end);
      }
      if (!targets.length) return need("points or curves");
      for (const p of new Set(targets)) out.push({ id: id(), type: "fix", point: p });
      break;
    }
    default:
      return;
  }
  if (writeSketch({ entities: sk.entities, constraints: [...sk.constraints, ...out] })) setSketchSelection([]);
}

export function toggleConstruction(): void {
  const sk = activeSketch();
  const sel = useSketchUi.getState().selection.filter((s) => s.kind === "curve" || s.kind === "point");
  if (sk && sel.length) {
    const ids = new Set(sel.map((s) => s.id));
    const entities = sk.entities.map((e) => (ids.has(e.id) ? ({ ...e, construction: !e.construction } as SketchEntity) : e));
    writeSketch({ entities, constraints: sk.constraints });
    return;
  }
  useSketchUi.setState((s) => ({ construction: !s.construction }));
}

/** Deletes selected geometry/constraints plus everything that depended on them. */
export function deleteSelection(): void {
  const sk = activeSketch();
  const sel = useSketchUi.getState().selection;
  if (!sk || !sel.length) return;
  const gone = new Set(sel.filter((s) => s.kind !== "constraint").map((s) => s.id));
  const goneC = new Set(sel.filter((s) => s.kind === "constraint").map((s) => s.id));
  // Removing a point removes curves using it; removing a curve removes its now-unused points.
  for (const e of sk.entities) {
    if (e.type === "line" && (gone.has(e.p1) || gone.has(e.p2))) gone.add(e.id);
    if (e.type === "circle" && gone.has(e.center)) gone.add(e.id);
    if (e.type === "arc" && (gone.has(e.center) || gone.has(e.start) || gone.has(e.end))) gone.add(e.id);
  }
  const usedPoints = new Set<string>();
  for (const e of sk.entities) {
    if (gone.has(e.id)) continue;
    if (e.type === "line") [e.p1, e.p2].forEach((p) => usedPoints.add(p));
    if (e.type === "circle") usedPoints.add(e.center);
    if (e.type === "arc") [e.center, e.start, e.end].forEach((p) => usedPoints.add(p));
  }
  for (const e of sk.entities) {
    if (e.type !== "point" || usedPoints.has(e.id) || sel.some((s) => s.id === e.id)) continue;
    const ownedByDeleted = sk.entities.some(
      (c) => gone.has(c.id) && ((c.type === "line" && (c.p1 === e.id || c.p2 === e.id)) || (c.type === "circle" && c.center === e.id) || (c.type === "arc" && [c.center, c.start, c.end].includes(e.id))),
    );
    if (ownedByDeleted) gone.add(e.id);
  }
  const refs = (c: SketchConstraint) => Object.entries(c).filter(([k, v]) => k !== "id" && k !== "type" && typeof v === "string").map(([, v]) => v as string);
  const touches = (c: SketchConstraint) => refs(c).some((r) => gone.has(r) || gone.has(r.split(".")[0]!));
  const entities = sk.entities.filter((e) => !gone.has(e.id));
  const constraints = sk.constraints.filter((c) => !goneC.has(c.id) && !touches(c));
  if (writeSketch({ entities, constraints })) setSketchSelection([]);
}

export function selectAll(): void {
  const sk = activeSketch();
  if (!sk) return;
  setSketchSelection(sk.entities.filter((e) => e.type !== "projection").map((e): SketchSel => ({ kind: e.type === "point" ? "point" : "curve", id: e.id })));
}
