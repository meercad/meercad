import { currentPoses, joinedParts, jointPick, partDrag, useMotion } from "../lib/mechanism";
import { AiOrb, toolLabel } from "./AiOrb";
import { materialName, partLooks } from "../lib/materials";
import { RenderBar } from "./RenderBar";
import { openMaterialPicker } from "./MaterialPicker";
import { partColors } from "../lib/partColors";
import { formatMass, massOf, motion, partMaterial } from "@meercad/model";
import { DEVIATION_GRADIENT, hideDeviation, showDeviation, useDeviation } from "../lib/deviation";
import { hasPack } from "../lib/premium";
import { closeMeshRepair, importOf, openMeshRepair, runMeshRepair, useMeshRepair } from "../lib/meshRepair";
import { hideThickness, setMinWall, showThickness, THICKNESS_GRADIENT, useThickness } from "../lib/thickness";
import { hidePrintCheck, layOnFace, pickFaceToLay, PRINT_COLORS, printBestWayUp, setOverhangLimit, showPrintCheck, usePrintCheck } from "../lib/printability";
import { touchOnly } from "../lib/keyboard";
import { hasTerrain, placeAt, previewPlace, sceneryOf, sketchOnTerrain, terrainItems, useTerrainPlace } from "../lib/terrain";
import { cleanUpMenu } from "./TerrainTools";
import { copyParts, hasClip, pasteParts, selectAll, selectedParts, selectParts } from "../lib/clipboard";
import { addMarkPoint, beginStroke, endStroke, extendStroke, clearTerrainMeasure, finishMarking, marksForView, measurePoint, startMarking, useTerrainDraw, useTerrainMeasure } from "../lib/terrainDraw";
import { TerrainHud, TerrainLabels } from "./TerrainTools";
import { clearScanMeasure, measureOnScan, scanOf, setScanTolerance, useScanMeasure } from "../lib/scanMeasure";
import { Image as PictureIcon, ImageOff, ArrowDownToLine, LayoutGrid, Box, BoxSelect, ClipboardPaste, CopyPlus, CircleDot, Copy, Eraser, Eye, EyeOff, Focus, Ghost, Highlighter, Layers, MapPin, Move3d, StickyNote, Palette, Pencil, PencilLine, Printer, Ruler, Scan, ScanSearch, Shapes, SlidersHorizontal, Trash, Wand2, Waves, Weight, X } from "lucide-react";
import { convertMeshPart, rebuildMeshPart } from "../lib/meshConvert";
import { binForPart } from "../lib/partBin";
import { useEffect, useMemo, useRef, useState } from "react";
import { deleteBodies, deleteModelSelection } from "../lib/deletion";
import { navigationFor, rightClick, setPrefs, useKey, usePrefs } from "../lib/keymap";
import { withKey } from "./Kbd";
import { isCompact, usePhoneSheets } from "../lib/layout";
import type { FeatureOp } from "@meercad/schema";
import { perFrame, samePick, THREE, Viewport, type DisplayMode, type Pick, type PickKind, type PlaneView, type SceneData, type SketchView } from "@meercad/viewport";
import { FEATURES, featureName, partName, sketchesUsed } from "../lib/features";
import { MultiTouch, Press } from "../lib/gestures";
import { planeSpecForPick, PLANE_LABELS } from "../lib/topology";
import { SketchEditor } from "../sketch/SketchEditor";
import { commitDialog, dialogPick, editFeature, startHoleAt, kernel, redo, scheduleRebuild, setViewport, startFeature, startSketch, toast, undo, useApp } from "../store";
import { pickKindsFor } from "./FeatureDialog";
import { deleteFeature, toggleHidden, toggleSeeThrough } from "./FeatureTree";
import { closeMenu, showMenu } from "./Menu";
import { InlineValues } from "./InlineValues";
import { Manipulators } from "./Manipulators";
import { ViewCube } from "./ViewCube";
import { SnapControls } from "./SnapControls";
import { dragStep, gridLevels } from "../lib/grid";
import { convertMmText, docUnit } from "../lib/units";
import { meshBodyIds, meshHint } from "../lib/meshParts";
import { bodyTextures, textureToggle } from "../lib/meshTexture";
import { t, tn } from "../lib/i18n";

/** Dialog fields that take whole parts, so a click on a mesh part may fill them. */
const PART_FIELDS = new Set(["targets", "target", "tools", "bodies", "source", "body"]);
/** Two clicks this close in time (ms) are a double-click. */
const DOUBLE_MS = 400;
import { CUSTOM_PLANE_COLOR, PLANE_COLORS, PlaneChooser } from "./PlaneChooser";

