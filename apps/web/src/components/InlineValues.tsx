/**
 * Values shown right on the model: the parameters of the selected feature, the dimensions of its
 * sketch, and the value at every drag arrow. Click a value to type a new number or expression.
 */
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { RebuildOutput } from "@meercad/kernel/client";
import type { Expr, Feature, SketchConstraint, SketchFeature } from "@meercad/schema";
import { toWorld, type Vec2 } from "@meercad/sketch";
import { THREE, type Pick, type Viewport } from "@meercad/viewport";
import { faceAnchor, profileAnchor } from "../lib/anchors";
import { Link2Off } from "lucide-react";
import { evaluate } from "@meercad/model";
import { apply, toast, useApp } from "../store";
import { usePrefs } from "../lib/keymap";
import { parseExpr } from "./ExprInput";
import { ValueInput, type ValueUnit } from "./ValueInput";
import { docUnit, fmtLen, lengthExpr, lengthText } from "../lib/units";
import { t } from "../lib/i18n";
import {
  constraintRefs,
  constraintsOfCurve,
  curveOfFace,
  curveOfPick,
  needsSize,
  pointsOf,
  type SketchCurveRef,
} from "../lib/sketchEdge";
import { pairAngle, quickDimensions } from "../sketch/editor/labels";
import { freshId } from "../sketch/actions";
import { followChipDrag } from "../lib/chipDrag";
import { angleArc, arcPoints, arcRays } from "../lib/angleDim";
import { anchorLine, changedAngle, holdLine, keepLine } from "../lib/angleHold";
import { preloadSolver, solveOnModel } from "../sketch/solveOnModel";
import { angleOf, linePair } from "../sketch/editor/geometry";

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
  /** A measured size that no dimension fixes yet; typing a value adds the dimension. */
  measured?: boolean;
  /** Dragging moves the chip: dropped on `frame`'s plane, it is stored there (sketch coordinates). */
  drag?: { frame: Frame; to: (at: Vec2) => void };
  /** Lines drawn dashed with the value (an angle's arc and rays), in the world. */
  arc?: V3[][];
  commit: (expr: Expr) => void;
}

/** Label text: lengths (" mm") in the design's unit; sketch dimensions ("") without a unit in mm designs. */
const fmt = (expr: Expr, unit = " mm") => {
  if (typeof expr !== "number") return String(expr);
  if (unit === " mm") return fmtLen(expr);
  if (unit === "" && docUnit() === "in") return fmtLen(expr);

  return `${+expr.toFixed(3)}${unit}`;
};

/**
 * The centre of the first face with a tag starting with `prefix` (or, for a copy's mark such as "@lp1.1",
 * ending with it).
 */
function faceCenterByTag(out: RebuildOutput, prefix: string): V3 | null {
  const hit = prefix.startsWith("@")
    ? (x: string) => x.endsWith(prefix)
    : (x: string) => x.startsWith(prefix);

  for (const mesh of out.meshes) {
    const i = mesh.faceTags.findIndex((t) => t.some(hit));
    if (i >= 0) return faceAnchor(mesh, i)?.origin ?? null;
  }

  return null;
}

