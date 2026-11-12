import { MotionPanel } from "./components/MotionPanel";
import { toggleJoints, useMotion } from "./lib/mechanism";
import { hasPack } from "./lib/premium";
import { useEffect, useState } from "react";
import { validateDocument } from "@meercad/schema";
import { copyParts, cutParts, duplicateParts, pasteParts, selectAll } from "./lib/clipboard";
import { FeatureDialog } from "./components/FeatureDialog";
import { deleteFeature, SidePanel } from "./components/FeatureTree";
import { Home } from "./components/Home";
import { MenuHost } from "./components/Menu";
import { AskHost } from "./components/Ask";
import { Settings } from "./components/Settings";
import { Tasks } from "./components/Tasks";
import { FirstRun } from "./components/FirstRun";
import { HelpPanel } from "./components/Help";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Tour, tourDone } from "./components/Tour";
import { TermsGate } from "./components/TermsGate";
import { termsAccepted } from "./lib/termsStore";
import { Toasts } from "./components/Toasts";
import { openPalette, TopBar } from "./components/TopBar";
import { Toolbar } from "./components/Toolbar";
import { ViewportView } from "./components/ViewportView";
import { importFile } from "./components/io";
import { initBridge } from "./lib/mcpBridge";
import { nativeApp, onFileOpened, Pencil } from "./lib/native";
import { assistantWindow, desktop } from "./lib/persistence";
import { startBackgroundPictures } from "./lib/thumbnails";
import { EXAMPLES } from "./lib/examples";
import { setTool, useSketchUi, type SketchTool } from "./sketch/state";
import { saveFile } from "./components/io";
import { actionFor, MODEL_ACTIONS, MODEL_CONTEXT, type ModelAction } from "./lib/keymap";
import type { FeatureOp } from "@meercad/schema";
import { closeTab, cycleTab, dropCachedTab, handOverAssistantTab, reopenClosedTab, toggleSide } from "./store";
import { AssistantPane } from "./components/AssistantTab";
import { cancelDialog, commitDialog, editFeature, getViewport, goHome, hideSelectedParts, lastStartedFeature, newProject, openProject, redo, startFeature, startSketch, toast, undo, useApp } from "./store";
import { planeSpecForPick } from "./lib/topology";
import type { StandardView } from "@meercad/viewport";
import { CommandPalette } from "./components/CommandPalette";
import { DebugHud, debugHud } from "./components/DebugHud";
import { deleteModelSelection } from "./lib/deletion";
import { AboutDialog } from "./components/AboutDialog";
import { DrawingDialog } from "./components/DrawingDialog";
import { VersionsDialog } from "./components/VersionsDialog";
import { openShare, ShareDialog } from "./components/ShareDialog";
import { MaterialPicker } from "./components/MaterialPicker";
import { AiLock } from "./components/AiLock";
import { isCompact } from "./lib/layout";
import { t } from "./lib/i18n";

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
      return openPalette();
    case "repeat": {
      const op = lastStartedFeature();
      return op ? startFeature(op) : undefined;
    }
    case "hide":
      return hideSelectedParts();
    case "unhide_all":
      return useApp.setState({ hidden: new Set() });
    case "fit":
      return vp?.fit();
    case "normal":
      if (hovered?.kind === "face" && hovered.normal) vp?.viewFrom(hovered.normal);
      return;
    case "measure":
      return useApp.setState({ measure: { active: !s.measure.active, picks: [], result: null } });
    case "joints":
      return hasPack("mechanics") || s.doc.mechanism?.joints.length ? toggleJoints() : undefined;
    case "sketch":
      if (hovered && (hovered.kind === "plane" || (hovered.kind === "face" && hovered.normal))) {
        const spec = planeSpecForPick(hovered, s.output?.meshes ?? []);
        if (spec) return startSketch(spec);
      }
      return startFeature("sketch");
    default:
      if ((action === "gear" || action === "spring") && !hasPack("mechanics")) return;
      return startFeature(action as FeatureOp);
  }
}

async function route(): Promise<void> {
  const hash = location.hash;
  const m = /^#\/p\/(.+)$/.exec(hash);
  const s = useApp.getState();
  if (m) {
    const id = decodeURIComponent(m[1]!);
    if (s.screen !== "editor" || s.project?.id !== id) await openProject(id);
  } else if (s.screen === "editor") goHome();
}

