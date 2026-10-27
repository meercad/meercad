/** Application state (zustand) and the document → kernel rebuild loop. */
import { create } from "zustand";
import { KernelClient, SupersededError, type Measurement, type RebuildOutput } from "@meercad/kernel/client";
import { DocumentStore, OpError } from "@meercad/model";
import { emptyDocument, type DocOp, type Feature, type FeatureOp, type MeercadDocument, type PlaneSpec } from "@meercad/schema";
import { planeSpecForPick } from "./lib/topology";
import type { Pick, Viewport } from "@meercad/viewport";
import { draftFeature, draftProblem } from "./lib/features";
import { createProject, listFolders, listProjects, loadProject, renameProjectFile, saveProject, type ProjectMeta } from "./lib/persistence";
import KernelWorker from "./kernel.worker.ts?worker";

export interface DialogState {
  feature: Feature;
  isNew: boolean;
  /** Selection field currently receiving viewport picks. */
  field: string | null;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export interface Tab {
  id: string;
  name: string;
  folder?: string;
}

interface State {
  screen: "home" | "editor";
  projects: ProjectMeta[];
  /** Open projects, in tab order. */
  tabs: Tab[];
  /** All project folders, and the one the project overview is showing. */
  folders: string[];
  folder: string;
  project: ProjectMeta | null;
  doc: MeercadDocument;
  canUndo: boolean;
  canRedo: boolean;
  output: RebuildOutput | null;
  /** Last rebuild of the real document (without previews); handles anchor to it. */
  baseOutput: RebuildOutput | null;
  /** True while the viewport shows a preview (dialog draft or copilot proposal). */
  previewing: boolean;
  previewError: string | null;
  kernel: { ready: boolean; info: string; error?: string };
  /** A rebuild of the model is running in the kernel. */
  building: boolean;
  dialog: DialogState | null;
  sketchId: string | null;
  selection: Pick[];
  hidden: Set<string>;
  showPlanes: boolean;
  showSketches: boolean;
  measure: { active: boolean; picks: Pick[]; result: Measurement | null };
  proposalDoc: MeercadDocument | null;
  toasts: Toast[];
  saveState: "saved" | "saving" | "unsaved";
  selectedFeature: string | null;
  /** Features picked together in the list (⌘/Shift-click), e.g. to link their values. */
  featureSelection: string[];
  /** History/parts/variables sidebar (collapsed by default). */
  sideOpen: boolean;
  /** What a connected assistant is doing right now (MCP). */
  aiActivity: { client: string; tool: string; at: number } | null;
  /** Waiting for the user to click a plane/face to start a sketch. */
  pickingSketchPlane: boolean;
}

export const kernel = new KernelClient(new KernelWorker());
let docStore = new DocumentStore();
/** Each open tab keeps its document and undo history in memory while it is in the background. */
const tabStores = new Map<string, DocumentStore>();
const closedTabs: string[] = [];

function loadTabs(): Tab[] {
  try {
    return (JSON.parse(localStorage.getItem("meercad.tabs") ?? "[]") as Tab[]).filter((t) => typeof t.id === "string");
  } catch {
    return [];
  }
}
function setTabs(tabs: Tab[]): void {
  useApp.setState({ tabs });
  try {
    localStorage.setItem("meercad.tabs", JSON.stringify(tabs));
  } catch {
    // tabs just won't be restored
  }
}
let viewportRef: Viewport | null = null;
export const setViewport = (v: Viewport | null) => (viewportRef = v);
export const getViewport = () => viewportRef;

export const useApp = create<State>(() => ({
  screen: "home",
  projects: [],
  tabs: loadTabs(),
  folders: [],
  folder: "",
  project: null,
  doc: emptyDocument(),
  canUndo: false,
  canRedo: false,
  output: null,
  baseOutput: null,
  previewing: false,
  previewError: null,
  kernel: { ready: false, info: "Loading geometry kernel…" },
  building: false,
  dialog: null,
  sketchId: null,
  selection: [],
  hidden: new Set(),
  showPlanes: false,
  showSketches: true,
  measure: { active: false, picks: [], result: null },
  proposalDoc: null,
  toasts: [],
  saveState: "saved",
  selectedFeature: null,
  featureSelection: [],
  pickingSketchPlane: false,
  aiActivity: null,
  sideOpen: (() => {
    try {
      return localStorage.getItem("meercad.sideOpen") === "1";
    } catch {
      return false;
    }
  })(),
}));

export function toggleSide(open?: boolean): void {
  const next = open ?? !useApp.getState().sideOpen;
  useApp.setState({ sideOpen: next });
  try {
    localStorage.setItem("meercad.sideOpen", next ? "1" : "0");
  } catch {
    // preference not persisted
  }
}

const set = useApp.setState;
const get = useApp.getState;

// ---------------------------------------------------------------- toasts

let toastId = 0;
export function toast(text: string, kind: Toast["kind"] = "info"): void {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "error" ? 6000 : 3000);
}

