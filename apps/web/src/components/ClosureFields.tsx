/**
 * Dialog fields of the closures: boxes with a snap or screw lid (presets, sizes, play, the snap or
 * the thread, lid beside or on the box) and snap hooks (sizes, angles, the strain they bend with,
 * where they stand and what they click into). Every change rebuilds the preview straight away;
 * − / + and turn buttons work without a keyboard.
 */
import { ArrowLeftRight, Minus, Plus, RotateCw, ShieldCheck, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Expr, Feature } from "@meercad/schema";
import { BOX, boxDefaults, DEFAULT_CLEARANCE, screwBoxSizes, SNAP_HOOK, SNAP_STRAIN, snapBoxSizes, snapHookStrain } from "@meercad/model";
import { checkInterference } from "../lib/interference";
import { describePlane } from "../lib/topology";
import { partName } from "../lib/features";
import { setDialogField, useApp } from "../store";
import { ExprInput } from "./ExprInput";
import { Examples } from "./GridfinityFields";
import { t, tn } from "../lib/i18n";

type Of<O extends Feature["op"]> = Extract<Feature, { op: O }>;
type SetFn = (patch: Record<string, unknown>) => void;

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="fld">
    <span className="fld-label">{label}</span>
    {children}
  </div>
);

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

/** A box that takes picks in the viewport for `field` while active. */
function PickBox({ field, items, placeholder, onRemove }: { field: string; items: string[]; placeholder: string; onRemove?: (i: number) => void }) {
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

const num = (e: Expr | undefined, fallback: number) => (typeof e === "number" ? e : fallback);
const mm = (v: number) => `${+v.toFixed(1)} mm`;

function Count({ value, min, max, onChange }: { value: Expr | undefined; min: number; max: number; onChange: (v: Expr) => void }) {
  const n = num(value, min);
  return (
    <div className="row" style={{ gap: 4, alignItems: "center" }}>
      <button className="icon-btn sm" aria-label={t("Fewer")} disabled={typeof value === "number" && n <= min} onClick={() => onChange(Math.max(min, n - 1))}>
        <Minus />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ExprInput value={value ?? min} unit="" integer quiet className="count" onCommit={onChange} onLive={onChange} />
      </div>
      <button className="icon-btn sm" aria-label={t("More")} disabled={typeof value === "number" && n >= max} onClick={() => onChange(Math.min(max, n + 1))}>
        <Plus />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- boxes

const BOX_CLEAR: Partial<Of<"box">> = { shape: undefined, depth: undefined, wall: undefined, floor: undefined, corner: undefined, lidThickness: undefined, snap: undefined, lipHeight: undefined, pitch: undefined, neck: undefined, starts: undefined };

const BOX_PRESETS: { label: string; patch: Partial<Of<"box">> }[] = [
  { label: t("Small parts box"), patch: { lid: "snap", width: 80, depth: 60, height: 40 } },
  { label: t("Flat tin"), patch: { lid: "snap", width: 100, depth: 70, height: 20, lipHeight: 4.5 } },
  { label: t("Round snap box"), patch: { lid: "snap", shape: "round", width: 60, height: 30 } },
  { label: t("Jar"), patch: { lid: "screw", width: 70, height: 70 } },
  { label: t("Quick-turn jar"), patch: { lid: "screw", width: 50, height: 60, starts: 2, pitch: 3 } },
];

export function BoxFields({ f, set }: { f: Of<"box">; set: SetFn }) {
  const screw = f.lid === "screw";
  const round = screw || f.shape === "round";
  const pair = (i: number, v: Expr) => set({ position: (f.position ?? [0, 0]).map((x, j) => (j === i ? v : x)) });

  // What the numbers come to (only when they are plain numbers).
  let info = "";
  try {
    const r = boxDefaults(f, (_k, e) => (e === undefined ? undefined : typeof e === "number" ? e : NaN));
    if ([r.width, r.depth, r.height, r.wall, r.clearance].some((v) => !Number.isFinite(v))) info = "";
    else if (screw) {
      const s = screwBoxSizes(r);
      info = t("Opening ⌀{d}, inside {h} deep · closes in {n} turns", { d: mm(2 * s.neckInner), h: mm(s.depthInside), n: +s.turns.toFixed(1) });
    } else {
      const s = snapBoxSizes(r);
      info = round ? t("Inside ⌀{d}, {h} deep", { d: mm(s.inner[0]), h: mm(s.depthInside) }) : t("Inside {w} × {d}, {h} deep", { w: mm(s.inner[0]), d: mm(s.inner[1]), h: mm(s.depthInside) });
    }
  } catch (e) {
    info = e instanceof Error ? e.message : "";
  }

  return (
    <>
      <Examples items={BOX_PRESETS} onPick={(patch) => set({ ...BOX_CLEAR, ...patch })} />
      <Seg
        value={f.lid}
        options={[["snap", t("Snap lid")], ["screw", t("Screw lid")]]}
        onChange={(lid) => set(lid === "screw" ? { lid, shape: undefined, depth: undefined, corner: undefined, snap: undefined, lipHeight: undefined, notch: undefined } : { lid, pitch: undefined, neck: undefined, starts: undefined })}
      />
      {!screw ? <Seg value={f.shape ?? "rect"} options={[["rect", t("Rectangular")], ["round", t("Round")]]} onChange={(shape) => set({ shape: shape === "rect" ? undefined : shape, depth: undefined, corner: undefined })} /> : null}
      <div className="row">
        <Field label={round ? t("Diameter") : t("Width")}>
          <ExprInput value={f.width} onCommit={(width) => set({ width })} onLive={(width) => set({ width })} />
        </Field>
        {!round ? (
          <Field label={t("Depth")}>
            <ExprInput value={f.depth ?? f.width} onCommit={(depth) => set({ depth })} onLive={(depth) => set({ depth })} />
          </Field>
        ) : null}
        <Field label={t("Height")}>
          <ExprInput value={f.height} onCommit={(height) => set({ height })} onLive={(height) => set({ height })} />
        </Field>
      </div>
      <p className="muted small">{info}</p>
      <div className="row">
        <Field label={t("Wall")}>
          <ExprInput value={f.wall} placeholder={String(BOX.wall)} onCommit={(wall) => set({ wall })} />
        </Field>
        <Field label={t("Play")}>
          <ExprInput value={f.clearance} placeholder={String(DEFAULT_CLEARANCE)} onCommit={(clearance) => set({ clearance })} />
        </Field>
        {!round ? (
          <Field label={t("Corner radius")}>
            <ExprInput value={f.corner} placeholder={String(BOX.corner)} onCommit={(corner) => set({ corner })} />
          </Field>
        ) : null}
      </div>
      {screw ? (
        <div className="row">
          <Field label={t("Pitch")}>
            <ExprInput value={f.pitch} placeholder={String(BOX.pitch)} onCommit={(pitch) => set({ pitch })} />
          </Field>
          <Field label={t("Neck height")}>
            <ExprInput value={f.neck} placeholder={String(BOX.neck)} onCommit={(neck) => set({ neck })} />
          </Field>
          <Field label={t("Starts")}>
            <Count value={f.starts ?? 1} min={1} max={4} onChange={(starts) => set({ starts: starts === 1 ? undefined : starts })} />
          </Field>
        </div>
      ) : (
        <>
          <div className="row">
            <Field label={t("Snap")}>
              <ExprInput value={f.snap} placeholder={String(BOX.snap)} onCommit={(snap) => set({ snap })} />
            </Field>
            <Field label={t("Lip height")}>
              <ExprInput value={f.lipHeight} placeholder={String(BOX.lipHeight)} onCommit={(lipHeight) => set({ lipHeight })} />
            </Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={f.notch !== false} onChange={(e) => set({ notch: e.target.checked ? undefined : false })} /> {t("Notch to open it with a finger nail")}
          </label>
        </>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={f.layout === "closed"} onChange={(e) => set({ layout: e.target.checked ? "closed" : undefined })} /> {t("Lid on the box (to look at it closed)")}
      </label>
      {f.layout === "closed" ? (
        <button className="btn" onClick={() => void checkInterference()}>
          <ShieldCheck /> {t("Check fit")}
        </button>
      ) : null}
      <Field label={t("On")}>
        <PickBox field="plane" items={[describePlane(f.plane ?? { ref: "origin.XY" })]} placeholder={t("Tap a plane or flat face where it stands")} />
      </Field>
      <div className="row">
        <Field label={t("Position x")}>
          <ExprInput value={f.position?.[0] ?? 0} onCommit={(v) => pair(0, v)} />
        </Field>
        <Field label={t("Position y")}>
          <ExprInput value={f.position?.[1] ?? 0} onCommit={(v) => pair(1, v)} />
        </Field>
      </div>
      <p className="muted small">
        {screw
          ? t("Box and cap are two parts. The thread has 45° flanks, so both print without supports: the jar upright, the cap upside down as it lies.")
          : t("Box and lid are two parts. The lid's lip clicks into a groove inside the rim; a larger snap holds tighter. Print the lid as it lies, top down.")}{" "}
        {t("Play is the gap per side; raise it if the lid is too tight on your printer.")}
      </p>
    </>
  );
}

// ---------------------------------------------------------------- snap hooks

const HOOK_PRESETS: { label: string; patch: Partial<Of<"snap_hook">> }[] = [
  { label: t("Holds for good"), patch: { retainAngle: undefined, insertAngle: undefined } },
  { label: t("Can be opened"), patch: { retainAngle: 45, insertAngle: undefined } },
  { label: t("Small"), patch: { length: 6, thickness: 1.2, width: 4, overhang: 0.5 } },
  { label: t("Sturdy"), patch: { length: 16, thickness: 2.4, width: 10, overhang: 1.2 } },
];

/** How much a hook bends, and for which plastics that is fine. */
function strainText(f: Of<"snap_hook">): { text: string; ok: boolean } | null {
  const h = { length: num(f.length, SNAP_HOOK.length), thickness: num(f.thickness, SNAP_HOOK.thickness), overhang: num(f.overhang, SNAP_HOOK.overhang) };
  if ([f.length, f.thickness, f.overhang].some((e) => e !== undefined && typeof e !== "number")) return null;
  const e = snapHookStrain(h);
  const pct = `${(e * 100).toFixed(1)} %`;
  const fits = (["PLA", "PETG", "PA"] as const).filter((m) => e <= SNAP_STRAIN[m]!);
  if (fits.length === 3) return { text: t("Bends {e} when it snaps: fine in PLA, PETG and nylon.", { e: pct }), ok: true };
  if (fits.length) return { text: t("Bends {e} when it snaps: too much for PLA; fine in {list}.", { e: pct, list: fits.map((m) => (m === "PA" ? t("nylon") : m)).join(", ") }), ok: false };
  return { text: t("Bends {e} when it snaps: it may break. Make it longer or thinner, or the overhang smaller.", { e: pct }), ok: false };
}

export function SnapHookFields({ f, set }: { f: Of<"snap_hook">; set: SetFn }) {
  const features = useApp((s) => s.doc.features);
  const strain = strainText(f);
  const angle = num(f.angle, 0);
  return (
    <>
      <Examples items={HOOK_PRESETS} onPick={(patch) => set(patch)} />
      <div className="row">
        <Field label={t("Length")}>
          <ExprInput value={f.length} placeholder={String(SNAP_HOOK.length)} onCommit={(length) => set({ length })} onLive={(length) => set({ length })} />
        </Field>
        <Field label={t("Thickness")}>
          <ExprInput value={f.thickness} placeholder={String(SNAP_HOOK.thickness)} onCommit={(thickness) => set({ thickness })} onLive={(thickness) => set({ thickness })} />
        </Field>
        <Field label={t("Width")}>
          <ExprInput value={f.width} placeholder={String(SNAP_HOOK.width)} onCommit={(width) => set({ width })} />
        </Field>
      </div>
      <div className="row">
        <Field label={t("Overhang")}>
          <ExprInput value={f.overhang} placeholder={String(SNAP_HOOK.overhang)} onCommit={(overhang) => set({ overhang })} onLive={(overhang) => set({ overhang })} />
        </Field>
        <Field label={t("Lead-in")}>
          <ExprInput value={f.insertAngle} unit="deg" placeholder={String(SNAP_HOOK.insertAngle)} onCommit={(insertAngle) => set({ insertAngle })} />
        </Field>
        <Field label={t("Holding angle")}>
          <ExprInput value={f.retainAngle} unit="deg" placeholder={String(SNAP_HOOK.retainAngle)} onCommit={(retainAngle) => set({ retainAngle })} />
        </Field>
      </div>
      {strain ? <div className={`callout ${strain.ok ? "info" : "warn"}`}>{strain.text}</div> : null}
      <Field label={t("Face")}>
        <div className="row">
          <div style={{ flex: 1 }}>
            <PickBox field="plane" items={[describePlane(f.plane)]} placeholder={t("Tap a flat face where the hook stands")} />
          </div>
          <button className={`icon-btn ${f.flip ? "active" : ""}`} title={t("Turn the other way")} aria-label={t("Turn the other way")} onClick={() => set({ flip: f.flip ? undefined : true })}>
            <ArrowLeftRight />
          </button>
        </div>
      </Field>
      <Field label={t("Places ({n})", { n: f.points.length })}>
        <PickBox field="points" items={f.points.length ? [tn(f.points.length, "{n} hook: tap the face to add", "{n} hooks: tap the face to add")] : []} placeholder={t("Tap the face to place hooks")} />
        {f.points.map((pt, i) => (
          <div className="row" key={i}>
            {[0, 1].map((k) => (
              <div key={k} style={{ flex: 1 }}>
                <ExprInput value={pt[k]} onCommit={(v) => set({ points: f.points.map((q, j) => (j === i ? (k === 0 ? [v, q[1]] : [q[0], v]) : q)) })} />
              </div>
            ))}
            <button className="icon-btn sm" title={t("Remove")} aria-label={t("Remove")} onClick={() => set({ points: f.points.filter((_, j) => j !== i) })}>
              <X />
            </button>
          </div>
        ))}
      </Field>
      <Field label={t("Barb points")}>
        <div className="row" style={{ alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <ExprInput value={f.angle ?? 0} unit="deg" onCommit={(a) => set({ angle: a === 0 ? undefined : a })} />
          </div>
          <button className="icon-btn" title={t("Turn by 90°")} aria-label={t("Turn by 90°")} onClick={() => set({ angle: (angle + 90) % 360 || undefined })}>
            <RotateCw />
          </button>
        </div>
      </Field>
      <Field label={t("Clicks into")}>
        <PickBox
          field="catchIn"
          items={(f.catchIn ?? []).map((id) => partName(id, features))}
          placeholder={t("Tap the part the hook clicks into (optional)")}
          onRemove={(i) => {
            const catchIn = (f.catchIn ?? []).filter((_, j) => j !== i);
            set({ catchIn: catchIn.length ? catchIn : undefined });
          }}
        />
      </Field>
      {f.catchIn?.length ? (
        <Field label={t("Play round the window")}>
          <ExprInput value={f.clearance} placeholder={String(DEFAULT_CLEARANCE)} onCommit={(clearance) => set({ clearance })} />
        </Field>
      ) : null}
      <label className="checkbox">
        <input type="checkbox" checked={f.mode === "new_body"} onChange={(e) => set({ mode: e.target.checked ? "new_body" : undefined })} /> {t("Hooks as a part of their own")}
      </label>
      <p className="muted small">{t("Hooks stand on the face and join its part. Model the parts closed, place the hook where its barb reaches into the other part's wall, and pick that part: its window is cut there, with play.")}</p>
    </>
  );
}
