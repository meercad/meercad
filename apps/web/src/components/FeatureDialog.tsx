import { ArrowLeftRight, Check, Cog, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { asArray, type AxisRef, type BooleanMode, type EdgeSelector, type Expr, type FaceSelector, type Feature, type PatternSource, type PlaneSpec, type ProfileRef, type ThreadProfile } from "@meercad/schema";
import type { Pick, PickKind } from "@meercad/viewport";
import { gearDims, HOLE_SIZES, INSERT_SIZES, METRIC_THREADS, parseMetric, SCREW_LENGTHS, STANDARD_CUT_TO_LENGTH, STANDARD_DEFAULT_SIZE, STANDARD_LYING, STANDARD_NAMES, STANDARD_SIZES, STANDARD_WITH_LENGTH, STANDARD_WITH_MOVING } from "@meercad/model";

/** The standard parts in the picker, by what they are for. */
const STANDARD_GROUPS: [string, (keyof typeof STANDARD_NAMES)[]][] = [
  ["Screws and nuts", ["socket_screw", "countersunk_screw", "hex_screw", "set_screw", "hex_nut", "washer", "insert"]],
  ["Aluminium profiles", ["profile", "corner_bracket", "t_nut"]],
  ["Linear motion", ["rail", "lead_screw", "linear_bearing", "shaft"]],
  ["Bearings and magnets", ["bearing", "magnet"]],
];
import { frameFromPlane, toSketch } from "@meercad/sketch";
import { draftFeature, FEATURES, featureName, partName } from "../lib/features";
import { gearParams, pairInfo } from "../lib/gears";
import { joinedParts } from "../lib/mechanism";
import { bendDefaults, bendInfo, describeBend, gapProblem, partsBox, unbentBox } from "../lib/bend";
import { BEND_MODES, evaluate } from "@meercad/model";
import { axisForPick, describeAxis, describeEdgeSelector, describeFaceSelector, describePlane, edgeSelectorForPick, faceSelectorForPick, planeSpecForPick, PLANE_LABELS } from "../lib/topology";
import { cancelDialog, commitDialog, openDraft, setDialogField, setDialogPick, updateDraft, useApp, type DialogState } from "../store";
import { ExprInput } from "./ExprInput";
import { usePrefs } from "../lib/keymap";
import { partSize, tooBig } from "../lib/printBed";
import { docUnit, inUnit } from "../lib/units";
import { GridfinityFields, LabelFields } from "./GridfinityFields";
import { BoxFields, SnapHookFields } from "./ClosureFields";
import { WallFields } from "./WallFields";
import { LithophaneFields } from "./LithophaneFields";
import { TextureFields } from "./TextureFields";
import { Kbd } from "./Kbd";
import { t, tn } from "../lib/i18n";

type Of<O extends Feature["op"]> = Extract<Feature, { op: O }>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const toggle = <T,>(list: T[], item: T): T[] => (list.some((x) => same(x, item)) ? list.filter((x) => !same(x, item)) : [...list, item]);

/** Which viewport entities the active selection field accepts. */
export function pickKindsFor(d: DialogState | null): Set<PickKind> {
  if (!d?.field) return new Set();
  const op = d.feature.op;
  const map: Record<string, PickKind[]> = {
    profile: op === "extrude" ? ["region", "sketch_curve", "face"] : ["region", "sketch_curve"],
    profiles: ["region", "sketch_curve", "face"],
    path: ["sketch_curve"],
    curves: ["sketch_curve"],
    from: ["face"],
    to: ["face"],
    axis: ["sketch_curve", "edge"],
    direction: ["sketch_curve", "edge"],
    direction2: ["sketch_curve", "edge"],
    edges: ["edge", "face"],
    faces: ["face"],
    face: ["face"],
    targets: ["face"],
    target: ["face"],
    tools: ["face"],
    bodies: ["face", "edge"],
    body: ["face", "edge"],
    source: ["face"],
    plane: ["plane", "face"],
    base: ["plane", "face"],
    neutral: ["plane", "face"],
    upTo: ["plane", "face"],
    points: ["face"],
    catchIn: ["face", "edge"],
  };
  if (op === "linear_pattern" && d.field === "direction") return new Set(map["direction"]);
  return new Set(map[d.field] ?? []);
}

/** A tapped point in the coordinates of the face's plane (the same frame the kernel uses), rounded to 0.01 mm. */
function holePoint(point: [number, number, number], normal: [number, number, number]): [number, number] {
  const [u, v] = toSketch(frameFromPlane(point, normal), point);
  return [Math.round(u * 100) / 100, Math.round(v * 100) / 100];
}

function featureOfFace(p: Pick, features: Feature[]): string | null {
  if (p.kind !== "face") return null;
  for (const tag of p.tags) {
    const id = tag.split(/[.@[]/)[0]!;
    const f = features.find((x) => x.id === id);
    if (f && (f.op === "extrude" || f.op === "revolve")) return id;
  }
  return null;
}

function handlePick(p: Pick, d: DialogState): void {
  const { meshes, report } = useApp.getState().output ?? { meshes: [], report: null };
  const features = useApp.getState().doc.features;
  const f = d.feature;
  const field = d.field;
  if (!field) return;
  const bodyOf = (pk: Pick) => (pk.kind === "face" || pk.kind === "edge" ? pk.bodyId : null);
  updateDraft((cur) => {
    const g = structuredClone(cur) as Record<string, unknown> & Feature;
    switch (field) {
      case "profile": {
        const prof0 = (g as Of<"extrude">).profile;
        const prof = "sketch" in prof0 ? prof0 : { sketch: "", regions: undefined };
        if (p.kind === "face" && g.op === "extrude") {
          const fs = faceSelectorForPick(p, meshes);
          if (fs) (g as Of<"extrude">).profile = { face: fs };
        } else if (p.kind === "sketch_curve") (g as Of<"extrude">).profile = { sketch: p.sketchId };
        else if (p.kind === "region") {
          const allKeys = report?.sketches.find((s) => s.id === p.sketchId)?.regions.filter((r) => r.depth % 2 === 1).map((r) => r.key) ?? [];
          const current = prof.sketch === p.sketchId ? (Array.isArray(prof.regions) ? prof.regions : prof.regions === "all" || prof.regions === undefined ? allKeys : []) : [];
          const next = toggle(current, p.key);
          (g as Of<"extrude">).profile = next.length ? { sketch: p.sketchId, regions: next } : { sketch: "" };
        }
        break;
      }
      case "profiles": {
        // In the order picked; picking one again takes it out.
        if (g.op !== "loft") break;
        let item: ProfileRef | null = null;
        if (p.kind === "region") item = { sketch: p.sketchId, regions: [p.key] };
        else if (p.kind === "sketch_curve") item = { sketch: p.sketchId };
        else if (p.kind === "face") {
          const fs = faceSelectorForPick(p, meshes);
          if (fs) item = { face: fs };
        }
        if (item) g.profiles = toggle(g.profiles, item);
        break;
      }
      case "from":
      case "to": {
        // Flat faces mate; round ones line up by their axes.
        if (g.op !== "align" || p.kind !== "face") break;
        const fs = faceSelectorForPick(p, meshes);
        if (!fs) break;
        g[field] = p.normal ? { face: fs } : { axisOf: fs };
        // The moved part takes the parts joined to it along, unless the target is one of them
        // (lining up parts of the same mechanism moves just the one).
        if (field === "from") {
          const group = joinedParts(p.bodyId, useApp.getState().doc.mechanism?.joints);
          g.bodies = group.length > 1 ? group : undefined;
        } else if (g.bodies?.includes(p.bodyId)) g.bodies = undefined;
        break;
      }
      case "curves": {
        // Rib lines of one sketch; picking in another sketch starts over there.
        if (g.op !== "rib" || p.kind !== "sketch_curve") break;
        const curves = g.sketch === p.sketchId ? (g.curves ?? []) : [];
        const next = toggle(curves, p.curveId);
        g.sketch = next.length ? p.sketchId : "";
        g.curves = next.length ? next : undefined;
        break;
      }
      case "path": {
        // Curves of one sketch; picking in another sketch starts over there.
        if (g.op !== "sweep" || p.kind !== "sketch_curve") break;
        const curves = g.path.sketch === p.sketchId ? (g.path.curves ?? []) : [];
        const next = toggle(curves, p.curveId);
        g.path = next.length ? { sketch: p.sketchId, curves: next } : { sketch: "" };
        break;
      }
      case "axis":
      case "direction":
      case "direction2": {
        const a = axisForPick(p, meshes);
        if (a && g.op === "transform" && g.rotate) g.rotate = { ...g.rotate, axis: a };
        else if (a) (g as unknown as Record<string, AxisRef>)[field] = a;
        break;
      }
      case "edges": {
        const sel = edgeSelectorForPick(p, meshes);
        if (sel) (g as Of<"fillet">).edges = toggle(asArray((g as Of<"fillet">).edges), sel);
        break;
      }
      case "faces": {
        const sel = faceSelectorForPick(p, meshes);
        if (sel) (g as Of<"shell">).faces = toggle((g as Of<"shell">).faces, sel);
        break;
      }
      case "face": {
        const sel = faceSelectorForPick(p, meshes);
        if (sel) (g as Of<"thread">).face = sel;
        break;
      }
      case "targets": {
        const b = bodyOf(p);
        if (b) (g as Of<"extrude">).targets = toggle((g as Of<"extrude">).targets ?? [], b);
        break;
      }
      case "target": {
        const b = bodyOf(p);
        if (b) {
          (g as Of<"boolean">).target = b;
          (g as Of<"boolean">).tools = (g as Of<"boolean">).tools.filter((t) => t !== b);
        }
        break;
      }
      case "bodies": {
        const b = bodyOf(p);
        if (!b) break;
        const cur = (g as Of<"transform" | "delete">).bodies;
        // Moving a part takes the parts joined to it along, so the joints stay together.
        if (g.op === "transform" && !g.copy && !cur.includes(b)) g.bodies = [...new Set([...cur, ...joinedParts(b, useApp.getState().doc.mechanism?.joints)])];
        else (g as Of<"transform" | "delete">).bodies = toggle(cur, b);
        // The first part picked for a bend sets which way it bends and how far, from its shape.
        if (g.op === "bend" && !cur.length && g.bodies.length) {
          const box = partsBox(useApp.getState().baseOutput, g.bodies);
          if (box) Object.assign(g, bendDefaults(g.mode, box));
        }
        break;
      }
      case "catchIn": {
        const b = bodyOf(p);
        if (b && g.op === "snap_hook") g.catchIn = toggle(g.catchIn ?? [], b);
        break;
      }
      case "body": {
        const b = bodyOf(p);
        if (b) (g as Of<"mesh_convert">).body = b;
        break;
      }
      case "tools": {
        const b = bodyOf(p);
        if (b && b !== (g as Of<"boolean">).target) (g as Of<"boolean">).tools = toggle((g as Of<"boolean">).tools, b);
        break;
      }
      case "source": {
        const src = (g as Of<"mirror">).source;
        if ("features" in src) {
          const fid = featureOfFace(p, features);
          if (fid) (g as Of<"mirror">).source = { features: toggle(src.features, fid) };
        } else {
          const b = bodyOf(p);
          if (b) (g as Of<"mirror">).source = { bodies: toggle(src.bodies, b) };
        }
        break;
      }
      case "plane":
      case "base":
      case "neutral":
      case "upTo": {
        const spec = planeSpecForPick(p, meshes);
        if (spec) (g as unknown as Record<string, PlaneSpec>)[field] = spec;
        // A hole goes where the face was tapped.
        if (spec && (g.op === "hole" || g.op === "standard_part" || g.op === "snap_hook") && p.kind === "face" && p.normal) (g as Of<"hole">).points = [holePoint(p.point, p.normal)];
        // Springs and screws stand where the face was tapped.
        if (spec && (g.op === "spring" || g.op === "screw") && p.kind === "face" && p.normal) g.center = holePoint(p.point, p.normal);
        // Text starts where the face was tapped.
        if (spec && g.op === "text" && p.kind === "face" && p.normal) g.position = holePoint(p.point, p.normal);
        if (spec && (g.op === "label" || g.op === "box" || (g.op === "gridfinity" && !g.baseplate) || (g.op === "wall" && !g.board)) && p.kind === "face" && p.normal) g.position = holePoint(p.point, p.normal);
        // Labels, free-standing bins and wall boards are centred where the face was tapped.
        // Labels and free-standing bins are centred where the face was tapped.
        if (spec && (g.op === "label" || g.op === "lithophane" || (g.op === "gridfinity" && !g.baseplate)) && p.kind === "face" && p.normal) g.position = holePoint(p.point, p.normal);
        break;
      }
      case "points": {
        // Points are the tap projected onto the hole's plane (u, v are the same on parallel faces).
        if ((g.op !== "hole" && g.op !== "standard_part" && g.op !== "snap_hook") || p.kind !== "face" || !p.normal) break;
        g.points = [...g.points, holePoint(p.point, p.normal)];
        break;
      }
    }
    return g as Feature;
  });
  // Single-valued fields advance to the next field automatically.
  if (["axis", "direction", "plane", "base", "neutral", "upTo", "target", "from", "to"].includes(field)) {
    const next = f.op === "align" && field === "from" ? "to" : f.op === "boolean" && field === "target" ? "tools" : (f.op === "hole" || f.op === "standard_part" || f.op === "snap_hook") && field === "plane" ? "points" : null;
    setDialogField(next);
  }
}

export function FeatureDialog() {
  const d = useApp((s) => s.dialog);
  const previewError = useApp((s) => s.previewError);
  const status = useApp((s) => (s.previewing && s.dialog ? s.output?.report.features.find((x) => x.id === s.dialog!.feature.id) : undefined));
  useEffect(() => {
    if (!d) return;
    setDialogPick((p) => {
      const cur = useApp.getState().dialog;
      if (cur) handlePick(p, cur);
    });
    // Picks made before opening the dialog seed its first field (select edges → Fillet).
    let pre = useApp.getState().selection;
    // A whole selected part becomes a body selection for move/mirror/pattern.
    const f0 = d.feature;
    if (pre.length > 1 && (f0.op === "transform" || f0.op === "delete" || f0.op === "mirror" || f0.op === "linear_pattern" || f0.op === "circular_pattern")) {
      let ids = [...new Set(pre.flatMap((p) => (p.kind === "face" ? [p.bodyId] : [])))];
      if (f0.op === "transform") ids = [...new Set(ids.flatMap((b) => joinedParts(b)))];
      if (f0.op === "transform" || f0.op === "delete") updateDraft({ bodies: ids } as Partial<Feature>);
      else updateDraft({ source: { bodies: ids } } as Partial<Feature>);
      pre = [];
      useApp.setState({ selection: [] });
    }
    if (pre.length && d.isNew) {
      for (const p of pre) {
        const cur = useApp.getState().dialog;
        if (cur) handlePick(p, cur);
      }
      useApp.setState({ selection: [] });
    }
    return () => {
      setDialogPick(null);
    };
  }, [d?.feature.id]);
  if (!d || d.gesture) return null;
  const f = d.feature;
  const Icon = FEATURES[f.op].icon;
  const problem = previewError;
  return (
    <div className="dialog" onKeyDown={(e) => e.key === "Escape" && cancelDialog()}>
      <div className="dialog-head">
        <Icon className="ficon" />
        <h3>{d.isNew ? FEATURES[f.op].label : featureName(f)}</h3>
        <span className="muted mono" style={{ fontSize: 11 }}>{f.id}</span>
      </div>
      <div className="dialog-body">
        <Body d={d} />
        {problem ? <div className="callout info">{problem}</div> : null}
        {status?.status === "error" ? (
          <div className="callout err">
            {status.message}
            {status.hint ? <div style={{ color: "var(--text-2)", marginTop: 4 }}>→ {status.hint}</div> : null}
          </div>
        ) : status?.status === "warning" ? (
          <div className="callout warn">{status.message}</div>
        ) : null}
      </div>
      <div className="dialog-foot">
        <span className="muted key-hint" style={{ marginRight: "auto", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
          <Kbd k="↵" /> {t("accept")} <Kbd k="Esc" /> {t("cancel")}
        </span>
        <button className="cancel-btn" onClick={cancelDialog} title={t("Cancel (Esc)")}>
          <X />
        </button>
        <button className="ok-btn" onClick={() => commitDialog()} disabled={!!problem || status?.status === "error"} title={t("Accept (Enter)")}>
          <Check />
        </button>
      </div>
    </div>
  );
}

function SelBox({ field, items, placeholder, onRemove }: { field: string; items: string[]; placeholder: string; onRemove?: (i: number) => void }) {
  const active = useApp((s) => s.dialog?.field === field);
  return (
    <div className={`selbox ${active ? "active" : ""}`} onClick={() => setDialogField(active ? null : field)} role="button" tabIndex={0}>
      {items.length ? (
        items.map((item, i) => (
          <span className="chip" key={i} title={item}>
            <span>{item}</span>
            {onRemove ? (
              <button onClick={(e) => (e.stopPropagation(), onRemove(i))} aria-label={t("Remove")}>
                <X />
              </button>
            ) : null}
          </span>
        ))
      ) : (
        <span className="placeholder">{active ? t("{what} in the viewport…", { what: placeholder }) : placeholder}</span>
      )}
    </div>
  );
}

/** Whether the parts (as the preview shows them) fit the print bed set in Settings. */
function BedCheck() {
  const bodies = useApp((s) => s.output?.report.bodies);
  const bed = usePrefs((s) => s.printBed);
  const doc = useApp((s) => s.doc);
  if (!bed || !bodies?.length) return null;
  const big = tooBig(bodies, bed);
  const size = `${bed.map((v) => inUnit(v)).join(" × ")} ${docUnit()}`;
  return big.length ? (
    <p className="small bed-warn">
      <TriangleAlert /> {t("Still too big for the print bed ({bed}): {parts}", { bed: size, parts: big.map((b) => `${partName(b.id, doc.features)} (${partSize(b.bbox).map((v) => inUnit(v)).join(" × ")})`).join(", ") })}
    </p>
  ) : (
    <p className="muted small">{t("Every part fits the print bed ({bed}).", { bed: size })}</p>
  );
}

/** Pins, dowels or a dovetail at the cut, so the printed pieces go back together in one place. */
function SplitConnectorFields({ f, set }: { f: Extract<Feature, { op: "split" }>; set: (patch: Partial<Extract<Feature, { op: "split" }>>) => void }) {
  const c = f.connectors;
  const put = (patch: Partial<NonNullable<typeof c>>) => c && set({ connectors: { ...c, ...patch } });
  const auto = (e: Expr) => (e === 0 ? undefined : e);
  return (
    <>
      <Field label={t("Connectors")}>
        <Seg
          value={c?.kind ?? "none"}
          options={[["none", t("Without")], ["pins", t("Pins")], ["dowels", t("Dowels")], ["dovetail", t("Dovetail")]]}
          onChange={(kind) => set({ connectors: kind === "none" ? undefined : { ...c, kind } })}
        />
      </Field>
      {c ? (
        <>
          <div className="row">
            <Field label={c.kind === "dovetail" ? t("Width") : t("Diameter")}>
              <ExprInput value={c.size} placeholder={t("auto")} onCommit={(size) => put({ size: auto(size) })} />
            </Field>
            <Field label={c.kind === "dowels" ? t("Length") : t("Depth")}>
              <ExprInput value={c.depth} placeholder={t("auto")} onCommit={(depth) => put({ depth: auto(depth) })} />
            </Field>
          </div>
          <div className="row">
            <Field label={t("Clearance")}>
              <ExprInput value={c.clearance} placeholder="0.2" onCommit={(clearance) => put({ clearance })} />
            </Field>
            {c.kind === "dovetail" ? null : (
              <Field label={t("Count")}>
                <ExprInput value={c.count} unit="" integer placeholder={t("auto")} onCommit={(count) => put({ count: auto(count) })} />
              </Field>
            )}
          </div>
          {c.kind === "dovetail" ? (
            <Field label={t("Slides in along")}>
              <Seg value={c.slide ?? "long"} options={[["long", t("Longer side")], ["short", t("Shorter side")]]} onChange={(slide) => put({ slide: slide === "long" ? undefined : slide, angle: undefined })} />
            </Field>
          ) : null}
          <p className="muted small">
            {c.kind === "pins"
              ? t("Pins grow out of the front piece into holes in the back piece, placed on the cut with wall around them. Clearance is the gap on every side; 0 for auto sizes.")
              : c.kind === "dowels"
                ? t("Holes in both pieces and loose dowels as their own parts: print them lying down, or use bought dowel pins. Clearance is the gap on every side; 0 for auto sizes.")
                : t("A dovetail tongue on the front piece runs across the cut; the back piece slides onto it from the side. Clearance is the gap on every side; 0 for auto sizes.")}
          </p>
        </>
      ) : null}
    </>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="fld">
    <span className="fld-label">{label}</span>
    {children}
  </div>
);

const MODES: [BooleanMode, string][] = [
  ["new_body", t("mode::New")],
  ["join", t("mode::Add")],
  ["cut", t("mode::Remove")],
  // "Schnittmenge" does not fit beside the other three.
  ["intersect", t("mode::Intersect")],
];

function AxisButtons({ value, onChange, kind = "axis" }: { value: AxisRef; onChange: (a: AxisRef) => void; kind?: string }) {
  return (
    <div className="row">
      {(["origin.X", "origin.Y", "origin.Z"] as const).map((r) => (
        <button key={r} className={`btn ${"ref" in value && value.ref === r ? "primary" : ""}`} style={{ flex: 1, height: 26 }} onClick={() => onChange({ ref: r })} title={kind === "direction" ? t("{a} direction", { a: r.slice(7) }) : t("{a} axis", { a: r.slice(7) })}>
          {r.slice(7)}
        </button>
      ))}
    </div>
  );
}

function PlaneButtons({ value, onChange }: { value: PlaneSpec; onChange: (p: PlaneSpec) => void }) {
  return (
    <div className="row">
      {Object.entries(PLANE_LABELS).map(([ref, label]) => (
        <button key={ref} className={`btn ${"ref" in value && value.ref === ref ? "primary" : ""}`} style={{ flex: 1, height: 26 }} onClick={() => onChange({ ref })}>
          {label}
        </button>
      ))}
    </div>
  );
}

function SourceField({ value, onChange }: { value: PatternSource; onChange: (s: PatternSource) => void }) {
  const features = useApp((s) => s.doc.features);
  const draftId = useApp((s) => s.dialog?.feature.id);
  const kind = "features" in value ? "features" : "bodies";
  const items = "features" in value ? value.features : value.bodies;
  const candidates = features.filter((f) => (f.op === "extrude" || f.op === "revolve") && f.id !== draftId);
  return (
    <>
      <Seg value={kind} options={[["features", t("Features")], ["bodies", t("Parts")]]} onChange={(k) => onChange(k === "features" ? { features: [] } : { bodies: [] })} />
      <SelBox
        field="source"
        items={items.map((id) => (kind === "features" ? featureName(features.find((f) => f.id === id) ?? ({ id, op: "extrude" } as Feature)) : partName(id, features)))}
        placeholder={kind === "features" ? t("Pick faces of extrudes/revolves") : t("Pick parts")}
        onRemove={(i) => onChange(kind === "features" ? { features: items.filter((_, j) => j !== i) } : { bodies: items.filter((_, j) => j !== i) })}
      />
      {kind === "features" && candidates.length ? (
        <div className="col" style={{ gap: 4 }}>
          {candidates.map((c) => (
            <label className="checkbox" key={c.id}>
              <input type="checkbox" checked={items.includes(c.id)} onChange={() => onChange({ features: toggle(items, c.id) })} />
              {featureName(c)}
            </label>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Thread: face, ISO size and pitch, length, printing clearance, hand. */
export const THREAD_PROFILE_LABELS: [ThreadProfile, string][] = [
  ["iso", t("Metric (ISO)")],
  ["trapezoid", t("Trapezoidal")],
  ["square", t("Square")],
  ["buttress", t("Buttress")],
  ["round", t("Round")],
];

/** Thread form, and for the non-metric forms (or custom sizes) diameter, pitch and starts. */
function ThreadForm({ profile, diameter, pitch, starts, set, diameterPlaceholder, pitchPlaceholder }: { profile?: ThreadProfile; diameter?: Expr; pitch?: Expr; starts?: Expr; set: (patch: Record<string, unknown>) => void; diameterPlaceholder?: string; pitchPlaceholder?: string }) {
  return (
    <>
      <Field label={t("Thread form")}>
        <select className="field" value={profile ?? "iso"} onChange={(e) => set({ profile: e.target.value === "iso" ? undefined : e.target.value, pitch: undefined, ...(e.target.value === "iso" ? {} : { size: undefined }) })}>
          {THREAD_PROFILE_LABELS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        {diameterPlaceholder !== undefined ? (
          <Field label={t("Diameter")}>
            <ExprInput value={diameter} placeholder={diameterPlaceholder} onCommit={(diameter) => set({ diameter })} onLive={(diameter) => set({ diameter })} />
          </Field>
        ) : null}
        <Field label={t("Pitch")}>
          <ExprInput value={pitch} placeholder={pitchPlaceholder ?? t("auto")} onCommit={(pitch) => set({ pitch })} onLive={(pitch) => set({ pitch })} />
        </Field>
        <Field label={t("Starts")}>
          <ExprInput value={starts} unit="" integer placeholder="1" onCommit={(starts) => set({ starts: starts === 1 ? undefined : starts })} onLive={(starts) => set({ starts })} />
        </Field>
      </div>
    </>
  );
}

function ThreadFields({ f, set }: { f: Of<"thread">; set: (patch: Record<string, unknown>) => void }) {
  const std = f.size ? METRIC_THREADS.find((t) => t.d === parseMetric(f.size!)) : undefined;
  const pitches = std ? [std.pitch, ...std.fine] : [];
  const custom = f.pitch !== undefined && !pitches.includes(f.pitch as number);
  const hasFace = !("face" in f.face) || !!f.face.face;
  const metric = (f.profile ?? "iso") === "iso" && f.diameter === undefined;
  if (!metric)
    return (
      <>
        <Field label={t("Hole wall or shaft")}>
          <SelBox field="face" items={hasFace ? [describeFaceSelector(f.face)] : []} placeholder={t("Pick a round face")} />
        </Field>
        <ThreadForm profile={f.profile} diameter={f.diameter} pitch={f.pitch} starts={f.starts} set={set} diameterPlaceholder={t("as drawn")} />
        <ThreadCommon f={f} set={set} />
      </>
    );
  return (
    <>
      <Field label={t("Hole wall or shaft")}>
        <SelBox field="face" items={hasFace ? [describeFaceSelector(f.face)] : []} placeholder={t("Pick a round face")} />
      </Field>
      <Field label={t("Thread form")}>
        <select className="field" value="iso" onChange={(e) => set({ profile: e.target.value === "iso" ? undefined : e.target.value, size: undefined, pitch: undefined })}>
          {THREAD_PROFILE_LABELS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <Field label={t("Size")}>
          <select className="field" value={f.size ?? ""} onChange={(e) => set({ size: e.target.value || undefined, pitch: undefined })}>
            <option value="">{t("Auto (from diameter)")}</option>
            {METRIC_THREADS.map((t) => (
              <option key={t.size} value={t.size}>
                {t.size}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Pitch")}>
          <select className="field" value={custom ? "custom" : f.pitch === undefined ? "" : String(f.pitch)} onChange={(e) => set({ pitch: e.target.value === "" ? undefined : e.target.value === "custom" ? (std?.pitch ?? 1) : Number(e.target.value) })}>
            <option value="">{std ? t("Coarse {p} mm", { p: std.pitch }) : t("Standard")}</option>
            {pitches.slice(1).map((p) => (
              <option key={p} value={p}>
                {t("Fine {p} mm", { p })}
              </option>
            ))}
            <option value="custom">{t("Custom…")}</option>
          </select>
        </Field>
      </div>
      {custom ? (
        <Field label={t("Custom pitch")}>
          <ExprInput value={f.pitch} autoFocus onCommit={(pitch) => set({ pitch })} />
        </Field>
      ) : null}
      <Field label={t("Starts")}>
        <ExprInput value={f.starts} unit="" integer placeholder="1" onCommit={(starts) => set({ starts: starts === 1 ? undefined : starts })} />
      </Field>
      <ThreadCommon f={f} set={set} />
    </>
  );
}

function ThreadCommon({ f, set }: { f: Of<"thread">; set: (patch: Record<string, unknown>) => void }) {
  return (
    <>
      <label className="checkbox">
        <input type="checkbox" checked={f.length === undefined} onChange={(e) => set({ length: e.target.checked ? undefined : 10 })} /> {t("Thread the whole face")}
      </label>
      {f.length !== undefined ? (
        <Field label={t("Length from the open end")}>
          <ExprInput value={f.length} onCommit={(length) => set({ length })} onLive={(length) => set({ length })} />
        </Field>
      ) : null}
      <Field label={t("Clearance per side (3D printing)")}>
        <ExprInput value={f.clearance} placeholder="0" onCommit={(clearance) => set({ clearance: clearance === 0 ? undefined : clearance })} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={!!f.leftHanded} onChange={(e) => set({ leftHanded: e.target.checked || undefined })} /> {t("Left-hand thread")}
      </label>
      <p className="muted small">{t("Holes get an internal thread, shafts an external one. Draw holes at the nominal size or the tap drill size; about 0.1–0.2 mm clearance helps printed threads fit.")}</p>
    </>
  );
}

/** Bend: parts, how (bend, wrap, spiral), axis and the values of that mode, and what it comes to. */
function BendFields({ f, set }: { f: Of<"bend">; set: (patch: Record<string, unknown>) => void }) {
  const features = useApp((s) => s.doc.features);
  const params = useApp((s) => s.baseOutput?.report.params);
  const base = useApp((s) => s.baseOutput);
  // The preview's numbers, else (a preview that failed) the last good ones or the saved step's.
  const fresh = useApp((s) => bendInfo(s.output, f.id));
  const lastGood = useRef<Record<string, number> | null>(null);
  if (fresh) lastGood.current = fresh;
  const known = fresh ?? lastGood.current ?? bendInfo(base, f.id);
  // Numbers of another mode (the preview not caught up yet) are not shown.
  const info = fresh && fresh["mode"] === BEND_MODES.indexOf(f.mode) ? fresh : null;
  const num = (e: Expr | undefined) => {
    if (e === undefined) return undefined;
    try {
      return evaluate(e, new Map(Object.entries(params ?? {})));
    } catch {
      return undefined;
    }
  };
  // The parts as they were before bending: from the bend's numbers, else the model before this step.
  const box = known ? unbentBox(known) : partsBox(base, f.bodies);
  const gap = gapProblem(f, f.mode === "spiral" ? (num(f.gap) ?? 1) : undefined);
  const switchMode = (mode: Of<"bend">["mode"]) => {
    set(box && f.bodies.length ? { ...bendDefaults(mode, box) } : { mode, ...(mode === "spiral" ? { radius: 20, gap: 1, angle: undefined } : mode === "wrap" ? { radius: 30, gap: undefined, angle: undefined } : { angle: 90, radius: undefined, gap: undefined }) });
  };
  return (
    <>
      <Field label={t("Parts")}>
        <SelBox field="bodies" items={f.bodies.map((b) => partName(b, features))} placeholder={t("Pick parts")} onRemove={(i) => set({ bodies: f.bodies.filter((_, j) => j !== i) })} />
      </Field>
      <Seg value={f.mode} options={[["bend", t("Bend")], ["wrap", t("Ring")], ["spiral", t("Spiral")]]} onChange={switchMode} />
      <Field label={f.mode === "spiral" ? t("Axis of the coil") : t("Bend axis")}>
        <SelBox field="axis" items={[describeAxis(f.axis)]} placeholder={t("Pick an edge or line")} />
        <AxisButtons value={f.axis} onChange={(axis) => set({ axis })} />
      </Field>
      {f.mode === "bend" ? (
        f.angle !== undefined || f.radius === undefined ? (
          <Field label={t("Angle")}>
            <ExprInput value={f.angle ?? 90} unit="deg" autoFocus onCommit={(angle) => set({ angle, radius: undefined })} onLive={(angle) => set({ angle, radius: undefined })} />
          </Field>
        ) : (
          <Field label={t("Radius")}>
            <ExprInput value={f.radius} autoFocus onCommit={(radius) => set({ radius })} onLive={(radius) => set({ radius })} />
          </Field>
        )
      ) : (
        <Field label={f.mode === "spiral" ? t("Inner radius") : t("Cylinder radius")}>
          <div className="row">
            <div style={{ flex: 1 }}>
              <ExprInput value={f.radius ?? 20} autoFocus onCommit={(radius) => set({ radius })} onLive={(radius) => set({ radius })} />
            </div>
            {f.mode === "wrap" && (known || box) ? (
              <button className="btn" onClick={() => set({ radius: known ? +(known["length"]! / (2 * Math.PI)).toFixed(3) : bendDefaults("wrap", box!).radius })} title={t("Make the ring's ends meet")}>
                {t("Close ring")}
              </button>
            ) : null}
          </div>
        </Field>
      )}
      {f.mode === "spiral" ? (
        <Field label={t("Gap between turns")}>
          <ExprInput value={f.gap ?? 1} onCommit={(g) => set({ gap: g })} onLive={(g) => set({ gap: g })} />
        </Field>
      ) : null}
      {gap ? <div className={`callout ${gap.error ? "err" : "warn"}`}>{gap.text}</div> : null}
      <label className="checkbox">
        <input type="checkbox" checked={!!f.flip} onChange={(e) => set({ flip: e.target.checked || undefined })} /> {t("Bend the other way")}
      </label>
      {f.mode === "spiral" ? (
        <label className="checkbox">
          <input type="checkbox" checked={!!f.reverse} onChange={(e) => set({ reverse: e.target.checked || undefined })} /> {t("Start at the other end")}
        </label>
      ) : null}
      <Field label={t("Tolerance")}>
        <ExprInput value={f.tolerance} placeholder="auto" onCommit={(tolerance) => set({ tolerance: tolerance === 0 ? undefined : tolerance })} />
      </Field>
      {info ? <p className="small">{describeBend(f.mode, info)}</p> : null}
      <p className="muted small">
        {f.mode === "spiral"
          ? t("Rolls a long strip into a flat coil that fits the print bed: a ruler, a band of text, a chain. The length in the middle of the strip stays the same.")
          : f.mode === "wrap"
            ? t("Lays the part onto a cylinder, its bottom face on it: a flat pattern becomes a ring or a bracelet. Close ring makes the ends meet.")
            : t("Bends the part round the axis by the angle, about its middle; the length in the middle of the thickness stays the same.")}{" "}
        {t("The result is a mesh part; drag the arrow to change the radius.")}
      </p>
    </>
  );
}

/** Scale: parts, factor (typed, or from a measured and a wanted length), about what. */
function ScaleFields({ f, set }: { f: Of<"scale">; set: (patch: Record<string, unknown>) => void }) {
  const features = useApp((s) => s.doc.features);
  const [measured, setMeasured] = useState("");
  const [wanted, setWanted] = useState("");
  const m = Number(measured.replace(",", ".")), w = Number(wanted.replace(",", "."));
  const ready = m > 0 && w > 0;
  return (
    <>
      <Field label={t("Parts")}>
        <SelBox field="bodies" items={f.bodies.map((b) => partName(b, features))} placeholder={t("Pick parts")} onRemove={(i) => set({ bodies: f.bodies.filter((_, j) => j !== i) })} />
      </Field>
      <Field label={t("Factor")}>
        <ExprInput value={f.factor} autoFocus unit="" onCommit={(factor) => set({ factor })} onLive={(factor) => set({ factor })} />
      </Field>
      <Field label={t("From a measurement")}>
        <div className="row">
          <input className="field" inputMode="decimal" placeholder={t("measured")} value={measured} onChange={(e) => setMeasured(e.target.value)} />
          <input className="field" inputMode="decimal" placeholder={t("should be")} value={wanted} onChange={(e) => setWanted(e.target.value)} />
          <button className="btn" disabled={!ready} onClick={() => set({ factor: `${w} / ${m}` })} title={t("Use wanted ÷ measured as the factor")}>
            {t("Use")}
          </button>
        </div>
      </Field>
      <Field label={t("About")}>
        <Seg value={f.center ?? "part"} options={[["part", t("Each part's centre")], ["origin", t("Origin")]]} onChange={(center) => set({ center: center === "part" ? undefined : center })} />
      </Field>
      <p className="muted small">{t("To correct a scan, measure a length on the real part with calipers, measure the same length on the model, and enter both.")}</p>
    </>
  );
}

const HOLE_KINDS: [Of<"hole">["kind"], string][] = [
  ["clearance", t("Screw")],
  ["counterbore", t("Counterbore")],
  ["countersink", t("Countersink")],
  ["tapped", t("Thread")],
  ["insert", t("Insert")],
  ["simple", t("Plain")],
];

/** Hole: kind and size, where (a flat face, tapped points), depth, printing allowance. */
function HoleFields({ f, set }: { f: Of<"hole">; set: (patch: Record<string, unknown>) => void }) {
  const sizes = f.kind === "insert" ? INSERT_SIZES : HOLE_SIZES;
  const screw = f.kind === "clearance" || f.kind === "counterbore" || f.kind === "countersink";
  return (
    <>
      <Field label={t("Hole")}>
        <select className="field" value={f.kind} onChange={(e) => {
          const kind = e.target.value as Of<"hole">["kind"];
          set(kind === "simple" ? { kind, size: undefined, fit: undefined, diameter: f.diameter ?? 5, allowance: f.allowance ?? "2 * fit" } : { kind, diameter: undefined, size: (kind === "insert" ? INSERT_SIZES : HOLE_SIZES).includes(f.size ?? "") ? f.size : "M3", ...(kind === "insert" ? { depth: undefined } : {}) });
        }}>
          {HOLE_KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        {f.kind === "simple" ? (
          <Field label={t("Diameter")}>
            <ExprInput value={f.diameter} autoFocus onCommit={(diameter) => set({ diameter })} onLive={(diameter) => set({ diameter })} />
          </Field>
        ) : (
          <Field label={f.kind === "insert" ? t("Insert") : t("Screw")}>
            <select className="field" value={f.size ?? "M3"} onChange={(e) => set({ size: e.target.value })}>
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        )}
        {screw ? (
          <Field label={t("Fit")}>
            <select className="field" value={f.fit ?? "normal"} onChange={(e) => set({ fit: e.target.value === "normal" ? undefined : e.target.value })}>
              <option value="close">{t("fit::Close")}</option>
              <option value="normal">{t("Normal")}</option>
              <option value="loose">{t("Loose")}</option>
            </select>
          </Field>
        ) : null}
      </div>
      <Field label={t("Face")}>
        <SelBox field="plane" items={[describePlane(f.plane)]} placeholder={t("Tap a flat face where the hole goes")} />
      </Field>
      <Field label={t("Holes ({n})", { n: f.points.length })}>
        <SelBox field="points" items={f.points.length ? [tn(f.points.length, "{n} point: tap the face to add", "{n} points: tap the face to add")] : []} placeholder={t("Tap the face to place holes")} />
        {f.points.map((pt, i) => (
          <div className="row" key={i}>
            {[0, 1].map((k) => (
              <div key={k} style={{ flex: 1 }}>
                <ExprInput value={pt[k]} onCommit={(v) => set({ points: f.points.map((q, j) => (j === i ? (k === 0 ? [v, q[1]] : [q[0], v]) : q)) })} />
              </div>
            ))}
            <button className="icon-btn sm" title={t("Remove")} onClick={() => set({ points: f.points.filter((_, j) => j !== i) })}>
              <X />
            </button>
          </div>
        ))}
      </Field>
      {f.kind !== "insert" ? (
        <label className="checkbox">
          <input type="checkbox" checked={f.depth === undefined} onChange={(e) => set({ depth: e.target.checked ? undefined : 10 })} /> {t("Through all")}
        </label>
      ) : null}
      {f.depth !== undefined || f.kind === "insert" ? (
        <Field label={t("Depth")}>
          <ExprInput value={f.depth} placeholder={f.kind === "insert" ? t("insert length + 1") : ""} onCommit={(depth) => set({ depth })} onLive={(depth) => set({ depth })} />
        </Field>
      ) : null}
      <div className="row">
        <Field label={t("Allowance (printing)")}>
          <ExprInput value={f.allowance} placeholder="0" onCommit={(allowance) => set({ allowance: allowance === 0 ? undefined : allowance })} />
        </Field>
        <button className={`icon-btn ${f.flip ? "active" : ""}`} title={t("Drill the other way")} onClick={() => set({ flip: f.flip ? undefined : true })}>
          <ArrowLeftRight />
        </button>
      </div>
      <p className="muted small">
        {f.kind === "insert"
          ? t("Sized for common heat-set inserts for plastic; check your inserts' recommended hole.")
          : f.kind === "tapped"
            ? t("Tap drill size with a modelled thread; printed threads often want 0.1–0.2 mm allowance.")
            : t("Clearance holes follow ISO 273, counterbores fit socket head cap screws, countersinks 90° flat head screws.")}

      </p>
    </>
  );
}

const EMPTY_PARAMS: Record<string, number> = {};
const mm = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "")} mm`;

/** Gear: kind, size, placement or partner, helix, bore and hub, with the resulting sizes. */
function GearFields({ f, set }: { f: Of<"gear">; set: (patch: Record<string, unknown>) => void }) {
  const features = useApp((s) => s.doc.features);
  const values = useApp((s) => s.output?.report.params) ?? EMPTY_PARAMS;
  const others = features.filter((x): x is Of<"gear"> => x.op === "gear" && x.id !== f.id);
  const p = gearParams(f, features, values);
  const dims = p ? gearDims(p) : null;
  const pair = pairInfo(f, features, values);
  const meshing = !!f.meshWith;
  const addMate = () => {
    const teeth = typeof f.teeth === "number" ? f.teeth * 2 : 30;
    if (!commitDialog()) return;
    const mate = draftFeature("gear", useApp.getState().doc) as Of<"gear">;
    // A ring gear or rack gets a gear; a gear gets a gear twice its size.
    openDraft({ ...mate, module: undefined, plane: undefined, teeth: f.kind === "spur" ? teeth : 18, width: f.width, meshWith: { gear: f.id, direction: 0 } } as Feature);
  };
  return (
    <>
      <Seg
        value={f.kind}
        options={[["spur", t("Gear")], ["internal", t("Ring gear")], ["rack", t("Rack")]]}
        onChange={(kind) => set({ kind, rim: undefined, ...(kind !== "spur" ? { bore: undefined, hub: undefined, profileShift: undefined } : {}), ...(kind === "rack" ? { chamfer: undefined } : {}) })}
      />
      {others.length ? (
        <Field label={t("Meshes with")}>
          <select className="field" value={f.meshWith?.gear ?? ""} onChange={(e) => set(e.target.value ? { meshWith: { gear: e.target.value, direction: f.meshWith?.direction ?? 0 }, module: undefined, pressureAngle: undefined, helix: undefined, herringbone: undefined, plane: undefined, center: undefined, rotation: undefined } : { meshWith: undefined, module: p?.module ?? 1.5, plane: { ref: "origin.XY" } })}>
            <option value="">{t("Nothing (place freely)")}</option>
            {others.map((g) => (
              <option key={g.id} value={g.id}>
                {featureName(g)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className="row">
        <Field label={t("Module")}>
          {meshing ? <div className="field muted">{p ? mm(p.module) : "–"}</div> : <ExprInput value={f.module} autoFocus onCommit={(module) => set({ module })} onLive={(module) => set({ module })} />}
        </Field>
        <Field label={t("Teeth")}>
          <ExprInput value={f.teeth} unit="" integer onCommit={(teeth) => set({ teeth })} onLive={(teeth) => set({ teeth })} />
        </Field>
        <Field label={t("Width")}>
          <ExprInput value={f.width} onCommit={(width) => set({ width })} onLive={(width) => set({ width })} />
        </Field>
      </div>
      {meshing ? (
        f.kind === "spur" || f.kind === "internal" ? (
          <Field label={t("Direction from the partner")}>
            <ExprInput value={f.meshWith!.direction ?? 0} unit="deg" onCommit={(direction) => set({ meshWith: { ...f.meshWith!, direction } })} onLive={(direction) => set({ meshWith: { ...f.meshWith!, direction } })} />
          </Field>
        ) : null
      ) : (
        <>
          <Field label={t("Plane")}>
            <SelBox field="plane" items={[describePlane(f.plane ?? { ref: "origin.XY" })]} placeholder={t("Pick a plane or flat face")} />
            <PlaneButtons value={f.plane ?? { ref: "origin.XY" }} onChange={(plane) => set({ plane })} />
          </Field>
          <Field label={t("Centre (in the plane) and turn")}>
            <div className="row">
              {[0, 1].map((i) => (
                <div key={i} style={{ flex: 1 }}>
                  <ExprInput
                    value={f.center?.[i] ?? 0}
                    onCommit={(v) => set({ center: [0, 1].map((j) => (j === i ? v : (f.center?.[j] ?? 0))) })}
                    onLive={(v) => set({ center: [0, 1].map((j) => (j === i ? v : (f.center?.[j] ?? 0))) })}
                  />
                </div>
              ))}
              <div style={{ flex: 1 }}>
                <ExprInput value={f.rotation ?? 0} unit="deg" onCommit={(rotation) => set({ rotation: rotation === 0 ? undefined : rotation })} onLive={(rotation) => set({ rotation })} />
              </div>
            </div>
          </Field>
        </>
      )}
      {f.kind === "internal" ? (
        <Field label={t("Outside diameter")}>
          <ExprInput value={f.rim} placeholder={dims ? (dims.df + 4 * p!.module).toFixed(1) : ""} onCommit={(rim) => set({ rim })} />
        </Field>
      ) : f.kind === "rack" ? (
        <Field label={t("Back below the teeth")}>
          <ExprInput value={f.rim} placeholder={p ? String(2 * p.module) : ""} onCommit={(rim) => set({ rim })} />
        </Field>
      ) : null}
      {!meshing ? (
        <div className="row">
          <Field label={t("Helix angle")}>
            <ExprInput value={f.helix ?? 0} unit="deg" onCommit={(helix) => set({ helix: helix === 0 ? undefined : helix })} onLive={(helix) => set({ helix })} />
          </Field>
          <Field label={t("Pressure angle")}>
            <select className="field" value={String(f.pressureAngle ?? 20)} onChange={(e) => set({ pressureAngle: e.target.value === "20" ? undefined : Number(e.target.value) })}>
              {[14.5, 20, 25].map((a) => (
                <option key={a} value={a}>
                  {a}°
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}
      {!meshing && f.helix !== undefined && f.helix !== 0 ? (
        <label className="checkbox">
          <input type="checkbox" checked={!!f.herringbone} onChange={(e) => set({ herringbone: e.target.checked || undefined })} /> {t("Herringbone (both hands, no side thrust)")}
        </label>
      ) : null}
      <div className="row">
        <Field label={t("Backlash (pair)")}>
          <ExprInput value={f.backlash} placeholder="0.15" onCommit={(backlash) => set({ backlash })} />
        </Field>
        {f.kind === "spur" ? (
          <Field label={t("Profile shift")}>
            <ExprInput value={f.profileShift} unit="" placeholder="0" onCommit={(profileShift) => set({ profileShift: profileShift === 0 ? undefined : profileShift })} />
          </Field>
        ) : null}
      </div>
      {f.kind !== "rack" ? (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={f.chamfer !== undefined} onChange={(e) => set({ chamfer: e.target.checked ? Math.min(0.5, (p?.module ?? 1) / 2) : undefined })} /> {t("Chamfer tooth ends")}
          </label>
          {f.chamfer !== undefined ? (
            <Field label={t("Chamfer (45°)")}>
              <ExprInput value={f.chamfer} onCommit={(chamfer) => set({ chamfer })} onLive={(chamfer) => set({ chamfer })} />
            </Field>
          ) : null}
        </>
      ) : null}
      {f.kind === "spur" ? (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.bore} onChange={(e) => set({ bore: e.target.checked ? { diameter: 5, allowance: "2 * fit" } : undefined })} /> {t("Bore")}
          </label>
          {f.bore ? (
            <>
              <Seg value={f.bore.shape ?? "round"} options={[["round", t("Round")], ["d_flat", t("D shaft")], ["hex", t("Hex")]]} onChange={(shape) => set({ bore: { ...f.bore!, shape: shape === "round" ? undefined : shape } })} />
              <div className="row">
                <Field label={f.bore.shape === "hex" ? t("Across flats") : t("Diameter")}>
                  <ExprInput value={f.bore.diameter} onCommit={(diameter) => set({ bore: { ...f.bore!, diameter } })} onLive={(diameter) => set({ bore: { ...f.bore!, diameter } })} />
                </Field>
                {f.bore.shape === "d_flat" ? (
                  <Field label={t("Across the flat")}>
                    <ExprInput value={f.bore.flat} placeholder={t("0.9 × diameter")} onCommit={(flat) => set({ bore: { ...f.bore!, flat } })} />
                  </Field>
                ) : null}
                <Field label={t("Allowance")}>
                  <ExprInput value={f.bore.allowance} placeholder="0" onCommit={(allowance) => set({ bore: { ...f.bore!, allowance } })} />
                </Field>
              </div>
            </>
          ) : null}
          <label className="checkbox">
            <input type="checkbox" checked={!!f.hub} onChange={(e) => set({ hub: e.target.checked ? { diameter: Math.max(8, (dims?.df ?? 20) / 2), length: 5 } : undefined })} /> {t("Hub")}
          </label>
          {f.hub ? (
            <div className="row">
              <Field label={t("Diameter")}>
                <ExprInput value={f.hub.diameter} onCommit={(diameter) => set({ hub: { ...f.hub!, diameter } })} onLive={(diameter) => set({ hub: { ...f.hub!, diameter } })} />
              </Field>
              <Field label={t("Length")}>
                <ExprInput value={f.hub.length} onCommit={(length) => set({ hub: { ...f.hub!, length } })} onLive={(length) => set({ hub: { ...f.hub!, length } })} />
              </Field>
              <Field label={t("Side")}>
                <select className="field" value={f.hub.side ?? "front"} onChange={(e) => set({ hub: { ...f.hub!, side: e.target.value === "front" ? undefined : e.target.value } })}>
                  <option value="front">{t("Top")}</option>
                  <option value="back">{t("Bottom")}</option>
                  <option value="both">{t("Both")}</option>
                </select>
              </Field>
            </div>
          ) : null}
        </>
      ) : null}
      <Field label={t("Result")}>
        <Seg value={f.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      {dims && p ? (
        <div className="gear-sizes small">
          {p.kind !== "rack" ? (
            <>
              <span>{t("Pitch Ø")}</span>
              <b>{mm(dims.d)}</b>
              <span>{p.kind === "internal" ? t("Inner Ø") : t("Outside Ø")}</span>
              <b>{mm(dims.da)}</b>
              <span>{t("Root Ø")}</span>
              <b>{mm(dims.df)}</b>
            </>
          ) : (
            <>
              <span>{t("Length")}</span>
              <b>{mm(p.teeth * dims.pitch)}</b>
            </>
          )}
          {pair ? (
            <>
              {Number.isFinite(pair.distance) ? (
                <>
                  <span>{t("Centre distance")}</span>
                  <b>{mm(pair.distance)}</b>
                </>
              ) : null}
              <span>{t("Ratio")}</span>
              <b>1 : {pair.ratio.toFixed(3).replace(/\.?0+$/, "")}</b>
            </>
          ) : null}
          {dims.span ? (
            <>
              <span>{t("Span over {k} teeth", { k: dims.span.k })}</span>
              <b>{mm(dims.span.w)}</b>
            </>
          ) : null}
        </div>
      ) : null}
      {dims?.warnings.map((w) => (
        <div key={w} className="callout warn">
          {w}
        </div>
      ))}
      {f.kind !== "rack" || meshing ? null : <p className="muted small">{t("The rack runs along the plane's first axis, its pitch line through the centre.")}</p>}
      <button className="btn" onClick={addMate} disabled={!p}>
        <Cog /> {t("Add mating gear")}
      </button>
    </>
  );
}

/** Info the kernel reported for the feature being edited. */
function useFeatureInfo(id: string): Record<string, number> | undefined {
  return useApp((s) => s.output?.report.features.find((x) => x.id === id)?.info);
}

/** Coil: profile, axis, pitch and turns, taper, hand. */
function CoilFields({ f, set, profileChip, sketches }: { f: Of<"coil">; set: (patch: Record<string, unknown>) => void; profileChip: (p: ProfileRef) => string; sketches: Of<"sketch">[] }) {
  const features = useApp((s) => s.doc.features);
  const prof = f.profile;
  const info = useFeatureInfo(f.id);
  return (
    <>
      <Field label={t("Profile")}>
        <SelBox field="profile" items={"face" in prof || prof.sketch ? [profileChip(prof)] : []} placeholder={t("Pick sketch regions beside the axis")} onRemove={() => set({ profile: { sketch: "" } })} />
        {"sketch" in prof && !prof.sketch && sketches.length ? (
          <select className="field" value="" onChange={(e) => set({ profile: { sketch: e.target.value } })}>
            <option value="">{t("…or use a whole sketch")}</option>
            {sketches.map((s) => (
              <option key={s.id} value={s.id}>
                {featureName(s)}
              </option>
            ))}
          </select>
        ) : null}
      </Field>
      <Field label={t("Axis")}>
        <SelBox field="axis" items={[describeAxis(f.axis)]} placeholder={t("Pick a line or edge")} />
        <AxisButtons value={f.axis} onChange={(axis) => set({ axis })} />
      </Field>
      <div className="row">
        <Field label={t("Pitch (rise per turn)")}>
          <ExprInput value={f.pitch} autoFocus onCommit={(pitch) => set({ pitch })} onLive={(pitch) => set({ pitch })} />
        </Field>
        <Field label={t("Turns")}>
          <ExprInput value={f.turns} unit="" onCommit={(turns) => set({ turns })} onLive={(turns) => set({ turns })} />
        </Field>
      </div>
      <div className="row">
        <Field label={t("Taper")}>
          <ExprInput value={f.taper ?? 0} unit="deg" onCommit={(taper) => set({ taper: taper === 0 ? undefined : taper })} onLive={(taper) => set({ taper })} />
        </Field>
        <button className={`icon-btn ${f.flip ? "active" : ""}`} title={t("Flip direction")} onClick={() => set({ flip: f.flip ? undefined : true })}>
          <ArrowLeftRight />
        </button>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={!!f.leftHanded} onChange={(e) => set({ leftHanded: e.target.checked || undefined })} /> {t("Left-handed")}
      </label>
      <Field label={t("Result")}>
        <Seg value={f.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      {f.mode !== "new_body" ? (
        <Field label={t("Merge scope (optional)")}>
          <SelBox field="targets" items={(f.targets ?? []).map((t) => partName(t, features))} placeholder={t("All touching parts")} onRemove={(i) => set({ targets: (f.targets ?? []).filter((_, j) => j !== i) })} />
        </Field>
      ) : null}
      {info?.["height"] !== undefined ? (
        <div className="gear-sizes small">
          <span>{t("Height")}</span>
          <b>{mm(info["height"])}</b>
        </div>
      ) : null}
      <p className="muted small">{t("Draw the profile in a sketch on a plane through the axis, beside it (a circle for a spring, a triangle for a thread). Cut into a rod for a custom thread.")}</p>
    </>
  );
}

/** Placement on a plane at a centre point, shared by springs and screws. */
function PlaceFields({ f, set }: { f: Of<"spring"> | Of<"screw">; set: (patch: Record<string, unknown>) => void }) {
  return (
    <>
      <Field label={t("Plane")}>
        <SelBox field="plane" items={[describePlane(f.plane ?? { ref: "origin.XY" })]} placeholder={t("Pick a plane or flat face")} />
        <PlaneButtons value={f.plane ?? { ref: "origin.XY" }} onChange={(plane) => set({ plane })} />
      </Field>
      <Field label={t("Centre (in the plane)")}>
        <div className="row">
          {[0, 1].map((i) => (
            <div key={i} style={{ flex: 1 }}>
              <ExprInput
                value={f.center?.[i] ?? 0}
                onCommit={(v) => set({ center: [0, 1].map((j) => (j === i ? v : (f.center?.[j] ?? 0))) })}
                onLive={(v) => set({ center: [0, 1].map((j) => (j === i ? v : (f.center?.[j] ?? 0))) })}
              />
            </div>
          ))}
        </div>
      </Field>
    </>
  );
}

const num = (v: number, digits = 2) => v.toFixed(digits).replace(/\.?0+$/, "");

/** Spring: kind, wire, diameter, coils, length or gap, ends, legs, and its numbers. */
function SpringFields({ f, set }: { f: Of<"spring">; set: (patch: Record<string, unknown>) => void }) {
  const info = useFeatureInfo(f.id);
  return (
    <>
      <Seg
        value={f.kind}
        options={[["compression", t("Compression")], ["extension", t("Extension")], ["torsion", t("Torsion")]]}
        onChange={(kind) => set({ kind, ...(kind === "compression" ? { length: f.length ?? 40, gap: undefined, legs: undefined } : { length: undefined, ends: undefined }) })}
      />
      <div className="row">
        <Field label={t("Wire Ø")}>
          <ExprInput value={f.wire} autoFocus onCommit={(wire) => set({ wire })} onLive={(wire) => set({ wire })} />
        </Field>
        <Field label={t("Outside Ø")}>
          <ExprInput value={f.diameter} onCommit={(diameter) => set({ diameter })} onLive={(diameter) => set({ diameter })} />
        </Field>
        <Field label={t("Active coils")}>
          <ExprInput value={f.coils} unit="" onCommit={(coils) => set({ coils })} onLive={(coils) => set({ coils })} />
        </Field>
      </div>
      {f.kind === "compression" ? (
        <div className="row">
          <Field label={t("Free length")}>
            <ExprInput value={f.length} placeholder={t("3 × diameter")} onCommit={(length) => set({ length })} onLive={(length) => set({ length })} />
          </Field>
          <Field label={t("Ends")}>
            <select className="field" value={f.ends ?? "ground"} onChange={(e) => set({ ends: e.target.value === "ground" ? undefined : e.target.value })}>
              <option value="ground">{t("Closed and ground")}</option>
              <option value="closed">{t("Closed")}</option>
              <option value="open">{t("Open")}</option>
            </select>
          </Field>
        </div>
      ) : (
        <div className="row">
          <Field label={t("Gap between coils")}>
            <ExprInput value={f.gap} placeholder="0.3" onCommit={(gap) => set({ gap })} onLive={(gap) => set({ gap })} />
          </Field>
          {f.kind === "torsion" ? (
            <Field label={t("Leg length")}>
              <ExprInput value={f.legs} placeholder={t("outside Ø")} onCommit={(legs) => set({ legs })} onLive={(legs) => set({ legs })} />
            </Field>
          ) : null}
        </div>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={!!f.leftHanded} onChange={(e) => set({ leftHanded: e.target.checked || undefined })} /> {t("Left-handed")}
      </label>
      <PlaceFields f={f} set={set} />
      <Field label={t("Result")}>
        <Seg value={f.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      {info ? (
        <div className="gear-sizes small">
          <span>{t("Pitch")}</span>
          <b>{mm(info["pitch"] ?? 0)}</b>
          <span>{t("Height")}</span>
          <b>{mm(info["height"] ?? 0)}</b>
          {f.kind === "compression" ? (
            <>
              <span>{t("Solid height")}</span>
              <b>{mm(info["solidHeight"] ?? 0)}</b>
            </>
          ) : null}
          <span>{f.kind === "torsion" ? t("Rate (spring steel)") : t("Rate (spring steel)")}</span>
          <b>{f.kind === "torsion" ? `${num(info["rateSteel"] ?? 0, 3)} N·mm/°` : `${num(info["rateSteel"] ?? 0, 2)} N/mm`}</b>
        </div>
      ) : null}
      <p className="muted small">{t("Printed springs are much softer than steel ones: PLA or PETG about 1/50, so use a thicker wire.")}</p>
    </>
  );
}

/** Screw or nut: head, thread form, diameter, pitch, starts, length, printing clearance. */
function ScrewFields({ f, set }: { f: Of<"screw">; set: (patch: Record<string, unknown>) => void }) {
  const info = useFeatureInfo(f.id);
  const nut = f.kind === "nut";
  const heads: [NonNullable<Of<"screw">["head"]>, string][] = nut
    ? [["hex", t("Hex")], ["round", t("Round")], ["knob", t("Knurled")]]
    : [["hex", t("Hex")], ["socket", t("Socket")], ["round", t("Button")], ["knob", t("Knurled")], ["none", t("None (threaded rod)")]];
  const addNut = () => {
    if (!commitDialog()) return;
    const draft = draftFeature("screw", useApp.getState().doc) as Of<"screw">;
    // The matching nut beside the screw, with the same thread.
    const cx = typeof f.center?.[0] === "number" ? f.center[0] : 0;
    const d = typeof f.diameter === "number" ? f.diameter : 8;
    openDraft({ ...draft, kind: "nut", head: "hex", profile: f.profile, diameter: f.diameter, pitch: f.pitch, starts: f.starts, leftHanded: f.leftHanded, clearance: f.clearance, length: undefined, plane: f.plane, center: [cx + 3 * d, f.center?.[1] ?? 0] } as Feature);
  };
  return (
    <>
      <Seg value={f.kind} options={[["screw", t("Screw")], ["nut", t("Nut")]]} onChange={(kind) => set({ kind, head: "hex", length: kind === "nut" ? undefined : 25, threadLength: undefined })} />
      <Field label={nut ? t("Shape") : t("Head")}>
        <select className="field" value={f.head ?? "hex"} onChange={(e) => set({ head: e.target.value === "hex" ? undefined : e.target.value })}>
          {heads.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <ThreadForm profile={f.profile} diameter={f.diameter} pitch={f.pitch} starts={f.starts} set={set} diameterPlaceholder="" pitchPlaceholder={info?.["pitch"] !== undefined ? String(info["pitch"]) : undefined} />
      <div className="row">
        <Field label={nut ? t("Height") : t("Length")}>
          <ExprInput value={f.length} placeholder={nut ? t("0.8 × diameter") : ""} onCommit={(length) => set({ length })} onLive={(length) => set({ length })} />
        </Field>
        {!nut ? (
          <Field label={t("Thread length")}>
            <ExprInput value={f.threadLength} placeholder={t("all")} onCommit={(threadLength) => set({ threadLength })} onLive={(threadLength) => set({ threadLength })} />
          </Field>
        ) : null}
      </div>
      <Field label={t("Clearance per side (3D printing)")}>
        <ExprInput value={f.clearance} placeholder="0" onCommit={(clearance) => set({ clearance: clearance === 0 ? undefined : clearance })} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={!!f.leftHanded} onChange={(e) => set({ leftHanded: e.target.checked || undefined })} /> {t("Left-hand thread")}
      </label>
      <PlaceFields f={f} set={set} />
      <Field label={t("Result")}>
        <Seg value={f.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      {info?.["pitch"] !== undefined ? (
        <div className="gear-sizes small">
          <span>{t("Pitch")}</span>
          <b>{mm(info["pitch"])}</b>
          <span>{t("Height")}</span>
          <b>{mm(info["height"] ?? 0)}</b>
        </div>
      ) : null}
      <p className="muted small">{t("A screw and a nut with the same thread fit each other. For printing, give both about 0.1–0.2 mm clearance.")}</p>
      {!nut ? (
        <button className="btn" onClick={addNut}>
          {t("Add matching nut")}
        </button>
      ) : null}
    </>
  );
}

function Body({ d }: { d: DialogState }) {
  const f = d.feature;
  const set = (patch: Record<string, unknown>) => updateDraft(patch as Partial<Feature>);
  const features = useApp((s) => s.doc.features);
  const sketches = features.filter((x): x is Of<"sketch"> => x.op === "sketch");
  const profileChip = (prof: ProfileRef) => {
    if ("face" in prof) return describeFaceSelector(prof.face);
    const sk = sketches.find((x) => x.id === prof.sketch);
    const name = sk ? featureName(sk) : prof.sketch;
    return Array.isArray(prof.regions) ? prof.regions.map((k) => `${name} · ${k.split("|")[0]}`).join(", ") : name;
  };
  switch (f.op) {
    case "loft":
      return (
        <>
          <Field label={t("Profiles, in order")}>
            <SelBox field="profiles" items={f.profiles.map((p, i) => `${i + 1}. ${profileChip(p)}`)} placeholder={t("Pick sketch regions or flat faces")} onRemove={(i) => set({ profiles: f.profiles.filter((_, j) => j !== i) })} />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.ruled} onChange={(e) => set({ ruled: e.target.checked || undefined })} /> {t("Straight sides between profiles")}
          </label>
          <Field label={t("Result")}>
            <Seg value={f.mode} options={MODES} onChange={(mode) => set({ mode })} />
          </Field>
          <p className="muted small">{t("Each profile is one closed region, on its own plane. Profiles that all have the same number of holes give a hollow loft.")}</p>
        </>
      );
    case "sweep": {
      const pathSk = sketches.find((x) => x.id === f.path.sketch);
      const pathChips = !f.path.sketch ? [] : f.path.curves ? f.path.curves.map((c) => `${pathSk ? featureName(pathSk) : f.path.sketch} · ${c}`) : [t("All lines of {name}", { name: pathSk ? featureName(pathSk) : f.path.sketch })];
      const prof = f.profile;
      return (
        <>
          <Field label={t("Profile")}>
            <SelBox field="profile" items={"face" in prof || prof.sketch ? [profileChip(prof)] : []} placeholder={t("Pick sketch regions")} onRemove={() => set({ profile: { sketch: "" } })} />
          </Field>
          <Field label={t("Path")}>
            <SelBox field="path" items={pathChips} placeholder={t("Pick lines and arcs")} onRemove={(i) => set({ path: f.path.curves && f.path.curves.length > 1 ? { sketch: f.path.sketch, curves: f.path.curves.filter((_, j) => j !== i) } : { sketch: "" } })} />
            {sketches.length ? (
              <select className="field" value="" onChange={(e) => set({ path: { sketch: e.target.value } })}>
                <option value="">{t("…or follow a whole sketch")}</option>
                {sketches.map((s) => (
                  <option key={s.id} value={s.id}>
                    {featureName(s)}
                  </option>
                ))}
              </select>
            ) : null}
          </Field>
          <Field label={t("Result")}>
            <Seg value={f.mode} options={MODES} onChange={(mode) => set({ mode })} />
          </Field>
          <p className="muted small">{t("Draw the path in its own sketch, usually on a plane across the profile's, starting in the profile.")}</p>
        </>
      );
    }
    case "extrude":
    case "revolve": {
      const prof = f.profile;
      const sk = "face" in prof ? undefined : sketches.find((x) => x.id === prof.sketch);
      const skName = sk ? featureName(sk) : "sketch" in prof ? prof.sketch : "";
      const regionChips = "face" in prof ? [describeFaceSelector(prof.face)] : !prof.sketch ? [] : Array.isArray(prof.regions) ? prof.regions.map((k) => `${skName} · ${k.split("|")[0]}`) : [t("All regions of {name}", { name: skName })];
      return (
        <>
          <Field label={t("Profile")}>
            <SelBox field="profile" items={regionChips} placeholder={f.op === "extrude" ? t("Pick sketch regions or a face") : t("Pick sketch regions")} onRemove={() => set({ profile: { sketch: "" } })} />
            {"sketch" in prof && !prof.sketch && sketches.length ? (
              <select className="field" value="" onChange={(e) => set({ profile: { sketch: e.target.value } })}>
                <option value="">{t("…or use a whole sketch")}</option>
                {sketches.map((s) => (
                  <option key={s.id} value={s.id}>
                    {featureName(s)}
                  </option>
                ))}
              </select>
            ) : null}
          </Field>
          <Field label={t("Result")}>
            <Seg value={f.mode} options={MODES} onChange={(mode) => set({ mode })} />
          </Field>
          {f.op === "extrude" ? (
            <>
              <Field label={t("End")}>
                <select className="field" value={f.extent} onChange={(e) => set({ extent: e.target.value, ...(e.target.value === "two_sided" && f.distance2 === undefined ? { distance2: 10 } : {}) })}>
                  <option value="blind">{t("Blind")}</option>
                  <option value="symmetric">{t("Symmetric")}</option>
                  <option value="two_sided">{t("Two directions")}</option>
                  <option value="through_all">{t("Through all")}</option>
                </select>
              </Field>
              {f.extent !== "through_all" ? (
                <Field label={f.extent === "two_sided" ? t("Distance (direction 1)") : t("Distance")}>
                  <div className="row">
                    <div style={{ flex: 1 }}>
                      <ExprInput value={f.distance} autoFocus onCommit={(distance) => set({ distance })} onLive={(distance) => set({ distance })} />
                    </div>
                    <button className={`icon-btn ${f.flip ? "active" : ""}`} title={t("Flip direction")} onClick={() => set({ flip: f.flip ? undefined : true })}>
                      <ArrowLeftRight />
                    </button>
                  </div>
                </Field>
              ) : (
                <button className={`btn ${f.flip ? "primary" : ""}`} onClick={() => set({ flip: f.flip ? undefined : true })}>
                  <ArrowLeftRight /> {t("Flip direction")}
                </button>
              )}
              {f.extent === "two_sided" ? (
                <Field label={t("Distance (direction 2)")}>
                  <ExprInput value={f.distance2} onCommit={(distance2) => set({ distance2 })} onLive={(distance2) => set({ distance2 })} />
                </Field>
              ) : null}
            </>
          ) : (
            <>
              <Field label={t("Axis")}>
                <SelBox field="axis" items={[describeAxis(f.axis)]} placeholder={t("Pick a line or edge")} />
                <AxisButtons value={f.axis} onChange={(axis) => set({ axis })} />
              </Field>
              <Field label={t("Angle")}>
                <ExprInput value={f.angle} unit="deg" onCommit={(angle) => set({ angle })} onLive={(angle) => set({ angle })} />
              </Field>
              <label className="checkbox">
                <input type="checkbox" checked={!!f.symmetric} onChange={(e) => set({ symmetric: e.target.checked || undefined })} /> {t("Symmetric")}
              </label>
            </>
          )}
          {f.mode !== "new_body" ? (
            <Field label={t("Merge scope (optional)")}>
              <SelBox field="targets" items={(f.targets ?? []).map((t) => partName(t, features))} placeholder={t("All touching parts")} onRemove={(i) => set({ targets: (f.targets ?? []).filter((_, j) => j !== i) })} />
            </Field>
          ) : null}
        </>
      );
    }
    case "fillet":
    case "chamfer": {
      const edges = asArray(f.edges) as EdgeSelector[];
      return (
        <>
          <Field label={t("Edges and faces")}>
            <SelBox field="edges" items={edges.map(describeEdgeSelector)} placeholder={t("Pick edges or faces")} onRemove={(i) => set({ edges: edges.filter((_, j) => j !== i) })} />
          </Field>
          <Field label={f.op === "fillet" ? t("Radius") : t("Distance")}>
            {f.op === "fillet" ? (
              <ExprInput value={f.radius} autoFocus onCommit={(radius) => set({ radius })} onLive={(radius) => set({ radius })} />
            ) : (
              <ExprInput value={f.distance} autoFocus onCommit={(distance) => set({ distance })} onLive={(distance) => set({ distance })} />
            )}
          </Field>
          {f.op === "fillet" ? (
            <>
              <label className="checkbox">
                <input type="checkbox" checked={f.radius2 !== undefined} onChange={(e) => set({ radius2: e.target.checked ? (typeof f.radius === "number" ? f.radius * 2 : 4) : undefined })} /> {t("Variable: changes along the edge")}
              </label>
              {f.radius2 !== undefined ? (
                <Field label={t("Radius at the other end")}>
                  <ExprInput value={f.radius2} onCommit={(radius2) => set({ radius2 })} onLive={(radius2) => set({ radius2 })} />
                </Field>
              ) : null}
            </>
          ) : null}
        </>
      );
    }
    case "shell":
      return (
        <>
          <Field label={t("Faces to remove")}>
            <SelBox field="faces" items={f.faces.map((s: FaceSelector) => describeFaceSelector(s))} placeholder={t("Pick faces")} onRemove={(i) => set({ faces: f.faces.filter((_, j) => j !== i) })} />
          </Field>
          <Field label={t("Thickness")}>
            <ExprInput value={f.thickness} autoFocus onCommit={(thickness) => set({ thickness })} onLive={(thickness) => set({ thickness })} />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.outward} onChange={(e) => set({ outward: e.target.checked || undefined })} /> {t("Thicken outward")}
          </label>
        </>
      );
    case "thread":
      return <ThreadFields f={f} set={set} />;
    case "gear":
      return <GearFields f={f} set={set} />;
    case "coil":
      return <CoilFields f={f} set={set} profileChip={profileChip} sketches={sketches} />;
    case "spring":
      return <SpringFields f={f} set={set} />;
    case "screw":
      return <ScrewFields f={f} set={set} />;
    case "gridfinity":
      return <GridfinityFields f={f} set={set} />;
    case "wall":
      return <WallFields f={f} set={set} />;
    case "label":
      return <LabelFields f={f} set={set} />;
    case "box":
      return <BoxFields f={f} set={set} />;
    case "snap_hook":
      return <SnapHookFields f={f} set={set} />;
    case "lithophane":
      return <LithophaneFields f={f} set={set} />;
    case "hole":
      return <HoleFields f={f} set={set} />;
    case "linear_pattern":
      return (
        <>
          <SourceField value={f.source} onChange={(source) => set({ source })} />
          <Field label={t("Direction")}>
            <SelBox field="direction" items={[describeAxis(f.direction)]} placeholder={t("Pick an edge or line")} />
            <AxisButtons value={f.direction} onChange={(direction) => set({ direction })} kind="direction" />
          </Field>
          <div className="row">
            <Field label={t("Count")}>
              <ExprInput value={f.count} unit="" integer onCommit={(count) => set({ count })} onLive={(count) => set({ count })} />
            </Field>
            <Field label={t("Spacing")}>
              <ExprInput value={f.spacing} onCommit={(spacing) => set({ spacing })} onLive={(spacing) => set({ spacing })} />
            </Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.direction2} onChange={(e) => set(e.target.checked ? { direction2: { ref: "origin.Y" }, count2: 2, spacing2: 20 } : { direction2: undefined, count2: undefined, spacing2: undefined })} /> {t("Second direction")}
          </label>
          {f.direction2 ? (
            <>
              <SelBox field="direction2" items={[describeAxis(f.direction2)]} placeholder={t("Pick an edge or line")} />
              <AxisButtons value={f.direction2} onChange={(direction2) => set({ direction2 })} kind="direction" />
              <div className="row">
                <Field label={t("Count")}>
                  <ExprInput value={f.count2} unit="" integer onCommit={(count2) => set({ count2 })} onLive={(count2) => set({ count2 })} />
                </Field>
                <Field label={t("Spacing")}>
                  <ExprInput value={f.spacing2} onCommit={(spacing2) => set({ spacing2 })} onLive={(spacing2) => set({ spacing2 })} />
                </Field>
              </div>
            </>
          ) : null}
        </>
      );
    case "circular_pattern":
      return (
        <>
          <SourceField value={f.source} onChange={(source) => set({ source })} />
          <Field label={t("Axis")}>
            <SelBox field="axis" items={[describeAxis(f.axis)]} placeholder={t("Pick an edge or line")} />
            <AxisButtons value={f.axis} onChange={(axis) => set({ axis })} />
          </Field>
          <div className="row">
            <Field label={t("Count")}>
              <ExprInput value={f.count} unit="" integer onCommit={(count) => set({ count })} onLive={(count) => set({ count })} />
            </Field>
            <Field label={t("Total angle")}>
              <ExprInput value={f.angle ?? 360} unit="deg" onCommit={(angle) => set({ angle })} onLive={(angle) => set({ angle })} />
            </Field>
          </div>
        </>
      );
    case "mirror":
      return (
        <>
          <SourceField value={f.source} onChange={(source) => set({ source })} />
          <Field label={t("Mirror plane")}>
            <SelBox field="plane" items={[describePlane(f.plane)]} placeholder={t("Pick a plane or face")} />
            <PlaneButtons value={f.plane} onChange={(plane) => set({ plane })} />
          </Field>
        </>
      );
    case "boolean":
      return (
        <>
          <Seg value={f.operation} options={[["union", t("Union")], ["subtract", t("Subtract")], ["intersect", t("Intersect")]]} onChange={(operation) => set({ operation })} />
          <Field label={t("Target part")}>
            <SelBox field="target" items={f.target ? [partName(f.target, features)] : []} placeholder={t("Pick the part to keep")} />
          </Field>
          <Field label={t("Tool parts")}>
            <SelBox field="tools" items={f.tools.map((t) => partName(t, features))} placeholder={t("Pick tool parts")} onRemove={(i) => set({ tools: f.tools.filter((_, j) => j !== i) })} />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.keepTools} onChange={(e) => set({ keepTools: e.target.checked || undefined })} /> {t("Keep tools")}
          </label>
        </>
      );
    case "scale":
      return <ScaleFields f={f} set={set} />;
    case "bend":
      return <BendFields f={f} set={set} />;
    case "align": {
      const desc = (v: Of<"align">["from"]) => {
        const sel = "face" in v ? v.face : v.axisOf;
        if ("face" in sel && !sel.face) return [];
        return ["axisOf" in v ? t("Axis of {face}", { face: describeFaceSelector(sel) }) : describeFaceSelector(sel)];
      };
      return (
        <>
          <Field label={t("Face of the part to move")}>
            <SelBox field="from" items={desc(f.from)} placeholder={t("Pick a flat face, or a round one for its axis")} />
          </Field>
          <Field label={t("Onto")}>
            <SelBox field="to" items={desc(f.to)} placeholder={t("Pick the face on the other part")} />
          </Field>
          {f.bodies && f.bodies.length > 1 ? <p className="muted small">{t("Parts joined to them come along, so their joints stay together.")}</p> : null}
          <div className="row">
            <Field label={t("Gap")}>
              <ExprInput value={f.offset ?? 0} onCommit={(offset) => set({ offset: offset === 0 ? undefined : offset })} onLive={(offset) => set({ offset })} />
            </Field>
            <Field label={t("Turn")}>
              <ExprInput value={f.angle ?? 0} unit="deg" onCommit={(angle) => set({ angle: angle === 0 ? undefined : angle })} />
            </Field>
          </div>
          <button className={`btn ${f.flip ? "primary" : ""}`} onClick={() => set({ flip: f.flip ? undefined : true })}>
            <ArrowLeftRight /> {"axisOf" in f.from ? t("Reverse direction") : t("Flush instead of facing")}
          </button>
          <p className="muted small">{t("Flat faces end up touching, facing each other; round faces (a shaft, a hole) share their axis. The part keeps its place along the other directions.")}</p>
        </>
      );
    }
    case "standard_part": {
      const sizes = STANDARD_SIZES[f.kind];
      return (
        <>
          <Field label={t("Part")}>
            <select className="field" value={f.kind} onChange={(e) => {
              const kind = e.target.value as Of<"standard_part">["kind"];
              const list = STANDARD_SIZES[kind];
              const length = STANDARD_WITH_LENGTH.includes(kind) ? (STANDARD_WITH_LENGTH.includes(f.kind) ? (f.length ?? 10) : 10) : STANDARD_CUT_TO_LENGTH.includes(kind) ? (STANDARD_CUT_TO_LENGTH.includes(f.kind) ? (f.length ?? 200) : 200) : undefined;
              set({
                kind,
                size: list.includes(f.size ?? "") ? f.size : STANDARD_DEFAULT_SIZE[kind],
                length,
                diameter: kind === "magnet" ? 6 : undefined,
                height: kind === "magnet" ? 3 : undefined,
                // A rail comes with its carriage and a lead screw with its nut, moving.
                withMoving: STANDARD_WITH_MOVING.includes(kind) ? true : undefined,
                angle: STANDARD_LYING.includes(kind) ? f.angle : undefined,
              });
            }}>
              {STANDARD_GROUPS.map(([group, kinds]) => (
                <optgroup key={group} label={t(group)}>
                  {kinds.map((k) => (
                    <option key={k} value={k}>
                      {t(STANDARD_NAMES[k])}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <div className="row">
            {sizes.length ? (
              <Field label={t("Size")}>
                <select className="field" value={f.size ?? ""} onChange={(e) => set({ size: e.target.value })}>
                  {sizes.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {STANDARD_WITH_LENGTH.includes(f.kind) ? (
              <Field label={t("Length")}>
                <select className="field" value={String(f.length ?? 10)} onChange={(e) => set({ length: Number(e.target.value) })}>
                  {SCREW_LENGTHS.map((l) => (
                    <option key={l} value={l}>
                      {l} mm
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            {STANDARD_CUT_TO_LENGTH.includes(f.kind) ? (
              <Field label={t("Length")}>
                <ExprInput value={f.length ?? 200} onCommit={(length) => set({ length })} />
              </Field>
            ) : null}
            {f.kind === "magnet" ? (
              <>
                <Field label={t("Diameter")}>
                  <ExprInput value={f.diameter ?? 6} onCommit={(diameter) => set({ diameter })} />
                </Field>
                <Field label={t("Height")}>
                  <ExprInput value={f.height ?? 3} onCommit={(height) => set({ height })} />
                </Field>
              </>
            ) : null}
          </div>
          {/* Its own row: next to size and length the size would not fit. */}
          {STANDARD_LYING.includes(f.kind) ? (
            <Field label={t("Turned")}>
              <ExprInput value={f.angle ?? 0} unit="deg" onCommit={(angle) => set({ angle: angle === 0 ? undefined : angle })} />
            </Field>
          ) : null}
          {STANDARD_WITH_MOVING.includes(f.kind) ? (
            <label className="checkbox">
              <input type="checkbox" checked={!!f.withMoving} onChange={(e) => set({ withMoving: e.target.checked ? true : undefined })} />
              {f.kind === "rail" ? t("With carriage (slides on the rail)") : t("With nut (travels when the screw turns)")}
            </label>
          ) : null}
          <Field label={t("Face")}>
            <div className="row">
              <div style={{ flex: 1 }}>
                <SelBox field="plane" items={[describePlane(f.plane)]} placeholder={t("Tap a flat face where the part goes")} />
              </div>
              <button className={`icon-btn ${f.flip ? "active" : ""}`} title={t("Turn the other way")} onClick={() => set({ flip: f.flip ? undefined : true })}>
                <ArrowLeftRight />
              </button>
            </div>
          </Field>
          <Field label={t("Places ({n})", { n: f.points.length })}>
            <SelBox field="points" items={f.points.length ? [tn(f.points.length, "{n} place: tap the face to add", "{n} places: tap the face to add")] : []} placeholder={t("Tap the face to place parts")} />
            {f.points.map((pt, i) => (
              <div className="row" key={i}>
                {[0, 1].map((k) => (
                  <div key={k} style={{ flex: 1 }}>
                    <ExprInput value={pt[k]} onCommit={(v) => set({ points: f.points.map((q, j) => (j === i ? (k === 0 ? [v, q[1]] : [q[0], v]) : q)) })} />
                  </div>
                ))}
                <button className="icon-btn sm" title={t("Remove")} onClick={() => set({ points: f.points.filter((_, j) => j !== i) })}>
                  <X />
                </button>
              </div>
            ))}
          </Field>
          <p className="muted small">
            {f.kind === "socket_screw" || f.kind === "hex_screw"
              ? t("The head sits on the face, the shank goes in: tap the centre of a hole.")
              : f.kind === "countersunk_screw" || f.kind === "set_screw" || f.kind === "insert"
                ? t("It sits in the hole, flush with the face: tap the centre of a hole.")
                : t("The part stands on the face; turn it to set it into a recess.")}{" "}
            {t("Each place is its own part.")}
          </p>
        </>
      );
    }
    case "primitive": {
      const c = f.center ?? [0, 0, 0];
      const size = f.size ?? [20, 20, 20];
      const setCenter = (k: number, v: string | number) => set({ center: c.map((x, i) => (i === k ? v : x)) as [string | number, string | number, string | number] });
      return (
        <>
          <Field label={t("Shape")}>
            <Seg
              value={f.shape}
              options={[["box", t("primitive::Box")], ["cylinder", t("primitive::Cylinder")], ["sphere", t("primitive::Sphere")]]}
              onChange={(shape) => set(shape === "box" ? { shape, size: f.size ?? [20, 20, 20], diameter: undefined, height: undefined, axis: undefined } : { shape, diameter: f.diameter ?? 20, height: shape === "cylinder" ? (f.height ?? 20) : undefined, size: undefined, ...(shape === "sphere" ? { axis: undefined } : {}) })}
            />
          </Field>
          {f.shape === "box" ? (
            <div className="row">
              {(["X", "Y", "Z"] as const).map((a, k) => (
                <Field key={a} label={t("Size {axis}", { axis: a })}>
                  <ExprInput value={size[k]!} onCommit={(v) => set({ size: size.map((x, i) => (i === k ? v : x)) as [string | number, string | number, string | number] })} onLive={(v) => set({ size: size.map((x, i) => (i === k ? v : x)) as [string | number, string | number, string | number] })} />
                </Field>
              ))}
            </div>
          ) : (
            <div className="row">
              <Field label={t("Diameter")}>
                <ExprInput value={f.diameter ?? 20} onCommit={(diameter) => set({ diameter })} onLive={(diameter) => set({ diameter })} />
              </Field>
              {f.shape === "cylinder" ? (
                <Field label={t("Height")}>
                  <ExprInput value={f.height ?? 20} onCommit={(height) => set({ height })} onLive={(height) => set({ height })} />
                </Field>
              ) : null}
            </div>
          )}
          {f.shape === "cylinder" ? (
            <Field label={t("Axis")}>
              <Seg value={f.axis ?? "Z"} options={[["X", "X"], ["Y", "Y"], ["Z", "Z"]]} onChange={(axis) => set({ axis: axis === "Z" ? undefined : axis })} />
            </Field>
          ) : null}
          <div className="row">
            {(["X", "Y", "Z"] as const).map((a, k) => (
              <Field key={a} label={t("Centre {axis}", { axis: a })}>
                <ExprInput value={c[k]!} onCommit={(v) => setCenter(k, v)} onLive={(v) => setCenter(k, v)} />
              </Field>
            ))}
          </div>
          <Field label={t("Result")}>
            <Seg value={f.mode} options={MODES} onChange={(mode) => set({ mode })} />
          </Field>
        </>
      );
    }
    case "text": {
      const pos = f.position ?? [0, 0];
      return (
        <>
          <Field label={t("Text")}>
            <textarea className="field" rows={2} value={f.text} autoFocus onChange={(e) => set({ text: e.target.value })} />
          </Field>
          <Field label={t("On")}>
            <SelBox field="plane" items={[describePlane(f.plane)]} placeholder={t("Tap a flat face where the text starts")} />
          </Field>
          <Field label={t("Result")}>
            <Seg value={f.mode} options={[["join", t("Raised")], ["cut", t("Engraved")], ["new_body", t("New part")]]} onChange={(mode) => set({ mode })} />
          </Field>
          <div className="row">
            <Field label={t("Letter height")}>
              <ExprInput value={f.size} onCommit={(size) => set({ size })} onLive={(size) => set({ size })} />
            </Field>
            <Field label={f.mode === "cut" ? t("Depth") : t("Height")}>
              <ExprInput value={f.depth} onCommit={(depth) => set({ depth })} onLive={(depth) => set({ depth })} />
            </Field>
          </div>
          <div className="row">
            <Field label={t("Font")}>
              <select className="field" value={f.font ?? "sans"} onChange={(e) => set({ font: e.target.value === "sans" ? undefined : e.target.value })}>
                <option value="sans">{t("Sans")}</option>
                <option value="sans-bold">{t("Sans bold")}</option>
                <option value="mono">{t("Mono")}</option>
              </select>
            </Field>
            <Field label={t("text::Align")}>
              <Seg value={f.align ?? "left"} options={[["left", t("Left")], ["center", t("Centre")], ["right", t("Right")]]} onChange={(align) => set({ align: align === "left" ? undefined : align })} />
            </Field>
          </div>
          <div className="row">
            <Field label={t("Position x")}>
              <ExprInput value={pos[0]} onCommit={(x) => set({ position: [x, pos[1]] })} />
            </Field>
            <Field label={t("Position y")}>
              <ExprInput value={pos[1]} onCommit={(y) => set({ position: [pos[0], y] })} />
            </Field>
            <Field label={t("Angle")}>
              <ExprInput value={f.angle ?? 0} unit="deg" onCommit={(angle) => set({ angle: angle === 0 ? undefined : angle })} />
            </Field>
          </div>
          <p className="muted small">{t("Letter height is the height of capitals. For printing, about 5 mm high and 0.6–1 mm deep reads well.")}</p>
        </>
      );
    }
    case "draft":
      return (
        <>
          <Field label={t("Faces")}>
            <SelBox field="faces" items={f.faces.map(describeFaceSelector)} placeholder={t("Pick side faces")} onRemove={(i) => set({ faces: f.faces.filter((_, j) => j !== i) })} />
          </Field>
          <Field label={t("Angle")}>
            <ExprInput value={f.angle} unit="deg" autoFocus onCommit={(angle) => set({ angle })} onLive={(angle) => set({ angle })} />
          </Field>
          <Field label={t("Neutral plane")}>
            <div className="row">
              <div style={{ flex: 1 }}>
                <SelBox field="neutral" items={[describePlane(f.neutral)]} placeholder={t("Pick a plane or flat face")} />
              </div>
              <button className={`icon-btn ${f.flip ? "active" : ""}`} title={t("Pull the other way")} onClick={() => set({ flip: f.flip ? undefined : true })}>
                <ArrowLeftRight />
              </button>
            </div>
            <PlaneButtons value={f.neutral} onChange={(neutral) => set({ neutral })} />
          </Field>
          <p className="muted small">{t("The faces keep their edge on the neutral plane (usually the bottom or the parting face) and lean inwards in the pull direction. 1–3° is typical for moulded parts.")}</p>
        </>
      );
    case "offset_face":
      return (
        <>
          <Field label={t("Faces")}>
            <SelBox field="faces" items={f.faces.map(describeFaceSelector)} placeholder={t("Pick faces")} onRemove={(i) => set({ faces: f.faces.filter((_, j) => j !== i) })} />
          </Field>
          <Field label={t("Up to")}>
            <div className="row">
              <div style={{ flex: 1 }}>
                <SelBox field="upTo" items={f.upTo ? [describePlane(f.upTo)] : []} placeholder={t("Optional: a plane or flat face")} />
              </div>
              {f.upTo && (
                <button className="icon-btn" title={t("Remove")} onClick={() => set({ upTo: undefined })}>
                  <X />
                </button>
              )}
            </div>
          </Field>
          <Field label={f.upTo ? t("Gap before it") : t("Distance")}>
            <ExprInput value={f.distance} unit="mm" autoFocus onCommit={(distance) => set({ distance })} onLive={(distance) => set({ distance })} />
          </Field>
          <p className="muted small">{f.upTo ? t("Flat faces parallel to the plane move onto it, or stop short of it by the gap.") : t("Positive moves the faces out of the part (it grows there), negative into it. A hole wall moved out makes the hole tighter.")}</p>
        </>
      );
    case "texture":
      return <TextureFields f={f} set={set} faces={<SelBox field="faces" items={f.faces.map(describeFaceSelector)} placeholder={t("Pick faces")} onRemove={(i) => set({ faces: f.faces.filter((_, j) => j !== i) })} />} />;
    case "rib": {
      const sk = sketches.find((x) => x.id === f.sketch);
      const name = sk ? featureName(sk) : f.sketch;
      return (
        <>
          <Field label={t("Lines")}>
            <SelBox field="curves" items={!f.sketch ? [] : f.curves ? f.curves.map((c) => `${name} · ${c}`) : [`All lines of ${name}`]} placeholder={t("Pick open lines in a sketch")} onRemove={(i) => set(f.curves && f.curves.length > 1 ? { curves: f.curves.filter((_, j) => j !== i) } : { sketch: "", curves: undefined })} />
            {sketches.length ? (
              <select className="field" value="" onChange={(e) => set({ sketch: e.target.value, curves: undefined })}>
                <option value="">{t("…or all lines of a sketch")}</option>
                {sketches.map((s) => (
                  <option key={s.id} value={s.id}>
                    {featureName(s)}
                  </option>
                ))}
              </select>
            ) : null}
          </Field>
          <Field label={t("Thickness")}>
            <div className="row">
              <div style={{ flex: 1 }}>
                <ExprInput value={f.thickness} autoFocus onCommit={(thickness) => set({ thickness })} onLive={(thickness) => set({ thickness })} />
              </div>
              <button className={`icon-btn ${f.flip ? "active" : ""}`} title={t("Fill towards the other side")} onClick={() => set({ flip: f.flip ? undefined : true })}>
                <ArrowLeftRight />
              </button>
            </div>
          </Field>
          <p className="muted small">{t("Draw the rib as an open line on a plane across the walls, e.g. from a wall to the floor. It fills from the line to the walls it meets, centred on the sketch plane.")}</p>
        </>
      );
    }
    case "split":
      return (
        <>
          <Field label={t("Split at")}>
            <SelBox field="plane" items={[describePlane(f.plane)]} placeholder={t("Pick a plane or flat face")} />
            <PlaneButtons value={f.plane} onChange={(plane) => set({ plane })} />
          </Field>
          <Field label={t("Parts")}>
            <SelBox field="bodies" items={f.bodies.map((b) => partName(b, features))} placeholder={t("All parts the plane crosses")} onRemove={(i) => set({ bodies: f.bodies.filter((_, j) => j !== i) })} />
          </Field>
          <Field label={t("Keep")}>
            <Seg value={f.keep ?? "both"} options={[["both", t("Both")], ["front", t("Front")], ["back", t("Back")]]} onChange={(keep) => set(keep === "both" ? { keep: undefined } : { keep, connectors: undefined })} />
          </Field>
          {(f.keep ?? "both") === "both" ? <SplitConnectorFields f={f} set={set} /> : null}
          <p className="muted small">{t("For a part larger than the printer: split at an offset plane, print both pieces. Front is the side the plane's arrow points to; that piece keeps the part's name.")}</p>
          <BedCheck />
        </>
      );
    case "delete":
      return (
        <Field label={t("Parts")}>
          <SelBox field="bodies" items={f.bodies.map((b) => partName(b, features))} placeholder={t("Pick parts")} onRemove={(i) => set({ bodies: f.bodies.filter((_, j) => j !== i) })} />
        </Field>
      );
    case "mesh_convert":
      return (
        <>
          <Field label={t("Mesh part")}>
            <SelBox field="body" items={f.body ? [partName(f.body, features)] : []} placeholder={t("Pick a mesh part")} onRemove={() => set({ body: "" })} />
          </Field>
          <Field label={t("Tolerance")}>
            <ExprInput value={f.tolerance} placeholder="auto" onCommit={(tolerance) => set({ tolerance: tolerance === 0 ? undefined : tolerance })} />
          </Field>
          <Field label={t("Sharp edge angle")}>
            <ExprInput value={f.angle ?? 30} unit="deg" onCommit={(angle) => set({ angle })} />
          </Field>
          <p className="muted small">{t("Flat, round, conical and spherical areas of the mesh become real faces (within the tolerance; by default a small fraction of the part's size). Triangles that match no surface stay flat facets. Raise the tolerance for rough meshes.")}</p>
        </>
      );
    case "transform": {
      const tr = f.translate ?? [0, 0, 0];
      const setT = (i: number, v: Expr) => set({ translate: tr.map((x, j) => (j === i ? v : x)) });
      return (
        <>
          <Field label={t("Parts")}>
            <SelBox field="bodies" items={f.bodies.map((b) => partName(b, features))} placeholder={t("Pick parts")} onRemove={(i) => set({ bodies: f.bodies.filter((_, j) => j !== i) })} />
          </Field>
          {!f.copy && f.bodies.some((b) => joinedParts(b).length > 1) ? <p className="muted small">{t("Parts joined to them come along, so their joints stay together.")}</p> : null}
          <Field label={t("Move by (X / Y / Z)")}>
            <div className="row">
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ flex: 1 }}>
                  <ExprInput value={tr[i]} onCommit={(v) => setT(i, v)} onLive={(v) => setT(i, v)} />
                </div>
              ))}
            </div>
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.rotate} onChange={(e) => set({ rotate: e.target.checked ? { axis: { ref: "origin.Z" }, angle: 90 } : undefined })} /> {t("Rotate")}
          </label>
          {f.rotate ? (
            <>
              <Field label={t("Axis")}>
                <SelBox field="axis" items={[describeAxis(f.rotate.axis)]} placeholder={t("Pick an edge or line")} />
                <AxisButtons value={f.rotate.axis} onChange={(axis) => set({ rotate: { ...f.rotate!, axis } })} />
              </Field>
              <Field label={t("Angle")}>
                <ExprInput value={f.rotate.angle} unit="deg" onCommit={(angle) => set({ rotate: { ...f.rotate!, angle } })} onLive={(angle) => set({ rotate: { ...f.rotate!, angle } })} />
              </Field>
            </>
          ) : null}
          <label className="checkbox">
            <input type="checkbox" checked={!!f.copy} onChange={(e) => set({ copy: e.target.checked || undefined })} /> {t("Keep original (copy)")}
          </label>
        </>
      );
    }
    case "plane":
      return (
        <>
          <Field label={t("Reference")}>
            <SelBox field="base" items={[describePlane(f.base)]} placeholder={t("Pick a plane or face")} />
            <PlaneButtons value={f.base} onChange={(base) => set({ base })} />
          </Field>
          <Field label={t("Offset")}>
            <ExprInput value={f.offset} autoFocus onCommit={(offset) => set({ offset })} onLive={(offset) => set({ offset })} />
          </Field>
          <Field label={t("Tilt")}>
            <ExprInput value={f.angle ?? 0} unit="deg" onCommit={(angle) => set({ angle })} onLive={(angle) => set({ angle })} />
          </Field>
        </>
      );
    default:
      return <div className="muted">{t("Nothing to set.")}</div>
;
  }
}