// ---------------------------------------------------------------- document

function syncDoc(): void {
  set({ doc: docStore.doc, canUndo: docStore.canUndo, canRedo: docStore.canRedo });
  scheduleRebuild();
  scheduleSave();
}

/** Applies Operations-API ops as one undo step. Returns false (and shows why) on failure. */
export function apply(...ops: DocOp[]): boolean {
  try {
    docStore.apply(...ops);
    syncDoc();
    return true;
  } catch (e) {
    toast(e instanceof OpError ? e.message : String(e), "error");
    return false;
  }
}

/** Like apply, but merges into the previous undo step (for continuous edits such as sketch drags). */
export function applyQuiet(...ops: DocOp[]): boolean {
  try {
    docStore.amend(...ops);
    syncDoc();
    return true;
  } catch (e) {
    toast(e instanceof OpError ? e.message : String(e), "error");
    return false;
  }
}

export function undo(): void {
  if (get().dialog || !docStore.canUndo) return;
  docStore.undo();
  syncDoc();
}

export function redo(): void {
  if (get().dialog || !docStore.canRedo) return;
  docStore.redo();
  syncDoc();
}

export const currentDoc = () => docStore.doc;

// ---------------------------------------------------------------- rebuild loop

/** The document the viewport should show: proposal, draft preview or the real document. */
function displayDoc(): { doc: MeercadDocument; preview: boolean; problem: string | null } {
  const s = get();
  if (s.proposalDoc) return { doc: s.proposalDoc, preview: true, problem: null };
  const d = s.dialog;
  if (!d) return { doc: docStore.doc, preview: false, problem: null };
  const problem = draftProblem(d.feature);
  if (problem) return { doc: docStore.doc, preview: false, problem };
  const doc = structuredClone(docStore.doc);
  if (d.isNew) {
    const at = doc.rollback ? doc.features.findIndex((f) => f.id === doc.rollback) + 1 : doc.features.length;
    doc.features.splice(at, 0, d.feature);
    if (doc.rollback) doc.rollback = d.feature.id;
  } else {
    const i = doc.features.findIndex((f) => f.id === d.feature.id);
    if (i >= 0) doc.features[i] = d.feature;
  }
  return { doc, preview: true, problem: null };
}

/** Rebuilds the real document now and resolves with the result (for scripted callers like MCP). */
export async function rebuildNow(): Promise<RebuildOutput> {
  set({ building: true });
  for (;;) {
    try {
      const output = await kernel.rebuild(docStore.doc);
      if (!get().dialog && !get().proposalDoc) set({ output, baseOutput: output, previewing: false, selection: remapSelection(get().selection, get().baseOutput, output) });
      set({ building: false });
      return output;
    } catch (e) {
      if (!(e instanceof SupersededError)) {
        set({ building: false });
        throw e;
      }
    }
  }
}

/**
 * Face and edge numbers change between rebuilds. Faces are found again by their persistent names;
 * edges are kept only while the part's topology is unchanged. Anything else is deselected rather
 * than silently pointing at a different face.
 */
function remapSelection(selection: Pick[], before: RebuildOutput | null, after: RebuildOutput): Pick[] {
  if (!selection.length) return selection;
  const out: Pick[] = [];
  for (const p of selection) {
    if (p.kind !== "face" && p.kind !== "edge") {
      out.push(p);
      continue;
    }
    const m = after.meshes.find((x) => x.bodyId === p.bodyId);
    if (!m) continue;
    const old = before?.meshes.find((x) => x.bodyId === p.bodyId);
    const same = old && old.faceTags.length === m.faceTags.length && old.faceTags.every((t, i) => t.join() === m.faceTags[i]!.join());
    if (same) {
      out.push(p);
      continue;
    }
    if (p.kind === "face") {
      const key = p.tags.join();
      const face = m.faceTags.findIndex((t) => t.join() === key);
      if (face >= 0) out.push({ ...p, face, tags: m.faceTags[face]! });
    }
  }
  return out.length === selection.length && out.every((p, i) => p === selection[i]) ? selection : out;
}

