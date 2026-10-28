/**
 * Values shown right on the model: the parameters of the selected feature, the dimensions of its
 * sketch, and the value at every drag arrow. Click a value to type a new number or expression.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import type { RebuildOutput } from "@meercad/kernel/client";
import type { Expr, Feature, SketchConstraint, SketchFeature } from "@meercad/schema";
import { toWorld, type Vec2 } from "@meercad/sketch";
import type { Viewport } from "@meercad/viewport";
import { faceAnchor, profileAnchor } from "../lib/anchors";
import { Link2Off } from "lucide-react";
import { evaluate } from "@meercad/model";
import { apply, toast, useApp } from "../store";
import { usePrefs } from "../lib/keymap";
import { parseExpr } from "./ExprInput";
import { ValueInput, type ValueUnit } from "./ValueInput";
import { docUnit, fmtLen, lengthExpr, lengthText } from "../lib/units";

type V3 = [number, number, number];

interface Item {
  key: string;
  at: V3;
  text: string;
  value: Expr;
  unit: ValueUnit;
  /** Name suggested when the value becomes a new variable. */
  suggest: string;
  /** Can be detached from its variables (lengths only; angles are stored in other units). */
  unlinkable?: boolean;
  commit: (v: Expr) => void;
}

/** Label text: lengths (" mm") in the design's unit; sketch dimensions ("") without a unit in mm designs. */
const fmt = (e: Expr, unit = " mm") => {
  if (typeof e !== "number") return String(e);
  if (unit === " mm") return fmtLen(e);
  if (unit === "" && docUnit() === "in") return fmtLen(e);
  return `${+e.toFixed(3)}${unit}`;
};

function faceCenterByTag(out: RebuildOutput, prefix: string): V3 | null {
  for (const m of out.meshes) {
    const i = m.faceTags.findIndex((t) => t.some((x) => x.startsWith(prefix)));
    if (i >= 0) return faceAnchor(m, i)?.origin ?? null;
  }
  return null;
}

function featureItems(f: Feature, out: RebuildOutput): Item[] {
  const edit = (patch: Record<string, unknown>) => apply({ type: "edit_feature", id: f.id, patch });
  const item = (key: string, at: V3 | null, label: string, value: Expr, field: string, unit = " mm"): Item[] =>
    at
      ? [{ key: `${f.id}.${key}`, at, text: `${label}${fmt(value, unit)}`, value, unit: unit === " mm" ? "mm" : unit === "°" ? "deg" : "", suggest: `${f.op}_${field}`, unlinkable: unit === " mm", commit: (v) => edit({ [field]: v }) }]
      : [];
  switch (f.op) {
    case "extrude": {
      if (f.extent === "through_all") return [];
      const at = faceCenterByTag(out, `${f.id}.end_cap`) ?? profileAnchor(out, f.profile)?.origin ?? null;
      return item("distance", at, "↕ ", f.distance, "distance");
    }
    case "revolve":
      return item("angle", faceCenterByTag(out, `${f.id}.side[`), "∠ ", f.angle, "angle", "°");
    case "fillet":
      return item("radius", faceCenterByTag(out, `${f.id}.round[`), "R ", f.radius, "radius");
    case "chamfer":
      return item("distance", faceCenterByTag(out, `${f.id}.bevel[`), "⌟ ", f.distance, "distance");
    case "shell":
      return item("thickness", faceCenterByTag(out, `${f.id}.inner[`), "▭ ", f.thickness, "thickness");
    case "plane": {
      const p = out.report.planes.find((x) => x.id === f.id);
      return item("offset", p ? p.frame.origin : null, "⇥ ", f.offset, "offset");
    }
    case "linear_pattern":
    case "circular_pattern": {
      const at = faceCenterByTag(out, `@${f.id}.1`) ?? null;
      const items = item("count", at, "× ", f.count, "count", "");
      if (f.op === "linear_pattern" && at) items.push(...item("spacing", [at[0], at[1], at[2] + 6], "↔ ", f.spacing, "spacing"));
      return items;
    }
    default:
      return [];
  }
}

