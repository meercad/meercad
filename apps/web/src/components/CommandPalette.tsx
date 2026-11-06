/** Command search (X / ⌘F): every action with its shortcut, fuzzy-filtered. */
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureOp } from "@meercad/schema";
import { FEATURES, TOOLBAR } from "../lib/features";
import { setTool, type SketchTool } from "../sketch/state";
import { applyConstraint, CONSTRAINT_TOOLS, toggleConstruction } from "../sketch/actions";
import { closeSketch, getViewport, goHome, newProject, redo, startFeature, undo, useApp } from "../store";
import { exportMesh, exportStep, importFile, saveFile } from "./io";
import { openDrawing } from "./DrawingDialog";
import { openVersions } from "./VersionsDialog";
import { hasPack, usePremium } from "../lib/premium";
import { checkInterference } from "../lib/interference";
import { Kbd } from "./Kbd";
import { keyFor, usePrefs, type Action } from "../lib/keymap";
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
const G = { sketch: t("Sketch"), constraint: t("Constraint"), modeling: t("Modeling"), edit: t("Edit"), view: t("View"), file: t("File"), help: t("Help") };
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

export function CommandPalette({ onHelp, onShortcuts, onTour }: { onHelp: () => void; onShortcuts: () => void; onTour: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const sketchId = useApp((s) => s.sketchId);
  const screen = useApp((s) => s.screen);
  const keys = usePrefs((s) => s.keys);
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
      for (const [tool, label] of SKETCH_TOOLS) if (tool !== "section" || hasPack("scan")) list.push({ group: G.sketch, label, ...kbd(`sketch.${tool}`), run: () => setTool(tool) });
      for (const c of CONSTRAINT_TOOLS) list.push({ group: G.constraint, label: c.label, ...(c.key ? { kbd: c.key } : {}), run: () => applyConstraint(c.type) });
      list.push({ group: G.sketch, label: t("Toggle construction"), ...kbd("sketch.construction"), run: toggleConstruction }, { group: G.sketch, label: t("Finish sketch"), kbd: "↵", run: closeSketch });
    } else if (screen === "editor") {
      for (const op of TOOLBAR) if ((op !== "gear" && op !== "spring") || hasPack("mechanics")) list.push({ group: G.modeling, label: FEATURES[op].label, ...kbd(op as Action), run: () => startFeature(op as FeatureOp) });
      list.push({ group: G.modeling, label: t("Measure"), ...kbd("measure"), run: () => useApp.setState({ measure: { active: true, picks: [], result: null } }) });
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
        { group: G.view, label: t("Toggle orthographic"), run: () => vp()?.setProjection(vp()?.projection === "orthographic" ? "perspective" : "orthographic") },
        { group: G.view, label: t("Toggle planes"), run: () => useApp.setState((s) => ({ showPlanes: !s.showPlanes })) },
        { group: G.file, label: t("Export STL"), run: () => void exportMesh("stl") },
        { group: G.file, label: t("Export 3MF"), run: () => void exportMesh("3mf") },
        { group: G.file, label: t("Export OBJ"), run: () => void exportMesh("obj") },
        { group: G.file, label: t("Export STEP"), run: () => void exportStep() },
        ...(hasPack("drawings") ? [{ group: G.file, label: t("Technical drawing (PDF, SVG, DXF)"), run: openDrawing }] : []),
        ...(hasPack("versions") ? [{ group: G.file, label: t("Versions: save or restore a state of the design"), run: openVersions }] : []),
        ...(hasPack("mechanics") ? [{ group: G.modeling, label: t("Check whether parts overlap (interference)"), run: () => void checkInterference() }] : []),
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
      { group: G.help, label: t("Settings"), kbd: "Mod+,", run: () => window.dispatchEvent(new Event("meercad:settings")) },
      { group: G.help, label: t("Toggle dark mode"), run: toggleTheme },
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
      <div className="palette" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label={t("Command search")}>
        <div className="palette-input">
          <Search />
          <input
            ref={input}
            value={q}
            placeholder={t("Search commands…")}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setOpen(false);
              if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(results.length - 1, x + 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
              if (e.key === "Enter") run(results[i]);
            }}
          />
          <Kbd k="Esc" />
        </div>
        <div className="palette-list">
          {results.map((c, k) => (
            <button key={`${c.group}${c.label}`} className={k === i ? "on" : ""} onMouseEnter={() => setI(k)} onClick={() => run(c)}>
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
