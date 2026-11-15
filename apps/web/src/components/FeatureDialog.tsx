import { ArrowLeftRight, Check, Cog, TriangleAlert, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  asArray,
  type AxisRef,
  type BooleanMode,
  type EdgeSelector,
  type Expr,
  type FaceSelector,
  type Feature,
  type PatternSource,
  type PlaneSpec,
  type ProfileRef,
  type ThreadProfile,
} from "@meercad/schema";
import type { RebuildOutput } from "@meercad/kernel/client";
import type { Pick, PickKind } from "@meercad/viewport";
import {
  gearDims,
  HOLE_SIZES,
  INSERT_SIZES,
  insertDims,
  insertLengths,
  METRIC_THREADS,
  parseMetric,
  SCREW_LENGTHS,
  STANDARD_CUT_TO_LENGTH,
  STANDARD_DEFAULT_SIZE,
  STANDARD_LYING,
  STANDARD_NAMES,
  STANDARD_SIZES,
  STANDARD_WITH_LENGTH,
  STANDARD_WITH_MOVING,
} from "@meercad/model";

/** The standard parts in the picker, by what they are for. */
const STANDARD_GROUPS: [string, (keyof typeof STANDARD_NAMES)[]][] = [
  [
    "Screws and nuts",
    ["socket_screw", "countersunk_screw", "hex_screw", "set_screw", "hex_nut", "washer", "insert"],
  ],
  ["Aluminium profiles", ["profile", "corner_bracket", "t_nut"]],
  ["Linear motion", ["rail", "lead_screw", "linear_bearing", "shaft"]],
  ["Bearings and magnets", ["bearing", "magnet"]],
];
import { frameFromPlane, toSketch } from "@meercad/sketch";
import { draftFeature, FEATURES, featureName, partName } from "../lib/features";
import { edgeInset, holeBesideEdge } from "../lib/holes";
import { gearParams, pairInfo } from "../lib/gears";
import { joinedParts } from "../lib/mechanism";
import { bendDefaults, bendInfo, describeBend, gapProblem, partsBox, unbentBox } from "../lib/bend";
import { BEND_MODES, evaluate } from "@meercad/model";
import {
  axisForPick,
  describeAxis,
  describeEdgeSelector,
  describeFaceSelector,
  describePlane,
  edgeSelectorForPick,
  faceSelectorForPick,
  planeSpecForPick,
  PLANE_LABELS,
} from "../lib/topology";
import {
  cancelDialog,
  commitDialog,
  openDraft,
  setDialogField,
  setDialogPick,
  updateDraft,
  useApp,
  type DialogState,
} from "../store";
import { ExprInput } from "./ExprInput";
import { usePrefs } from "../lib/keymap";
import { partSize, tooBig } from "../lib/printBed";
import { docUnit, inUnit } from "../lib/units";
import { GridfinityFields, LabelFields } from "./GridfinityFields";
import { BoxFields, SnapHookFields } from "./ClosureFields";
import { WallFields } from "./WallFields";
import { LithophaneFields } from "./LithophaneFields";
import { Kbd } from "./Kbd";
import { t, tn } from "../lib/i18n";

type Of<O extends Feature["op"]> = Extract<Feature, { op: O }>;

/** Changes the draft: the fields a step's form edits. */
type SetPatch = (patch: Record<string, unknown>) => void;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const toggle = <T,>(list: T[], item: T): T[] =>
  list.some((x) => same(x, item)) ? list.filter((x) => !same(x, item)) : [...list, item];

/** Which viewport entities the active selection field accepts. */
export function pickKindsFor(dialog: DialogState | null): Set<PickKind> {
  if (!dialog?.field) return new Set();

  const op = dialog.feature.op;
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
    // Holes also go beside a tapped edge, the right distance in.
    points: op === "hole" ? ["face", "edge"] : ["face"],
    catchIn: ["face", "edge"],
  };
  if (op === "linear_pattern" && dialog.field === "direction") return new Set(map["direction"]);

  return new Set(map[dialog.field] ?? []);
}

/**
 * A tapped point in the coordinates of the face's plane (the same frame the kernel uses), rounded to 0.01 mm.
 */
function holePoint(point: [number, number, number], normal: [number, number, number]): [number, number] {
  const [u, v] = toSketch(frameFromPlane(point, normal), point);

  return [Math.round(u * 100) / 100, Math.round(v * 100) / 100];
}

