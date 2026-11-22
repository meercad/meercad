/**
 * The 3D view's effects, one hook per thing it keeps in step with the app: the viewport itself, the
 * colour maps, the terrain, scans, part colours, the scene, the phone sheets, moving parts, joints and
 * the view switches. ViewportView calls them in a fixed order, which is the order the effects run in.
 */
import type { RebuildOutput } from "@meercad/kernel/client";
import type { MeercadDocument } from "@meercad/schema";
import { THREE, Viewport, type SceneData } from "@meercad/viewport";
import { useEffect, useMemo, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { hasBeta, useBeta } from "../../lib/beta";
import { useDeviation } from "../../lib/deviation";
import { useStrength } from "../../lib/strength";
import { dragStep, gridLevels } from "../../lib/grid";
import { t } from "../../lib/i18n";
import { navigationFor, usePrefs } from "../../lib/keymap";
import { isCompact, usePhoneSheets } from "../../lib/layout";
import { partLooks } from "../../lib/materials";
import { currentPoses, joinedParts, partDrag, useMotion } from "../../lib/mechanism";
import { meshBodyIds } from "../../lib/meshParts";
import { bodyTextures } from "../../lib/meshTexture";
import { partColors } from "../../lib/partColors";
import { usePrintCheck } from "../../lib/printability";
import { scanOf, useScanMeasure } from "../../lib/scanMeasure";
import { sceneryOf, useTerrainPlace } from "../../lib/terrain";
import {
  beginStroke,
  clearTerrainMeasure,
  endStroke,
  extendStroke,
  marksForView,
  useTerrainDraw,
  useTerrainMeasure,
} from "../../lib/terrainDraw";
import { useThickness } from "../../lib/thickness";
import { docUnit } from "../../lib/units";
import { setViewport, useApp, type DialogState } from "../../store";
import { ViewPointer, type SelectionBox } from "./pointer";
import { EMPTY_SCENE, jointGlyphsFor, sceneFor } from "./scene";

type View = Viewport | null;

const NO_HITS: [string, string][] = [];
const NO_PARTS: string[] = [];
/** Parts that run into each other, or cannot move further, show in this colour. */
const HIT_COLOR = "#d93f3f";
/** A rebuild that takes longer than this (ms) says so in the status line. */
const SLOW_BUILD_MS = 700;
/** The status dot shows busy this long (ms) after each new model. */
const BUSY_BLINK_MS = 150;
/** Phone sheets slide in for about this long (ms); the inset is measured again after it. */
const SHEET_SLIDE_MS = 260;
/** Without the design grid, drag arrows move freely in steps this fine (mm). */
const FREE_DRAG_STEP = 0.01;

/** Creates the viewport in `host`, follows the navigation preferences, and disposes of it on unmount. */
export function useCreateViewport(
  host: RefObject<HTMLDivElement | null>,
  setVp: Dispatch<SetStateAction<Viewport | null>>,
): void {
  useEffect(() => {
    const viewport = new Viewport(host.current!);
    // With the topology beta on, imported meshes (its suggestions too) are shaded smooth.
    viewport.smoothMeshes = hasBeta("topology");

    const offBeta = useBeta.subscribe(() => (viewport.smoothMeshes = hasBeta("topology")));
    // Named for screen readers (and the touch tests, which aim gestures with several fingers at it).
    viewport.renderer.domElement.setAttribute("role", "img");
    viewport.renderer.domElement.setAttribute("aria-label", t("3D view"));
    setVp(viewport);
    setViewport(viewport);

    const applyNav = () => {
      const prefs = usePrefs.getState();
      viewport.setNavigation(navigationFor(prefs.mouse), prefs.invertZoom, prefs.swipeRotates);
      // The grid button shows the grid and snaps to it; off, it is hidden and nothing snaps to it.
      viewport.setGridVisible(prefs.snapGrid);
      viewport.invalidate();
    };

    // The grid follows the zoom in the design's unit. Drag arrows move in finer round steps (not the
    // grid's), or freely with the grid off.
    viewport.gridSteps = (pixel) => gridLevels(pixel, docUnit());

    viewport.handleStep = (pixel) => {
      const prefs = usePrefs.getState();

      return prefs.snapGrid ? dragStep(pixel, docUnit()) : FREE_DRAG_STEP;
    };

    applyNav();

    const offPrefs = usePrefs.subscribe(applyNav);

    return () => {
      offBeta();
      offPrefs();
      setViewport(null);
      viewport.dispose();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** The strength, printability, wall thickness or deviation map on the part, in that order of precedence. */
export function useAnalysisMaps(viewport: View): void {
  const heat = useDeviation((s) => s.maps);
  const wall = useThickness((s) => s.maps);
  const print = usePrintCheck((s) => s.maps);
  const strength = useStrength((s) => s.maps);
  useEffect(
    () => viewport?.setBodyHeat(strength.size ? strength : print.size ? print : wall.size ? wall : heat),
    [viewport, heat, wall, print, strength],
  );
}

/**
 * Reference models (an area from drone photos) around the design. Returns a counter that goes up each
 * time they have loaded.
 */
export function useScenery(viewport: View, doc: MeercadDocument): number {
  const references = doc.references;
  const [sceneryReady, setSceneryReady] = useState(0);
  useEffect(
    () =>
      void viewport?.setScenery(sceneryOf({ ...doc, references })).then(() => setSceneryReady((n) => n + 1)),
    [viewport, references],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  return sceneryReady;
}

/**
 * The highlighter: a press on the ground paints until it comes up (mouse, finger or Pencil). It takes
 * the pointer before the view's own handling, so painting never turns the view. Returns what is being
 * drawn on the terrain.
 */
export function useHighlighter(
  viewport: View,
  host: RefObject<HTMLDivElement | null>,
): ReturnType<typeof useTerrainDraw.getState> {
  const drawing = useTerrainDraw();
  const painting = drawing.kind === "stroke" || drawing.kind === "erase";
  useEffect(() => {
    const element = host.current;
    if (!viewport || !element || !painting) return;

    return listenForStrokes(viewport, element);
  }, [viewport, painting]); // eslint-disable-line react-hooks/exhaustive-deps

  return drawing;
}

/** Paints strokes on the ground under presses on the canvas; returns the function that stops it. */
function listenForStrokes(viewport: Viewport, element: HTMLDivElement): () => void {
  let active: number | null = null;

  const down = (event: PointerEvent) => {
    if (
      active !== null ||
      event.target !== viewport.canvas ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }

    const hit = viewport.sceneryHit(event.clientX, event.clientY);
    if (!hit) return;

    event.stopPropagation();
    event.preventDefault();
    active = event.pointerId;

    try {
      viewport.canvas.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser no longer knows: the stroke still follows it while over the view.
    }

    beginStroke(hit.point, hit.id);
  };

  const move = (event: PointerEvent) => {
    if (event.pointerId !== active) return;

    event.stopPropagation();

    const hit = viewport.sceneryHit(event.clientX, event.clientY);
    if (hit) extendStroke(hit.point);
  };

  const up = (event: PointerEvent) => {
    if (event.pointerId !== active) return;

    event.stopPropagation();
    active = null;
    endStroke();
  };

  element.addEventListener("pointerdown", down, true);
  element.addEventListener("pointermove", move, true);
  element.addEventListener("pointerup", up, true);
  element.addEventListener("pointercancel", up, true);

  return () => {
    element.removeEventListener("pointerdown", down, true);
    element.removeEventListener("pointermove", move, true);
    element.removeEventListener("pointerup", up, true);
    element.removeEventListener("pointercancel", up, true);
  };
}

/**
 * Lines, areas and notes on the terrain, with the one being drawn; a terrain measurement left over when
 * the Measure tool closes is cleared. Returns the labels to show over the view.
 */
export function useTerrainMarks(
  viewport: View,
  references: MeercadDocument["references"],
  drawing: ReturnType<typeof useTerrainDraw.getState>,
  measuring: boolean,
  sceneryReady: number,
): ReturnType<typeof marksForView> {
  const terrainMeasure = useTerrainMeasure();
  useEffect(() => {
    if (!measuring && !terrainMeasure.scale && terrainMeasure.points.length) clearTerrainMeasure();
  }, [measuring, terrainMeasure]);

  const marks = useMemo(
    () => (viewport ? marksForView(references, drawing) : { lines: [], labels: [] }),
    [viewport, references, drawing, terrainMeasure, sceneryReady],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => viewport?.setSceneryMarks(marks.lines), [viewport, marks]);

  return marks;
}

/** Shapes fitted on a scan in the Measure tool, laid over the triangles they cover. */
export function useScanShapes(viewport: View): void {
  const scanShapes = useScanMeasure((s) => s.shapes);
  useEffect(() => {
    if (!viewport || !scanShapes.length) return;

    const group = scanShapeGroup(scanShapes);
    viewport.overlay.add(group);
    viewport.invalidate();

    return () => {
      viewport.overlay.remove(group);
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      viewport.invalidate();
    };
  }, [viewport, scanShapes]);
}

/** The first fitted shape in orange, the others in blue, see-through over the scan. */
function scanShapeGroup(scanShapes: ReturnType<typeof useScanMeasure.getState>["shapes"]): THREE.Group {
  const group = new THREE.Group();
  scanShapes.forEach(({ bodyId, shape }, i) => {
    const mesh = scanOf(bodyId);
    if (!mesh) return;

    const pos = new Float32Array(shape.triangles.length * 9);
    shape.triangles.forEach((tri, k) => {
      for (let c = 0; c < 3; c++) {
        pos.set(
          mesh.positions.subarray(mesh.triangles[tri * 3 + c]! * 3, mesh.triangles[tri * 3 + c]! * 3 + 3),
          k * 9 + c * 3,
        );
      }
    });

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));

    const mat = new THREE.MeshBasicMaterial({
      color: i ? 0x2e7dff : 0xff7a1a,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    group.add(new THREE.Mesh(g, mat));
  });

  return group;
}

/**
 * Part colours and finishes. Parts that run into each other while the joints panel is open show red; so
 * do parts that cannot move further this way (links in line, a joint at its limit). Materials give parts
 * their finish (PBR).
 */
export function usePartLooks(
  viewport: View,
  doc: MeercadDocument,
  output: RebuildOutput | null,
  colorParts: boolean,
): void {
  const hits = useMotion((s) => (s.open ? s.hits : NO_HITS));
  const blocked = useMotion((s) => (s.open ? s.blocked : NO_PARTS));
  useEffect(() => {
    if (!viewport) return;

    const colors = partColors(doc, output?.report.bodies.map((b) => b.id) ?? [], colorParts);
    const red = [...hits.flat(), ...blocked];
    viewport.setBodyColors(
      red.length ? new Map([...colors, ...red.map((id): [string, string] => [id, HIT_COLOR])]) : colors,
    );
  }, [viewport, doc, output, colorParts, hits, blocked]);
  useEffect(() => {
    if (!viewport) return;

    viewport.setBodyLooks(partLooks(doc, output?.report.bodies.map((b) => b.id) ?? []));
  }, [viewport, doc, output]);
}

/** Grid contrast follows the light/dark theme. */
export function useThemeContrast(viewport: View): void {
  useEffect(() => {
    if (!viewport) return;

    const apply = () => {
      const t = document.documentElement.dataset["theme"];
      viewport.setDark(t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
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
  }, [viewport]);
}

/** Rebuilds that take a noticeable moment say so in the status line. */
export function useSlowBuild(): boolean {
  const building = useApp((state) => state.building);
  const [slowBuild, setSlowBuild] = useState(false);
  useEffect(() => {
    if (!building) return setSlowBuild(false);

    const t = setTimeout(() => setSlowBuild(true), SLOW_BUILD_MS);

    return () => clearTimeout(t);
  }, [building]);

  return slowBuild;
}

/** True for a moment after each new model, so the status dot blinks. */
export function useBusyBlink(output: RebuildOutput | null): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setBusy(true);

    const t = setTimeout(() => setBusy(false), BUSY_BLINK_MS);

    return () => clearTimeout(t);
  }, [output]);

  return busy;
}

/** The grid is laid out in the design's unit. */
export function useGridUnit(viewport: View): void {
  const designUnits = useApp((state) => state.doc.units);
  useEffect(() => viewport?.invalidate(), [viewport, designUnits]);
}

/**
 * The scene from the rebuild, with mesh parts lit as a whole and scanned parts wearing their picture
 * (unless it is switched off on the part).
 */
export function useScene(
  viewport: View,
  output: RebuildOutput | null,
  doc: MeercadDocument,
  hidden: Set<string>,
  sketchId: string | null,
  dialog: DialogState | null,
): SceneData | null {
  const dialogOp = dialog?.feature.op;
  const scene = useMemo<SceneData | null>(
    () => (output ? sceneFor(output, doc, hidden, sketchId, dialogOp ?? "") : null),
    [output, hidden, sketchId, doc.features, doc.seeThrough, dialogOp],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // No model yet (a project is opening): clear the view instead of showing the previous one.
    if (!viewport) return;

    const state = useApp.getState();
    // Mesh parts light up as a whole on hover and selection.
    viewport.setWholeBodies(meshBodyIds(state.doc.features, state.output?.meshes ?? []));
    viewport.setScene(scene ?? EMPTY_SCENE);
    if (!scene) viewport.resetFraming();
  }, [viewport, scene]);
  useEffect(
    () => viewport?.setBodyTextures(bodyTextures(doc.features, output?.meshes ?? [])),
    [viewport, doc.features, output],
  );

  return scene;
}

/** Phone: sheets cover the lower part of the view; the model centres in the space above them. */
export function usePhoneInset(
  viewport: View,
  dialog: DialogState | null,
  measuring: boolean,
  sketchId: string | null,
): void {
  const motionOpen = useMotion((s) => s.open);
  const sideOpen = useApp((state) => state.sideOpen);
  const phoneConstraints = usePhoneSheets((s) => s.constraints);
  useEffect(() => {
    if (!viewport) return;

    const sheets = () => [
      ...document.querySelectorAll<HTMLElement>(".dialog, .measure-card, .side, .constraint-palette.open"),
    ];

    const update = () => {
      if (!isCompact()) return viewport.setBottomInset(0);

      const box = viewport.canvas.getBoundingClientRect();
      const top = Math.min(box.bottom, ...sheets().map((element) => element.getBoundingClientRect().top));
      viewport.setBottomInset(Math.max(0, box.bottom - top));
    };

    const observer = new ResizeObserver(update);
    sheets().forEach((element) => observer.observe(element));
    update();

    // Sheets slide in: measure again once they have arrived.
    const t = window.setTimeout(update, SHEET_SLIDE_MS);
    window.addEventListener("resize", update);

    return () => {
      observer.disconnect();
      window.clearTimeout(t);
      window.removeEventListener("resize", update);
    };
  }, [viewport, dialog, measuring, sideOpen, sketchId, phoneConstraints, motionOpen]);
}

/**
 * Moving parts: poses from the joint values; parts can be dragged while the joints panel is open. A part
 * being set onto the terrain shows where it would stand.
 */
export function usePoses(
  viewport: View,
  output: RebuildOutput | null,
  mechanism: MeercadDocument["mechanism"],
  dialog: DialogState | null,
): void {
  const motionOpen = useMotion((s) => s.open);
  const motionFree = useMotion((s) => s.free);
  const motionTick = useMotion((s) => s.tick);
  const placeMove = useTerrainPlace((s) => s.move);
  const placeBody = useTerrainPlace((s) => s.body);
  useEffect(() => {
    if (!viewport) return;

    viewport.partDrag = motionOpen && !dialog ? partDrag : null;

    const poses = currentPoses();

    if (placeBody && placeMove) {
      for (const id of joinedParts(placeBody)) {
        poses.set(id, new THREE.Matrix4().makeTranslation(...placeMove).toArray());
      }
    }

    viewport.setPoses(poses);
  }, [viewport, motionOpen, motionFree, motionTick, output, mechanism, dialog, placeBody, placeMove]);
}

/** Joint symbols while the joints panel is open (see jointGlyphsFor). */
export function useJointGlyphs(
  viewport: View,
  output: RebuildOutput | null,
  mechanism: MeercadDocument["mechanism"],
): void {
  const motionOpen = useMotion((s) => s.open);
  const motionDraft = useMotion((s) => s.draft);
  const showJoints = usePrefs((prefs) => prefs.showJoints);
  useEffect(() => {
    if (!viewport) return;

    viewport.setJointGlyphs(
      motionOpen
        ? jointGlyphsFor(
            mechanism?.joints ?? [],
            output?.report.joints ?? [],
            motionDraft?.joint.id,
            showJoints,
          )
        : [],
    );
  }, [viewport, motionOpen, output, mechanism, motionDraft?.joint.id, showJoints]);
}

/**
 * What the view shows besides the parts: planes (always while a plane is to be picked, and while nothing
 * is modelled yet), sketches, the selection or the measured picks, and whether a finger draws.
 */
export function useViewFlags(
  viewport: View,
  output: RebuildOutput | null,
  sketchId: string | null,
  dialog: DialogState | null,
): void {
  const showPlanes = useApp((state) => state.showPlanes);
  const showSketches = useApp((state) => state.showSketches);
  const pickingPlane = useApp((state) => state.pickingSketchPlane);
  const selection = useApp((state) => state.selection);
  const measure = useApp((state) => state.measure);
  const hasBodies = !!output?.report.bodies.length;
  const planeField = dialog?.field === "plane" || dialog?.field === "base";
  useEffect(
    () => viewport?.setPlanesVisible(!sketchId && (showPlanes || !hasBodies || pickingPlane || planeField)),
    [viewport, sketchId, showPlanes, hasBodies, pickingPlane, dialog?.field],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => viewport?.setPlaneEmphasis(pickingPlane || planeField),
    [viewport, pickingPlane, dialog?.field],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => viewport?.setSketchesVisible(showSketches), [viewport, showSketches]);
  useEffect(() => viewport?.setFingerDraws(!!sketchId), [viewport, sketchId]);
  useEffect(() => {
    if (!viewport) return;

    viewport.setSelection(measure.active ? measure.picks : selection);
  }, [viewport, selection, measure]);
}

/** Mouse, touch and pen input on the view (see ViewPointer). */
export function useViewPointer(
  viewport: View,
  boxRef: { readonly current: SelectionBox | null },
  setBox: Dispatch<SetStateAction<SelectionBox | null>>,
): void {
  useEffect(() => {
    if (!viewport) return;

    return new ViewPointer(viewport, boxRef, setBox).attach();
  }, [viewport]); // eslint-disable-line react-hooks/exhaustive-deps
}
