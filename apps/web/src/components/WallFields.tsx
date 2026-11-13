/**
 * Dialog fields of the wall storage generator: openGrid boards and pegboards, and the holders
 * that clip into them (hook, ring, shelf, Gridfinity shelf, screw snap). Presets set everything
 * at once; every value stays editable and each change rebuilds the preview straight away.
 */
import { ShieldCheck } from "lucide-react";
import type { Expr, Feature } from "@meercad/schema";
import {
  OPENGRID,
  PEGBOARD_NAMES,
  PEGBOARDS,
  WALL,
  binShelfCells,
  pegboard,
  type PegGrid,
} from "@meercad/model";
import { checkInterference } from "../lib/interference";
import { describePlane } from "../lib/topology";
import { featureName, WALL_ACCESSORIES } from "../lib/features";
import { useApp } from "../store";
import { ExprInput } from "./ExprInput";
import { Count, Examples, Field, mm, num, PlaneBox, Seg } from "./GridfinityFields";
import { t } from "../lib/i18n";

type Wall = Extract<Feature, { op: "wall" }>;
type SetFn = (patch: Record<string, unknown>) => void;
type Accessory = NonNullable<Wall["accessory"]>;

const CLEAR: Partial<Wall> = {
  variant: undefined,
  screws: undefined,
  grid: undefined,
  pitch: undefined,
  hole: undefined,
  thickness: undefined,
  accessory: undefined,
  plate: undefined,
  depth: undefined,
  size: undefined,
};

/** Ready-made starting points; a holder preset keeps the board it sits on when the system matches. */
const PRESETS: { label: string; patch: Partial<Wall> }[] = [
  { label: t("openGrid board 4×4"), patch: { system: "opengrid", kind: "board", units: [4, 4] } },
  {
    label: t("openGrid lite 6×4 with screw holes"),
    patch: { system: "opengrid", kind: "board", units: [6, 4], variant: "lite", screws: true },
  },
  { label: t("Pegboard 8×6"), patch: { system: "pegboard", kind: "board", units: [8, 6] } },
  { label: t("Hook"), patch: { kind: "holder", units: [1, 1], accessory: "hook" } },
  {
    label: t("Ring for screwdrivers"),
    patch: { kind: "holder", units: [1, 1], accessory: "ring", size: 12 },
  },
  { label: t("Shelf"), patch: { kind: "holder", units: [3, 2], accessory: "shelf" } },
  {
    label: t("Shelf for 2 Gridfinity bins"),
    patch: { kind: "holder", units: [4, 2], accessory: "bin", size: 2 },
  },
];

const ACCESSORIES: Accessory[] = ["hook", "ring", "shelf", "bin", "plain", "screw"];

