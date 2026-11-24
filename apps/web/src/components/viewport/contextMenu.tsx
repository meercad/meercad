/**
 * The context menu of the 3D view (right click, or a long press on touch): one menu for empty space
 * (with the terrain tools when the ground is there), a mesh part, a face, an edge, a sketch and a plane.
 */
import type { FeatureOp } from "@meercad/schema";
import { samePick, type Pick, type Viewport } from "@meercad/viewport";
import {
  ArrowDownToLine,
  BoxSelect,
  CircleDot,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eraser,
  FlaskConical,
  Eye,
  EyeOff,
  Focus,
  Ghost,
  Highlighter,
  Image as PictureIcon,
  ImageOff,
  Layers,
  LayoutGrid,
  MapPin,
  Move3d,
  Pencil,
  PencilLine,
  Printer,
  Ruler,
  ScanSearch,
  Shapes,
  StickyNote,
  Trash,
  Wand2,
  Weight,
} from "lucide-react";
import type { ReactNode } from "react";
import { copyParts, hasClip, pasteParts, selectAll, selectedParts } from "../../lib/clipboard";
import { deleteBodies, deleteModelSelection } from "../../lib/deletion";
import { hasBeta } from "../../lib/beta";
import { isCompact } from "../../lib/layout";
import { nativeApp } from "../../lib/native";
import { hideDeviation, showDeviation, useDeviation } from "../../lib/deviation";
import { openStrength } from "../../lib/strength";
import { FEATURES, partName } from "../../lib/features";
import { keyFor } from "../../lib/keymap";
import { t } from "../../lib/i18n";
import { convertMeshPart, rebuildMeshPart } from "../../lib/meshConvert";
import { importOf, openMeshRepair } from "../../lib/meshRepair";
import { meshBodyIds } from "../../lib/meshParts";
import { textureToggle } from "../../lib/meshTexture";
import { binForPart } from "../../lib/partBin";
import { hidePrintCheck, layOnFace, showPrintCheck, usePrintCheck } from "../../lib/printability";
import { sketchOnTerrain, terrainItems } from "../../lib/terrain";
import { addMarkPoint, clearTerrainMeasure, measurePoint, startMarking } from "../../lib/terrainDraw";
import { hideThickness, showThickness, useThickness } from "../../lib/thickness";
import { planeSpecForPick, PLANE_LABELS } from "../../lib/topology";
import { editFeature, startFeature, startHoleAt, startSketch, useApp } from "../../store";
import { deleteFeature, toggleHidden, toggleSeeThrough } from "../FeatureTree";
import { showMenu, type MenuEntry } from "../Menu";
import { openMaterialPicker } from "../MaterialPicker";
import { cleanUpMenu } from "../TerrainTools";
import { ownerOfPick, wholePart } from "./click";
import { featureOfPick } from "./scene";

type AppState = ReturnType<typeof useApp.getState>;
type Ground = NonNullable<ReturnType<Viewport["sceneryHit"]>>;
type FacePick = Extract<Pick, { kind: "face" }>;

interface Item {
  label: string;
  icon: ReactNode;
  kbd?: string;
  onClick: () => void;
}

/** Opens the menu for `pick` (null: empty space) at the screen point x, y. */
export function openContextMenu(viewport: Viewport, pick: Pick | null, x: number, y: number): void {
  const state = useApp.getState();
  if (state.dialog || state.sketchId) return;

  // Selected as by a click, so a sketch edge's dimensions show beside the menu too.
  if (pick && !state.selection.some((p) => samePick(p, pick))) {
    useApp.setState({ selection: [pick], selectedFeature: ownerOfPick(pick, state) });
  }

  const fid = pick ? featureOfPick(pick, useApp.getState().doc.features) : null;
  const common = commonItems(pick, fid);
  const ground = !pick ? viewport.sceneryHit(x, y) : null;

  if (!pick) return showMenu(x, y, emptySpaceMenu(viewport, ground, state, x, y));

  if (pick.kind === "face" && meshBodyIds(state.doc.features, state.output?.meshes ?? []).has(pick.bodyId)) {
    return showMenu(x, y, meshPartMenu(pick, state, common));
  }

  if (pick.kind === "face") return showMenu(x, y, faceMenu(pick, state, common));

  if (pick.kind === "edge") {
    return showMenu(x, y, [featureItem("fillet"), featureItem("chamfer"), "sep", ...common]);
  }

  if (pick.kind === "region" || pick.kind === "sketch_curve") {
    return showMenu(x, y, sketchMenu(pick.sketchId));
  }

  if (pick.kind === "plane") return showMenu(x, y, planeMenu(pick.planeId));
}