let rebuildQueued = false;
export function scheduleRebuild(): void {
  if (rebuildQueued) return;
  rebuildQueued = true;
  queueMicrotask(() => {
    rebuildQueued = false;
    const { doc, preview, problem } = displayDoc();
    set({ previewError: problem, building: true });
    kernel.rebuild(doc).then(
      (output) => {
        set(preview ? { output, previewing: true, building: false } : { output, baseOutput: output, previewing: false, building: false, selection: remapSelection(get().selection, get().baseOutput, output) });
        if (!preview) scheduleThumbnail();
      },
      (e: unknown) => {
        // A newer rebuild replaced this one; it clears the flag when it finishes.
        if (e instanceof SupersededError) return;
        set({ building: false });
        const msg = e instanceof Error ? e.message : String(e);
        if (preview) set({ previewError: msg });
        else toast(`Rebuild failed: ${msg}`, "error");
      },
    );
  });
}

kernel.ready.then(
  ({ initMs }) => set({ kernel: { ready: true, info: `Kernel ready (${initMs.toFixed(0)} ms)` } }),
  (e: Error) => set({ kernel: { ready: false, info: "Kernel failed", error: e.message } }),
);

// ---------------------------------------------------------------- feature dialogs

export function startFeature(op: FeatureOp): void {
  const s = get();
  if (s.dialog) cancelDialog();
  if (op === "sketch") return startSketch();
  const feature = draftFeature(op, docStore.doc);
  // Seed selections from what the user already picked.
  set({ dialog: { feature, isNew: true, field: firstField(op) }, measure: { active: false, picks: [], result: null } });
  scheduleRebuild();
}

export function editFeature(id: string): void {
  const f = docStore.doc.features.find((x) => x.id === id);
  if (!f) return;
  if (get().dialog) cancelDialog();
  if (f.op === "sketch") return openSketch(id);
  set({ dialog: { feature: structuredClone(f), isNew: false, field: null }, selection: [] });
  scheduleRebuild();
}

/** Opens a dialog for an already-built draft (used by drag gestures). */
export function startDraft(feature: Feature): void {
  if (get().dialog) cancelDialog();
  set({ dialog: { feature, isNew: true, field: null }, selection: [] });
  scheduleRebuild();
}

export function updateDraft(patch: Partial<Feature> | ((f: Feature) => Feature)): void {
  const d = get().dialog;
  if (!d) return;
  const feature = stripUndefined(typeof patch === "function" ? patch(d.feature) : ({ ...d.feature, ...patch } as Feature));
  set({ dialog: { ...d, feature } });
  scheduleRebuild();
}

export function setDialogField(field: string | null): void {
  const d = get().dialog;
  if (d) set({ dialog: { ...d, field } });
}

export function commitDialog(): boolean {
  const d = get().dialog;
  if (!d) return false;
  const problem = draftProblem(d.feature);
  if (problem) {
    toast(problem, "error");
    return false;
  }
  let ok: boolean;
  if (d.isNew) ok = apply({ type: "add_features", features: [d.feature] });
  else {
    // Keys the draft dropped must be deleted (null) rather than merged back from the original.
    const original = docStore.doc.features.find((f) => f.id === d.feature.id) ?? {};
    const patch: Record<string, unknown> = { ...(d.feature as unknown as Record<string, unknown>) };
    for (const k of Object.keys(original)) if (!(k in patch)) patch[k] = null;
    ok = apply({ type: "edit_feature", id: d.feature.id, patch });
  }
  if (ok) {
    set({ dialog: null, selection: [], previewError: null });
    scheduleRebuild();
  }
  return ok;
}

export function cancelDialog(): void {
  if (!get().dialog) return;
  set({ dialog: null, previewError: null });
  scheduleRebuild();
}

function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripUndefined) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, stripUndefined(x)])) as T;
  return v;
}

function firstField(op: FeatureOp): string | null {
  return (
    {
      extrude: "profile",
      revolve: "profile",
      fillet: "edges",
      chamfer: "edges",
      shell: "faces",
      thread: "face",
      linear_pattern: "source",
      circular_pattern: "source",
      mirror: "source",
      boolean: "target",
      transform: "bodies",
      plane: "base",
    } as Partial<Record<FeatureOp, string>>
  )[op] ?? null;
}

