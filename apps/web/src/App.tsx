import { useEffect, useState } from "react";
import { decodeShareFragment } from "@leocad/io";
import { validateDocument } from "@leocad/schema";
import { FeatureDialog } from "./components/FeatureDialog";
import { deleteFeature, SidePanel } from "./components/FeatureTree";
import { Home } from "./components/Home";
import { MenuHost } from "./components/Menu";
import { HelpPanel } from "./components/Help";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { Tour, tourDone } from "./components/Tour";
import { Toasts } from "./components/Toasts";
import { Toolbar } from "./components/Toolbar";
import { TopBar } from "./components/TopBar";
import { ViewportView } from "./components/ViewportView";
import { importFile } from "./components/io";
import { initBridge } from "./lib/mcpBridge";
import { desktop } from "./lib/persistence";
import { saveFile } from "./components/io";
import { FEATURES } from "./lib/features";
import { cancelDialog, commitDialog, editFeature, getViewport, goHome, newProject, openProject, redo, startFeature, startSketch, toast, undo, useApp } from "./store";
import { planeSpecForPick } from "./lib/topology";
import type { StandardView } from "@leocad/viewport";
import { CommandPalette } from "./components/CommandPalette";

try {
  const theme = localStorage.getItem("leocad.theme");
  if (theme) document.documentElement.dataset["theme"] = theme;
} catch {
  // default theme
}

/** Shapr3D view numbering: 1 reset/iso, 2 front, 3 back, 4 top, 5 bottom, 6 right, 7 left. */
const VIEW_KEYS: Record<string, StandardView> = { "1": "iso", "2": "front", "3": "back", "4": "top", "5": "bottom", "6": "right", "7": "left" };

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
  const [help, setHelp] = useState(false);
  const [guide, setGuide] = useState(false);
  const [tour, setTour] = useState(false);
  // First time in the editor: offer the introduction tour.
  useEffect(() => {
    if (screen === "editor" && !tourDone()) setTour(true);
  }, [screen]);
  useEffect(() => {
    const open = () => setGuide((g) => !g);
    window.addEventListener("leocad:help", open);
    return () => window.removeEventListener("leocad:help", open);
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
        } else if (VIEW_KEYS[k]) {
          e.preventDefault();
          getViewport()?.setView(VIEW_KEYS[k]!);
        } else if (k === "f") {
          e.preventDefault();
          window.dispatchEvent(new Event("leocad:palette"));
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
      if (k === "x") return window.dispatchEvent(new Event("leocad:palette"));
      const hovered = getViewport()?.hovered ?? null;
      if (e.key === " " && hovered?.kind === "face" && hovered.normal) {
        e.preventDefault();
        return getViewport()?.viewFrom(hovered.normal);
      }
      if (k === "s" && hovered && (hovered.kind === "plane" || (hovered.kind === "face" && hovered.normal))) {
        const spec = planeSpecForPick(hovered, s.output?.meshes ?? []);
        if (spec) return startSketch(spec);
      }
      if (k === "m") return useApp.setState({ measure: { active: !s.measure.active, picks: [], result: null } });
      if (k === "z") return getViewport()?.fit();
      for (const [op, meta] of Object.entries(FEATURES)) {
        if (meta.shortcut?.toLowerCase() === k) return startFeature(op as keyof typeof FEATURES);
      }
      if (VIEW_KEYS[k]) getViewport()?.setView(VIEW_KEYS[k]!);
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
          <div className="right">{guide ? <HelpPanel onClose={() => setGuide(false)} onTour={() => (setGuide(false), setTour(true))} onShortcuts={() => setHelp(true)} /> : null}</div>
          <div className="view-wrap" style={{ gridArea: "view", position: "relative", minWidth: 0, minHeight: 0, display: "flex" }}>
            <ViewportView />
            <FeatureDialog />
          </div>
        </div>
      )}
      {help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null}
      <CommandPalette onHelp={() => setGuide(true)} onShortcuts={() => setHelp(true)} onTour={() => setTour(true)} />
      {tour && screen === "editor" ? <Tour onClose={() => setTour(false)} /> : null}
      <Toasts />
      <MenuHost />
    </>
  );
}
