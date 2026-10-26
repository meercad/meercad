/** Application state (zustand) and the document → kernel rebuild loop. */
import { create } from "zustand";
import { KernelClient, SupersededError, type Measurement, type RebuildOutput } from "@opencad/kernel/client";
import { DocumentStore, OpError } from "@opencad/model";
import { emptyDocument, type DocOp, type Feature, type FeatureOp, type OpencadDocument, type PlaneSpec } from "@opencad/schema";
import { planeSpecForPick } from "./lib/topology";
import type { Pick, Viewport } from "@opencad/viewport";
import { draftFeature, draftProblem } from "./lib/features";
import { listProjects, loadProject, newProjectId, saveProject, type ProjectMeta } from "./lib/persistence";
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

interface State {
  screen: "home" | "editor";
  projects: ProjectMeta[];
  project: ProjectMeta | null;
  doc: OpencadDocument;
  canUndo: boolean;
  canRedo: boolean;
  output: RebuildOutput | null;
  /** Last rebuild of the real document (without previews); handles anchor to it. */
  baseOutput: RebuildOutput | null;
  /** True while the viewport shows a preview (dialog draft or copilot proposal). */
  previewing: boolean;
  previewError: string | null;
  kernel: { ready: boolean; info: string; error?: string };
  dialog: DialogState | null;
  sketchId: string | null;
  selection: Pick[];
  hidden: Set<string>;
  showPlanes: boolean;
  showSketches: boolean;
  measure: { active: boolean; picks: Pick[]; result: Measurement | null };
  copilotOpen: boolean;
  proposalDoc: OpencadDocument | null;
  toasts: Toast[];
  saveState: "saved" | "saving" | "unsaved";
  selectedFeature: string | null;
  /** Waiting for the user to click a plane/face to start a sketch. */
  pickingSketchPlane: boolean;
}

export const kernel = new KernelClient(new KernelWorker());
let docStore = new DocumentStore();
let viewportRef: Viewport | null = null;
export const setViewport = (v: Viewport | null) => (viewportRef = v);
export const getViewport = () => viewportRef;

export const useApp = create<State>(() => ({
  screen: "home",
  projects: [],
  project: null,
  doc: emptyDocument(),
  canUndo: false,
  canRedo: false,
  output: null,
  baseOutput: null,
  previewing: false,
  previewError: null,
  kernel: { ready: false, info: "Loading geometry kernel…" },
  dialog: null,
  sketchId: null,
  selection: [],
  hidden: new Set(),
  showPlanes: false,
  showSketches: true,
  measure: { active: false, picks: [], result: null },
  copilotOpen: false,
  proposalDoc: null,
  toasts: [],
  saveState: "saved",
  selectedFeature: null,
  pickingSketchPlane: false,
}));

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
function displayDoc(): { doc: OpencadDocument; preview: boolean; problem: string | null } {
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
  for (;;) {
    try {
      const output = await kernel.rebuild(docStore.doc);
      if (!get().dialog && !get().proposalDoc) set({ output, baseOutput: output, previewing: false });
      return output;
    } catch (e) {
      if (!(e instanceof SupersededError)) throw e;
    }
  }
}

let rebuildQueued = false;
export function scheduleRebuild(): void {
  if (rebuildQueued) return;
  rebuildQueued = true;
  queueMicrotask(() => {
    rebuildQueued = false;
    const { doc, preview, problem } = displayDoc();
    set({ previewError: problem });
    kernel.rebuild(doc).then(
      (output) => set(preview ? { output, previewing: true } : { output, baseOutput: output, previewing: false }),
      (e: unknown) => {
        if (e instanceof SupersededError) return;
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
      linear_pattern: "source",
      circular_pattern: "source",
      mirror: "source",
      boolean: "target",
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
    toast("Select a plane or a flat face for the sketch");
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
  set({ projects: await listProjects() });
}

export async function openProject(id: string): Promise<void> {
  const p = await loadProject(id);
  if (!p) {
    toast("Project not found", "error");
    return;
  }
  loadDoc(p.doc, { id: p.id, name: p.name, updatedAt: p.updatedAt });
  history.replaceState(null, "", `#/p/${p.id}`);
}

export async function newProject(doc: OpencadDocument = emptyDocument(), name = "Untitled part"): Promise<void> {
  const meta = { id: newProjectId(), name, updatedAt: Date.now() };
  await saveProject({ ...meta, doc });
  loadDoc(doc, meta);
  history.replaceState(null, "", `#/p/${meta.id}`);
}

function loadDoc(doc: OpencadDocument, meta: ProjectMeta): void {
  docStore = new DocumentStore(doc);
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
  void flushSave().then(refreshProjects);
  set({ screen: "home", project: null, sketchId: null, dialog: null });
  history.replaceState(null, "", "#/");
}

export function renameProject(name: string): void {
  const p = get().project;
  if (!p || !name.trim()) return;
  set({ project: { ...p, name: name.trim() } });
  scheduleSave();
}

let saveTimer: number | undefined;
function scheduleSave(): void {
  if (!get().project) return;
  set({ saveState: "unsaved" });
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), 800);
}

export async function flushSave(): Promise<void> {
  clearTimeout(saveTimer);
  const p = get().project;
  if (!p || get().saveState === "saved") return;
  set({ saveState: "saving" });
  let thumbnail: string | undefined;
  try {
    thumbnail = viewportRef?.snapshot(320, 240);
  } catch {
    thumbnail = undefined;
  }
  try {
    await saveProject({ ...p, updatedAt: Date.now(), doc: docStore.doc, ...(thumbnail ? { thumbnail } : {}) });
    set({ saveState: "saved" });
  } catch (e) {
    set({ saveState: "unsaved" });
    toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

window.addEventListener("beforeunload", () => void flushSave());

export function replaceDocument(doc: OpencadDocument): void {
  apply({ type: "replace", doc });
}

// Debug handle for development and end-to-end checks.
if (import.meta.env.DEV) Object.assign(window, { opencad: { useApp, apply, currentDoc, getViewport, kernel } });
