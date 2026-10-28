import { ArrowLeftRight, Check, X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { asArray, type AxisRef, type BooleanMode, type EdgeSelector, type Expr, type FaceSelector, type Feature, type PatternSource, type PlaneSpec } from "@meercad/schema";
import type { Pick, PickKind } from "@meercad/viewport";
import { METRIC_THREADS, parseMetric } from "@meercad/model";
import { FEATURES, featureName, partName } from "../lib/features";
import { axisForPick, describeAxis, describeEdgeSelector, describeFaceSelector, describePlane, edgeSelectorForPick, faceSelectorForPick, planeSpecForPick, PLANE_LABELS } from "../lib/topology";
import { cancelDialog, commitDialog, setDialogField, setDialogPick, updateDraft, useApp, type DialogState } from "../store";
import { ExprInput } from "./ExprInput";
import { Kbd } from "./Kbd";

type Of<O extends Feature["op"]> = Extract<Feature, { op: O }>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const toggle = <T,>(list: T[], item: T): T[] => (list.some((x) => same(x, item)) ? list.filter((x) => !same(x, item)) : [...list, item]);

/** Which viewport entities the active selection field accepts. */
export function pickKindsFor(d: DialogState | null): Set<PickKind> {
  if (!d?.field) return new Set();
  const op = d.feature.op;
  const map: Record<string, PickKind[]> = {
    profile: op === "extrude" ? ["region", "sketch_curve", "face"] : ["region", "sketch_curve"],
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
    source: ["face"],
    plane: ["plane", "face"],
    base: ["plane", "face"],
  };
  if (op === "linear_pattern" && d.field === "direction") return new Set(map["direction"]);
  return new Set(map[d.field] ?? []);
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
        if (b) (g as Of<"transform" | "delete">).bodies = toggle((g as Of<"transform" | "delete">).bodies, b);
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
      case "base": {
        const spec = planeSpecForPick(p, meshes);
        if (spec) (g as unknown as Record<string, PlaneSpec>)[field] = spec;
        break;
      }
    }
    return g as Feature;
  });
  // Single-valued fields advance to the next field automatically.
  if (["axis", "direction", "plane", "base", "target"].includes(field)) {
    const next = f.op === "boolean" && field === "target" ? "tools" : null;
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
      const ids = [...new Set(pre.flatMap((p) => (p.kind === "face" ? [p.bodyId] : [])))];
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
  if (!d) return null;
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
        <span className="muted" style={{ marginRight: "auto", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
          <Kbd k="↵" /> accept <Kbd k="Esc" /> cancel
        </span>
        <button className="cancel-btn" onClick={cancelDialog} title="Cancel (Esc)">
          <X />
        </button>
        <button className="ok-btn" onClick={() => commitDialog()} disabled={!!problem || status?.status === "error"} title="Accept (Enter)">
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
        items.map((t, i) => (
          <span className="chip" key={i} title={t}>
            <span>{t}</span>
            {onRemove ? (
              <button onClick={(e) => (e.stopPropagation(), onRemove(i))} aria-label="Remove">
                <X />
              </button>
            ) : null}
          </span>
        ))
      ) : (
        <span className="placeholder">{active ? `${placeholder} in the viewport…` : placeholder}</span>
      )}
    </div>
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
  ["new_body", "New"],
  ["join", "Add"],
  ["cut", "Remove"],
  ["intersect", "Intersect"],
];

