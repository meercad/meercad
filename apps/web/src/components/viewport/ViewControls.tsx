/**
 * The 3D view's own controls and status: the buttons in the corner (fit, projection, display mode,
 * planes, sketches, pictures, dimensions, part colours), the status line, the selection box and the
 * hint while a face is picked to lay a part on.
 */
import type { DisplayMode, Viewport } from "@meercad/viewport";
import {
  Box,
  Layers,
  Palette,
  PencilLine,
  Ruler,
  Scan,
  SlidersHorizontal,
  SquareSplitHorizontal,
  Waves,
} from "lucide-react";
import { useState } from "react";
import { t, tn } from "../../lib/i18n";
import { touchOnly } from "../../lib/keyboard";
import { setPrefs, usePrefs } from "../../lib/keymap";
import { pickFaceToLay } from "../../lib/printability";
import { toggleSection, useViewSection } from "../../lib/viewSection";
import { useApp } from "../../store";
import { withKey } from "../Kbd";
import { showMenu } from "../Menu";
import { SnapControls } from "../SnapControls";
import { useBusyBlink, useSlowBuild } from "./hooks";
import type { SelectionBox } from "./pointer";

const MODE_LABEL: Record<DisplayMode, string> = {
  shaded_edges: t("Shaded"),
  shaded: t("Shaded (no edges)"),
  hidden_line: t("Hidden line"),
  xray: t("X-ray"),
  wireframe: t("Wireframe"),
  rendered: t("Rendered"),
};

/** The display modes in the order the menus list them, with their menu names. */
function displayModes(): [DisplayMode, string][] {
  return [
    ["shaded_edges", t("Shaded with edges")],
    ["shaded", t("Shaded")],
    ["hidden_line", t("Hidden lines removed")],
    ["xray", t("X-ray")],
    ["wireframe", t("Wireframe")],
    ["rendered", t("Rendered")],
  ];
}

/** True while any lithophane in the design is not suppressed. */
function useHasTextures(): boolean {
  return useApp((state) =>
    state.doc.features.some((feature) => feature.op === "lithophane" && !feature.suppressed),
  );
}

