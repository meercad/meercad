import { ChevronDown, Download, FileDown, House, Moon, Redo2, Share2, Sparkles, Sun, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { goHome, redo, renameProject, undo, useApp } from "../store";
import { exportMesh, exportSketch, exportStep, saveFile, shareLink } from "./io";
import { showMenu } from "./Menu";

const NONE: never[] = [];
const EMPTY: Record<string, never> = {};

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden>
      <path d="M16 3l11 6v14l-11 6-11-6V9z" fill="var(--accent)" />
      <path d="M16 3l11 6-11 6-11-6z" fill="color-mix(in srgb, var(--accent) 45%, white)" />
      <path d="M16 15v14l-11-6V9z" fill="color-mix(in srgb, var(--accent) 80%, black)" />
    </svg>
  );
}

export function toggleTheme(): void {
  const root = document.documentElement;
  const dark = root.dataset["theme"] ? root.dataset["theme"] === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset["theme"] = dark ? "light" : "dark";
  try {
    localStorage.setItem("opencad.theme", root.dataset["theme"]);
  } catch {
    // theme just won't persist
  }
}

export function TopBar() {
  const project = useApp((s) => s.project);
  const saveState = useApp((s) => s.saveState);
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  const copilot = useApp((s) => s.copilotOpen);
  const sketches = useApp((s) => s.output?.report.sketches) ?? NONE;
  const [name, setName] = useState(project?.name ?? "");
  const exportBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => setName(project?.name ?? ""), [project?.name]);

  const openExport = () => {
    const r = exportBtn.current!.getBoundingClientRect();
    showMenu(r.right - 220, r.bottom + 4, [
      { label: "STL (3D printing)", icon: <FileDown />, onClick: () => exportMesh("stl") },
      { label: "3MF (3D printing)", icon: <FileDown />, onClick: () => exportMesh("3mf") },
      { label: "STEP (CAD exchange)", icon: <FileDown />, onClick: () => void exportStep() },
      "sep",
      ...sketches.flatMap((s) => [
        { label: `${s.id} as DXF (laser)`, icon: <FileDown />, onClick: () => exportSketch(s.id, "dxf") },
        { label: `${s.id} as SVG`, icon: <FileDown />, onClick: () => exportSketch(s.id, "svg") },
      ]),
      ...(sketches.length ? (["sep"] as const) : []),
      { label: "opencad file (.ocad)", icon: <Download />, onClick: saveFile },
    ]);
  };

  return (
    <header className="topbar">
      <button className="logo" onClick={goHome} title="All projects">
        <Logo />
        opencad
      </button>
      <span className="muted">/</span>
      <input
        className="doc-name"
        value={name}
        aria-label="Project name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => renameProject(name)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <span className="save-state">{saveState === "saved" ? "Saved in this browser" : saveState === "saving" ? "Saving…" : "Unsaved changes"}</span>
      <div className="spacer" />
      <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
        <Undo2 />
      </button>
      <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
        <Redo2 />
      </button>
      <button className="icon-btn" onClick={toggleTheme} title="Toggle dark mode">
        <Sun className="light-only" />
        <Moon style={{ display: "none" }} />
      </button>
      <button className="icon-btn" onClick={goHome} title="Projects">
        <House />
      </button>
      <button className="btn" ref={exportBtn} onClick={openExport}>
        <Download /> <span className="btn-label">Export</span> <ChevronDown />
      </button>
      <button className="btn" onClick={() => void shareLink()} title="Copy a link that contains the whole model">
        <Share2 /> <span className="btn-label">Share</span>
      </button>
      <button className={`btn ${copilot ? "primary" : ""}`} onClick={() => useApp.setState((s) => ({ copilotOpen: !s.copilotOpen }))} title="AI copilot (bring your own key)">
        <Sparkles /> <span className="btn-label">Copilot</span>
      </button>
    </header>
  );
}
