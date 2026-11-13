/**
 * Direct manipulation: drag arrows on the selection to push/pull faces, extrude
 * sketch regions and fillet edges; the same arrows edit distances while a dialog is open.
 */
import {
  ArrowUpFromLine,
  Bolt,
  Cone,
  EyeOff,
  Link2Off,
  Grid3x3,
  Move3d,
  Pencil,
  Ruler,
  Rotate3d,
  Shell,
  Spline,
  SquareRoundCorner,
  SquareSplitHorizontal,
  Trash,
  Triangle,
} from "lucide-react";
import { deleteModelSelection } from "../lib/deletion";
import { joinedParts } from "../lib/mechanism";
import { keyFor, usePrefs } from "../lib/keymap";
import { toggleHidden } from "./FeatureTree";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { evaluate, nextFeatureId } from "@meercad/model";
import { asArray, type EdgeSelector, type Expr, type Feature } from "@meercad/schema";
import type { Handle, Pick, Viewport } from "@meercad/viewport";
import {
  cylinderAnchor,
  isCylinderFace,
  edgeAnchor,
  edgeSelectorAnchor,
  faceAnchor,
  faceSelectorAnchor,
  profileAnchor,
  profileTriangles,
} from "../lib/anchors";
import { edgeSelectorForPick, faceSelectorForPick, planeSpecForPick } from "../lib/topology";
import {
  apply,
  applyQuiet,
  cancelDialog,
  commitDialog,
  currentDoc,
  holdRebuilds,
  rebuildIsSlow,
  rebuilding,
  startDraft,
  startFeature,
  startSketch,
  updateDraft,
  useApp,
} from "../store";
import { InlineInput } from "./InlineValues";
import { docUnit, fmtLen, lengthValue } from "../lib/units";
import { Kbd } from "./Kbd";
import { bendInfo } from "../lib/bend";
import { capDrag } from "../lib/capDrag";
import { t } from "../lib/i18n";

const num = (expr: Expr | undefined, fallback = 0): number => {
  if (expr === undefined) return fallback;

  try {
    return evaluate(expr, new Map(Object.entries(useApp.getState().baseOutput?.report.params ?? {})));
  } catch {
    return fallback;
  }
};

/** What ties a hole's size to others (variable, equal constraints), and how to cut that tie. */
const holeLinks = new Map<string, { what: string; unlink: () => void } | null>();

