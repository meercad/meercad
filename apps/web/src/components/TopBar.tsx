import { Check, ChevronDown, CircleHelp, Download, Ellipsis, FileDown, House, Info, Keyboard, Moon, PanelLeft, Pencil, Plus, Redo2, Ruler, Settings, Share2, Undo2, Upload, X } from "lucide-react";
import { setPrefs, usePrefs } from "../lib/keymap";
import { useRef } from "react";
import { closeTab, goHome, newProject, openProject, redo, renameProject, setDesignUnits, toggleSide, undo, useApp } from "../store";
import { featureName } from "../lib/features";
import { useCompact } from "../lib/layout";
import { askText } from "./Ask";
import type { MenuEntry } from "./Menu";
import { exportMesh, exportSketch, exportStep, importFile, saveFile, shareLink } from "./io";
import { nativeApp } from "../lib/native";
import { desktop } from "../lib/persistence";
import { McpButton } from "./McpButton";
import { CopilotButton } from "./Copilot";
import { TabStrip } from "./Tabs";
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
    localStorage.setItem("meercad.theme", root.dataset["theme"]);
  } catch {
    // theme just won't persist
  }
}

export function TopBar() {
  const sideOpen = useApp((s) => s.sideOpen);
  const canUndo = useApp((s) => s.canUndo);
  const canRedo = useApp((s) => s.canRedo);
  const inDialog = useApp((s) => !!s.dialog);
  const sketches = useApp((s) => s.output?.report.sketches) ?? NONE;
  const features = useApp((s) => s.doc.features);
  const project = useApp((s) => s.project);
  const tabs = useApp((s) => s.tabs);
  const compact = useCompact();
  const nameBtn = useRef<HTMLButtonElement>(null);
  const units = useApp((s) => s.doc.units ?? "mm");

  const fileBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const sketchName = (id: string) => {
    const f = features.find((x) => x.id === id);
    return f ? featureName(f) : id;
  };
  const fileItems = (): MenuEntry[] => [
      { label: "Import STEP, STL, 3MF, OBJ, DXF, SVG…", icon: <Upload />, kbd: "Mod+O", onClick: () => void importFile() },
      "sep",
      { label: "Export STL (3D printing)", icon: <FileDown />, onClick: () => void exportMesh("stl") },
      { label: "Export 3MF (3D printing)", icon: <FileDown />, onClick: () => void exportMesh("3mf") },
      { label: "Export STEP (CAD exchange)", icon: <FileDown />, onClick: () => void exportStep() },
      ...sketches.flatMap((s) => [
        { label: `Export ${sketchName(s.id)} as DXF (laser)`, icon: <FileDown />, onClick: () => exportSketch(s.id, "dxf") },
        { label: `Export ${sketchName(s.id)} as SVG`, icon: <FileDown />, onClick: () => exportSketch(s.id, "svg") },
      ]),
      "sep",
      { label: `${units === "mm" ? "✓ " : "   "}Millimetres (this design)`, icon: <Ruler />, onClick: () => setDesignUnits("mm") },
      { label: `${units === "in" ? "✓ " : "   "}Inches (this design)`, icon: <Ruler />, onClick: () => setDesignUnits("in") },
      "sep",
      { label: "Save copy as .meercad…", icon: <Download />, kbd: "Shift+Mod+S", onClick: saveFile },
      ...(desktop ? [] : [{ label: "Copy share link", icon: <Share2 />, onClick: () => void shareLink() }]),
  ];
  const openFile = () => {
    const r = fileBtn.current!.getBoundingClientRect();
    showMenu(r.right - 240, r.bottom + 6, fileItems());
  };
  const openMore = () => {
    const r = moreBtn.current!.getBoundingClientRect();
    // The phone has no File button: its items come first here.
    showMenu(r.right - 240, r.bottom + 6, [
      ...(compact ? [...fileItems(), "sep" as const] : []),
      { label: "Settings…", icon: <Settings />, kbd: "Mod+,", onClick: () => window.dispatchEvent(new Event("meercad:settings")) },
      { label: "Help & guides", icon: <CircleHelp />, onClick: () => window.dispatchEvent(new Event("meercad:help")) },
      ...(compact ? [] : [{ label: "Keyboard shortcuts", icon: <Keyboard />, kbd: "?", onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })) }]),
      { label: `${usePrefs.getState().showValues ? "Hide" : "Show"} dimensions on the model`, icon: <Ruler />, onClick: () => setPrefs({ showValues: !usePrefs.getState().showValues }) },
      ...(compact ? [] : [{ label: `${usePrefs.getState().showKeys ? "Hide" : "Show"} shortcut badges`, icon: <Keyboard />, onClick: () => setPrefs({ showKeys: !usePrefs.getState().showKeys }) }]),
      { label: "Toggle dark mode", icon: <Moon />, onClick: toggleTheme },
      "sep",
      { label: "About meerCAD, privacy & licences", icon: <Info />, onClick: () => window.dispatchEvent(new CustomEvent("meercad:about")) },
    ]);
  };

  // Phone: the project name stands in for the tab strip and switches between open projects.
  const openProjects = () => {
    const r = nameBtn.current!.getBoundingClientRect();
    showMenu(r.left, r.bottom + 6, [
      ...tabs.map((t) => ({ label: t.name, icon: t.id === project?.id ? <Check /> : <span />, onClick: () => void openProject(t.id) })),
      "sep",
      { label: "New part", icon: <Plus />, onClick: () => void newProject() },
      {
        label: "Rename…",
        icon: <Pencil />,
        onClick: () => void askText({ title: "Rename part", label: "Name", value: project?.name ?? "", confirmLabel: "Rename" }).then((n) => (n?.trim() ? renameProject(n.trim()) : undefined)),
      },
      ...(project ? [{ label: "Close", icon: <X />, onClick: () => closeTab(project.id) }] : []),
    ]);
  };
  if (compact)
    return (
      <header className="topbar compact">
        <button className="icon-btn" onClick={goHome} title="All projects">
          <House />
        </button>
        <button className="doc-switch" ref={nameBtn} onClick={openProjects} title="Open projects">
          <span>{project?.name ?? "Untitled part"}</span>
          <ChevronDown />
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={undo} disabled={!canUndo && !inDialog} title="Undo">
          <Undo2 />
        </button>
        <button className="icon-btn" onClick={redo} disabled={!canRedo || inDialog} title="Redo">
          <Redo2 />
        </button>
        <CopilotButton />
        <button className="icon-btn" ref={moreBtn} onClick={openMore} title="File, settings, help">
          <Ellipsis />
        </button>
      </header>
    );

  return (
    <header className={`topbar ${desktop ? "desktop" : ""}`}>
      <button className={`icon-btn side-toggle ${sideOpen ? "active" : ""}`} onClick={() => toggleSide()} title={`${sideOpen ? "Hide" : "Show"} history, parts and variables (⌘⌥H)`}>
        <PanelLeft />
      </button>
      <button className="icon-btn" onClick={goHome} title="All projects">
        <House />
      </button>
      <TabStrip />
      <button className="icon-btn" onClick={undo} disabled={!canUndo && !inDialog} title="Undo (⌘Z, or tap with two fingers)">
        <Undo2 />
      </button>
      <button className="icon-btn" onClick={redo} disabled={!canRedo || inDialog} title="Redo (⇧⌘Z, or tap with three fingers)">
        <Redo2 />
      </button>
      <button className="btn" ref={fileBtn} onClick={openFile} title="Import and export">
        File <ChevronDown />
      </button>
      {/* Assistants connect through the desktop app or a browser on a computer, not the iPad app. */}
      {nativeApp ? null : (
        <span className="mcp-anchor">
          <McpButton />
        </span>
      )}
      <CopilotButton />
      <button className="icon-btn" ref={moreBtn} onClick={openMore} title="More: settings, help, projects">
        <Ellipsis />
      </button>
    </header>
  );
}