/** Editable dimension labels of a sketch, placed on its plane (or only those of `only`, moved onto `onto`). */
function sketchItems(sk: SketchFeature, out: RebuildOutput, only?: Set<string>, onto?: V3): Item[] {
  const view = out.report.sketches.find((s) => s.id === sk.id);
  if (!view) return [];
  const pts = new Map(view.points.map(([id, x, y]) => [id, [x, y] as Vec2]));
  const mid = (id: string): Vec2 | null => {
    const c = view.curves.find((x) => x.id === id);
    if (!c) return null;
    if (c.kind === "line") return [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2];
    return [c.center[0] + c.radius * 0.7, c.center[1] + c.radius * 0.7];
  };
  const items: Item[] = [];
  const equalPartners = new Set(
    only ? sk.constraints.flatMap((c) => (c.type === "equal" && (only.has(c.a) || only.has(c.b)) ? [c.a, c.b] : [])) : [],
  );
  for (const c of sk.constraints) {
    if (!("value" in c)) continue;
    // Sizes set on an equal partner (e.g. one diameter driving several holes) belong to the shape too.
    const sizedViaEqual = (c.type === "length" || c.type === "radius" || c.type === "diameter") && equalPartners.has(constraintRefs(c)[0]!);
    if (only && !constraintRefs(c).some((r) => only.has(r)) && !sizedViaEqual) continue;
    let at: Vec2 | null = c.label ?? null;
    if (!at) {
      if (c.type === "length") at = mid(c.line);
      else if (c.type === "radius" || c.type === "diameter") at = mid(c.curve);
      else if (c.type === "angle") at = mid(c.a);
      else if (c.type === "arc_angle") at = mid(c.curve);
      else if (c.type === "distance") {
        const a = pts.get(c.a);
        const b = pts.get(c.b) ?? mid(c.b);
        at = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
      }
    }
    if (!at) continue;
    const prefix = c.type === "diameter" ? "⌀ " : c.type === "radius" ? "R " : "";
    let world = toWorld(view.frame, at);
    // Slide the label along the sketch normal to the selected face, so it sits on the model.
    if (onto) {
      const n = view.frame.normal;
      const d = (onto[0] - world[0]) * n[0] + (onto[1] - world[1]) * n[1] + (onto[2] - world[2]) * n[2];
      world = [world[0] + n[0] * d, world[1] + n[1] * d, world[2] + n[2] * d];
    }
    items.push({
      key: `${sk.id}.${c.id}`,
      at: world,
      unit: c.type === "angle" || c.type === "arc_angle" ? "deg" : "mm",
      suggest: c.type === "diameter" ? "diameter" : c.type === "radius" ? "radius" : c.type === "angle" || c.type === "arc_angle" ? "angle" : c.type === "length" ? "length" : "distance",
      text: `${c.type === "arc_angle" ? "∠ " : prefix}${fmt(c.value, c.type === "angle" || c.type === "arc_angle" ? "°" : "")}`,
      value: c.value,
      unlinkable: c.type !== "angle" && c.type !== "arc_angle",
      commit: (v) => apply({ type: "edit_feature", id: sk.id, patch: { constraints: sk.constraints.map((x) => (x.id === c.id ? ({ ...x, value: v } as SketchConstraint) : x)) } }),
    });
  }
  return items;
}

