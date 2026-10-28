/**
 * Direct manipulation: drag arrows on the selection to push/pull faces, extrude
 * sketch regions and fillet edges; the same arrows edit distances while a dialog is open.
 */
import { ArrowUpFromLine, Bolt, EyeOff, Link2Off, Grid3x3, Move3d, Pencil, Ruler, Rotate3d, Shell, SquareRoundCorner, SquareSplitHorizontal, Trash, Triangle } from "lucide-react";
import { deleteModelSelection } from "../lib/deletion";
import { keyFor, usePrefs } from "../lib/keymap";
import { toggleHidden } from "./FeatureTree";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { evaluate, nextFeatureId } from "@meercad/model";
import { asArray, type EdgeSelector, type Expr, type Feature } from "@meercad/schema";
import type { Handle, Pick, Viewport } from "@meercad/viewport";
import { cylinderAnchor, isCylinderFace, edgeAnchor, edgeSelectorAnchor, faceAnchor, faceSelectorAnchor, profileAnchor, profileTriangles } from "../lib/anchors";
import { edgeSelectorForPick, faceSelectorForPick, planeSpecForPick } from "../lib/topology";
import { apply, applyQuiet, cancelDialog, commitDialog, currentDoc, holdRebuilds, rebuildIsSlow, rebuilding, startDraft, startFeature, startSketch, updateDraft, useApp } from "../store";
import { InlineInput } from "./InlineValues";
import { docUnit, fmtLen, lengthValue } from "../lib/units";
import { Kbd } from "./Kbd";

const num = (e: Expr | undefined, fallback = 0): number => {
  if (e === undefined) return fallback;
  try {
    return evaluate(e, new Map(Object.entries(useApp.getState().baseOutput?.report.params ?? {})));
  } catch {
    return fallback;
  }
};

/** What ties a hole's size to others (variable, equal constraints), and how to cut that tie. */
const holeLinks = new Map<string, { what: string; unlink: () => void } | null>();