function featureItems(feature: Feature, out: RebuildOutput): Item[] {
  const edit = (patch: Record<string, unknown>) => apply({ type: "edit_feature", id: feature.id, patch });
  const item = (
    key: string,
    at: V3 | null,
    label: string,
    value: Expr,
    field: string,
    unit = " mm",
  ): Item[] =>
    at
      ? [
          {
            key: `${feature.id}.${key}`,
            at,
            text: `${label}${fmt(value, unit)}`,
            value,
            unit: unit === " mm" ? "mm" : unit === "°" ? "deg" : "",
            suggest: `${feature.op}_${field}`,
            unlinkable: unit === " mm",
            commit: (expr) => edit({ [field]: expr }),
          },
        ]
      : [];

  switch (feature.op) {
    case "extrude": {
      if (feature.extent === "through_all") return [];

      const at =
        faceCenterByTag(out, `${feature.id}.end_cap`) ?? profileAnchor(out, feature.profile)?.origin ?? null;

      return item("distance", at, "↕ ", feature.distance, "distance");
    }
    case "revolve":
      return item("angle", faceCenterByTag(out, `${feature.id}.side[`), "∠ ", feature.angle, "angle", "°");
    case "fillet":
      return item("radius", faceCenterByTag(out, `${feature.id}.round[`), "R ", feature.radius, "radius");
    case "chamfer":
      return item(
        "distance",
        faceCenterByTag(out, `${feature.id}.bevel[`),
        "⌟ ",
        feature.distance,
        "distance",
      );
    case "shell":
      return item(
        "thickness",
        faceCenterByTag(out, `${feature.id}.inner[`),
        "▭ ",
        feature.thickness,
        "thickness",
      );
    case "plane": {
      const p = out.report.planes.find((x) => x.id === feature.id);

      return item("offset", p ? p.frame.origin : null, "⇥ ", feature.offset, "offset");
    }
    case "bend": {
      const info = out.report.features.find((x) => x.id === feature.id)?.info;
      if (!info) return [];

      const c: V3 = [info["cx"]!, info["cy"]!, info["cz"]!];
      const o: V3 = [info["ox"]!, info["oy"]!, info["oz"]!];

      if (feature.mode === "bend") {
        return feature.angle !== undefined || feature.radius === undefined
          ? item("angle", c, "∠ ", feature.angle ?? 90, "angle", "°")
          : item("radius", c, "R ", feature.radius, "radius");
      }

      const items = item("radius", c, "R ", feature.radius ?? 0, "radius");

      // A spiral's gap sits on its outside.
      if (feature.mode === "spiral") {
        items.push(
          ...item(
            "gap",
            c.map((x, i) => x + o[i]! * info["outerRadius"]!) as V3,
            "↔ ",
            feature.gap ?? 1,
            "gap",
          ),
        );
      }

      return items;
    }
    case "linear_pattern":
    case "circular_pattern": {
      const at = faceCenterByTag(out, `@${feature.id}.1`) ?? null;
      const items = item("count", at, "× ", feature.count, "count", "");

      if (feature.op === "linear_pattern" && at) {
        items.push(...item("spacing", [at[0], at[1], at[2] + 6], "↔ ", feature.spacing, "spacing"));
      }

      return items;
    }
    case "box": {
      // The box's outside sizes at its edges: width in front, depth at the side, height on top.
      const b = out.report.bodies.find((x) => x.id === feature.id)?.bbox;
      if (!b) return [];

      const mid = (i: number) => (b.min[i]! + b.max[i]!) / 2;
      const size = (key: string, p: V3, label: string, value: Expr, commit: (expr: Expr) => void): Item => ({
        key: `${feature.id}.${key}`,
        at: p,
        text: `${label}${fmt(value, " mm")}`,
        value,
        unit: "mm",
        suggest: `box_${key}`,
        unlinkable: true,
        commit,
      });
      const round = feature.lid === "screw" || feature.shape === "round";
      const items = [
        size("width", [mid(0), b.min[1]! - 4, b.min[2]!], round ? "⌀ " : "↔ ", feature.width, (width) =>
          edit({ width }),
        ),
      ];

      if (!round) {
        items.push(
          size("depth", [b.max[0]! + 4, mid(1), b.min[2]!], "↕ ", feature.depth ?? feature.width, (depth) =>
            edit({ depth }),
          ),
        );
      }

      items.push(
        size("height", [b.max[0]!, b.min[1]!, b.max[2]!], "↥ ", feature.height, (height) => edit({ height })),
      );

      return items;
    }
    case "wall": {
      // Cells along x and y at the part's box.
      const b = out.report.bodies.find((x) => x.id === feature.id)?.bbox;
      if (!b || feature.accessory === "screw") return [];

      const mid = (i: number) => (b.min[i]! + b.max[i]!) / 2;
      const pairItem = (key: string, p: V3, value: Expr, commit: (expr: Expr) => void): Item => ({
        key: `${feature.id}.${key}`,
        at: p,
        text: `▦ ${fmt(value, "")}`,
        value,
        unit: "",
        suggest: `wall_${key}`,
        unlinkable: false,
        commit,
      });

      return [
        pairItem("units_x", [mid(0), b.min[1]! - 4, b.max[2]!], feature.units[0], (expr) =>
          edit({ units: [expr, feature.units[1]] }),
        ),
        pairItem("units_y", [b.max[0]! + 4, mid(1), b.max[2]!], feature.units[1], (expr) =>
          edit({ units: [feature.units[0], expr] }),
        ),
      ];
    }
    case "gridfinity":
    case "label": {
      // Sizes at the part's box: count of cells (or the label's size) along x and y, a bin's height on top.
      const b = out.report.bodies.find((x) => x.id === feature.id)?.bbox;
      if (!b) return [];

      const mid = (i: number) => (b.min[i]! + b.max[i]!) / 2;
      const at = (x: number, y: number, z: number): V3 => [x, y, z];
      const pairItem = (
        key: string,
        p: V3,
        label: string,
        value: Expr,
        unit: string,
        commit: (expr: Expr) => void,
      ): Item => ({
        key: `${feature.id}.${key}`,
        at: p,
        text: `${label}${fmt(value, unit)}`,
        value,
        unit: unit === " mm" ? "mm" : "",
        suggest: `${feature.op}_${key}`,
        unlinkable: unit === " mm",
        commit,
      });

      if (feature.op === "label") {
        const expr = feature.width ?? 36,
          h = feature.height ?? 11;

        return [
          pairItem("width", at(mid(0), b.min[1]! - 3, b.max[2]!), "↔ ", expr, " mm", (width) =>
            edit({ width }),
          ),
          pairItem("height", at(b.max[0]! + 3, mid(1), b.max[2]!), "↕ ", h, " mm", (height) =>
            edit({ height }),
          ),
        ];
      }

      // A bin sized round its part has no numbers to drag (they follow the part).
      if (feature.drawer || !feature.units) return [];

      const units = feature.units;
      const items = [
        pairItem("units_x", at(mid(0), b.min[1]! - 4, b.min[2]!), "▦ ", units[0], "", (expr) =>
          edit({ units: [expr, units[1]] }),
        ),
        pairItem("units_y", at(b.max[0]! + 4, mid(1), b.min[2]!), "▦ ", units[1], "", (expr) =>
          edit({ units: [units[0], expr] }),
        ),
      ];

      if (feature.kind === "bin") {
        items.push(
          pairItem("height", at(b.max[0]!, b.min[1]!, b.max[2]!), "↕ ", feature.height ?? 3, "", (height) =>
            edit({ height }),
          ),
        );
      }

      return items;
    }
    default:
      return [];
  }
}