export function InlineValues({ viewport }: { viewport: Viewport }) {
  const selected = useApp((s) => s.selectedFeature);
  const doc = useApp((s) => s.doc);
  const out = useApp((s) => s.baseOutput);
  const dialog = useApp((s) => s.dialog);
  const sketchId = useApp((s) => s.sketchId);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const [editing, setEditing] = useState<string | null>(null);
  const showValues = usePrefs((s) => s.showValues);
  const selection = useApp((s) => s.selection);
  useEffect(() => viewport.onChange(tick), [viewport]);
  // Drag arrows are set up after this renders (by the manipulators); lay out again once they change.
  const handleSig = useRef("");
  useEffect(() => {
    const sig = viewport.handles.map((h) => h.id).join();
    if (sig !== handleSig.current) {
      handleSig.current = sig;
      tick();
    }
  });
  if (!out || sketchId || dialog || !selected || !showValues) return null;
  const f = doc.features.find((x) => x.id === selected);
  if (!f) return null;
  const items = [...featureItems(f, out)];
  // Show the driving sketch's dimensions too, so the whole feature can be resized in place.
  const skId = f.op === "sketch" ? f.id : (f.op === "extrude" || f.op === "revolve") && "sketch" in f.profile ? f.profile.sketch : null;
  const sk = skId ? doc.features.find((x): x is SketchFeature => x.id === skId && x.op === "sketch") : undefined;
  if (sk) {
    // A picked face of the feature narrows this to the dimensions of the shape it came from.
    const face = selection.length === 1 && selection[0]!.kind === "face" ? selection[0]! : null;
    const curve = face?.kind === "face" ? face.tags.map((t) => new RegExp(`^${f.id}\\.side\\[${sk.id}\\.([\\w-]+?)(?::\\d+)?\\]$`).exec(t)?.[1]).find(Boolean) : undefined;
    if (curve && face?.kind === "face") {
      const m = out.meshes.find((x) => x.bodyId === face.bodyId);
      items.push(...sketchItems(sk, out, shapeOf(sk, curve), (m && faceAnchor(m, face.face)?.origin) ?? face.point));
    } else if (!face) items.push(...sketchItems(sk, out));
  }
  return (
    <div className="overlay-layer">
      {layoutChips(items, viewport).map(({ it, s }) => {
        return (
          <div key={it.key} className="value-chip" style={{ left: s[0], top: s[1] }} onPointerDown={(e) => e.stopPropagation()}>
            {editing === it.key ? (
              <ValueInput value={it.value} unit={it.unit} suggest={it.suggest} onDone={(v) => (setEditing(null), v !== null && v !== it.value && commitKeepingParams(it, v))} />
            ) : (
              <>
                <button onClick={() => setEditing(it.key)} title="Click to edit">
                  {it.text}
                </button>
                {it.unlinkable && typeof it.value === "string" && isLinked(it.value) ? (
                  <button className="unlink" onClick={() => unlink(it)} title="Linked to a variable — click to use a plain number here instead">
                    <Link2Off />
                  </button>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Screen positions for the chips, nudged up or down so none overlaps another chip or a drag
 * arrow's value label (several dimensions often project onto the same spot).
 */
function layoutChips(items: Item[], viewport: Viewport): { it: Item; s: [number, number] }[] {
  type Box = { x: number; y: number; w: number; h: number };
  const H = 26;
  const overlaps = (a: Box, b: Box) => Math.abs(a.x - b.x) * 2 < a.w + b.w + 6 && Math.abs(a.y - b.y) * 2 < a.h + b.h + 4;
  const placed: Box[] = [];
  // Drag arrows keep their labels where they are; chips make room around them.
  for (const h of viewport.handles) {
    const t = viewport.handleTipScreen(h.id);
    if (t) placed.push({ x: t[0] + 16, y: t[1] - 16, w: 90, h: H });
  }
  const out: { it: Item; s: [number, number] }[] = [];
  for (const it of items) {
    const s = viewport.worldToScreen(it.at);
    if (!s) continue;
    const w = it.text.length * 7.4 + 22 + (it.unlinkable && typeof it.value === "string" ? 26 : 0);
    const steps = [0, 1, -1, 2, -2, 3, -3, 4, -4];
    const box = steps.map((k) => ({ x: s[0], y: s[1] + k * (H + 4), w, h: H })).find((b) => !placed.some((p) => overlaps(b, p))) ?? { x: s[0], y: s[1], w, h: H };
    placed.push(box);
    out.push({ it, s: [box.x, box.y] });
  }
  return out;
}

/** Entity ids of the shape a curve belongs to: everything connected to it through shared points. */
function shapeOf(sk: SketchFeature, curve: string): Set<string> {
  const pointsOf = (e: SketchFeature["entities"][number]): string[] =>
    e.type === "line" ? [e.p1, e.p2] : e.type === "circle" ? [e.center] : e.type === "arc" ? [e.center, e.start, e.end] : [];
  const ids = new Set([curve]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of sk.entities) {
      const pts = pointsOf(e);
      const touches = ids.has(e.id) || pts.some((p) => ids.has(p));
      if (!touches) continue;
      for (const id of [e.id, ...pts]) if (!ids.has(id)) (ids.add(id), (grew = true));
    }
    // Constraints like midpoint/point_on tie extra points (a rectangle's centre) to the shape.
    for (const c of sk.constraints) {
      if (c.type !== "midpoint" && c.type !== "point_on" && c.type !== "coincident" && c.type !== "symmetric") continue;
      const refs = constraintRefs(c);
      if (refs.some((r) => ids.has(r)) && refs.some((r) => !ids.has(r) && r !== "origin" && !r.startsWith("origin."))) for (const r of refs) if (r !== "origin" && !r.startsWith("origin.") && !ids.has(r)) (ids.add(r), (grew = true));
    }
  }
  return ids;
}

/** Entity ids a constraint refers to ("l1.p1" counts as "l1"). */
function constraintRefs(c: SketchConstraint): string[] {
  return Object.entries(c)
    .filter(([k, v]) => k !== "id" && k !== "type" && k !== "label" && typeof v === "string")
    .map(([, v]) => (v as string).split(".")[0]!);
}

/**
 * A value that is just a variable name keeps its link: typing a number changes the variable
 * (everything using it follows); typing an expression replaces the link deliberately.
 */
/** True for values that reference variables (anything but a plain number). */
function isLinked(value: string): boolean {
  return Object.keys(useApp.getState().doc.params).some((name) => new RegExp(`\\b${name}\\b`).test(value));
}

/** Replaces a variable-driven value with its current number, so only this dimension changes from now on. */
function unlink(it: Item): void {
  try {
    const n = evaluate(it.value, new Map(Object.entries(useApp.getState().baseOutput?.report.params ?? {})));
    it.commit(+n.toFixed(4));
    toast("Unlinked — this value no longer follows the variable");
  } catch {
    toast("Could not evaluate this value", "error");
  }
}

function commitKeepingParams(it: Item, v: Expr): void {
  const params = useApp.getState().doc.params;
  // A plain value typed over a variable changes the variable, not the dimension's link to it.
  const plain = typeof v === "number" || /^\s*-?\d+(\.\d+)?\s*(mm|in|deg)\s*$/.test(v);
  if (typeof it.value === "string" && it.value in params && plain) {
    const old = params[it.value]!;
    const unit = typeof v === "number" ? (typeof old === "string" && /deg\b/.test(old) ? " deg" : typeof old === "string" && /mm\b/.test(old) ? " mm" : "") : "";
    apply({ type: "set_param", name: it.value, expr: unit ? `${v}${unit}` : v });
    return;
  }
  it.commit(v);
}

/** Quick value field; a `length` is shown and typed in the design's unit. */
export function InlineInput({ value, length, onDone }: { value: Expr; length?: boolean; onDone: (v: Expr | null) => void }) {
  const initial = length ? lengthText(value) : String(value);
  const [text, setText] = useState(initial);
  const parse = (t: string): Expr | null => (!t.trim() || t.trim() === initial ? null : length ? lengthExpr(t) : parseExpr(t));
  const done = useRef(false);
  const finish = (v: Expr | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      autoFocus
      className="value-input"
      value={text}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(parse(text))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(parse(text));
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}
