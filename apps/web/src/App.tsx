import { useEffect, useState } from "react";
import { decodeShareFragment } from "@opencad/io";
import { validateDocument } from "@opencad/schema";
import { CopilotPanel } from "./components/Copilot";
import { FeatureDialog } from "./components/FeatureDialog";
import { deleteFeature, SidePanel } from "./components/FeatureTree";
import { Home } from "./components/Home";
import { MenuHost } from "./components/Menu";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Toasts } from "./components/Toasts";
import { Toolbar } from "./components/Toolbar";
import { TopBar } from "./components/TopBar";
import { ViewportView } from "./components/ViewportView";
import { importFile } from "./components/io";
import { initBridge } from "./lib/mcpBridge";
import { desktop } from "./lib/persistence";
import { saveFile } from "./components/io";
import { FEATURES } from "./lib/features";
import { cancelDialog, commitDialog, editFeature, getViewport, goHome, newProject, openProject, redo, startFeature, toast, undo, useApp } from "./store";

try {
  const theme = localStorage.getItem("opencad.theme");
  if (theme) document.documentElement.dataset["theme"] = theme;
} catch {
  // default theme
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
  if (m) await openProject(decodeURIComponent(m[1]!));
}

export function App() {
  const screen = useApp((s) => s.screen);
  const copilot = useApp((s) => s.copilotOpen);
  const [help, setHelp] = useState(false);
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
    });
    const offOpen = desktop.on("open-project", (id) => void openProject(id));
    return () => {
      offMenu();
      offOpen();
    };
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
      if ((e.metaKey || e.ctrlKey) && !typing) {
        const k = e.key.toLowerCase();
        if (k === "z") {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (k === "y") {
          e.preventDefault();
          redo();
        } else if (k === "o") {
          e.preventDefault();
          void importFile();
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
      if ((e.key === "Delete" || e.key === "Backspace") && s.selectedFeature) {
        const f = s.doc.features.find((x) => x.id === s.selectedFeature);
        if (f) deleteFeature(f);
        return;
      }
      if (e.key === "Enter" && s.selectedFeature) return editFeature(s.selectedFeature);
      const k = e.key.toLowerCase();
      if (k === "m") return useApp.setState({ measure: { active: !s.measure.active, picks: [], result: null } });
      if (k === "z") return getViewport()?.fit();
      for (const [op, meta] of Object.entries(FEATURES)) {
        if (meta.shortcut?.toLowerCase() === k) return startFeature(op as keyof typeof FEATURES);
      }
      const views: Record<string, Parameters<NonNullable<ReturnType<typeof getViewport>>["setView"]>[0]> = { "1": "front", "2": "back", "3": "left", "4": "right", "5": "top", "6": "bottom", "0": "iso" };
      if (views[k]) getViewport()?.setView(views[k]!);
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
        <div className="app">
          <TopBar />
          <Toolbar />
          <SidePanel />
          <div className="view-wrap" style={{ gridArea: "view", position: "relative", minWidth: 0, minHeight: 0, display: "flex" }}>
            <ViewportView />
            <FeatureDialog />
          </div>
          <div className="right">{copilot ? <CopilotPanel /> : null}</div>
        </div>
      )}
      {help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null}
      <Toasts />
      <MenuHost />
    </>
  );
}
