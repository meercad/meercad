import { ChevronDown, CircleHelp, Download, Ellipsis, FileDown, House, Keyboard, Moon, PanelLeft, Redo2, Settings, Share2, Undo2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { goHome, redo, renameProject, toggleSide, undo, useApp } from "../store";
import { exportMesh, exportSketch, exportStep, importFile, saveFile, shareLink } from "./io";
import { desktop } from "../lib/persistence";
import { McpButton } from "./McpButton";
import { showMenu } from "./Menu";

const NONE: never[] = [];
const EMPTY: Record<string, never> = {};

export function Logo() {
  return <img src="/logo.png" alt="" width={28} height={28} />;
}

export function toggleTheme(): void {
  const root = document.documentElement;
  const dark = root.dataset["theme"] ? root.dataset["theme"] === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset["theme"] = dark ? "light" : "dark";
  try {
    localStorage.setItem("leocad.theme", root.dataset["theme"]);
  } catch {
    // theme just won't persist
  }
}

export function TopBar() {
  const project = useApp((s) => s.project);
  const sideOpen = useApp((s) => s.sideOpen);
  const saveState = useApp((s) => s.saveState);
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  const sketches = useApp((s) => s.output?.report.sketches) ?? NONE;
  const [name, setName] = useState(project?.name ?? "");
  useEffect(() => setName(project?.name ?? ""), [project?.name]);

  const fileBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const openFile = () => {
    const r = fileBtn.current!.getBoundingClientRect();
    showMenu(r.right - 240, r.bottom + 6, [
      { label: "Import STEP, STL, DXF, SVG…", icon: <Upload />, kbd: "Mod+O", onClick: () => void importFile() },
      "sep",
      { label: "Export STL (3D printing)", icon: <FileDown />, onClick: () => exportMesh("stl") },
      { label: "Export 3MF (3D printing)", icon: <FileDown />, onClick: () => exportMesh("3mf") },
      { label: "Export STEP (CAD exchange)", icon: <FileDown />, onClick: () => void exportStep() },
      ...sketches.flatMap((s) => [
        { label: `Export ${s.id} as DXF (laser)`, icon: <FileDown />, onClick: () => exportSketch(s.id, "dxf") },
        { label: `Export ${s.id} as SVG`, icon: <FileDown />, onClick: () => exportSketch(s.id, "svg") },
      ]),
      "sep",
      { label: "Save copy as .leocad…", icon: <Download />, kbd: "Shift+Mod+S", onClick: saveFile },
      ...(desktop ? [] : [{ label: "Copy share link", icon: <Share2 />, onClick: () => void shareLink() }]),
    ]);
  };
  const openMore = () => {
    const r = moreBtn.current!.getBoundingClientRect();
    showMenu(r.right - 240, r.bottom + 6, [
      { label: "All projects", icon: <House />, onClick: goHome },
      { label: "Settings…", icon: <Settings />, kbd: "Mod+,", onClick: () => window.dispatchEvent(new Event("leocad:settings")) },
      { label: "Help & guides", icon: <CircleHelp />, onClick: () => window.dispatchEvent(new Event("leocad:help")) },
      { label: "Keyboard shortcuts", icon: <Keyboard />, kbd: "?", onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })) },
      { label: "Toggle dark mode", icon: <Moon />, onClick: toggleTheme },
    ]);
  };

  return (
    <header className={`topbar ${desktop ? "desktop" : ""}`}>
      <button className={`icon-btn side-toggle ${sideOpen ? "active" : ""}`} onClick={() => toggleSide()} title={`${sideOpen ? "Hide" : "Show"} history, parts and variables (⌘⌥H)`}>
        <PanelLeft />
      </button>
      <button className="logo" onClick={goHome} title={`All projects — ${saveState === "saved" ? "saved" : saveState === "saving" ? "saving…" : "unsaved changes"}`}>
        <Logo />
      </button>
      <input
        className="doc-name"
        value={name}
        aria-label="Project name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => renameProject(name)}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      <span className="spacer" />
      <button className="icon-btn" onClick={undo} disabled={!canUndo} title="Undo (⌘Z)">
        <Undo2 />
      </button>
      <button className="icon-btn" onClick={redo} disabled={!canRedo} title="Redo (⇧⌘Z)">
        <Redo2 />
      </button>
      <button className="btn" ref={fileBtn} onClick={openFile} title="Import and export">
        File <ChevronDown />
      </button>
      <span className="mcp-anchor">
        <McpButton />
      </span>
      <button className="icon-btn" ref={moreBtn} onClick={openMore} title="More: settings, help, projects">
        <Ellipsis />
      </button>
    </header>
  );
}
