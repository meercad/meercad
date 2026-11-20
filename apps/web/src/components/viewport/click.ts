/**
 * A click (or tap) in the 3D view, in the order the tools take it: drawing and measuring on the
 * terrain, laying a part on the plate, a joint field, the sketch plane, the Measure tool, an open tool's
 * selection field, and otherwise the selection.
 */
import { samePick, type Pick, type PickKind, type Viewport } from "@meercad/viewport";
import type { RebuildOutput } from "@meercad/kernel/client";
import { jointPick } from "../../lib/mechanism";
import { meshBodyIds, meshHint } from "../../lib/meshParts";
import { layOnFace, pickFaceToLay, usePrintCheck } from "../../lib/printability";
import { sectionOnPick, useViewSection } from "../../lib/viewSection";
import { clearScanMeasure, measureOnScan } from "../../lib/scanMeasure";
import { placeAt, sketchOnTerrain, useTerrainPlace } from "../../lib/terrain";
import { addMarkPoint, measurePoint, useTerrainDraw, useTerrainMeasure } from "../../lib/terrainDraw";
import { curveOfPick } from "../../lib/sketchEdge";
import { choosePlane } from "../../lib/sketchPlane";
import { planeSpecForPick } from "../../lib/topology";
import { t } from "../../lib/i18n";
import { commitDialog, dialogPick, kernel, startSketch, toast, useApp, type DialogState } from "../../store";
import { pickKindsFor } from "../FeatureDialog";
import { featureOfPick } from "./scene";

type AppState = ReturnType<typeof useApp.getState>;
/** A pick on a part: a face or an edge. */
type PartPick = Extract<Pick, { kind: "face" | "edge" }>;

/** What a click picks when no tool narrows it. */
export const DEFAULT_KINDS = new Set<PickKind>(["edge", "face", "region", "sketch_curve", "plane"]);

/** Dialog fields that take whole parts, so a click on a mesh part may fill them. */
const PART_FIELDS = new Set(["targets", "target", "tools", "bodies", "source", "body"]);

/** What a click may pick right now. */
export function pickKinds(): ReadonlySet<PickKind> {
  const state = useApp.getState();
  if (useViewSection.getState().picking) return new Set(["face"]);
  if (state.pickingSketchPlane) return new Set(["plane", "face"]);
  if (state.measure.active) return new Set(["face", "edge"]);
  if (state.dialog) return pickKindsFor(state.dialog);

  return DEFAULT_KINDS;
}

/** Handles a click on `pick` (null: empty space) at the screen point `at`. */
export function clickInView(
  viewport: Viewport,
  pick: Pick | null,
  additive: boolean,
  at?: [number, number],
  ground = false,
): void {
  const state = useApp.getState();
  if (clickOnTerrainOrPlate(viewport, pick, at, state)) return;
  if (!state.dialog && jointPick(pick)) return;
  if (state.pickingSketchPlane) return pickSketchPlane(viewport, pick, at, state, ground);
  if (state.measure.active) return measurePick(pick, state);

  // A mesh part is picked as a whole: its faces are thousands of triangles.
  const meshPick = onMeshPart(pick, state);
  if (state.dialog) return dialogClick(pick, additive, !!meshPick, state.dialog);
  if (!pick) return void useApp.setState({ selection: [], selectedFeature: null });

  if (meshPick) return selectMeshPart(meshPick, state);

  useApp.setState({
    selection: toggledSelection(state.selection, pick, additive),
    selectedFeature: ownerOfPick(pick, state),
  });
}

/**
 * The step a pick belongs to: for an edge a sketch's curve made, the step that swept it (so its
 * sketch's dimensions show on the model), else the step that made the face or part.
 */
export function ownerOfPick(pick: Pick, state: AppState): string | null {
  const features = state.doc.features;
  const meshes = state.output?.meshes ?? state.baseOutput?.meshes ?? [];

  return curveOfPick(pick, meshes, features)?.featureId ?? featureOfPick(pick, features);
}

/**
 * The tools that work on the ground or the plate: drawing on the terrain, setting a part onto it, laying
 * a part on a face, measuring on the terrain. True when one of them took the click.
 */
function clickOnTerrainOrPlate(
  viewport: Viewport,
  pick: Pick | null,
  at: [number, number] | undefined,
  state: AppState,
): boolean {
  // Drawing on the terrain: each click is a point where it meets the ground.
  if (useTerrainDraw.getState().kind) {
    const hit = at && viewport.sceneryHit(at[0], at[1]);
    if (hit) addMarkPoint(hit.point, hit.id);

    return true;
  }

  // A part waiting to be set onto the terrain goes where it is clicked.
  if (useTerrainPlace.getState().body) {
    const hit = at && viewport.sceneryHit(at[0], at[1]);
    if (hit) placeAt(hit.point);
    else toast(t("Click on the terrain"), "error");

    return true;
  }

  // Laying the section plane on a face.
  if (useViewSection.getState().picking) {
    sectionOnPick(pick);

    return true;
  }

  // Laying a part on the plate: the face clicked goes down.
  if (usePrintCheck.getState().picking) {
    if (pick?.kind === "face") layOnFace(pick.bodyId, pick.face, pick.normal ?? pick.surface);
    else pickFaceToLay(false);

    return true;
  }

  // Measuring on the terrain, or the two ends of a known distance to scale it by.
  const ms = useTerrainMeasure.getState();

  if (ms.scale || (state.measure.active && !pick)) {
    const hit = at && viewport.sceneryHit(at[0], at[1]);

    if (hit) {
      measurePoint(hit.point, hit.id);

      return true;
    }

    if (ms.scale) return true;
  }

  return false;
}

