import { Check, Cog, Film, Link2, Pause, Pencil, Play, Plus, RotateCcw, ShieldCheck, Trash2, X } from "lucide-react";
import { useState } from "react";
import { download } from "./io";
import { jointRange, renderMotionGif } from "../lib/render";
import type { Joint } from "@meercad/schema";
import { partName } from "../lib/features";
import { motion } from "@meercad/model";
import { checkClearance, currentMechanism, swingRanges, deleteJoint, editJoint, jointValues, jointsFromGears, playJoint, restPose, saveJoint, setJointField, setJointValue, startJoint, stopPlaying, updateJointDraft, useMotion, wantedClearance, type JointField } from "../lib/mechanism";
import { describeEdgeSelector, describeFaceSelector } from "../lib/topology";
import { toast, useApp } from "../store";
import { ExprInput } from "./ExprInput";
import { t, tn } from "../lib/i18n";
import { usePack } from "../lib/premium";

const TYPES: [Joint["type"], string, string?][] = [
  ["revolute", t("joint::Turn")],
  ["slider", t("joint::Slide")],
  ["cylindrical", t("joint::Both"), t("Turn and slide on one axis, like a pin in a guide")],
  ["fixed", t("joint::Fixed")],
];

function anchorText(j: Joint): string {
  const a = j.anchor;
  if ("axis" in a) return t("{axis} axis", { axis: a.axis.ref.slice(7) });
  if ("gear" in a) return t("Axis of {gear}", { gear: a.gear });
  if ("axisOf" in a) return describeFaceSelector(a.axisOf);
  return describeEdgeSelector(a.edge);
}

/** An angle as −180° … 180°. */
const wrapDegrees = (d: number) => {
  const w = d - 360 * Math.round(d / 360);
  return w <= -180 ? w + 360 : w;
};
/** Rounded for the panel, without a "-0". */
const shown = (x: number, digits: number) => {
  const s = x.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
};

