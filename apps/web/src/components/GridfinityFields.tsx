/**
 * Dialog fields of the storage generators: Gridfinity bins and baseplates (presets, sizes in grid
 * units, compartments, holes, placement) and printable labels (symbol, text, style, colours).
 * Every change rebuilds the preview straight away; − / + buttons step counts without typing.
 */
import { Minus, Plus, ShieldCheck } from "lucide-react";
import { checkInterference } from "../lib/interference";
import type { ReactNode } from "react";
import type { Expr, Feature } from "@meercad/schema";
import { binSize, compartments, drawerFit, GRIDFINITY, LABEL_SYMBOL_NAMES, LABEL_SYMBOLS, labelSymbol, type LabelSymbolKind } from "@meercad/model";
import { describePlane } from "../lib/topology";
import { featureName } from "../lib/features";
import { setDialogField, useApp } from "../store";
import { ExprInput } from "./ExprInput";
import { t } from "../lib/i18n";

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

export function PlaneBox({ placeholder, value }: { placeholder: string; value: string }) {
  const active = useApp((s) => s.dialog?.field === "plane");
  return (
    <div className={`selbox ${active ? "active" : ""}`} onClick={() => setDialogField(active ? null : "plane")} role="button" tabIndex={0}>
      {active ? (
        <span className="placeholder">{t("{what} in the viewport…", { what: placeholder })}</span>
      ) : (
        <span className="chip" title={value}>
          <span>{value}</span>
        </span>
      )}
    </div>
  );
}

const num = (e: Expr | undefined, fallback: number) => (typeof e === "number" ? e : fallback);

/** A whole number with − and + beside it (no keyboard needed). */
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

const mm = (v: number) => `${+v.toFixed(1)} mm`;

interface Preset {
  label: string;
  patch: Partial<Of<"gridfinity">>;
}

const CLEAR: Partial<Of<"gridfinity">> = { units: [1, 1], height: undefined, dividers: undefined, scoop: undefined, tab: undefined, lip: undefined, solid: undefined, magnets: undefined, screws: undefined, drawer: undefined, floor: undefined, wall: undefined };

/** Ready-made starting points: a click sets every value; each stays editable. */
const PRESETS: Preset[] = [
  { label: t("1×1 bin"), patch: { kind: "bin", units: [1, 1], height: 3 } },
  { label: t("2×1 bin, 3 dividers"), patch: { kind: "bin", units: [2, 1], height: 3, dividers: [3, 0], scoop: 10, tab: {} } },
  { label: t("3×2 bin, 6 compartments"), patch: { kind: "bin", units: [3, 2], height: 6, dividers: [2, 1], scoop: 15, tab: {} } },
  { label: t("Screw sorter 2×2"), patch: { kind: "bin", units: [2, 2], height: 3, dividers: [3, 3], scoop: 6 } },
  { label: t("Baseplate 4×3, magnets"), patch: { kind: "baseplate", units: [4, 3], magnets: true } },
  { label: t("Baseplate for a drawer"), patch: { kind: "baseplate", units: [1, 1], drawer: [400, 300] } },
];