const ORIGIN_FRAMES: Record<string, PlaneView["frame"]> = {
  "origin.XY": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  "origin.XZ": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
  "origin.YZ": { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
};

const DEFAULT_KINDS = new Set<PickKind>(["edge", "face", "region", "sketch_curve", "plane"]);
const EMPTY_SCENE: SceneData = { bodies: [], sketches: [], planes: [], references: [], hiddenBodies: new Set(), editingSketch: null };

const NO_HITS: [string, string][] = [];
const NO_PARTS: string[] = [];
const HIT_COLOR = "#d93f3f";

/** In a scheme where a right click confirms: finishes the open tool or the measurement. False when nothing ran. */
function confirmByRightClick(): boolean {
  if (rightClick() !== "confirm") return false;
  const s = useApp.getState();
  if (s.dialog) commitDialog();
  else if (s.measure.active) useApp.setState({ measure: { active: false, picks: [], result: null } });
  else return false;
  return true;
}

export function ViewportView() {
  const host = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<Viewport | null>(null);
  const fitKey = useKey("fit");
  const output = useApp((s) => s.output);
  const hidden = useApp((s) => s.hidden);
  const showPlanes = useApp((s) => s.showPlanes);
  const showSketches = useApp((s) => s.showSketches);
  const showValues = usePrefs((s) => s.showValues);
  const showTextures = usePrefs((s) => s.showTextures);
  const hasTextures = useApp((s) => s.doc.features.some((f) => f.op === "lithophane" && !f.suppressed));
  const colorParts = usePrefs((s) => s.colorParts);
  const sketchId = useApp((s) => s.sketchId);
  const dialog = useApp((s) => s.dialog);
  const selection = useApp((s) => s.selection);
  const measure = useApp((s) => s.measure);
  const pickingPlane = useApp((s) => s.pickingSketchPlane);
  const placing = useTerrainPlace((s) => !!s.body) || usePrintCheck((s) => s.picking);
  const doc = useApp((s) => s.doc);
  // Deviation from a mesh as a colour map on the part.
  const heat = useDeviation((s) => s.maps);
  const wall = useThickness((s) => s.maps);
  const print = usePrintCheck((s) => s.maps);
  useEffect(() => vp?.setBodyHeat(print.size ? print : wall.size ? wall : heat), [vp, heat, wall, print]);
  const layingOnFace = usePrintCheck((s) => s.picking);
  // Reference models (an area from drone photos) around the design.
  const references = doc.references;
  const [sceneryReady, setSceneryReady] = useState(0);
  useEffect(() => void vp?.setScenery(sceneryOf({ ...doc, references })).then(() => setSceneryReady((n) => n + 1)), [vp, references]); // eslint-disable-line react-hooks/exhaustive-deps
  // Lines, areas and notes on it, with the one being drawn.
  const drawing = useTerrainDraw();
  // The highlighter: a press on the ground paints until it comes up (mouse, finger or Pencil). It
  // takes the pointer before the view's own handling, so painting never turns the view.
  const painting = drawing.kind === "stroke" || drawing.kind === "erase";
  useEffect(() => {
    const el = host.current;
    if (!vp || !el || !painting) return;
    let active: number | null = null;
    const down = (e: PointerEvent) => {
      if (active !== null || e.target !== vp.canvas || (e.pointerType === "mouse" && e.button !== 0)) return;
      const hit = vp.sceneryHit(e.clientX, e.clientY);
      if (!hit) return;
      e.stopPropagation();
      e.preventDefault();
      active = e.pointerId;
      try {
        vp.canvas.setPointerCapture(e.pointerId);
      } catch {
        // A pointer the browser no longer knows: the stroke still follows it while over the view.
      }
      beginStroke(hit.point, hit.id);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      e.stopPropagation();
      const hit = vp.sceneryHit(e.clientX, e.clientY);
      if (hit) extendStroke(hit.point);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== active) return;
      e.stopPropagation();
      active = null;
      endStroke();
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move, true);
    el.addEventListener("pointerup", up, true);
    el.addEventListener("pointercancel", up, true);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move, true);
      el.removeEventListener("pointerup", up, true);
      el.removeEventListener("pointercancel", up, true);
    };
  }, [vp, painting]);
  const terrainMeasure = useTerrainMeasure();
  useEffect(() => {
    if (!measure.active && !terrainMeasure.scale && terrainMeasure.points.length) clearTerrainMeasure();
  }, [measure.active, terrainMeasure]);
  const marks = useMemo(() => (vp ? marksForView(references, drawing) : { lines: [], labels: [] }), [vp, references, drawing, terrainMeasure, sceneryReady]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => vp?.setSceneryMarks(marks.lines), [vp, marks]);
  // Shapes fitted on a scan in the Measure tool, laid over the triangles they cover.
  const scanShapes = useScanMeasure((s) => s.shapes);
  useEffect(() => {
    if (!vp || !scanShapes.length) return;
    const group = new THREE.Group();
    scanShapes.forEach(({ bodyId, shape }, i) => {
      const m = scanOf(bodyId);
      if (!m) return;
      const pos = new Float32Array(shape.triangles.length * 9);
      shape.triangles.forEach((tri, k) => {
        for (let c = 0; c < 3; c++) pos.set(m.positions.subarray(m.triangles[tri * 3 + c]! * 3, m.triangles[tri * 3 + c]! * 3 + 3), k * 9 + c * 3);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.MeshBasicMaterial({ color: i ? 0x2e7dff : 0xff7a1a, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      group.add(new THREE.Mesh(g, mat));
    });
    vp.overlay.add(group);
    vp.invalidate();
    return () => {
      vp.overlay.remove(group);
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      vp.invalidate();
    };
  }, [vp, scanShapes]);
  // Parts that run into each other while the joints panel is open show red.
  // So do parts that cannot move further this way (links in line, a joint at its limit).
  const hits = useMotion((s) => (s.open ? s.hits : NO_HITS));
  const blocked = useMotion((s) => (s.open ? s.blocked : NO_PARTS));
  useEffect(() => {
    if (!vp) return;
    const colors = partColors(doc, output?.report.bodies.map((b) => b.id) ?? [], colorParts);
    const red = [...hits.flat(), ...blocked];
    vp.setBodyColors(red.length ? new Map([...colors, ...red.map((id): [string, string] => [id, HIT_COLOR])]) : colors);
  }, [vp, doc, output, colorParts, hits, blocked]);
  // Materials give parts their finish (PBR).
  useEffect(() => {
    if (!vp) return;
    vp.setBodyLooks(partLooks(doc, output?.report.bodies.map((b) => b.id) ?? []));
  }, [vp, doc, output]);
  const kernelState = useApp((s) => s.kernel);
  const previewing = useApp((s) => s.previewing);
  const [ortho, setOrtho] = useState(false);
  const [mode, setMode] = useState<DisplayMode>("shaded_edges");
  // Grid contrast follows the light/dark theme.
  useEffect(() => {
    if (!vp) return;
    const apply = () => {
      const t = document.documentElement.dataset["theme"];
      vp.setDark(t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => {
      mo.disconnect();
      mq.removeEventListener("change", apply);
    };
  }, [vp]);
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; filter: "all" | "face" | "edge" } | null>(null);
  const boxRef = useRef(box);
  boxRef.current = box;
  const [busy, setBusy] = useState(false);
  // Rebuilds that take a noticeable moment say so in the status line.
  const building = useApp((s) => s.building);
  const [slowBuild, setSlowBuild] = useState(false);
  useEffect(() => {
    if (!building) return setSlowBuild(false);
    const t = setTimeout(() => setSlowBuild(true), 700);
    return () => clearTimeout(t);
  }, [building]);

  useEffect(() => {
    const v = new Viewport(host.current!);
    // Named for screen readers (and the touch tests, which aim gestures with several fingers at it).
    v.renderer.domElement.setAttribute("role", "img");
    v.renderer.domElement.setAttribute("aria-label", t("3D view"));
    setVp(v);
    setViewport(v);
    const applyNav = () => {
      const p = usePrefs.getState();
      v.setNavigation(navigationFor(p.mouse), p.invertZoom, p.swipeOrbits);
      // The grid button shows the grid and snaps to it; off, it is hidden and nothing snaps to it.
      v.setGridVisible(p.snapGrid);
      v.invalidate();
    };
    // The grid follows the zoom in the design's unit. Drag arrows move in finer round steps (not the
    // grid's), or freely with the grid off.
    v.gridSteps = (pixel) => gridLevels(pixel, docUnit());
    v.handleStep = (pixel) => {
      const p = usePrefs.getState();
      return p.snapGrid ? dragStep(pixel, docUnit()) : 0.01;
    };
    applyNav();
    const offPrefs = usePrefs.subscribe(applyNav);
    return () => {
      offPrefs();
      setViewport(null);
      v.dispose();
    };
  }, []);

  // The grid is laid out in the design's unit.
  const designUnits = useApp((s) => s.doc.units);
  useEffect(() => vp?.invalidate(), [vp, designUnits]);

  // Scene
  const scene = useMemo<SceneData | null>(() => {
    if (!output) return null;
    const r = output.report;
    let size = 60;
    for (const b of r.bodies) size = Math.max(size, ...b.bbox.max.map(Math.abs), ...b.bbox.min.map(Math.abs));
    const consumed = sketchesUsed(doc.features);
    const picksSketches = ["extrude", "revolve", "loft", "sweep", "rib"].includes(dialog?.feature.op ?? "");
    const sketches: SketchView[] = r.sketches
      .filter((s) => !hidden.has(s.id) && (s.id === sketchId || !consumed.has(s.id) || picksSketches || hiddenOverride(s.id)))
      .map((s) => ({ id: s.id, frame: s.frame, curves: s.curves, regions: s.regions.map((g) => ({ key: g.key, polygons: g.polygons })) }));
    const planes: PlaneView[] = [
      ...Object.entries(ORIGIN_FRAMES).map(([id, frame]) => ({ id, label: PLANE_LABELS[id]!, frame, size: size * 0.6, color: PLANE_COLORS[id]! })),
      ...r.planes.map((p) => ({ id: p.id, label: doc.features.find((f) => f.id === p.id)?.name ?? p.id, frame: p.frame, size: size * 0.6, color: CUSTOM_PLANE_COLOR })),
    ];
    // Mesh parts show no edges: they would outline every triangle.
    const meshParts = meshBodyIds(doc.features, output.meshes);
    const bodies = output.meshes.map((m) => (meshParts.has(m.bodyId) && m.edgeRanges.length ? { ...m, edgeLines: new Float32Array(), edgeRanges: new Int32Array() } : m));
    return { bodies, sketches, planes, references: output.references, hiddenBodies: hidden, ghostBodies: new Set(doc.seeThrough ?? []), editingSketch: sketchId };
  }, [output, hidden, sketchId, doc.features, doc.seeThrough, dialog?.feature.op]);

  useEffect(() => {
    // No model yet (a project is opening): clear the view instead of showing the previous one.
    if (!vp) return;
    const st = useApp.getState();
    // Mesh parts light up as a whole on hover and selection.
    vp.setWholeBodies(meshBodyIds(st.doc.features, st.output?.meshes ?? []));
    vp.setScene(scene ?? EMPTY_SCENE);
    if (!scene) vp.resetFraming();
  }, [vp, scene]);
  // Scanned parts wear their picture (unless it is switched off on the part).
  useEffect(() => vp?.setBodyTextures(bodyTextures(doc.features, output?.meshes ?? [])), [vp, doc.features, output]);
  // Phone: sheets cover the lower part of the view; the model centres in the space above them.
  const motionOpen = useMotion((s) => s.open);
  const sideOpen = useApp((s) => s.sideOpen);
  const phoneConstraints = usePhoneSheets((s) => s.constraints);
  useEffect(() => {
    if (!vp) return;
    const sheets = () => [...document.querySelectorAll<HTMLElement>(".dialog, .measure-card, .side, .constraint-palette.open")];
    const update = () => {
      if (!isCompact()) return vp.setBottomInset(0);
      const box = vp.canvas.getBoundingClientRect();
      const top = Math.min(box.bottom, ...sheets().map((el) => el.getBoundingClientRect().top));
      vp.setBottomInset(Math.max(0, box.bottom - top));
    };
    const ro = new ResizeObserver(update);
    sheets().forEach((el) => ro.observe(el));
    update();
    // Sheets slide in: measure again once they have arrived.
    const t = window.setTimeout(update, 260);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
      window.removeEventListener("resize", update);
    };
  }, [vp, dialog, measure.active, sideOpen, sketchId, phoneConstraints, motionOpen]);
  // Moving parts: poses from the joint values; parts can be dragged while the joints panel is open.
  const motionFree = useMotion((s) => s.free);
  const motionTick = useMotion((s) => s.tick);
  // A part being set onto the terrain shows where it would stand.
  const placeMove = useTerrainPlace((s) => s.move);
  const placeBody = useTerrainPlace((s) => s.body);
  useEffect(() => {
    if (!vp) return;
    vp.partDrag = motionOpen && !dialog ? partDrag : null;
    const poses = currentPoses();
    if (placeBody && placeMove) for (const id of joinedParts(placeBody)) poses.set(id, new THREE.Matrix4().makeTranslation(...placeMove).toArray());
    vp.setPoses(poses);
  }, [vp, motionOpen, motionFree, motionTick, output, doc.mechanism, dialog, placeBody, placeMove]);
  // Joint symbols while the joints panel is open; the one being edited stands out.
  // Switched off they stay away so the motion shows alone, except for the joint being edited.
  const motionDraft = useMotion((s) => s.draft);
  const showJoints = usePrefs((s) => s.showJoints);
  useEffect(() => {
    if (!vp) return;
    const joints = doc.mechanism?.joints ?? [];
    const frames = output?.report.joints ?? [];
    vp.setJointGlyphs(
      motionOpen
        ? joints.flatMap((j) => {
            const f = frames.find((x) => x.id === j.id);
            if (!f || f.error || j.suppressed) return [];
            const active = motionDraft?.joint.id === j.id;
            if (!showJoints && !active) return [];
            const on = j.b !== "ground" ? { parent: j.b } : {};
            // A cylindrical joint shows a ring to turn it (riding on its slide) and an arrow to slide it.
            if (j.type === "cylindrical")
              return [
                { id: `${j.id}${motion.TURN}`, type: "revolute" as const, origin: f.origin, axis: f.axis, parent: motion.cylindricalCarrier(j.id), active },
                { id: `${j.id}${motion.SLIDE}`, type: "slider" as const, origin: f.origin, axis: f.axis, ...on, active },
              ];
            return [{ id: j.id, type: j.type, origin: f.origin, axis: f.axis, ...on, active }];
          })
        : [],
    );
  }, [vp, motionOpen, output, doc.mechanism, motionDraft?.joint.id, showJoints]);
  const hasBodies = !!output?.report.bodies.length;
  useEffect(() => vp?.setPlanesVisible(!sketchId && (showPlanes || !hasBodies || pickingPlane || dialog?.field === "plane" || dialog?.field === "base")), [vp, sketchId, showPlanes, hasBodies, pickingPlane, dialog?.field]);
  useEffect(() => vp?.setPlaneEmphasis(pickingPlane || dialog?.field === "plane" || dialog?.field === "base"), [vp, pickingPlane, dialog?.field]);
  useEffect(() => vp?.setSketchesVisible(showSketches), [vp, showSketches]);
  useEffect(() => vp?.setFingerDraws(!!sketchId), [vp, sketchId]);
  useEffect(() => {
    if (!vp) return;
    vp.setSelection(measure.active ? measure.picks : selection);
  }, [vp, selection, measure]);
  useEffect(() => {
    setBusy(true);
    const t = setTimeout(() => setBusy(false), 150);
    return () => clearTimeout(t);
  }, [output]);

  const kinds = (): ReadonlySet<PickKind> => {
    const s = useApp.getState();
    if (s.pickingSketchPlane) return new Set(["plane", "face"]);
    if (s.measure.active) return new Set(["face", "edge"]);
    if (s.dialog) return pickKindsFor(s.dialog);
    return DEFAULT_KINDS;
  };

  // Pointer handling (sketch mode is handled by the sketch editor)
  useEffect(() => {
    if (!vp) return;
    const el = vp.canvas;
    let down: { x: number; y: number; button: number; empty: boolean } | null = null;
    /** The last plain click, to catch the second click of a double-click on a face. */
    let lastClick: { at: number; x: number; y: number; body: string | null } | null = null;
    let doubleDone = -Infinity;
    let filter: "all" | "face" | "edge" = "all";
    const onKey = (e: KeyboardEvent) => {
      if (!boxRef.current) return;
      const k = e.key.toLowerCase();
      // While box-selecting, F = faces only, E = edges only, Tab cycles.
      if (k === "f" || k === "e" || k === "tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        filter = k === "f" ? "face" : k === "e" ? "edge" : filter === "all" ? "face" : filter === "face" ? "edge" : "all";
        setBox((b) => (b ? { ...b, filter } : b));
      }
    };
    window.addEventListener("keydown", onKey, true);
    // Touch and pen: a tap selects one item after another and a tap on empty space deselects;
    // holding opens the context menu, holding and then dragging selects an area. A finger double
    // tap turns the view to the face, a pen double tap selects the whole part. Swiping three
    // fingers sideways (or tapping two / three) undoes and redoes.
    let area: { x: number; y: number } | null = null;
    let boxNow: typeof box = null;
    let navOff = false;
    const press = new Press(
      (x, y, e) => {
        if (useApp.getState().sketchId || boxRef.current) return;
        down = null;
        contextMenu(vp.pick(x, y, kinds()), x, y);
        // Should the finger move on, it drags out an area instead of orbiting.
        if (e.pointerType === "touch") {
          navOff = true;
          vp.controls.enabled = false;
        }
      },
      (x, y) => {
        if (useApp.getState().dialog) return;
        closeMenu();
        area = { x, y };
        filter = "all";
      },
    );
    const multi = new MultiTouch((g) => {
      if (g === "swipe-left" || g === "tap2") undo();
      else redo();
    });
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") {
        press.move(e);
        multi.move(e);
      }
      if ((e.pointerType === "touch" && !area) || useApp.getState().sketchId) return;
      moveFrame(e);
    };
    const showBox = (x0: number, y0: number, e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      boxNow = { x0: x0 - r.left, y0: y0 - r.top, x1: e.clientX - r.left, y1: e.clientY - r.top, filter };
      setBox(boxNow);
    };
    // Hover picking and box sizing raycast the model: once per frame is plenty.
    const moveFrame = perFrame((e: PointerEvent) => {
      if (area) return showBox(area.x, area.y, e);
      const d = down;
      if (d && d.button === 0 && d.empty && e.buttons === 1 && !useApp.getState().dialog && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) {
        press.cancel();
        return showBox(d.x, d.y, e);
      }
      if (e.buttons) return;
      // Setting a part onto the terrain or drawing on it: the ground under the pointer is what counts.
      const ms = useTerrainMeasure.getState();
      const measuring = ms.scale || (useApp.getState().measure.active && ms.points.length === 1);
      if (useTerrainPlace.getState().body || useTerrainDraw.getState().kind || measuring) {
        const hit = vp.sceneryHit(e.clientX, e.clientY);
        if (useTerrainPlace.getState().body && hit) previewPlace(hit.point);
        if (useTerrainDraw.getState().kind) useTerrainDraw.setState({ hover: hit?.point ?? null });
        if (measuring) useTerrainMeasure.setState({ hover: hit?.point ?? null });
        if (!measuring || ms.scale) return;
      }
      vp.setHover(vp.pick(e.clientX, e.clientY, kinds()));
    });
    const finishBox = (additive: boolean) => {
      const b = boxNow ? { ...boxNow, filter } : boxRef.current;
      boxNow = null;
      if (!b) return;
      setBox(null);
      const r = el.getBoundingClientRect();
      const enclosed = b.x1 >= b.x0;
      const ks = new Set<"face" | "edge">(b.filter === "all" ? ["face", "edge"] : [b.filter]);
      const meshParts = meshBodyIds(useApp.getState().doc.features, useApp.getState().output?.meshes ?? []);
      // Box selection skips mesh parts' triangles (they are picked as whole parts).
      const picks = vp.boxSelect(b.x0 + r.left, b.y0 + r.top, b.x1 + r.left, b.y1 + r.top, enclosed, ks).filter((p) => !((p.kind === "face" || p.kind === "edge") && meshParts.has(p.bodyId)));
      const cur = useApp.getState().selection;
      useApp.setState({ selection: additive ? [...cur, ...picks.filter((p) => !cur.some((c) => samePick(c, p)))] : picks, selectedFeature: null });
    };
    const restoreNav = () => {
      if (!navOff) return;
      navOff = false;
      vp.controls.enabled = true;
    };
    const onDown = (e: PointerEvent) => {
      multi.down(e);
      if (e.pointerType !== "mouse" && !useApp.getState().sketchId) press.down(e);
      if (e.pointerType === "touch") return;
      moveFrame.cancel();
      filter = "all";
      down = { x: e.clientX, y: e.clientY, button: e.button, empty: e.button === 0 && !vp.pick(e.clientX, e.clientY, kinds()) };
    };
    const onUp = (e: PointerEvent) => {
      const gesture = e.pointerType === "mouse" ? null : press.up(e);
      multi.up(e);
      restoreNav();
      if (area) {
        moveFrame.flush();
        area = null;
        down = null;
        return finishBox(false);
      }
      if (e.pointerType === "touch") {
        if (useApp.getState().sketchId) return;
        if (gesture === "tap") onClick(vp.pick(e.clientX, e.clientY, kinds()), true, [e.clientX, e.clientY]);
        if (gesture === "double") {
          const pick = vp.pick(e.clientX, e.clientY, new Set(["face"]));
          if (pick?.kind === "face" && pick.normal) vp.lookAtFace(pick.point, pick.normal);
        }
        return;
      }
      moveFrame.flush();
      const d = down;
      down = null;
      if (gesture === "double" && e.pointerType === "pen") return onDbl(e);
      if (boxNow || boxRef.current) return finishBox(e.shiftKey);
      if (!d || useApp.getState().sketchId || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
      const pick = vp.pick(e.clientX, e.clientY, kinds());
      if (d.button === 2) return confirmByRightClick() ? undefined : contextMenu(pick, e.clientX, e.clientY);
      if (d.button !== 0) return;
      // The second click of a double-click on a face selects its part right away: going through
      // the face again and then the part made the highlight and the steps list flicker.
      const now = performance.now();
      const prev = lastClick;
      lastClick = { at: now, x: e.clientX, y: e.clientY, body: pick?.kind === "face" ? pick.bodyId : null };
      if (prev?.body && (!pick || pick.kind === "face") && now - prev.at < DOUBLE_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 6 && !useApp.getState().dialog && !useApp.getState().measure.active && !useTerrainDraw.getState().kind) {
        lastClick = null;
        doubleDone = now;
        return selectParts([prev.body], e.shiftKey || e.metaKey || e.ctrlKey, true);
      }
      onClick(pick, e.shiftKey || e.metaKey || e.ctrlKey || e.pointerType === "pen", [e.clientX, e.clientY]);
    };
    const onDbl = (e: MouseEvent) => {
      // Already handled on the second click.
      if (performance.now() - doubleDone < DOUBLE_MS) return;
      if (useTerrainDraw.getState().kind) return finishMarking();
      if (useApp.getState().sketchId || useApp.getState().dialog) return;
      const pick = vp.pick(e.clientX, e.clientY, DEFAULT_KINDS);
      // Double-clicking a face selects its whole part; other entities open their feature.
      if (pick?.kind === "face") return selectParts([pick.bodyId], e.shiftKey || e.metaKey || e.ctrlKey, true);
      const fid = pick ? featureOfPick(pick) : null;
      if (fid) editFeature(fid);
    };
    const onCancel = (e: PointerEvent) => {
      press.up(e);
      multi.up(e);
      restoreNav();
      if (e.pointerType === "touch" && !area) return;
      moveFrame.cancel();
      area = null;
      boxNow = null;
      down = null;
      setBox(null);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("dblclick", onDbl);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onCancel);
      el.removeEventListener("dblclick", onDbl);
      window.removeEventListener("keydown", onKey, true);
      press.cancel();
      moveFrame.cancel();
      restoreNav();
    };
  }, [vp]);

  const onClick = (pick: Pick | null, additive: boolean, at?: [number, number]) => {
    const s = useApp.getState();
    // Drawing on the terrain: each click is a point where it meets the ground.
    if (useTerrainDraw.getState().kind) {
      const hit = at && vp?.sceneryHit(at[0], at[1]);
      if (hit) addMarkPoint(hit.point, hit.id);
      return;
    }
    // A part waiting to be set onto the terrain goes where it is clicked.
    if (useTerrainPlace.getState().body) {
      const hit = at && vp?.sceneryHit(at[0], at[1]);
      if (hit) placeAt(hit.point);
      else toast(t("Click on the terrain"), "error");
      return;
    }
    // Laying a part on the plate: the face clicked goes down.
    if (usePrintCheck.getState().picking) {
      if (pick?.kind === "face") layOnFace(pick.bodyId, pick.face, pick.normal ?? pick.surface);
      else pickFaceToLay(false);
      return;
    }
    // Measuring on the terrain, or the two ends of a known distance to scale it by.
    const ms = useTerrainMeasure.getState();
    if (ms.scale || (s.measure.active && !pick)) {
      const hit = at && vp?.sceneryHit(at[0], at[1]);
      if (hit) return measurePoint(hit.point, hit.id);
      if (ms.scale) return;
    }
    if (!s.dialog && jointPick(pick)) return;
    if (s.pickingSketchPlane) {
      // On the terrain (no part or plane in the way): a level sketch at that height.
      const ground = !pick && at ? vp?.sceneryHit(at[0], at[1]) : null;
      if (ground) return sketchOnTerrain(ground.point);
      if (!pick) return;
      const spec = planeSpecForPick(pick, s.output?.meshes ?? []);
      if (spec) startSketch(spec);
      else toast(t("Pick a plane or a flat face"), "error");
      return;
    }
    if (s.measure.active) {
      // On a scan or other mesh part: the shape the surface follows there.
      if (pick && (pick.kind === "face" || pick.kind === "edge") && hasPack("scan") && meshBodyIds(s.doc.features, s.output?.meshes ?? []).has(pick.bodyId)) return measureOnScan(pick.bodyId, pick.point);
      clearScanMeasure();
      if (!pick || (pick.kind !== "face" && pick.kind !== "edge")) return useApp.setState({ measure: { active: true, picks: [], result: null } });
      const picks = s.measure.picks.length >= 2 || !additive && s.measure.picks.length >= 2 ? [pick] : [...s.measure.picks.filter((p) => !samePick(p, pick)), pick].slice(-2);
      useApp.setState({ measure: { active: true, picks, result: null } });
      const ref = (p: Pick) => (p.kind === "face" ? { bodyId: p.bodyId, kind: "face" as const, index: p.face } : p.kind === "edge" ? { bodyId: p.bodyId, kind: "edge" as const, index: p.edge } : null);
      const [a, b] = picks.map(ref);
      if (a)
        void kernel.measure(a, b ?? undefined).then(
          (result) => useApp.setState((st) => ({ measure: { ...st.measure, result } })),
          (e: Error) => toast(e.message, "error"),
        );
      return;
    }
    // A mesh part is picked as a whole: its faces are thousands of triangles.
    const onMesh = pick && (pick.kind === "face" || pick.kind === "edge") && meshBodyIds(s.doc.features, s.output?.meshes ?? []).has(pick.bodyId);
    if (s.dialog) {
      if (onMesh && s.dialog.field && !PART_FIELDS.has(s.dialog.field)) return toast(meshHint(hasPack("scan")));
      if (pick && s.dialog.field) dialogPick?.(pick, additive);
      // Clicking empty space accepts the tool unless a selection field is waiting.
      else if (!pick && !s.dialog.field) commitDialog();
      return;
    }
    if (!pick) return useApp.setState({ selection: [], selectedFeature: null });
    if (onMesh) {
      const m = s.output?.meshes.find((x) => x.bodyId === pick.bodyId);
      if (m) useApp.setState({ selection: m.faceTags.map((tags, face) => ({ kind: "face" as const, bodyId: m.bodyId, face, tags, point: pick.point, normal: null })), selectedFeature: featureOfPick(pick) });
      return;
    }
    const i = s.selection.findIndex((x) => samePick(x, pick));
    const selection = additive ? (i >= 0 ? s.selection.filter((_, j) => j !== i) : [...s.selection, pick]) : [pick];
    useApp.setState({ selection, selectedFeature: featureOfPick(pick) });
  };

  const contextMenu = (pick: Pick | null, x: number, y: number) => {
    const s = useApp.getState();
    if (s.dialog || s.sketchId) return;
    if (pick && !s.selection.some((p) => samePick(p, pick))) useApp.setState({ selection: [pick] });
    const start = (op: FeatureOp) => () => startFeature(op);
    const fid = pick ? featureOfPick(pick) : null;
    const item = (op: FeatureOp, label?: string) => {
      const Icon = FEATURES[op].icon;
      return { label: label ?? FEATURES[op].label, icon: <Icon />, kbd: FEATURES[op].shortcut, onClick: start(op) };
    };
    const common = [
      ...(fid ? [{ label: t("Edit {feature}", { feature: fid }), icon: <Pencil />, onClick: () => editFeature(fid) }] : []),
      { label: t("Measure"), icon: <Ruler />, kbd: "Shift+M", onClick: () => useApp.setState({ measure: { active: true, picks: pick && (pick.kind === "face" || pick.kind === "edge") ? [pick] : [], result: null } }) },
    ];
    const ground = !pick ? vp?.sceneryHit(x, y) : null;
    if (!pick)
      return showMenu(x, y, [
        ...(ground
          ? [
              { label: t("Mark a line"), icon: <PencilLine />, onClick: () => (startMarking("line", ground.id), addMarkPoint(ground.point)) },
              { label: t("Mark an area"), icon: <Shapes />, onClick: () => (startMarking("area", ground.id), addMarkPoint(ground.point)) },
              { label: t("Highlighter"), icon: <Highlighter />, onClick: () => startMarking("stroke", ground.id) },
              { label: t("Pin a note here"), icon: <StickyNote />, onClick: () => (startMarking("note", ground.id), addMarkPoint(ground.point)) },
              { label: t("Stake-out point here"), icon: <MapPin />, onClick: () => (startMarking("point", ground.id), addMarkPoint(ground.point)) },
              { label: t("Measure from here"), icon: <Ruler />, onClick: () => (useApp.setState({ measure: { active: true, picks: [], result: null } }), clearTerrainMeasure(), measurePoint(ground.point, ground.id)) },
              { label: t("New sketch here on the ground"), icon: <Pencil />, onClick: () => sketchOnTerrain(ground.point) },
              { label: t("Clean up…"), icon: <Eraser />, onClick: () => cleanUpMenu(ground.id, x, y) },
              "sep" as const,
            ]
          : []),
        { label: t("Select all parts"), icon: <BoxSelect />, kbd: "Mod+A", onClick: () => selectAll() },
        ...(hasClip() ? [{ label: t("Paste"), icon: <ClipboardPaste />, kbd: "Mod+V", onClick: () => void pasteParts() }] : []),
        { label: t("Fit view"), icon: <Focus />, kbd: fitKey, onClick: () => vp?.fit() },
        { label: s.showPlanes ? t("Hide planes") : t("Show planes"), icon: <Layers />, onClick: () => useApp.setState({ showPlanes: !s.showPlanes }) },
        { label: t("Show all parts"), icon: <Eye />, onClick: () => useApp.setState({ hidden: new Set() }) },
      ]);
    if (pick.kind === "face" && meshBodyIds(s.doc.features, s.output?.meshes ?? []).has(pick.bodyId)) {
      const m = s.output?.meshes.find((b) => b.bodyId === pick.bodyId);
      if (m) useApp.setState({ selection: m.faceTags.map((tags, face) => ({ kind: "face" as const, bodyId: m.bodyId, face, tags, point: pick.point, normal: null })) });
      return showMenu(x, y, [
        { label: t("Move {part}", { part: partName(pick.bodyId, useApp.getState().doc.features) }), icon: <Move3d />, onClick: () => startFeature("transform") },
        { label: t("Mirror part"), icon: <Copy />, onClick: () => (useApp.setState({ selection: [] }), startFeature("mirror")) },
        { label: t("Hide {part}", { part: partName(pick.bodyId, useApp.getState().doc.features) }), icon: <EyeOff />, onClick: () => toggleHidden(pick.bodyId) },
        { label: t("Copy"), icon: <Copy />, kbd: "Mod+C", onClick: () => copyParts(selectedParts().includes(pick.bodyId) ? selectedParts() : [pick.bodyId]) },
        { label: t("Duplicate"), icon: <CopyPlus />, kbd: "Mod+D", onClick: () => (copyParts(selectedParts().includes(pick.bodyId) ? selectedParts() : [pick.bodyId]), void pasteParts()) },
        ...terrainItems(pick.bodyId, { set: <ArrowDownToLine />, place: <MapPin /> }),
        { label: s.doc.seeThrough?.includes(pick.bodyId) ? t("Show solid") : t("Show see-through"), icon: <Ghost />, onClick: () => toggleSeeThrough(pick.bodyId) },
        { label: t("Material…"), icon: <Weight />, onClick: () => openMaterialPicker(selectedParts().includes(pick.bodyId) ? selectedParts() : [pick.bodyId]) },
        ...textureItems(pick.bodyId),
        "sep" as const,
        printItem(pick.bodyId),
        { label: t("Lay on this face"), icon: <ArrowDownToLine />, onClick: () => layOnFace(pick.bodyId, pick.face, pick.normal ?? pick.surface) },
        { label: t("Gridfinity bin for this part"), icon: <LayoutGrid />, onClick: () => binForPart(pick.bodyId) },
        ...(hasPack("scan")
          ? [
              "sep" as const,
              { label: t("Convert to editable body"), icon: <Shapes />, onClick: () => convertMeshPart(pick.bodyId) },
              { label: t("Rebuild with features"), icon: <Wand2 />, onClick: () => void rebuildMeshPart(pick.bodyId) },
              thicknessItem(pick.bodyId),
              ...(importOf(pick.bodyId) ? [{ label: t("Clean up mesh…"), icon: <Eraser />, onClick: () => openMeshRepair(pick.bodyId) }] : []),
            ]
          : []),
        "sep",
        ...common,
        "sep",
        { label: t("Delete {part}", { part: partName(pick.bodyId, useApp.getState().doc.features) }), icon: <Trash />, danger: true, onClick: () => deleteBodies([pick.bodyId]) },
      ]);
    }
    if (pick.kind === "face")
      return showMenu(x, y, [
        ...(pick.normal ? [{ label: t("New sketch on face"), icon: <Pencil />, kbd: "S", onClick: () => startSketch(planeSpecForPick(pick, s.output?.meshes ?? []) ?? undefined) }] : []),
        item("extrude", t("Push/pull face")),
        item("fillet", t("Fillet face edges")),
        item("chamfer", t("Chamfer face edges")),
        item("shell", t("Shell (remove this face)")),
        ...(!pick.normal ? [item("thread", t("Thread this hole or shaft"))] : []),
        ...(pick.normal ? [{ label: t("Hole here"), icon: <CircleDot />, kbd: "Shift+H", onClick: () => startHoleAt(pick) }] : []),
        "sep",
        { label: t("Hide {part}", { part: partName(pick.bodyId, useApp.getState().doc.features) }), icon: <EyeOff />, onClick: () => toggleHidden(pick.bodyId) },
        { label: t("Copy"), icon: <Copy />, kbd: "Mod+C", onClick: () => copyParts(selectedParts().includes(pick.bodyId) ? selectedParts() : [pick.bodyId]) },
        { label: t("Duplicate"), icon: <CopyPlus />, kbd: "Mod+D", onClick: () => (copyParts(selectedParts().includes(pick.bodyId) ? selectedParts() : [pick.bodyId]), void pasteParts()) },
        ...terrainItems(pick.bodyId, { set: <ArrowDownToLine />, place: <MapPin /> }),
        { label: s.doc.seeThrough?.includes(pick.bodyId) ? t("Show solid") : t("Show see-through"), icon: <Ghost />, onClick: () => toggleSeeThrough(pick.bodyId) },
        { label: t("Material…"), icon: <Weight />, onClick: () => openMaterialPicker(selectedParts().includes(pick.bodyId) ? selectedParts() : [pick.bodyId]) },
        ...textureItems(pick.bodyId),
        { label: t("Mirror part"), icon: <Copy />, onClick: () => (useApp.setState({ selection: [] }), startFeature("mirror")) },
        "sep",
        printItem(pick.bodyId),
        ...(pick.normal ? [{ label: t("Lay on this face"), icon: <ArrowDownToLine />, onClick: () => layOnFace(pick.bodyId, pick.face) }] : []),
        ...(hasPack("scan") ? [...deviationItems(pick.bodyId), thicknessItem(pick.bodyId)] : []),
        ...common,
        "sep",
        { label: useApp.getState().selection.length > 1 ? t("Delete selection") : t("Delete face"), icon: <Trash />, kbd: "⌫", danger: true, onClick: () => void deleteModelSelection() },
        { label: t("Delete {part}", { part: partName(pick.bodyId, useApp.getState().doc.features) }), icon: <Trash />, danger: true, onClick: () => deleteBodies([pick.bodyId]) },
      ]);
    if (pick.kind === "edge") return showMenu(x, y, [item("fillet"), item("chamfer"), "sep", ...common]);
    if (pick.kind === "region" || pick.kind === "sketch_curve")
      return showMenu(x, y, [
        item("extrude"),
        item("revolve"),
        "sep",
        { label: t("Edit sketch {sketch}", { sketch: pick.sketchId }), icon: <Pencil />, onClick: () => editFeature(pick.sketchId) },
        { label: t("Hide sketch"), icon: <EyeOff />, onClick: () => toggleHidden(pick.sketchId) },
      ]);
    if (pick.kind === "plane")
      return showMenu(x, y, [
        { label: t("New sketch on {plane}", { plane: PLANE_LABELS[pick.planeId] ?? pick.planeId }), icon: <Pencil />, onClick: () => startSketch({ ref: pick.planeId }) },
        item("plane", t("Offset plane")),
        ...(pick.planeId.startsWith("origin.") ? [] : [{ label: t("Delete plane"), icon: <Trash />, danger: true, onClick: () => {
          const f = useApp.getState().doc.features.find((x) => x.id === pick.planeId);
          if (f) void deleteFeature(f);
        } }]),
      ]);
  };

  const featureOfPick = (p: Pick): string | null => {
    const docNow = useApp.getState().doc;
    if (p.kind === "region" || p.kind === "sketch_curve") return p.sketchId;
    if (p.kind === "plane") return p.planeId.startsWith("origin.") ? null : p.planeId;
    if (p.kind === "face") {
      // The latest feature that tagged this face is the most specific owner.
      const ids = p.tags.map((t) => t.split(/[.@[]/)[0]!);
      for (let i = docNow.features.length - 1; i >= 0; i--) if (ids.includes(docNow.features[i]!.id)) return docNow.features[i]!.id;
    }
    if (p.kind === "edge" || p.kind === "face") return docNow.features.find((f) => f.id === p.bodyId)?.id ?? null;
    return null;
  };

  return (
    <div className={`view ${dialog?.field || pickingPlane || measure.active || placing ? "picking" : ""}`} ref={host}>
      {vp ? <ViewCube viewport={vp} /> : null}
      {vp ? <Manipulators viewport={vp} /> : null}
      {vp ? <InlineValues viewport={vp} /> : null}
      {vp && sketchId ? <SketchEditor viewport={vp} sketchId={sketchId} /> : null}
      {vp && pickingPlane && scene ? <PlaneChooser viewport={vp} planes={scene.planes} /> : null}
      {vp && marks.labels.length ? <TerrainLabels viewport={vp} labels={marks.labels} /> : null}
      <TerrainHud />
      <AiActivity />
      {box ? (
        <div
          className={`select-box ${box.x1 >= box.x0 ? "enclosed" : "crossing"}`}
          style={{ left: Math.min(box.x0, box.x1), top: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0) }}
        >
          <span>{box.filter === "all" ? t("Faces + edges") : box.filter === "face" ? t("Faces") : t("Edges")} · {box.x1 >= box.x0 ? t("inside") : t("touching")} · F/E/Tab</span>
        </div>
      ) : null}
      {measure.active ? <MeasureCard /> : null}
      {mode === "rendered" && vp ? <RenderBar vp={vp} onExit={() => (vp.setDisplayMode("shaded_edges"), setMode("shaded_edges"))} /> : null}
      <LoadingOverlay />
      <DeviationLegend />
      <ThicknessLegend />
      <PrintCheckCard />
      {layingOnFace ? (
        <div className="terrain-hud" role="status">
          <strong>{t("Lay on a face")}</strong>
          <span className="muted">{touchOnly() ? t("Tap the face that should lie on the plate") : t("Click the face that should lie on the plate")}</span>
          <button className="btn" onClick={() => pickFaceToLay(false)}>
            {t("Cancel")}
          </button>
        </div>
      ) : null}
      <MeshRepairCard />
      <div className="status-pill" title={kernelState.error ?? ""}>
        {slowBuild ? <span className="spinner sm" aria-hidden /> : <span className={`dot ${!kernelState.ready || busy ? "busy" : ""}`} style={kernelState.error ? { background: "var(--err)" } : undefined} />}
        {kernelState.error ?? (!kernelState.ready ? kernelState.info : slowBuild ? t("Rebuilding…") : output ? `${tn(output.report.bodies.length, "{n} part", "{n} parts")} · ${t("rebuild {ms} ms", { ms: output.report.rebuildMs.toFixed(0) })}${previewing ? ` · ${t("preview")}` : ""}${hasTextures && !showTextures ? ` · ${t("pictures hidden")}` : ""}` : t("Ready"))}
      </div>
      <div className="view-controls">
        <SnapControls viewport={vp} />
        <span className="bar-sep" aria-hidden />
        <button className="icon-btn sm" title={withKey(t("Fit all"), fitKey)} onClick={() => vp?.fit()}>
          <Scan />
        </button>
        {/* Phone: the less used view switches share one menu, so the column stays short. */}
        <button
          className="icon-btn sm phone-only"
          title={t("View options")}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const check = (on: boolean) => (on ? "✓ " : "   ");
            const modes: [DisplayMode, string][] = [
              ["shaded_edges", t("Shaded with edges")],
              ["shaded", t("Shaded")],
              ["hidden_line", t("Hidden lines removed")],
              ["xray", t("X-ray")],
              ["wireframe", t("Wireframe")],
              ["rendered", t("Rendered")],
            ];
            showMenu(r.left - 6, r.top, [
              ...modes.map(([m, label]) => ({ label: `${check(vp?.mode === m)}${label}`, onClick: () => (vp?.setDisplayMode(m), setMode(m)) })),
              "sep" as const,
              {
                label: `${check(ortho)}${t("Orthographic")}`,
                onClick: () => {
                  vp?.setProjection(ortho ? "perspective" : "orthographic");
                  setOrtho(!ortho);
                },
              },
              { label: `${check(showPlanes)}${t("Planes")}`, onClick: () => useApp.setState({ showPlanes: !showPlanes }) },
              { label: `${check(showSketches)}${t("Sketches")}`, onClick: () => useApp.setState({ showSketches: !showSketches }) },
              { label: `${check(showValues)}${t("Dimensions on the model")}`, onClick: () => setPrefs({ showValues: !showValues }) },
              { label: `${check(colorParts)}${t("A colour for each part")}`, onClick: () => setPrefs({ colorParts: !colorParts }) },
              ...(hasTextures ? [{ label: `${check(showTextures)}${t("Lithophane pictures")}`, onClick: () => setPrefs({ showTextures: !showTextures }) }] : []),
            ], { alignRight: true });
          }}
        >
          <SlidersHorizontal />
        </button>
        <button
          className={`icon-btn sm phone-hide ${ortho ? "active" : ""}`}
          title={ortho ? t("Orthographic (click for perspective)") : t("Perspective (click for orthographic)")}
          onClick={() => {
            vp?.setProjection(ortho ? "perspective" : "orthographic");
            setOrtho(!ortho);
          }}
        >
          <Box />
        </button>
        <button
          className="icon-btn sm mode-btn phone-hide"
          title={t("Display mode")}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const modes: [DisplayMode, string][] = [
              ["shaded_edges", t("Shaded with edges")],
              ["shaded", t("Shaded")],
              ["hidden_line", t("Hidden lines removed")],
              ["xray", t("X-ray")],
              ["wireframe", t("Wireframe")],
              ["rendered", t("Rendered")],
            ];
            showMenu(r.left, r.top - 6, modes.map(([m, label]) => ({ label: `${vp?.mode === m ? "✓ " : "   "}${label}`, onClick: () => (vp?.setDisplayMode(m), setMode(m)) })), { above: true });
          }}
        >
          <Box /> <span className="mode-label">{MODE_LABEL[mode]}</span>
        </button>
        <button className={`icon-btn sm phone-hide ${showPlanes ? "active" : ""}`} title={t("Planes")} onClick={() => useApp.setState({ showPlanes: !showPlanes })}>
          <Layers />
        </button>
        <button className={`icon-btn sm phone-hide ${showSketches ? "active" : ""}`} title={t("Sketches")} onClick={() => useApp.setState({ showSketches: !showSketches })}>
          <PencilLine />
        </button>
        {/* Textures cost time on every rebuild: hidden, editing a textured part is quicker (exports keep them). */}
        {hasTextures ? (
          <button className={`icon-btn sm phone-hide ${showTextures ? "active" : ""}`} title={showTextures ? t("Hide lithophane pictures while editing (rebuilds faster; exports keep them)") : t("Show lithophane pictures")} onClick={() => setPrefs({ showTextures: !showTextures })}>
            <Waves />
          </button>
        ) : null}
        <button className={`icon-btn sm phone-hide ${showValues ? "active" : ""}`} title={showValues ? t("Hide dimensions on the model") : t("Show dimensions on the model")} onClick={() => setPrefs({ showValues: !showValues })}>
          <Ruler />
        </button>
        <button className={`icon-btn sm phone-hide ${colorParts ? "active" : ""}`} title={colorParts ? t("Parts in one colour") : t("A colour for each part")} onClick={() => setPrefs({ colorParts: !colorParts })}>
          <Palette />
        </button>
      </div>
    </div>
  );
}