/** An entry that starts a tool, with its icon and shortcut. */
function featureItem(op: FeatureOp, label?: string) {
  const Icon = FEATURES[op].icon;

  return {
    label: label ?? FEATURES[op].label,
    icon: <Icon />,
    kbd: FEATURES[op].shortcut,
    onClick: () => startFeature(op),
  };
}

/** Editing the picked feature and measuring from the pick, in every part menu. */
function commonItems(pick: Pick | null, fid: string | null) {
  return [
    ...(fid
      ? [
          {
            label: t("Edit {feature}", { feature: fid }),
            icon: <Pencil />,
            onClick: () => editFeature(fid),
          },
        ]
      : []),
    {
      label: t("Measure"),
      icon: <Ruler />,
      kbd: "Shift+M",
      onClick: () =>
        useApp.setState({
          measure: {
            active: true,
            picks: pick && (pick.kind === "face" || pick.kind === "edge") ? [pick] : [],
            result: null,
          },
        }),
    },
  ];
}

/** Empty space: the terrain tools where the ground is, then selecting, pasting and the view. */
function emptySpaceMenu(
  viewport: Viewport,
  ground: Ground | null | undefined,
  state: AppState,
  x: number,
  y: number,
): MenuEntry[] {
  return [
    ...(ground ? [...groundItems(ground, x, y), "sep" as const] : []),
    { label: t("Select all parts"), icon: <BoxSelect />, kbd: "Mod+A", onClick: () => selectAll() },
    ...(hasClip()
      ? [{ label: t("Paste"), icon: <ClipboardPaste />, kbd: "Mod+V", onClick: () => void pasteParts() }]
      : []),
    { label: t("Fit view"), icon: <Focus />, kbd: keyFor("fit"), onClick: () => viewport.fit() },
    {
      label: state.showPlanes ? t("Hide planes") : t("Show planes"),
      icon: <Layers />,
      onClick: () => useApp.setState({ showPlanes: !state.showPlanes }),
    },
    { label: t("Show all parts"), icon: <Eye />, onClick: () => useApp.setState({ hidden: new Set() }) },
  ];
}

/** Marking, measuring and sketching on the terrain at the point pressed. */
function groundItems(ground: Ground, x: number, y: number): Item[] {
  return [
    {
      label: t("Mark a line"),
      icon: <PencilLine />,
      onClick: () => (startMarking("line", ground.id), addMarkPoint(ground.point)),
    },
    {
      label: t("Mark an area"),
      icon: <Shapes />,
      onClick: () => (startMarking("area", ground.id), addMarkPoint(ground.point)),
    },
    {
      label: t("Highlighter"),
      icon: <Highlighter />,
      onClick: () => startMarking("stroke", ground.id),
    },
    {
      label: t("Pin a note here"),
      icon: <StickyNote />,
      onClick: () => (startMarking("note", ground.id), addMarkPoint(ground.point)),
    },
    {
      label: t("Stake-out point here"),
      icon: <MapPin />,
      onClick: () => (startMarking("point", ground.id), addMarkPoint(ground.point)),
    },
    {
      label: t("Measure from here"),
      icon: <Ruler />,
      onClick: () => (
        useApp.setState({ measure: { active: true, picks: [], result: null } }),
        clearTerrainMeasure(),
        measurePoint(ground.point, ground.id)
      ),
    },
    {
      label: t("New sketch here on the ground"),
      icon: <Pencil />,
      onClick: () => sketchOnTerrain(ground.point),
    },
    { label: t("Clean up…"), icon: <Eraser />, onClick: () => cleanUpMenu(ground.id, x, y) },
  ];
}