type Frame = Parameters<typeof toWorld>[0];

/** A sketch's plane moved along its normal to go through `onto` (where its labels are shown). */
function shiftedFrame(frame: Frame, onto?: V3): Frame {
  if (!onto) return frame;

  const n = frame.normal;
  const o = frame.origin;
  const d = (onto[0] - o[0]) * n[0] + (onto[1] - o[1]) * n[1] + (onto[2] - o[2]) * n[2];

  return { ...frame, origin: [o[0] + n[0] * d, o[1] + n[1] * d, o[2] + n[2] * d] };
}

/** A point of a sketch in the world, slid along the sketch's normal onto the plane through `onto`. */
function placed(frame: Frame, at: Vec2, onto?: V3): V3 {
  return toWorld(shiftedFrame(frame, onto), at);
}

/**
 * Editable dimension labels of a sketch, placed on its plane (or only those of `only`, moved onto
 * `onto`; with `ids` only those constraints).
 */
function sketchItems(
  sketch: SketchFeature,
  out: RebuildOutput,
  only?: Set<string>,
  onto?: V3,
  ids?: Set<string>,
): Item[] {
  const view = out.report.sketches.find((sketchView) => sketchView.id === sketch.id);
  if (!view) return [];

  const pts = new Map(view.points.map(([id, x, y]) => [id, [x, y] as Vec2]));

  const mid = (id: string): Vec2 | null => {
    const curve = view.curves.find((x) => x.id === id);
    if (!curve) return null;
    if (curve.kind === "line") return [(curve.a[0] + curve.b[0]) / 2, (curve.a[1] + curve.b[1]) / 2];
    if (curve.kind === "spline") return curve.pts[Math.floor(curve.pts.length / 2)] ?? null;

    return [curve.center[0] + curve.radius * 0.7, curve.center[1] + curve.radius * 0.7];
  };

  const items: Item[] = [];
  const equalPartners = new Set(
    only
      ? sketch.constraints.flatMap((constraint) =>
          constraint.type === "equal" && (only.has(constraint.a) || only.has(constraint.b))
            ? [constraint.a, constraint.b]
            : [],
        )
      : [],
  );

  for (const constraint of sketch.constraints) {
    if (!("value" in constraint)) continue;

    // Sizes set on an equal partner (e.g. one diameter driving several holes) belong to the shape too.
    const sizedViaEqual =
      (constraint.type === "length" || constraint.type === "radius" || constraint.type === "diameter") &&
      equalPartners.has(constraintRefs(constraint)[0]!);
    if (only && !constraintRefs(constraint).some((r) => only.has(r)) && !sizedViaEqual) continue;
    if (ids && !ids.has(constraint.id)) continue;

    let at: Vec2 | null = constraint.label ?? null;

    if (!at) {
      if (constraint.type === "length") {
        at = mid(constraint.line);
      } else if (constraint.type === "radius" || constraint.type === "diameter") {
        at = mid(constraint.curve);
      } else if (constraint.type === "angle") {
        // Between the two lines, on the arc of the angle (as in the sketch editor).
        const pair = linePair(view, constraint.a, constraint.b);
        const value = typeof constraint.value === "number" ? constraint.value : undefined;
        at = (pair && angleArc(pair[0], pair[1], null, value)?.label) ?? mid(constraint.a);
      } else if (constraint.type === "arc_angle") {
        at = mid(constraint.curve);
      } else if (constraint.type === "distance") {
        const a = pts.get(constraint.a);
        const b = pts.get(constraint.b) ?? mid(constraint.b);
        at = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
      }
    }

    if (!at) continue;

    const prefix = constraint.type === "diameter" ? "⌀ " : constraint.type === "radius" ? "R " : "";

    items.push({
      key: `${sketch.id}.${constraint.id}`,
      // Slid along the sketch normal to the picked face or edge, so the label sits on the model.
      at: placed(view.frame, at, onto),
      ...(constraint.type === "angle" ? { arc: angleLines(constraint, view, onto) } : {}),
      drag: {
        frame: shiftedFrame(view.frame, onto),
        to: (label) => commitLabel(sketch, constraint.id, label),
      },
      unit: constraint.type === "angle" || constraint.type === "arc_angle" ? "deg" : "mm",
      suggest:
        constraint.type === "diameter"
          ? "diameter"
          : constraint.type === "radius"
            ? "radius"
            : constraint.type === "angle" || constraint.type === "arc_angle"
              ? "angle"
              : constraint.type === "length"
                ? "length"
                : "distance",
      text: `${constraint.type === "arc_angle" ? "∠ " : prefix}${fmt(constraint.value, constraint.type === "angle" || constraint.type === "arc_angle" ? "°" : "")}`,
      value: constraint.value,
      unlinkable: constraint.type !== "angle" && constraint.type !== "arc_angle",
      commit: (expr) =>
        commitConstraints(
          sketch,
          out,
          sketch.constraints.map((x) =>
            x.id === constraint.id ? ({ ...x, value: expr } as SketchConstraint) : x,
          ),
        ),
    });
  }

  return items;
}