export function Manipulators({ viewport }: { viewport: Viewport }) {
  const dialog = useApp((state) => state.dialog);
  const selection = useApp((state) => state.selection);
  const base = useApp((state) => state.baseOutput);
  const sketchId = useApp((state) => state.sketchId);
  const measure = useApp((state) => state.measure.active);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  /** Push/pull drafts follow the drag direction (out = add, in = remove). */
  const autoMode = useRef(false);
  /** Where a push/pull was grabbed, so the arrow stays at the clicked spot once its feature dialog opens. */
  const grabbed = useRef<{ feature: string; origin: V3; dir: V3 } | null>(null);

  useEffect(() => {
    const label = (id: string, v: number) =>
      id === "edge"
        ? v >= 0
          ? t("Fillet R {value}", { value: fmtLen(v) })
          : t("Chamfer {value}", { value: fmtLen(-v) })
        : id === "fillet" || id === "bend"
          ? `R ${fmtLen(v)}`
          : id === "hole"
            ? `Ø ${fmtLen(2 * v)}`
            : fmtLen(v);
    viewport.onHandleDrag = (handle, v, screen) =>
      setTip(handle && screen ? { x: screen[0], y: screen[1], text: label(handle.id, v) } : null);

    return () => {
      viewport.onHandleDrag = null;
    };
  }, [viewport]);

  useEffect(() => {
    viewport.setHandles(sketchId || measure || !base ? [] : computeHandles().map(slowDrag));
  });

  // The push/pull stand-in goes once the kernel has caught up with the last value.
  const output = useApp((state) => state.output);
  const previewError = useApp((state) => state.previewError);
  useEffect(() => {
    if (!slow.current && !rebuilding()) viewport.setGhost(null);
  }, [viewport, output, previewError, dialog]);
  useEffect(() => () => viewport.setGhost(null), [viewport]);

  /**
   * Where rebuilds are slow (a big part on an iPad), a drag does not feed the kernel every value:
   * it rebuilds where the pen rests and on release, and a push/pull shows an instant stand-in.
   */
  const slow = useRef<{ timer: number; ghost: ReturnType<typeof profileTriangles> } | null>(null);

  function slowDrag(handle: Handle): Handle {
    return {
      ...handle,
      onStart: () => {
        if (rebuildIsSlow()) {
          holdRebuilds(true);
          slow.current = { timer: 0, ghost: null };
        }

        handle.onStart?.();
      },
      onDrag: (v) => {
        handle.onDrag(v);

        const s = slow.current;
        if (!s) return;

        const { dialog: dialog, baseOutput: b } = useApp.getState();

        if (handle.id === "extrude" && dialog?.feature.op === "extrude" && b) {
          s.ghost ??= profileTriangles(b, dialog.feature.profile);
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

        handle.onEnd(v);
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
      const feature = d.feature;

      if (feature.op === "extrude" && feature.extent !== "through_all") {
        const a = profileAnchor(out, feature.profile);
        if (!a) return [];

        const value = num(feature.distance, 10) * (feature.flip ? -1 : 1);
        const g = grabbed.current?.feature === feature.id ? grabbed.current : null;

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

      if ((feature.op === "fillet" || feature.op === "chamfer") && asArray(feature.edges).length) {
        const a = edgeSelectorAnchor(out, asArray(feature.edges)[0] as EdgeSelector);
        if (!a) return [];

        return [
          {
            id: "fillet",
            origin: a.origin,
            dir: a.dir,
            value: num(feature.op === "fillet" ? feature.radius : feature.distance, 1),
            min: 0.05,
            onDrag: (v) => updateDraft(feature.op === "fillet" ? { radius: v } : { distance: v }),
            onEnd: () => undefined,
          },
        ];
      }

      if (feature.op === "transform" && feature.bodies[0]) {
        const t = (feature.translate ?? [0, 0, 0]).map((expr) => num(expr, 0)) as [number, number, number];
        const c = bodyCenter(out, feature.bodies[0]);
        if (!c) return [];

        // The base output may already include this move when editing it: anchor at the original spot.
        const origin = (d.isNew ? c : c.map((v, i) => v - t[i]!)) as [number, number, number];

        return moveHandles(
          origin,
          t,
          (i, v) =>
            updateDraft(
              (feature) =>
                ({
                  ...feature,
                  translate: ((feature as Extract<Feature, { op: "transform" }>).translate ?? [0, 0, 0]).map(
                    (x, j) => (j === i ? v : x),
                  ) as [Expr, Expr, Expr],
                }) as Feature,
            ),
          () => undefined,
        );
      }

      if (feature.op === "bend") {
        // One arrow for the radius: a spiral's from its centre to where it starts; a bend's or a
        // ring's from the middle of the part (which stays put) towards the centre.
        const info = bendInfo(useApp.getState().output, feature.id);
        if (!info) return [];

        const c: V3 = [info["cx"]!, info["cy"]!, info["cz"]!];
        const o: V3 = [info["ox"]!, info["oy"]!, info["oz"]!];
        const r = info["radius"]!;

        if (feature.mode === "spiral") {
          return [
            {
              id: "bend",
              origin: c,
              dir: o,
              value: r,
              min: 0.5,
              onDrag: (v) => updateDraft({ radius: +v.toFixed(2) }),
              onEnd: () => undefined,
            },
          ];
        }

        const len = info["length"]!,
          half = info["thickness"]! / 2;

        return [
          {
            id: "bend",
            origin: c.map((x, i) => x + o[i]! * r) as V3,
            dir: o.map((x) => -x) as V3,
            value: r,
            min:
              feature.mode === "bend"
                ? Math.max(half * 1.05, len / (2 * Math.PI))
                : Math.max(0.5, len / (2 * Math.PI)),
            onDrag: (v) =>
              updateDraft(
                feature.mode === "bend"
                  ? { angle: +Math.min(360, (len / v) * (180 / Math.PI)).toFixed(1), radius: undefined }
                  : { radius: +v.toFixed(2) },
              ),
            onEnd: () => undefined,
          },
        ];
      }

      if (feature.op === "shell" && feature.faces[0]) {
        const a = faceSelectorAnchor(out, feature.faces[0]);
        if (!a) return [];

        return [
          {
            id: "shell",
            origin: a.origin,
            dir: a.normal.map((x) => -x) as typeof a.normal,
            value: num(feature.thickness, 2),
            min: 0.05,
            onDrag: (v) => updateDraft({ thickness: v }),
            onEnd: () => undefined,
          },
        ];
      }

      return [];
    }

    const sel = selection;
    // A whole part is selected (double-click): show move arrows along X/Y/Z.
    const bodyIds = new Set(sel.map((pick) => (pick.kind === "face" ? pick.bodyId : null)));
    const whole =
      sel.length > 1 &&
      bodyIds.size === 1 &&
      !bodyIds.has(null) &&
      out.meshes.find((mesh) => mesh.bodyId === [...bodyIds][0])?.faceTags.length === sel.length;

    if (whole) {
      const bodyId = [...bodyIds][0]!;
      const c = bodyCenter(out, bodyId);
      if (!c) return [];

      return moveHandles(
        c,
        [0, 0, 0],
        (i, v) =>
          updateDraft(
            (feature) =>
              ({
                ...feature,
                translate: [0, 1, 2].map((j) => (j === i ? v : 0)) as [Expr, Expr, Expr],
              }) as Feature,
          ),
        (v) => finish(v),
        () =>
          startDraft({
            id: nextFeatureId(currentDoc(), "transform"),
            op: "transform",
            bodies: joinedParts(bodyId),
            translate: [0, 0, 0],
          }),
      );
    }

    if (sel.length === 1 && sel[0]!.kind === "face") {
      const hole = holeHandle(out, sel[0]! as Extract<Pick, { kind: "face" }>);
      if (hole) return [hole];
    }

    if (sel.length === 1 && sel[0]!.kind === "face") {
      const p = sel[0]!;
      const mesh = out.meshes.find((x) => x.bodyId === p.bodyId);
      const a = mesh ? faceAnchor(mesh, p.face) : null;
      const fs = faceSelectorForPick(p, out.meshes);
      if (!a || !fs) return [];

      // A flat face moves along its normal; a curved one grows or shrinks along the surface, so the
      // arrow points straight out of it at the clicked spot.
      const origin = p.normal ? onPlane(p.point, a.origin, a.normal) : p.point;
      const dir = p.normal ? a.normal : (p.surface ?? a.normal);
      // The end face of an extrusion: the drag changes its distance (or the variable behind it),
      // so what was cut through the part later still goes through.
      const cap = p.normal ? capDrag(currentDoc(), p.tags ?? [], (expr) => num(expr, NaN), docUnit()) : null;

      if (cap && Number.isFinite(cap.distance)) {
        const back = origin.map((x, i) => x - dir[i]! * cap.distance) as V3;

        return [
          {
            id: "cap",
            origin: back,
            dir,
            value: cap.distance,
            min: 0.05,
            onStart: () => void apply(cap.write(cap.distance)),
            onDrag: (v) => void applyQuiet(cap.write(v)),
            onEnd: (v) => void applyQuiet(cap.write(v)),
          },
        ];
      }

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
            startDraft({
              id,
              op: "extrude",
              profile: { face: fs },
              extent: "blind",
              distance: 0.001,
              mode: "join",
            });
          },
          onDrag: (v) => updateDraft(extrudePatch(v)),
          onEnd: (v) => finish(v),
        },
      ];
    }

    if (sel.length === 1 && sel[0]!.kind === "region") {
      const p = sel[0]!;
      const sketchView = out.report.sketches.find((sketchView) => sketchView.id === p.sketchId);
      if (!sketchView) return [];

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
            startDraft({
              id,
              op: "extrude",
              profile: { sketch: p.sketchId, regions: [p.key] },
              extent: "blind",
              distance: 0.001,
              mode: out.report.bodies.length ? "join" : "new_body",
            });
          },
          onDrag: (v) => updateDraft(extrudePatch(v)),
          onEnd: (v) => finish(v),
        },
      ];
    }

    const edges = sel.filter((pick) => pick.kind === "edge");

    if (edges.length && edges.length === sel.length) {
      const first = edges[0]! as Extract<Pick, { kind: "edge" }>;
      const mesh = out.meshes.find((x) => x.bodyId === first.bodyId);
      const sels = edges.map((p) => edgeSelectorForPick(p, out.meshes)).filter((x): x is EdgeSelector => !!x);
      const a = mesh ? edgeAnchor(mesh, first.edge) : null;
      if (!a || !sels.length) return [];

      // Out along the bisector rounds the edge, in towards the material bevels it.
      const ids = {
        fillet: nextFeatureId(currentDoc(), "fillet"),
        chamfer: nextFeatureId(currentDoc(), "chamfer"),
      };

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
              v >= 0
                ? { id: ids.fillet, op: "fillet", edges: sels, radius: Math.max(0.05, v) }
                : { id: ids.chamfer, op: "chamfer", edges: sels, distance: Math.max(0.05, -v) },
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
      const match = /^[\w-]+\.side\[([\w-]+)\.([\w-]+)\]/.exec(tag);
      if (!match) continue;

      const [, sketchId, curveId] = match as unknown as [string, string, string];
      const doc = currentDoc();
      const sketch = doc.features.find(
        (feature): feature is Extract<Feature, { op: "sketch" }> =>
          feature.id === sketchId && feature.op === "sketch",
      );
      const view = out.report.sketches.find((sketchView) => sketchView.id === sketchId);
      const curve = view?.curves.find((curve) => curve.id === curveId);
      if (!sketch || !view || curve?.kind !== "circle") continue;

      const { origin: o, u, v } = view.frame;
      // Measure the selected wall itself: pattern and mirror copies sit elsewhere than the sketch circle.
      const mesh = out.meshes.find((x) => x.bodyId === pick.bodyId);
      const cyl = mesh ? cylinderAnchor(mesh, pick.face, view.frame.normal, u) : null;
      const center =
        cyl?.top ??
        ([0, 1, 2].map((i) => o[i]! + u[i]! * curve.center[0] + v[i]! * curve.center[1]) as [
          number,
          number,
          number,
        ]);
      const radial = cyl?.dir ?? u;
      // A circle made Equal to another has no size of its own: the dimension on any circle in its
      // Equal group drives it, so that is what the arrow changes.
      const group = new Set([curveId]);

      for (let grew = true; grew;) {
        grew = false;

        for (const constraint of sketch.constraints) {
          if (
            constraint.type !== "equal" ||
            !(group.has(constraint.a) || group.has(constraint.b)) ||
            (group.has(constraint.a) && group.has(constraint.b))
          ) {
            continue;
          }

          group.add(constraint.a).add(constraint.b);
          grew = true;
        }
      }

      const dim = (sketch.constraints.find(
        (constraint) =>
          (constraint.type === "radius" || constraint.type === "diameter") && constraint.curve === curveId,
      ) ??
        sketch.constraints.find(
          (constraint) =>
            (constraint.type === "radius" || constraint.type === "diameter") && group.has(constraint.curve),
        )) as { id: string; type: "radius" | "diameter"; curve: string; value: Expr } | undefined;
      const params = doc.params;

      const write = (r: number, quiet: boolean) => {
        const run = quiet ? applyQuiet : apply;
        const value = +(dim?.type === "diameter" ? 2 * r : r).toFixed(3);

        if (dim && typeof dim.value === "string" && dim.value in params) {
          const old = params[dim.value];
          // An inch design writes inches; a mm design keeps the variable's "mm" (or a bare number).
          const expr =
            docUnit() === "in"
              ? lengthValue(value, "in")
              : typeof old === "string" && /mm\b/.test(old)
                ? `${value} mm`
                : value;

          return run({ type: "set_param", name: dim.value, expr });
        }

        const latest = currentDoc().features.find((feature) => feature.id === sketchId) as typeof sketch;

        return run({
          type: "edit_feature",
          id: sketchId,
          patch: dim
            ? {
                constraints: latest.constraints.map((constraint) =>
                  constraint.id === dim.id ? ({ ...constraint, value } as typeof constraint) : constraint,
                ),
              }
            : {
                entities: latest.entities.map((entity) =>
                  group.has(entity.id) && entity.type === "circle"
                    ? { ...entity, radius: +r.toFixed(3) }
                    : entity,
                ),
              },
        });
      };

      const equal = sketch.constraints.filter(
        (constraint) =>
          constraint.type === "equal" &&
          (("a" in constraint && constraint.a === curveId) ||
            ("b" in constraint && constraint.b === curveId)),
      );
      const byVar =
        dim &&
        typeof dim.value === "string" &&
        Object.keys(params).some((n) => new RegExp(`\\b${n}\\b`).test(dim.value as string));
      holeLinks.set(
        "hole",
        byVar || equal.length
          ? {
              what: [
                byVar ? t('the variable "{name}"', { name: String(dim!.value) }) : null,
                equal.length
                  ? equal.length === 1
                    ? t("another circle (Equal)")
                    : t("{n} other circles (Equal)", { n: equal.length })
                  : null,
              ]
                .filter(Boolean)
                .join(t(" and ")),
              unlink: () => {
                const latest = currentDoc().features.find(
                  (feature) => feature.id === sketchId,
                ) as typeof sketch;
                const r = curve.radius;
                apply({
                  type: "edit_feature",
                  id: sketchId,
                  patch: {
                    constraints: latest.constraints
                      .filter((constraint) => !equal.some((e) => e.id === constraint.id))
                      // Only this circle's own dimension is frozen; one on another circle of the group stays
                      // as it is.
                      .map((constraint) =>
                        dim && constraint.id === dim.id && dim.curve === curveId
                          ? ({
                              ...constraint,
                              value: +(dim.type === "diameter" ? 2 * r : r).toFixed(3),
                            } as typeof constraint)
                          : constraint,
                      ),
                  },
                });
              },
            }
          : null,
      );

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

  function moveHandles(
    origin: [number, number, number],
    t: [number, number, number],
    drag: (axis: number, v: number) => void,
    end: (v: number) => void,
    start?: () => void,
  ): Handle[] {
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

    // A draft that cannot be built stays open, now as a dialog, so its problem can be fixed.
    if (!commitDialog()) {
      useApp.setState((state) => (state.dialog ? { dialog: { ...state.dialog, gesture: false } } : {}));
    }
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
  usePrefs((prefs) => prefs.keys);

  const last = selection.at(-1)!;
  const meshes = useApp.getState().output?.meshes ?? [];
  const kinds = new Set(selection.map((pick) => pick.kind));
  const actions: { icon: ReactNode; label: string; kbd?: string | undefined; run: () => void }[] = [];
  const partIds = new Set(selection.map((pick) => (pick.kind === "face" ? pick.bodyId : "")));
  const wholePart =
    selection.length > 1 &&
    partIds.size === 1 &&
    !partIds.has("") &&
    meshes.find((mesh) => mesh.bodyId === [...partIds][0])?.faceTags.length === selection.length;

  if (wholePart) {
    actions.push({
      icon: <Move3d />,
      label: t("Move"),
      kbd: keyFor("transform"),
      run: () => startFeature("transform"),
    });
    actions.push({
      icon: <SquareSplitHorizontal />,
      label: t("Mirror"),
      kbd: keyFor("mirror"),
      run: () => startFeature("mirror"),
    });
    actions.push({
      icon: <Grid3x3 />,
      label: t("Pattern"),
      kbd: keyFor("linear_pattern"),
      run: () => startFeature("linear_pattern"),
    });
    actions.push({ icon: <EyeOff />, label: t("Hide"), run: () => toggleHidden([...partIds][0]!) });
  } else if (kinds.size === 1 && kinds.has("face")) {
    const plane = planeSpecForPick(last, meshes);

    if (plane && selection.length === 1) {
      actions.push({
        icon: <Pencil />,
        label: t("Sketch"),
        kbd: keyFor("sketch"),
        run: () => startSketch(plane),
      });
    }

    if (selection.length === 1 && last.kind === "face") {
      actions.push({
        icon: <ArrowUpFromLine />,
        label: t("Push/Pull"),
        kbd: t("kbd::drag"),
        run: () => startFeature("extrude"),
      });
    }

    actions.push({
      icon: <SquareRoundCorner />,
      label: t("Fillet"),
      kbd: keyFor("fillet"),
      run: () => startFeature("fillet"),
    });
    actions.push({
      icon: <Triangle />,
      label: t("Chamfer"),
      kbd: keyFor("chamfer"),
      run: () => startFeature("chamfer"),
    });
    actions.push({
      icon: <Shell />,
      label: t("Shell"),
      kbd: keyFor("shell"),
      run: () => startFeature("shell"),
    });

    const lastMesh = last.kind === "face" ? meshes.find((mesh) => mesh.bodyId === last.bodyId) : undefined;

    if (selection.length === 1 && last.kind === "face" && lastMesh && isCylinderFace(lastMesh, last.face)) {
      actions.push({
        icon: <Bolt />,
        label: t("Thread"),
        kbd: keyFor("thread"),
        run: () => startFeature("thread"),
      });
    }
  } else if (kinds.size === 1 && kinds.has("edge")) {
    actions.push({
      icon: <SquareRoundCorner />,
      label: t("Fillet"),
      kbd: keyFor("fillet"),
      run: () => startFeature("fillet"),
    });
    actions.push({
      icon: <Triangle />,
      label: t("Chamfer"),
      kbd: keyFor("chamfer"),
      run: () => startFeature("chamfer"),
    });
  } else if (kinds.has("region") || kinds.has("sketch_curve")) {
    actions.push({
      icon: <ArrowUpFromLine />,
      label: t("Extrude"),
      kbd: keyFor("extrude"),
      run: () => startFeature("extrude"),
    });
    actions.push({
      icon: <Rotate3d />,
      label: t("Revolve"),
      kbd: keyFor("revolve"),
      run: () => startFeature("revolve"),
    });
    actions.push({ icon: <Cone />, label: t("Loft"), kbd: keyFor("loft"), run: () => startFeature("loft") });
    actions.push({
      icon: <Spline />,
      label: t("Sweep"),
      kbd: keyFor("sweep"),
      run: () => startFeature("sweep"),
    });
  } else if (kinds.has("plane") && selection.length === 1 && last.kind === "plane") {
    actions.push({
      icon: <Pencil />,
      label: t("Sketch"),
      kbd: keyFor("sketch"),
      run: () => startSketch({ ref: last.planeId }),
    });
  }

  if (kinds.has("face") || kinds.has("edge")) {
    actions.push({
      icon: <Ruler />,
      label: t("Measure"),
      kbd: keyFor("measure"),
      run: () => useApp.setState({ measure: { active: true, picks: selection.slice(-2), result: null } }),
    });
  }

  // Without a keyboard there is no Delete key.
  if ((kinds.has("face") || kinds.has("edge")) && matchMedia("(pointer: coarse)").matches) {
    actions.push({ icon: <Trash />, label: t("Delete"), run: () => void deleteModelSelection() });
  }

  if (!actions.length) return null;

  return (
    <div className="quick-actions docked" onPointerDown={(event) => event.stopPropagation()}>
      {actions.map((a) => (
        <button
          key={a.label}
          className="qa"
          onClick={a.run}
          title={`${a.label}${a.kbd ? ` (${a.kbd})` : ""}`}
        >
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

  const showValues = usePrefs((prefs) => prefs.showValues);
  const handles = (viewport as unknown as { handles: Handle[] }).handles ?? [];
  if (viewport.draggingHandle || !showValues) return null;

  return (
    <div className="overlay-layer">
      {handles.map((handle) => {
        const s = viewport.handleTipScreen(handle.id);
        if (!s) return null;

        // Hole handles carry the radius but show and take the diameter.
        const scale = handle.id === "hole" ? 2 : 1;
        const shown = +(handle.value * scale).toFixed(4);
        const text =
          handle.id === "edge"
            ? t("drag: out = fillet, in = chamfer")
            : `${handle.id === "hole" ? "Ø " : ""}${fmtLen(shown)}`;

        return (
          <div
            key={handle.id}
            className="value-chip handle-chip"
            style={{ left: s[0] + 16, top: s[1] - 16 }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {typing === handle.id ? (
              <InlineInput
                value={shown}
                length
                onDone={(expr) => {
                  setTyping(null);
                  if (expr === null) return;

                  const n = num(expr, NaN) / scale;
                  if (!Number.isFinite(n)) return;

                  handle.onStart?.();
                  handle.onDrag(n);
                  handle.onEnd(n);
                }}
              />
            ) : (
              <>
                <button onClick={() => setTyping(handle.id)} title={t("Click to type a value")}>
                  {text}
                </button>
                {holeLinks.get(handle.id) ? (
                  <button
                    className="unlink"
                    onClick={() => holeLinks.get(handle.id)!.unlink()}
                    title={t("Changes together with {what}. Click to change only this hole.", {
                      what: holeLinks.get(handle.id)!.what,
                    })}
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

function bodyCenter(
  out: { report: { bodies: { id: string; bbox: { min: number[]; max: number[] } }[] } },
  id: string,
): [number, number, number] | null {
  const b = out.report.bodies.find((x) => x.id === id);

  return b ? ([0, 1, 2].map((i) => (b.bbox.min[i]! + b.bbox.max[i]!) / 2) as [number, number, number]) : null;
}

type V3 = [number, number, number];

/** The clicked spot moved onto the face's plane (box-selected faces carry a corner instead of a click). */
function onPlane(point: V3, origin: V3, n: V3): V3 {
  const d = (point[0] - origin[0]) * n[0] + (point[1] - origin[1]) * n[1] + (point[2] - origin[2]) * n[2];

  return [point[0] - n[0] * d, point[1] - n[1] * d, point[2] - n[2] * d];
}