export function WallFields({ f: feature, set }: { f: Wall; set: SetFn }) {
  const features = useApp((state) => state.doc.features);
  const boards = features.filter(
    (x): x is Wall =>
      x.op === "wall" && x.kind === "board" && x.id !== feature.id && x.system === feature.system,
  );
  const board = boards.find((x) => x.id === feature.board);
  const holder = feature.kind === "holder";
  const og = feature.system === "opengrid";
  const acc = feature.accessory ?? "hook";
  const units: [number, number] = [num(feature.units[0], 1), num(feature.units[1], 1)];
  const pair = (k: "units" | "cell" | "position", i: number, expr: Expr, base: [Expr, Expr]) =>
    set({ [k]: base.map((x, j) => (j === i ? expr : x)) });
  // A holder takes the sizes of the board it sits on.
  const src = board ?? feature;
  const peg = pegboard(
    src.grid,
    num(src.pitch, NaN) || undefined,
    num(src.hole, NaN) || undefined,
    num(src.thickness, NaN) || undefined,
  );
  const pitch = og ? OPENGRID.pitch : peg.pitch;

  const usePreset = (p: Partial<Wall>) => {
    const system = p.system ?? feature.system;
    const keep = p.kind === "holder" && system === feature.system && feature.kind === "holder";
    const onBoard =
      p.kind === "holder" && !keep
        ? [...features]
            .reverse()
            .find(
              (x): x is Wall =>
                x.op === "wall" && x.kind === "board" && x.system === system && x.id !== feature.id,
            )
        : undefined;
    set({
      ...CLEAR,
      ...(p.kind === "board" ? { board: undefined, cell: undefined } : {}),
      ...(onBoard
        ? { board: onBoard.id, cell: feature.cell ?? [0, 0], plane: undefined, position: undefined }
        : {}),
      ...p,
      system,
    });
  };

  const setAccessory = (a: Accessory) => {
    const patch: Record<string, unknown> = {
      accessory: a,
      depth: undefined,
      size: undefined,
      plate: undefined,
    };

    if (a === "bin") {
      patch.units = [Math.max(units[0], binShelfCells(WALL.bins, pitch)), Math.max(units[1], 2)];
    }

    if (a === "screw") patch.units = [1, 1];

    set(patch);
  };

  let info = "";

  if (!holder) {
    info = t("{w} × {h} outside, {t} thick", {
      w: mm(units[0] * pitch),
      h: mm(units[1] * pitch),
      t: mm(og ? (feature.variant === "lite" ? OPENGRID.lite : OPENGRID.full) : peg.thickness),
    });
  } else if (acc === "screw") {
    info = t("A snap {w} square, {t} deep, screwed to the wall through its middle", {
      w: mm(OPENGRID.snap),
      t: mm(src.variant === "lite" ? OPENGRID.snapLite : OPENGRID.full),
    });
  } else {
    info = t("Plate {w} × {h}", {
      w: mm(units[0] * pitch - WALL.plateGap),
      h: mm(units[1] * pitch - WALL.plateGap),
    });
  }

  const bins = Math.round(num(feature.size, WALL.bins));
  const needCells = acc === "bin" ? binShelfCells(bins, pitch) : 0;

  if (holder && acc === "bin" && units[0] < needCells) {
    info += ` · ${t("{n} bins need {c} cells across", { n: bins, c: needCells })}`;
  }

  return (
    <>
      <Examples items={PRESETS} onPick={usePreset} />
      <Seg
        value={feature.system}
        options={[
          ["opengrid", "openGrid"],
          ["pegboard", t("Pegboard")],
        ]}
        onChange={(system) =>
          set({
            ...CLEAR,
            system,
            board: undefined,
            cell: undefined,
            ...(holder ? { accessory: acc === "screw" ? undefined : feature.accessory } : {}),
          })
        }
      />
      <Seg
        value={feature.kind}
        options={[
          ["board", t("Board")],
          ["holder", t("Holder")],
        ]}
        onChange={(kind) =>
          set(
            kind === "board"
              ? {
                  kind,
                  board: undefined,
                  cell: undefined,
                  accessory: undefined,
                  plate: undefined,
                  depth: undefined,
                  size: undefined,
                }
              : { kind, screws: undefined, units: [1, 1] },
          )
        }
      />
      {og && !board ? (
        <Field label={t("Thickness")}>
          <Seg
            value={feature.variant ?? "full"}
            options={[
              ["full", t("Full (6.8 mm)")],
              ["lite", t("Lite (4 mm)")],
            ]}
            onChange={(variant) => set({ variant: variant === "full" ? undefined : variant })}
          />
        </Field>
      ) : null}
      {!og && !board ? (
        <>
          <Field label={t("Hole pattern")}>
            <select
              className="field"
              value={feature.grid ?? "us_quarter"}
              onChange={(event) =>
                set({
                  grid: event.target.value === "us_quarter" ? undefined : event.target.value,
                  pitch: undefined,
                  hole: undefined,
                  thickness: undefined,
                })
              }
            >
              {(Object.keys(PEGBOARDS) as PegGrid[]).map((g) => (
                <option key={g} value={g}>
                  {t(PEGBOARD_NAMES[g])}
                </option>
              ))}
            </select>
          </Field>
          <div className="row">
            <Field label={t("Hole spacing")}>
              <ExprInput
                value={feature.pitch}
                placeholder={String(PEGBOARDS[feature.grid ?? "us_quarter"].pitch)}
                onCommit={(pitch) => set({ pitch })}
              />
            </Field>
            <Field
              label={PEGBOARDS[feature.grid ?? "us_quarter"].square ? t("Hole side") : t("Hole diameter")}
            >
              <ExprInput
                value={feature.hole}
                placeholder={String(PEGBOARDS[feature.grid ?? "us_quarter"].hole)}
                onCommit={(hole) => set({ hole })}
              />
            </Field>
          </div>
          <div className="row">
            <Field label={t("Board thickness")}>
              <ExprInput
                value={feature.thickness}
                placeholder={String(PEGBOARDS[feature.grid ?? "us_quarter"].thickness)}
                onCommit={(thickness) => set({ thickness })}
              />
            </Field>
            <div style={{ flex: 1 }} />
          </div>
        </>
      ) : null}
      {holder ? (
        <Field label={t("Holds")}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {ACCESSORIES.filter((a) => og || a !== "screw").map((a) => (
              <button
                key={a}
                className={`btn ${acc === a ? "primary" : ""}`}
                style={{ height: 30 }}
                onClick={() => setAccessory(a)}
              >
                {WALL_ACCESSORIES[a]}
              </button>
            ))}
          </div>
        </Field>
      ) : null}
      {acc !== "screw" || !holder ? (
        <div className="row">
          <Field label={t("Cells across")}>
            <Count
              value={feature.units[0]}
              min={1}
              max={60}
              onChange={(expr) => pair("units", 0, expr, feature.units)}
            />
          </Field>
          <Field label={t("Cells up")}>
            <Count
              value={feature.units[1]}
              min={1}
              max={60}
              onChange={(expr) => pair("units", 1, expr, feature.units)}
            />
          </Field>
        </div>
      ) : null}
      <p className="muted small">{info}</p>
      {!holder && og ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!feature.screws}
            onChange={(event) => set({ screws: event.target.checked || undefined })}
          />{" "}
          {t("Screw holes next to the corners")}
        </label>
      ) : null}
      {holder ? (
        <AccessoryFields f={feature} set={set} acc={acc} cellsFor={(n) => binShelfCells(n, pitch)} />
      ) : null}
      {holder && boards.length ? (
        <Field label={t("Hangs on")}>
          <select
            className="field"
            value={feature.board ?? ""}
            onChange={(event) =>
              set(
                event.target.value
                  ? {
                      board: event.target.value,
                      cell: feature.cell ?? [0, 0],
                      plane: undefined,
                      position: undefined,
                    }
                  : { board: undefined, cell: undefined },
              )
            }
          >
            <option value="">{t("Nothing (place freely)")}</option>
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {featureName(b)}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {feature.board ? (
        <>
          <div className="row">
            <Field label={t("Cell (column)")}>
              <Count
                value={feature.cell?.[0] ?? 0}
                min={0}
                max={200}
                onChange={(expr) => pair("cell", 0, expr, feature.cell ?? [0, 0])}
              />
            </Field>
            <Field label={t("Cell (row)")}>
              <Count
                value={feature.cell?.[1] ?? 0}
                min={0}
                max={200}
                onChange={(expr) => pair("cell", 1, expr, feature.cell ?? [0, 0])}
              />
            </Field>
          </div>
          <button className="btn" onClick={() => void checkInterference()}>
            <ShieldCheck /> {t("Check fit")}
          </button>
        </>
      ) : (
        <>
          <Field label={t("On")}>
            <PlaneBox
              value={describePlane(feature.plane ?? { ref: "origin.XY" })}
              placeholder={t("Tap a plane or flat face where it lies")}
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
        {og
          ? t(
              "openGrid is an open wall system on a 28 mm grid (by David D, CC BY 4.0). Holders click in on snaps; the lite board takes lite snaps, screws straight to the wall and is quicker to print.",
            )
          : t(
              "Pegboard holders hang on pegs through the holes: the top pegs hook up behind the board, so tilt the holder in from above.",
            )}
      </p>
    </>
  );
}

function AccessoryFields({
  f: feature,
  set,
  acc,
  cellsFor,
}: {
  f: Wall;
  set: SetFn;
  acc: Accessory;
  cellsFor: (bins: number) => number;
}) {
  const plate =
    acc !== "screw" ? (
      <Field label={t("Plate")}>
        <ExprInput
          value={feature.plate}
          placeholder={String(WALL.plate)}
          onCommit={(plate) => set({ plate })}
        />
      </Field>
    ) : null;
  const two = (
    a: [string, Expr | undefined, number, "depth" | "size"],
    b: [string, Expr | undefined, number, "depth" | "size"],
  ) => (
    <div className="row">
      {[a, b].map(([label, value, fallback, key]) => (
        <Field key={key} label={label}>
          <ExprInput
            value={value}
            placeholder={String(fallback)}
            onCommit={(expr) => set({ [key]: expr })}
            onLive={(expr) => set({ [key]: expr })}
          />
        </Field>
      ))}
      {plate}
    </div>
  );

  switch (acc) {
    case "hook":
      return two(
        [t("Reach"), feature.depth, WALL.hookDepth, "depth"],
        [t("Tip height"), feature.size, WALL.hookRise, "size"],
      );
    case "ring":
      return two(
        [t("Inner diameter"), feature.size, WALL.ringDiameter, "size"],
        [t("Gap to the plate"), feature.depth, WALL.ringDepth, "depth"],
      );
    case "shelf":
      return two(
        [t("Depth"), feature.depth, WALL.shelfDepth, "depth"],
        [t("Lip height"), feature.size, WALL.shelfLip, "size"],
      );
    case "bin":
      return (
        <div className="row">
          <Field label={t("Bins (42 mm)")}>
            <Count
              value={feature.size ?? WALL.bins}
              min={1}
              max={10}
              onChange={(size) =>
                set(
                  typeof size === "number"
                    ? { size, units: [Math.max(num(feature.units[0], 1), cellsFor(size)), feature.units[1]] }
                    : { size },
                )
              }
            />
          </Field>
          {plate}
        </div>
      );
    case "screw":
      return (
        <Field label={t("Screw diameter")}>
          <ExprInput
            value={feature.size}
            placeholder={String(WALL.screw)}
            onCommit={(size) => set({ size })}
          />
        </Field>
      );
    default:
      return <div className="row">{plate}</div>;
  }
}
