import { Check, Cog, Link2, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { Joint } from "@meercad/schema";
import { partName } from "../lib/features";
import { currentMechanism, deleteJoint, editJoint, jointsFromGears, saveJoint, setJointField, setJointValue, startJoint, updateJointDraft, useMotion, type JointField } from "../lib/mechanism";
import { describeEdgeSelector, describeFaceSelector } from "../lib/topology";
import { toast, useApp } from "../store";
import { ExprInput } from "./ExprInput";

const TYPES: [Joint["type"], string][] = [
  ["revolute", "Turn"],
  ["slider", "Slide"],
  ["fixed", "Fixed"],
];

function anchorText(j: Joint): string {
  const a = j.anchor;
  if ("axis" in a) return `${a.axis.ref.slice(7)} axis`;
  if ("gear" in a) return `Axis of ${a.gear}`;
  if ("axisOf" in a) return describeFaceSelector(a.axisOf);
  return describeEdgeSelector(a.edge);
}

/** Joints panel: the joints with their values, adding and editing joints; parts can be dragged while it is open. */
export function MotionPanel() {
  const open = useMotion((s) => s.open);
  const draft = useMotion((s) => s.draft);
  const free = useMotion((s) => s.free);
  const doc = useApp((s) => s.doc);
  useApp((s) => s.output);
  const dialog = useApp((s) => !!s.dialog);
  if (!open || dialog) return null;
  const features = doc.features;
  const { mech, problems } = currentMechanism();
  const values = mech.values(free);
  const joints = doc.mechanism?.joints ?? [];
  const couplings = doc.mechanism?.couplings ?? [];
  const gearsWithout = (useApp.getState().output?.report.gears ?? []).filter((g) => !joints.some((j) => j.a === g.id)).length;
  const name = (id: string) => (id === "ground" ? "Ground" : partName(id, features));
  const close = () => useMotion.setState({ open: false, draft: null });
  return (
    <div className="dialog motion-panel">
      <div className="dialog-head">
        <Link2 className="ficon" />
        <h3>{draft ? (draft.isNew ? "New joint" : "Edit joint") : "Joints"}</h3>
        <button className="icon-btn sm" title="Close" onClick={close}>
          <X />
        </button>
      </div>
      <div className="dialog-body">
        {draft ? (
          <JointForm />
        ) : (
          <>
            {joints.length ? <p className="muted small">Drag a part to move it. The model itself stays as drawn.</p> : <p className="muted small">Joints let parts turn or slide against each other, from where they were drawn. Add one, then drag the part.</p>}
            {joints.map((j) => {
              const v = values[j.id];
              const limits = mech.joint(j.id)?.limits;
              const driven = couplings.find((c) => c.driven === j.id);
              const unit = j.type === "revolute" ? "°" : " mm";
              const [lo, hi] = limits ?? (j.type === "revolute" ? [-180, 180] : [-50, 50]);
              return (
                <div key={j.id} className="joint-row">
                  <div className="joint-head">
                    <b>{j.name ?? j.id}</b>
                    <span className="muted small">
                      {name(j.a)} on {name(j.b)}
                    </span>
                    <button className="icon-btn sm" title="Edit" onClick={() => editJoint(j.id)}>
                      <Pencil />
                    </button>
                    <button className="icon-btn sm" title="Delete" onClick={() => deleteJoint(j.id)}>
                      <Trash2 />
                    </button>
                  </div>
                  {problems[j.id] ? (
                    <div className="callout warn">{problems[j.id]}</div>
                  ) : j.type === "fixed" ? (
                    <span className="muted small">Held fixed</span>
                  ) : (
                    <div className="row joint-value">
                      <input type="range" min={Math.max(lo, (v ?? 0) - 720)} max={Math.min(hi, (v ?? 0) + 720)} step={j.type === "revolute" ? 1 : 0.1} value={v ?? 0} onChange={(e) => setJointValue(j.id, Number(e.target.value))} />
                      <span className="joint-num">
                        {(v ?? 0).toFixed(j.type === "revolute" ? 0 : 1)}
                        {unit}
                      </span>
                    </div>
                  )}
                  {driven ? <span className="muted small">Follows {driven.driver} × {String(driven.ratio)}</span> : null}
                </div>
              );
            })}
            {Object.entries(problems)
              .filter(([id]) => couplings.some((c) => c.id === id))
              .map(([id, p]) => (
                <div key={id} className="callout warn">
                  {id}: {p}
                </div>
              ))}
            {mech.errors.map((e) => (
              <div key={e} className="callout warn">
                {e}
              </div>
            ))}
            <div className="row">
              <button className="btn" onClick={startJoint}>
                <Plus /> Add joint
              </button>
              {joints.length ? (
                <button className="btn" onClick={() => useMotion.setState({ free: {} })} title="Back to where the parts were drawn">
                  <RotateCcw /> Rest position
                </button>
              ) : null}
            </div>
            {gearsWithout ? (
              <button
                className="btn"
                onClick={() => {
                  const n = jointsFromGears();
                  if (n) toast(`${n} gear joint${n > 1 ? "s" : ""} added: drag a gear to turn it`);
                }}
              >
                <Cog /> Joints for {gearsWithout} gear{gearsWithout > 1 ? "s" : ""}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function PickBox({ field, text, placeholder }: { field: JointField; text: string; placeholder: string }) {
  const active = useMotion((s) => s.draft?.field === field);
  return (
    <div className={`selbox ${active ? "active" : ""}`} role="button" tabIndex={0} onClick={() => setJointField(active ? null : field)}>
      {text ? (
        <span className="chip">
          <span>{text}</span>
        </span>
      ) : (
        <span className="placeholder">{active ? `${placeholder} in the viewport…` : placeholder}</span>
      )}
    </div>
  );
}

function JointForm() {
  const draft = useMotion((s) => s.draft)!;
  const features = useApp((s) => s.doc.features);
  const j = draft.joint;
  const name = (id: string) => (id === "ground" ? "Ground" : id ? partName(id, features) : "");
  const unit = j.type === "slider" ? "mm" : "deg";
  return (
    <>
      <div className="fld">
        <span className="fld-label">Moving part</span>
        <PickBox field="a" text={name(j.a)} placeholder="Tap the part that moves" />
      </div>
      <div className="fld">
        <span className="fld-label">Hangs on</span>
        <PickBox field="b" text={name(j.b)} placeholder="Tap the part it hangs on" />
        <button className={`btn ${j.b === "ground" ? "primary" : ""}`} onClick={() => updateJointDraft({ b: "ground" }, "anchor")}>
          Ground (stays put)
        </button>
      </div>
      <div className="fld">
        <span className="fld-label">Axis</span>
        <PickBox field="anchor" text={anchorText(j)} placeholder="Tap a hole, a shaft or an edge" />
        <div className="row">
          {(["origin.X", "origin.Y", "origin.Z"] as const).map((r) => (
            <button key={r} className={`btn ${"axis" in j.anchor && j.anchor.axis.ref === r ? "primary" : ""}`} style={{ flex: 1, height: 26 }} onClick={() => updateJointDraft({ anchor: { axis: { ref: r } } }, null)}>
              {r.slice(7)}
            </button>
          ))}
        </div>
      </div>
      <div className="fld">
        <span className="fld-label">Motion</span>
        <div className="segmented">
          {TYPES.map(([t, label]) => (
            <button key={t} className={t === j.type ? "on" : ""} onClick={() => updateJointDraft({ type: t, ...(t === "fixed" ? { limits: undefined } : {}) })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {j.type !== "fixed" ? (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={!!j.limits} onChange={(e) => updateJointDraft({ limits: e.target.checked ? (j.type === "revolute" ? [0, 90] : [0, 20]) : undefined })} /> Limits
          </label>
          {j.limits ? (
            <div className="row">
              <div className="fld" style={{ flex: 1 }}>
                <span className="fld-label">From</span>
                <ExprInput value={j.limits[0]} unit={unit} onCommit={(v) => updateJointDraft({ limits: [v, j.limits![1]] })} />
              </div>
              <div className="fld" style={{ flex: 1 }}>
                <span className="fld-label">To</span>
                <ExprInput value={j.limits[1]} unit={unit} onCommit={(v) => updateJointDraft({ limits: [j.limits![0], v] })} />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      <div className="fld">
        <span className="fld-label">Name</span>
        <input className="field" value={j.name ?? ""} placeholder={j.id} onChange={(e) => updateJointDraft({ name: e.target.value || undefined })} />
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="cancel-btn" title="Cancel" onClick={() => useMotion.setState({ draft: null })}>
          <X />
        </button>
        <button className="ok-btn" title="Save joint" onClick={saveJoint} disabled={!j.a}>
          <Check />
        </button>
      </div>
      {!draft.isNew ? null : <p className="muted small">The part keeps where it was drawn as its rest position.</p>}
    </>
  );
}
