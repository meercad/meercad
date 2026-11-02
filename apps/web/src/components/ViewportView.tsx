import { currentPoses, jointPick, partDrag, useMotion } from "../lib/mechanism";
import { partColors } from "../lib/partColors";
import { motion } from "@meercad/model";
import { DEVIATION_GRADIENT, hideDeviation, showDeviation, useDeviation } from "../lib/deviation";
import { hasPack } from "../lib/premium";
import { clearScanMeasure, measureOnScan, scanOf, setScanTolerance, useScanMeasure } from "../lib/scanMeasure";
import { Box, CircleDot, Copy, Eye, EyeOff, Focus, Ghost, Layers, Move3d, Palette, Pencil, PencilLine, Ruler, Scan, ScanSearch, Shapes, SlidersHorizontal, Trash, Wand2, X } from "lucide-react";
import { convertMeshPart, rebuildMeshPart } from "../lib/meshConvert";
import { useEffect, useMemo, useRef, useState } from "react";
import { deleteBodies, deleteModelSelection } from "../lib/deletion";
import { navigationFor, setPrefs, useKey, usePrefs } from "../lib/keymap";
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
import { t, tn } from "../lib/i18n";

/** Dialog fields that take whole parts, so a click on a mesh part may fill them. */
const PART_FIELDS = new Set(["targets", "target", "tools", "bodies", "source", "body"]);
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