export function App() {
  const screen = useApp((s) => s.screen);
  const assistantTab = useApp((s) => s.assistantTab);
  const sideOpen = useApp((s) => s.sideOpen);
  const motionOpen = useMotion((s) => s.open);
  const sheet = useApp((s) => !!s.dialog || s.measure.active) || motionOpen;
  const [help, setHelp] = useState(false);
  const [guide, setGuide] = useState(false);
  const [tour, setTour] = useState(false);
  // First start: the terms of use come before anything else (an assistant's tab only exists once they are accepted).
  const [terms, setTerms] = useState(() => !assistantWindow && !termsAccepted());
  // First time in the editor: offer the introduction tour.
  useEffect(() => {
    if (!terms && screen === "editor" && !tourDone() && !isCompact() && !assistantWindow) setTour(true);
  }, [screen, terms]);
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
  // Missing and outdated project pictures are made in the background from the start (one window does it).
  useEffect(() => {
    if (!assistantWindow) startBackgroundPictures(EXAMPLES);
  }, []);
  useEffect(() => {
    void route();
    initBridge();
    if (!desktop) return;
    document.documentElement.classList.add("is-desktop");
    if (assistantWindow) document.documentElement.classList.add("in-assistant-tab");
    const offMenu = desktop.on("menu", (cmd) => {
      // Before the terms of use are accepted, the menu bar does nothing behind them.
      if (!termsAccepted()) return;
      // While an assistant works on the model, the menu commands wait too.
      if (useApp.getState().aiLock && cmd !== "shortcuts") return;
      if (cmd === "new") void newProject();
      else if (cmd === "import") void importFile();
      else if (cmd === "home") goHome();
      else if (cmd === "save-as" && useApp.getState().project) saveFile();
      else if (cmd === "share" && useApp.getState().project) openShare();
      else if (cmd === "shortcuts") setHelp((h) => !h);
      else if (cmd === "settings") window.dispatchEvent(new Event("meercad:settings"));
      else if (cmd === "close-tab") closeCurrentTab();
      else if (cmd === "reopen-tab") reopenClosedTab();
      else if (cmd === "next-tab" || cmd === "prev-tab") cycleTab(cmd === "next-tab" ? 1 : -1);
      else if (cmd === "cut" || cmd === "copy" || cmd === "paste" || cmd === "selectAll" || cmd === "duplicate") {
        // Text in a field (or selected on the page) is edited as text; otherwise the command acts on parts.
        const el = document.activeElement;
        const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement | null)?.isContentEditable || !!window.getSelection()?.toString();
        if (text || useApp.getState().screen !== "editor") {
          if (cmd !== "duplicate") void desktop?.editNative(cmd);
        } else partCommand(cmd);
      } else if (cmd === "undo" || cmd === "redo") {
        // In a text field the menu undoes typing; everywhere else it undoes the model.
        const el = document.activeElement;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) document.execCommand(cmd);
        else if (cmd === "undo") undo();
        else redo();
      }
    });
    const offOpen = desktop.on("open-project", (id) => void openProject(id));
    const offError = desktop.on("error", (msg) => toast(msg, "error"));
    const offChanged = desktop.on("projects-changed", () => window.dispatchEvent(new Event("meercad:projects-changed")));
    // Another window saved a project: a copy kept here for a background tab is stale.
    const offSaved = desktop.on("project-saved", (id) => dropCachedTab(id));
    return () => {
      offMenu();
      offOpen();
      offError();
      offChanged();
      offSaved();
    };
  }, []);
  // iPad app: .meercad files opened from the Files app, and Apple Pencil double-tap / squeeze,
  // which switches a sketch between Select and the drawing tool used last.
  useEffect(() => {
    if (!nativeApp) return;
    document.documentElement.classList.add("native");
    const offOpen = onFileOpened((file) => {
      if ("id" in file) return void openProject(file.id);
      try {
        const v = validateDocument(JSON.parse(file.text));
        if (!v.ok) return toast(t("Not a valid meerCAD file: {msg}", { msg: v.errors[0]! }), "error");
        void newProject(v.value, file.name);
      } catch {
        toast(t("Could not read {name}", { name: file.name }), "error");
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
      if (k === "w" && !e.shiftKey && (useApp.getState().project || useApp.getState().assistantTab)) return run(closeCurrentTab);
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
        } else if (!desktop && !e.shiftKey && !e.altKey && (k === "a" || k === "c" || k === "x" || k === "v" || k === "d") && !s.sketchId && !s.dialog) {
          // The iPad with a keyboard (on the Mac the Edit menu sends these).
          e.preventDefault();
          partCommand(({ a: "selectAll", c: "copy", x: "cut", v: "paste", d: "duplicate" } as const)[k]);
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
      // Every key goes through the active control scheme (lib/controls).
      const action = actionFor(e, MODEL_CONTEXT);
      if (!action) return;
      if (action === "cancel") {
        if (s.dialog) return cancelDialog();
        if (s.pickingSketchPlane) return useApp.setState({ pickingSketchPlane: false });
        if (s.measure.active) return useApp.setState({ measure: { active: false, picks: [], result: null } });
        if (useMotion.getState().draft) return useMotion.setState({ draft: null });
        if (useMotion.getState().open) return toggleJoints();
        return useApp.setState({ selection: [], selectedFeature: null });
      }
      if (action === "confirm" && s.dialog) return void commitDialog();
      if (s.dialog) return;
      if (action === "delete") {
        e.preventDefault();
        if (s.selection.length || s.selectedFeature) void deleteModelSelection();
        return;
      }
      if (action === "confirm") {
        if (s.selectedFeature) editFeature(s.selectedFeature);
        return;
      }
      if (action === "select_all") {
        e.preventDefault();
        return partCommand("selectAll");
      }
      e.preventDefault();
      runModelAction(action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      // Nothing is imported behind the terms of use.
      if (!termsAccepted()) return;
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
      <AiLock />
      {assistantTab ? (
        <AssistantPane session={assistantTab} />
      ) : screen === "home" ? (
        <Home />
      ) : (
        <div className={`app ${sideOpen ? "side-open" : ""} ${sheet ? "has-sheet" : ""}`}>
          {/* An assistant's tab has its bar at the bottom (AiLock) instead: the window's page shows the tabs above it. */}
          {assistantWindow ? null : <TopBar />}
          {sideOpen ? <SidePanel /> : null}
          <div className="right">{guide ? <HelpPanel onClose={() => setGuide(false)} onTour={() => (setGuide(false), setTour(true))} onShortcuts={() => setHelp(true)} /> : null}</div>
          <div className="view-wrap" style={{ gridArea: "view", position: "relative", minWidth: 0, minHeight: 0, display: "flex" }}>
            <ViewportView />
            <Toolbar />
            <FeatureDialog />
            <MotionPanel />
          </div>
        </div>
      )}
      {help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null}
      <CommandPalette onHelp={() => setGuide(true)} onShortcuts={() => setHelp(true)} onTour={() => setTour(true)} />
      {tour && screen === "editor" ? <Tour onClose={() => setTour(false)} /> : null}
      <Tasks />
      <Toasts />
      <Settings onShortcuts={() => setHelp(true)} />
      <AboutDialog />
      <DrawingDialog />
      <VersionsDialog />
      <ShareDialog />
      <MaterialPicker />
      {desktop && !terms ? <FirstRun /> : null}
      <MenuHost />
      <AskHost />
      {terms ? <TermsGate onAccept={() => setTerms(false)} /> : null}
      {debugHud ? <DebugHud /> : null}
    </>
  );
}

/** ⌘W: closes the open tab, also an assistant's (it stops working on it; its project is saved). */
function closeCurrentTab(): void {
  const s = useApp.getState();
  if (s.assistantTab) void handOverAssistantTab(s.assistantTab, false);
  else if (s.project) closeTab(s.project.id);
}

/** Select all, copy, cut, paste or duplicate whole parts (see lib/clipboard). */
function partCommand(cmd: "cut" | "copy" | "paste" | "selectAll" | "duplicate"): void {
  const s = useApp.getState();
  if (s.screen !== "editor" || s.sketchId || s.dialog) return;
  if (cmd === "selectAll") selectAll();
  else if (cmd === "copy") copyParts();
  else if (cmd === "cut") cutParts();
  else if (cmd === "paste") void pasteParts();
  else duplicateParts();
}