/** A mesh part (a scan, an imported mesh): selected as a whole, with the tools that work on meshes. */
function meshPartMenu(pick: FacePick, state: AppState, common: MenuEntry[]): MenuEntry[] {
  const mesh = state.output?.meshes.find((b) => b.bodyId === pick.bodyId);
  if (mesh) useApp.setState({ selection: wholePart(mesh, pick.point) });

  return [
    {
      label: t("Move {part}", { part: partName(pick.bodyId, useApp.getState().doc.features) }),
      icon: <Move3d />,
      onClick: () => startFeature("transform"),
    },
    mirrorItem(),
    ...partItems(pick.bodyId, state),
    "sep" as const,
    printItem(pick.bodyId),
    {
      label: t("Lay on this face"),
      icon: <ArrowDownToLine />,
      onClick: () => layOnFace(pick.bodyId, pick.face, pick.normal ?? pick.surface),
    },
    {
      label: t("Gridfinity bin for this part"),
      icon: <LayoutGrid />,
      onClick: () => binForPart(pick.bodyId),
    },
    "sep" as const,
    {
      label: t("Convert to editable body"),
      icon: <Shapes />,
      onClick: () => convertMeshPart(pick.bodyId),
    },
    {
      label: t("Rebuild with features"),
      icon: <Wand2 />,
      onClick: () => void rebuildMeshPart(pick.bodyId),
    },
    thicknessItem(pick.bodyId),
    ...(importOf(pick.bodyId)
      ? [{ label: t("Clean up mesh…"), icon: <Eraser />, onClick: () => openMeshRepair(pick.bodyId) }]
      : []),
    "sep",
    ...common,
    "sep",
    deletePartItem(pick.bodyId),
  ];
}

/** A face of a modelled part: sketching on it, the face tools, the part's own entries and the checks. */
function faceMenu(pick: FacePick, state: AppState, common: MenuEntry[]): MenuEntry[] {
  return [
    ...(pick.normal
      ? [
          {
            label: t("New sketch on face"),
            icon: <Pencil />,
            kbd: "S",
            onClick: () => startSketch(planeSpecForPick(pick, state.output?.meshes ?? []) ?? undefined),
          },
        ]
      : []),
    featureItem("extrude", t("Push/pull face")),
    featureItem("fillet", t("Fillet face edges")),
    featureItem("chamfer", t("Chamfer face edges")),
    featureItem("shell", t("Shell (remove this face)")),
    ...(!pick.normal ? [featureItem("thread", t("Thread this hole or shaft"))] : []),
    ...(pick.normal
      ? [{ label: t("Hole here"), icon: <CircleDot />, kbd: "Shift+H", onClick: () => startHoleAt(pick) }]
      : []),
    "sep",
    ...partItems(pick.bodyId, state),
    mirrorItem(),
    "sep",
    printItem(pick.bodyId),
    ...(pick.normal
      ? [
          {
            label: t("Lay on this face"),
            icon: <ArrowDownToLine />,
            onClick: () => layOnFace(pick.bodyId, pick.face),
          },
        ]
      : []),
    ...deviationItems(pick.bodyId),
    thicknessItem(pick.bodyId),
    ...strengthItems(pick.bodyId),
    ...common,
    "sep",
    {
      label: useApp.getState().selection.length > 1 ? t("Delete selection") : t("Delete face"),
      icon: <Trash />,
      kbd: "⌫",
      danger: true,
      onClick: () => void deleteModelSelection(),
    },
    deletePartItem(pick.bodyId),
  ];
}

/** A sketch's region or curve: the tools that take a profile, editing and hiding the sketch. */
function sketchMenu(sketchId: string): MenuEntry[] {
  return [
    featureItem("extrude"),
    featureItem("revolve"),
    "sep",
    {
      label: t("Edit sketch {sketch}", { sketch: sketchId }),
      icon: <Pencil />,
      onClick: () => editFeature(sketchId),
    },
    { label: t("Hide sketch"), icon: <EyeOff />, onClick: () => toggleHidden(sketchId) },
  ];
}

/** A plane: a sketch on it, an offset plane, and deleting it unless it is an origin plane. */
function planeMenu(planeId: string): MenuEntry[] {
  return [
    {
      label: t("New sketch on {plane}", { plane: PLANE_LABELS[planeId] ?? planeId }),
      icon: <Pencil />,
      onClick: () => startSketch({ ref: planeId }),
    },
    featureItem("plane", t("Offset plane")),
    ...(planeId.startsWith("origin.")
      ? []
      : [
          {
            label: t("Delete plane"),
            icon: <Trash />,
            danger: true,
            onClick: () => {
              const feature = useApp.getState().doc.features.find((x) => x.id === planeId);
              if (feature) void deleteFeature(feature);
            },
          },
        ]),
  ];
}