/** Installed by the dialog component: routes a viewport pick into the active selection field. */
export let dialogPick: ((p: Pick, additive: boolean) => void) | null = null;
export const setDialogPick = (fn: typeof dialogPick) => (dialogPick = fn);

// ---------------------------------------------------------------- sketch mode

/** Creates a sketch on the given plane, the selected plane/face, or opens plane selection. */
export function startSketch(planeHint?: PlaneSpec): void {
  const doc = docStore.doc;
  const sel = get().selection[0];
  const plane = planeHint ?? (sel ? planeSpecForPick(sel, get().output?.meshes ?? []) : null);
  if (!plane) {
    set({ pickingSketchPlane: true, selection: [] });
    return;
  }
  set({ pickingSketchPlane: false });
  const feature = draftFeature("sketch", doc) as Extract<Feature, { op: "sketch" }>;
  feature.plane = plane;
  if (!apply({ type: "add_features", features: [feature] })) return;
  set({ selection: [] });
  openSketch(feature.id);
}

export function openSketch(id: string): void {
  set({ sketchId: id, selection: [], dialog: null, selectedFeature: id });
}

export function closeSketch(): void {
  set({ sketchId: null, selection: [] });
}

// ---------------------------------------------------------------- projects

export async function refreshProjects(): Promise<void> {
  const [projects, folders] = await Promise.all([listProjects(), listFolders()]);
  set({ projects, folders, folder: folders.includes(get().folder) ? get().folder : "" });
  // Tabs of projects that no longer exist close; names follow renames made elsewhere.
  const byId = new Map(projects.map((p) => [p.id, p]));
  const tabs = get().tabs.filter((t) => byId.has(t.id) || t.id === get().project?.id).map((t) => (byId.has(t.id) ? { ...t, name: byId.get(t.id)!.name } : t));
  if (tabs.length !== get().tabs.length || tabs.some((t, i) => t.name !== get().tabs[i]!.name)) setTabs(tabs);
}

export async function openProject(id: string): Promise<void> {
  if (get().project?.id === id && get().screen === "editor") return;
  await flushSave(true);
  const cached = tabStores.get(id);
  const tab = get().tabs.find((t) => t.id === id);
  if (cached && tab) {
    loadDoc(cached.doc, { id, name: tab.name, folder: tab.folder ?? "", updatedAt: Date.now() }, cached);
    history.replaceState(null, "", `#/p/${encodeURIComponent(id)}`);
    return;
  }
  const p = await loadProject(id).catch(() => undefined);
  if (!p) {
    toast("Project not found", "error");
    closeTab(id, false);
    return;
  }
  loadDoc(p.doc, { id: p.id, name: p.name, folder: p.folder ?? "", updatedAt: p.updatedAt });
  history.replaceState(null, "", `#/p/${encodeURIComponent(p.id)}`);
}

export async function newProject(doc: MeercadDocument = emptyDocument(), name = "Untitled part"): Promise<void> {
  await flushSave();
  // New parts land next to the open project, or in the folder the overview shows.
  const meta = await createProject(name, doc, get().project?.folder ?? get().folder);
  loadDoc(doc, meta);
  history.replaceState(null, "", `#/p/${encodeURIComponent(meta.id)}`);
}

function loadDoc(doc: MeercadDocument, meta: ProjectMeta, store?: DocumentStore): void {
  // Refresh the project's picture once per opening, after the first rebuild.
  thumbFor = null;
  const leaving = get().project;
  if (leaving) tabStores.set(leaving.id, docStore);
  docStore = store ?? new DocumentStore(doc);
  tabStores.set(meta.id, docStore);
  if (!get().tabs.some((t) => t.id === meta.id)) setTabs([...get().tabs, { id: meta.id, name: meta.name, ...(meta.folder ? { folder: meta.folder } : {}) }]);
  set({
    screen: "editor",
    project: meta,
    dialog: null,
    sketchId: null,
    selection: [],
    output: null,
    hidden: new Set(),
    measure: { active: false, picks: [], result: null },
    proposalDoc: null,
    saveState: "saved",
    selectedFeature: null,
  });
  syncDoc();
  set({ saveState: "saved" });
}

export const undoAvailable = () => docStore.canUndo;