/**
 * The measured size of a curve no dimension fixes yet (a line's length, a circle's diameter, an arc's
 * radius) at the picked spot; typing a value adds that dimension to the sketch.
 */
function measuredItems(sketch: SketchFeature, out: RebuildOutput, curveId: string, onto: V3): Item[] {
  const view = out.report.sketches.find((sketchView) => sketchView.id === sketch.id);
  const curve = view?.curves.find((x) => x.id === curveId);
  if (!view || !curve) return [];

  const sizeFree = needsSize(sketch, curveId);

  // Sizes, and an arc's sweep (the angle at its centre); a line's slant would only clutter the model.
  return quickDimensions(sketch, curve)
    .filter((quick) => (quick.length ? sizeFree : quick.key === "sweep"))
    .map((quick) => ({
      key: `${sketch.id}.${curveId}.${quick.key}`,
      at: placed(view.frame, quick.at, onto),
      text: quick.text,
      value: +quick.value.toFixed(3),
      unit: quick.length ? ("mm" as const) : ("deg" as const),
      suggest: !quick.length
        ? "angle"
        : curve.kind === "line"
          ? "length"
          : curve.kind === "circle"
            ? "diameter"
            : "radius",
      measured: true,
      commit: (expr: Expr) =>
        apply({
          type: "edit_feature",
          id: sketch.id,
          patch: {
            constraints: [
              ...sketch.constraints,
              { id: freshId(sketch, "c"), ...quick.make(expr) } as SketchConstraint,
            ],
          },
        }),
    }));
}

