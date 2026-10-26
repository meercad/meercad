/**
 * Values shown right on the model: the parameters of the selected feature, the dimensions of its
 * sketch, and the value at every drag arrow. Click a value to type a new number or expression.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import type { RebuildOutput } from "@leocad/kernel/client";
import type { Expr, Feature, SketchConstraint, SketchFeature } from "@leocad/schema";
import { toWorld, type Vec2 } from "@leocad/sketch";
import type { Viewport } from "@leocad/viewport";
import { faceAnchor, profileAnchor } from "../lib/anchors";
import { Link2Off } from "lucide-react";
import { evaluate } from "@leocad/model";
import { apply, toast, useApp } from "../store";
import { usePrefs } from "../lib/keymap";
import { parseExpr } from "./ExprInput";

type V3 = [number, number, number];

interface Item {
  key: string;
  at: V3;
  text: string;
  value: Expr;
  /** Can be detached from its variables (lengths only; angles are stored in other units). */
  unlinkable?: boolean;
  commit: (v: Expr) => void;
}

const fmt = (e: Expr, unit = " mm") => (typeof e === "number" ? `${+e.toFixed(3)}${unit}` : String(e));

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
    at ? [{ key: `${f.id}.${key}`, at, text: `${label}${fmt(value, unit)}`, value, unlinkable: unit === " mm", commit: (v) => edit({ [field]: v }) }] : [];
  switch (f.op) {
    case "extrude": {
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

/** Editable dimension labels of a sketch, placed on its plane. */
function sketchItems(sk: SketchFeature, out: RebuildOutput): Item[] {
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
  for (const c of sk.constraints) {
    if (!("value" in c)) continue;
    let at: Vec2 | null = c.label ?? null;
    if (!at) {
      if (c.type === "length") at = mid(c.line);
      else if (c.type === "radius" || c.type === "diameter") at = mid(c.curve);
      else if (c.type === "angle") at = mid(c.a);
      else if (c.type === "distance") {
        const a = pts.get(c.a);
        const b = pts.get(c.b) ?? mid(c.b);
        at = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
      }
    }
    if (!at) continue;
    const prefix = c.type === "diameter" ? "⌀ " : c.type === "radius" ? "R " : "";
    items.push({
      key: `${sk.id}.${c.id}`,
      at: toWorld(view.frame, at),
      text: `${prefix}${fmt(c.value, c.type === "angle" ? "°" : "")}`,
      value: c.value,
      unlinkable: c.type !== "angle",
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
  useEffect(() => viewport.onChange(tick), [viewport]);
  if (!out || sketchId || dialog || !selected || !showValues) return null;
  const f = doc.features.find((x) => x.id === selected);
  if (!f) return null;
  const items = [...featureItems(f, out)];
  // Show the driving sketch's dimensions too, so the whole feature can be resized in place.
  const skId = f.op === "sketch" ? f.id : (f.op === "extrude" || f.op === "revolve") && "sketch" in f.profile ? f.profile.sketch : null;
  const sk = skId ? doc.features.find((x): x is SketchFeature => x.id === skId && x.op === "sketch") : undefined;
  if (sk) items.push(...sketchItems(sk, out));
  return (
    <div className="overlay-layer">
      {items.map((it) => {
        const s = viewport.worldToScreen(it.at);
        if (!s) return null;
        return (
          <div key={it.key} className="value-chip" style={{ left: s[0], top: s[1] }} onPointerDown={(e) => e.stopPropagation()}>
            {editing === it.key ? (
              <InlineInput value={it.value} onDone={(v) => (setEditing(null), v !== null && v !== it.value && commitKeepingParams(it, v))} />
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
  if (typeof it.value === "string" && it.value in params && typeof v === "number") {
    const old = params[it.value]!;
    const unit = typeof old === "string" && /deg\b/.test(old) ? " deg" : typeof old === "string" && /mm\b/.test(old) ? " mm" : "";
    apply({ type: "set_param", name: it.value, expr: unit ? `${v}${unit}` : v });
    return;
  }
  it.commit(v);
}

export function InlineInput({ value, onDone }: { value: Expr; onDone: (v: Expr | null) => void }) {
  const [text, setText] = useState(String(value));
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
      onBlur={() => finish(text.trim() ? parseExpr(text) : null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(text.trim() ? parseExpr(text) : null);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}
