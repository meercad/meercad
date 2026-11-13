/**
 * Dialog fields of the storage generators: Gridfinity bins and baseplates (presets, sizes in grid
 * units, compartments, holes, placement) and printable labels (symbol, text, style, colours).
 * Every change rebuilds the preview straight away; − / + buttons step counts without typing.
 */
import { Minus, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { checkInterference } from "../lib/interference";
import type { ReactNode } from "react";
import type { Expr, Feature } from "@meercad/schema";
import {
  binSize,
  compartments,
  drawerFit,
  GRIDFINITY,
  LABEL_SYMBOL_NAMES,
  LABEL_SYMBOLS,
  labelSymbol,
  type LabelSymbolKind,
} from "@meercad/model";
import { describePlane } from "../lib/topology";
import { featureName, partName } from "../lib/features";
import { PickBox } from "./ClosureFields";
import { setDialogField, useApp } from "../store";
import { ExprInput } from "./ExprInput";
import { t } from "../lib/i18n";

type Of<O extends Feature["op"]> = Extract<Feature, { op: O }>;
type SetFn = (patch: Record<string, unknown>) => void;

export const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="fld">
    <span className="fld-label">{label}</span>
    {children}
  </div>
);

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, ReactNode][];
  onChange: (v: T) => void;
}) {
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
  const active = useApp((state) => state.dialog?.field === "plane");

  return (
    <div
      className={`selbox ${active ? "active" : ""}`}
      onClick={() => setDialogField(active ? null : "plane")}
      role="button"
      tabIndex={0}
    >
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

export const num = (expr: Expr | undefined, fallback: number) => (typeof expr === "number" ? expr : fallback);

/** A whole number with − and + beside it (no keyboard needed). */
export function Count({
  value,
  min,
  max,
  onChange,
}: {
  value: Expr | undefined;
  min: number;
  max: number;
  onChange: (expr: Expr) => void;
}) {
  const n = num(value, min);

  return (
    <div className="row" style={{ gap: 4, alignItems: "center" }}>
      <button
        className="icon-btn sm"
        aria-label={t("Fewer")}
        disabled={typeof value === "number" && n <= min}
        onClick={() => onChange(Math.max(min, n - 1))}
      >
        <Minus />
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ExprInput
          value={value ?? min}
          unit=""
          integer
          quiet
          className="count"
          onCommit={onChange}
          onLive={onChange}
        />
      </div>
      <button
        className="icon-btn sm"
        aria-label={t("More")}
        disabled={typeof value === "number" && n >= max}
        onClick={() => onChange(Math.min(max, n + 1))}
      >
        <Plus />
      </button>
    </div>
  );
}

export const mm = (v: number) => `${+v.toFixed(1)} mm`;

interface Preset {
  label: string;
  patch: Partial<Of<"gridfinity">>;
}

const CLEAR: Partial<Of<"gridfinity">> = {
  units: [1, 1],
  height: undefined,
  pocket: undefined,
  dividers: undefined,
  scoop: undefined,
  tab: undefined,
  lip: undefined,
  solid: undefined,
  magnets: undefined,
  screws: undefined,
  drawer: undefined,
  outline: undefined,
  gap: undefined,
  fill: undefined,
  bed: undefined,
  floor: undefined,
  wall: undefined,
};

/** Ready-made starting points: a click sets every value; each stays editable. */
const PRESETS: Preset[] = [
  { label: t("1×1 bin"), patch: { kind: "bin", units: [1, 1], height: 3 } },
  {
    label: t("2×1 bin, 3 dividers"),
    patch: { kind: "bin", units: [2, 1], height: 3, dividers: [3, 0], scoop: 10, tab: {} },
  },
  {
    label: t("3×2 bin, 6 compartments"),
    patch: { kind: "bin", units: [3, 2], height: 6, dividers: [2, 1], scoop: 15, tab: {} },
  },
  {
    label: t("Screw sorter 2×2"),
    patch: { kind: "bin", units: [2, 2], height: 3, dividers: [3, 3], scoop: 6 },
  },
  { label: t("Baseplate 4×3, magnets"), patch: { kind: "baseplate", units: [4, 3], magnets: true } },
  { label: t("Baseplate for a drawer"), patch: { kind: "baseplate", units: [1, 1], drawer: [400, 300] } },
  {
    label: t("Floor 3 m × 1.5 m, cut for the print bed"),
    patch: { kind: "baseplate", units: [1, 1], drawer: [3000, 1500], bed: { size: [256, 256] } },
  },
];

/** The print bed a baseplate is cut up for, unless changed. */
const DEFAULT_BED: [number, number] = [256, 256];

/** Examples to start from, in a menu: picking one sets every value, each stays editable. */
export function Examples<P>({
  items,
  onPick,
}: {
  items: { label: string; patch: P }[];
  onPick: (patch: P) => void;
}) {
  return (
    <Field label={t("Start from an example")}>
      <select
        className="field"
        value=""
        onChange={(event) => {
          const item = items[Number(event.target.value)];
          if (item) onPick(item.patch);
        }}
      >
        <option value="">{t("Pick an example…")}</option>
        {items.map((p, i) => (
          <option key={p.label} value={i}>
            {p.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function GridfinityFields({ f: feature, set }: { f: Of<"gridfinity">; set: SetFn }) {
  const features = useApp((state) => state.doc.features);
  const kernelInfo = useApp((state) => state.output?.report.features.find((x) => x.id === feature.id)?.info);

  if (feature.kind === "bin" && feature.pocket) {
    return <PartBinFields f={feature} set={set} info={kernelInfo} />;
  }

  return <GridFields f={feature} set={set} features={features} kernelInfo={kernelInfo} />;
}

function GridFields({
  f: feature,
  set,
  features,
  kernelInfo,
}: {
  f: Of<"gridfinity">;
  set: SetFn;
  features: readonly Feature[];
  kernelInfo: Record<string, number> | undefined;
}) {
  const plates = features.filter(
    (x): x is Of<"gridfinity"> => x.op === "gridfinity" && x.kind === "baseplate" && x.id !== feature.id,
  );
  const bin = feature.kind === "bin";
  const fu = feature.units ?? [1, 1];
  const units: [number, number] = [num(fu[0], 1), num(fu[1], 1)];
  const height = num(feature.height, 3);
  const pair = (
    k: "units" | "dividers" | "cell" | "drawer" | "position",
    i: number,
    expr: Expr,
    base: [Expr, Expr],
  ) => set({ [k]: base.map((x, j) => (j === i ? expr : x)) });
  const div = feature.dividers ?? [0, 0];

  const usePreset = (patch: Preset["patch"]) => {
    setWantOutline(false);
    set({
      ...CLEAR,
      ...(patch.kind === "baseplate" ? { baseplate: undefined, cell: undefined } : {}),
      ...patch,
    });
  };

  const sketches = features.filter((x): x is Of<"sketch"> => x.op === "sketch");
  // The mode follows the feature (presets change it too); "outline" before a sketch is picked is kept here.
  const [wantOutline, setWantOutline] = useState(false);
  const mode: "cells" | "area" | "outline" = feature.outline
    ? "outline"
    : feature.drawer
      ? "area"
      : wantOutline
        ? "outline"
        : "cells";

  const pickMode = (m: typeof mode) => {
    setWantOutline(m === "outline");

    if (m === "cells") {
      set({ drawer: undefined, outline: undefined, gap: undefined, fill: undefined });
    } else if (m === "area") {
      set({ drawer: feature.drawer ?? [400, 300], outline: undefined });
    } else {
      set({
        drawer: undefined,
        outline: sketches.length
          ? {
              sketch: (
                sketches.find((x) => x.id === feature.outline?.sketch) ?? sketches[sketches.length - 1]!
              ).id,
            }
          : undefined,
        plane: undefined,
        position: undefined,
      });
    }
  };

  // What the numbers come to.
  let info = "";

  try {
    if (bin) {
      const s = binSize(units, height);
      const c = compartments(
        units,
        height,
        [num(div[0], 0), num(div[1], 0)],
        num(feature.wall, GRIDFINITY.wall),
        num(feature.dividerThickness ?? feature.wall, GRIDFINITY.wall),
        num(feature.floor, height >= 2 ? GRIDFINITY.binFloor : GRIDFINITY.footHeight + 0.85),
      );
      info = t("{w} × {d} × {h} outside ({lip} with the lip)", {
        w: mm(s.width),
        d: mm(s.depth),
        h: mm(s.rim),
        lip: mm(s.top),
      });

      if (!feature.solid) {
        info += ` · ${c.count > 1 ? t("{n} compartments of {w} × {d}", { n: c.count, w: mm(c.width), d: mm(c.depth) }) : t("inside {w} × {d}", { w: mm(c.width), d: mm(c.depth) })}`;
      }
    } else if ((feature.outline || feature.bed) && kernelInfo?.["cells"] !== undefined) {
      const k = kernelInfo;
      info = t("{n} cells ({x} × {y}) on {w} × {d}", {
        n: k["cells"]!,
        x: k["cellsX"]!,
        y: k["cellsY"]!,
        w: mm(k["width"]!),
        d: mm(k["depth"]!),
      });

      if (k["borderX"] !== undefined) {
        info += ` · ${t(feature.fill === false ? "left empty {bx} and {by}" : "border {bx} and {by}", { bx: mm(k["borderX"]), by: mm(k["borderY"]!) })}`;
      }

      if (feature.bed) {
        info += ` · ${t("{n} pieces, the largest {w} × {d}", { n: k["pieces"]!, w: mm(k["largestX"]!), d: mm(k["largestY"]!) })}`;
      }
    } else if (feature.drawer) {
      const fit = drawerFit(
        [num(feature.drawer[0], 400), num(feature.drawer[1], 300)],
        num(feature.gap, 0.5),
      );
      info = t("{x} × {y} cells, border {bx} and {by}", {
        x: fit.units[0],
        y: fit.units[1],
        bx: mm(fit.border[0]),
        by: mm(fit.border[1]),
      });
    } else {
      info = t("{w} × {d} outside", {
        w: mm(units[0] * GRIDFINITY.pitch),
        d: mm(units[1] * GRIDFINITY.pitch),
      });
    }
  } catch (error) {
    info = error instanceof Error ? error.message : "";
  }

  return (
    <>
      <Examples items={PRESETS} onPick={usePreset} />
      <KindSeg f={feature} set={set} />
      {!bin ? (
        <Seg
          value={mode}
          options={[
            ["cells", t("Cells")],
            ["area", t("Floor area")],
            ["outline", t("Drawn outline")],
          ]}
          onChange={pickMode}
        />
      ) : null}
      {!bin && mode === "area" ? (
        <div className="row">
          <Field label={t("Area width")}>
            <ExprInput
              value={feature.drawer?.[0] ?? 400}
              onCommit={(expr) => pair("drawer", 0, expr, feature.drawer ?? [400, 300])}
              onLive={(expr) => pair("drawer", 0, expr, feature.drawer ?? [400, 300])}
            />
          </Field>
          <Field label={t("Area depth")}>
            <ExprInput
              value={feature.drawer?.[1] ?? 300}
              onCommit={(expr) => pair("drawer", 1, expr, feature.drawer ?? [400, 300])}
              onLive={(expr) => pair("drawer", 1, expr, feature.drawer ?? [400, 300])}
            />
          </Field>
        </div>
      ) : null}
      {!bin && mode === "outline" ? (
        sketches.length ? (
          <Field label={t("Outline (sketch)")}>
            <select
              className="field"
              value={feature.outline?.sketch ?? ""}
              onChange={(event) =>
                set({ outline: event.target.value ? { sketch: event.target.value } : undefined })
              }
            >
              {feature.outline ? null : <option value="">{t("Pick a sketch")}</option>}
              {sketches.map((x) => (
                <option key={x.id} value={x.id}>
                  {featureName(x)}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="muted small">
            {t("Draw the area's outline in a sketch first (any closed shape, holes too), then pick it here.")}
          </p>
        )
      ) : null}
      {!bin && mode !== "cells" ? (
        <>
          <Field label={t("Gap to the edge")}>
            <ExprInput value={feature.gap} placeholder="0.5" onCommit={(gap) => set({ gap })} />
          </Field>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={feature.fill !== false}
              onChange={(event) => set({ fill: event.target.checked ? undefined : false })}
            />{" "}
            {t("Fill the rest with a solid border")}
          </label>
        </>
      ) : null}
      {bin || mode === "cells" ? (
        <div className="row">
          <Field label={t("Cells wide")}>
            <Count value={fu[0]} min={1} max={30} onChange={(expr) => pair("units", 0, expr, fu)} />
          </Field>
          <Field label={t("Cells deep")}>
            <Count value={fu[1]} min={1} max={30} onChange={(expr) => pair("units", 1, expr, fu)} />
          </Field>
        </div>
      ) : null}
      {!bin ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!feature.bed}
            onChange={(event) => set({ bed: event.target.checked ? { size: DEFAULT_BED } : undefined })}
          />{" "}
          {t("Cut into pieces for the print bed")}
        </label>
      ) : null}
      {!bin && feature.bed ? (
        <>
          <div className="row">
            <Field label={t("Bed width")}>
              <ExprInput
                value={feature.bed.size[0]}
                onCommit={(expr) => set({ bed: { ...feature.bed, size: [expr, feature.bed!.size[1]] } })}
              />
            </Field>
            <Field label={t("Bed depth")}>
              <ExprInput
                value={feature.bed.size[1]}
                onCommit={(expr) => set({ bed: { ...feature.bed, size: [feature.bed!.size[0], expr] } })}
              />
            </Field>
          </div>
          <div className="row">
            <Field label={t("Unusable width")}>
              <ExprInput
                value={feature.bed.margin?.[0]}
                placeholder="0"
                onCommit={(expr) =>
                  set({ bed: { ...feature.bed, margin: [expr, feature.bed?.margin?.[1] ?? 0] } })
                }
              />
            </Field>
            <Field label={t("Unusable depth")}>
              <ExprInput
                value={feature.bed.margin?.[1]}
                placeholder="0"
                onCommit={(expr) =>
                  set({ bed: { ...feature.bed, margin: [feature.bed?.margin?.[0] ?? 0, expr] } })
                }
              />
            </Field>
          </div>
          <p className="muted small">
            {t(
              "What of the bed cannot be printed on, e.g. 20 mm depth when the back 2 cm are taken. The plate comes apart between cells; the pieces are parts A1, A2, … (rows from the front): export them together as one 3MF.",
            )}
          </p>
        </>
      ) : null}
      {bin ? (
        <div className="row">
          <Field label={t("Height (units)")}>
            <Count value={feature.height ?? 3} min={1} max={40} onChange={(height) => set({ height })} />
          </Field>
          <div style={{ flex: 1 }} />
        </div>
      ) : null}
      <p className="muted small">{info}</p>
      {bin ? (
        <>
          <div className="row">
            <Field label={t("Dividers across")}>
              <Count value={div[0]} min={0} max={50} onChange={(expr) => pair("dividers", 0, expr, div)} />
            </Field>
            <Field label={t("Dividers along")}>
              <Count value={div[1]} min={0} max={50} onChange={(expr) => pair("dividers", 1, expr, div)} />
            </Field>
          </div>
          <div className="row">
            <Field label={t("Wall")}>
              <ExprInput
                value={feature.wall}
                placeholder={String(GRIDFINITY.wall)}
                onCommit={(wall) => set({ wall })}
                onLive={(wall) => set({ wall })}
              />
            </Field>
            <Field label={t("Floor height")}>
              <ExprInput
                value={feature.floor}
                placeholder={String(height >= 2 ? GRIDFINITY.binFloor : GRIDFINITY.footHeight + 0.85)}
                onCommit={(floor) => set({ floor })}
              />
            </Field>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={feature.scoop !== undefined}
              onChange={(event) => set({ scoop: event.target.checked ? 10 : undefined })}
            />{" "}
            {t("Scoop: a finger slide at the front")}
          </label>
          {feature.scoop !== undefined ? (
            <Field label={t("Scoop radius")}>
              <ExprInput
                value={feature.scoop}
                onCommit={(scoop) => set({ scoop })}
                onLive={(scoop) => set({ scoop })}
              />
            </Field>
          ) : null}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={!!feature.tab}
              onChange={(event) => set({ tab: event.target.checked ? {} : undefined })}
            />{" "}
            {t("Label tab at the back")}
          </label>
          {feature.tab ? (
            <>
              <Seg
                value={feature.tab.style ?? "full"}
                options={[
                  ["full", t("Full width")],
                  ["left", t("Left")],
                  ["center", t("Centre")],
                  ["right", t("Right")],
                ]}
                onChange={(style) =>
                  set({ tab: { ...feature.tab, style: style === "full" ? undefined : style } })
                }
              />
              <div className="row">
                <Field label={t("Tab width")}>
                  <ExprInput
                    value={feature.tab.width}
                    placeholder={String(GRIDFINITY.tabWidth)}
                    onCommit={(width) => set({ tab: { ...feature.tab, width } })}
                  />
                </Field>
                <Field label={t("Tab angle")}>
                  <ExprInput
                    value={feature.tab.angle}
                    unit="deg"
                    placeholder={String(GRIDFINITY.tabAngle)}
                    onCommit={(angle) => set({ tab: { ...feature.tab, angle } })}
                  />
                </Field>
              </div>
            </>
          ) : null}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={feature.lip !== false}
              onChange={(event) => set({ lip: event.target.checked ? undefined : false })}
            />{" "}
            {t("Stacking lip")}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={!!feature.solid}
              onChange={(event) => set({ solid: event.target.checked || undefined })}
            />{" "}
            {t("Solid (cut your own pockets)")}
          </label>
        </>
      ) : (
        <Field label={t("Floor below the cells")}>
          <ExprInput
            value={feature.floor}
            placeholder={feature.magnets || feature.screws ? String(GRIDFINITY.plateFloorWithHoles) : "0"}
            onCommit={(floor) => set({ floor })}
          />
        </Field>
      )}
      <div className="row">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!feature.magnets}
            onChange={(event) => set({ magnets: event.target.checked || undefined })}
          />{" "}
          {t("Magnet holes")}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!feature.screws}
            onChange={(event) => set({ screws: event.target.checked || undefined })}
          />{" "}
          {t("Screw holes")}
        </label>
      </div>
      {bin && plates.length ? (
        <Field label={t("Stands in")}>
          <select
            className="field"
            value={feature.baseplate ?? ""}
            onChange={(event) =>
              set(
                event.target.value
                  ? {
                      baseplate: event.target.value,
                      cell: feature.cell ?? [0, 0],
                      plane: undefined,
                      position: undefined,
                    }
                  : { baseplate: undefined, cell: undefined },
              )
            }
          >
            <option value="">{t("Nothing (place freely)")}</option>
            {plates.map((feature) => (
              <option key={feature.id} value={feature.id}>
                {featureName(feature)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {feature.baseplate ? (
        <>
          <div className="row">
            <Field label={t("Cell (column)")}>
              <Count
                value={feature.cell?.[0] ?? 0}
                min={0}
                max={100}
                onChange={(expr) => pair("cell", 0, expr, feature.cell ?? [0, 0])}
              />
            </Field>
            <Field label={t("Cell (row)")}>
              <Count
                value={feature.cell?.[1] ?? 0}
                min={0}
                max={100}
                onChange={(expr) => pair("cell", 1, expr, feature.cell ?? [0, 0])}
              />
            </Field>
          </div>
          <button className="btn" onClick={() => void checkInterference()}>
            <ShieldCheck /> {t("Check fit")}
          </button>
        </>
      ) : !bin && feature.outline ? null : (
        <>
          <Field label={t("On")}>
            <PlaneBox
              value={describePlane(feature.plane ?? { ref: "origin.XY" })}
              placeholder={t("Tap a plane or flat face where it stands")}
            />
          </Field>
          <div className="row">
            <Field label={t("Position x")}>
              <ExprInput
                value={feature.position?.[0] ?? 0}
                onCommit={(expr) => pair("position", 0, expr, feature.position ?? [0, 0])}
              />
            </Field>
            <Field label={t("Position y")}>
              <ExprInput
                value={feature.position?.[1] ?? 0}
                onCommit={(expr) => pair("position", 1, expr, feature.position ?? [0, 0])}
              />
            </Field>
          </div>
        </>
      )}
      <p className="muted small">
        {bin
          ? t(
              "Bins are 42 mm per cell and 7 mm per height unit, with 0.25 mm play all round in a baseplate. The result is an ordinary part: round its edges or cut into it.",
            )
          : t(
              "Baseplates hold bins in 42 mm cells. Without a floor they print fastest; magnets and screws need one. An area or a drawn outline gets as many whole cells as fit and, if you like, a solid border round them.",
            )}
      </p>
    </>
  );
}

/** Bin, baseplate, or a bin with a nest for a part (a scan or any other part). */
function KindSeg({ f: feature, set }: { f: Of<"gridfinity">; set: SetFn }) {
  const value = feature.kind === "bin" && feature.pocket ? "part" : feature.kind;

  return (
    <Seg
      value={value}
      options={[
        ["bin", t("Bin")],
        ["baseplate", t("Baseplate")],
        ["part", t("For a part")],
      ]}
      onChange={(kind) => {
        if (kind === value) return;

        if (kind === "part") {
          // Sized round the part; the part is tapped in the viewport next.
          set({
            kind: "bin",
            pocket: { body: "" },
            units: undefined,
            height: undefined,
            dividers: undefined,
            scoop: undefined,
            tab: undefined,
            solid: undefined,
            wall: undefined,
            floor: undefined,
            position: undefined,
            drawer: undefined,
            outline: undefined,
            gap: undefined,
            fill: undefined,
            bed: undefined,
          });
          setDialogField("pocket");
        } else if (kind === "bin") {
          set({
            kind,
            pocket: undefined,
            units: feature.units ?? [1, 1],
            height: feature.height ?? 3,
            drawer: undefined,
            outline: undefined,
            gap: undefined,
            fill: undefined,
            bed: undefined,
          });
        } else {
          set({
            kind,
            pocket: undefined,
            units: feature.units ?? [1, 1],
            baseplate: undefined,
            cell: undefined,
            dividers: undefined,
            scoop: undefined,
            tab: undefined,
            lip: undefined,
            solid: undefined,
            height: undefined,
          });
        }
      }}
    />
  );
}

/**
 * A bin with a nest for a part: the part sinks in by a share of its height with some play, the bin
 * takes as few cells as hold it (or fixed sizes) and is built where the part lies.
 */
function PartBinFields({
  f: feature,
  set,
  info,
}: {
  f: Of<"gridfinity">;
  set: SetFn;
  info: Record<string, number> | undefined;
}) {
  const features = useApp((state) => state.doc.features);
  const plates = features.filter(
    (x): x is Of<"gridfinity"> => x.op === "gridfinity" && x.kind === "baseplate",
  );
  const p = feature.pocket!;
  const auto = !feature.units;
  const setPocket = (patch: Partial<NonNullable<Of<"gridfinity">["pocket"]>>) =>
    set({ pocket: { ...p, ...patch } });
  const sizeText =
    info?.["width"] !== undefined
      ? t("{x} × {y} cells, {h} units high · nest {d} deep", {
          x: info["width"]!,
          y: info["depth"]!,
          h: info["height"]!,
          d: mm(info["pocketDepth"]!),
        }) + (info["angle"] ? ` · ${t("turned {a}°", { a: +info["angle"].toFixed(1) })}` : "")
      : "";

  return (
    <>
      <KindSeg f={feature} set={set} />
      <Field label={t("Part to hold")}>
        <PickBox
          field="pocket"
          items={p.body ? [partName(p.body, features)] : []}
          placeholder={t("Tap the part (e.g. a scan)")}
          onRemove={() => setPocket({ body: "" })}
        />
      </Field>
      <div className="row">
        <Field label={t("Sinks in (% of its height)")}>
          <ExprInput
            value={p.sink ?? 50}
            unit=""
            placeholder="50"
            onCommit={(sink) => setPocket({ sink: sink === 50 ? undefined : sink })}
          />
        </Field>
        <Field label={t("Play")}>
          <ExprInput
            value={p.clearance}
            placeholder="0.5"
            onCommit={(clearance) => setPocket({ clearance })}
          />
        </Field>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!p.grip}
          onChange={(event) => setPocket({ grip: event.target.checked || undefined })}
        />{" "}
        {t("Finger grip across the part")}
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={auto}
          onChange={(event) =>
            set(
              event.target.checked
                ? { units: undefined, height: undefined }
                : { units: [info?.["width"] ?? 1, info?.["depth"] ?? 1], height: info?.["height"] ?? 3 },
            )
          }
        />{" "}
        {t("Size to fit the part")}
      </label>
      {!auto ? (
        <div className="row">
          <Field label={t("Cells wide")}>
            <Count
              value={feature.units![0]}
              min={1}
              max={30}
              onChange={(expr) => set({ units: [expr, feature.units![1]] })}
            />
          </Field>
          <Field label={t("Cells deep")}>
            <Count
              value={feature.units![1]}
              min={1}
              max={30}
              onChange={(expr) => set({ units: [feature.units![0], expr] })}
            />
          </Field>
          <Field label={t("Height (units)")}>
            <Count value={feature.height ?? 3} min={1} max={40} onChange={(height) => set({ height })} />
          </Field>
        </div>
      ) : null}
      {sizeText ? <p className="muted small">{sizeText}</p> : null}
      <div className="row">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={feature.lip !== false}
            onChange={(event) => set({ lip: event.target.checked ? undefined : false })}
          />{" "}
          {t("Stacking lip")}
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!feature.magnets}
            onChange={(event) => set({ magnets: event.target.checked || undefined })}
          />{" "}
          {t("Magnet holes")}
        </label>
      </div>
      {plates.length ? (
        <Field label={t("Stands in")}>
          <select
            className="field"
            value={feature.baseplate ?? ""}
            onChange={(event) =>
              set(
                event.target.value
                  ? { baseplate: event.target.value, cell: feature.cell ?? [0, 0], plane: undefined }
                  : { baseplate: undefined, cell: undefined },
              )
            }
          >
            <option value="">{t("Nothing (built round the part)")}</option>
            {plates.map((x) => (
              <option key={x.id} value={x.id}>
                {featureName(x)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {feature.baseplate ? (
        <div className="row">
          <Field label={t("Cell (column)")}>
            <Count
              value={feature.cell?.[0] ?? 0}
              min={0}
              max={100}
              onChange={(expr) => set({ cell: [expr, feature.cell?.[1] ?? 0] })}
            />
          </Field>
          <Field label={t("Cell (row)")}>
            <Count
              value={feature.cell?.[1] ?? 0}
              min={0}
              max={100}
              onChange={(expr) => set({ cell: [feature.cell?.[0] ?? 0, expr] })}
            />
          </Field>
        </div>
      ) : (
        <Field label={t("Stands on")}>
          <PlaneBox
            value={describePlane(feature.plane ?? { ref: "origin.XY" })}
            placeholder={t("Tap a plane or flat face where it stands")}
          />
        </Field>
      )}
      <p className="muted small">
        {t(
          "The part sinks into the bin's solid top; the nest follows its underside and opens upwards, so it lifts straight out. The bin is built where the part lies, turned to need the fewest cells. Turn or lay the part down first to choose which side goes in. Making the nest takes a few seconds.",
        )}
      </p>
    </>
  );
}

/** A small drawing of a symbol for its button. */
function SymbolIcon({ kind }: { kind: LabelSymbolKind }) {
  const { loops, width } = labelSymbol(kind);
  const d = loops
    .map((l) => `M${l.map(([x, y]) => `${x.toFixed(3)},${(-y).toFixed(3)}`).join("L")}Z`)
    .join("");

  return (
    <svg
      viewBox={`-0.05 -0.55 ${width + 0.1} 1.1`}
      width={Math.round(18 * (width + 0.1))}
      height={18}
      aria-hidden
    >
      <path d={d} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

const LABEL_PRESETS: { label: string; patch: Partial<Of<"label">> }[] = [
  { label: t("Tab of a 1-cell bin"), patch: { width: undefined, height: undefined } },
  { label: t("Wide tab"), patch: { width: 80, height: 11 } },
  { label: t("Drawer front"), patch: { width: 60, height: 20, thickness: 1.6 } },
];

export function LabelFields({ f: feature, set }: { f: Of<"label">; set: SetFn }) {
  const symbol = feature.symbol ?? "none";

  return (
    <>
      <Examples items={LABEL_PRESETS} onPick={(patch) => set(patch)} />
      <Field label={t("Symbol")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          <button
            className={`btn ${symbol === "none" ? "primary" : ""}`}
            style={{ height: 32 }}
            onClick={() => set({ symbol: undefined })}
          >
            {t("None")}
          </button>
          {LABEL_SYMBOLS.map((k) => (
            <button
              key={k}
              className={`btn ${symbol === k ? "primary" : ""}`}
              style={{ height: 32 }}
              title={t(LABEL_SYMBOL_NAMES[k])}
              aria-label={t(LABEL_SYMBOL_NAMES[k])}
              onClick={() => set({ symbol: k })}
            >
              <SymbolIcon kind={k} />
            </button>
          ))}
        </div>
      </Field>
      <Field label={t("Text")}>
        <textarea
          className="field"
          rows={2}
          value={feature.text ?? ""}
          onChange={(event) => set({ text: event.target.value || undefined })}
        />
      </Field>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"].map((m) => (
          <button
            key={m}
            className="btn"
            style={{ height: 26, padding: "0 8px" }}
            onClick={() =>
              set({
                text:
                  /×/.test(feature.text ?? "") && /^M[\d.]+/.test(feature.text ?? "")
                    ? (feature.text ?? "").replace(/^M[\d.]+/, m)
                    : m,
              })
            }
          >
            {m}
          </button>
        ))}
        {["×6", "×8", "×10", "×12", "×16", "×20"].map((l) => (
          <button
            key={l}
            className="btn"
            style={{ height: 26, padding: "0 8px" }}
            onClick={() => set({ text: `${(feature.text ?? "M3").replace(/×.*$/, "")}${l}` })}
          >
            {l}
          </button>
        ))}
      </div>
      <Field label={t("Result")}>
        <Seg
          value={feature.style ?? "raised"}
          options={[
            ["raised", t("Raised")],
            ["engraved", t("Engraved")],
          ]}
          onChange={(style) => set({ style: style === "raised" ? undefined : style })}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.separate}
          onChange={(event) => set({ separate: event.target.checked || undefined })}
        />{" "}
        {t("Two colours: the marking as its own part")}
      </label>
      <div className="row">
        <Field label={t("Width")}>
          <ExprInput
            value={feature.width}
            placeholder="36"
            onCommit={(width) => set({ width })}
            onLive={(width) => set({ width })}
          />
        </Field>
        <Field label={t("Height")}>
          <ExprInput
            value={feature.height}
            placeholder="11"
            onCommit={(height) => set({ height })}
            onLive={(height) => set({ height })}
          />
        </Field>
      </div>
      <div className="row">
        <Field label={t("Thickness")}>
          <ExprInput
            value={feature.thickness}
            placeholder="1.2"
            onCommit={(thickness) => set({ thickness })}
          />
        </Field>
        <Field label={feature.style === "engraved" ? t("Depth") : t("Height")}>
          <ExprInput value={feature.depth} placeholder="0.6" onCommit={(depth) => set({ depth })} />
        </Field>
      </div>
      <div className="row">
        <Field label={t("Letter height")}>
          <ExprInput value={feature.size} placeholder={t("fit")} onCommit={(size) => set({ size })} />
        </Field>
        <Field label={t("Font")}>
          <select
            className="field"
            value={feature.font ?? "sans"}
            onChange={(event) =>
              set({ font: event.target.value === "sans" ? undefined : event.target.value })
            }
          >
            <option value="sans">{t("Sans")}</option>
            <option value="sans-bold">{t("Sans bold")}</option>
            <option value="mono">{t("Mono")}</option>
          </select>
        </Field>
      </div>
      <Field label={t("On")}>
        <PlaneBox
          value={describePlane(feature.plane ?? { ref: "origin.XY" })}
          placeholder={t("Tap a flat face where the label goes")}
        />
      </Field>
      <div className="row">
        <Field label={t("Position x")}>
          <ExprInput
            value={feature.position?.[0] ?? 0}
            onCommit={(x) => set({ position: [x, feature.position?.[1] ?? 0] })}
          />
        </Field>
        <Field label={t("Position y")}>
          <ExprInput
            value={feature.position?.[1] ?? 0}
            onCommit={(y) => set({ position: [feature.position?.[0] ?? 0, y] })}
          />
        </Field>
        <Field label={t("Angle")}>
          <ExprInput
            value={feature.angle ?? 0}
            unit="deg"
            onCommit={(angle) => set({ angle: angle === 0 ? undefined : angle })}
          />
        </Field>
      </div>
      <p className="muted small">
        {t(
          "Tap a bin's label tab to put the label on it. With two colours, give the marking its own colour or material and print both in one go.",
        )}
      </p>
    </>
  );
}
