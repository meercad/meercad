/**
 * Command search (key from the control scheme, or the search button): every action with its shortcut,
 * fuzzy-filtered.
 */
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureOp } from "@meercad/schema";
import { FEATURES, TOOLBAR } from "../lib/features";
import { setTool, type SketchTool } from "../sketch/state";
import { applyConstraint, CONSTRAINT_TOOLS, toggleConstruction } from "../sketch/actions";
import {
  closeSketch,
  getViewport,
  goHome,
  hideSelectedParts,
  lastStartedFeature,
  newProject,
  redo,
  startFeature,
  undo,
  useApp,
} from "../store";
import { exportMesh, exportRobot, exportStep, importFile, saveFile, sendToSlicer, viewInAr } from "./io";
import { useSlicers } from "../lib/slicers";
import { nativeApp } from "../lib/native";
import { openDrawing } from "./DrawingDialog";
import { openVersions } from "./VersionsDialog";
import { hasPack, usePremium } from "../lib/premium";
import { openShare } from "./ShareDialog";
import { checkInterference } from "../lib/interference";
import { Kbd } from "./Kbd";
import { CONTROL_SCHEMES, keyFor, setPrefs, usePrefs, type Action } from "../lib/keymap";
import { selectAll } from "../lib/clipboard";
import { deleteModelSelection } from "../lib/deletion";
import { toggleJoints } from "../lib/mechanism";
import { toggleTheme } from "./TopBar";
import { desktop } from "../lib/persistence";
import { t } from "../lib/i18n";

interface Command {
  label: string;
  kbd?: string;
  group: string;
  run: () => void;
}

const SKETCH_TOOLS: [Exclude<SketchTool, "select">, string][] = [
  ["line", t("Line")],
  ["rect", t("Rectangle")],
  ["rect_center", t("Center rectangle")],
  ["circle", t("Circle")],
  ["arc", t("3-point arc")],
  ["arc_center", t("Center arc")],
  ["polygon", t("Polygon")],
  ["spline", t("Spline")],
  ["point", t("Point")],
  ["trim", t("Trim")],
  ["fillet", t("Round a corner")],
  ["chamfer", t("Bevel a corner")],
  ["offset", t("Offset curves")],
  ["pattern", t("Repeat curves (pattern)")],
  ["dimension", t("Dimension")],
  ["project", t("Project model edges")],
  ["section", t("Trace mesh section")],
];
const G = {
  sketch: t("Sketch"),
  constraint: t("Constraint"),
  modeling: t("Modeling"),
  edit: t("Edit"),
  view: t("View"),
  file: t("File"),
  help: t("Help"),
};

const kbd = (a: Action) => {
  const k = keyFor(a);

  return k ? { kbd: k } : {};
};

/** Subsequence match with a score favouring word starts and contiguous runs. */
function score(q: string, text: string): number {
  if (!q) return 1;

  const lower = text.toLowerCase();
  let ti = 0;
  let s = 0;
  let run = 0;

  for (const ch of q.toLowerCase()) {
    const i = lower.indexOf(ch, ti);
    if (i < 0) return 0;

    run = i === ti ? run + 1 : 1;
    s += run + (i === 0 || lower[i - 1] === " " ? 3 : 0);
    ti = i + 1;
  }

  return s;
}