/** The curves of `sketchId` two picks were made from, or null unless both are of that sketch. */
function linesOf(
  picks: readonly Pick[],
  out: RebuildOutput,
  features: readonly Feature[],
  sketchId: string,
): [string, string] | null {
  const ids = picks.map((x) => curveOfPick(x, out.meshes, features));
  const [a, b] = ids.map((x) => (x?.sketchId === sketchId ? x.curveId : null));

  return a && b && a !== b ? [a, b] : null;
}

/** The angle between two lines of a sketch: its dimension, or the measured angle to fix it. */
function angleItems(
  sketch: SketchFeature,
  out: RebuildOutput,
  [a, b]: [string, string],
  onto: V3,
  label: PairLabel,
): Item[] {
  const view = out.report.sketches.find((x) => x.id === sketch.id);
  if (!view) return [];

  const same = (x: SketchConstraint) =>
    x.type === "angle" && [x.a, x.b].sort().join() === [a, b].sort().join();
  const existing = sketch.constraints.filter(same).map((x) => x.id);
  if (existing.length) return sketchItems(sketch, out, undefined, onto, new Set(existing));

  const key = `${a},${b}`;
  const quick = pairAngle(sketch, view, a, b, label.value?.key === key ? label.value.at : null);
  if (!quick?.angle) return [];

  const world = (points: Vec2[]) => points.map((p) => placed(view.frame, p, onto));

  return [
    {
      key: `${sketch.id}.${a}.${b}.angle`,
      at: placed(view.frame, quick.at, onto),
      text: quick.text,
      value: quick.value,
      unit: "deg",
      suggest: "angle",
      measured: true,
      arc: [
        arcPoints(quick.angle.arc),
        ...arcRays(quick.angle.arc, quick.angle.p, quick.angle.q).map((x) => [x.a, x.b]),
      ].map(world),
      drag: { frame: shiftedFrame(view.frame, onto), to: (at) => label.set({ key, at }) },
      commit: (expr: Expr) =>
        commitConstraints(sketch, out, [
          ...sketch.constraints,
          { id: freshId(sketch, "c"), ...quick.make(expr) } as SketchConstraint,
        ]),
    },
  ];
}

/** The dimensions of one sketch curve behind a picked edge: its own, or its measured size. */
function curveItems(sketch: SketchFeature, out: RebuildOutput, curveId: string, onto: V3): Item[] {
  const own = sketchItems(sketch, out, undefined, onto, constraintsOfCurve(sketch, curveId));

  return [...own, ...measuredItems(sketch, out, curveId, onto)];
}