function featureOfFace(pick: Pick, features: Feature[]): string | null {
  if (pick.kind !== "face") return null;

  for (const tag of pick.tags) {
    const id = tag.split(/[.@[]/)[0]!;
    const feature = features.find((x) => x.id === id);
    if (feature && (feature.op === "extrude" || feature.op === "revolve")) return id;
  }

  return null;
}

/** The draft as a pick step changes it: a copy, written to by field name. */
type Draft = Record<string, unknown> & Feature;

/** What the view showed when the pick was made. */
interface PickScene {
  meshes: RebuildOutput["meshes"];
  report: RebuildOutput["report"] | null;
  features: Feature[];
}

/** One selection field's answer to a pick: changes the draft in place. */
type PickStep = (draft: Draft, pick: Pick, scene: PickScene, field: string) => void;

const bodyOf = (pick: Pick) => (pick.kind === "face" || pick.kind === "edge" ? pick.bodyId : null);
const jointsNow = () => useApp.getState().doc.mechanism?.joints;

/** Steps whose points are taps on the face of their plane. */
const placesPoints = (draft: Feature) =>
  draft.op === "hole" || draft.op === "standard_part" || draft.op === "snap_hook";

/** Steps centred, or started, where their face was tapped. */
const placedAtTap = (draft: Feature) =>
  draft.op === "text" ||
  draft.op === "label" ||
  draft.op === "box" ||
  draft.op === "lithophane" ||
  (draft.op === "gridfinity" && !draft.baseplate) ||
  (draft.op === "wall" && !draft.board);

/** The regions of the picked sketch the profile has now; the odd-depth ones when it takes them all. */
function profileRegions(
  profile: { sketch: string; regions?: string[] | "all" },
  pick: Extract<Pick, { kind: "region" }>,
  report: PickScene["report"],
): string[] {
  if (profile.sketch !== pick.sketchId) return [];

  if (Array.isArray(profile.regions)) return profile.regions;

  if (profile.regions !== "all" && profile.regions !== undefined) return [];

  return (
    report?.sketches
      .find((sketchView) => sketchView.id === pick.sketchId)
      ?.regions.filter((r) => r.depth % 2 === 1)
      .map((r) => r.key) ?? []
  );
}

/** Extrude or revolve profile: a face (extrude only), a whole sketch, or regions toggled in and out. */
const pickProfile: PickStep = (draft, pick, { meshes, report }) => {
  const prof0 = (draft as Of<"extrude">).profile;
  const prof = "sketch" in prof0 ? prof0 : { sketch: "", regions: undefined };

  if (pick.kind === "face" && draft.op === "extrude") {
    const fs = faceSelectorForPick(pick, meshes);
    if (fs) (draft as Of<"extrude">).profile = { face: fs };
  } else if (pick.kind === "sketch_curve") {
    (draft as Of<"extrude">).profile = { sketch: pick.sketchId };
  } else if (pick.kind === "region") {
    const next = toggle(profileRegions(prof, pick, report), pick.key);
    (draft as Of<"extrude">).profile = next.length
      ? { sketch: pick.sketchId, regions: next }
      : { sketch: "" };
  }
};

/** Loft profiles, in the order picked; picking one again takes it out. */
const pickLoftProfile: PickStep = (draft, pick, { meshes }) => {
  if (draft.op !== "loft") return;

  let item: ProfileRef | null = null;

  if (pick.kind === "region") {
    item = { sketch: pick.sketchId, regions: [pick.key] };
  } else if (pick.kind === "sketch_curve") {
    item = { sketch: pick.sketchId };
  } else if (pick.kind === "face") {
    const fs = faceSelectorForPick(pick, meshes);
    if (fs) item = { face: fs };
  }

  if (item) draft.profiles = toggle(draft.profiles, item);
};

/** Align's two faces: flat faces mate; round ones line up by their axes. */
const pickAlignFace: PickStep = (draft, pick, { meshes }, field) => {
  if (draft.op !== "align" || pick.kind !== "face") return;

  const fs = faceSelectorForPick(pick, meshes);
  if (!fs) return;

  draft[field] = pick.normal ? { face: fs } : { axisOf: fs };

  // The moved part takes the parts joined to it along, unless the target is one of them
  // (lining up parts of the same mechanism moves just the one).
  if (field === "from") {
    const group = joinedParts(pick.bodyId, jointsNow());
    draft.bodies = group.length > 1 ? group : undefined;
  } else if (draft.bodies?.includes(pick.bodyId)) {
    draft.bodies = undefined;
  }
};

/** Rib lines of one sketch; picking in another sketch starts over there. */
const pickRibCurve: PickStep = (draft, pick) => {
  if (draft.op !== "rib" || pick.kind !== "sketch_curve") return;

  const curves = draft.sketch === pick.sketchId ? (draft.curves ?? []) : [];
  const next = toggle(curves, pick.curveId);
  draft.sketch = next.length ? pick.sketchId : "";
  draft.curves = next.length ? next : undefined;
};

/** Sweep path: curves of one sketch; picking in another sketch starts over there. */
const pickPathCurve: PickStep = (draft, pick) => {
  if (draft.op !== "sweep" || pick.kind !== "sketch_curve") return;

  const curves = draft.path.sketch === pick.sketchId ? (draft.path.curves ?? []) : [];
  const next = toggle(curves, pick.curveId);
  draft.path = next.length ? { sketch: pick.sketchId, curves: next } : { sketch: "" };
};

/** An axis or direction; a move's rotation keeps its axis in the rotation. */
const pickAxis: PickStep = (draft, pick, { meshes }, field) => {
  const a = axisForPick(pick, meshes);
  if (a && draft.op === "transform" && draft.rotate) draft.rotate = { ...draft.rotate, axis: a };
  else if (a) (draft as unknown as Record<string, AxisRef>)[field] = a;
};

const pickEdge: PickStep = (draft, pick, { meshes }) => {
  const sel = edgeSelectorForPick(pick, meshes);
  if (sel) (draft as Of<"fillet">).edges = toggle(asArray((draft as Of<"fillet">).edges), sel);
};

const pickFaces: PickStep = (draft, pick, { meshes }) => {
  const sel = faceSelectorForPick(pick, meshes);
  if (sel) (draft as Of<"shell">).faces = toggle((draft as Of<"shell">).faces, sel);
};

const pickFace: PickStep = (draft, pick, { meshes }) => {
  const sel = faceSelectorForPick(pick, meshes);
  if (sel) (draft as Of<"thread">).face = sel;
};

/** Parts an extrude or revolve may merge with. */
const pickTargets: PickStep = (draft, pick) => {
  const b = bodyOf(pick);
  if (b) (draft as Of<"extrude">).targets = toggle((draft as Of<"extrude">).targets ?? [], b);
};

/** The part a boolean keeps; it stops being one of the tools. */
const pickBooleanTarget: PickStep = (draft, pick) => {
  const b = bodyOf(pick);

  if (b) {
    (draft as Of<"boolean">).target = b;
    (draft as Of<"boolean">).tools = (draft as Of<"boolean">).tools.filter((t) => t !== b);
  }
};

const pickBooleanTool: PickStep = (draft, pick) => {
  const b = bodyOf(pick);

  if (b && b !== (draft as Of<"boolean">).target) {
    (draft as Of<"boolean">).tools = toggle((draft as Of<"boolean">).tools, b);
  }
};

/** Parts to move, delete, split, scale or bend. */
const pickBodies: PickStep = (draft, pick) => {
  const b = bodyOf(pick);
  if (!b) return;

  const cur = (draft as Of<"transform" | "delete">).bodies;

  // Moving a part takes the parts joined to it along, so the joints stay together.
  if (draft.op === "transform" && !draft.copy && !cur.includes(b)) {
    draft.bodies = [...new Set([...cur, ...joinedParts(b, jointsNow())])];
  } else {
    (draft as Of<"transform" | "delete">).bodies = toggle(cur, b);
  }

  // The first part picked for a bend sets which way it bends and how far, from its shape.
  if (draft.op === "bend" && !cur.length && draft.bodies.length) {
    const box = partsBox(useApp.getState().baseOutput, draft.bodies);
    if (box) Object.assign(draft, bendDefaults(draft.mode, box));
  }
};

/** Parts a snap hook catches in. */
const pickCatch: PickStep = (draft, pick) => {
  const b = bodyOf(pick);
  if (b && draft.op === "snap_hook") draft.catchIn = toggle(draft.catchIn ?? [], b);
};

/** The mesh part to convert. */
const pickMeshBody: PickStep = (draft, pick) => {
  const b = bodyOf(pick);
  if (b) (draft as Of<"mesh_convert">).body = b;
};

/** The part a Gridfinity bin holds (not the bin itself). */
const pickPocket: PickStep = (draft, pick) => {
  const b = bodyOf(pick);
  if (b && draft.op === "gridfinity" && b !== draft.id) draft.pocket = { ...draft.pocket, body: b };
};

/** What a pattern or mirror repeats: features (by a face of theirs) or parts. */
const pickSource: PickStep = (draft, pick, { features }) => {
  const src = (draft as Of<"mirror">).source;

  if ("features" in src) {
    const fid = featureOfFace(pick, features);
    if (fid) (draft as Of<"mirror">).source = { features: toggle(src.features, fid) };
  } else {
    const b = bodyOf(pick);
    if (b) (draft as Of<"mirror">).source = { bodies: toggle(src.bodies, b) };
  }
};

/**
 * A plane, or a flat face; a step placed on a face also goes where it was tapped: a hole's point, a
 * spring's or screw's centre, the start of a text, the centre of a label, box, bin, wall board or
 * lithophane.
 */
const pickPlane: PickStep = (draft, pick, { meshes }, field) => {
  const spec = planeSpecForPick(pick, meshes);
  if (!spec) return;

  (draft as unknown as Record<string, PlaneSpec>)[field] = spec;
  if (pick.kind !== "face" || !pick.normal) return;

  if (placesPoints(draft)) {
    (draft as Of<"hole">).points = [holePoint(pick.point, pick.normal)];
  } else if (draft.op === "spring" || draft.op === "screw") {
    draft.center = holePoint(pick.point, pick.normal);
  } else if (placedAtTap(draft)) {
    (draft as Of<"text">).position = holePoint(pick.point, pick.normal);
  }
};

/** A tapped edge puts a hole beside it, as far in as the wall to the edge needs. */
function holeBesidePickedEdge(draft: Of<"hole">, pick: Extract<Pick, { kind: "edge" }>, scene: PickScene) {
  const mesh = scene.meshes.find((mesh) => mesh.bodyId === pick.bodyId);
  const inset = edgeInset(draft);
  const tag = "face" in draft.plane && "face" in draft.plane.face ? draft.plane.face.face : undefined;
  const at = mesh && inset !== undefined ? holeBesideEdge(mesh, pick.edge, pick.point, inset, tag) : null;
  if (at) draft.points = [...draft.points, holePoint(at.point, at.normal)];
}

/** Points are the tap projected onto the hole's plane (u, v are the same on parallel faces). */
const pickPoint: PickStep = (draft, pick, scene) => {
  if (draft.op === "hole" && pick.kind === "edge") {
    holeBesidePickedEdge(draft, pick, scene);

    return;
  }

  if (!placesPoints(draft) || pick.kind !== "face" || !pick.normal) return;

  (draft as Of<"hole">).points = [...(draft as Of<"hole">).points, holePoint(pick.point, pick.normal)];
};

/** What a pick in the view does, by the selection field that is active. */
const PICK_STEPS = new Map<string, PickStep>([
  ["profile", pickProfile],
  ["profiles", pickLoftProfile],
  ["from", pickAlignFace],
  ["to", pickAlignFace],
  ["curves", pickRibCurve],
  ["path", pickPathCurve],
  ["axis", pickAxis],
  ["direction", pickAxis],
  ["direction2", pickAxis],
  ["edges", pickEdge],
  ["faces", pickFaces],
  ["face", pickFace],
  ["targets", pickTargets],
  ["target", pickBooleanTarget],
  ["bodies", pickBodies],
  ["catchIn", pickCatch],
  ["body", pickMeshBody],
  ["pocket", pickPocket],
  ["tools", pickBooleanTool],
  ["source", pickSource],
  ["plane", pickPlane],
  ["base", pickPlane],
  ["neutral", pickPlane],
  ["upTo", pickPlane],
  ["points", pickPoint],
]);

/** Fields that hold one thing: a pick there moves on to the next field. */
const SINGLE_VALUED = ["axis", "direction", "plane", "base", "neutral", "upTo", "target", "from", "to"];

/** The field after a single-valued one: align's target face, boolean's tools, a hole's points. */
function fieldAfter(op: Feature["op"], field: string): string | null {
  if (op === "align" && field === "from") return "to";

  if (op === "boolean" && field === "target") return "tools";

  if ((op === "hole" || op === "standard_part" || op === "snap_hook") && field === "plane") return "points";

  return null;
}

function handlePick(pick: Pick, dialog: DialogState): void {
  const { meshes, report } = useApp.getState().output ?? { meshes: [], report: null };
  const scene: PickScene = { meshes, report, features: useApp.getState().doc.features };
  const field = dialog.field;
  if (!field) return;

  updateDraft((cur) => {
    const draft = structuredClone(cur) as Draft;
    PICK_STEPS.get(field)?.(draft, pick, scene, field);

    return draft as Feature;
  });

  if (SINGLE_VALUED.includes(field)) setDialogField(fieldAfter(dialog.feature.op, field));
}

/** Whether a step takes whole parts: several parts selected before opening it become its parts. */
const takesParts = (op: Feature["op"]) =>
  op === "transform" ||
  op === "delete" ||
  op === "mirror" ||
  op === "linear_pattern" ||
  op === "circular_pattern";

/**
 * Picks made before opening the dialog seed its first field (select edges → Fillet); several selected
 * parts become the parts to move, delete, mirror or pattern.
 */
function seedFromSelection(dialog: DialogState): void {
  let pre = useApp.getState().selection;
  const feature = dialog.feature;

  if (pre.length > 1 && takesParts(feature.op)) {
    let ids = [...new Set(pre.flatMap((pick) => (pick.kind === "face" ? [pick.bodyId] : [])))];
    if (feature.op === "transform") ids = [...new Set(ids.flatMap((b) => joinedParts(b)))];

    if (feature.op === "transform" || feature.op === "delete") {
      updateDraft({ bodies: ids } as Partial<Feature>);
    } else {
      updateDraft({ source: { bodies: ids } } as Partial<Feature>);
    }

    pre = [];
    useApp.setState({ selection: [] });
  }

  if (pre.length && dialog.isNew) {
    for (const pick of pre) {
      const cur = useApp.getState().dialog;
      if (cur) handlePick(pick, cur);
    }

    useApp.setState({ selection: [] });
  }
}

export function FeatureDialog() {
  const dialog = useApp((state) => state.dialog);
  const previewError = useApp((state) => state.previewError);
  const status = useApp((state) =>
    state.previewing && state.dialog
      ? state.output?.report.features.find((x) => x.id === state.dialog!.feature.id)
      : undefined,
  );
  useEffect(() => {
    if (!dialog) return;

    setDialogPick((pick) => {
      const cur = useApp.getState().dialog;
      if (cur) handlePick(pick, cur);
    });
    seedFromSelection(dialog);

    return () => {
      setDialogPick(null);
    };
  }, [dialog?.feature.id]);
  if (!dialog || dialog.gesture) return null;

  const feature = dialog.feature;
  const Icon = FEATURES[feature.op].icon;
  const problem = previewError;

  return (
    <div className="dialog" onKeyDown={(event) => event.key === "Escape" && cancelDialog()}>
      <div className="dialog-head">
        <Icon className="ficon" />
        <h3>{dialog.isNew ? FEATURES[feature.op].label : featureName(feature)}</h3>
        <span className="muted mono" style={{ fontSize: 11 }}>
          {feature.id}
        </span>
      </div>
      <div className="dialog-body">
        <Body d={dialog} />
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
        <span
          className="muted key-hint"
          style={{ marginRight: "auto", fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}
        >
          <Kbd k="↵" /> {t("accept")} <Kbd k="Esc" /> {t("cancel")}
        </span>
        <button className="cancel-btn" onClick={cancelDialog} title={t("Cancel (Esc)")}>
          <X />
        </button>
        <button
          className="ok-btn"
          onClick={() => commitDialog()}
          disabled={!!problem || status?.status === "error"}
          title={t("Accept (Enter)")}
        >
          <Check />
        </button>
      </div>
    </div>
  );
}

function SelBox({
  field,
  items,
  placeholder,
  onRemove,
}: {
  field: string;
  items: string[];
  placeholder: string;
  onRemove?: (i: number) => void;
}) {
  const active = useApp((state) => state.dialog?.field === field);

  return (
    <div
      className={`selbox ${active ? "active" : ""}`}
      onClick={() => setDialogField(active ? null : field)}
      role="button"
      tabIndex={0}
    >
      {items.length ? (
        items.map((item, i) => (
          <span className="chip" key={i} title={item}>
            <span>{item}</span>
            {onRemove ? (
              <button onClick={(event) => (event.stopPropagation(), onRemove(i))} aria-label={t("Remove")}>
                <X />
              </button>
            ) : null}
          </span>
        ))
      ) : (
        <span className="placeholder">
          {active ? t("{what} in the viewport…", { what: placeholder }) : placeholder}
        </span>
      )}
    </div>
  );
}

/** Whether the parts (as the preview shows them) fit the print bed set in Settings. */
function BedCheck() {
  const bodies = useApp((state) => state.output?.report.bodies);
  const bed = usePrefs((prefs) => prefs.printBed);
  const doc = useApp((state) => state.doc);
  if (!bed || !bodies?.length) return null;

  const big = tooBig(bodies, bed);
  const size = `${bed.map((v) => inUnit(v)).join(" × ")} ${docUnit()}`;

  return big.length ? (
    <p className="small bed-warn">
      <TriangleAlert />{" "}
      {t("Still too big for the print bed ({bed}): {parts}", {
        bed: size,
        parts: big
          .map(
            (b) =>
              `${partName(b.id, doc.features)} (${partSize(b.bbox)
                .map((v) => inUnit(v))
                .join(" × ")})`,
          )
          .join(", "),
      })}
    </p>
  ) : (
    <p className="muted small">{t("Every part fits the print bed ({bed}).", { bed: size })}</p>
  );
}

/** Pins, dowels or a dovetail at the cut, so the printed pieces go back together in one place. */
function SplitConnectorFields({
  f: feature,
  set,
}: {
  f: Extract<Feature, { op: "split" }>;
  set: (patch: Partial<Extract<Feature, { op: "split" }>>) => void;
}) {
  const c = feature.connectors;
  const put = (patch: Partial<NonNullable<typeof c>>) => c && set({ connectors: { ...c, ...patch } });
  const auto = (expr: Expr) => (expr === 0 ? undefined : expr);

  return (
    <>
      <Field label={t("Connectors")}>
        <Seg
          value={c?.kind ?? "none"}
          options={[
            ["none", t("Without")],
            ["pins", t("Pins")],
            ["dowels", t("Dowels")],
            ["dovetail", t("Dovetail")],
          ]}
          onChange={(kind) => set({ connectors: kind === "none" ? undefined : { ...c, kind } })}
        />
      </Field>
      {c ? (
        <>
          <div className="row">
            <Field label={c.kind === "dovetail" ? t("Width") : t("Diameter")}>
              <ExprInput
                value={c.size}
                placeholder={t("auto")}
                onCommit={(size) => put({ size: auto(size) })}
              />
            </Field>
            <Field label={c.kind === "dowels" ? t("Length") : t("Depth")}>
              <ExprInput
                value={c.depth}
                placeholder={t("auto")}
                onCommit={(depth) => put({ depth: auto(depth) })}
              />
            </Field>
          </div>
          <div className="row">
            <Field label={t("Clearance")}>
              <ExprInput value={c.clearance} placeholder="0.2" onCommit={(clearance) => put({ clearance })} />
            </Field>
            {c.kind === "dovetail" ? null : (
              <Field label={t("Count")}>
                <ExprInput
                  value={c.count}
                  unit=""
                  integer
                  placeholder={t("auto")}
                  onCommit={(count) => put({ count: auto(count) })}
                />
              </Field>
            )}
          </div>
          {c.kind === "dovetail" ? (
            <Field label={t("Slides in along")}>
              <Seg
                value={c.slide ?? "long"}
                options={[
                  ["long", t("Longer side")],
                  ["short", t("Shorter side")],
                ]}
                onChange={(slide) => put({ slide: slide === "long" ? undefined : slide, angle: undefined })}
              />
            </Field>
          ) : null}
          <p className="muted small">
            {c.kind === "pins"
              ? t(
                  "Pins grow out of the front piece into holes in the back piece, placed on the cut with wall around them. Clearance is the gap on every side; 0 for auto sizes.",
                )
              : c.kind === "dowels"
                ? t(
                    "Holes in both pieces and loose dowels as their own parts: print them lying down, or use bought dowel pins. Clearance is the gap on every side; 0 for auto sizes.",
                  )
                : t(
                    "A dovetail tongue on the front piece runs across the cut; the back piece slides onto it from the side. Clearance is the gap on every side; 0 for auto sizes.",
                  )}
          </p>
        </>
      ) : null}
    </>
  );
}

function Seg<T extends string>({
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

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="fld">
    <span className="fld-label">{label}</span>
    {children}
  </div>
);

/** Turns a step the other way round: its `flip`, as an icon button beside the field it belongs to. */
function FlipButton({ flip, title, set }: { flip: boolean | undefined; title: string; set: SetPatch }) {
  return (
    <button
      className={`icon-btn ${flip ? "active" : ""}`}
      title={title}
      onClick={() => set({ flip: flip ? undefined : true })}
    >
      <ArrowLeftRight />
    </button>
  );
}

/** Picks a whole sketch from a list, for steps that also take its regions or lines one by one. */
function SketchSelect({
  sketches,
  prompt,
  onPick,
}: {
  sketches: Of<"sketch">[];
  prompt: string;
  onPick: (sketch: string) => void;
}) {
  if (!sketches.length) return null;

  return (
    <select className="field" value="" onChange={(event) => onPick(event.target.value)}>
      <option value="">{prompt}</option>
      {sketches.map((sketch) => (
        <option key={sketch.id} value={sketch.id}>
          {featureName(sketch)}
        </option>
      ))}
    </select>
  );
}

const MODES: [BooleanMode, string][] = [
  ["new_body", t("mode::New")],
  ["join", t("mode::Add")],
  ["cut", t("mode::Remove")],
  // "Schnittmenge" does not fit beside the other three.
  ["intersect", t("mode::Intersect")],
];

function AxisButtons({
  value,
  onChange,
  kind = "axis",
}: {
  value: AxisRef;
  onChange: (a: AxisRef) => void;
  kind?: string;
}) {
  return (
    <div className="row">
      {(["origin.X", "origin.Y", "origin.Z"] as const).map((r) => (
        <button
          key={r}
          className={`btn ${"ref" in value && value.ref === r ? "primary" : ""}`}
          style={{ flex: 1, height: 26 }}
          onClick={() => onChange({ ref: r })}
          title={
            kind === "direction" ? t("{a} direction", { a: r.slice(7) }) : t("{a} axis", { a: r.slice(7) })
          }
        >
          {r.slice(7)}
        </button>
      ))}
    </div>
  );
}

function PlaneButtons({ value, onChange }: { value: PlaneSpec; onChange: (plane: PlaneSpec) => void }) {
  return (
    <div className="row">
      {Object.entries(PLANE_LABELS).map(([ref, label]) => (
        <button
          key={ref}
          className={`btn ${"ref" in value && value.ref === ref ? "primary" : ""}`}
          style={{ flex: 1, height: 26 }}
          onClick={() => onChange({ ref })}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function SourceField({ value, onChange }: { value: PatternSource; onChange: (s: PatternSource) => void }) {
  const features = useApp((state) => state.doc.features);
  const draftId = useApp((state) => state.dialog?.feature.id);
  const kind = "features" in value ? "features" : "bodies";
  const items = "features" in value ? value.features : value.bodies;
  const candidates = features.filter(
    (feature) => (feature.op === "extrude" || feature.op === "revolve") && feature.id !== draftId,
  );

  return (
    <>
      <Seg
        value={kind}
        options={[
          ["features", t("Features")],
          ["bodies", t("Parts")],
        ]}
        onChange={(k) => onChange(k === "features" ? { features: [] } : { bodies: [] })}
      />
      <SelBox
        field="source"
        items={items.map((id) =>
          kind === "features"
            ? featureName(features.find((feature) => feature.id === id) ?? ({ id, op: "extrude" } as Feature))
            : partName(id, features),
        )}
        placeholder={kind === "features" ? t("Pick faces of extrudes/revolves") : t("Pick parts")}
        onRemove={(i) =>
          onChange(
            kind === "features"
              ? { features: items.filter((_, j) => j !== i) }
              : { bodies: items.filter((_, j) => j !== i) },
          )
        }
      />
      {kind === "features" && candidates.length ? (
        <div className="col" style={{ gap: 4 }}>
          {candidates.map((feature) => (
            <label className="checkbox" key={feature.id}>
              <input
                type="checkbox"
                checked={items.includes(feature.id)}
                onChange={() => onChange({ features: toggle(items, feature.id) })}
              />
              {featureName(feature)}
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
function ThreadForm({
  profile,
  diameter,
  pitch,
  starts,
  set,
  diameterPlaceholder,
  pitchPlaceholder,
}: {
  profile?: ThreadProfile;
  diameter?: Expr;
  pitch?: Expr;
  starts?: Expr;
  set: SetPatch;
  diameterPlaceholder?: string;
  pitchPlaceholder?: string;
}) {
  return (
    <>
      <Field label={t("Thread form")}>
        <select
          className="field"
          value={profile ?? "iso"}
          onChange={(event) =>
            set({
              profile: event.target.value === "iso" ? undefined : event.target.value,
              pitch: undefined,
              ...(event.target.value === "iso" ? {} : { size: undefined }),
            })
          }
        >
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
            <ExprInput
              value={diameter}
              placeholder={diameterPlaceholder}
              onCommit={(diameter) => set({ diameter })}
              onLive={(diameter) => set({ diameter })}
            />
          </Field>
        ) : null}
        <Field label={t("Pitch")}>
          <ExprInput
            value={pitch}
            placeholder={pitchPlaceholder ?? t("auto")}
            onCommit={(pitch) => set({ pitch })}
            onLive={(pitch) => set({ pitch })}
          />
        </Field>
        <Field label={t("Starts")}>
          <ExprInput
            value={starts}
            unit=""
            integer
            placeholder="1"
            onCommit={(starts) => set({ starts: starts === 1 ? undefined : starts })}
            onLive={(starts) => set({ starts })}
          />
        </Field>
      </div>
    </>
  );
}

function ThreadFields({ f: feature, set }: { f: Of<"thread">; set: SetPatch }) {
  const std = feature.size
    ? METRIC_THREADS.find((thread) => thread.d === parseMetric(feature.size!))
    : undefined;
  const pitches = std ? [std.pitch, ...std.fine] : [];
  const custom = feature.pitch !== undefined && !pitches.includes(feature.pitch as number);
  const hasFace = !("face" in feature.face) || !!feature.face.face;
  const metric = (feature.profile ?? "iso") === "iso" && feature.diameter === undefined;

  if (!metric) {
    return (
      <>
        <Field label={t("Hole wall or shaft")}>
          <SelBox
            field="face"
            items={hasFace ? [describeFaceSelector(feature.face)] : []}
            placeholder={t("Pick a round face")}
          />
        </Field>
        <ThreadForm
          profile={feature.profile}
          diameter={feature.diameter}
          pitch={feature.pitch}
          starts={feature.starts}
          set={set}
          diameterPlaceholder={t("as drawn")}
        />
        <ThreadCommon f={feature} set={set} />
      </>
    );
  }

  return (
    <>
      <Field label={t("Hole wall or shaft")}>
        <SelBox
          field="face"
          items={hasFace ? [describeFaceSelector(feature.face)] : []}
          placeholder={t("Pick a round face")}
        />
      </Field>
      <Field label={t("Thread form")}>
        <select
          className="field"
          value="iso"
          onChange={(event) =>
            set({
              profile: event.target.value === "iso" ? undefined : event.target.value,
              size: undefined,
              pitch: undefined,
            })
          }
        >
          {THREAD_PROFILE_LABELS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <Field label={t("Size")}>
          <select
            className="field"
            value={feature.size ?? ""}
            onChange={(event) => set({ size: event.target.value || undefined, pitch: undefined })}
          >
            <option value="">{t("Auto (from diameter)")}</option>
            {METRIC_THREADS.map((thread) => (
              <option key={thread.size} value={thread.size}>
                {thread.size}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("Pitch")}>
          <select
            className="field"
            value={custom ? "custom" : feature.pitch === undefined ? "" : String(feature.pitch)}
            onChange={(event) =>
              set({
                pitch:
                  event.target.value === ""
                    ? undefined
                    : event.target.value === "custom"
                      ? (std?.pitch ?? 1)
                      : Number(event.target.value),
              })
            }
          >
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
          <ExprInput value={feature.pitch} autoFocus onCommit={(pitch) => set({ pitch })} />
        </Field>
      ) : null}
      <Field label={t("Starts")}>
        <ExprInput
          value={feature.starts}
          unit=""
          integer
          placeholder="1"
          onCommit={(starts) => set({ starts: starts === 1 ? undefined : starts })}
        />
      </Field>
      <ThreadCommon f={feature} set={set} />
    </>
  );
}

function ThreadCommon({ f: feature, set }: { f: Of<"thread">; set: SetPatch }) {
  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={feature.length === undefined}
          onChange={(event) => set({ length: event.target.checked ? undefined : 10 })}
        />{" "}
        {t("Thread the whole face")}
      </label>
      {feature.length !== undefined ? (
        <Field label={t("Length from the open end")}>
          <ExprInput
            value={feature.length}
            onCommit={(length) => set({ length })}
            onLive={(length) => set({ length })}
          />
        </Field>
      ) : null}
      <Field label={t("Clearance per side (3D printing)")}>
        <ExprInput
          value={feature.clearance}
          placeholder="0"
          onCommit={(clearance) => set({ clearance: clearance === 0 ? undefined : clearance })}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.leftHanded}
          onChange={(event) => set({ leftHanded: event.target.checked || undefined })}
        />{" "}
        {t("Left-hand thread")}
      </label>
      <p className="muted small">
        {t(
          "Holes get an internal thread, shafts an external one. Draw holes at the nominal size or the tap drill size; about 0.1–0.2 mm clearance helps printed threads fit.",
        )}
      </p>
    </>
  );
}

/**
 * Switching how a bend works: values that fit the parts' box when there are parts, else the defaults
 * of the new mode.
 */
function bendModePatch(mode: Of<"bend">["mode"], box: Parameters<typeof bendDefaults>[1] | null) {
  return box
    ? { ...bendDefaults(mode, box) }
    : {
        mode,
        ...(mode === "spiral"
          ? { radius: 20, gap: 1, angle: undefined }
          : mode === "wrap"
            ? { radius: 30, gap: undefined, angle: undefined }
            : { angle: 90, radius: undefined, gap: undefined }),
      };
}

/** Bend: parts, how (bend, wrap, spiral), axis and the values of that mode, and what it comes to. */
function BendFields({ f: feature, set }: { f: Of<"bend">; set: SetPatch }) {
  const features = useApp((state) => state.doc.features);
  const params = useApp((state) => state.baseOutput?.report.params);
  const base = useApp((state) => state.baseOutput);
  // The preview's numbers, else (a preview that failed) the last good ones or the saved step's.
  const fresh = useApp((state) => bendInfo(state.output, feature.id));
  const lastGood = useRef<Record<string, number> | null>(null);
  if (fresh) lastGood.current = fresh;

  const known = fresh ?? lastGood.current ?? bendInfo(base, feature.id);
  // Numbers of another mode (the preview not caught up yet) are not shown.
  const info = fresh && fresh["mode"] === BEND_MODES.indexOf(feature.mode) ? fresh : null;

  const num = (expr: Expr | undefined) => {
    if (expr === undefined) return undefined;

    try {
      return evaluate(expr, new Map(Object.entries(params ?? {})));
    } catch {
      return undefined;
    }
  };

  // The parts as they were before bending: from the bend's numbers, else the model before this step.
  const box = known ? unbentBox(known) : partsBox(base, feature.bodies);
  const gap = gapProblem(feature, feature.mode === "spiral" ? (num(feature.gap) ?? 1) : undefined);

  return (
    <>
      <Field label={t("Parts")}>
        <SelBox
          field="bodies"
          items={feature.bodies.map((b) => partName(b, features))}
          placeholder={t("Pick parts")}
          onRemove={(i) => set({ bodies: feature.bodies.filter((_, j) => j !== i) })}
        />
      </Field>
      <Seg
        value={feature.mode}
        options={[
          ["bend", t("Bend")],
          ["wrap", t("Ring")],
          ["spiral", t("Spiral")],
        ]}
        onChange={(mode) => set(bendModePatch(mode, feature.bodies.length ? box : null))}
      />
      <Field label={feature.mode === "spiral" ? t("Axis of the coil") : t("Bend axis")}>
        <SelBox field="axis" items={[describeAxis(feature.axis)]} placeholder={t("Pick an edge or line")} />
        <AxisButtons value={feature.axis} onChange={(axis) => set({ axis })} />
      </Field>
      {feature.mode === "bend" ? (
        feature.angle !== undefined || feature.radius === undefined ? (
          <Field label={t("Angle")}>
            <ExprInput
              value={feature.angle ?? 90}
              unit="deg"
              autoFocus
              onCommit={(angle) => set({ angle, radius: undefined })}
              onLive={(angle) => set({ angle, radius: undefined })}
            />
          </Field>
        ) : (
          <Field label={t("Radius")}>
            <ExprInput
              value={feature.radius}
              autoFocus
              onCommit={(radius) => set({ radius })}
              onLive={(radius) => set({ radius })}
            />
          </Field>
        )
      ) : (
        <Field label={feature.mode === "spiral" ? t("Inner radius") : t("Cylinder radius")}>
          <div className="row">
            <div style={{ flex: 1 }}>
              <ExprInput
                value={feature.radius ?? 20}
                autoFocus
                onCommit={(radius) => set({ radius })}
                onLive={(radius) => set({ radius })}
              />
            </div>
            {feature.mode === "wrap" && (known || box) ? (
              <button
                className="btn"
                onClick={() =>
                  set({
                    radius: known
                      ? +(known["length"]! / (2 * Math.PI)).toFixed(3)
                      : bendDefaults("wrap", box!).radius,
                  })
                }
                title={t("Make the ring's ends meet")}
              >
                {t("Close ring")}
              </button>
            ) : null}
          </div>
        </Field>
      )}
      {feature.mode === "spiral" ? (
        <Field label={t("Gap between turns")}>
          <ExprInput
            value={feature.gap ?? 1}
            onCommit={(expr) => set({ gap: expr })}
            onLive={(expr) => set({ gap: expr })}
          />
        </Field>
      ) : null}
      {gap ? <div className={`callout ${gap.error ? "err" : "warn"}`}>{gap.text}</div> : null}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.flip}
          onChange={(event) => set({ flip: event.target.checked || undefined })}
        />{" "}
        {t("Bend the other way")}
      </label>
      {feature.mode === "spiral" ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!feature.reverse}
            onChange={(event) => set({ reverse: event.target.checked || undefined })}
          />{" "}
          {t("Start at the other end")}
        </label>
      ) : null}
      <Field label={t("Tolerance")}>
        <ExprInput
          value={feature.tolerance}
          placeholder="auto"
          onCommit={(tolerance) => set({ tolerance: tolerance === 0 ? undefined : tolerance })}
        />
      </Field>
      {info ? <p className="small">{describeBend(feature.mode, info)}</p> : null}
      <p className="muted small">
        {feature.mode === "spiral"
          ? t(
              "Rolls a long strip into a flat coil that fits the print bed: a ruler, a band of text, a chain. The length in the middle of the strip stays the same.",
            )
          : feature.mode === "wrap"
            ? t(
                "Lays the part onto a cylinder, its bottom face on it: a flat pattern becomes a ring or a bracelet. Close ring makes the ends meet.",
              )
            : t(
                "Bends the part round the axis by the angle, about its middle; the length in the middle of the thickness stays the same.",
              )}{" "}
        {t("The result is a mesh part; drag the arrow to change the radius.")}
      </p>
    </>
  );
}

/** Scale: parts, factor (typed, or from a measured and a wanted length), about what. */
function ScaleFields({ f: feature, set }: { f: Of<"scale">; set: SetPatch }) {
  const features = useApp((state) => state.doc.features);
  const [measured, setMeasured] = useState("");
  const [wanted, setWanted] = useState("");
  const m = Number(measured.replace(",", ".")),
    w = Number(wanted.replace(",", "."));
  const ready = m > 0 && w > 0;

  return (
    <>
      <Field label={t("Parts")}>
        <SelBox
          field="bodies"
          items={feature.bodies.map((b) => partName(b, features))}
          placeholder={t("Pick parts")}
          onRemove={(i) => set({ bodies: feature.bodies.filter((_, j) => j !== i) })}
        />
      </Field>
      <Field label={t("Factor")}>
        <ExprInput
          value={feature.factor}
          autoFocus
          unit=""
          onCommit={(factor) => set({ factor })}
          onLive={(factor) => set({ factor })}
        />
      </Field>
      <Field label={t("From a measurement")}>
        <div className="row">
          <input
            className="field"
            inputMode="decimal"
            placeholder={t("measured")}
            value={measured}
            onChange={(event) => setMeasured(event.target.value)}
          />
          <input
            className="field"
            inputMode="decimal"
            placeholder={t("should be")}
            value={wanted}
            onChange={(event) => setWanted(event.target.value)}
          />
          <button
            className="btn"
            disabled={!ready}
            onClick={() => set({ factor: `${w} / ${m}` })}
            title={t("Use wanted ÷ measured as the factor")}
          >
            {t("Use")}
          </button>
        </div>
      </Field>
      <Field label={t("About")}>
        <Seg
          value={feature.center ?? "part"}
          options={[
            ["part", t("Each part's centre")],
            ["origin", t("Origin")],
          ]}
          onChange={(center) => set({ center: center === "part" ? undefined : center })}
        />
      </Field>
      <p className="muted small">
        {t(
          "To correct a scan, measure a length on the real part with calipers, measure the same length on the model, and enter both.",
        )}
      </p>
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

/** Switching a hole to another kind: a plain hole keeps a diameter, the others a size they come in. */
function holeKindPatch(feature: Of<"hole">, kind: Of<"hole">["kind"]) {
  const withoutInsert = kind === "insert" ? {} : { length: undefined, withInserts: undefined };

  return kind === "simple"
    ? {
        kind,
        size: undefined,
        fit: undefined,
        diameter: feature.diameter ?? 5,
        allowance: feature.allowance ?? "2 * fit",
        ...withoutInsert,
      }
    : {
        kind,
        diameter: undefined,
        size: (kind === "insert" ? INSERT_SIZES : HOLE_SIZES).includes(feature.size ?? "")
          ? feature.size
          : "M3",
        ...(kind === "insert" ? { depth: undefined, length: undefined } : withoutInsert),
      };
}

/** Hole: kind and size, where (a flat face, tapped points), depth, printing allowance. */
function HoleFields({ f: feature, set }: { f: Of<"hole">; set: SetPatch }) {
  const sizes = feature.kind === "insert" ? INSERT_SIZES : HOLE_SIZES;
  const screw =
    feature.kind === "clearance" || feature.kind === "counterbore" || feature.kind === "countersink";

  return (
    <>
      <Field label={t("Hole")}>
        <select
          className="field"
          value={feature.kind}
          onChange={(event) => set(holeKindPatch(feature, event.target.value as Of<"hole">["kind"]))}
        >
          {HOLE_KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        {feature.kind === "simple" ? (
          <Field label={t("Diameter")}>
            <ExprInput
              value={feature.diameter}
              autoFocus
              onCommit={(diameter) => set({ diameter })}
              onLive={(diameter) => set({ diameter })}
            />
          </Field>
        ) : (
          <Field label={feature.kind === "insert" ? t("Insert") : t("Screw")}>
            <select
              className="field"
              value={feature.size ?? "M3"}
              onChange={(event) =>
                set({ size: event.target.value, ...(feature.kind === "insert" ? { length: undefined } : {}) })
              }
            >
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        )}
        {feature.kind === "insert" ? (
          <InsertLength size={feature.size ?? "M3"} length={feature.length} set={set} />
        ) : null}
        {screw ? (
          <Field label={t("Fit")}>
            <select
              className="field"
              value={feature.fit ?? "normal"}
              onChange={(event) =>
                set({ fit: event.target.value === "normal" ? undefined : event.target.value })
              }
            >
              <option value="close">{t("fit::Close")}</option>
              <option value="normal">{t("Normal")}</option>
              <option value="loose">{t("Loose")}</option>
            </select>
          </Field>
        ) : null}
      </div>
      <Field label={t("Face")}>
        <SelBox
          field="plane"
          items={[describePlane(feature.plane)]}
          placeholder={t("Tap a flat face where the hole goes")}
        />
      </Field>
      <PointsField
        label={t("Holes ({n})", { n: feature.points.length })}
        points={feature.points}
        summary={tn(
          feature.points.length,
          "{n} point: tap the face to add",
          "{n} points: tap the face to add",
        )}
        placeholder={t("Tap the face to place holes, or an edge for a hole beside it")}
        set={set}
      />
      {feature.kind !== "insert" ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={feature.depth === undefined}
            onChange={(event) => set({ depth: event.target.checked ? undefined : 10 })}
          />{" "}
          {t("Through all")}
        </label>
      ) : null}
      {feature.depth !== undefined || feature.kind === "insert" ? (
        <Field label={t("Depth")}>
          <ExprInput
            value={feature.depth}
            placeholder={feature.kind === "insert" ? t("insert length + 1") : ""}
            onCommit={(depth) => set({ depth })}
            onLive={(depth) => set({ depth })}
          />
        </Field>
      ) : null}
      <div className="row">
        <Field label={t("Allowance (printing)")}>
          <ExprInput
            value={feature.allowance}
            placeholder="0"
            onCommit={(allowance) => set({ allowance: allowance === 0 ? undefined : allowance })}
          />
        </Field>
        <FlipButton flip={feature.flip} title={t("Drill the other way")} set={set} />
      </div>
      {feature.kind === "insert" ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!feature.withInserts}
            onChange={(event) => set({ withInserts: event.target.checked ? true : undefined })}
          />{" "}
          {t("Also place the inserts (parts list)")}
        </label>
      ) : null}
      <p className="muted small">
        {feature.kind === "insert"
          ? insertNote(feature.size ?? "M3", typeof feature.length === "number" ? feature.length : undefined)
          : feature.kind === "tapped"
            ? t("Tap drill size with a modelled thread; printed threads often want 0.1–0.2 mm allowance.")
            : t(
                "Clearance holes follow ISO 273, counterbores fit socket head cap screws, countersinks 90° flat head screws.",
              )}
      </p>
    </>
  );
}

/** Points tapped on the step's face, each one editable and removable; `summary` says how many. */
function PointsField({
  label,
  points,
  summary,
  placeholder,
  set,
}: {
  label: string;
  points: [Expr, Expr][];
  summary: string;
  placeholder: string;
  set: SetPatch;
}) {
  return (
    <Field label={label}>
      <SelBox field="points" items={points.length ? [summary] : []} placeholder={placeholder} />
      {points.map((pt, i) => (
        <div className="row" key={i}>
          {[0, 1].map((k) => (
            <div key={k} style={{ flex: 1 }}>
              <ExprInput
                value={pt[k]}
                onCommit={(expr) =>
                  set({
                    points: points.map((q, j) => (j === i ? (k === 0 ? [expr, q[1]] : [q[0], expr]) : q)),
                  })
                }
              />
            </div>
          ))}
          <button
            className="icon-btn sm"
            title={t("Remove")}
            onClick={() => set({ points: points.filter((_, j) => j !== i) })}
          >
            <X />
          </button>
        </div>
      ))}
    </Field>
  );
}

/** An insert's length, from the lengths its size comes in (the usual one first). */
function InsertLength({ size, length, set }: { size: string; length: Of<"hole">["length"]; set: SetPatch }) {
  const lengths = insertLengths(size);
  if (lengths.length < 2) return null;

  return (
    <Field label={t("Length")}>
      <select
        className="field"
        value={String(typeof length === "number" ? length : lengths[0])}
        onChange={(event) => {
          const l = Number(event.target.value);
          set({ length: l === lengths[0] ? undefined : l });
        }}
      >
        {lengths.map((l, i) => (
          <option key={l} value={l}>
            {i === 0 ? t("{length} mm (standard)", { length: l }) : t("{length} mm (short)", { length: l })}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** What the hole is sized for: the insert's outside, the hole and the wall it needs. */
function insertNote(size: string, length: number | undefined): string {
  try {
    const d = insertDims(size, length);

    if (d) {
      return t(
        "{size}×{length} insert: hole Ø{hole}, insert Ø{outer} outside, keep at least {wall} mm of wall around it. Sized as the common makers recommend; check your inserts' data.",
        { size, length: d.length, hole: d.hole, outer: d.outer, wall: d.wall },
      );
    }
  } catch {
    // an unknown length: the rebuild says so
  }

  return t("Sized for common heat-set inserts for plastic; check your inserts' recommended hole.");
}

const EMPTY_PARAMS: Record<string, number> = {};
const mm = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "")} mm`;

type GearParams = NonNullable<ReturnType<typeof gearParams>>;
type GearDims = ReturnType<typeof gearDims>;

/** Gear: kind, size, placement or partner, helix, bore and hub, with the resulting sizes. */
function GearFields({ f: feature, set }: { f: Of<"gear">; set: SetPatch }) {
  const features = useApp((state) => state.doc.features);
  const values = useApp((state) => state.output?.report.params) ?? EMPTY_PARAMS;
  const others = features.filter((x): x is Of<"gear"> => x.op === "gear" && x.id !== feature.id);
  const p = gearParams(feature, features, values);
  const dims = p ? gearDims(p) : null;
  const pair = pairInfo(feature, features, values);
  const meshing = !!feature.meshWith;

  return (
    <>
      <Seg
        value={feature.kind}
        options={[
          ["spur", t("Gear")],
          ["internal", t("Ring gear")],
          ["rack", t("Rack")],
        ]}
        onChange={(kind) =>
          set({
            kind,
            rim: undefined,
            ...(kind !== "spur" ? { bore: undefined, hub: undefined, profileShift: undefined } : {}),
            ...(kind === "rack" ? { chamfer: undefined } : {}),
          })
        }
      />
      {others.length ? <GearPartner f={feature} set={set} others={others} p={p} /> : null}
      <GearSize f={feature} set={set} meshing={meshing} p={p} />
      {meshing ? (
        feature.kind === "spur" || feature.kind === "internal" ? (
          <Field label={t("Direction from the partner")}>
            <ExprInput
              value={feature.meshWith!.direction ?? 0}
              unit="deg"
              onCommit={(direction) => set({ meshWith: { ...feature.meshWith!, direction } })}
              onLive={(direction) => set({ meshWith: { ...feature.meshWith!, direction } })}
            />
          </Field>
        ) : null
      ) : (
        <GearPlacement f={feature} set={set} />
      )}
      <GearRim f={feature} set={set} p={p} dims={dims} />
      {!meshing ? <GearHelix f={feature} set={set} /> : null}
      <div className="row">
        <Field label={t("Backlash (pair)")}>
          <ExprInput value={feature.backlash} placeholder="0.15" onCommit={(backlash) => set({ backlash })} />
        </Field>
        {feature.kind === "spur" ? (
          <Field label={t("Profile shift")}>
            <ExprInput
              value={feature.profileShift}
              unit=""
              placeholder="0"
              onCommit={(profileShift) =>
                set({ profileShift: profileShift === 0 ? undefined : profileShift })
              }
            />
          </Field>
        ) : null}
      </div>
      {feature.kind !== "rack" ? <GearChamfer f={feature} set={set} p={p} /> : null}
      {feature.kind === "spur" ? (
        <>
          <GearBore f={feature} set={set} />
          <GearHub f={feature} set={set} dims={dims} />
        </>
      ) : null}
      <Field label={t("Result")}>
        <Seg value={feature.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      {dims && p ? <GearSizes p={p} dims={dims} pair={pair} /> : null}
      {dims?.warnings.map((w) => (
        <div key={w} className="callout warn">
          {w}
        </div>
      ))}
      {feature.kind !== "rack" || meshing ? null : (
        <p className="muted small">
          {t("The rack runs along the plane's first axis, its pitch line through the centre.")}
        </p>
      )}
      <button className="btn" onClick={() => addMatingGear(feature)} disabled={!p}>
        <Cog /> {t("Add mating gear")}
      </button>
    </>
  );
}

/**
 * Accepts the gear and opens a new one meshing with it: a ring gear or rack gets a gear; a gear gets a
 * gear twice its size.
 */
function addMatingGear(feature: Of<"gear">): void {
  const teeth = typeof feature.teeth === "number" ? feature.teeth * 2 : 30;
  if (!commitDialog()) return;

  const mate = draftFeature("gear", useApp.getState().doc) as Of<"gear">;
  openDraft({
    ...mate,
    module: undefined,
    plane: undefined,
    teeth: feature.kind === "spur" ? teeth : 18,
    width: feature.width,
    meshWith: { gear: feature.id, direction: 0 },
  } as Feature);
}

/** The gear this one meshes with: it then takes its module, angles and place from that one. */
function GearPartner({
  f: feature,
  set,
  others,
  p,
}: {
  f: Of<"gear">;
  set: SetPatch;
  others: Of<"gear">[];
  p: GearParams | null;
}) {
  return (
    <Field label={t("Meshes with")}>
      <select
        className="field"
        value={feature.meshWith?.gear ?? ""}
        onChange={(event) =>
          set(
            event.target.value
              ? {
                  meshWith: { gear: event.target.value, direction: feature.meshWith?.direction ?? 0 },
                  module: undefined,
                  pressureAngle: undefined,
                  helix: undefined,
                  herringbone: undefined,
                  plane: undefined,
                  center: undefined,
                  rotation: undefined,
                }
              : { meshWith: undefined, module: p?.module ?? 1.5, plane: { ref: "origin.XY" } },
          )
        }
      >
        <option value="">{t("Nothing (place freely)")}</option>
        {others.map((feature) => (
          <option key={feature.id} value={feature.id}>
            {featureName(feature)}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Module, teeth and width; a meshing gear shows the module it takes from its partner. */
function GearSize({
  f: feature,
  set,
  meshing,
  p,
}: {
  f: Of<"gear">;
  set: SetPatch;
  meshing: boolean;
  p: GearParams | null;
}) {
  return (
    <div className="row">
      <Field label={t("Module")}>
        {meshing ? (
          <div className="field muted">{p ? mm(p.module) : "–"}</div>
        ) : (
          <ExprInput
            value={feature.module}
            autoFocus
            onCommit={(module) => set({ module })}
            onLive={(module) => set({ module })}
          />
        )}
      </Field>
      <Field label={t("Teeth")}>
        <ExprInput
          value={feature.teeth}
          unit=""
          integer
          onCommit={(teeth) => set({ teeth })}
          onLive={(teeth) => set({ teeth })}
        />
      </Field>
      <Field label={t("Width")}>
        <ExprInput
          value={feature.width}
          onCommit={(width) => set({ width })}
          onLive={(width) => set({ width })}
        />
      </Field>
    </div>
  );
}

/** A free gear's plane, centre in it and turn. */
function GearPlacement({ f: feature, set }: { f: Of<"gear">; set: SetPatch }) {
  const setCenter = (i: number, expr: Expr) =>
    set({ center: [0, 1].map((j) => (j === i ? expr : (feature.center?.[j] ?? 0))) });

  return (
    <>
      <Field label={t("Plane")}>
        <SelBox
          field="plane"
          items={[describePlane(feature.plane ?? { ref: "origin.XY" })]}
          placeholder={t("Pick a plane or flat face")}
        />
        <PlaneButtons value={feature.plane ?? { ref: "origin.XY" }} onChange={(plane) => set({ plane })} />
      </Field>
      <Field label={t("Centre (in the plane) and turn")}>
        <div className="row">
          {[0, 1].map((i) => (
            <div key={i} style={{ flex: 1 }}>
              <ExprInput
                value={feature.center?.[i] ?? 0}
                onCommit={(expr) => setCenter(i, expr)}
                onLive={(expr) => setCenter(i, expr)}
              />
            </div>
          ))}
          <div style={{ flex: 1 }}>
            <ExprInput
              value={feature.rotation ?? 0}
              unit="deg"
              onCommit={(rotation) => set({ rotation: rotation === 0 ? undefined : rotation })}
              onLive={(rotation) => set({ rotation })}
            />
          </div>
        </div>
      </Field>
    </>
  );
}

/** A ring gear's outside diameter, or the back of a rack below its teeth. */
function GearRim({
  f: feature,
  set,
  p,
  dims,
}: {
  f: Of<"gear">;
  set: SetPatch;
  p: GearParams | null;
  dims: GearDims | null;
}) {
  if (feature.kind === "internal") {
    return (
      <Field label={t("Outside diameter")}>
        <ExprInput
          value={feature.rim}
          placeholder={dims ? (dims.df + 4 * p!.module).toFixed(1) : ""}
          onCommit={(rim) => set({ rim })}
        />
      </Field>
    );
  }

  if (feature.kind === "rack") {
    return (
      <Field label={t("Back below the teeth")}>
        <ExprInput
          value={feature.rim}
          placeholder={p ? String(2 * p.module) : ""}
          onCommit={(rim) => set({ rim })}
        />
      </Field>
    );
  }

  return null;
}

/** A free gear's helix and pressure angle; a helical one can be herringbone. */
function GearHelix({ f: feature, set }: { f: Of<"gear">; set: SetPatch }) {
  return (
    <>
      <div className="row">
        <Field label={t("Helix angle")}>
          <ExprInput
            value={feature.helix ?? 0}
            unit="deg"
            onCommit={(helix) => set({ helix: helix === 0 ? undefined : helix })}
            onLive={(helix) => set({ helix })}
          />
        </Field>
        <Field label={t("Pressure angle")}>
          <select
            className="field"
            value={String(feature.pressureAngle ?? 20)}
            onChange={(event) =>
              set({ pressureAngle: event.target.value === "20" ? undefined : Number(event.target.value) })
            }
          >
            {[14.5, 20, 25].map((a) => (
              <option key={a} value={a}>
                {a}°
              </option>
            ))}
          </select>
        </Field>
      </div>
      {feature.helix !== undefined && feature.helix !== 0 ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!feature.herringbone}
            onChange={(event) => set({ herringbone: event.target.checked || undefined })}
          />{" "}
          {t("Herringbone (both hands, no side thrust)")}
        </label>
      ) : null}
    </>
  );
}

/** A 45° chamfer on the tooth ends, at most half a module (and 0.5 mm) to start with. */
function GearChamfer({ f: feature, set, p }: { f: Of<"gear">; set: SetPatch; p: GearParams | null }) {
  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={feature.chamfer !== undefined}
          onChange={(event) =>
            set({ chamfer: event.target.checked ? Math.min(0.5, (p?.module ?? 1) / 2) : undefined })
          }
        />{" "}
        {t("Chamfer tooth ends")}
      </label>
      {feature.chamfer !== undefined ? (
        <Field label={t("Chamfer (45°)")}>
          <ExprInput
            value={feature.chamfer}
            onCommit={(chamfer) => set({ chamfer })}
            onLive={(chamfer) => set({ chamfer })}
          />
        </Field>
      ) : null}
    </>
  );
}

/** A gear's bore: round, D shaft or hex, with its printing allowance. */
function GearBore({ f: feature, set }: { f: Of<"gear">; set: SetPatch }) {
  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.bore}
          onChange={(event) =>
            set({ bore: event.target.checked ? { diameter: 5, allowance: "2 * fit" } : undefined })
          }
        />{" "}
        {t("Bore")}
      </label>
      {feature.bore ? (
        <>
          <Seg
            value={feature.bore.shape ?? "round"}
            options={[
              ["round", t("Round")],
              ["d_flat", t("D shaft")],
              ["hex", t("Hex")],
            ]}
            onChange={(shape) =>
              set({ bore: { ...feature.bore!, shape: shape === "round" ? undefined : shape } })
            }
          />
          <div className="row">
            <Field label={feature.bore.shape === "hex" ? t("Across flats") : t("Diameter")}>
              <ExprInput
                value={feature.bore.diameter}
                onCommit={(diameter) => set({ bore: { ...feature.bore!, diameter } })}
                onLive={(diameter) => set({ bore: { ...feature.bore!, diameter } })}
              />
            </Field>
            {feature.bore.shape === "d_flat" ? (
              <Field label={t("Across the flat")}>
                <ExprInput
                  value={feature.bore.flat}
                  placeholder={t("0.9 × diameter")}
                  onCommit={(flat) => set({ bore: { ...feature.bore!, flat } })}
                />
              </Field>
            ) : null}
            <Field label={t("Allowance")}>
              <ExprInput
                value={feature.bore.allowance}
                placeholder="0"
                onCommit={(allowance) => set({ bore: { ...feature.bore!, allowance } })}
              />
            </Field>
          </div>
        </>
      ) : null}
    </>
  );
}

/** A hub on a gear's top, bottom or both sides; it starts half the root diameter wide. */
function GearHub({ f: feature, set, dims }: { f: Of<"gear">; set: SetPatch; dims: GearDims | null }) {
  return (
    <>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.hub}
          onChange={(event) =>
            set({
              hub: event.target.checked
                ? { diameter: Math.max(8, (dims?.df ?? 20) / 2), length: 5 }
                : undefined,
            })
          }
        />{" "}
        {t("Hub")}
      </label>
      {feature.hub ? (
        <div className="row">
          <Field label={t("Diameter")}>
            <ExprInput
              value={feature.hub.diameter}
              onCommit={(diameter) => set({ hub: { ...feature.hub!, diameter } })}
              onLive={(diameter) => set({ hub: { ...feature.hub!, diameter } })}
            />
          </Field>
          <Field label={t("Length")}>
            <ExprInput
              value={feature.hub.length}
              onCommit={(length) => set({ hub: { ...feature.hub!, length } })}
              onLive={(length) => set({ hub: { ...feature.hub!, length } })}
            />
          </Field>
          <Field label={t("Side")}>
            <select
              className="field"
              value={feature.hub.side ?? "front"}
              onChange={(event) =>
                set({
                  hub: {
                    ...feature.hub!,
                    side: event.target.value === "front" ? undefined : event.target.value,
                  },
                })
              }
            >
              <option value="front">{t("Top")}</option>
              <option value="back">{t("Bottom")}</option>
              <option value="both">{t("Both")}</option>
            </select>
          </Field>
        </div>
      ) : null}
    </>
  );
}

/** What the gear comes to: diameters (or a rack's length), centre distance and ratio, span. */
function GearSizes({
  p,
  dims,
  pair,
}: {
  p: GearParams;
  dims: NonNullable<GearDims>;
  pair: ReturnType<typeof pairInfo>;
}) {
  return (
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
  );
}

/** Info the kernel reported for the feature being edited. */
function useFeatureInfo(id: string): Record<string, number> | undefined {
  return useApp((state) => state.output?.report.features.find((x) => x.id === id)?.info);
}

/** Coil: profile, axis, pitch and turns, taper, hand. */
function CoilFields({
  f: feature,
  set,
  profileChip,
  sketches,
}: {
  f: Of<"coil">;
  set: SetPatch;
  profileChip: (profile: ProfileRef) => string;
  sketches: Of<"sketch">[];
}) {
  const features = useApp((state) => state.doc.features);
  const prof = feature.profile;
  const info = useFeatureInfo(feature.id);

  return (
    <>
      <Field label={t("Profile")}>
        <SelBox
          field="profile"
          items={"face" in prof || prof.sketch ? [profileChip(prof)] : []}
          placeholder={t("Pick sketch regions beside the axis")}
          onRemove={() => set({ profile: { sketch: "" } })}
        />
        {"sketch" in prof && !prof.sketch ? (
          <SketchSelect
            sketches={sketches}
            prompt={t("…or use a whole sketch")}
            onPick={(sketch) => set({ profile: { sketch } })}
          />
        ) : null}
      </Field>
      <Field label={t("Axis")}>
        <SelBox field="axis" items={[describeAxis(feature.axis)]} placeholder={t("Pick a line or edge")} />
        <AxisButtons value={feature.axis} onChange={(axis) => set({ axis })} />
      </Field>
      <div className="row">
        <Field label={t("Pitch (rise per turn)")}>
          <ExprInput
            value={feature.pitch}
            autoFocus
            onCommit={(pitch) => set({ pitch })}
            onLive={(pitch) => set({ pitch })}
          />
        </Field>
        <Field label={t("Turns")}>
          <ExprInput
            value={feature.turns}
            unit=""
            onCommit={(turns) => set({ turns })}
            onLive={(turns) => set({ turns })}
          />
        </Field>
      </div>
      <div className="row">
        <Field label={t("Taper")}>
          <ExprInput
            value={feature.taper ?? 0}
            unit="deg"
            onCommit={(taper) => set({ taper: taper === 0 ? undefined : taper })}
            onLive={(taper) => set({ taper })}
          />
        </Field>
        <FlipButton flip={feature.flip} title={t("Flip direction")} set={set} />
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.leftHanded}
          onChange={(event) => set({ leftHanded: event.target.checked || undefined })}
        />{" "}
        {t("Left-handed")}
      </label>
      <Field label={t("Result")}>
        <Seg value={feature.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      {feature.mode !== "new_body" ? (
        <Field label={t("Merge scope (optional)")}>
          <SelBox
            field="targets"
            items={(feature.targets ?? []).map((t) => partName(t, features))}
            placeholder={t("All touching parts")}
            onRemove={(i) => set({ targets: (feature.targets ?? []).filter((_, j) => j !== i) })}
          />
        </Field>
      ) : null}
      {info?.["height"] !== undefined ? (
        <div className="gear-sizes small">
          <span>{t("Height")}</span>
          <b>{mm(info["height"])}</b>
        </div>
      ) : null}
      <p className="muted small">
        {t(
          "Draw the profile in a sketch on a plane through the axis, beside it (a circle for a spring, a triangle for a thread). Cut into a rod for a custom thread.",
        )}
      </p>
    </>
  );
}

/** Placement on a plane at a centre point, shared by springs and screws. */
function PlaceFields({ f, set }: { f: Of<"spring"> | Of<"screw">; set: SetPatch }) {
  return (
    <>
      <Field label={t("Plane")}>
        <SelBox
          field="plane"
          items={[describePlane(f.plane ?? { ref: "origin.XY" })]}
          placeholder={t("Pick a plane or flat face")}
        />
        <PlaneButtons value={f.plane ?? { ref: "origin.XY" }} onChange={(plane) => set({ plane })} />
      </Field>
      <Field label={t("Centre (in the plane)")}>
        <div className="row">
          {[0, 1].map((i) => (
            <div key={i} style={{ flex: 1 }}>
              <ExprInput
                value={f.center?.[i] ?? 0}
                onCommit={(expr) =>
                  set({ center: [0, 1].map((j) => (j === i ? expr : (f.center?.[j] ?? 0))) })
                }
                onLive={(expr) => set({ center: [0, 1].map((j) => (j === i ? expr : (f.center?.[j] ?? 0))) })}
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
function SpringFields({ f: feature, set }: { f: Of<"spring">; set: SetPatch }) {
  const info = useFeatureInfo(feature.id);

  return (
    <>
      <Seg
        value={feature.kind}
        options={[
          ["compression", t("Compression")],
          ["extension", t("Extension")],
          ["torsion", t("Torsion")],
        ]}
        onChange={(kind) =>
          set({
            kind,
            ...(kind === "compression"
              ? { length: feature.length ?? 40, gap: undefined, legs: undefined }
              : { length: undefined, ends: undefined }),
          })
        }
      />
      <div className="row">
        <Field label={t("Wire Ø")}>
          <ExprInput
            value={feature.wire}
            autoFocus
            onCommit={(wire) => set({ wire })}
            onLive={(wire) => set({ wire })}
          />
        </Field>
        <Field label={t("Outside Ø")}>
          <ExprInput
            value={feature.diameter}
            onCommit={(diameter) => set({ diameter })}
            onLive={(diameter) => set({ diameter })}
          />
        </Field>
        <Field label={t("Active coils")}>
          <ExprInput
            value={feature.coils}
            unit=""
            onCommit={(coils) => set({ coils })}
            onLive={(coils) => set({ coils })}
          />
        </Field>
      </div>
      {feature.kind === "compression" ? (
        <div className="row">
          <Field label={t("Free length")}>
            <ExprInput
              value={feature.length}
              placeholder={t("3 × diameter")}
              onCommit={(length) => set({ length })}
              onLive={(length) => set({ length })}
            />
          </Field>
          <Field label={t("Ends")}>
            <select
              className="field"
              value={feature.ends ?? "ground"}
              onChange={(event) =>
                set({ ends: event.target.value === "ground" ? undefined : event.target.value })
              }
            >
              <option value="ground">{t("Closed and ground")}</option>
              <option value="closed">{t("Closed")}</option>
              <option value="open">{t("Open")}</option>
            </select>
          </Field>
        </div>
      ) : (
        <div className="row">
          <Field label={t("Gap between coils")}>
            <ExprInput
              value={feature.gap}
              placeholder="0.3"
              onCommit={(gap) => set({ gap })}
              onLive={(gap) => set({ gap })}
            />
          </Field>
          {feature.kind === "torsion" ? (
            <Field label={t("Leg length")}>
              <ExprInput
                value={feature.legs}
                placeholder={t("outside Ø")}
                onCommit={(legs) => set({ legs })}
                onLive={(legs) => set({ legs })}
              />
            </Field>
          ) : null}
        </div>
      )}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.leftHanded}
          onChange={(event) => set({ leftHanded: event.target.checked || undefined })}
        />{" "}
        {t("Left-handed")}
      </label>
      <PlaceFields f={feature} set={set} />
      <Field label={t("Result")}>
        <Seg value={feature.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      {info ? (
        <div className="gear-sizes small">
          <span>{t("Pitch")}</span>
          <b>{mm(info["pitch"] ?? 0)}</b>
          <span>{t("Height")}</span>
          <b>{mm(info["height"] ?? 0)}</b>
          {feature.kind === "compression" ? (
            <>
              <span>{t("Solid height")}</span>
              <b>{mm(info["solidHeight"] ?? 0)}</b>
            </>
          ) : null}
          <span>{t("Rate (spring steel)")}</span>
          <b>
            {feature.kind === "torsion"
              ? `${num(info["rateSteel"] ?? 0, 3)} N·mm/°`
              : `${num(info["rateSteel"] ?? 0, 2)} N/mm`}
          </b>
        </div>
      ) : null}
      <p className="muted small">
        {t("Printed springs are much softer than steel ones: PLA or PETG about 1/50, so use a thicker wire.")}
      </p>
    </>
  );
}

/** Accepts the screw and opens the matching nut beside it, with the same thread. */
function addMatchingNut(feature: Of<"screw">): void {
  if (!commitDialog()) return;

  const draft = draftFeature("screw", useApp.getState().doc) as Of<"screw">;
  const cx = typeof feature.center?.[0] === "number" ? feature.center[0] : 0;
  const d = typeof feature.diameter === "number" ? feature.diameter : 8;
  openDraft({
    ...draft,
    kind: "nut",
    head: "hex",
    profile: feature.profile,
    diameter: feature.diameter,
    pitch: feature.pitch,
    starts: feature.starts,
    leftHanded: feature.leftHanded,
    clearance: feature.clearance,
    length: undefined,
    plane: feature.plane,
    center: [cx + 3 * d, feature.center?.[1] ?? 0],
  } as Feature);
}

/** Screw or nut: head, thread form, diameter, pitch, starts, length, printing clearance. */
function ScrewFields({ f: feature, set }: { f: Of<"screw">; set: SetPatch }) {
  const info = useFeatureInfo(feature.id);
  const nut = feature.kind === "nut";
  const heads: [NonNullable<Of<"screw">["head"]>, string][] = nut
    ? [
        ["hex", t("Hex")],
        ["round", t("Round")],
        ["knob", t("Knurled")],
      ]
    : [
        ["hex", t("Hex")],
        ["socket", t("Socket")],
        ["round", t("Button")],
        ["knob", t("Knurled")],
        ["none", t("None (threaded rod)")],
      ];

  return (
    <>
      <Seg
        value={feature.kind}
        options={[
          ["screw", t("Screw")],
          ["nut", t("Nut")],
        ]}
        onChange={(kind) =>
          set({ kind, head: "hex", length: kind === "nut" ? undefined : 25, threadLength: undefined })
        }
      />
      <Field label={nut ? t("Shape") : t("Head")}>
        <select
          className="field"
          value={feature.head ?? "hex"}
          onChange={(event) => set({ head: event.target.value === "hex" ? undefined : event.target.value })}
        >
          {heads.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      <ThreadForm
        profile={feature.profile}
        diameter={feature.diameter}
        pitch={feature.pitch}
        starts={feature.starts}
        set={set}
        diameterPlaceholder=""
        pitchPlaceholder={info?.["pitch"] !== undefined ? String(info["pitch"]) : undefined}
      />
      <div className="row">
        <Field label={nut ? t("Height") : t("Length")}>
          <ExprInput
            value={feature.length}
            placeholder={nut ? t("0.8 × diameter") : ""}
            onCommit={(length) => set({ length })}
            onLive={(length) => set({ length })}
          />
        </Field>
        {!nut ? (
          <Field label={t("Thread length")}>
            <ExprInput
              value={feature.threadLength}
              placeholder={t("all")}
              onCommit={(threadLength) => set({ threadLength })}
              onLive={(threadLength) => set({ threadLength })}
            />
          </Field>
        ) : null}
      </div>
      <Field label={t("Clearance per side (3D printing)")}>
        <ExprInput
          value={feature.clearance}
          placeholder="0"
          onCommit={(clearance) => set({ clearance: clearance === 0 ? undefined : clearance })}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.leftHanded}
          onChange={(event) => set({ leftHanded: event.target.checked || undefined })}
        />{" "}
        {t("Left-hand thread")}
      </label>
      <PlaceFields f={feature} set={set} />
      <Field label={t("Result")}>
        <Seg value={feature.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      {info?.["pitch"] !== undefined ? (
        <div className="gear-sizes small">
          <span>{t("Pitch")}</span>
          <b>{mm(info["pitch"])}</b>
          <span>{t("Height")}</span>
          <b>{mm(info["height"] ?? 0)}</b>
        </div>
      ) : null}
      <p className="muted small">
        {t(
          "A screw and a nut with the same thread fit each other. For printing, give both about 0.1–0.2 mm clearance.",
        )}
      </p>
      {!nut ? (
        <button className="btn" onClick={() => addMatchingNut(feature)}>
          {t("Add matching nut")}
        </button>
      ) : null}
    </>
  );
}

function Body({ d: dialog }: { d: DialogState }) {
  const feature = dialog.feature;
  const set: SetPatch = (patch) => updateDraft(patch as Partial<Feature>);
  const features = useApp((state) => state.doc.features);
  const sketches = features.filter((x): x is Of<"sketch"> => x.op === "sketch");

  const profileChip = (prof: ProfileRef) => {
    if ("face" in prof) return describeFaceSelector(prof.face);

    const sketch = sketches.find((x) => x.id === prof.sketch);
    const name = sketch ? featureName(sketch) : prof.sketch;

    return Array.isArray(prof.regions)
      ? prof.regions.map((k) => `${name} · ${k.split("|")[0]}`).join(", ")
      : name;
  };

  switch (feature.op) {
    case "loft":
      return <LoftFields f={feature} set={set} profileChip={profileChip} />;
    case "sweep":
      return <SweepFields f={feature} set={set} profileChip={profileChip} sketches={sketches} />;
    case "extrude":
    case "revolve":
      return <ExtrudeFields f={feature} set={set} sketches={sketches} />;
    case "fillet":
    case "chamfer":
      return <EdgeRoundFields f={feature} set={set} />;
    case "shell":
      return <ShellFields f={feature} set={set} />;
    case "thread":
      return <ThreadFields f={feature} set={set} />;
    case "gear":
      return <GearFields f={feature} set={set} />;
    case "coil":
      return <CoilFields f={feature} set={set} profileChip={profileChip} sketches={sketches} />;
    case "spring":
      return <SpringFields f={feature} set={set} />;
    case "screw":
      return <ScrewFields f={feature} set={set} />;
    case "gridfinity":
      return <GridfinityFields f={feature} set={set} />;
    case "wall":
      return <WallFields f={feature} set={set} />;
    case "label":
      return <LabelFields f={feature} set={set} />;
    case "box":
      return <BoxFields f={feature} set={set} />;
    case "snap_hook":
      return <SnapHookFields f={feature} set={set} />;
    case "lithophane":
      return <LithophaneFields f={feature} set={set} />;
    case "hole":
      return <HoleFields f={feature} set={set} />;
    case "linear_pattern":
      return <LinearPatternFields f={feature} set={set} />;
    case "circular_pattern":
      return <CircularPatternFields f={feature} set={set} />;
    case "mirror":
      return <MirrorFields f={feature} set={set} />;
    case "boolean":
      return <BooleanFields f={feature} set={set} />;
    case "scale":
      return <ScaleFields f={feature} set={set} />;
    case "bend":
      return <BendFields f={feature} set={set} />;
    case "align":
      return <AlignFields f={feature} set={set} />;
    case "standard_part":
      return <StandardPartFields f={feature} set={set} />;
    case "primitive":
      return <PrimitiveFields f={feature} set={set} />;
    case "text":
      return <TextFields f={feature} set={set} />;
    case "draft":
      return <DraftFields f={feature} set={set} />;
    case "offset_face":
      return <OffsetFaceFields f={feature} set={set} />;
    case "rib":
      return <RibFields f={feature} set={set} sketches={sketches} />;
    case "split":
      return <SplitFields f={feature} set={set} />;
    case "delete":
      return <DeleteFields f={feature} set={set} />;
    case "mesh_convert":
      return <MeshConvertFields f={feature} set={set} />;
    case "transform":
      return <TransformFields f={feature} set={set} />;
    case "plane":
      return <PlaneFields f={feature} set={set} />;
    default:
      return <div className="muted">{t("Nothing to set.")}</div>;
  }
}

/** Loft: profiles in order, straight or smooth sides, result. */
function LoftFields({
  f: feature,
  set,
  profileChip,
}: {
  f: Of<"loft">;
  set: SetPatch;
  profileChip: (prof: ProfileRef) => string;
}) {
  return (
    <>
      <Field label={t("Profiles, in order")}>
        <SelBox
          field="profiles"
          items={feature.profiles.map((profile, i) => `${i + 1}. ${profileChip(profile)}`)}
          placeholder={t("Pick sketch regions or flat faces")}
          onRemove={(i) => set({ profiles: feature.profiles.filter((_, j) => j !== i) })}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.ruled}
          onChange={(event) => set({ ruled: event.target.checked || undefined })}
        />{" "}
        {t("Straight sides between profiles")}
      </label>
      <Field label={t("Result")}>
        <Seg value={feature.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      <p className="muted small">
        {t(
          "Each profile is one closed region, on its own plane. Profiles that all have the same number of holes give a hollow loft.",
        )}
      </p>
    </>
  );
}

/** Sweep: profile, the path it follows, result. */
function SweepFields({
  f: feature,
  set,
  profileChip,
  sketches,
}: {
  f: Of<"sweep">;
  set: SetPatch;
  profileChip: (prof: ProfileRef) => string;
  sketches: Of<"sketch">[];
}) {
  const pathSk = sketches.find((x) => x.id === feature.path.sketch);
  const pathChips = !feature.path.sketch
    ? []
    : feature.path.curves
      ? feature.path.curves.map((c) => `${pathSk ? featureName(pathSk) : feature.path.sketch} · ${c}`)
      : [t("All lines of {name}", { name: pathSk ? featureName(pathSk) : feature.path.sketch })];
  const prof = feature.profile;

  return (
    <>
      <Field label={t("Profile")}>
        <SelBox
          field="profile"
          items={"face" in prof || prof.sketch ? [profileChip(prof)] : []}
          placeholder={t("Pick sketch regions")}
          onRemove={() => set({ profile: { sketch: "" } })}
        />
      </Field>
      <Field label={t("Path")}>
        <SelBox
          field="path"
          items={pathChips}
          placeholder={t("Pick lines and arcs")}
          onRemove={(i) =>
            set({
              path:
                feature.path.curves && feature.path.curves.length > 1
                  ? { sketch: feature.path.sketch, curves: feature.path.curves.filter((_, j) => j !== i) }
                  : { sketch: "" },
            })
          }
        />
        <SketchSelect
          sketches={sketches}
          prompt={t("…or follow a whole sketch")}
          onPick={(sketch) => set({ path: { sketch } })}
        />
      </Field>
      <Field label={t("Result")}>
        <Seg value={feature.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      <p className="muted small">
        {t(
          "Draw the path in its own sketch, usually on a plane across the profile's, starting in the profile.",
        )}
      </p>
    </>
  );
}

/** Extrude or revolve: profile, result, how far (or about what), and which parts it may merge with. */
function ExtrudeFields({
  f: feature,
  set,
  sketches,
}: {
  f: Of<"extrude" | "revolve">;
  set: SetPatch;
  sketches: Of<"sketch">[];
}) {
  const features = useApp((state) => state.doc.features);

  const prof = feature.profile;
  const sketch = "face" in prof ? undefined : sketches.find((x) => x.id === prof.sketch);
  const skName = sketch ? featureName(sketch) : "sketch" in prof ? prof.sketch : "";
  const regionChips =
    "face" in prof
      ? [describeFaceSelector(prof.face)]
      : !prof.sketch
        ? []
        : Array.isArray(prof.regions)
          ? prof.regions.map((k) => `${skName} · ${k.split("|")[0]}`)
          : [t("All regions of {name}", { name: skName })];

  return (
    <>
      <Field label={t("Profile")}>
        <SelBox
          field="profile"
          items={regionChips}
          placeholder={
            feature.op === "extrude" ? t("Pick sketch regions or a face") : t("Pick sketch regions")
          }
          onRemove={() => set({ profile: { sketch: "" } })}
        />
        {"sketch" in prof && !prof.sketch ? (
          <SketchSelect
            sketches={sketches}
            prompt={t("…or use a whole sketch")}
            onPick={(sketch) => set({ profile: { sketch } })}
          />
        ) : null}
      </Field>
      <Field label={t("Result")}>
        <Seg value={feature.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
      {feature.op === "extrude" ? (
        <ExtrudeEnd f={feature} set={set} />
      ) : (
        <RevolveAxis f={feature} set={set} />
      )}
      {feature.mode !== "new_body" ? (
        <Field label={t("Merge scope (optional)")}>
          <SelBox
            field="targets"
            items={(feature.targets ?? []).map((t) => partName(t, features))}
            placeholder={t("All touching parts")}
            onRemove={(i) => set({ targets: (feature.targets ?? []).filter((_, j) => j !== i) })}
          />
        </Field>
      ) : null}
    </>
  );
}

/** How far an extrude goes: blind, symmetric, two directions or through all, and which way. */
function ExtrudeEnd({ f: feature, set }: { f: Of<"extrude">; set: SetPatch }) {
  return (
    <>
      <Field label={t("End")}>
        <select
          className="field"
          value={feature.extent}
          onChange={(event) =>
            set({
              extent: event.target.value,
              ...(event.target.value === "two_sided" && feature.distance2 === undefined
                ? { distance2: 10 }
                : {}),
            })
          }
        >
          <option value="blind">{t("Blind")}</option>
          <option value="symmetric">{t("Symmetric")}</option>
          <option value="two_sided">{t("Two directions")}</option>
          <option value="through_all">{t("Through all")}</option>
        </select>
      </Field>
      {feature.extent !== "through_all" ? (
        <Field label={feature.extent === "two_sided" ? t("Distance (direction 1)") : t("Distance")}>
          <div className="row">
            <div style={{ flex: 1 }}>
              <ExprInput
                value={feature.distance}
                autoFocus
                onCommit={(distance) => set({ distance })}
                onLive={(distance) => set({ distance })}
              />
            </div>
            <FlipButton flip={feature.flip} title={t("Flip direction")} set={set} />
          </div>
        </Field>
      ) : (
        <button
          className={`btn ${feature.flip ? "primary" : ""}`}
          onClick={() => set({ flip: feature.flip ? undefined : true })}
        >
          <ArrowLeftRight /> {t("Flip direction")}
        </button>
      )}
      {feature.extent === "two_sided" ? (
        <Field label={t("Distance (direction 2)")}>
          <ExprInput
            value={feature.distance2}
            onCommit={(distance2) => set({ distance2 })}
            onLive={(distance2) => set({ distance2 })}
          />
        </Field>
      ) : null}
    </>
  );
}

/** What a revolve turns about, and how far. */
function RevolveAxis({ f: feature, set }: { f: Of<"revolve">; set: SetPatch }) {
  return (
    <>
      <Field label={t("Axis")}>
        <SelBox field="axis" items={[describeAxis(feature.axis)]} placeholder={t("Pick a line or edge")} />
        <AxisButtons value={feature.axis} onChange={(axis) => set({ axis })} />
      </Field>
      <Field label={t("Angle")}>
        <ExprInput
          value={feature.angle}
          unit="deg"
          onCommit={(angle) => set({ angle })}
          onLive={(angle) => set({ angle })}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.symmetric}
          onChange={(event) => set({ symmetric: event.target.checked || undefined })}
        />{" "}
        {t("Symmetric")}
      </label>
    </>
  );
}

/** Fillet or chamfer: edges and faces, radius or distance; a fillet can change along the edge. */
function EdgeRoundFields({ f: feature, set }: { f: Of<"fillet" | "chamfer">; set: SetPatch }) {
  const edges = asArray(feature.edges) as EdgeSelector[];

  return (
    <>
      <Field label={t("Edges and faces")}>
        <SelBox
          field="edges"
          items={edges.map(describeEdgeSelector)}
          placeholder={t("Pick edges or faces")}
          onRemove={(i) => set({ edges: edges.filter((_, j) => j !== i) })}
        />
      </Field>
      <Field label={feature.op === "fillet" ? t("Radius") : t("Distance")}>
        {feature.op === "fillet" ? (
          <ExprInput
            value={feature.radius}
            autoFocus
            onCommit={(radius) => set({ radius })}
            onLive={(radius) => set({ radius })}
          />
        ) : (
          <ExprInput
            value={feature.distance}
            autoFocus
            onCommit={(distance) => set({ distance })}
            onLive={(distance) => set({ distance })}
          />
        )}
      </Field>
      {feature.op === "fillet" ? (
        <>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={feature.radius2 !== undefined}
              onChange={(event) =>
                set({
                  radius2: event.target.checked
                    ? typeof feature.radius === "number"
                      ? feature.radius * 2
                      : 4
                    : undefined,
                })
              }
            />{" "}
            {t("Variable: changes along the edge")}
          </label>
          {feature.radius2 !== undefined ? (
            <Field label={t("Radius at the other end")}>
              <ExprInput
                value={feature.radius2}
                onCommit={(radius2) => set({ radius2 })}
                onLive={(radius2) => set({ radius2 })}
              />
            </Field>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Shell: faces to remove, wall thickness, inward or outward. */
function ShellFields({ f: feature, set }: { f: Of<"shell">; set: SetPatch }) {
  return (
    <>
      <Field label={t("Faces to remove")}>
        <SelBox
          field="faces"
          items={feature.faces.map((selector: FaceSelector) => describeFaceSelector(selector))}
          placeholder={t("Pick faces")}
          onRemove={(i) => set({ faces: feature.faces.filter((_, j) => j !== i) })}
        />
      </Field>
      <Field label={t("Thickness")}>
        <ExprInput
          value={feature.thickness}
          autoFocus
          onCommit={(thickness) => set({ thickness })}
          onLive={(thickness) => set({ thickness })}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.outward}
          onChange={(event) => set({ outward: event.target.checked || undefined })}
        />{" "}
        {t("Thicken outward")}
      </label>
    </>
  );
}

/** Linear pattern: what to repeat, direction, count and spacing, optionally a second direction. */
function LinearPatternFields({ f: feature, set }: { f: Of<"linear_pattern">; set: SetPatch }) {
  return (
    <>
      <SourceField value={feature.source} onChange={(source) => set({ source })} />
      <Field label={t("Direction")}>
        <SelBox
          field="direction"
          items={[describeAxis(feature.direction)]}
          placeholder={t("Pick an edge or line")}
        />
        <AxisButtons
          value={feature.direction}
          onChange={(direction) => set({ direction })}
          kind="direction"
        />
      </Field>
      <div className="row">
        <Field label={t("Count")}>
          <ExprInput
            value={feature.count}
            unit=""
            integer
            onCommit={(count) => set({ count })}
            onLive={(count) => set({ count })}
          />
        </Field>
        <Field label={t("Spacing")}>
          <ExprInput
            value={feature.spacing}
            onCommit={(spacing) => set({ spacing })}
            onLive={(spacing) => set({ spacing })}
          />
        </Field>
      </div>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.direction2}
          onChange={(event) =>
            set(
              event.target.checked
                ? { direction2: { ref: "origin.Y" }, count2: 2, spacing2: 20 }
                : { direction2: undefined, count2: undefined, spacing2: undefined },
            )
          }
        />{" "}
        {t("Second direction")}
      </label>
      {feature.direction2 ? (
        <>
          <SelBox
            field="direction2"
            items={[describeAxis(feature.direction2)]}
            placeholder={t("Pick an edge or line")}
          />
          <AxisButtons
            value={feature.direction2}
            onChange={(direction2) => set({ direction2 })}
            kind="direction"
          />
          <div className="row">
            <Field label={t("Count")}>
              <ExprInput
                value={feature.count2}
                unit=""
                integer
                onCommit={(count2) => set({ count2 })}
                onLive={(count2) => set({ count2 })}
              />
            </Field>
            <Field label={t("Spacing")}>
              <ExprInput
                value={feature.spacing2}
                onCommit={(spacing2) => set({ spacing2 })}
                onLive={(spacing2) => set({ spacing2 })}
              />
            </Field>
          </div>
        </>
      ) : null}
    </>
  );
}

/** Circular pattern: what to repeat, axis, count and total angle. */
function CircularPatternFields({ f: feature, set }: { f: Of<"circular_pattern">; set: SetPatch }) {
  return (
    <>
      <SourceField value={feature.source} onChange={(source) => set({ source })} />
      <Field label={t("Axis")}>
        <SelBox field="axis" items={[describeAxis(feature.axis)]} placeholder={t("Pick an edge or line")} />
        <AxisButtons value={feature.axis} onChange={(axis) => set({ axis })} />
      </Field>
      <div className="row">
        <Field label={t("Count")}>
          <ExprInput
            value={feature.count}
            unit=""
            integer
            onCommit={(count) => set({ count })}
            onLive={(count) => set({ count })}
          />
        </Field>
        <Field label={t("Total angle")}>
          <ExprInput
            value={feature.angle ?? 360}
            unit="deg"
            onCommit={(angle) => set({ angle })}
            onLive={(angle) => set({ angle })}
          />
        </Field>
      </div>
    </>
  );
}

/** Mirror: what to mirror and the plane. */
function MirrorFields({ f: feature, set }: { f: Of<"mirror">; set: SetPatch }) {
  return (
    <>
      <SourceField value={feature.source} onChange={(source) => set({ source })} />
      <Field label={t("Mirror plane")}>
        <SelBox
          field="plane"
          items={[describePlane(feature.plane)]}
          placeholder={t("Pick a plane or face")}
        />
        <PlaneButtons value={feature.plane} onChange={(plane) => set({ plane })} />
      </Field>
    </>
  );
}

/** Boolean: union, subtract or intersect a target part with tool parts. */
function BooleanFields({ f: feature, set }: { f: Of<"boolean">; set: SetPatch }) {
  const features = useApp((state) => state.doc.features);

  return (
    <>
      <Seg
        value={feature.operation}
        options={[
          ["union", t("Union")],
          ["subtract", t("Subtract")],
          ["intersect", t("Intersect")],
        ]}
        onChange={(operation) => set({ operation })}
      />
      <Field label={t("Target part")}>
        <SelBox
          field="target"
          items={feature.target ? [partName(feature.target, features)] : []}
          placeholder={t("Pick the part to keep")}
        />
      </Field>
      <Field label={t("Tool parts")}>
        <SelBox
          field="tools"
          items={feature.tools.map((t) => partName(t, features))}
          placeholder={t("Pick tool parts")}
          onRemove={(i) => set({ tools: feature.tools.filter((_, j) => j !== i) })}
        />
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.keepTools}
          onChange={(event) => set({ keepTools: event.target.checked || undefined })}
        />{" "}
        {t("Keep tools")}
      </label>
    </>
  );
}

/** Align: a face of the part to move onto a face of another, gap and turn. */
function AlignFields({ f: feature, set }: { f: Of<"align">; set: SetPatch }) {
  const desc = (v: Of<"align">["from"]) => {
    const sel = "face" in v ? v.face : v.axisOf;
    if ("face" in sel && !sel.face) return [];

    return [
      "axisOf" in v ? t("Axis of {face}", { face: describeFaceSelector(sel) }) : describeFaceSelector(sel),
    ];
  };

  return (
    <>
      <Field label={t("Face of the part to move")}>
        <SelBox
          field="from"
          items={desc(feature.from)}
          placeholder={t("Pick a flat face, or a round one for its axis")}
        />
      </Field>
      <Field label={t("Onto")}>
        <SelBox field="to" items={desc(feature.to)} placeholder={t("Pick the face on the other part")} />
      </Field>
      {feature.bodies && feature.bodies.length > 1 ? (
        <p className="muted small">{t("Parts joined to them come along, so their joints stay together.")}</p>
      ) : null}
      <div className="row">
        <Field label={t("Gap")}>
          <ExprInput
            value={feature.offset ?? 0}
            onCommit={(offset) => set({ offset: offset === 0 ? undefined : offset })}
            onLive={(offset) => set({ offset })}
          />
        </Field>
        <Field label={t("Turn")}>
          <ExprInput
            value={feature.angle ?? 0}
            unit="deg"
            onCommit={(angle) => set({ angle: angle === 0 ? undefined : angle })}
          />
        </Field>
      </div>
      <button
        className={`btn ${feature.flip ? "primary" : ""}`}
        onClick={() => set({ flip: feature.flip ? undefined : true })}
      >
        <ArrowLeftRight /> {"axisOf" in feature.from ? t("Reverse direction") : t("Flush instead of facing")}
      </button>
      <p className="muted small">
        {t(
          "Flat faces end up touching, facing each other; round faces (a shaft, a hole) share their axis. The part keeps its place along the other directions.",
        )}
      </p>
    </>
  );
}

/**
 * Switching a standard part to another kind: a size it comes in, its usual length (kept when the old
 * kind had one of the same sort), a magnet's size, the moving part along, the turn where it lies.
 */
function standardKindPatch(feature: Of<"standard_part">, kind: Of<"standard_part">["kind"]) {
  const list = STANDARD_SIZES[kind];
  const length = STANDARD_WITH_LENGTH.includes(kind)
    ? STANDARD_WITH_LENGTH.includes(feature.kind)
      ? (feature.length ?? 10)
      : 10
    : STANDARD_CUT_TO_LENGTH.includes(kind)
      ? STANDARD_CUT_TO_LENGTH.includes(feature.kind)
        ? (feature.length ?? 200)
        : 200
      : undefined;

  return {
    kind,
    size: list.includes(feature.size ?? "") ? feature.size : STANDARD_DEFAULT_SIZE[kind],
    length,
    diameter: kind === "magnet" ? 6 : undefined,
    height: kind === "magnet" ? 3 : undefined,
    // A rail comes with its carriage and a lead screw with its nut, moving.
    withMoving: STANDARD_WITH_MOVING.includes(kind) ? true : undefined,
    angle: STANDARD_LYING.includes(kind) ? feature.angle : undefined,
  };
}

/** Standard part: kind, size and length, the face it goes on and the places on it. */
function StandardPartFields({ f: feature, set }: { f: Of<"standard_part">; set: SetPatch }) {
  const sizes = STANDARD_SIZES[feature.kind];

  return (
    <>
      <Field label={t("Part")}>
        <select
          className="field"
          value={feature.kind}
          onChange={(event) =>
            set(standardKindPatch(feature, event.target.value as Of<"standard_part">["kind"]))
          }
        >
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
            <select
              className="field"
              value={feature.size ?? ""}
              onChange={(event) =>
                set({
                  size: event.target.value,
                  ...(feature.kind === "insert" ? { length: undefined } : {}),
                })
              }
            >
              {sizes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {STANDARD_WITH_LENGTH.includes(feature.kind) ? (
          <Field label={t("Length")}>
            <select
              className="field"
              value={String(feature.length ?? 10)}
              onChange={(event) => set({ length: Number(event.target.value) })}
            >
              {SCREW_LENGTHS.map((l) => (
                <option key={l} value={l}>
                  {l} mm
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {feature.kind === "insert" ? (
          <InsertLength size={feature.size ?? "M3"} length={feature.length} set={set} />
        ) : null}
        {STANDARD_CUT_TO_LENGTH.includes(feature.kind) ? (
          <Field label={t("Length")}>
            <ExprInput value={feature.length ?? 200} onCommit={(length) => set({ length })} />
          </Field>
        ) : null}
        {feature.kind === "magnet" ? (
          <>
            <Field label={t("Diameter")}>
              <ExprInput value={feature.diameter ?? 6} onCommit={(diameter) => set({ diameter })} />
            </Field>
            <Field label={t("Height")}>
              <ExprInput value={feature.height ?? 3} onCommit={(height) => set({ height })} />
            </Field>
          </>
        ) : null}
      </div>
      {/* Its own row: next to size and length the size would not fit. */}
      {STANDARD_LYING.includes(feature.kind) ? (
        <Field label={t("Turned")}>
          <ExprInput
            value={feature.angle ?? 0}
            unit="deg"
            onCommit={(angle) => set({ angle: angle === 0 ? undefined : angle })}
          />
        </Field>
      ) : null}
      {STANDARD_WITH_MOVING.includes(feature.kind) ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={!!feature.withMoving}
            onChange={(event) => set({ withMoving: event.target.checked ? true : undefined })}
          />
          {feature.kind === "rail"
            ? t("With carriage (slides on the rail)")
            : t("With nut (travels when the screw turns)")}
        </label>
      ) : null}
      <Field label={t("Face")}>
        <div className="row">
          <div style={{ flex: 1 }}>
            <SelBox
              field="plane"
              items={[describePlane(feature.plane)]}
              placeholder={t("Tap a flat face where the part goes")}
            />
          </div>
          <FlipButton flip={feature.flip} title={t("Turn the other way")} set={set} />
        </div>
      </Field>
      <PointsField
        label={t("Places ({n})", { n: feature.points.length })}
        points={feature.points}
        summary={tn(
          feature.points.length,
          "{n} place: tap the face to add",
          "{n} places: tap the face to add",
        )}
        placeholder={t("Tap the face to place parts")}
        set={set}
      />
      <p className="muted small">
        {feature.kind === "socket_screw" || feature.kind === "hex_screw"
          ? t("The head sits on the face, the shank goes in: tap the centre of a hole.")
          : feature.kind === "countersunk_screw" || feature.kind === "set_screw" || feature.kind === "insert"
            ? t("It sits in the hole, flush with the face: tap the centre of a hole.")
            : t("The part stands on the face; turn it to set it into a recess.")}{" "}
        {t("Each place is its own part.")}
      </p>
    </>
  );
}

/** `values` with the one at `k` replaced. */
const replaced = (values: [Expr, Expr, Expr], k: number, v: Expr) =>
  values.map((x, i) => (i === k ? v : x)) as [Expr, Expr, Expr];

/** Switching a primitive's shape: a box takes its size, a cylinder or sphere its diameter (and height). */
function primitiveShapePatch(feature: Of<"primitive">, shape: Of<"primitive">["shape"]) {
  return shape === "box"
    ? {
        shape,
        size: feature.size ?? [20, 20, 20],
        diameter: undefined,
        height: undefined,
        axis: undefined,
      }
    : {
        shape,
        diameter: feature.diameter ?? 20,
        height: shape === "cylinder" ? (feature.height ?? 20) : undefined,
        size: undefined,
        ...(shape === "sphere" ? { axis: undefined } : {}),
      };
}

/** Primitive: box, cylinder or sphere, its size, axis, centre and result. */
function PrimitiveFields({ f: feature, set }: { f: Of<"primitive">; set: SetPatch }) {
  const c = feature.center ?? [0, 0, 0];
  const size = feature.size ?? [20, 20, 20];
  const setCenter = (k: number, v: Expr) => set({ center: replaced(c, k, v) });
  const setSize = (k: number, v: Expr) => set({ size: replaced(size, k, v) });

  return (
    <>
      <Field label={t("Shape")}>
        <Seg
          value={feature.shape}
          options={[
            ["box", t("primitive::Box")],
            ["cylinder", t("primitive::Cylinder")],
            ["sphere", t("primitive::Sphere")],
          ]}
          onChange={(shape) => set(primitiveShapePatch(feature, shape))}
        />
      </Field>
      {feature.shape === "box" ? (
        <div className="row">
          {(["X", "Y", "Z"] as const).map((a, k) => (
            <Field key={a} label={t("Size {axis}", { axis: a })}>
              <ExprInput
                value={size[k]!}
                onCommit={(expr) => setSize(k, expr)}
                onLive={(expr) => setSize(k, expr)}
              />
            </Field>
          ))}
        </div>
      ) : (
        <div className="row">
          <Field label={t("Diameter")}>
            <ExprInput
              value={feature.diameter ?? 20}
              onCommit={(diameter) => set({ diameter })}
              onLive={(diameter) => set({ diameter })}
            />
          </Field>
          {feature.shape === "cylinder" ? (
            <Field label={t("Height")}>
              <ExprInput
                value={feature.height ?? 20}
                onCommit={(height) => set({ height })}
                onLive={(height) => set({ height })}
              />
            </Field>
          ) : null}
        </div>
      )}
      {feature.shape === "cylinder" ? (
        <Field label={t("Axis")}>
          <Seg
            value={feature.axis ?? "Z"}
            options={[
              ["X", "X"],
              ["Y", "Y"],
              ["Z", "Z"],
            ]}
            onChange={(axis) => set({ axis: axis === "Z" ? undefined : axis })}
          />
        </Field>
      ) : null}
      <div className="row">
        {(["X", "Y", "Z"] as const).map((a, k) => (
          <Field key={a} label={t("Centre {axis}", { axis: a })}>
            <ExprInput
              value={c[k]!}
              onCommit={(expr) => setCenter(k, expr)}
              onLive={(expr) => setCenter(k, expr)}
            />
          </Field>
        ))}
      </div>
      <Field label={t("Result")}>
        <Seg value={feature.mode} options={MODES} onChange={(mode) => set({ mode })} />
      </Field>
    </>
  );
}

/** Text: the words, the face they go on, raised or engraved, size, font, alignment and place. */
function TextFields({ f: feature, set }: { f: Of<"text">; set: SetPatch }) {
  const pos = feature.position ?? [0, 0];

  return (
    <>
      <Field label={t("Text")}>
        <textarea
          className="field"
          rows={2}
          value={feature.text}
          autoFocus
          onChange={(event) => set({ text: event.target.value })}
        />
      </Field>
      <Field label={t("On")}>
        <SelBox
          field="plane"
          items={[describePlane(feature.plane)]}
          placeholder={t("Tap a flat face where the text starts")}
        />
      </Field>
      <Field label={t("Result")}>
        <Seg
          value={feature.mode}
          options={[
            ["join", t("Raised")],
            ["cut", t("Engraved")],
            ["new_body", t("New part")],
          ]}
          onChange={(mode) => set({ mode })}
        />
      </Field>
      <div className="row">
        <Field label={t("Letter height")}>
          <ExprInput
            value={feature.size}
            onCommit={(size) => set({ size })}
            onLive={(size) => set({ size })}
          />
        </Field>
        <Field label={feature.mode === "cut" ? t("Depth") : t("Height")}>
          <ExprInput
            value={feature.depth}
            onCommit={(depth) => set({ depth })}
            onLive={(depth) => set({ depth })}
          />
        </Field>
      </div>
      <div className="row">
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
        <Field label={t("text::Align")}>
          <Seg
            value={feature.align ?? "left"}
            options={[
              ["left", t("Left")],
              ["center", t("Centre")],
              ["right", t("Right")],
            ]}
            onChange={(align) => set({ align: align === "left" ? undefined : align })}
          />
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
          <ExprInput
            value={feature.angle ?? 0}
            unit="deg"
            onCommit={(angle) => set({ angle: angle === 0 ? undefined : angle })}
          />
        </Field>
      </div>
      <p className="muted small">
        {t(
          "Letter height is the height of capitals. For printing, about 5 mm high and 0.6–1 mm deep reads well.",
        )}
      </p>
    </>
  );
}

/** Draft: side faces, angle and the neutral plane they lean from. */
function DraftFields({ f: feature, set }: { f: Of<"draft">; set: SetPatch }) {
  return (
    <>
      <Field label={t("Faces")}>
        <SelBox
          field="faces"
          items={feature.faces.map(describeFaceSelector)}
          placeholder={t("Pick side faces")}
          onRemove={(i) => set({ faces: feature.faces.filter((_, j) => j !== i) })}
        />
      </Field>
      <Field label={t("Angle")}>
        <ExprInput
          value={feature.angle}
          unit="deg"
          autoFocus
          onCommit={(angle) => set({ angle })}
          onLive={(angle) => set({ angle })}
        />
      </Field>
      <Field label={t("Neutral plane")}>
        <div className="row">
          <div style={{ flex: 1 }}>
            <SelBox
              field="neutral"
              items={[describePlane(feature.neutral)]}
              placeholder={t("Pick a plane or flat face")}
            />
          </div>
          <FlipButton flip={feature.flip} title={t("Pull the other way")} set={set} />
        </div>
        <PlaneButtons value={feature.neutral} onChange={(neutral) => set({ neutral })} />
      </Field>
      <p className="muted small">
        {t(
          "The faces keep their edge on the neutral plane (usually the bottom or the parting face) and lean inwards in the pull direction. 1–3° is typical for moulded parts.",
        )}
      </p>
    </>
  );
}

/** Offset faces: faces, by a distance or up to a plane. */
function OffsetFaceFields({ f: feature, set }: { f: Of<"offset_face">; set: SetPatch }) {
  return (
    <>
      <Field label={t("Faces")}>
        <SelBox
          field="faces"
          items={feature.faces.map(describeFaceSelector)}
          placeholder={t("Pick faces")}
          onRemove={(i) => set({ faces: feature.faces.filter((_, j) => j !== i) })}
        />
      </Field>
      <Field label={t("Up to")}>
        <div className="row">
          <div style={{ flex: 1 }}>
            <SelBox
              field="upTo"
              items={feature.upTo ? [describePlane(feature.upTo)] : []}
              placeholder={t("Optional: a plane or flat face")}
            />
          </div>
          {feature.upTo && (
            <button className="icon-btn" title={t("Remove")} onClick={() => set({ upTo: undefined })}>
              <X />
            </button>
          )}
        </div>
      </Field>
      <Field label={feature.upTo ? t("Gap before it") : t("Distance")}>
        <ExprInput
          value={feature.distance}
          unit="mm"
          autoFocus
          onCommit={(distance) => set({ distance })}
          onLive={(distance) => set({ distance })}
        />
      </Field>
      <p className="muted small">
        {feature.upTo
          ? t("Flat faces parallel to the plane move onto it, or stop short of it by the gap.")
          : t(
              "Positive moves the faces out of the part (it grows there), negative into it. A hole wall moved out makes the hole tighter.",
            )}
      </p>
    </>
  );
}

/** Rib: open lines of a sketch, thickness and side. */
function RibFields({ f: feature, set, sketches }: { f: Of<"rib">; set: SetPatch; sketches: Of<"sketch">[] }) {
  const sketch = sketches.find((x) => x.id === feature.sketch);
  const name = sketch ? featureName(sketch) : feature.sketch;

  return (
    <>
      <Field label={t("Lines")}>
        <SelBox
          field="curves"
          items={
            !feature.sketch
              ? []
              : feature.curves
                ? feature.curves.map((c) => `${name} · ${c}`)
                : [`All lines of ${name}`]
          }
          placeholder={t("Pick open lines in a sketch")}
          onRemove={(i) =>
            set(
              feature.curves && feature.curves.length > 1
                ? { curves: feature.curves.filter((_, j) => j !== i) }
                : { sketch: "", curves: undefined },
            )
          }
        />
        <SketchSelect
          sketches={sketches}
          prompt={t("…or all lines of a sketch")}
          onPick={(sketch) => set({ sketch, curves: undefined })}
        />
      </Field>
      <Field label={t("Thickness")}>
        <div className="row">
          <div style={{ flex: 1 }}>
            <ExprInput
              value={feature.thickness}
              autoFocus
              onCommit={(thickness) => set({ thickness })}
              onLive={(thickness) => set({ thickness })}
            />
          </div>
          <FlipButton flip={feature.flip} title={t("Fill towards the other side")} set={set} />
        </div>
      </Field>
      <p className="muted small">
        {t(
          "Draw the rib as an open line on a plane across the walls, e.g. from a wall to the floor. It fills from the line to the walls it meets, centred on the sketch plane.",
        )}
      </p>
    </>
  );
}

/** Split: plane, parts, which pieces to keep, connectors, and whether the pieces fit the bed. */
function SplitFields({ f: feature, set }: { f: Of<"split">; set: SetPatch }) {
  const features = useApp((state) => state.doc.features);

  return (
    <>
      <Field label={t("Split at")}>
        <SelBox
          field="plane"
          items={[describePlane(feature.plane)]}
          placeholder={t("Pick a plane or flat face")}
        />
        <PlaneButtons value={feature.plane} onChange={(plane) => set({ plane })} />
      </Field>
      <Field label={t("Parts")}>
        <SelBox
          field="bodies"
          items={feature.bodies.map((b) => partName(b, features))}
          placeholder={t("All parts the plane crosses")}
          onRemove={(i) => set({ bodies: feature.bodies.filter((_, j) => j !== i) })}
        />
      </Field>
      <Field label={t("Keep")}>
        <Seg
          value={feature.keep ?? "both"}
          options={[
            ["both", t("Both")],
            ["front", t("Front")],
            ["back", t("Back")],
          ]}
          onChange={(keep) => set(keep === "both" ? { keep: undefined } : { keep, connectors: undefined })}
        />
      </Field>
      {(feature.keep ?? "both") === "both" ? <SplitConnectorFields f={feature} set={set} /> : null}
      <p className="muted small">
        {t(
          "For a part larger than the printer: split at an offset plane, print both pieces. Front is the side the plane's arrow points to; that piece keeps the part's name.",
        )}
      </p>
      <BedCheck />
    </>
  );
}

/** Delete: the parts to remove. */
function DeleteFields({ f: feature, set }: { f: Of<"delete">; set: SetPatch }) {
  const features = useApp((state) => state.doc.features);

  return (
    <Field label={t("Parts")}>
      <SelBox
        field="bodies"
        items={feature.bodies.map((b) => partName(b, features))}
        placeholder={t("Pick parts")}
        onRemove={(i) => set({ bodies: feature.bodies.filter((_, j) => j !== i) })}
      />
    </Field>
  );
}

/** Mesh to solid: the mesh part, tolerance and sharp edge angle. */
function MeshConvertFields({ f: feature, set }: { f: Of<"mesh_convert">; set: SetPatch }) {
  const features = useApp((state) => state.doc.features);

  return (
    <>
      <Field label={t("Mesh part")}>
        <SelBox
          field="body"
          items={feature.body ? [partName(feature.body, features)] : []}
          placeholder={t("Pick a mesh part")}
          onRemove={() => set({ body: "" })}
        />
      </Field>
      <Field label={t("Tolerance")}>
        <ExprInput
          value={feature.tolerance}
          placeholder="auto"
          onCommit={(tolerance) => set({ tolerance: tolerance === 0 ? undefined : tolerance })}
        />
      </Field>
      <Field label={t("Sharp edge angle")}>
        <ExprInput value={feature.angle ?? 30} unit="deg" onCommit={(angle) => set({ angle })} />
      </Field>
      <p className="muted small">
        {t(
          "Flat, round, conical and spherical areas of the mesh become real faces (within the tolerance; by default a small fraction of the part's size). Triangles that match no surface stay flat facets. Raise the tolerance for rough meshes.",
        )}
      </p>
    </>
  );
}

/** Move: parts, offset, optional rotation, copy or not. */
function TransformFields({ f: feature, set }: { f: Of<"transform">; set: SetPatch }) {
  const features = useApp((state) => state.doc.features);

  const tr = feature.translate ?? [0, 0, 0];
  const setT = (i: number, expr: Expr) => set({ translate: tr.map((x, j) => (j === i ? expr : x)) });

  return (
    <>
      <Field label={t("Parts")}>
        <SelBox
          field="bodies"
          items={feature.bodies.map((b) => partName(b, features))}
          placeholder={t("Pick parts")}
          onRemove={(i) => set({ bodies: feature.bodies.filter((_, j) => j !== i) })}
        />
      </Field>
      {!feature.copy && feature.bodies.some((b) => joinedParts(b).length > 1) ? (
        <p className="muted small">{t("Parts joined to them come along, so their joints stay together.")}</p>
      ) : null}
      <Field label={t("Move by (X / Y / Z)")}>
        <div className="row">
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ flex: 1 }}>
              <ExprInput value={tr[i]} onCommit={(expr) => setT(i, expr)} onLive={(expr) => setT(i, expr)} />
            </div>
          ))}
        </div>
      </Field>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.rotate}
          onChange={(event) =>
            set({ rotate: event.target.checked ? { axis: { ref: "origin.Z" }, angle: 90 } : undefined })
          }
        />{" "}
        {t("Rotate")}
      </label>
      {feature.rotate ? (
        <>
          <Field label={t("Axis")}>
            <SelBox
              field="axis"
              items={[describeAxis(feature.rotate.axis)]}
              placeholder={t("Pick an edge or line")}
            />
            <AxisButtons
              value={feature.rotate.axis}
              onChange={(axis) => set({ rotate: { ...feature.rotate!, axis } })}
            />
          </Field>
          <Field label={t("Angle")}>
            <ExprInput
              value={feature.rotate.angle}
              unit="deg"
              onCommit={(angle) => set({ rotate: { ...feature.rotate!, angle } })}
              onLive={(angle) => set({ rotate: { ...feature.rotate!, angle } })}
            />
          </Field>
        </>
      ) : null}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!feature.copy}
          onChange={(event) => set({ copy: event.target.checked || undefined })}
        />{" "}
        {t("Keep original (copy)")}
      </label>
    </>
  );
}

/** Construction plane: reference, offset and tilt. */
function PlaneFields({ f: feature, set }: { f: Of<"plane">; set: SetPatch }) {
  return (
    <>
      <Field label={t("Reference")}>
        <SelBox field="base" items={[describePlane(feature.base)]} placeholder={t("Pick a plane or face")} />
        <PlaneButtons value={feature.base} onChange={(base) => set({ base })} />
      </Field>
      <Field label={t("Offset")}>
        <ExprInput
          value={feature.offset}
          autoFocus
          onCommit={(offset) => set({ offset })}
          onLive={(offset) => set({ offset })}
        />
      </Field>
      <Field label={t("Tilt")}>
        <ExprInput
          value={feature.angle ?? 0}
          unit="deg"
          onCommit={(angle) => set({ angle })}
          onLive={(angle) => set({ angle })}
        />
      </Field>
    </>
  );
}
