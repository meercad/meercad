/** Command search (X / ⌘F): every action with its shortcut, fuzzy-filtered. */
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureOp } from "@meercad/schema";
import { FEATURES, TOOLBAR } from "../lib/features";
import { setTool, type SketchTool } from "../sketch/state";
import { applyConstraint, CONSTRAINT_TOOLS, toggleConstruction } from "../sketch/actions";
import { closeSketch, getViewport, goHome, newProject, redo, startFeature, undo, useApp } from "../store";
import { exportMesh, exportStep, importFile, saveFile } from "./io";
import { Kbd } from "./Kbd";
import { keyFor, usePrefs, type Action } from "../lib/keymap";
import { toggleTheme } from "./TopBar";
import { desktop } from "../lib/persistence";

interface Command {
  label: string;
  kbd?: string;
  group: string;
  run: () => void;
}

const SKETCH_TOOLS: [Exclude<SketchTool, "select">, string][] = [
  ["line", "Line"],
  ["rect", "Rectangle"],
  ["rect_center", "Center rectangle"],
  ["circle", "Circle"],
  ["arc", "3-point arc"],
  ["arc_center", "Center arc"],
  ["polygon", "Polygon"],
  ["point", "Point"],
  ["trim", "Trim"],
  ["fillet", "Round a corner"],
  ["chamfer", "Bevel a corner"],
  ["offset", "Offset curves"],
  ["dimension", "Dimension"],
  ["project", "Project model edges"],
];
const kbd = (a: Action) => {
  const k = keyFor(a);
  return k ? { kbd: k } : {};
};

/** Subsequence match with a score favouring word starts and contiguous runs. */
function score(q: string, text: string): number {
  if (!q) return 1;
  const t = text.toLowerCase();
  let ti = 0;
  let s = 0;
  let run = 0;
  for (const ch of q.toLowerCase()) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return 0;
    run = i === ti ? run + 1 : 1;
    s += run + (i === 0 || t[i - 1] === " " ? 3 : 0);
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
      for (const [tool, label] of SKETCH_TOOLS) list.push({ group: "Sketch", label, ...kbd(`sketch.${tool}`), run: () => setTool(tool) });
      for (const c of CONSTRAINT_TOOLS) list.push({ group: "Constraint", label: c.label, ...(c.key ? { kbd: c.key } : {}), run: () => applyConstraint(c.type) });
      list.push({ group: "Sketch", label: "Toggle construction", ...kbd("sketch.construction"), run: toggleConstruction }, { group: "Sketch", label: "Finish sketch", kbd: "↵", run: closeSketch });
    } else if (screen === "editor") {
      for (const op of TOOLBAR) list.push({ group: "Modeling", label: FEATURES[op].label, ...kbd(op as Action), run: () => startFeature(op as FeatureOp) });
      list.push({ group: "Modeling", label: "Measure", ...kbd("measure"), run: () => useApp.setState({ measure: { active: true, picks: [], result: null } }) });
    }
    if (screen === "editor") {
      list.push(
        { group: "Edit", label: "Undo", kbd: "Mod+Z", run: undo },
        { group: "Edit", label: "Redo", kbd: "Shift+Mod+Z", run: redo },
        { group: "View", label: "Fit all", ...kbd("fit"), run: () => vp()?.fit() },
        { group: "View", label: "Isometric view", ...kbd("view.iso"), run: () => vp()?.setView("iso") },
        { group: "View", label: "Front view", ...kbd("view.front"), run: () => vp()?.setView("front") },
        { group: "View", label: "Back view", ...kbd("view.back"), run: () => vp()?.setView("back") },
        { group: "View", label: "Top view", ...kbd("view.top"), run: () => vp()?.setView("top") },
        { group: "View", label: "Bottom view", ...kbd("view.bottom"), run: () => vp()?.setView("bottom") },
        { group: "View", label: "Right view", ...kbd("view.right"), run: () => vp()?.setView("right") },
        { group: "View", label: "Left view", ...kbd("view.left"), run: () => vp()?.setView("left") },
        { group: "View", label: "Toggle orthographic", run: () => vp()?.setProjection(vp()?.projection === "orthographic" ? "perspective" : "orthographic") },
        { group: "View", label: "Toggle planes", run: () => useApp.setState((s) => ({ showPlanes: !s.showPlanes })) },
        { group: "File", label: "Export STL", run: () => void exportMesh("stl") },
        { group: "File", label: "Export 3MF", run: () => void exportMesh("3mf") },
        { group: "File", label: "Export STEP", run: () => void exportStep() },
        { group: "File", label: "Save copy as .meercad", kbd: "Shift+Mod+S", run: saveFile },
        { group: "File", label: "All projects", run: goHome },
      );
    }
    list.push(
      { group: "File", label: "New part", kbd: "Mod+N", run: () => void newProject() },
      { group: "File", label: "Import / open file", kbd: "Mod+O", run: () => void importFile() },
      { group: "Help", label: "Help & guides", run: onHelp },
      { group: "Help", label: "Keyboard shortcuts", kbd: "?", run: onShortcuts },
      { group: "Help", label: "Introduction tour", run: onTour },
      { group: "Help", label: "Settings", kbd: "Mod+,", run: () => window.dispatchEvent(new Event("meercad:settings")) },
      { group: "Help", label: "Toggle dark mode", run: toggleTheme },
      ...(desktop ? [{ group: "Help", label: "Check for updates", run: () => void desktop!.updates.check() }] : []),
    );
    return list;
  }, [sketchId, screen, keys, onHelp, onShortcuts, onTour]);

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
      <div className="palette" onPointerDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command search">
        <div className="palette-input">
          <Search />
          <input
            ref={input}
            value={q}
            placeholder="Search commands…"
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
          {!results.length ? <div className="empty">No matching command</div> : null}
        </div>
      </div>
    </div>
  );
}
