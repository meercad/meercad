import { useEffect, useState } from "react";
import { decodeShareFragment } from "@meercad/io";
import { validateDocument } from "@meercad/schema";
import { FeatureDialog } from "./components/FeatureDialog";
import { deleteFeature, SidePanel } from "./components/FeatureTree";
import { Home } from "./components/Home";
import { MenuHost } from "./components/Menu";
import { AskHost } from "./components/Ask";
import { Settings } from "./components/Settings";
import { FirstRun } from "./components/FirstRun";
import { HelpPanel } from "./components/Help";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Tour, tourDone } from "./components/Tour";
import { Toasts } from "./components/Toasts";
import { UpdateBanner } from "./components/UpdateBanner";
import { TopBar } from "./components/TopBar";
import { Toolbar } from "./components/Toolbar";
import { ViewportView } from "./components/ViewportView";
import { importFile } from "./components/io";
import { initBridge } from "./lib/mcpBridge";
import { nativeApp, onFileOpened, Pencil } from "./lib/native";
import { desktop } from "./lib/persistence";
import { setTool, useSketchUi, type SketchTool } from "./sketch/state";
import { saveFile } from "./components/io";
import { actionFor, MODEL_ACTIONS, type ModelAction } from "./lib/keymap";
import type { FeatureOp } from "@meercad/schema";
import { closeTab, cycleTab, reopenClosedTab, toggleSide } from "./store";
import { cancelDialog, commitDialog, editFeature, getViewport, goHome, newProject, openProject, redo, startFeature, startSketch, toast, undo, useApp } from "./store";
import { planeSpecForPick } from "./lib/topology";
import type { StandardView } from "@meercad/viewport";
import { CommandPalette } from "./components/CommandPalette";
import { DebugHud, debugHud } from "./components/DebugHud";
import { deleteModelSelection } from "./lib/deletion";
import { AboutDialog } from "./components/AboutDialog";
import { isCompact } from "./lib/layout";

try {
  const theme = localStorage.getItem("meercad.theme");
  if (theme) document.documentElement.dataset["theme"] = theme;
} catch {
  // default theme
}

/** Runs a keyboard action from the active shortcut preset (see lib/keymap). */
function runModelAction(action: ModelAction): void {
  const s = useApp.getState();
  const vp = getViewport();
  const hovered = vp?.hovered ?? null;
  if (action.startsWith("view.")) return vp?.setView(action.slice(5) as StandardView);
  switch (action) {
    case "palette":
      return void window.dispatchEvent(new Event("meercad:palette"));
    case "fit":
      return vp?.fit();
    case "normal":
      if (hovered?.kind === "face" && hovered.normal) vp?.viewFrom(hovered.normal);
      return;
    case "measure":
      return useApp.setState({ measure: { active: !s.measure.active, picks: [], result: null } });
    case "sketch":
      if (hovered && (hovered.kind === "plane" || (hovered.kind === "face" && hovered.normal))) {
        const spec = planeSpecForPick(hovered, s.output?.meshes ?? []);
        if (spec) return startSketch(spec);
      }
      return startFeature("sketch");
    default:
      return startFeature(action as FeatureOp);
  }
}

async function route(): Promise<void> {
  const hash = location.hash;
  if (hash.startsWith("#m1.")) {
    try {
      const v = validateDocument(await decodeShareFragment(hash));
      if (!v.ok) throw new Error(v.errors[0]);
      await newProject(v.value, "Shared part");
      toast("Opened a shared model as a new project in this browser");
    } catch (e) {
      toast(`Could not open share link: ${e instanceof Error ? e.message : String(e)}`, "error");
      history.replaceState(null, "", "#/");
    }
    return;
  }
  const m = /^#\/p\/(.+)$/.exec(hash);
  const s = useApp.getState();
  if (m) {
    const id = decodeURIComponent(m[1]!);
    if (s.screen !== "editor" || s.project?.id !== id) await openProject(id);
  } else if (s.screen === "editor") goHome();
}