export function InlineValues({ viewport }: { viewport: Viewport }) {
  const selected = useApp((state) => state.selectedFeature);
  const doc = useApp((state) => state.doc);
  const out = useApp((state) => state.baseOutput);
  const dialog = useApp((state) => state.dialog);
  const sketchId = useApp((state) => state.sketchId);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const [editing, setEditing] = useState<string | null>(null);
  const showValues = usePrefs((prefs) => prefs.showValues);
  const selection = useApp((state) => state.selection);
  const [pairLabel, setPairLabel] = useState<PairLabel["value"]>(null);
  const arcs = useRef<V3[][]>([]);
  arcs.current = [];
  useDashedLines(viewport, arcs);
  useEffect(() => viewport.onChange(tick), [viewport]);
  useEffect(() => preloadSolver(), []);

  // Drag arrows are set up after this renders (by the manipulators); lay out again once they change.
  const handleSig = useRef("");
  useEffect(() => {
    const sig = viewport.handles.map((handle) => handle.id).join();

    if (sig !== handleSig.current) {
      handleSig.current = sig;
      tick();
    }
  });
  if (!out || sketchId || dialog || !selected || !showValues) return null;

  const feature = doc.features.find((x) => x.id === selected);
  if (!feature) return null;

  const items = [...featureItems(feature, out)];
  // Show the driving sketch's dimensions too, so the whole feature can be resized in place.
  const skId =
    feature.op === "sketch"
      ? feature.id
      : (feature.op === "extrude" || feature.op === "revolve") && "sketch" in feature.profile
        ? feature.profile.sketch
        : null;
  const sketch = skId
    ? doc.features.find((x): x is SketchFeature => x.id === skId && x.op === "sketch")
    : undefined;

  // A picked edge (or sketch line) the sketch's curve made shows that curve's dimensions only.
  const pick = selection.length === 1 ? selection[0]! : null;
  const edge = pick ? curveOfPick(pick, out.meshes, doc.features) : null;

  // Two lines (or edges they made) picked together: the angle between them.
  const pair = sketch && selection.length === 2 ? linesOf(selection, out, doc.features, sketch.id) : null;

  if (sketch && pair) {
    items.push(
      ...angleItems(sketch, out, pair, selection[1]!.point, { value: pairLabel, set: setPairLabel }),
    );
  } else if (sketch && edge && fromSketch(edge, feature.id, sketch.id)) {
    if (edge.curveId) items.push(...curveItems(sketch, out, edge.curveId, pick!.point));
  } else if (sketch) {
    // A picked face of the feature narrows this to the dimensions of the shape it came from.
    const face = pick?.kind === "face" ? pick : null;
    const curve = face ? curveOfFace(face.tags, feature.id, sketch.id) : null;

    if (curve && face) {
      const mesh = out.meshes.find((x) => x.bodyId === face.bodyId);
      items.push(
        ...sketchItems(
          sketch,
          out,
          shapeOf(sketch, curve),
          (mesh && faceAnchor(mesh, face.face)?.origin) ?? face.point,
        ),
      );
    } else if (!face) {
      items.push(...sketchItems(sketch, out));
    }
  }

  arcs.current = items.flatMap((item) => item.arc ?? []);

  return (
    <div className="overlay-layer">
      {layoutChips(items, viewport).map(({ it: item, s }) => {
        return (
          <div
            key={item.key}
            className={`value-chip${item.measured ? " quick-dim" : ""}${item.arc ? " pair-angle" : ""}`}
            style={{ left: s[0], top: s[1] }}
            onPointerDown={(event) => {
              event.stopPropagation();

              const drag = item.drag;
              if (!drag || editing === item.key) return;

              followChipDrag(event, (x, y) => {
                const at = viewport.rayToPlane(x, y, drag.frame);
                if (at) drag.to(at);
              });
            }}
          >
            {editing === item.key ? (
              <ValueInput
                value={item.value}
                unit={item.unit}
                suggest={item.suggest}
                onDone={(expr) => (
                  setEditing(null),
                  expr !== null && expr !== item.value && commitKeepingParams(item, expr)
                )}
              />
            ) : (
              <>
                <button onClick={() => setEditing(item.key)} title={t("Click to edit")}>
                  {item.text}
                </button>
                {item.unlinkable && typeof item.value === "string" && isLinked(item.value) ? (
                  <button
                    className="unlink"
                    onClick={() => unlink(item)}
                    title={t("Linked to a variable — click to use a plain number here instead")}
                  >
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
  const overlaps = (a: Box, b: Box) =>
    Math.abs(a.x - b.x) * 2 < a.w + b.w + 6 && Math.abs(a.y - b.y) * 2 < a.h + b.h + 4;
  const placed: Box[] = [];

  // Drag arrows keep their labels where they are; chips make room around them.
  for (const handle of viewport.handles) {
    const t = viewport.handleTipScreen(handle.id);
    if (t) placed.push({ x: t[0] + 16, y: t[1] - 16, w: 90, h: H });
  }

  const out: { it: Item; s: [number, number] }[] = [];

  for (const item of items) {
    const s = viewport.worldToScreen(item.at);
    if (!s) continue;

    const w = item.text.length * 7.4 + 22 + (item.unlinkable && typeof item.value === "string" ? 26 : 0);
    const steps = [0, 1, -1, 2, -2, 3, -3, 4, -4];
    const box = steps
      .map((k) => ({ x: s[0], y: s[1] + k * (H + 4), w, h: H }))
      .find((b) => !placed.some((p) => overlaps(b, p))) ?? { x: s[0], y: s[1], w, h: H };
    placed.push(box);
    out.push({ it: item, s: [box.x, box.y] });
  }

  return out;
}

/** Entity ids of the shape a curve belongs to: everything connected to it through shared points. */
function shapeOf(sketch: SketchFeature, curve: string): Set<string> {
  const ids = new Set([curve]);

  for (let grew = true; grew;) {
    grew = false;

    for (const entity of sketch.entities) {
      const pts = pointsOf(entity);
      const touches = ids.has(entity.id) || pts.some((p) => ids.has(p));
      if (!touches) continue;

      for (const id of [entity.id, ...pts]) if (!ids.has(id)) (ids.add(id), (grew = true));
    }

    // Constraints like midpoint/point_on tie extra points (a rectangle's centre) to the shape.
    for (const constraint of sketch.constraints) {
      if (
        constraint.type !== "midpoint" &&
        constraint.type !== "point_on" &&
        constraint.type !== "coincident" &&
        constraint.type !== "symmetric"
      ) {
        continue;
      }

      const refs = constraintRefs(constraint);

      if (
        refs.some((r) => ids.has(r)) &&
        refs.some((r) => !ids.has(r) && r !== "origin" && !r.startsWith("origin."))
      ) {
        for (const r of refs) {
          if (r !== "origin" && !r.startsWith("origin.") && !ids.has(r)) (ids.add(r), (grew = true));
        }
      }
    }
  }

  return ids;
}

/** True when the picked edge belongs to the selected step and its sketch. */
function fromSketch(edge: SketchCurveRef, featureId: string, sketchId: string): boolean {
  return edge.featureId === featureId && edge.sketchId === sketchId;
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
function unlink(item: Item): void {
  try {
    const n = evaluate(
      item.value,
      new Map(Object.entries(useApp.getState().baseOutput?.report.params ?? {})),
    );
    item.commit(+n.toFixed(4));
    toast(t("Unlinked — this value no longer follows the variable"));
  } catch {
    toast(t("Could not evaluate this value"), "error");
  }
}

function commitKeepingParams(item: Item, expr: Expr): void {
  const params = useApp.getState().doc.params;
  // A plain value typed over a variable changes the variable, not the dimension's link to it.
  const plain = typeof expr === "number" || /^\s*-?\d+(\.\d+)?\s*(mm|in|deg)\s*$/.test(expr);

  if (typeof item.value === "string" && item.value in params && plain) {
    const old = params[item.value]!;
    const unit =
      typeof expr === "number"
        ? typeof old === "string" && /deg\b/.test(old)
          ? " deg"
          : typeof old === "string" && /mm\b/.test(old)
            ? " mm"
            : ""
        : "";
    apply({ type: "set_param", name: item.value, expr: unit ? `${expr}${unit}` : expr });

    return;
  }

  item.commit(expr);
}

/** Quick value field; a `length` is shown and typed in the design's unit. */
export function InlineInput({
  value,
  length,
  onDone,
}: {
  value: Expr;
  length?: boolean;
  onDone: (expr: Expr | null) => void;
}) {
  const initial = length ? lengthText(value) : String(value);
  const [text, setText] = useState(initial);
  const parse = (t: string): Expr | null =>
    !t.trim() || t.trim() === initial ? null : length ? lengthExpr(t) : parseExpr(t);
  const done = useRef(false);

  const finish = (expr: Expr | null) => {
    if (done.current) return;

    done.current = true;
    onDone(expr);
  };

  return (
    <input
      autoFocus
      className="value-input"
      value={text}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => finish(parse(text))}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(parse(text));
        if (event.key === "Escape") finish(null);
      }}
    />
  );
}

/** Puts a sketch dimension's value where it was dragged to (sketch coordinates, 0.01 mm). */
function commitLabel(sketch: SketchFeature, constraintId: string, at: Vec2): void {
  const label: [number, number] = [+at[0].toFixed(2), +at[1].toFixed(2)];

  apply({
    type: "edit_feature",
    id: sketch.id,
    patch: {
      constraints: sketch.constraints.map((x) =>
        x.id === constraintId ? ({ ...x, label } as SketchConstraint) : x,
      ),
    },
  });
}

/**
 * Writes a sketch's changed constraints; a changed angle turns one line only, the other held where
 * it is (lib/angleHold.ts), solved here so the kernel starts from that.
 */
function commitConstraints(sketch: SketchFeature, out: RebuildOutput, constraints: SketchConstraint[]): void {
  const angle = changedAngle(sketch.constraints, constraints);
  const view = out.report.sketches.find((x) => x.id === sketch.id);
  const next = { ...sketch, constraints };
  const keep = angle ? anchorLine(next, angle[0], angle[1]) : null;
  const points = new Map(view?.points.map(([id, x, y]) => [id, [x, y] as Vec2]));
  const solved = keep ? solveOnModel(next, constraints, holdLine(next, keep, points), out) : null;
  const entities = solved && keep ? keepLine(sketch.entities, solved.entities, keep) : undefined;

  apply({
    type: "edit_feature",
    id: sketch.id,
    patch: entities ? { entities, constraints } : { constraints },
  });
}

/** Where the angle chip of two picked lines was dragged (sketch coordinates), and how to change it. */
interface PairLabel {
  value: { key: string; at: Vec2 } | null;
  set: (value: { key: string; at: Vec2 }) => void;
}

/** An angle dimension's arc and rays, in the world (on the plane through `onto`). */
function angleLines(
  constraint: Extract<SketchConstraint, { type: "angle" }>,
  view: RebuildOutput["report"]["sketches"][number],
  onto?: V3,
): V3[][] {
  const angle = angleOf(constraint, view);
  if (!angle) return [];

  const lines = [arcPoints(angle.arc), ...arcRays(angle.arc, angle.p, angle.q).map((x) => [x.a, x.b])];

  return lines.map((points) => points.map((p) => placed(view.frame, p, onto)));
}

/** Draws the lines in `lines` dashed over the model, again whenever they change. */
function useDashedLines(viewport: Viewport, lines: { readonly current: V3[][] }): void {
  const group = useMemo(() => new THREE.Group(), []);
  const drawn = useRef("");

  useEffect(() => {
    viewport.overlay.add(group);

    return () => {
      viewport.overlay.remove(group);
      clearGroup(group);
    };
  }, [viewport, group]);

  useEffect(() => {
    const signature = JSON.stringify(
      lines.current.map((line) => line.map((p) => p.map((x) => +x.toFixed(3)))),
    );
    if (signature === drawn.current) return;

    drawn.current = signature;
    clearGroup(group);

    for (const line of lines.current) group.add(dashedLine(line));

    viewport.invalidate();
  });
}

/** A dashed line through world points, drawn over the model; dashes sized to the line. */
function dashedLine(points: V3[]): THREE.Line {
  const length = points
    .slice(1)
    .reduce((sum, p, i) => sum + Math.hypot(...p.map((x, k) => x - points[i]![k]!)), 0);
  const dash = Math.max(length / 24, 0.05);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p))),
    new THREE.LineDashedMaterial({
      color: ANGLE_COLOR,
      dashSize: dash,
      gapSize: dash * 0.7,
      depthTest: false,
    }),
  );
  line.computeLineDistances();
  line.renderOrder = 30;

  return line;
}

/** Colour of an angle's dashed arc on the model (the accent of the value chips). */
const ANGLE_COLOR = 0x4f46e5;

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    child.removeFromParent();

    const line = child as THREE.Line;
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }
}