/**
 * Choosing where a new sketch goes (lib/sketchPlane.ts): the flat face or plane clicked, the ground for
 * a click on nothing or with Option/Alt held (`ground`: parts never block it), or level on the terrain.
 */
function pickSketchPlane(
  viewport: Viewport,
  pick: Pick | null,
  at: [number, number] | undefined,
  state: AppState,
  ground: boolean,
): void {
  const terrain = !pick && !ground && at ? viewport.sceneryHit(at[0], at[1]) : null;
  const choice = choosePlane(pick, !!terrain, ground, (p) => planeSpecForPick(p, state.output?.meshes ?? []));

  if (choice.kind === "terrain") sketchOnTerrain(terrain!.point);
  else if (choice.kind === "plane") startSketch(choice.spec);
  else toast(t("Pick a plane or a flat face"), "error");
}

/** The Measure tool: a face or an edge, then a second one; on a mesh part the shape fitted there. */
function measurePick(pick: Pick | null, state: AppState): void {
  // On a scan or other mesh part: the shape the surface follows there.
  const meshPick = onMeshPart(pick, state);
  if (meshPick) return void measureOnScan(meshPick.bodyId, meshPick.point);

  clearScanMeasure();

  if (!pick || (pick.kind !== "face" && pick.kind !== "edge")) {
    return useApp.setState({ measure: { active: true, picks: [], result: null } });
  }

  const picks = nextMeasurePicks(state.measure.picks, pick);
  useApp.setState({ measure: { active: true, picks, result: null } });

  const [a, b] = picks.map(measureRef);

  if (a) {
    void kernel.measure(a, b ?? undefined).then(
      (result) => useApp.setState((state) => ({ measure: { ...state.measure, result } })),
      (error: Error) => toast(error.message, "error"),
    );
  }
}

/** The picks to measure after a click: a third one starts over, otherwise the last two. */
export function nextMeasurePicks(picks: readonly Pick[], pick: Pick): Pick[] {
  return picks.length >= 2 ? [pick] : [...picks.filter((p) => !samePick(p, pick)), pick].slice(-2);
}

/** A face or an edge as the kernel's measure takes it. */
function measureRef(pick: Pick) {
  return pick.kind === "face"
    ? { bodyId: pick.bodyId, kind: "face" as const, index: pick.face }
    : pick.kind === "edge"
      ? { bodyId: pick.bodyId, kind: "edge" as const, index: pick.edge }
      : null;
}

/** An open tool: the pick fills its selection field; empty space accepts the tool when none waits. */
function dialogClick(pick: Pick | null, additive: boolean, onMesh: boolean, dialog: DialogState): void {
  if (onMesh && dialog.field && !PART_FIELDS.has(dialog.field)) return toast(meshHint());
  if (pick && dialog.field) dialogPick?.(pick, additive);
  // Clicking empty space accepts the tool unless a selection field is waiting.
  else if (!pick && !dialog.field) commitDialog();
}

/** The pick when it is a face or edge of a mesh part (a scan, an imported mesh), else null. */
function onMeshPart(pick: Pick | null, state: AppState): PartPick | null {
  return pick &&
    (pick.kind === "face" || pick.kind === "edge") &&
    meshBodyIds(state.doc.features, state.output?.meshes ?? []).has(pick.bodyId)
    ? pick
    : null;
}

/** Selects every face of the mesh part `pick` lies on. */
function selectMeshPart(pick: PartPick, state: AppState): void {
  const mesh = state.output?.meshes.find((x) => x.bodyId === pick.bodyId);

  if (mesh) {
    useApp.setState({
      selection: wholePart(mesh, pick.point),
      selectedFeature: featureOfPick(pick, useApp.getState().doc.features),
    });
  }
}

/** All faces of a mesh part as picks at `point`. */
export function wholePart(mesh: RebuildOutput["meshes"][number], point: Pick["point"]): Pick[] {
  return mesh.faceTags.map((tags, face) => ({
    kind: "face" as const,
    bodyId: mesh.bodyId,
    face,
    tags,
    point,
    normal: null,
  }));
}

/** The selection after a click: the pick alone, or with Shift added or taken away. */
export function toggledSelection(selection: readonly Pick[], pick: Pick, additive: boolean): Pick[] {
  const i = selection.findIndex((x) => samePick(x, pick));

  return additive ? (i >= 0 ? selection.filter((_, j) => j !== i) : [...selection, pick]) : [pick];
}