/** Joints panel: the joints with their values, adding and editing joints; parts can be dragged while it is open. */
export function MotionPanel() {
  const open = useMotion((s) => s.open);
  const draft = useMotion((s) => s.draft);
  const free = useMotion((s) => s.free);
  const playing = useMotion((s) => s.playing);
  // Without the pack the joints of a design someone shared are there to look at and move, not to change.
  const canEdit = usePack("mechanics");
  const [filming, setFilming] = useState<string | null>(null);
  const film = async (id: string) => {
    setFilming(id);
    try {
      const [from, to] = jointRange(id);
      const gif = await renderMotionGif(id, from, to);
      const project = useApp.getState().project?.name ?? "meerCAD";
      download(`${project} ${id}.gif`, gif as BlobPart);
    } catch (e) {
      toast(t("Could not make the video: {error}", { error: (e as Error).message }), "error");
    } finally {
      setFilming(null);
    }
  };
  useMotion((s) => s.tick);
  const doc = useApp((s) => s.doc);
  useApp((s) => s.output);
  const dialog = useApp((s) => !!s.dialog);
  if (!open || dialog) return null;
  const features = doc.features;
  const { mech, problems } = currentMechanism();
  void free;
  const values = jointValues();
  // In a linkage some joints only swing part of a turn (a crank-rocker's rocker): their sliders end there.
  const swing = swingRanges();
  const joints = doc.mechanism?.joints ?? [];
  const couplings = doc.mechanism?.couplings ?? [];
  const gearsWithout = (useApp.getState().output?.report.gears ?? []).filter((g) => !joints.some((j) => j.a === g.id)).length;
  const name = (id: string) => (id === "ground" ? t("Ground") : partName(id, features));
  const close = () => useMotion.setState({ open: false, draft: null });
  return (
    <div className="dialog motion-panel">
      <div className="dialog-head">
        <Link2 className="ficon" />
        <h3>{draft && canEdit ? (draft.isNew ? t("New joint") : t("Edit joint")) : t("Joints")}</h3>
        <button className="icon-btn sm" title={t("Close")} onClick={close}>
          <X />
        </button>
      </div>
      <div className="dialog-body">
        {draft && canEdit ? (
          <JointForm />
        ) : (
          <>
            {joints.length ? <p className="muted small">{t("Drag a part to move it. The model itself stays as drawn.")}</p> : <p className="muted small">{t("Joints let parts turn or slide against each other, from where they were drawn. Add one, then drag the part.")}</p>}
            {joints.map((j) => {
              const driven = couplings.find((c) => c.driven === j.id);
              // A cylindrical joint has a value for its turn and one for its slide.
              const parts: [string, "revolute" | "slider", string?][] =
                j.type === "cylindrical" ? [[`${j.id}${motion.TURN}`, "revolute", t("joint::Turn")], [`${j.id}${motion.SLIDE}`, "slider", t("joint::Slide")]] : j.type === "fixed" ? [] : [[j.id, j.type]];
              return (
                <div key={j.id} className="joint-row">
                  <div className="joint-head">
                    <b>{j.name ?? j.id}</b>
                    <span className="muted small">
                      {t("{part} on {base}", { part: name(j.a), base: name(j.b) })}
                    </span>
                    {j.type !== "fixed" && !problems[j.id] ? (
                      <button className={`icon-btn sm ${filming === parts[0]![0] ? "active" : ""}`} title={t("Save a video (GIF) of this motion")} disabled={!!filming} onClick={() => void film(parts[0]![0])}>
                        <Film />
                      </button>
                    ) : null}
                    {canEdit ? (
                      <>
                        <button className="icon-btn sm" title={t("Edit")} onClick={() => editJoint(j.id)}>
                          <Pencil />
                        </button>
                        <button className="icon-btn sm" title={t("Delete")} onClick={() => deleteJoint(j.id)}>
                          <Trash2 />
                        </button>
                      </>
                    ) : null}
                  </div>
                  {problems[j.id] ? (
                    <div className="callout warn">{problems[j.id]}</div>
                  ) : j.type === "fixed" ? (
                    <span className="muted small">{t("Held fixed")}</span>
                  ) : (
                    parts.map(([id, kind, label]) => {
                      const v = values[id];
                      const limits = mech.joint(id)?.limits ?? swing[id] ?? undefined;
                      const unit = kind === "revolute" ? "°" : " mm";
                      const [lo, hi] = limits ?? (kind === "revolute" ? [-180, 180] : [-50, 50]);
                      // A turn without limits keeps counting inside; slider and number show it as -180° to 180°.
                      const turning = kind === "revolute" && !limits;
                      const seen = turning ? wrapDegrees(v ?? 0) : (v ?? 0);
                      return (
                        <div key={id} className="row joint-value">
                          {label ? <span className="joint-part muted small">{label}</span> : null}
                          <button className={`icon-btn sm ${playing === id ? "active" : ""}`} title={playing === id ? t("Stop") : t("Play: move it back and forth")} onClick={() => (playing === id ? stopPlaying() : playJoint(id))}>
                            {playing === id ? <Pause /> : <Play />}
                          </button>
                          <input
                            type="range"
                            min={turning ? -180 : Math.max(lo, (v ?? 0) - 720)}
                            max={turning ? 180 : Math.min(hi, (v ?? 0) + 720)}
                            step={kind === "revolute" ? 1 : 0.1}
                            value={seen}
                            // A free turn goes on from where it is: 179° → -179° is two degrees on, not a turn back.
                            onChange={(e) => (stopPlaying(), setJointValue(id, turning ? (v ?? 0) + wrapDegrees(Number(e.target.value) - seen) : Number(e.target.value)))}
                          />
                          <span className="joint-num">
                            {shown(seen, kind === "revolute" ? 0 : 1)}
                            {unit}
                          </span>
                        </div>
                      );
                    })
                  )}
                  {driven ? <span className="muted small">{t("Follows {driver} × {ratio}", { driver: driven.driver, ratio: String(driven.ratio) })}</span> : null}
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
            {mech.errors.filter((e) => !e.includes("moves in two joints")).map((e) => (
              <div key={e} className="callout warn">
                {e}
              </div>
            ))}
            {canEdit ? null : <p className="muted small">{t("Changing joints needs the Mechanics pack.")}</p>}
            <div className="row">
              {canEdit ? (
                <button className="btn" onClick={startJoint}>
                  <Plus /> {t("Add joint")}
                </button>
              ) : null}
              {joints.length ? (
                <button className="btn" onClick={restPose} title={t("Back to where the parts were drawn")}>
                  <RotateCcw /> {t("Rest position")}
                </button>
              ) : null}
            </div>
            {joints.length ? <ClearanceResults /> : null}
            {gearsWithout && canEdit ? (
              <button
                className="btn"
                onClick={() => {
                  const n = jointsFromGears();
                  if (n) toast(tn(n, "{n} gear joint added: drag a gear to turn it", "{n} gear joints added: drag a gear to turn it"));
                }}
              >
                <Cog /> {tn(gearsWithout, "Joints for {n} gear", "Joints for {n} gears")}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Gaps between moving parts in the pose shown: red when they overlap or touch, amber below the wanted print clearance. */
function ClearanceResults() {
  const check = useMotion((s) => s.check);
  const free = useMotion((s) => s.free);
  const tick = useMotion((s) => s.tick);
  const features = useApp((s) => s.doc.features);
  const want = wantedClearance();
  const stale = check && !check.running && JSON.stringify(check.free) !== JSON.stringify({ ...free, tick });
  const name = (id: string) => partName(id, features);
  return (
    <>
      <button className="btn" onClick={() => void checkClearance()} disabled={check?.running}>
        <ShieldCheck /> {check?.running ? t("Checking…") : stale ? t("Check again in this position") : t("Check clearance")}
      </button>
      {check && !check.running ? (
        <div className={`clearance-list ${stale ? "stale" : ""}`}>
          {check.error ? <div className="callout err">{check.error}</div> : null}
          {!check.error && !check.results.length ? <span className="muted small">{t("No part comes near another.")}</span> : null}
          {check.results.map((r) => {
            const level = r.overlap > 1e-3 || r.distance < 1e-4 ? "bad" : r.distance < want ? "warn" : "ok";
            return (
              <div key={`${r.a}|${r.b}`} className={`clearance-row ${level}`}>
                <span className="dot" />
                <span className="pair">
                  {name(r.a)} · {name(r.b)}
                </span>
                <b>{r.overlap > 1e-3 ? t("overlap {volume} mm³", { volume: r.overlap.toFixed(r.overlap < 10 ? 2 : 0) }) : r.distance < 1e-4 ? t("touching") : `${r.distance.toFixed(2)} mm`}</b>
              </div>
            );
          })}
          {check.results.length ? <span className="muted small">{t("Wanted for printing in place: at least {want} mm.", { want })}</span> : null}
        </div>
      ) : null}
    </>
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
        <span className="placeholder">{active ? t("{action} in the viewport…", { action: placeholder }) : placeholder}</span>
      )}
    </div>
  );
}

function JointForm() {
  const draft = useMotion((s) => s.draft)!;
  const features = useApp((s) => s.doc.features);
  const j = draft.joint;
  const name = (id: string) => (id === "ground" ? t("Ground") : id ? partName(id, features) : "");
  const unit = j.type === "slider" ? "mm" : "deg";
  const turns = j.type === "revolute" || j.type === "cylindrical";
  return (
    <>
      <div className="fld">
        <span className="fld-label">{t("Moving part")}</span>
        <PickBox field="a" text={name(j.a)} placeholder={t("Tap the part that moves")} />
      </div>
      <div className="fld">
        <span className="fld-label">{t("Hangs on")}</span>
        <PickBox field="b" text={name(j.b)} placeholder={t("Tap the part it hangs on")} />
        <button className={`btn ${j.b === "ground" ? "primary" : ""}`} onClick={() => updateJointDraft({ b: "ground" }, "anchor")}>
          {t("Ground (stays put)")}
        </button>
      </div>
      <div className="fld">
        <span className="fld-label">{t("Axis")}</span>
        <PickBox field="anchor" text={anchorText(j)} placeholder={t("Tap a hole, a shaft or an edge")} />
        <div className="row">
          {(["origin.X", "origin.Y", "origin.Z"] as const).map((r) => (
            <button key={r} className={`btn ${"axis" in j.anchor && j.anchor.axis.ref === r ? "primary" : ""}`} style={{ flex: 1, height: 26 }} onClick={() => updateJointDraft({ anchor: { axis: { ref: r } } }, null)}>
              {r.slice(7)}
            </button>
          ))}
        </div>
      </div>
      <div className="fld">
        <span className="fld-label">{t("Motion")}</span>
        <div className="segmented">
          {TYPES.map(([type, label, hint]) => (
            <button key={type} className={type === j.type ? "on" : ""} title={hint} onClick={() => updateJointDraft({ type, ...(type === "fixed" ? { limits: undefined } : {}), ...(type !== "cylindrical" ? { travel: undefined } : {}) })}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {j.type !== "fixed" ? (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={!!j.limits} onChange={(e) => updateJointDraft({ limits: e.target.checked ? (turns ? [0, 90] : [0, 20]) : undefined })} /> {j.type === "cylindrical" ? t("Limits of the turn") : t("Limits")}
          </label>
          {j.limits ? (
            <div className="row">
              <div className="fld" style={{ flex: 1 }}>
                <span className="fld-label">{t("From")}</span>
                <ExprInput value={j.limits[0]} unit={unit} onCommit={(v) => updateJointDraft({ limits: [v, j.limits![1]] })} />
              </div>
              <div className="fld" style={{ flex: 1 }}>
                <span className="fld-label">{t("To")}</span>
                <ExprInput value={j.limits[1]} unit={unit} onCommit={(v) => updateJointDraft({ limits: [j.limits![0], v] })} />
              </div>
            </div>
          ) : null}
          {j.type === "cylindrical" ? (
            <>
              <label className="checkbox">
                <input type="checkbox" checked={!!j.travel} onChange={(e) => updateJointDraft({ travel: e.target.checked ? [0, 20] : undefined })} /> {t("Limits of the slide")}
              </label>
              {j.travel ? (
                <div className="row">
                  <div className="fld" style={{ flex: 1 }}>
                    <span className="fld-label">{t("From")}</span>
                    <ExprInput value={j.travel[0]} unit="mm" onCommit={(v) => updateJointDraft({ travel: [v, j.travel![1]] })} />
                  </div>
                  <div className="fld" style={{ flex: 1 }}>
                    <span className="fld-label">{t("To")}</span>
                    <ExprInput value={j.travel[1]} unit="mm" onCommit={(v) => updateJointDraft({ travel: [j.travel![0], v] })} />
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      <div className="fld">
        <span className="fld-label">{t("Name")}</span>
        <input className="field" value={j.name ?? ""} placeholder={j.id} onChange={(e) => updateJointDraft({ name: e.target.value || undefined })} />
      </div>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="cancel-btn" title={t("Cancel")} onClick={() => useMotion.setState({ draft: null })}>
          <X />
        </button>
        <button className="ok-btn" title={t("Save joint")} onClick={saveJoint} disabled={!j.a}>
          <Check />
        </button>
      </div>
      {!draft.isNew ? null : <p className="muted small">{t("The part keeps where it was drawn as its rest position.")}</p>}
    </>
  );
}