export function ViewportView() {
  const host = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<Viewport | null>(null);
  const fitKey = useKey("fit");
  const output = useApp((s) => s.output);
  const hidden = useApp((s) => s.hidden);
  const showPlanes = useApp((s) => s.showPlanes);
  const showSketches = useApp((s) => s.showSketches);
  const showValues = usePrefs((s) => s.showValues);
  const colorParts = usePrefs((s) => s.colorParts);
  const sketchId = useApp((s) => s.sketchId);
  const dialog = useApp((s) => s.dialog);
  const selection = useApp((s) => s.selection);
  const measure = useApp((s) => s.measure);
  const pickingPlane = useApp((s) => s.pickingSketchPlane);
  const doc = useApp((s) => s.doc);
  // Deviation from a mesh as a colour map on the part.
  const heat = useDeviation((s) => s.maps);
  useEffect(() => vp?.setBodyHeat(heat), [vp, heat]);
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
    setVp(v);
    setViewport(v);
    const applyNav = () => {
      const p = usePrefs.getState();
      v.setNavigation(navigationFor(p.mouse), p.invertZoom);
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
  useEffect(() => {
    if (!vp) return;
    vp.partDrag = motionOpen && !dialog ? partDrag : null;
    vp.setPoses(currentPoses());
  }, [vp, motionOpen, motionFree, motionTick, output, doc.mechanism, dialog]);
  // Joint symbols while the joints panel is open; the one being edited stands out.
  const motionDraft = useMotion((s) => s.draft);
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
  }, [vp, motionOpen, output, doc.mechanism, motionDraft?.joint.id]);
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
        if (gesture === "tap") onClick(vp.pick(e.clientX, e.clientY, kinds()), true);
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
      if (d.button === 2) return contextMenu(pick, e.clientX, e.clientY);
      if (d.button === 0) onClick(pick, e.shiftKey || e.metaKey || e.ctrlKey || e.pointerType === "pen");
    };
    const onDbl = (e: MouseEvent) => {
      if (useApp.getState().sketchId || useApp.getState().dialog) return;
      const pick = vp.pick(e.clientX, e.clientY, DEFAULT_KINDS);
      // Double-clicking a face selects its whole part; other entities open their feature.
      if (pick?.kind === "face") {
        const m = useApp.getState().output?.meshes.find((x) => x.bodyId === pick.bodyId);
        if (m) {
          const faces = m.faceTags.map((tags, face) => ({ kind: "face" as const, bodyId: m.bodyId, face, tags, point: pick.point, normal: null }));
          useApp.setState({ selection: faces, selectedFeature: null });
        }
        return;
      }
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

  const onClick = (pick: Pick | null, additive: boolean) => {
    const s = useApp.getState();
    if (!s.dialog && jointPick(pick)) return;
    if (s.pickingSketchPlane) {
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
    if (!pick)
      return showMenu(x, y, [
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
        { label: s.doc.seeThrough?.includes(pick.bodyId) ? t("Show solid") : t("Show see-through"), icon: <Ghost />, onClick: () => toggleSeeThrough(pick.bodyId) },
        ...(hasPack("scan")
          ? [
              "sep" as const,
              { label: t("Convert to editable body"), icon: <Shapes />, onClick: () => convertMeshPart(pick.bodyId) },
              { label: t("Rebuild with features"), icon: <Wand2 />, onClick: () => void rebuildMeshPart(pick.bodyId) },
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
        { label: s.doc.seeThrough?.includes(pick.bodyId) ? t("Show solid") : t("Show see-through"), icon: <Ghost />, onClick: () => toggleSeeThrough(pick.bodyId) },
        { label: t("Mirror part"), icon: <Copy />, onClick: () => (useApp.setState({ selection: [] }), startFeature("mirror")) },
        ...(hasPack("scan") ? deviationItems(pick.bodyId) : []),
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
    <div className={`view ${dialog?.field || pickingPlane || measure.active ? "picking" : ""}`} ref={host}>
      {vp ? <ViewCube viewport={vp} /> : null}
      {vp ? <Manipulators viewport={vp} /> : null}
      {vp ? <InlineValues viewport={vp} /> : null}
      {vp && sketchId ? <SketchEditor viewport={vp} sketchId={sketchId} /> : null}
      {vp && pickingPlane && scene ? <PlaneChooser viewport={vp} planes={scene.planes} /> : null}
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
      <LoadingOverlay />
      <DeviationLegend />
      <div className="status-pill" title={kernelState.error ?? ""}>
        {slowBuild ? <span className="spinner sm" aria-hidden /> : <span className={`dot ${!kernelState.ready || busy ? "busy" : ""}`} style={kernelState.error ? { background: "var(--err)" } : undefined} />}
        {kernelState.error ?? (!kernelState.ready ? kernelState.info : slowBuild ? t("Rebuilding…") : output ? `${tn(output.report.bodies.length, "{n} part", "{n} parts")} · ${t("rebuild {ms} ms", { ms: output.report.rebuildMs.toFixed(0) })}${previewing ? ` · ${t("preview")}` : ""}` : t("Ready"))}
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
            ];
            showMenu(r.left - 220, r.top, [
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
            ]);
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

const MODE_LABEL: Record<DisplayMode, string> = { shaded_edges: t("Shaded"), shaded: t("Shaded (no edges)"), hidden_line: t("Hidden line"), xray: t("X-ray"), wireframe: t("Wireframe") };

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
          <span className="muted">{m.picks.length ? t("Measuring…") : t("Click a face or an edge. Shift-click to add a second one.")}</span>
        )}
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
      </div>
    </div>
  );
}

function AiActivity() {
  const activity = useApp((s) => s.aiActivity);
  const previewing = useApp((s) => !!s.proposalDoc);
  if (!activity && !previewing) return null;
  return (
    <div className="ai-activity">
      <span className="pulse" />
      {activity ? (
        <span>
          <b>{activity.client}</b> · {activity.tool.replace(/_/g, " ")}
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
  const text = kernelState.error ? null : !kernelState.ready ? t("Starting the geometry engine…") : !hasOutput && features ? tn(features, "Building the model · {n} feature", "Building the model · {n} features") : null;
  if (!text) return null;
  // Which step the first build is at, once the kernel reports it.
  const step = kernelState.ready && progress ? doc.features.find((f) => f.id === progress.feature) : undefined;
  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-card">
        <span className="spinner" aria-hidden />
        <span>
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
  return meshes.map((mesh) => ({ label: t("Deviation from {mesh}", { mesh: partName(mesh, s.doc.features) }), icon: <ScanSearch />, onClick: () => showDeviation(body, mesh) }));
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