export function CommandPalette({
  onHelp,
  onShortcuts,
  onTour,
}: {
  onHelp: () => void;
  onShortcuts: () => void;
  onTour: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const sketchId = useApp((state) => state.sketchId);
  const screen = useApp((state) => state.screen);
  const keys = usePrefs((prefs) => prefs.keys);
  const packs = usePremium();

  useEffect(() => {
    const toggle = () => {
      setOpen((o) => !o);
      setQ("");
      setI(0);
    };

    window.addEventListener("meercad:palette", toggle);

    return () => window.removeEventListener("meercad:palette", toggle);
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const vp = () => getViewport();
    const list: Command[] = [];

    if (screen === "editor" && sketchId) {
      for (const [tool, label] of SKETCH_TOOLS) {
        if (tool !== "section" || hasPack("scan")) {
          list.push({ group: G.sketch, label, ...kbd(`sketch.${tool}`), run: () => setTool(tool) });
        }
      }

      for (const c of CONSTRAINT_TOOLS) {
        list.push({
          group: G.constraint,
          label: c.label,
          ...kbd(`constraint.${c.type}`),
          run: () => applyConstraint(c.type),
        });
      }

      list.push(
        {
          group: G.sketch,
          label: t("Toggle construction"),
          ...kbd("sketch.construction"),
          run: toggleConstruction,
        },
        { group: G.sketch, label: t("Finish sketch"), kbd: "↵", run: closeSketch },
      );
    } else if (screen === "editor") {
      for (const op of TOOLBAR) {
        if ((op !== "gear" && op !== "spring") || hasPack("mechanics")) {
          list.push({
            group: G.modeling,
            label: FEATURES[op].label,
            ...kbd(op as Action),
            run: () => startFeature(op as FeatureOp),
          });
        }
      }

      list.push({
        group: G.modeling,
        label: t("Measure"),
        ...kbd("measure"),
        run: () => useApp.setState({ measure: { active: true, picks: [], result: null } }),
      });

      const last = lastStartedFeature();

      if (last) {
        list.push({
          group: G.modeling,
          label: t("Repeat: {name}", { name: FEATURES[last].label }),
          ...kbd("repeat"),
          run: () => startFeature(last),
        });
      }

      if (hasPack("mechanics")) {
        list.push({ group: G.modeling, label: t("Joints"), ...kbd("joints"), run: toggleJoints });
      }

      list.push(
        { group: G.edit, label: t("Select all parts"), ...kbd("select_all"), run: selectAll },
        {
          group: G.edit,
          label: t("Delete selection"),
          ...kbd("delete"),
          run: () => void deleteModelSelection(),
        },
        { group: G.view, label: t("Hide selected parts"), ...kbd("hide"), run: hideSelectedParts },
        {
          group: G.view,
          label: t("Show all hidden parts"),
          ...kbd("unhide_all"),
          run: () => useApp.setState({ hidden: new Set() }),
        },
      );
    }

    if (screen === "editor") {
      list.push(
        { group: G.edit, label: t("Undo"), kbd: "Mod+Z", run: undo },
        { group: G.edit, label: t("Redo"), kbd: "Shift+Mod+Z", run: redo },
        { group: G.view, label: t("Fit all"), ...kbd("fit"), run: () => vp()?.fit() },
        { group: G.view, label: t("Isometric view"), ...kbd("view.iso"), run: () => vp()?.setView("iso") },
        { group: G.view, label: t("Front view"), ...kbd("view.front"), run: () => vp()?.setView("front") },
        { group: G.view, label: t("Back view"), ...kbd("view.back"), run: () => vp()?.setView("back") },
        { group: G.view, label: t("Top view"), ...kbd("view.top"), run: () => vp()?.setView("top") },
        { group: G.view, label: t("Bottom view"), ...kbd("view.bottom"), run: () => vp()?.setView("bottom") },
        { group: G.view, label: t("Right view"), ...kbd("view.right"), run: () => vp()?.setView("right") },
        { group: G.view, label: t("Left view"), ...kbd("view.left"), run: () => vp()?.setView("left") },
        {
          group: G.view,
          label: t("Toggle orthographic"),
          run: () =>
            vp()?.setProjection(vp()?.projection === "orthographic" ? "perspective" : "orthographic"),
        },
        {
          group: G.view,
          label: t("Toggle planes"),
          run: () => useApp.setState((state) => ({ showPlanes: !state.showPlanes })),
        },
        { group: G.file, label: t("Export STL"), run: () => void exportMesh("stl") },
        { group: G.file, label: t("Export 3MF"), run: () => void exportMesh("3mf") },
        ...useSlicers.getState().slicers.map((sl) => ({
          group: G.file,
          label: t("Send to {name}", { name: sl.name }),
          run: () => void sendToSlicer(sl.id),
        })),
        { group: G.file, label: t("Export OBJ"), run: () => void exportMesh("obj") },
        ...(hasPack("mechanics") && (useApp.getState().doc.mechanism?.joints.length ?? 0) > 0
          ? [
              {
                group: G.file,
                label: t("Export robot (MJCF/URDF for simulation)"),
                run: () => void exportRobot(),
              },
            ]
          : []),
        { group: G.file, label: t("Export STEP"), run: () => void exportStep() },
        {
          group: G.file,
          label: nativeApp
            ? t("View in AR (real size on the table)")
            : t("Export USDZ (AR on iPhone and iPad)"),
          run: () => void viewInAr(),
        },
        ...(hasPack("drawings")
          ? [{ group: G.file, label: t("Technical drawing (PDF, SVG, DXF)"), run: openDrawing }]
          : []),
        ...(hasPack("versions")
          ? [
              {
                group: G.file,
                label: t("Versions: save or restore a state of the design"),
                run: openVersions,
              },
            ]
          : []),
        ...(hasPack("mechanics")
          ? [
              {
                group: G.modeling,
                label: t("Check whether parts overlap (interference)"),
                run: () => void checkInterference(),
              },
            ]
          : []),
        { group: G.file, label: t("Share the design (with its history, editable)"), run: openShare },
        { group: G.file, label: t("Save copy as .meercad"), kbd: "Shift+Mod+S", run: saveFile },
        { group: G.file, label: t("All projects"), run: goHome },
      );
    }

    list.push(
      { group: G.file, label: t("New part"), kbd: "Mod+N", run: () => void newProject() },
      { group: G.file, label: t("Import / open file"), kbd: "Mod+O", run: () => void importFile() },
      { group: G.help, label: t("Help & guides"), run: onHelp },
      { group: G.help, label: t("Keyboard shortcuts"), kbd: "?", run: onShortcuts },
      { group: G.help, label: t("Introduction tour"), run: onTour },
      {
        group: G.help,
        label: t("Settings"),
        kbd: "Mod+,",
        run: () => window.dispatchEvent(new Event("meercad:settings")),
      },
      { group: G.help, label: t("Toggle dark mode"), run: toggleTheme },
      ...CONTROL_SCHEMES.map((c) => ({
        group: G.help,
        label: t("Control scheme: {name}", { name: c.label }),
        run: () => setPrefs({ keys: c.keys, mouse: c.mouse }),
      })),
    );

    return list;
  }, [sketchId, screen, keys, onHelp, onShortcuts, onTour, packs]);

  const results = commands
    .map((c) => ({ c, s: Math.max(score(q, c.label), score(q, `${c.group} ${c.label}`) - 2) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((r) => r.c);
  if (!open) return null;

  const run = (c: Command | undefined) => {
    if (!c) return;

    setOpen(false);
    c.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onPointerDown={() => setOpen(false)}>
      <div
        className="palette"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-label={t("Command search")}
      >
        <div className="palette-input">
          <Search />
          <input
            ref={input}
            value={q}
            placeholder={t("Search commands…")}
            onChange={(event) => {
              setQ(event.target.value);
              setI(0);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setOpen(false);

              if (event.key === "ArrowDown") {
                (event.preventDefault(), setI((x) => Math.min(results.length - 1, x + 1)));
              }

              if (event.key === "ArrowUp") (event.preventDefault(), setI((x) => Math.max(0, x - 1)));
              if (event.key === "Enter") run(results[i]);
            }}
          />
          <Kbd k="Esc" />
        </div>
        <div className="palette-list">
          {results.map((c, k) => (
            <button
              key={`${c.group}${c.label}`}
              className={k === i ? "on" : ""}
              onMouseEnter={() => setI(k)}
              onClick={() => run(c)}
            >
              <span className="muted palette-group">{c.group}</span>
              <span>{c.label}</span>
              <span className="spacer" />
              {c.kbd ? <Kbd k={c.kbd} /> : null}
            </button>
          ))}
          {!results.length ? <div className="empty">{t("No matching command")}</div> : null}
        </div>
      </div>
    </div>
  );
}