const MODE_LABEL: Record<DisplayMode, string> = { shaded_edges: t("Shaded"), shaded: t("Shaded (no edges)"), hidden_line: t("Hidden line"), xray: t("X-ray"), wireframe: t("Wireframe"), rendered: t("Rendered") };

function hiddenOverride(_id: string): boolean {
  return false;
}

function MeasureCard() {
  const m = useApp((s) => s.measure);
  const scan = useScanMeasure();
  return (
    <div className="measure-card">
      <div className="dialog-head">
        <Ruler className="ficon" />
        <h3>{t("Measure")}</h3>
        <button className="icon-btn sm" onClick={() => useApp.setState({ measure: { active: false, picks: [], result: null } })}>
          ×
        </button>
      </div>
      <div className="dialog-body">
        {m.result ? (
          <table>
            <tbody>
              {m.result.rows.map(([k, v]) => (
                <tr key={k}>
                  <td className="muted">{t(k)}</td>
                  <td>{convertMmText(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <span className="muted">{m.picks.length ? t("Measuring…") : (touchOnly() ? t("Tap a face or an edge; a second tap adds another.") : t("Click a face or an edge. Shift-click to add a second one."))}</span>
        )}
        <PartMass picks={m.picks} />
        {scan.shapes.length ? (
          <label className="row" style={{ gap: 6, marginTop: 6 }}>
            <span className="muted">{t("Fit tolerance")}</span>
            <input
              className="field"
              type="number"
              step="0.05"
              min="0.01"
              style={{ width: 72 }}
              defaultValue={scan.tol}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) setScanTolerance(v);
              }}
            />
            <span className="muted">mm</span>
          </label>
        ) : hasPack("scan") && !m.result ? (
          <p className="muted small">{t("On a scan or other mesh, a click fits the plane, cylinder, cone or sphere there; a second click measures between the two.")}</p>
        ) : null}
        {hasTerrain() && !m.result ? <p className="muted small">{touchOnly() ? t("On a terrain, a tap shows where the point is (with GPS when the photos had it); a second tap gives the distance, the height difference, the slope and the direction from north.") : t("On a terrain, a click shows where the point is (with GPS when the photos had it); a second click gives the distance, the height difference, the slope and the direction from north.")}</p> : null}
      </div>
    </div>
  );
}

/** The measured part's volume and, with a material, its mass. */
function PartMass({ picks }: { picks: readonly Pick[] }) {
  const doc = useApp((s) => s.doc);
  const bodies = useApp((s) => s.output?.report.bodies);
  const id = picks.find((p): p is Extract<Pick, { bodyId: string }> => "bodyId" in p)?.bodyId;
  const body = id ? bodies?.find((b) => b.id === id) : undefined;
  if (!body || !Number.isFinite(body.volume)) return null;
  const m = partMaterial(doc, body.id);
  return (
    <p className="small" style={{ margin: "8px 0 0" }}>
      <b>{partName(body.id, doc.features)}</b> · {t("{v} cm³", { v: (body.volume / 1000).toFixed(2) })}
      {m ? ` · ${formatMass(massOf(body.volume, m))} ${materialName(m)}` : <span className="muted"> · {t("no material, so no mass")}</span>}
    </p>
  );
}

function AiActivity() {
  const activity = useApp((s) => (s.aiLock ? null : s.aiActivity));
  const previewing = useApp((s) => !!s.proposalDoc);
  if (!activity && !previewing) return null;
  return (
    <div className="ai-activity">
      <AiOrb busy={!!activity} small />
      {activity ? (
        <span>
          <b>{activity.client}</b> · {toolLabel(activity.tool)}
        </span>
      ) : null}
      {previewing ? (
        <>
          <span className="muted">{t("Preview — not applied")}</span>
          <button
            className="btn"
            style={{ height: 22, padding: "0 8px" }}
            onClick={() => {
              useApp.setState({ proposalDoc: null });
              scheduleRebuild();
            }}
          >
            {t("Dismiss")}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Centered while the geometry engine starts or a project's model is computed for the first time. */
function LoadingOverlay() {
  const kernelState = useApp((s) => s.kernel);
  const hasOutput = useApp((s) => !!s.output);
  const features = useApp((s) => s.doc.features.length);
  const progress = useApp((s) => s.buildProgress);
  const doc = useApp((s) => s.doc);
  const text = kernelState.error ? null : !kernelState.ready && !hasOutput ? t("Starting the geometry engine…") : !hasOutput && features ? tn(features, "Building the model · {n} feature", "Building the model · {n} features") : null;
  if (!text) return null;
  // Which step the first build is at, once the kernel reports it.
  const step = kernelState.ready && progress ? doc.features.find((f) => f.id === progress.feature) : undefined;
  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-card">
        <span className="spinner" aria-hidden />
        <span className="loading-text">
          {text}
          {progress && kernelState.ready ? (
            <>
              <span className="loading-step">{t("{feature} ({n} of {total})", { feature: step ? featureName(step) : progress.feature, n: progress.index + 1, total: progress.total })}</span>
              <span className="task-bar loading-bar">
                <span className="task-fill" style={{ width: `${Math.max(2, (progress.index / Math.max(1, progress.total)) * 100)}%` }} />
              </span>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/** "Deviation from <mesh>" for each mesh part in the model (a scan, the mesh a part was rebuilt from). */
function deviationItems(body: string): { label: string; icon: React.ReactNode; onClick: () => void }[] {
  const s = useApp.getState();
  if (useDeviation.getState().body === body) return [{ label: t("Hide deviation"), icon: <ScanSearch />, onClick: hideDeviation }];
  const meshes = [...meshBodyIds(s.doc.features, s.output?.meshes ?? [])].filter((id) => id !== body);
  return meshes.map((mesh) => ({ label: t("Deviation from {mesh}", { mesh: partName(mesh, s.doc.features) }), icon: <ScanSearch />, onClick: () => (hideThickness(), hidePrintCheck(), showDeviation(body, mesh)) }));
}

function thicknessItem(body: string): { label: string; icon: React.ReactNode; onClick: () => void } {
  if (useThickness.getState().body === body) return { label: t("Hide wall thickness"), icon: <Layers />, onClick: hideThickness };
  return { label: t("Wall thickness"), icon: <Layers />, onClick: () => (hideDeviation(), hidePrintCheck(), showThickness(body)) };
}

function printItem(body: string): { label: string; icon: React.ReactNode; onClick: () => void } {
  if (usePrintCheck.getState().body === body) return { label: t("Hide printability"), icon: <Printer />, onClick: hidePrintCheck };
  return { label: t("Check printability"), icon: <Printer />, onClick: () => (hideDeviation(), hideThickness(), showPrintCheck(body)) };
}

/** Triangles in a binary STL import's file (from its header), 0 when unknown. */
function fileTriangles(body: string): number {
  const f = importOf(body);
  if (!f) return 0;
  const head = Uint8Array.from(atob(f.data.slice(0, 112)), (c) => c.charCodeAt(0));
  return head.length >= 84 ? new DataView(head.buffer).getUint32(80, true) : 0;
}

/** Options for cleaning up a mesh part, and its triangle count now. */
function MeshRepairCard() {
  const r = useMeshRepair();
  const features = useApp((s) => s.doc.features);
  const shown = useApp((s) => (r.body ? s.output?.meshes.find((m) => m.bodyId === r.body) : undefined));
  // A mesh that failed to import (open) has no part: count the file's triangles instead.
  const triangles = shown ? shown.indices.length / 3 : r.body ? fileTriangles(r.body) : 0;
  if (!r.body) return null;
  const check = (key: "removePieces" | "fillHoles" | "reduce", label: string) => (
    <label className="row small" style={{ gap: 6 }}>
      <input type="checkbox" checked={r[key]} onChange={(e) => useMeshRepair.setState({ [key]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
  return (
    <div className="deviation-card" role="dialog">
      <div className="row">
        <Eraser className="ficon" />
        <b>{t("Clean up {part}", { part: partName(r.body, features) })}</b>
        <span className="spacer" />
        <button className="icon-btn sm" title={t("Close")} onClick={closeMeshRepair}>
          <X />
        </button>
      </div>
      {triangles ? <p className="muted small">{tn(triangles, "one::{n} triangle", "{n} triangles")}</p> : null}
      {check("removePieces", t("Remove loose pieces (scan debris)"))}
      {check("fillHoles", t("Close holes"))}
      {check("reduce", t("Fewer triangles"))}
      {r.reduce ? (
        <label className="row small" style={{ gap: 6, paddingLeft: 22 }}>
          <span className="muted">{t("Surface moves at most")}</span>
          <input
            className="field"
            type="number"
            step="0.01"
            min="0.001"
            style={{ width: 64 }}
            defaultValue={r.tolerance}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v > 0) useMeshRepair.setState({ tolerance: v });
            }}
          />
          <span className="muted">mm</span>
        </label>
      ) : null}
      <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
        <button className="btn" onClick={closeMeshRepair}>
          {t("Cancel")}
        </button>
        <button className="btn primary" disabled={!r.removePieces && !r.fillHoles && !r.reduce} onClick={() => void runMeshRepair()}>
          {t("Clean up")}
        </button>
      </div>
    </div>
  );
}

/** Scale, thinnest spot and the minimum wall of the thickness map. */
function ThicknessLegend() {
  const { body, stats, error, minWall } = useThickness();
  const features = useApp((s) => s.doc.features);
  if (!body) return null;
  return (
    <div className="deviation-card" role="status">
      <div className="row">
        <Layers className="ficon" />
        <b>{t("Wall thickness of {part}", { part: partName(body, features) })}</b>
        <span className="spacer" />
        <button className="icon-btn sm" title={t("Close")} onClick={hideThickness}>
          <X />
        </button>
      </div>
      {error ? (
        <p className="muted small">{t("The part is not in the model any more.")}</p>
      ) : (
        <>
          <div className="deviation-scale" style={{ background: THICKNESS_GRADIENT }} />
          <div className="deviation-ticks">
            <span>{convertMmText(`${minWall} mm`)}</span>
            <span>{convertMmText(`${minWall * 2} mm`)}</span>
            <span>{convertMmText(`${minWall * 3} mm`)}</span>
          </div>
          <label className="row small" style={{ gap: 6 }}>
            <span className="muted">{t("Thinnest wall allowed")}</span>
            <input
              className="field"
              type="number"
              step="0.1"
              min="0.1"
              style={{ width: 64 }}
              defaultValue={minWall}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) setMinWall(v);
              }}
            />
            <span className="muted">mm</span>
          </label>
          {stats ? (
            <p className="small">
              {Number.isFinite(stats.min)
                ? t("Thinnest: {min} · {share} % of the surface below {wall}", { min: convertMmText(`${stats.min.toFixed(2)} mm`), share: Math.round(stats.thin * 100), wall: convertMmText(`${stats.minWall} mm`) })
                : t("No wall could be measured: the mesh is open.")}
            </p>
          ) : (
            <p className="muted small">{t("Measuring the wall thickness")}</p>
          )}
          <p className="muted small">{t("Red: thinner than allowed · green: three times as thick or more · grey: not measured (open mesh).")}</p>
        </>
      )}
    </div>
  );
}

/** Colours, overhang limit, support estimate and the best way up of the printability map. */
function PrintCheckCard() {
  const { body, stats, error, limit, picking } = usePrintCheck();
  const features = useApp((s) => s.doc.features);
  if (!body) return null;
  const cm2 = (mm2: number) => `${(mm2 / 100).toFixed(mm2 < 1000 ? 1 : 0)} cm²`;
  const cm3 = (mm3: number) => `${(mm3 / 1000).toFixed(mm3 < 10_000 ? 1 : 0)} cm³`;
  const swatch = (color: string, label: string) => (
    <span className="row small" style={{ gap: 4 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: "inline-block" }} />
      {label}
    </span>
  );
  return (
    <div className="deviation-card" role="status">
      <div className="row">
        <Printer className="ficon" />
        <b>{t("Printability of {part}", { part: partName(body, features) })}</b>
        <span className="spacer" />
        <button className="icon-btn sm" title={t("Close")} onClick={hidePrintCheck}>
          <X />
        </button>
      </div>
      {error ? (
        <p className="muted small">{t("The part is not in the model any more.")}</p>
      ) : (
        <>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            {swatch(PRINT_COLORS.overhang, t("Needs support"))}
            {swatch(PRINT_COLORS.ok, t("Prints without"))}
            {swatch(PRINT_COLORS.plate, t("On the plate"))}
          </div>
          <label className="row small" style={{ gap: 6 }}>
            <span className="muted">{t("Steepest overhang without support")}</span>
            <input
              className="field"
              type="number"
              step="5"
              min="0"
              max="89"
              style={{ width: 56 }}
              defaultValue={limit}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0 && v < 90) setOverhangLimit(v);
              }}
            />
            <span className="muted">°</span>
          </label>
          {stats ? (
            <>
              <p className="small">
                {stats.overhangArea > 0.5
                  ? t("Overhang: {area} ({share} % of the surface) · support about {volume}", { area: convertMmText(cm2(stats.overhangArea)), share: Math.max(1, Math.round(stats.overhangShare * 100)), volume: convertMmText(cm3(stats.supportVolume)) })
                  : t("No overhangs: prints without support as it stands.")}
              </p>
              {stats.best ? (
                <p className="small">
                  {stats.best.supportVolume < 1
                    ? t("Turned another way up it prints without support.")
                    : t("Turned another way up: support about {volume}.", { volume: convertMmText(cm3(stats.best.supportVolume)) })}
                </p>
              ) : null}
              <div className="row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button className={`btn ${picking ? "primary" : ""}`} onClick={() => pickFaceToLay(!picking)}>
                  {t("Lay on a face…")}
                </button>
                {stats.best ? (
                  <button className="btn primary" onClick={() => printBestWayUp(body)}>
                    {t("Turn the best way up")}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="muted small">{t("Checking printability")}</p>
          )}
        </>
      )}
    </div>
  );
}

/** Scale and numbers of the deviation map. */
function DeviationLegend() {
  const { body, mesh, stats, error } = useDeviation();
  const features = useApp((s) => s.doc.features);
  if (!body || !mesh) return null;
  const mm = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)} mm`;
  return (
    <div className="deviation-card" role="status">
      <div className="row">
        <ScanSearch className="ficon" />
        <b>{t("Deviation from {mesh}", { mesh: partName(mesh, features) })}</b>
        <span className="spacer" />
        <button className="icon-btn sm" title={t("Close")} onClick={hideDeviation}>
          <X />
        </button>
      </div>
      {error || !stats ? (
        <p className="muted small">{t("The part or the mesh is not in the model any more.")}</p>
      ) : (
        <>
          <div className="deviation-scale" style={{ background: DEVIATION_GRADIENT }} />
          <div className="deviation-ticks">
            <span>{mm(-stats.range)}</span>
            <span>0</span>
            <span>{mm(stats.range)}</span>
          </div>
          <p className="muted small">{t("Blue: smaller than the mesh · red: bigger.")}</p>
          <p className="small">
            {t("{share} % within ±{tol} mm · from {min} to {max}", { share: Math.round(stats.within * 100), tol: stats.tolerance, min: mm(stats.min), max: mm(stats.max) })}
          </p>
          <p className="muted small">{t("Part {part}", { part: partName(body, features) })}</p>
        </>
      )}
    </div>
  );
}

/** The switch for a scan's picture, for the part menus. */
function textureItems(bodyId: string) {
  const sw = textureToggle(bodyId);
  return sw ? [{ label: sw.label, icon: sw.shown ? <ImageOff /> : <PictureIcon />, onClick: sw.onClick }] : [];
}