/** The buttons in the view's corner; on a phone the less used ones share one menu. */
export function ViewControls({
  viewport,
  fitKey,
  mode,
  setMode,
}: {
  viewport: Viewport | null;
  fitKey: string | undefined;
  mode: DisplayMode;
  setMode: (mode: DisplayMode) => void;
}) {
  const showPlanes = useApp((state) => state.showPlanes);
  const showSketches = useApp((state) => state.showSketches);
  const showValues = usePrefs((prefs) => prefs.showValues);
  const showTextures = usePrefs((prefs) => prefs.showTextures);
  const colorParts = usePrefs((prefs) => prefs.colorParts);
  const hasTextures = useHasTextures();
  const sectionOn = useViewSection((s) => !!s.section);
  const [ortho, setOrtho] = useState(false);

  const toggleProjection = () => {
    viewport?.setProjection(ortho ? "perspective" : "orthographic");
    setOrtho(!ortho);
  };

  const modeItems = (check: (on: boolean) => string) =>
    displayModes().map(([m, label]) => ({
      label: `${check(viewport?.mode === m)}${label}`,
      onClick: () => (viewport?.setDisplayMode(m), setMode(m)),
    }));

  const phoneMenu = (rect: DOMRect) => {
    const check = (on: boolean) => (on ? "✓ " : "   ");
    showMenu(
      rect.left - 6,
      rect.top,
      [
        ...modeItems(check),
        "sep" as const,
        { label: `${check(sectionOn)}${t("Section view")}`, onClick: () => toggleSection(viewport) },
        { label: `${check(ortho)}${t("Orthographic")}`, onClick: toggleProjection },
        {
          label: `${check(showPlanes)}${t("Planes")}`,
          onClick: () => useApp.setState({ showPlanes: !showPlanes }),
        },
        {
          label: `${check(showSketches)}${t("Sketches")}`,
          onClick: () => useApp.setState({ showSketches: !showSketches }),
        },
        {
          label: `${check(showValues)}${t("Dimensions on the model")}`,
          onClick: () => setPrefs({ showValues: !showValues }),
        },
        {
          label: `${check(colorParts)}${t("A colour for each part")}`,
          onClick: () => setPrefs({ colorParts: !colorParts }),
        },
        ...(hasTextures
          ? [
              {
                label: `${check(showTextures)}${t("Lithophane pictures")}`,
                onClick: () => setPrefs({ showTextures: !showTextures }),
              },
            ]
          : []),
      ],
      { alignRight: true },
    );
  };

  const modeMenu = (rect: DOMRect) =>
    showMenu(
      rect.left,
      rect.top - 6,
      modeItems((on) => (on ? "✓ " : "   ")),
      { above: true },
    );

  return (
    <div className="view-controls">
      <SnapControls viewport={viewport} />
      <span className="bar-sep" aria-hidden />
      <button className="icon-btn sm" title={withKey(t("Fit all"), fitKey)} onClick={() => viewport?.fit()}>
        <Scan />
      </button>
      {/* Phone: the less used view switches share one menu, so the column stays short. */}
      <button
        className="icon-btn sm phone-only"
        title={t("View options")}
        onClick={(event) => phoneMenu((event.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        <SlidersHorizontal />
      </button>
      <button
        className={`icon-btn sm phone-hide ${ortho ? "active" : ""}`}
        title={ortho ? t("Orthographic (click for perspective)") : t("Perspective (click for orthographic)")}
        onClick={toggleProjection}
      >
        <Box />
      </button>
      <button
        className="icon-btn sm mode-btn phone-hide"
        title={t("Display mode")}
        onClick={(event) => modeMenu((event.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        <Box /> <span className="mode-label">{MODE_LABEL[mode]}</span>
      </button>
      <button
        className={`icon-btn sm phone-hide ${sectionOn ? "active" : ""}`}
        title={t("Section view: cut the parts open (view only)")}
        aria-pressed={sectionOn}
        onClick={() => toggleSection(viewport)}
      >
        <SquareSplitHorizontal />
      </button>
      <button
        className={`icon-btn sm phone-hide ${showPlanes ? "active" : ""}`}
        title={t("Planes")}
        onClick={() => useApp.setState({ showPlanes: !showPlanes })}
      >
        <Layers />
      </button>
      <button
        className={`icon-btn sm phone-hide ${showSketches ? "active" : ""}`}
        title={t("Sketches")}
        onClick={() => useApp.setState({ showSketches: !showSketches })}
      >
        <PencilLine />
      </button>
      {/* Textures cost time on every rebuild: hidden, editing a textured part is quicker
          (exports keep them). */}
      {hasTextures ? (
        <button
          className={`icon-btn sm phone-hide ${showTextures ? "active" : ""}`}
          title={
            showTextures
              ? t("Hide lithophane pictures while editing (rebuilds faster; exports keep them)")
              : t("Show lithophane pictures")
          }
          onClick={() => setPrefs({ showTextures: !showTextures })}
        >
          <Waves />
        </button>
      ) : null}
      <button
        className={`icon-btn sm phone-hide ${showValues ? "active" : ""}`}
        title={showValues ? t("Hide dimensions on the model") : t("Show dimensions on the model")}
        onClick={() => setPrefs({ showValues: !showValues })}
      >
        <Ruler />
      </button>
      <button
        className={`icon-btn sm phone-hide ${colorParts ? "active" : ""}`}
        title={colorParts ? t("Parts in one colour") : t("A colour for each part")}
        onClick={() => setPrefs({ colorParts: !colorParts })}
      >
        <Palette />
      </button>
    </div>
  );
}

/** The status line: the engine starting, a rebuild under way, or the parts and the last rebuild time. */
export function StatusPill() {
  const output = useApp((state) => state.output);
  const kernelState = useApp((state) => state.kernel);
  const previewing = useApp((state) => state.previewing);
  const showTextures = usePrefs((prefs) => prefs.showTextures);
  const hasTextures = useHasTextures();
  const slowBuild = useSlowBuild();
  const busy = useBusyBlink(output);

  return (
    <div className="status-pill" title={kernelState.error ?? ""}>
      {slowBuild ? (
        <span className="spinner sm" aria-hidden />
      ) : (
        <span
          className={`dot ${!kernelState.ready || busy ? "busy" : ""}`}
          style={kernelState.error ? { background: "var(--err)" } : undefined}
        />
      )}
      {kernelState.error ??
        (!kernelState.ready
          ? kernelState.info
          : slowBuild
            ? t("Rebuilding…")
            : output
              ? `${tn(output.report.bodies.length, "{n} part", "{n} parts")} · ${t("rebuild {ms} ms", { ms: output.report.rebuildMs.toFixed(0) })}${previewing ? ` · ${t("preview")}` : ""}${hasTextures && !showTextures ? ` · ${t("pictures hidden")}` : ""}`
              : t("Ready"))}
    </div>
  );
}

/** The box being dragged, with what it takes and how. */
export function SelectBoxOverlay({ box }: { box: SelectionBox }) {
  return (
    <div
      className={`select-box ${box.x1 >= box.x0 ? "enclosed" : "crossing"}`}
      style={{
        left: Math.min(box.x0, box.x1),
        top: Math.min(box.y0, box.y1),
        width: Math.abs(box.x1 - box.x0),
        height: Math.abs(box.y1 - box.y0),
      }}
    >
      <span>
        {box.filter === "all" ? t("Faces + edges") : box.filter === "face" ? t("Faces") : t("Edges")} ·{" "}
        {box.x1 >= box.x0 ? t("inside") : t("touching")} · F/E/Tab
      </span>
    </div>
  );
}

/** The hint while a face is picked to lay the part on the plate. */
export function LayOnFaceHud() {
  return (
    <div className="terrain-hud" role="status">
      <strong>{t("Lay on a face")}</strong>
      <span className="muted">
        {touchOnly()
          ? t("Tap the face that should lie on the plate")
          : t("Click the face that should lie on the plate")}
      </span>
      <button className="btn" onClick={() => pickFaceToLay(false)}>
        {t("Cancel")}
      </button>
    </div>
  );
}
