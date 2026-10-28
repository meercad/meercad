import { ChevronDown, CircleHelp, Download, Ellipsis, FileDown, House, Info, Keyboard, Moon, PanelLeft, Redo2, Ruler, Settings, Share2, Undo2, Upload } from "lucide-react";
import { setPrefs, usePrefs } from "../lib/keymap";
import { useRef } from "react";
import { goHome, redo, setDesignUnits, toggleSide, undo, useApp } from "../store";
import { exportMesh, exportSketch, exportStep, importFile, saveFile, shareLink } from "./io";
import { nativeApp } from "../lib/native";
import { desktop } from "../lib/persistence";
import { McpButton } from "./McpButton";
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
  const units = useApp((s) => s.doc.units ?? "mm");

  const fileBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const openFile = () => {
    const r = fileBtn.current!.getBoundingClientRect();
    showMenu(r.right - 240, r.bottom + 6, [
      { label: "Import STEP, STL, DXF, SVG…", icon: <Upload />, kbd: "Mod+O", onClick: () => void importFile() },
      "sep",
      { label: "Export STL (3D printing)", icon: <FileDown />, onClick: () => void exportMesh("stl") },
      { label: "Export 3MF (3D printing)", icon: <FileDown />, onClick: () => void exportMesh("3mf") },
      { label: "Export STEP (CAD exchange)", icon: <FileDown />, onClick: () => void exportStep() },
      ...sketches.flatMap((s) => [
        { label: `Export ${s.id} as DXF (laser)`, icon: <FileDown />, onClick: () => exportSketch(s.id, "dxf") },
        { label: `Export ${s.id} as SVG`, icon: <FileDown />, onClick: () => exportSketch(s.id, "svg") },
      ]),
      "sep",
      { label: `${units === "mm" ? "✓ " : "   "}Millimetres (this design)`, icon: <Ruler />, onClick: () => setDesignUnits("mm") },
      { label: `${units === "in" ? "✓ " : "   "}Inches (this design)`, icon: <Ruler />, onClick: () => setDesignUnits("in") },
      "sep",
      { label: "Save copy as .meercad…", icon: <Download />, kbd: "Shift+Mod+S", onClick: saveFile },
      ...(desktop ? [] : [{ label: "Copy share link", icon: <Share2 />, onClick: () => void shareLink() }]),
    ]);
  };
  const openMore = () => {
    const r = moreBtn.current!.getBoundingClientRect();
    showMenu(r.right - 240, r.bottom + 6, [
      { label: "Settings…", icon: <Settings />, kbd: "Mod+,", onClick: () => window.dispatchEvent(new Event("meercad:settings")) },
      { label: "Help & guides", icon: <CircleHelp />, onClick: () => window.dispatchEvent(new Event("meercad:help")) },
      { label: "Keyboard shortcuts", icon: <Keyboard />, kbd: "?", onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })) },
      { label: `${usePrefs.getState().showValues ? "Hide" : "Show"} dimensions on the model`, icon: <Ruler />, onClick: () => setPrefs({ showValues: !usePrefs.getState().showValues }) },
      { label: `${usePrefs.getState().showKeys ? "Hide" : "Show"} shortcut badges`, icon: <Keyboard />, onClick: () => setPrefs({ showKeys: !usePrefs.getState().showKeys }) },
      { label: "Toggle dark mode", icon: <Moon />, onClick: toggleTheme },
      "sep",
      { label: "About meerCAD, privacy & licences", icon: <Info />, onClick: () => window.dispatchEvent(new CustomEvent("meercad:about")) },
    ]);
  };

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
      <button className="icon-btn" ref={moreBtn} onClick={openMore} title="More: settings, help, projects">
        <Ellipsis />
      </button>
    </header>
  );
}