/** The parts a part entry acts on: the selected parts when this one is among them, else this one. */
function partsFor(bodyId: string): string[] {
  return selectedParts().includes(bodyId) ? selectedParts() : [bodyId];
}

/** Hiding, copying, placing on the terrain, see-through, material and picture: in both part menus. */
function partItems(bodyId: string, state: AppState): Item[] {
  return [
    {
      label: t("Hide {part}", { part: partName(bodyId, useApp.getState().doc.features) }),
      icon: <EyeOff />,
      onClick: () => toggleHidden(bodyId),
    },
    {
      label: t("Copy"),
      icon: <Copy />,
      kbd: "Mod+C",
      onClick: () => copyParts(partsFor(bodyId)),
    },
    {
      label: t("Duplicate"),
      icon: <CopyPlus />,
      kbd: "Mod+D",
      onClick: () => (copyParts(partsFor(bodyId)), void pasteParts()),
    },
    ...terrainItems(bodyId, { set: <ArrowDownToLine />, place: <MapPin /> }),
    {
      label: state.doc.seeThrough?.includes(bodyId) ? t("Show solid") : t("Show see-through"),
      icon: <Ghost />,
      onClick: () => toggleSeeThrough(bodyId),
    },
    {
      label: t("Material…"),
      icon: <Weight />,
      onClick: () => openMaterialPicker(partsFor(bodyId)),
    },
    ...textureItems(bodyId),
  ];
}

/** Mirroring starts with an empty selection, so the part is chosen in the tool. */
function mirrorItem(): Item {
  return {
    label: t("Mirror part"),
    icon: <Copy />,
    onClick: () => (useApp.setState({ selection: [] }), startFeature("mirror")),
  };
}

function deletePartItem(bodyId: string): MenuEntry {
  return {
    label: t("Delete {part}", { part: partName(bodyId, useApp.getState().doc.features) }),
    icon: <Trash />,
    danger: true,
    onClick: () => deleteBodies([bodyId]),
  };
}

/** "Deviation from <mesh>" for each mesh part in the model (a scan, the mesh a part was rebuilt from). */
function deviationItems(body: string): Item[] {
  const state = useApp.getState();

  if (useDeviation.getState().body === body) {
    return [{ label: t("Hide deviation"), icon: <ScanSearch />, onClick: hideDeviation }];
  }

  const meshes = [...meshBodyIds(state.doc.features, state.output?.meshes ?? [])].filter((id) => id !== body);

  return meshes.map((mesh) => ({
    label: t("Deviation from {mesh}", { mesh: partName(mesh, state.doc.features) }),
    icon: <ScanSearch />,
    onClick: () => (hideThickness(), hidePrintCheck(), showDeviation(body, mesh)),
  }));
}

function thicknessItem(body: string): Item {
  if (useThickness.getState().body === body) {
    return { label: t("Hide wall thickness"), icon: <Layers />, onClick: hideThickness };
  }

  return {
    label: t("Wall thickness"),
    icon: <Layers />,
    onClick: () => (hideDeviation(), hidePrintCheck(), showThickness(body)),
  };
}

/** The strength check with the topology suggestion: only with the beta function switched on. */
function strengthItems(body: string): Item[] {
  // Not on the iPhone: minutes of full load on one core are no use there.
  if (!hasBeta("topology") || (nativeApp && isCompact())) return [];

  return [
    {
      label: t("Strength and topology (beta)"),
      icon: <FlaskConical />,
      onClick: () => (hideDeviation(), hideThickness(), hidePrintCheck(), openStrength(body)),
    },
  ];
}

function printItem(body: string): Item {
  if (usePrintCheck.getState().body === body) {
    return { label: t("Hide printability"), icon: <Printer />, onClick: hidePrintCheck };
  }

  return {
    label: t("Check printability"),
    icon: <Printer />,
    onClick: () => (hideDeviation(), hideThickness(), showPrintCheck(body)),
  };
}

/** The switch for a scan's picture, for the part menus. */
function textureItems(bodyId: string): Item[] {
  const sw = textureToggle(bodyId);

  return sw
    ? [{ label: sw.label, icon: sw.shown ? <ImageOff /> : <PictureIcon />, onClick: sw.onClick }]
    : [];
}