export function GridfinityFields({ f, set }: { f: Of<"gridfinity">; set: SetFn }) {
  const features = useApp((s) => s.doc.features);
  const plates = features.filter((x): x is Of<"gridfinity"> => x.op === "gridfinity" && x.kind === "baseplate" && x.id !== f.id);
  const bin = f.kind === "bin";
  const units: [number, number] = [num(f.units[0], 1), num(f.units[1], 1)];
  const height = num(f.height, 3);
  const pair = (k: "units" | "dividers" | "cell" | "drawer" | "position", i: number, v: Expr, base: [Expr, Expr]) => set({ [k]: base.map((x, j) => (j === i ? v : x)) });
  const div = f.dividers ?? [0, 0];
  const usePreset = (p: Preset) => set({ ...CLEAR, ...(p.patch.kind === "baseplate" ? { baseplate: undefined, cell: undefined } : {}), ...p.patch });

  // What the numbers come to.
  let info = "";
  try {
    if (bin) {
      const s = binSize(units, height);
      const c = compartments(units, height, [num(div[0], 0), num(div[1], 0)], num(f.wall, GRIDFINITY.wall), num(f.dividerThickness ?? f.wall, GRIDFINITY.wall), num(f.floor, height >= 2 ? GRIDFINITY.binFloor : GRIDFINITY.footHeight + 0.85));
      info = t("{w} × {d} × {h} outside ({lip} with the lip)", { w: mm(s.width), d: mm(s.depth), h: mm(s.rim), lip: mm(s.top) });
      if (!f.solid) info += ` · ${c.count > 1 ? t("{n} compartments of {w} × {d}", { n: c.count, w: mm(c.width), d: mm(c.depth) }) : t("inside {w} × {d}", { w: mm(c.width), d: mm(c.depth) })}`;
    } else if (f.drawer) {
      const fit = drawerFit([num(f.drawer[0], 400), num(f.drawer[1], 300)]);
      info = t("{x} × {y} cells, border {bx} and {by}", { x: fit.units[0], y: fit.units[1], bx: mm(fit.border[0]), by: mm(fit.border[1]) });
    } else info = t("{w} × {d} outside", { w: mm(units[0] * GRIDFINITY.pitch), d: mm(units[1] * GRIDFINITY.pitch) });
  } catch (e) {
    info = e instanceof Error ? e.message : "";
  }

  return (
    <>
      <div className="preset-row" style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {PRESETS.map((p) => (
          <button key={p.label} className="btn" style={{ height: 28 }} onClick={() => usePreset(p)}>
            {p.label}
          </button>
        ))}
      </div>
      <Seg
        value={f.kind}
        options={[["bin", t("Bin")], ["baseplate", t("Baseplate")]]}
        onChange={(kind) => set(kind === "bin" ? { kind } : { kind, baseplate: undefined, cell: undefined, dividers: undefined, scoop: undefined, tab: undefined, lip: undefined, solid: undefined, height: undefined })}
      />
      {!bin ? (
        <label className="checkbox">
          <input type="checkbox" checked={!!f.drawer} onChange={(e) => set({ drawer: e.target.checked ? [400, 300] : undefined })} /> {t("Fill a drawer")}
        </label>
      ) : null}
      {!bin && f.drawer ? (
        <div className="row">
          <Field label={t("Drawer width")}>
            <ExprInput value={f.drawer[0]} onCommit={(v) => pair("drawer", 0, v, f.drawer!)} onLive={(v) => pair("drawer", 0, v, f.drawer!)} />
          </Field>
          <Field label={t("Drawer depth")}>
            <ExprInput value={f.drawer[1]} onCommit={(v) => pair("drawer", 1, v, f.drawer!)} onLive={(v) => pair("drawer", 1, v, f.drawer!)} />
          </Field>
        </div>
      ) : (
        <div className="row">
          <Field label={t("Cells wide")}>
            <Count value={f.units[0]} min={1} max={30} onChange={(v) => pair("units", 0, v, f.units)} />
          </Field>
          <Field label={t("Cells deep")}>
            <Count value={f.units[1]} min={1} max={30} onChange={(v) => pair("units", 1, v, f.units)} />
          </Field>
        </div>
      )}
      {bin ? (
        <div className="row">
          <Field label={t("Height (units)")}>
            <Count value={f.height ?? 3} min={1} max={40} onChange={(height) => set({ height })} />
          </Field>
          <div style={{ flex: 1 }} />
        </div>
      ) : null}
      <p className="muted small">{info}</p>
      {bin ? (
        <>
          <div className="row">
            <Field label={t("Dividers across")}>
              <Count value={div[0]} min={0} max={50} onChange={(v) => pair("dividers", 0, v, div)} />
            </Field>
            <Field label={t("Dividers along")}>
              <Count value={div[1]} min={0} max={50} onChange={(v) => pair("dividers", 1, v, div)} />
            </Field>
          </div>
          <div className="row">
            <Field label={t("Wall")}>
              <ExprInput value={f.wall} placeholder={String(GRIDFINITY.wall)} onCommit={(wall) => set({ wall })} onLive={(wall) => set({ wall })} />
            </Field>
            <Field label={t("Floor height")}>
              <ExprInput value={f.floor} placeholder={String(height >= 2 ? GRIDFINITY.binFloor : GRIDFINITY.footHeight + 0.85)} onCommit={(floor) => set({ floor })} />
            </Field>
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={f.scoop !== undefined} onChange={(e) => set({ scoop: e.target.checked ? 10 : undefined })} /> {t("Scoop: a finger slide at the front")}
          </label>
          {f.scoop !== undefined ? (
            <Field label={t("Scoop radius")}>
              <ExprInput value={f.scoop} onCommit={(scoop) => set({ scoop })} onLive={(scoop) => set({ scoop })} />
            </Field>
          ) : null}
          <label className="checkbox">
            <input type="checkbox" checked={!!f.tab} onChange={(e) => set({ tab: e.target.checked ? {} : undefined })} /> {t("Label tab at the back")}
          </label>
          {f.tab ? (
            <>
              <Seg value={f.tab.style ?? "full"} options={[["full", t("Full width")], ["left", t("Left")], ["center", t("Centre")], ["right", t("Right")]]} onChange={(style) => set({ tab: { ...f.tab, style: style === "full" ? undefined : style } })} />
              <div className="row">
                <Field label={t("Tab width")}>
                  <ExprInput value={f.tab.width} placeholder={String(GRIDFINITY.tabWidth)} onCommit={(width) => set({ tab: { ...f.tab, width } })} />
                </Field>
                <Field label={t("Tab angle")}>
                  <ExprInput value={f.tab.angle} unit="deg" placeholder={String(GRIDFINITY.tabAngle)} onCommit={(angle) => set({ tab: { ...f.tab, angle } })} />
                </Field>
              </div>
            </>
          ) : null}
          <label className="checkbox">
            <input type="checkbox" checked={f.lip !== false} onChange={(e) => set({ lip: e.target.checked ? undefined : false })} /> {t("Stacking lip")}
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={!!f.solid} onChange={(e) => set({ solid: e.target.checked || undefined })} /> {t("Solid (cut your own pockets)")}
          </label>
        </>
      ) : (
        <Field label={t("Floor below the cells")}>
          <ExprInput value={f.floor} placeholder={f.magnets || f.screws ? String(GRIDFINITY.plateFloorWithHoles) : "0"} onCommit={(floor) => set({ floor })} />
        </Field>
      )}
      <div className="row">
        <label className="checkbox">
          <input type="checkbox" checked={!!f.magnets} onChange={(e) => set({ magnets: e.target.checked || undefined })} /> {t("Magnet holes")}
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={!!f.screws} onChange={(e) => set({ screws: e.target.checked || undefined })} /> {t("Screw holes")}
        </label>
      </div>
      {bin && plates.length ? (
        <Field label={t("Stands in")}>
          <select className="field" value={f.baseplate ?? ""} onChange={(e) => set(e.target.value ? { baseplate: e.target.value, cell: f.cell ?? [0, 0], plane: undefined, position: undefined } : { baseplate: undefined, cell: undefined })}>
            <option value="">{t("Nothing (place freely)")}</option>
            {plates.map((p) => (
              <option key={p.id} value={p.id}>
                {featureName(p)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {f.baseplate ? (
        <>
        <div className="row">
          <Field label={t("Cell (column)")}>
            <Count value={f.cell?.[0] ?? 0} min={0} max={100} onChange={(v) => pair("cell", 0, v, f.cell ?? [0, 0])} />
          </Field>
          <Field label={t("Cell (row)")}>
            <Count value={f.cell?.[1] ?? 0} min={0} max={100} onChange={(v) => pair("cell", 1, v, f.cell ?? [0, 0])} />
          </Field>
        </div>
        <button className="btn" onClick={() => void checkInterference()}>
          <ShieldCheck /> {t("Check fit")}
        </button>
        </>
      ) : (
        <>
          <Field label={t("On")}>
            <PlaneBox value={describePlane(f.plane ?? { ref: "origin.XY" })} placeholder={t("Tap a plane or flat face where it stands")} />
          </Field>
          <div className="row">
            <Field label={t("Position x")}>
              <ExprInput value={f.position?.[0] ?? 0} onCommit={(v) => pair("position", 0, v, f.position ?? [0, 0])} />
            </Field>
            <Field label={t("Position y")}>
              <ExprInput value={f.position?.[1] ?? 0} onCommit={(v) => pair("position", 1, v, f.position ?? [0, 0])} />
            </Field>
          </div>
        </>
      )}
      <p className="muted small">{bin ? t("Bins are 42 mm per cell and 7 mm per height unit, with 0.25 mm play all round in a baseplate. The result is an ordinary part: round its edges or cut into it.") : t("Baseplates hold bins in 42 mm cells. Without a floor they print fastest; magnets and screws need one.")}</p>
    </>
  );
}

/** A small drawing of a symbol for its button. */
function SymbolIcon({ kind }: { kind: LabelSymbolKind }) {
  const { loops, width } = labelSymbol(kind);
  const d = loops.map((l) => `M${l.map(([x, y]) => `${x.toFixed(3)},${(-y).toFixed(3)}`).join("L")}Z`).join("");
  return (
    <svg viewBox={`-0.05 -0.55 ${width + 0.1} 1.1`} width={Math.round(18 * (width + 0.1))} height={18} aria-hidden>
      <path d={d} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

const LABEL_PRESETS: { label: string; patch: Partial<Of<"label">> }[] = [
  { label: t("Tab of a 1-cell bin"), patch: { width: undefined, height: undefined } },
  { label: t("Wide tab"), patch: { width: 80, height: 11 } },
  { label: t("Drawer front"), patch: { width: 60, height: 20, thickness: 1.6 } },
];

export function LabelFields({ f, set }: { f: Of<"label">; set: SetFn }) {
  const symbol = f.symbol ?? "none";
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {LABEL_PRESETS.map((p) => (
          <button key={p.label} className="btn" style={{ height: 28 }} onClick={() => set(p.patch)}>
            {p.label}
          </button>
        ))}
      </div>
      <Field label={t("Symbol")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          <button className={`btn ${symbol === "none" ? "primary" : ""}`} style={{ height: 32 }} onClick={() => set({ symbol: undefined })}>
            {t("None")}
          </button>
          {LABEL_SYMBOLS.map((k) => (
            <button key={k} className={`btn ${symbol === k ? "primary" : ""}`} style={{ height: 32 }} title={t(LABEL_SYMBOL_NAMES[k])} aria-label={t(LABEL_SYMBOL_NAMES[k])} onClick={() => set({ symbol: k })}>
              <SymbolIcon kind={k} />
            </button>
          ))}
        </div>
      </Field>
      <Field label={t("Text")}>
        <textarea className="field" rows={2} value={f.text ?? ""} onChange={(e) => set({ text: e.target.value || undefined })} />
      </Field>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"].map((m) => (
          <button key={m} className="btn" style={{ height: 26, padding: "0 8px" }} onClick={() => set({ text: /×/.test(f.text ?? "") && /^M[\d.]+/.test(f.text ?? "") ? (f.text ?? "").replace(/^M[\d.]+/, m) : m })}>
            {m}
          </button>
        ))}
        {["×6", "×8", "×10", "×12", "×16", "×20"].map((l) => (
          <button key={l} className="btn" style={{ height: 26, padding: "0 8px" }} onClick={() => set({ text: `${(f.text ?? "M3").replace(/×.*$/, "")}${l}` })}>
            {l}
          </button>
        ))}
      </div>
      <Field label={t("Result")}>
        <Seg value={f.style ?? "raised"} options={[["raised", t("Raised")], ["engraved", t("Engraved")]]} onChange={(style) => set({ style: style === "raised" ? undefined : style })} />
      </Field>
      <label className="checkbox">
        <input type="checkbox" checked={!!f.separate} onChange={(e) => set({ separate: e.target.checked || undefined })} /> {t("Two colours: the marking as its own part")}
      </label>
      <div className="row">
        <Field label={t("Width")}>
          <ExprInput value={f.width} placeholder="36" onCommit={(width) => set({ width })} onLive={(width) => set({ width })} />
        </Field>
        <Field label={t("Height")}>
          <ExprInput value={f.height} placeholder="11" onCommit={(height) => set({ height })} onLive={(height) => set({ height })} />
        </Field>
      </div>
      <div className="row">
        <Field label={t("Thickness")}>
          <ExprInput value={f.thickness} placeholder="1.2" onCommit={(thickness) => set({ thickness })} />
        </Field>
        <Field label={f.style === "engraved" ? t("Depth") : t("Height")}>
          <ExprInput value={f.depth} placeholder="0.6" onCommit={(depth) => set({ depth })} />
        </Field>
      </div>
      <div className="row">
        <Field label={t("Letter height")}>
          <ExprInput value={f.size} placeholder={t("fit")} onCommit={(size) => set({ size })} />
        </Field>
        <Field label={t("Font")}>
          <select className="field" value={f.font ?? "sans"} onChange={(e) => set({ font: e.target.value === "sans" ? undefined : e.target.value })}>
            <option value="sans">{t("Sans")}</option>
            <option value="sans-bold">{t("Sans bold")}</option>
            <option value="mono">{t("Mono")}</option>
          </select>
        </Field>
      </div>
      <Field label={t("On")}>
        <PlaneBox value={describePlane(f.plane ?? { ref: "origin.XY" })} placeholder={t("Tap a flat face where the label goes")} />
      </Field>
      <div className="row">
        <Field label={t("Position x")}>
          <ExprInput value={f.position?.[0] ?? 0} onCommit={(x) => set({ position: [x, f.position?.[1] ?? 0] })} />
        </Field>
        <Field label={t("Position y")}>
          <ExprInput value={f.position?.[1] ?? 0} onCommit={(y) => set({ position: [f.position?.[0] ?? 0, y] })} />
        </Field>
        <Field label={t("Angle")}>
          <ExprInput value={f.angle ?? 0} unit="deg" onCommit={(angle) => set({ angle: angle === 0 ? undefined : angle })} />
        </Field>
      </div>
      <p className="muted small">{t("Tap a bin's label tab to put the label on it. With two colours, give the marking its own colour or material and print both in one go.")}</p>
    </>
  );
}