export function Manipulators({ viewport }: { viewport: Viewport }) {
  const dialog = useApp((s) => s.dialog);
  const selection = useApp((s) => s.selection);
  const base = useApp((s) => s.baseOutput);
  const sketchId = useApp((s) => s.sketchId);
  const measure = useApp((s) => s.measure.active);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  /** Push/pull drafts follow the drag direction (out = add, in = remove). */
  const autoMode = useRef(false);
  /** Where a push/pull was grabbed, so the arrow stays at the clicked spot once its feature dialog opens. */
  const grabbed = useRef<{ feature: string; origin: V3; dir: V3 } | null>(null);

  useEffect(() => {
    const label = (id: string, v: number) =>
      id === "edge"
        ? v >= 0
          ? `Fillet R ${fmtLen(v)}`
          : `Chamfer ${fmtLen(-v)}`
        : id === "fillet"
          ? `R ${fmtLen(v)}`
          : id === "hole"
            ? `Ø ${fmtLen(2 * v)}`
            : fmtLen(v);
    viewport.onHandleDrag = (h, v, screen) => setTip(h && screen ? { x: screen[0], y: screen[1], text: label(h.id, v) } : null);
    return () => {
      viewport.onHandleDrag = null;
    };
  }, [viewport]);

  useEffect(() => {
    viewport.setHandles(sketchId || measure || !base ? [] : computeHandles().map(slowDrag));
  });

  // The push/pull stand-in goes once the kernel has caught up with the last value.
  const output = useApp((s) => s.output);
  const previewError = useApp((s) => s.previewError);
  useEffect(() => {
    if (!slow.current && !rebuilding()) viewport.setGhost(null);
  }, [viewport, output, previewError, dialog]);
  useEffect(() => () => viewport.setGhost(null), [viewport]);

  /**
   * Where rebuilds are slow (a big part on an iPad), a drag does not feed the kernel every value:
   * it rebuilds where the pen rests and on release, and a push/pull shows an instant stand-in.
   */
  const slow = useRef<{ timer: number; ghost: ReturnType<typeof profileTriangles> } | null>(null);
  function slowDrag(h: Handle): Handle {
    return {
      ...h,
      onStart: () => {
        if (rebuildIsSlow()) {
          holdRebuilds(true);
          slow.current = { timer: 0, ghost: null };
        }
        h.onStart?.();
      },
      onDrag: (v) => {
        h.onDrag(v);
        const s = slow.current;
        if (!s) return;
        const { dialog: d, baseOutput: b } = useApp.getState();
        if (h.id === "extrude" && d?.feature.op === "extrude" && b) {
          s.ghost ??= profileTriangles(b, d.feature.profile);
          if (s.ghost) viewport.setGhost({ ...s.ghost, distance: v });
        }
        window.clearTimeout(s.timer);
        s.timer = window.setTimeout(() => {
          holdRebuilds(false);
          holdRebuilds(true);
        }, 400);
      },
      onEnd: (v) => {
        const s = slow.current;
        slow.current = null;
        if (s) window.clearTimeout(s.timer);
        h.onEnd(v);
        if (s) holdRebuilds(false);
      },
    };
  }

  function extrudePatch(v: number): Partial<Feature> {
    const patch: Record<string, unknown> = { distance: Math.abs(v) || 0.001, flip: v < 0 ? true : undefined };
    if (autoMode.current) patch["mode"] = v < 0 ? "cut" : base!.report.bodies.length ? "join" : "new_body";
    return patch as Partial<Feature>;
  }

  function computeHandles(): Handle[] {
    const out = base!;
    const d = dialog;
    if (d) {
      const f = d.feature;
      if (f.op === "extrude" && f.extent !== "through_all") {
        const a = profileAnchor(out, f.profile);
        if (!a) return [];
        const value = num(f.distance, 10) * (f.flip ? -1 : 1);
        const g = grabbed.current?.feature === f.id ? grabbed.current : null;
        return [
          {
            id: "extrude",
            origin: g?.origin ?? a.origin,
            dir: g?.dir ?? a.normal,
            value,
            onDrag: (v) => updateDraft(extrudePatch(v)),
            onEnd: () => undefined,
          },
        ];
      }
      if ((f.op === "fillet" || f.op === "chamfer") && asArray(f.edges).length) {
        const a = edgeSelectorAnchor(out, asArray(f.edges)[0] as EdgeSelector);
        if (!a) return [];
        return [
          {
            id: "fillet",
            origin: a.origin,
            dir: a.dir,
            value: num(f.op === "fillet" ? f.radius : f.distance, 1),
            min: 0.05,
            onDrag: (v) => updateDraft(f.op === "fillet" ? { radius: v } : { distance: v }),
            onEnd: () => undefined,
          },
        ];
      }
      if (f.op === "transform" && f.bodies[0]) {
        const t = (f.translate ?? [0, 0, 0]).map((e) => num(e, 0)) as [number, number, number];
        const c = bodyCenter(out, f.bodies[0]);
        if (!c) return [];
        // The base output may already include this move when editing it: anchor at the original spot.
        const origin = (d.isNew ? c : c.map((v, i) => v - t[i]!)) as [number, number, number];
        return moveHandles(origin, t, (i, v) => updateDraft((g) => ({ ...g, translate: (((g as Extract<Feature, { op: "transform" }>).translate ?? [0, 0, 0]).map((x, j) => (j === i ? v : x))) as [Expr, Expr, Expr] }) as Feature), () => undefined);
      }
      if (f.op === "shell" && f.faces[0]) {
        const a = faceSelectorAnchor(out, f.faces[0]);
        if (!a) return [];
        return [{ id: "shell", origin: a.origin, dir: a.normal.map((x) => -x) as typeof a.normal, value: num(f.thickness, 2), min: 0.05, onDrag: (v) => updateDraft({ thickness: v }), onEnd: () => undefined }];
      }
      return [];
    }
    const sel = selection;
    // A whole part is selected (double-click): show move arrows along X/Y/Z.
    const bodyIds = new Set(sel.map((p) => (p.kind === "face" ? p.bodyId : null)));
    const whole = sel.length > 1 && bodyIds.size === 1 && !bodyIds.has(null) && out.meshes.find((m) => m.bodyId === [...bodyIds][0])?.faceTags.length === sel.length;
    if (whole) {
      const bodyId = [...bodyIds][0]!;
      const c = bodyCenter(out, bodyId);
      if (!c) return [];
      return moveHandles(c, [0, 0, 0], (i, v) => updateDraft((g) => ({ ...g, translate: [0, 1, 2].map((j) => (j === i ? v : 0)) as [Expr, Expr, Expr] }) as Feature), (v) => finish(v), () => startDraft({ id: nextFeatureId(currentDoc(), "transform"), op: "transform", bodies: [bodyId], translate: [0, 0, 0] }));
    }
    if (sel.length === 1 && sel[0]!.kind === "face") {
      const hole = holeHandle(out, sel[0]! as Extract<Pick, { kind: "face" }>);
      if (hole) return [hole];
    }
    if (sel.length === 1 && sel[0]!.kind === "face") {
      const p = sel[0]!;
      const m = out.meshes.find((x) => x.bodyId === p.bodyId);
      const a = m ? faceAnchor(m, p.face) : null;
      const fs = faceSelectorForPick(p, out.meshes);
      if (!a || !fs) return [];
      // A flat face moves along its normal; a curved one grows or shrinks along the surface, so the
      // arrow points straight out of it at the clicked spot.
      const origin = p.normal ? onPlane(p.point, a.origin, a.normal) : p.point;
      const dir = p.normal ? a.normal : (p.surface ?? a.normal);
      return [
        {
          id: "extrude",
          origin,
          dir,
          value: 0,
          onStart: () => {
            autoMode.current = true;
            const id = nextFeatureId(currentDoc(), "extrude");
            grabbed.current = { feature: id, origin, dir };
            startDraft({ id, op: "extrude", profile: { face: fs }, extent: "blind", distance: 0.001, mode: "join" });
          },
          onDrag: (v) => updateDraft(extrudePatch(v)),
          onEnd: (v) => finish(v),
        },
      ];
    }
    if (sel.length === 1 && sel[0]!.kind === "region") {
      const p = sel[0]!;
      const sk = out.report.sketches.find((s) => s.id === p.sketchId);
      if (!sk) return [];
      const a = profileAnchor(out, { sketch: p.sketchId, regions: [p.key] });
      if (!a) return [];
      const origin = onPlane(p.point, a.origin, a.normal);
      return [
        {
          id: "extrude",
          origin,
          dir: a.normal,
          value: 0,
          onStart: () => {
            autoMode.current = true;
            const id = nextFeatureId(currentDoc(), "extrude");
            grabbed.current = { feature: id, origin, dir: a.normal };
            startDraft({ id, op: "extrude", profile: { sketch: p.sketchId, regions: [p.key] }, extent: "blind", distance: 0.001, mode: out.report.bodies.length ? "join" : "new_body" });
          },
          onDrag: (v) => updateDraft(extrudePatch(v)),
          onEnd: (v) => finish(v),
        },
      ];
    }
    const edges = sel.filter((p) => p.kind === "edge");
    if (edges.length && edges.length === sel.length) {
      const first = edges[0]! as Extract<Pick, { kind: "edge" }>;
      const m = out.meshes.find((x) => x.bodyId === first.bodyId);
      const sels = edges.map((p) => edgeSelectorForPick(p, out.meshes)).filter((x): x is EdgeSelector => !!x);
      const a = m ? edgeAnchor(m, first.edge) : null;
      if (!a || !sels.length) return [];
      // Out along the bisector rounds the edge, in towards the material bevels it.
      const ids = { fillet: nextFeatureId(currentDoc(), "fillet"), chamfer: nextFeatureId(currentDoc(), "chamfer") };
      return [
        {
          id: "edge",
          origin: a.origin,
          dir: a.dir,
          value: 0,
          onStart: () => {
            autoMode.current = false;
            startDraft({ id: ids.fillet, op: "fillet", edges: sels, radius: 0.05 });
          },
          onDrag: (v) =>
            updateDraft(() =>
              v >= 0 ? { id: ids.fillet, op: "fillet", edges: sels, radius: Math.max(0.05, v) } : { id: ids.chamfer, op: "chamfer", edges: sels, distance: Math.max(0.05, -v) },
            ),
          onEnd: (v) => finish(v),
        },
      ];
    }
    return [];
  }

  /**
   * The round wall of a hole or boss (a face extruded from a sketch circle) gets a radial arrow:
   * dragging it changes the circle's diameter/radius dimension, the variable behind it, or the
   * circle itself when it has no dimension.
   */
  function holeHandle(out: NonNullable<typeof base>, pick: Extract<Pick, { kind: "face" }>): Handle | null {
    holeLinks.delete("hole");
    for (const tag of pick.tags ?? []) {
      const m = /^[\w-]+\.side\[([\w-]+)\.([\w-]+)\]/.exec(tag);
      if (!m) continue;
      const [, sketchId, curveId] = m as unknown as [string, string, string];
      const doc = currentDoc();
      const sk = doc.features.find((f): f is Extract<Feature, { op: "sketch" }> => f.id === sketchId && f.op === "sketch");
      const view = out.report.sketches.find((s) => s.id === sketchId);
      const curve = view?.curves.find((c) => c.id === curveId);
      if (!sk || !view || curve?.kind !== "circle") continue;
      const { origin: o, u, v } = view.frame;
      // Measure the selected wall itself: pattern and mirror copies sit elsewhere than the sketch circle.
      const mesh = out.meshes.find((x) => x.bodyId === pick.bodyId);
      const cyl = mesh ? cylinderAnchor(mesh, pick.face, view.frame.normal, u) : null;
      const center = cyl?.top ?? ([0, 1, 2].map((i) => o[i]! + u[i]! * curve.center[0] + v[i]! * curve.center[1]) as [number, number, number]);
      const radial = cyl?.dir ?? u;
      // A circle made Equal to another has no size of its own: the dimension on any circle in its
      // Equal group drives it, so that is what the arrow changes.
      const group = new Set([curveId]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const c of sk.constraints) {
          if (c.type !== "equal" || !(group.has(c.a) || group.has(c.b)) || (group.has(c.a) && group.has(c.b))) continue;
          group.add(c.a).add(c.b);
          grew = true;
        }
      }
      const dim = (sk.constraints.find((c) => (c.type === "radius" || c.type === "diameter") && c.curve === curveId) ??
        sk.constraints.find((c) => (c.type === "radius" || c.type === "diameter") && group.has(c.curve))) as { id: string; type: "radius" | "diameter"; curve: string; value: Expr } | undefined;
      const params = doc.params;
      const write = (r: number, quiet: boolean) => {
        const run = quiet ? applyQuiet : apply;
        const value = +(dim?.type === "diameter" ? 2 * r : r).toFixed(3);
        if (dim && typeof dim.value === "string" && dim.value in params) {
          const old = params[dim.value];
          // An inch design writes inches; a mm design keeps the variable's "mm" (or a bare number).
          const expr = docUnit() === "in" ? lengthValue(value, "in") : typeof old === "string" && /mm\b/.test(old) ? `${value} mm` : value;
          return run({ type: "set_param", name: dim.value, expr });
        }
        const latest = currentDoc().features.find((f) => f.id === sketchId) as typeof sk;
        return run({
          type: "edit_feature",
          id: sketchId,
          patch: dim
            ? { constraints: latest.constraints.map((c) => (c.id === dim.id ? ({ ...c, value } as typeof c) : c)) }
            : { entities: latest.entities.map((e) => (group.has(e.id) && e.type === "circle" ? { ...e, radius: +r.toFixed(3) } : e)) },
        });
      };
      const equal = sk.constraints.filter((c) => c.type === "equal" && (("a" in c && c.a === curveId) || ("b" in c && c.b === curveId)));
      const byVar = dim && typeof dim.value === "string" && Object.keys(params).some((n) => new RegExp(`\\b${n}\\b`).test(dim.value as string));
      holeLinks.set("hole", byVar || equal.length ? {
        what: [byVar ? `the variable "${dim!.value}"` : null, equal.length ? `${equal.length === 1 ? "another circle" : `${equal.length} other circles`} (Equal)` : null].filter(Boolean).join(" and "),
        unlink: () => {
          const latest = currentDoc().features.find((f) => f.id === sketchId) as typeof sk;
          const r = curve.radius;
          apply({
            type: "edit_feature",
            id: sketchId,
            patch: {
              constraints: latest.constraints
                .filter((c) => !equal.some((e) => e.id === c.id))
                // Only this circle's own dimension is frozen; one on another circle of the group stays as it is.
                .map((c) => (dim && c.id === dim.id && dim.curve === curveId ? ({ ...c, value: +(dim.type === "diameter" ? 2 * r : r).toFixed(3) } as typeof c) : c)),
            },
          });
        },
      } : null);
      return {
        id: "hole",
        origin: center,
        dir: radial,
        value: curve.radius,
        min: 0.05,
        onStart: () => void write(curve.radius, false),
        onDrag: (r) => void write(r, true),
        onEnd: () => undefined,
      };
    }
    return null;
  }

  function moveHandles(origin: [number, number, number], t: [number, number, number], drag: (axis: number, v: number) => void, end: (v: number) => void, start?: () => void): Handle[] {
    const dirs: [number, number, number][] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const colors = [0xe5484d, 0x30a46c, 0x3e63dd];
    return dirs.map((dir, i) => ({
      id: `move-${"xyz"[i]}`,
      color: colors[i]!,
      // Three axis arrows already read as "move"; double heads would only clutter the gizmo.
      twoWay: false,
      origin,
      dir,
      value: t[i]!,
      ...(start ? { onStart: start } : {}),
      onDrag: (v: number) => drag(i, v),
      onEnd: end,
    }));
  }

  function finish(v: number): void {
    autoMode.current = false;
    if (Math.abs(v) < 1e-6) return cancelDialog();
    commitDialog();
  }

  return (
    <>
      <HandleLabels viewport={viewport} />
      {tip ? (
        <div className="cursor-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      ) : null}
      {!dialog && !sketchId && !measure && selection.length ? <QuickActions selection={selection} /> : null}
    </>
  );
}


/** Floating action bar next to the selection, with the shortcut of every action. */
/** Actions for the current selection, docked at the bottom so they never cover a drag arrow. */
function QuickActions({ selection }: { selection: Pick[] }) {
  usePrefs((s) => s.keys);
  const last = selection.at(-1)!;
  const meshes = useApp.getState().output?.meshes ?? [];
  const kinds = new Set(selection.map((p) => p.kind));
  const actions: { icon: ReactNode; label: string; kbd?: string | undefined; run: () => void }[] = [];
  const partIds = new Set(selection.map((p) => (p.kind === "face" ? p.bodyId : "")));
  const wholePart = selection.length > 1 && partIds.size === 1 && !partIds.has("") && meshes.find((m) => m.bodyId === [...partIds][0])?.faceTags.length === selection.length;
  if (wholePart) {
    actions.push({ icon: <Move3d />, label: "Move", kbd: keyFor("transform"), run: () => startFeature("transform") });
    actions.push({ icon: <SquareSplitHorizontal />, label: "Mirror", kbd: keyFor("mirror"), run: () => startFeature("mirror") });
    actions.push({ icon: <Grid3x3 />, label: "Pattern", kbd: keyFor("linear_pattern"), run: () => startFeature("linear_pattern") });
    actions.push({ icon: <EyeOff />, label: "Hide", run: () => toggleHidden([...partIds][0]!) });
  } else if (kinds.size === 1 && kinds.has("face")) {
    const plane = planeSpecForPick(last, meshes);
    if (plane && selection.length === 1) actions.push({ icon: <Pencil />, label: "Sketch", kbd: keyFor("sketch"), run: () => startSketch(plane) });
    if (selection.length === 1 && last.kind === "face") actions.push({ icon: <ArrowUpFromLine />, label: "Push/Pull", kbd: "drag", run: () => startFeature("extrude") });
    actions.push({ icon: <SquareRoundCorner />, label: "Fillet", kbd: keyFor("fillet"), run: () => startFeature("fillet") });
    actions.push({ icon: <Triangle />, label: "Chamfer", kbd: keyFor("chamfer"), run: () => startFeature("chamfer") });
    actions.push({ icon: <Shell />, label: "Shell", kbd: keyFor("shell"), run: () => startFeature("shell") });
    const lastMesh = last.kind === "face" ? meshes.find((m) => m.bodyId === last.bodyId) : undefined;
    if (selection.length === 1 && last.kind === "face" && lastMesh && isCylinderFace(lastMesh, last.face)) actions.push({ icon: <Bolt />, label: "Thread", kbd: keyFor("thread"), run: () => startFeature("thread") });
  } else if (kinds.size === 1 && kinds.has("edge")) {
    actions.push({ icon: <SquareRoundCorner />, label: "Fillet", kbd: keyFor("fillet"), run: () => startFeature("fillet") });
    actions.push({ icon: <Triangle />, label: "Chamfer", kbd: keyFor("chamfer"), run: () => startFeature("chamfer") });
  } else if (kinds.has("region") || kinds.has("sketch_curve")) {
    actions.push({ icon: <ArrowUpFromLine />, label: "Extrude", kbd: keyFor("extrude"), run: () => startFeature("extrude") });
    actions.push({ icon: <Rotate3d />, label: "Revolve", kbd: keyFor("revolve"), run: () => startFeature("revolve") });
  } else if (kinds.has("plane") && selection.length === 1 && last.kind === "plane") {
    actions.push({ icon: <Pencil />, label: "Sketch", kbd: keyFor("sketch"), run: () => startSketch({ ref: last.planeId }) });
  }
  if (kinds.has("face") || kinds.has("edge")) actions.push({ icon: <Ruler />, label: "Measure", kbd: keyFor("measure"), run: () => useApp.setState({ measure: { active: true, picks: selection.slice(-2), result: null } }) });
  // Without a keyboard there is no Delete key.
  if ((kinds.has("face") || kinds.has("edge")) && matchMedia("(pointer: coarse)").matches) actions.push({ icon: <Trash />, label: "Delete", run: () => void deleteModelSelection() });
  if (!actions.length) return null;
  return (
    <div className="quick-actions docked" onPointerDown={(e) => e.stopPropagation()}>
      {actions.map((a) => (
        <button key={a.label} className="qa" onClick={a.run} title={`${a.label}${a.kbd ? ` (${a.kbd})` : ""}`}>
          {a.icon}
          <span>{a.label}</span>
          {a.kbd ? <Kbd k={a.kbd} /> : null}
        </button>
      ))}
    </div>
  );
}

/** The value at each drag arrow; click it to type an exact value. */
function HandleLabels({ viewport }: { viewport: Viewport }) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const [typing, setTyping] = useState<string | null>(null);
  useEffect(() => viewport.onChange(tick), [viewport]);
  useEffect(() => {
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, []);
  const showValues = usePrefs((s) => s.showValues);
  const handles = (viewport as unknown as { handles: Handle[] }).handles ?? [];
  if (viewport.draggingHandle || !showValues) return null;
  return (
    <div className="overlay-layer">
      {handles.map((h) => {
        const s = viewport.handleTipScreen(h.id);
        if (!s) return null;
        // Hole handles carry the radius but show and take the diameter.
        const scale = h.id === "hole" ? 2 : 1;
        const shown = +(h.value * scale).toFixed(4);
        const text = h.id === "edge" ? "drag: out = fillet, in = chamfer" : `${h.id === "hole" ? "Ø " : ""}${fmtLen(shown)}`;
        return (
          <div key={h.id} className="value-chip handle-chip" style={{ left: s[0] + 16, top: s[1] - 16 }} onPointerDown={(e) => e.stopPropagation()}>
            {typing === h.id ? (
              <InlineInput
                value={shown}
                length
                onDone={(v) => {
                  setTyping(null);
                  if (v === null) return;
                  const n = num(v, NaN) / scale;
                  if (!Number.isFinite(n)) return;
                  h.onStart?.();
                  h.onDrag(n);
                  h.onEnd(n);
                }}
              />
            ) : (
              <>
                <button onClick={() => setTyping(h.id)} title="Click to type a value">
                  {text}
                </button>
                {holeLinks.get(h.id) ? (
                  <button className="unlink" onClick={() => holeLinks.get(h.id)!.unlink()} title={`Changes together with ${holeLinks.get(h.id)!.what}. Click to change only this hole.`}>
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

function bodyCenter(out: { report: { bodies: { id: string; bbox: { min: number[]; max: number[] } }[] } }, id: string): [number, number, number] | null {
  const b = out.report.bodies.find((x) => x.id === id);
  return b ? ([0, 1, 2].map((i) => (b.bbox.min[i]! + b.bbox.max[i]!) / 2) as [number, number, number]) : null;
}

type V3 = [number, number, number];

/** The clicked spot moved onto the face's plane (box-selected faces carry a corner instead of a click). */
function onPlane(point: V3, origin: V3, n: V3): V3 {
  const d = (point[0] - origin[0]) * n[0] + (point[1] - origin[1]) * n[1] + (point[2] - origin[2]) * n[2];
  return [point[0] - n[0] * d, point[1] - n[1] * d, point[2] - n[2] * d];
}