export function App() {
  const screen = useApp((s) => s.screen);
  const sideOpen = useApp((s) => s.sideOpen);
  const sheet = useApp((s) => !!s.dialog || s.measure.active);
  const sketching = useApp((s) => !!s.sketchId);
  const [help, setHelp] = useState(false);
  const [guide, setGuide] = useState(false);
  const [tour, setTour] = useState(false);
  // First time in the editor: offer the introduction tour.
  useEffect(() => {
    if (screen === "editor" && !tourDone() && !isCompact()) setTour(true);
  }, [screen]);
  useEffect(() => {
    const open = () => setGuide((g) => !g);
    window.addEventListener("meercad:help", open);
    return () => window.removeEventListener("meercad:help", open);
  }, []);
  useEffect(() => {
    // Back/forward and pasted links move between projects and home.
    const onHash = () => void route();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    void route();
    initBridge();
    if (!desktop) return;
    document.documentElement.classList.add("is-desktop");
    const offMenu = desktop.on("menu", (cmd) => {
      if (cmd === "new") void newProject();
      else if (cmd === "import") void importFile();
      else if (cmd === "home") goHome();
      else if (cmd === "save-as" && useApp.getState().project) saveFile();
      else if (cmd === "shortcuts") setHelp((h) => !h);
      else if (cmd === "settings") window.dispatchEvent(new Event("meercad:settings"));
      else if (cmd === "close-tab" && useApp.getState().project) closeTab(useApp.getState().project!.id);
      else if (cmd === "reopen-tab") reopenClosedTab();
      else if (cmd === "next-tab" || cmd === "prev-tab") cycleTab(cmd === "next-tab" ? 1 : -1);
      else if (cmd === "undo" || cmd === "redo") {
        // In a text field the menu undoes typing; everywhere else it undoes the model.
        const el = document.activeElement;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) document.execCommand(cmd);
        else if (cmd === "undo") undo();
        else redo();
      }
    });
    const offOpen = desktop.on("open-project", (id) => void openProject(id));
    const offError = desktop.on("error", (msg) => toast(msg, "error"));
    return () => {
      offMenu();
      offOpen();
      offError();
    };
  }, []);
  // iPad app: .meercad files opened from the Files app, and Apple Pencil double-tap / squeeze,
  // which switches a sketch between Select and the drawing tool used last.
  useEffect(() => {
    if (!nativeApp) return;
    document.documentElement.classList.add("native");
    const offOpen = onFileOpened((t) => {
      if ("id" in t) return void openProject(t.id);
      try {
        const v = validateDocument(JSON.parse(t.text));
        if (!v.ok) return toast(`Not a valid meerCAD file: ${v.errors[0]}`, "error");
        void newProject(v.value, t.name);
      } catch {
        toast(`Could not read ${t.name}`, "error");
      }
    });
    let lastTool: SketchTool = "line";
    const pencil = Pencil.addListener("tap", () => {
      if (!useApp.getState().sketchId) return;
      const { tool } = useSketchUi.getState();
      if (tool === "select") return setTool(lastTool);
      lastTool = tool;
      setTool("select");
    });
    return () => {
      offOpen();
      void pencil.then((s) => s.remove(), () => undefined);
    };
  }, []);
  // Tabs: the usual browser/editor keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => (e.preventDefault(), e.stopImmediatePropagation(), fn());
      if (e.ctrlKey && e.key === "Tab") return run(() => cycleTab(e.shiftKey ? -1 : 1));
      if (!mod) return;
      if (k === "t" && e.shiftKey) return run(reopenClosedTab);
      if (k === "t" && !e.altKey) return run(() => void newProject());
      if (k === "w" && !e.shiftKey && useApp.getState().project) return run(() => closeTab(useApp.getState().project!.id));
      if (e.shiftKey && (e.code === "BracketRight" || e.code === "BracketLeft")) return run(() => cycleTab(e.code === "BracketRight" ? 1 : -1));
      if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) return run(() => cycleTab(e.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "?" && !typing) setHelp((h) => !h);
      if (e.key === "Escape") setHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if (s.screen !== "editor") return;
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      // The desktop Edit menu no longer does text undo itself (its Undo acts on the model).
      if ((e.metaKey || e.ctrlKey) && typing && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        document.execCommand(e.shiftKey ? "redo" : "undo");
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !typing) {
        const k = e.key.toLowerCase();
        if (k === "z") {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (k === "y") {
          e.preventDefault();
          redo();
        } else if (k === "h" && e.altKey) {
          e.preventDefault();
          toggleSide();
        } else if (k === "\\") {
          e.preventDefault();
          toggleSide();
        } else if (k === "o") {
          e.preventDefault();
          void importFile();
        } else {
          const action = actionFor(e, MODEL_ACTIONS);
          if (action) {
            e.preventDefault();
            runModelAction(action);
          }
        }
        return;
      }
      if (typing || s.sketchId) return;
      if (e.key === "Escape") {
        if (s.dialog) return cancelDialog();
        if (s.pickingSketchPlane) return useApp.setState({ pickingSketchPlane: false });
        if (s.measure.active) return useApp.setState({ measure: { active: false, picks: [], result: null } });
        return useApp.setState({ selection: [], selectedFeature: null });
      }
      if (e.key === "Enter" && s.dialog) return void commitDialog();
      if (s.dialog) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (s.selection.length || s.selectedFeature) void deleteModelSelection();
        return;
      }
      if (e.key === "Enter" && s.selectedFeature) return editFeature(s.selectedFeature);
      const action = actionFor(e, MODEL_ACTIONS);
      if (action) {
        e.preventDefault();
        runModelAction(action);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      void importFile(e.dataTransfer.files[0]);
    };
    const onOver = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && e.preventDefault();
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragover", onOver);
    return () => {
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragover", onOver);
    };
  }, []);

  return (
    <>
      {screen === "home" ? (
        <Home />
      ) : (
        <div className={`app ${sideOpen ? "side-open" : ""} ${sheet ? "has-sheet" : ""} ${sketching ? "sketching" : ""}`}>
          <TopBar />
          {sideOpen ? <SidePanel /> : null}
          <div className="right">{guide ? <HelpPanel onClose={() => setGuide(false)} onTour={() => (setGuide(false), setTour(true))} onShortcuts={() => setHelp(true)} /> : null}</div>
          <div className="view-wrap" style={{ gridArea: "view", position: "relative", minWidth: 0, minHeight: 0, display: "flex" }}>
            <ViewportView />
            <Toolbar />
            <FeatureDialog />
          </div>
        </div>
      )}
      {help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null}
      <CommandPalette onHelp={() => setGuide(true)} onShortcuts={() => setHelp(true)} onTour={() => setTour(true)} />
      {tour && screen === "editor" ? <Tour onClose={() => setTour(false)} /> : null}
      <UpdateBanner />
      <Toasts />
      <Settings onShortcuts={() => setHelp(true)} />
      <AboutDialog />
      {desktop ? <FirstRun /> : null}
      <MenuHost />
      <AskHost />
      {debugHud ? <DebugHud /> : null}
    </>
  );
}