export function goHome(): void {
  const p = get().project;
  if (p) tabStores.set(p.id, docStore);
  void flushSave(true).then(refreshProjects);
  set({ screen: "home", project: null, sketchId: null, dialog: null });
  history.replaceState(null, "", "#/");
}

export async function renameProject(name: string): Promise<void> {
  const p = get().project;
  if (!p || !name.trim() || name.trim() === p.name) return;
  await flushSave();
  try {
    const meta = await renameProjectFile(p.id, name.trim());
    set({ project: { ...p, ...meta } });
    retargetTab(p.id, meta);
    history.replaceState(null, "", `#/p/${encodeURIComponent(meta.id)}`);
  } catch (e) {
    toast(`Could not rename: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

let saveTimer: number | undefined;
function scheduleSave(): void {
  if (!get().project) return;
  set({ saveState: "unsaved" });
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), 800);
}

/** Projects get a picture once the model has been built, even if nothing was changed yet. */
let thumbTimer: number | undefined;
let thumbFor: string | null = null;
function scheduleThumbnail(): void {
  const p = get().project;
  if (!p || thumbFor === p.id) return;
  clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(() => {
    if (get().project?.id !== p.id || get().sketchId || get().dialog) return;
    thumbFor = p.id;
    void flushSave(true);
  }, 1200);
}

function snapshot(): string | undefined {
  try {
    return viewportRef?.snapshot(480, 360, true);
  } catch {
    return undefined;
  }
}

/** Saves pending changes; `withThumbnail` also refreshes the picture when nothing changed. */
export async function flushSave(withThumbnail = false): Promise<void> {
  clearTimeout(saveTimer);
  const p = get().project;
  if (!p || (get().saveState === "saved" && !withThumbnail)) return;
  set({ saveState: "saving" });
  const thumbnail = snapshot();
  try {
    await saveProject({ ...p, updatedAt: Date.now(), doc: docStore.doc, ...(thumbnail ? { thumbnail } : {}) });
    set({ saveState: "saved" });
  } catch (e) {
    set({ saveState: "unsaved" });
    toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

window.addEventListener("beforeunload", () => void flushSave());

export function replaceDocument(doc: MeercadDocument): void {
  apply({ type: "replace", doc });
}

// Debug handle for development and end-to-end checks.
if (import.meta.env.DEV) Object.assign(window, { meercad: { useApp, apply, currentDoc, getViewport, kernel } });

// ---------------------------------------------------------------- tabs

/** Closes a tab; the active one switches to its neighbour (or home). */
export function closeTab(id: string, remember = true): void {
  const tabs = get().tabs;
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  if (remember) closedTabs.push(id);
  const active = get().project?.id === id;
  const finish = () => {
    tabStores.delete(id);
    setTabs(get().tabs.filter((t) => t.id !== id));
  };
  if (!active) return finish();
  const next = tabs[i + 1] ?? tabs[i - 1];
  void flushSave(true).then(() => {
    finish();
    if (next) void openProject(next.id);
    else goHome();
  });
}

export function reopenClosedTab(): void {
  const id = closedTabs.pop();
  if (id) void openProject(id);
}

/** Switches to the next (+1) or previous (-1) tab, wrapping around. */
export function cycleTab(step: 1 | -1): void {
  const tabs = get().tabs;
  if (!tabs.length) return;
  const i = tabs.findIndex((t) => t.id === get().project?.id);
  const next = tabs[(i + step + tabs.length) % tabs.length]!;
  void openProject(next.id);
}

export function moveTab(id: string, before: string | null): void {
  const tabs = get().tabs.filter((t) => t.id !== id);
  const tab = get().tabs.find((t) => t.id === id);
  if (!tab) return;
  const at = before ? tabs.findIndex((t) => t.id === before) : tabs.length;
  tabs.splice(at < 0 ? tabs.length : at, 0, tab);
  setTabs(tabs);
}

/** A project's id changed (renamed or moved): keep its tab and in-memory state. */
export function retargetTab(oldId: string, meta: { id: string; name: string; folder?: string }): void {
  const store = tabStores.get(oldId);
  if (store) {
    tabStores.delete(oldId);
    tabStores.set(meta.id, store);
  }
  setTabs(get().tabs.map((t) => (t.id === oldId ? { id: meta.id, name: meta.name, ...(meta.folder ? { folder: meta.folder } : {}) } : t)));
}