function AxisButtons({ value, onChange, kind = "axis" }: { value: AxisRef; onChange: (a: AxisRef) => void; kind?: string }) {
  return (
    <div className="row">
      {(["origin.X", "origin.Y", "origin.Z"] as const).map((r) => (
        <button key={r} className={`btn ${"ref" in value && value.ref === r ? "primary" : ""}`} style={{ flex: 1, height: 26 }} onClick={() => onChange({ ref: r })} title={`${r.slice(7)} ${kind}`}>
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
      <Seg value={kind} options={[["features", "Features"], ["bodies", "Parts"]]} onChange={(k) => onChange(k === "features" ? { features: [] } : { bodies: [] })} />
      <SelBox
        field="source"
        items={items.map((id) => (kind === "features" ? featureName(features.find((f) => f.id === id) ?? ({ id, op: "extrude" } as Feature)) : partName(id, features)))}
        placeholder={kind === "features" ? "Pick faces of extrudes/revolves" : "Pick parts"}
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
function ThreadFields({ f, set }: { f: Of<"thread">; set: (patch: Record<string, unknown>) => void }) {
  const std = f.size ? METRIC_THREADS.find((t) => t.d === parseMetric(f.size!)) : undefined;
  const pitches = std ? [std.pitch, ...std.fine] : [];
  const custom = f.pitch !== undefined && !pitches.includes(f.pitch as number);
  const hasFace = !("face" in f.face) || !!f.face.face;
  return (
    <>
      <Field label="Hole wall or shaft">
        <SelBox field="face" items={hasFace ? [describeFaceSelector(f.face)] : []} placeholder="Pick a round face" />
      </Field>
      <div className="row">
        <Field label="Size">
          <select className="field" value={f.size ?? ""} onChange={(e) => set({ size: e.target.value || undefined, pitch: undefined })}>
            <option value="">Auto (from diameter)</option>
            {METRIC_THREADS.map((t) => (
              <option key={t.size} value={t.size}>
                {t.size}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pitch">
          <select className="field" value={custom ? "custom" : f.pitch === undefined ? "" : String(f.pitch)} onChange={(e) => set({ pitch: e.target.value === "" ? undefined : e.target.value === "custom" ? (std?.pitch ?? 1) : Number(e.target.value) })}>
            <option value="">{std ? `Coarse ${std.pitch} mm` : "Standard"}</option>
            {pitches.slice(1).map((p) => (
              <option key={p} value={p}>
                Fine {p} mm
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </Field>
      </div>
      {custom ? (
        <Field label="Custom pitch">
          <ExprInput value={f.pitch} autoFocus onCommit={(pitch) => set({ pitch })} />
        </Field>
      ) : null}
      <label className="checkbox">
        <input type="checkbox" checked={f.length === undefined} onChange={(e) => set({ length: e.target.checked ? undefined : 10 })} /> Thread the whole face
      </label>
      {f.length !== undefined ? (
        <Field label="Length from the open end">
          <ExprInput value={f.length} onCommit={(length) => set({ length })} onLive={(length) => set({ length })} />
        </Field>
      ) : null}
      <Field label="Clearance per side (3D printing)">
        <ExprInput value={f.clearance} placeholder="0" onCommit={(clearance) => set({ clearance: clearance === 0 ? undefined : clearance })} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={!!f.leftHanded} onChange={(e) => set({ leftHanded: e.target.checked || undefined })} /> Left-hand thread
      </label>
      <p className="muted small">Holes get an internal thread, shafts an external one. Draw holes at the nominal size or the tap drill size; about 0.1–0.2 mm clearance helps printed threads fit.</p>
    </>
  );
}

function Body({ d }: { d: DialogState }) {
  const f = d.feature;
  const set = (patch: Record<string, unknown>) => updateDraft(patch as Partial<Feature>);
  const features = useApp((s) => s.doc.features);
  const sketches = features.filter((x): x is Of<"sketch"> => x.op === "sketch");
  switch (f.op) {
    case "extrude":
    case "revolve": {
      const prof = f.profile;
      const sk = "face" in prof ? undefined : sketches.find((x) => x.id === prof.sketch);
      const skName = sk ? featureName(sk) : "sketch" in prof ? prof.sketch : "";
      const regionChips = "face" in prof ? [describeFaceSelector(prof.face)] : !prof.sketch ? [] : Array.isArray(prof.regions) ? prof.regions.map((k) => `${skName} · ${k.split("|")[0]}`) : [`All regions of ${skName}`];
      return (
        <>
          <Field label="Profile">
            <SelBox field="profile" items={regionChips} placeholder={f.op === "extrude" ? "Pick sketch regions or a face" : "Pick sketch regions"} onRemove={() => set({ profile: { sketch: "" } })} />
            {"sketch" in prof && !prof.sketch && sketches.length ? (
              <select className="field" value="" onChange={(e) => set({ profile: { sketch: e.target.value } })}>
                <option value="">…or use a whole sketch</option>
                {sketches.map((s) => (
                  <option key={s.id} value={s.id}>
                    {featureName(s)}
                  </option>
                ))}
              </select>
            ) : null}
          </Field>
          <Field label="Result">
            <Seg value={f.mode} options={MODES} onChange={(mode) => set({ mode })} />
          </Field>
          {f.op === "extrude" ? (
            <>
              <Field label="End">
                <select className="field" value={f.extent} onChange={(e) => set({ extent: e.target.value, ...(e.target.value === "two_sided" && f.distance2 === undefined ? { distance2: 10 } : {}) })}>
                  <option value="blind">Blind</option>
                  <option value="symmetric">Symmetric</option>
                  <option value="two_sided">Two directions</option>
                  <option value="through_all">Through all</option>
                </select>
              </Field>
              {f.extent !== "through_all" ? (
                <Field label={f.extent === "two_sided" ? "Distance (direction 1)" : "Distance"}>
                  <div className="row">
                    <div style={{ flex: 1 }}>
                      <ExprInput value={f.distance} autoFocus onCommit={(distance) => set({ distance })} onLive={(distance) => set({ distance })} />
                    </div>
                    <button className={`icon-btn ${f.flip ? "active" : ""}`} title="Flip direction" onClick={() => set({ flip: f.flip ? undefined : true })}>
                      <ArrowLeftRight />
                    </button>
                  </div>
                </Field>
              ) : (
                <button className={`btn ${f.flip ? "primary" : ""}`} onClick={() => set({ flip: f.flip ? undefined : true })}>
                  <ArrowLeftRight /> Flip direction
                </button>
              )}
              {f.extent === "two_sided" ? (
                <Field label="Distance (direction 2)">
                  <ExprInput value={f.distance2} onCommit={(distance2) => set({ distance2 })} onLive={(distance2) => set({ distance2 })} />
                </Field>
              ) : null}
            </>
          ) : (
            <>
              <Field label="Axis">
                <SelBox field="axis" items={[describeAxis(f.axis)]} placeholder="Pick a line or edge" />
                <AxisButtons value={f.axis} onChange={(axis) => set({ axis })} />
              </Field>
              <Field label="Angle">
                <ExprInput value={f.angle} unit="deg" onCommit={(angle) => set({ angle })} onLive={(angle) => set({ angle })} />
              </Field>
              <label className="checkbox">
                <input type="checkbox" checked={!!f.symmetric} onChange={(e) => set({ symmetric: e.target.checked || undefined })} /> Symmetric
              </label>
            </>
          )}
          {f.mode !== "new_body" ? (
            <Field label="Merge scope (optional)">
              <SelBox field="targets" items={(f.targets ?? []).map((t) => partName(t, features))} placeholder="All touching parts" onRemove={(i) => set({ targets: (f.targets ?? []).filter((_, j) => j !== i) })} />
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
          <Field label="Edges and faces">
            <SelBox field="edges" items={edges.map(describeEdgeSelector)} placeholder="Pick edges or faces" onRemove={(i) => set({ edges: edges.filter((_, j) => j !== i) })} />
          </Field>
          <Field label={f.op === "fillet" ? "Radius" : "Distance"}>
            {f.op === "fillet" ? (
              <ExprInput value={f.radius} autoFocus onCommit={(radius) => set({ radius })} onLive={(radius) => set({ radius })} />
            ) : (
              <ExprInput value={f.distance} autoFocus onCommit={(distance) => set({ distance })} onLive={(distance) => set({ distance })} />
            )}
          </Field>
        </>
      );
    }
    case "shell":
      return (
        <>
          <Field label="Faces to remove">
            <SelBox field="faces" items={f.faces.map((s: FaceSelector) => describeFaceSelector(s))} placeholder="Pick faces" onRemove={(i) => set({ faces: f.faces.filter((_, j) => j !== i) })} />
          </Field>
          <Field label="Thickness">
            <ExprInput value={f.thickness} autoFocus onCommit={(thickness) => set({ thickness })} onLive={(thickness) => set({ thickness })} />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.outward} onChange={(e) => set({ outward: e.target.checked || undefined })} /> Thicken outward
          </label>
        </>
      );
    case "thread":
      return <ThreadFields f={f} set={set} />;
    case "linear_pattern":
      return (
        <>
          <SourceField value={f.source} onChange={(source) => set({ source })} />
          <Field label="Direction">
            <SelBox field="direction" items={[describeAxis(f.direction)]} placeholder="Pick an edge or line" />
            <AxisButtons value={f.direction} onChange={(direction) => set({ direction })} kind="direction" />
          </Field>
          <div className="row">
            <Field label="Count">
              <ExprInput value={f.count} unit="" integer onCommit={(count) => set({ count })} onLive={(count) => set({ count })} />
            </Field>
            <Field label="Spacing">
              <ExprInput value={f.spacing} onCommit={(spacing) => set({ spacing })} onLive={(spacing) => set({ spacing })} />
            </Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.direction2} onChange={(e) => set(e.target.checked ? { direction2: { ref: "origin.Y" }, count2: 2, spacing2: 20 } : { direction2: undefined, count2: undefined, spacing2: undefined })} /> Second direction
          </label>
          {f.direction2 ? (
            <>
              <SelBox field="direction2" items={[describeAxis(f.direction2)]} placeholder="Pick an edge or line" />
              <AxisButtons value={f.direction2} onChange={(direction2) => set({ direction2 })} kind="direction" />
              <div className="row">
                <Field label="Count">
                  <ExprInput value={f.count2} unit="" integer onCommit={(count2) => set({ count2 })} onLive={(count2) => set({ count2 })} />
                </Field>
                <Field label="Spacing">
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
          <Field label="Axis">
            <SelBox field="axis" items={[describeAxis(f.axis)]} placeholder="Pick an edge or line" />
            <AxisButtons value={f.axis} onChange={(axis) => set({ axis })} />
          </Field>
          <div className="row">
            <Field label="Count">
              <ExprInput value={f.count} unit="" integer onCommit={(count) => set({ count })} onLive={(count) => set({ count })} />
            </Field>
            <Field label="Total angle">
              <ExprInput value={f.angle ?? 360} unit="deg" onCommit={(angle) => set({ angle })} onLive={(angle) => set({ angle })} />
            </Field>
          </div>
        </>
      );
    case "mirror":
      return (
        <>
          <SourceField value={f.source} onChange={(source) => set({ source })} />
          <Field label="Mirror plane">
            <SelBox field="plane" items={[describePlane(f.plane)]} placeholder="Pick a plane or face" />
            <PlaneButtons value={f.plane} onChange={(plane) => set({ plane })} />
          </Field>
        </>
      );
    case "boolean":
      return (
        <>
          <Seg value={f.operation} options={[["union", "Union"], ["subtract", "Subtract"], ["intersect", "Intersect"]]} onChange={(operation) => set({ operation })} />
          <Field label="Target part">
            <SelBox field="target" items={f.target ? [partName(f.target, features)] : []} placeholder="Pick the part to keep" />
          </Field>
          <Field label="Tool parts">
            <SelBox field="tools" items={f.tools.map((t) => partName(t, features))} placeholder="Pick tool parts" onRemove={(i) => set({ tools: f.tools.filter((_, j) => j !== i) })} />
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.keepTools} onChange={(e) => set({ keepTools: e.target.checked || undefined })} /> Keep tools
          </label>
        </>
      );
    case "delete":
      return (
        <Field label="Parts">
          <SelBox field="bodies" items={f.bodies.map((b) => partName(b, features))} placeholder="Pick parts" onRemove={(i) => set({ bodies: f.bodies.filter((_, j) => j !== i) })} />
        </Field>
      );
    case "transform": {
      const t = f.translate ?? [0, 0, 0];
      const setT = (i: number, v: Expr) => set({ translate: t.map((x, j) => (j === i ? v : x)) });
      return (
        <>
          <Field label="Parts">
            <SelBox field="bodies" items={f.bodies.map((b) => partName(b, features))} placeholder="Pick parts" onRemove={(i) => set({ bodies: f.bodies.filter((_, j) => j !== i) })} />
          </Field>
          <Field label="Move by (X / Y / Z)">
            <div className="row">
              {[0, 1, 2].map((i) => (
                <div key={i} style={{ flex: 1 }}>
                  <ExprInput value={t[i]} onCommit={(v) => setT(i, v)} onLive={(v) => setT(i, v)} />
                </div>
              ))}
            </div>
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.rotate} onChange={(e) => set({ rotate: e.target.checked ? { axis: { ref: "origin.Z" }, angle: 90 } : undefined })} /> Rotate
          </label>
          {f.rotate ? (
            <>
              <Field label="Axis">
                <SelBox field="axis" items={[describeAxis(f.rotate.axis)]} placeholder="Pick an edge or line" />
                <AxisButtons value={f.rotate.axis} onChange={(axis) => set({ rotate: { ...f.rotate!, axis } })} />
              </Field>
              <Field label="Angle">
                <ExprInput value={f.rotate.angle} unit="deg" onCommit={(angle) => set({ rotate: { ...f.rotate!, angle } })} onLive={(angle) => set({ rotate: { ...f.rotate!, angle } })} />
              </Field>
            </>
          ) : null}
          <label className="checkbox">
            <input type="checkbox" checked={!!f.copy} onChange={(e) => set({ copy: e.target.checked || undefined })} /> Keep original (copy)
          </label>
        </>
      );
    }
    case "plane":
      return (
        <>
          <Field label="Reference">
            <SelBox field="base" items={[describePlane(f.base)]} placeholder="Pick a plane or face" />
            <PlaneButtons value={f.base} onChange={(base) => set({ base })} />
          </Field>
          <Field label="Offset">
            <ExprInput value={f.offset} autoFocus onCommit={(offset) => set({ offset })} onLive={(offset) => set({ offset })} />
          </Field>
          <Field label="Tilt">
            <ExprInput value={f.angle ?? 0} unit="deg" onCommit={(angle) => set({ angle })} onLive={(angle) => set({ angle })} />
          </Field>
        </>
      );
    default:
      return <div className="muted">Nothing to set.</div>;
  }
}
