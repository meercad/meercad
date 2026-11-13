import {
  Bot,
  Check,
  Search,
  ChevronDown,
  CircleHelp,
  Download,
  Share,
  Ellipsis,
  Eye,
  FileDown,
  FileText,
  History,
  House,
  Info,
  Keyboard,
  Layers,
  PanelLeft,
  Pencil,
  PenLine,
  Rotate3d,
  Plus,
  Printer,
  Redo2,
  Ruler,
  Settings,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { setPrefs, useKey, usePrefs } from "../lib/keymap";
import { useRef } from "react";
import {
  closeTab,
  goHome,
  newProject,
  openProject,
  redo,
  renameProject,
  setDesignUnits,
  toggleSide,
  undo,
  useApp,
} from "../store";
import { featureName } from "../lib/features";
import { useCompact } from "../lib/layout";
import { askText } from "./Ask";
import type { MenuEntry } from "./Menu";
import {
  exportMesh,
  exportRobot,
  exportSketch,
  exportStep,
  exportVariants,
  importFile,
  saveFile,
  sendToSlicer,
  viewInAr,
} from "./io";
import { useSlicers } from "../lib/slicers";
import { openDrawing } from "./DrawingDialog";
import { openVersions } from "./VersionsDialog";
import { openShare } from "./ShareDialog";
import { hasPack } from "../lib/premium";
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

function isDark(): boolean {
  const theme = document.documentElement.dataset["theme"];

  return theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
}

export function toggleTheme(): void {
  const root = document.documentElement;
  root.dataset["theme"] = isDark() ? "light" : "dark";

  try {
    localStorage.setItem("meercad.theme", root.dataset["theme"]);
  } catch {
    // theme just won't persist
  }
}

export const openPalette = (): void => void window.dispatchEvent(new Event("meercad:palette"));

export function TopBar() {
  const sideOpen = useApp((state) => state.sideOpen);
  const canUndo = useApp((state) => state.canUndo);
  const canRedo = useApp((state) => state.canRedo);
  const inDialog = useApp((state) => !!state.dialog);
  const sketches = useApp((state) => state.output?.report.sketches) ?? NONE;
  const features = useApp((state) => state.doc.features);
  const project = useApp((state) => state.project);
  const tabs = useApp((state) => state.tabs);
  const compact = useCompact();
  const nameBtn = useRef<HTMLButtonElement>(null);
  const units = useApp((state) => state.doc.units ?? "mm");
  const variants = useApp((state) => state.doc.variants?.length ?? 0);
  const hasJoints = useApp((state) => (state.doc.mechanism?.joints.length ?? 0) > 0);
  const slicers = useSlicers((s) => s.slicers);
  const searchKey = useKey("palette");
  // Command search for every tool and command; on touch screens this button is the way in.
  const searchBtn = (
    <button
      className="icon-btn"
      onClick={openPalette}
      title={searchKey ? t("Search commands ({key})", { key: searchKey }) : t("Search commands")}
      aria-label={t("Search commands")}
    >
      <Search />
    </button>
  );

  const fileBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);

  const sketchName = (id: string) => {
    const feature = features.find((x) => x.id === id);

    return feature ? featureName(feature) : id;
  };

  const on = (yes: boolean) => (yes ? <Check /> : <span className="menu-icon-gap" />);
  const exportItems = (): MenuEntry[] => [
    { label: t("STL (3D printing)"), icon: <FileDown />, onClick: () => void exportMesh("stl") },
    { label: t("3MF (3D printing)"), icon: <FileDown />, onClick: () => void exportMesh("3mf") },
    {
      label: t("3MF with materials and colours"),
      icon: on(usePrefs.getState().threeMfMaterials),
      onClick: () => setPrefs({ threeMfMaterials: !usePrefs.getState().threeMfMaterials }),
    },
    {
      label: t("OBJ (rendering, other 3D tools)"),
      icon: <FileDown />,
      onClick: () => void exportMesh("obj"),
    },
    { label: t("STEP (CAD exchange)"), icon: <FileDown />, onClick: () => void exportStep() },
    // A design with joints can go to a physics simulator as a robot (MuJoCo, mjlab, ROS, Isaac Sim).
    ...(hasJoints && hasPack("mechanics")
      ? [{ label: t("Robot (MJCF/URDF for simulation)"), icon: <Bot />, onClick: () => void exportRobot() }]
      : []),
    // In the apps AR is a top-level entry; the browser hands out the USDZ file instead.
    ...(nativeApp
      ? []
      : [{ label: t("USDZ (AR on iPhone and iPad)"), icon: <Rotate3d />, onClick: () => void viewInAr() }]),
    "sep",
    ...(hasPack("drawings")
      ? [{ label: t("Technical drawing (PDF, DXF)…"), icon: <FileText />, onClick: openDrawing }]
      : []),
    ...(variants && hasPack("versions")
      ? [
          {
            label: t("All {n} variants (zip)", { n: variants }),
            icon: <Layers />,
            submenu: (["stl", "3mf", "obj", "step"] as const).map((f) => ({
              label: f.toUpperCase(),
              icon: <FileDown />,
              onClick: () => void exportVariants(f),
            })),
          },
        ]
      : []),
    "sep",
    ...sketches.map((sketchView) => ({
      label: sketchName(sketchView.id),
      icon: <PenLine />,
      submenu: [
        { label: t("DXF (laser)"), icon: <FileDown />, onClick: () => exportSketch(sketchView.id, "dxf") },
        { label: "SVG", icon: <FileDown />, onClick: () => exportSketch(sketchView.id, "svg") },
      ],
    })),
  ];
  const fileItems = (): MenuEntry[] => [
    {
      label: t("Import…"),
      title: t("STEP, STL, 3MF, OBJ, DXF or SVG"),
      icon: <Upload />,
      kbd: "Mod+O",
      onClick: () => void importFile(),
    },
    { label: t("Export"), icon: <FileDown />, submenu: exportItems() },
    // Straight into a slicer installed on this Mac, as a 3MF: one submenu, Bambu Studio first; hidden without
    // one.
    ...(slicers.length
      ? [
          {
            label: t("Send to slicer"),
            icon: <Printer />,
            submenu: slicers.map((sl) => ({
              label: sl.name,
              title: t("Opens the model as a 3MF in {name}", { name: sl.name }),
              icon: <Printer />,
              onClick: () => void sendToSlicer(sl.id),
            })),
          },
        ]
      : []),
    ...(nativeApp
      ? [
          {
            label: t("View in AR (real size on the table)"),
            icon: <Rotate3d />,
            onClick: () => void viewInAr(),
          },
        ]
      : []),
    {
      label: t("Units"),
      icon: <Ruler />,
      hint: units,
      submenu: [
        {
          label: t("Millimetres (this design)"),
          icon: on(units === "mm"),
          onClick: () => setDesignUnits("mm"),
        },
        { label: t("Inches (this design)"), icon: on(units === "in"), onClick: () => setDesignUnits("in") },
      ],
    },
    "sep",
    ...(hasPack("versions") ? [{ label: t("Versions…"), icon: <History />, onClick: openVersions }] : []),
    { label: t("Share…"), icon: <Share />, onClick: openShare },
    { label: t("Save copy as .meercad…"), icon: <Download />, kbd: "Shift+Mod+S", onClick: saveFile },
  ];

  const viewItems = (): MenuEntry[] => {
    const prefs = usePrefs.getState();

    return [
      {
        label: t("Dimensions on the model"),
        icon: on(prefs.showValues),
        onClick: () => setPrefs({ showValues: !prefs.showValues }),
      },
      ...(compact
        ? []
        : [
            {
              label: t("Shortcut badges"),
              icon: on(prefs.showKeys),
              onClick: () => setPrefs({ showKeys: !prefs.showKeys }),
            },
          ]),
      { label: t("Dark mode"), icon: on(isDark()), onClick: toggleTheme },
    ];
  };

  const openFile = () => {
    const rect = fileBtn.current!.getBoundingClientRect();
    showMenu(rect.right, rect.bottom + 6, fileItems(), { alignRight: true });
  };

  const openMore = () => {
    const rect = moreBtn.current!.getBoundingClientRect();
    // The phone has no File button: its items come first here.
    showMenu(
      rect.right,
      rect.bottom + 6,
      [
        ...(compact ? [...fileItems(), "sep" as const] : []),
        { label: t("View"), icon: <Eye />, submenu: viewItems() },
        {
          label: t("Settings…"),
          icon: <Settings />,
          kbd: "Mod+,",
          onClick: () => window.dispatchEvent(new Event("meercad:settings")),
        },
        {
          label: t("Help & guides"),
          icon: <CircleHelp />,
          onClick: () => window.dispatchEvent(new Event("meercad:help")),
        },
        ...(compact
          ? []
          : [
              {
                label: t("Keyboard shortcuts"),
                icon: <Keyboard />,
                kbd: "?",
                onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" })),
              },
            ]),
        "sep",
        {
          label: t("About meerCAD, privacy & licences"),
          icon: <Info />,
          onClick: () => window.dispatchEvent(new CustomEvent("meercad:about")),
        },
      ],
      { alignRight: true },
    );
  };

  // Phone: the project name stands in for the tab strip and switches between open projects.
  const openProjects = () => {
    const rect = nameBtn.current!.getBoundingClientRect();
    showMenu(rect.left, rect.bottom + 6, [
      ...tabs.map((tab) => ({
        label: tab.name,
        icon: tab.id === project?.id ? <Check /> : <span className="menu-icon-gap" />,
        onClick: () => void openProject(tab.id),
      })),
      "sep",
      { label: t("New part"), icon: <Plus />, onClick: () => void newProject() },
      {
        label: t("Rename…"),
        icon: <Pencil />,
        onClick: () =>
          void askText({
            title: t("Rename part"),
            label: t("Name"),
            value: project?.name ?? "",
            confirmLabel: t("Rename"),
          }).then((n) => (n?.trim() ? renameProject(n.trim()) : undefined)),
      },
      ...(project ? [{ label: t("Close"), icon: <X />, onClick: () => closeTab(project.id) }] : []),
    ]);
  };

  if (compact) {
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
        {searchBtn}
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
  }

  return (
    <header className={`topbar ${desktop ? "desktop" : ""}`}>
      <button
        className={`icon-btn side-toggle ${sideOpen ? "active" : ""}`}
        onClick={() => toggleSide()}
        title={
          sideOpen
            ? t("Hide history, parts and variables (⌘⌥H)")
            : t("Show history, parts and variables (⌘⌥H)")
        }
      >
        <PanelLeft />
      </button>
      <button className="icon-btn" onClick={goHome} title={t("All projects")}>
        <House />
      </button>
      <TabStrip />
      {searchBtn}
      <button
        className="icon-btn"
        onClick={undo}
        disabled={!canUndo && !inDialog}
        title={t("Undo (⌘Z, or tap with two fingers)")}
      >
        <Undo2 />
      </button>
      <button
        className="icon-btn"
        onClick={redo}
        disabled={!canRedo || inDialog}
        title={t("Redo (⇧⌘Z, or tap with three fingers)")}
      >
        <Redo2 />
      </button>
      <button className="btn" ref={fileBtn} onClick={openFile} title={t("Import and export")}>
        {t("File")} <ChevronDown />
      </button>
      {/* Assistants connect through the Mac app, not the iPad app. */}
      {nativeApp ? null : (
        <span className="mcp-anchor">
          <McpButton />
        </span>
      )}
      <button
        className="icon-btn"
        ref={moreBtn}
        onClick={openMore}
        title={t("More: settings, help, projects")}
      >
        <Ellipsis />
      </button>
    </header>
  );
}
