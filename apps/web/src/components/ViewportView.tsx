/**
 * The 3D view: the viewport kept in step with the app (hooks in viewport/hooks.ts, in the order their
 * effects run), its input (viewport/pointer.ts, click.ts, contextMenu.tsx) and what lies over it.
 */
import { useStrength, viewedScene } from "../lib/strength";
import { StrengthCard } from "./StrengthCard";
import type { DisplayMode, Viewport } from "@meercad/viewport";
import { useMemo, useRef, useState } from "react";
import { useKey, usePrefs } from "../lib/keymap";
import { usePrintCheck } from "../lib/printability";
import { useTerrainPlace } from "../lib/terrain";
import { SketchEditor } from "../sketch/SketchEditor";
import { useApp } from "../store";
import { InlineValues } from "./InlineValues";
import { Manipulators } from "./Manipulators";
import { PlaneChooser } from "./PlaneChooser";
import { RenderBar } from "./RenderBar";
import { TerrainHud, TerrainLabels } from "./TerrainTools";
import { ViewCube } from "./ViewCube";
import {
  AiActivity,
  DeviationLegend,
  LoadingOverlay,
  MeasureCard,
  MeshRepairCard,
  PrintCheckCard,
  ThicknessLegend,
} from "./viewport/cards";
import {
  useAnalysisMaps,
  useCreateViewport,
  useGridUnit,
  useHighlighter,
  useJointGlyphs,
  usePartLooks,
  usePhoneInset,
  usePoses,
  useScanShapes,
  useScene,
  useScenery,
  useTerrainMarks,
  useThemeContrast,
  useViewFlags,
  useViewPointer,
} from "./viewport/hooks";
import type { SelectionBox } from "./viewport/pointer";
import { LayOnFaceHud, SelectBoxOverlay, StatusPill, ViewControls } from "./viewport/ViewControls";

export function ViewportView() {
  const host = useRef<HTMLDivElement>(null);
  const [viewport, setVp] = useState<Viewport | null>(null);
  const fitKey = useKey("fit");
  const output = useApp((state) => state.output);
  const hidden = useApp((state) => state.hidden);
  const colorParts = usePrefs((prefs) => prefs.colorParts);
  const sketchId = useApp((state) => state.sketchId);
  const dialog = useApp((state) => state.dialog);
  const measure = useApp((state) => state.measure);
  const pickingPlane = useApp((state) => state.pickingSketchPlane);
  const placing = useTerrainPlace((s) => !!s.body) || usePrintCheck((s) => s.picking);
  const doc = useApp((state) => state.doc);
  const layingOnFace = usePrintCheck((s) => s.picking);
  const [mode, setMode] = useState<DisplayMode>("shaded_edges");
  const [box, setBox] = useState<SelectionBox | null>(null);
  const boxRef = useRef(box);
  boxRef.current = box;

  // Each hook keeps one thing in the viewport in step; their effects run in this order.
  useAnalysisMaps(viewport);

  const sceneryReady = useScenery(viewport, doc);
  const drawing = useHighlighter(viewport, host);
  const marks = useTerrainMarks(viewport, doc.references, drawing, measure.active, sceneryReady);
  useScanShapes(viewport);
  usePartLooks(viewport, doc, output, colorParts);
  useThemeContrast(viewport);
  useCreateViewport(host, setVp);
  useGridUnit(viewport);

  // A part with a topology is shown as its shadow, or one of the two alone (see lib/strength.ts).
  const linkBody = useStrength((state) => state.body);
  const linkTopology = useStrength((state) => state.topology);
  const linkView = useStrength((state) => state.view);
  const viewed = useMemo(
    () => viewedScene(doc, hidden, { body: linkBody, topology: linkTopology, view: linkView }),
    [doc, hidden, linkBody, linkTopology, linkView],
  );
  const scene = useScene(viewport, output, viewed.doc, viewed.hidden, sketchId, dialog);
  usePhoneInset(viewport, dialog, measure.active, sketchId);
  usePoses(viewport, output, doc.mechanism, dialog);
  useJointGlyphs(viewport, output, doc.mechanism);
  useViewFlags(viewport, output, sketchId, dialog);
  useViewPointer(viewport, boxRef, setBox);

  return (
    <div
      className={`view ${dialog?.field || pickingPlane || measure.active || placing ? "picking" : ""}`}
      ref={host}
    >
      {viewport ? <ViewCube viewport={viewport} /> : null}
      {viewport ? <Manipulators viewport={viewport} /> : null}
      {viewport ? <InlineValues viewport={viewport} /> : null}
      {viewport && sketchId ? <SketchEditor viewport={viewport} sketchId={sketchId} /> : null}
      {viewport && pickingPlane && scene ? <PlaneChooser viewport={viewport} planes={scene.planes} /> : null}
      {viewport && marks.labels.length ? <TerrainLabels viewport={viewport} labels={marks.labels} /> : null}
      <TerrainHud />
      <AiActivity />
      {box ? <SelectBoxOverlay box={box} /> : null}
      {measure.active ? <MeasureCard /> : null}
      {mode === "rendered" && viewport ? (
        <RenderBar
          vp={viewport}
          onExit={() => (viewport.setDisplayMode("shaded_edges"), setMode("shaded_edges"))}
        />
      ) : null}
      <LoadingOverlay />
      <DeviationLegend />
      <ThicknessLegend />
      <StrengthCard />
      <PrintCheckCard />
      {layingOnFace ? <LayOnFaceHud /> : null}
      <MeshRepairCard />
      <StatusPill />
      <ViewControls viewport={viewport} fitKey={fitKey} mode={mode} setMode={setMode} />
    </div>
  );
}
