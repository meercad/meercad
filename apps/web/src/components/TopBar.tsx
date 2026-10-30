import { Check, ChevronDown, CircleHelp, Download, Ellipsis, FileDown, House, Info, Keyboard, Moon, PanelLeft, Pencil, Plus, Redo2, Ruler, Settings, Share2, Undo2, Upload, X } from "lucide-react";
import { setPrefs, usePrefs } from "../lib/keymap";
import { useRef } from "react";
import { closeTab, goHome, newProject, openProject, redo, renameProject, setDesignUnits, toggleSide, undo, useApp } from "../store";
import { featureName } from "../lib/features";
import { useCompact } from "../lib/layout";
import { askText } from "./Ask";
import type { MenuEntry } from "./Menu";
import { exportMesh, exportSketch, exportStep, importFile, saveFile, shareLink } from "./io";
import { openDrawing } from "./DrawingDialog";
import { nativeApp } from "../lib/native";
import { desktop } from "../lib/persistence";
import { McpButton } from "./McpButton";
import { TabStrip } from "./Tabs";
import { showMenu } from "./Menu";
import { t } from "../lib/i18n";

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
      { label: t("Import STEP, STL, 3MF, OBJ, DXF, SVG…"), icon: <Upload />, kbd: "Mod+O", onClick: () => void importFile() },
      "sep",
      { label: t("Export STL (3D printing)"), icon: <FileDown />, onClick: () => void exportMesh("stl") },
      { label: t("Export 3MF (3D printing)"), icon: <FileDown />, onClick: () => void exportMesh("3mf") },
      { label: t("Export STEP (CAD exchange)"), icon: <FileDown />, onClick: () => void exportStep() },
      { label: t("Technical drawing (PDF, DXF)…"), icon: <FileDown />, onClick: openDrawing },
      ...sketches.flatMap((s) => [
        { label: t("Export {name} as DXF (laser)", { name: sketchName(s.id) }), icon: <FileDown />, onClick: () => exportSketch(s.id, "dxf") },
        { label: t("Export {name} as SVG", { name: sketchName(s.id) }), icon: <FileDown />, onClick: () => exportSketch(s.id, "svg") },
      ]),
      "sep",
      { label: `${units === "mm" ? "✓ " : "   "}${t("Millimetres (this design)")}`, icon: <Ruler />, onClick: () => setDesignUnits("mm") },
      { label: `${units === "in" ? "✓ " : "   "}${t("Inches (this design)")}`, icon: <Ruler />, onClick: () => setDesignUnits("in") },
      "sep",
      { label: t("Save copy as .meercad…"), icon: <Download />, kbd: "Shift+Mod+S", onClick: saveFile },
      ...(desktop ? [] : [{ label: t("Copy share link"), icon: <Share2 />, onClick: () => void shareLink() }]),
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
      { label: t("Settings…"), icon: <Settings />, kbd: "Mod+,", onClick: () => window.dispatchEvent(new Event("meercad:settings")) },
      { label: t("Help & guides"), icon: <CircleHelp />, onClick: () => window.dispatchEvent(new Event("meercad:help")) },
      ...(compact ? [] : [{ label: t("Keyboard shortcuts"), icon: <Keyboard />, kbd: "?", onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })) }]),
      { label: usePrefs.getState().showValues ? t("Hide dimensions on the model") : t("Show dimensions on the model"), icon: <Ruler />, onClick: () => setPrefs({ showValues: !usePrefs.getState().showValues }) },
      ...(compact ? [] : [{ label: usePrefs.getState().showKeys ? t("Hide shortcut badges") : t("Show shortcut badges"), icon: <Keyboard />, onClick: () => setPrefs({ showKeys: !usePrefs.getState().showKeys }) }]),
      { label: t("Toggle dark mode"), icon: <Moon />, onClick: toggleTheme },
      "sep",
      { label: t("About meerCAD, privacy & licences"), icon: <Info />, onClick: () => window.dispatchEvent(new CustomEvent("meercad:about")) },
    ]);
  };

  // Phone: the project name stands in for the tab strip and switches between open projects.
  const openProjects = () => {
    const r = nameBtn.current!.getBoundingClientRect();
    showMenu(r.left, r.bottom + 6, [
      ...tabs.map((t) => ({ label: t.name, icon: t.id === project?.id ? <Check /> : <span />, onClick: () => void openProject(t.id) })),
      "sep",
      { label: t("New part"), icon: <Plus />, onClick: () => void newProject() },
      {
        label: t("Rename…"),
        icon: <Pencil />,
        onClick: () => void askText({ title: t("Rename part"), label: t("Name"), value: project?.name ?? "", confirmLabel: t("Rename") }).then((n) => (n?.trim() ? renameProject(n.trim()) : undefined)),
      },
      ...(project ? [{ label: t("Close"), icon: <X />, onClick: () => closeTab(project.id) }] : []),
    ]);
  };
  if (compact)
    return (
      <header className="topbar compact">
        <button className="icon-btn" onClick={goHome} title={t("All projects")}>
          <House />
        </button>
        <button className="doc-switch" ref={nameBtn} onClick={openProjects} title={t("Open projects")}>
          <span>{project?.name ?? t("Untitled part")}</span>
          <ChevronDown />
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={undo} disabled={!canUndo && !inDialog} title={t("Undo")}>
          <Undo2 />
        </button>
        <button className="icon-btn" onClick={redo} disabled={!canRedo || inDialog} title={t("Redo")}>
          <Redo2 />
        </button>
        <button className="icon-btn" ref={moreBtn} onClick={openMore} title={t("File, settings, help")}>
          <Ellipsis />
        </button>
      </header>
    );

  return (
    <header className={`topbar ${desktop ? "desktop" : ""}`}>
      <button className={`icon-btn side-toggle ${sideOpen ? "active" : ""}`} onClick={() => toggleSide()} title={sideOpen ? t("Hide history, parts and variables (⌘⌥H)") : t("Show history, parts and variables (⌘⌥H)")}>
        <PanelLeft />
      </button>
      <button className="icon-btn" onClick={goHome} title={t("All projects")}>
        <House />
      </button>
      <TabStrip />
      <button className="icon-btn" onClick={undo} disabled={!canUndo && !inDialog} title={t("Undo (⌘Z, or tap with two fingers)")}>
        <Undo2 />
      </button>
      <button className="icon-btn" onClick={redo} disabled={!canRedo || inDialog} title={t("Redo (⇧⌘Z, or tap with three fingers)")}>
        <Redo2 />
      </button>
      <button className="btn" ref={fileBtn} onClick={openFile} title={t("Import and export")}>
        {t("File")} <ChevronDown />
      </button>
      {/* Assistants connect through the desktop app or a browser on a computer, not the iPad app. */}
      {nativeApp ? null : (
        <span className="mcp-anchor">
          <McpButton />
        </span>
      )}
      <button className="icon-btn" ref={moreBtn} onClick={openMore} title={t("More: settings, help, projects")}>
        <Ellipsis />
      </button>
    </header>
  );
}
