/** Application state (zustand) and the document → kernel rebuild loop. */
import { create } from "zustand";
import { KernelClient, SupersededError, type Measurement, type RebuildOutput, type RebuildProgress } from "@meercad/kernel/client";
import { DocumentStore, OpError, withMotion } from "@meercad/model";
import { emptyDocument, withoutRemovedFeatures, type DocOp, type Feature, type FeatureOp, type MeercadDocument, type PlaneSpec } from "@meercad/schema";
import { planeSpecForPick, setFeatureLabels } from "./lib/topology";
import { usePrefs } from "./lib/keymap";
import { FACE_TOOLS, meshBodyIds, meshHint } from "./lib/meshParts";
import { hasPack } from "./lib/premium";
import { notePacks, refuseLocked } from "./lib/packNotice";
import { setUnitSource } from "./lib/units";
import type { LengthUnit } from "@meercad/schema";
import type { Pick, Viewport } from "@meercad/viewport";
import { frameFromPlane, toSketch } from "@meercad/sketch";
import { draftFeature, draftProblem, featureName } from "./lib/features";
import { assistantWindow, createProject, desktop, listFolders, listProjects, loadProject, renameProjectFile, saveProject, saveThumbnail, type AssistantTab, type ProjectMeta } from "./lib/persistence";
import { BIG_STEPS, kernelKindFor, viewIsCurrent, type KernelKind } from "./lib/pictureState";
import KernelWorker from "./kernel.worker.ts?worker";
import kernelBuild from "./kernel.worker.ts?worker&url";
import { outputKey, readOutput, writeOutput, type MeshOptions } from "./lib/openCache";
import { isCompact } from "./lib/layout";
import type { PaceCurve, ProgressPoint } from "./lib/eta";
import { t } from "./lib/i18n";
import { openGuard, tasksOnEditor } from "./lib/opening";

export interface DialogState {
  feature: Feature;
  isNew: boolean;
  /** Selection field currently receiving viewport picks. */
  field: string | null;
  /** Opened by dragging an arrow: no dialog is shown, only the value at the arrow, until the drag ends. */
  gesture?: boolean;
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

/** An assistant session's tab (Mac app): it works on its project there, the tab is locked for the user. */
export type { AssistantTab };

interface State {
  screen: "home" | "editor";
  projects: ProjectMeta[];
  /** Open projects, in tab order. */
  tabs: Tab[];
  /** The assistants' tabs, after the user's (Mac app). */
  assistantTabs: AssistantTab[];
  /** The assistant's tab the window shows (its session), instead of Home or a project of the user's. */
  assistantTab: string | null;
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
  /** Work in progress, shown with its progress (see `startTask`). */
  tasks: Task[];
  /** How far the first build of a model has got, for the loading overlay. */
  buildProgress: { index: number; total: number; feature: string } | null;
  saveState: "saved" | "saving" | "unsaved";
  selectedFeature: string | null;
  /** Features picked together in the list (⌘/Shift-click), e.g. to link their values. */
  featureSelection: string[];
  /** History/parts/variables sidebar (collapsed by default). */
  sideOpen: boolean;
  /** What a connected assistant is doing right now (MCP). */
  aiActivity: { client: string; tool: string; at: number } | null;
  /** An assistant is working on the model (MCP): the app takes no input until it is done or stopped. */
  aiLock: { client: string } | null;
  /** Waiting for the user to click a plane/face to start a sketch. */
  pickingSketchPlane: boolean;
}

/**
 * The kernel uses the multi-threaded OCCT build (parallel meshing and booleans) whenever the page is
 * cross-origin isolated: SharedArrayBuffer only exists there, i.e. over https or from localhost, not
 * on a plain-http LAN address. `?threads=0` or localStorage "meercad.threads" = "0" turns it off.
 */
const wantThreads = new URLSearchParams(location.search).get("threads") !== "0" && !threadsOff();
function threadsOff(): boolean {
  try {
    return localStorage.getItem("meercad.threads") === "0";
  } catch {
    return false;
  }
}
// OCCT broke on a model (seen with large booleans in the multi-threaded build): carry on in a fresh,
// single-threaded kernel, which builds the same models with more room.
const kernelName: KernelKind = wantThreads && crossOriginIsolated ? "kernel-threads" : desktop ? "kernel" : "kernel-reserve";
export const kernel = new KernelClient(
  new KernelWorker({ name: kernelName }),
  () => new KernelWorker({ name: desktop ? "kernel" : "kernel-reserve" }),
  // On the Mac a fresh kernel takes over before the running one is full (see Renewal); the iPad has
  // no room for two kernels at once.
  desktop ? { worker: () => new KernelWorker({ name: kernelName }), ...renewAt() } : undefined,
);
/**
 * iPad and iPhone: before another design is built, a kernel still holding more than this starts over
 * fresh (KernelClient.restartIfAbove); it would otherwise keep what the last design took, and two
 * big designs one after the other outgrow the page.
 */
const RESTART_ABOVE = 600 * 2 ** 20;
/** The project the editor's kernel was last given, and the kind it is of (see kernelKindFor). */
let kernelProject: string | null = null;
let kernelKind: KernelKind = kernelName;
/**
 * iPad and iPhone: starts the editor's kernel over when it holds more than `above`, after the
 * overview has built pictures in it (no second kernel fits there, see thumbnails.ts). Only while no
 * project is open.
 */
export function freshKernelIfAbove(above: number): void {
  if (get().project) return;
  if (kernel.restartIfAbove(above, () => new KernelWorker({ name: kernelKind }))) kernelProject = null;
}
/** For test runs: localStorage "meercad.kernel.renew" (MB) makes the fresh kernel take over that early. */
function renewAt(): { above?: number; grown?: number } {
  try {
    const mb = Number(localStorage.getItem("meercad.kernel.renew"));
    return mb > 0 ? { above: mb * 2 ** 20, grown: 0 } : {};
  } catch {
    return {};
  }
}
/** A second, single-threaded kernel for background work that must never hold up the editor. */
export const spareKernel = () => new KernelClient(new KernelWorker({ name: "kernel-spare" }));
// Touch screens are tablets: meshing is a large share of every rebuild there, and the screen is
// held close but small, so looser tolerances (about half the triangles) are hard to see.
const meshCoarse = matchMedia("(pointer: coarse)").matches ? 2 : 1;
if (meshCoarse !== 1) void kernel.configure(meshCoarse);
/** How the editor's kernel meshes parts: a kept result (openCache) is only used for the same. */
export const editorMeshOptions = (): MeshOptions => ({ build: kernelBuild, coarse: meshCoarse, textures: usePrefs.getState().showTextures });
let docStore = new DocumentStore();
/** Each open tab keeps its document and undo history in memory while it is in the background. */
const tabStores = new Map<string, DocumentStore>();
const closedTabs: string[] = [];

function loadTabs(): Tab[] {
  // An assistant's tab is a page of its own: it never restores the user's tabs.
  if (assistantWindow) return [];
  try {
    return (JSON.parse(localStorage.getItem("meercad.tabs") ?? "[]") as Tab[]).filter((t) => typeof t.id === "string");
  } catch {
    return [];
  }
}
function setTabs(tabs: Tab[]): void {
  useApp.setState({ tabs });
  if (assistantWindow) return;
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
  assistantTabs: [],
  assistantTab: null,
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
  tasks: [],
  buildProgress: null,
  saveState: "saved",
  selectedFeature: null,
  featureSelection: [],
  pickingSketchPlane: false,
  aiActivity: null,
  aiLock: null,
  sideOpen: (() => {
    // On a phone the panel is a sheet over the model: it starts closed.
    if (isCompact()) return false;
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

// A tool that opens takes over the history's highlight: only the step being edited stays marked
// (none for a new one), so two things never look active at once.
useApp.subscribe((s, prev) => {
  const id = s.dialog && !s.dialog.isNew ? s.dialog.feature.id : null;
  if (s.dialog && (!prev.dialog || prev.dialog.feature.id !== s.dialog.feature.id) && (s.selectedFeature !== id || s.featureSelection.length)) set({ selectedFeature: id, featureSelection: [] });
});

// ---------------------------------------------------------------- toasts

let toastId = 0;

export interface Task {
  id: number;
  label: string;
  /** 0–1, or null while unknown. */
  progress: number | null;
  detail?: string;
  /** When it started (performance.now()); short tasks are never shown. */
  since: number;
  /** The project it works for: its tab shows the progress too. */
  project?: string;
  /** Shows a button that stops it. */
  cancel?: () => void;
  /** Long work (minutes): shows the time it has run and an estimate of what is left. */
  long?: boolean;
  /** Only the way into the editor ("Opening …"): ends once the editor shows the design, which then shows its own progress. */
  untilEditor?: boolean;
  /** How its progress goes with time, when not evenly (see lib/eta). */
  pace?: PaceCurve;
  /** When the first progress came (performance.now()), and every change since: [seconds after it, progress]. */
  progressFrom?: number;
  progressLog?: ProgressPoint[];
}
let taskId = 0;

/**
 * Registers work the user should see running: anything that can take more than a moment (a slow
 * rebuild, reading an import). Update it as it goes; `done` removes it. The Tasks panel shows it
 * with a progress bar once it has run for a moment.
 */
export function startTask(label: string, progress: number | null = null, options: { project?: string; cancel?: () => void; long?: boolean; pace?: PaceCurve; untilEditor?: boolean } = {}): { update(progress: number | null, detail?: string): void; done(): void } {
  const id = ++taskId;
  set((s) => ({ tasks: [...s.tasks, { id, label, progress, since: performance.now(), ...options }] }));
  return {
    update(p, detail) {
      const now = performance.now();
      set((s) => ({
        tasks: s.tasks.map((x) => {
          if (x.id !== id) return x;
          const from = x.progressFrom ?? (p !== null ? now : undefined);
          const log = x.long && p !== null && p !== x.progress && from !== undefined ? [...(x.progressLog ?? []), [(now - from) / 1000, p] as const] : x.progressLog;
          return { ...x, progress: p, ...(detail !== undefined ? { detail } : {}), ...(from !== undefined ? { progressFrom: from } : {}), ...(log ? { progressLog: log } : {}) };
        }),
      }));
    },
    done() {
      set((s) => ({ tasks: s.tasks.filter((x) => x.id !== id) }));
    },
  };
}

/**
 * Progress of one kernel rebuild from the worker's per-feature reports: in the loading overlay while
 * the model has no result yet, else as a "Rebuilding" task.
 */
function rebuildTask(): { onProgress: RebuildProgress; done(): void } {
  let task: ReturnType<typeof startTask> | null = null;
  // The tab this rebuild is for: another tab brought to the front meanwhile shows its own progress,
  // not this one's (this one shows on its tab).
  const store = docStore;
  const project = get().project?.id;
  const ours = () => docStore === store;
  return {
    onProgress: ({ index, total, feature }) => {
      if (ours() && !get().output) return set({ buildProgress: { index, total, feature } });
      task ??= startTask(t("Rebuilding"), null, project ? { project } : {});
      const f = store.doc.features.find((x) => x.id === feature);
      task.update(index / Math.max(1, total), t("{feature} ({n} of {total})", { feature: f ? featureName(f) : feature, n: index + 1, total }));
    },
    done: () => {
      task?.done();
      if (ours() && get().buildProgress) set({ buildProgress: null });
    },
  };
}
export function toast(text: string, kind: Toast["kind"] = "info"): void {
  const id = ++toastId;
  // The same message again replaces the one showing rather than stacking up.
  set((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, text, kind }] }));
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

/** Undo; with a feature dialog open it discards that dialog's unsaved change first. */
export function undo(): void {
  if (get().dialog) {
    cancelDialog();
    toast(t("Undone: unsaved change"));
    return;
  }
  if (!docStore.canUndo) return;
  const before = docStore.doc;
  docStore.undo();
  syncDoc();
  toast(t("Undone: {step}", { step: describeStep(docStore.doc, before) }));
}

export function redo(): void {
  if (get().dialog || !docStore.canRedo) return;
  const before = docStore.doc;
  docStore.redo();
  syncDoc();
  toast(t("Redone: {step}", { step: describeStep(before, docStore.doc) }));
}

/** A short name for what changed between two documents, for undo/redo feedback. */
function describeStep(from: MeercadDocument, to: MeercadDocument): string {
  const ids = (d: MeercadDocument) => new Set(d.features.map((f) => f.id));
  const [a, b] = [ids(from), ids(to)];
  const added = to.features.find((f) => !a.has(f.id));
  if (added) return featureName(added);
  const removed = from.features.find((f) => !b.has(f.id));
  if (removed) return t("delete {name}", { name: featureName(removed) });
  const changed = to.features.find((f, i) => JSON.stringify(f) !== JSON.stringify(from.features.find((g) => g.id === f.id)) || from.features[i]?.id !== f.id);
  if (changed) return featureName(changed);
  if (JSON.stringify(from.params) !== JSON.stringify(to.params)) return t("variables");
  return t("change");
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
    const task = rebuildTask();
    const doc = docStore.doc;
    try {
      const output = await kernel.rebuild(doc, { textures: usePrefs.getState().showTextures, onProgress: task.onProgress });
      if (!get().dialog && !get().proposalDoc && docStore.doc === doc) {
        set({ output, baseOutput: output, previewing: false, selection: remapSelection(get().selection, get().baseOutput, output) });
        shownDoc = docStore.doc;
        scheduleThumbnail();
        scheduleOutputCache();
      }
      set({ building: false });
      return output;
    } catch (e) {
      if (!(e instanceof SupersededError)) {
        set({ building: false });
        throw e;
      }
    } finally {
      task.done();
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
  // Per body, worked out once: unchanged faces keep their picks, else faces are found by their tags.
  // (A whole selected mesh is thousands of picks, so nothing here may scan per pick.)
  const bodies = new Map<string, { same: boolean; byTags: Map<string, number> | null; tags: string[][] } | null>();
  const bodyInfo = (id: string) => {
    if (bodies.has(id)) return bodies.get(id)!;
    const m = after.meshes.find((x) => x.bodyId === id);
    const old = before?.meshes.find((x) => x.bodyId === id);
    const info = m ? { same: !!old && (old === m || (old.faceTags.length === m.faceTags.length && old.faceTags.every((t, i) => t.join() === m.faceTags[i]!.join()))), byTags: null, tags: m.faceTags } : null;
    bodies.set(id, info);
    return info;
  };
  const out: Pick[] = [];
  for (const p of selection) {
    if (p.kind !== "face" && p.kind !== "edge") {
      out.push(p);
      continue;
    }
    const info = bodyInfo(p.bodyId);
    if (!info) continue;
    if (info.same) {
      out.push(p);
      continue;
    }
    if (p.kind === "face") {
      info.byTags ??= new Map(info.tags.map((t, i) => [t.join(), i]));
      const face = info.byTags.get(p.tags.join());
      if (face !== undefined) out.push({ ...p, face, tags: info.tags[face]! });
    }
  }
  return out.length === selection.length && out.every((p, i) => p === selection[i]) ? selection : out;
}

let rebuildQueued = false;
let rebuildsPending = 0;
let lastRebuildMs = 0;
let held: "off" | "on" | "wanted" = "off";

/** Rebuilds still on their way from the kernel. */
export const rebuilding = () => rebuildsPending > 0 || held === "wanted";

/** The last rebuild took long enough (a big part on an iPad) that a drag should not wait on it. */
export const rebuildIsSlow = () => lastRebuildMs > 150;

/**
 * While holding, rebuild requests are collected instead of sent: dragging on a slow device then
 * computes only where the pen rests or lets go, instead of a stale value that delays the final one.
 */
export function holdRebuilds(on: boolean): void {
  const wanted = held === "wanted";
  held = on ? (wanted ? "wanted" : "on") : "off";
  if (!on && wanted) scheduleRebuild();
}

let draftTextures = false;
/** A rebuild with textures slower than this suggests hiding them (once per session). */
const SLOW_TEXTURE_MS = 3000;
let texturesHinted = false;
// Showing or hiding textures rebuilds the meshes (the geometry comes from the cache).
usePrefs.subscribe((p, prev) => {
  if (p.showTextures !== prev.showTextures) scheduleRebuild();
});
/** Counts rebuild requests, so a fine texture that a newer edit overtook is not shown. */
let rebuildGeneration = 0;

/** While a lithophane value is being dragged: its picture is made coarse and quick; letting go makes it fine again. */
export function setDraftTextures(on: boolean): void {
  if (draftTextures === on) return;
  draftTextures = on;
  if (!on) scheduleRebuild();
}

export function scheduleRebuild(): void {
  if (held !== "off") {
    held = "wanted";
    return;
  }
  if (rebuildQueued) return;
  rebuildQueued = true;
  queueMicrotask(() => {
    rebuildQueued = false;
    const { doc, preview, problem } = displayDoc();
    set({ previewError: problem, building: true });
    const t0 = performance.now();
    rebuildsPending++;
    const task = rebuildTask();
    const gen = ++rebuildGeneration;
    // Lithophane pictures take a while at full detail: the part shows first with a coarse picture,
    // and the fine one follows (the geometry is not computed again for it).
    const textures = usePrefs.getState().showTextures;
    const textured = doc.features.some((f) => f.op === "lithophane" && !f.suppressed);
    const quick = textures && !draftTextures && textured;
    // The tab this rebuild is for: its result is not shown if another tab came to the front meanwhile.
    const store = docStore;
    const show = (output: RebuildOutput, final: boolean) => {
      if (docStore !== store) return;
      set(preview ? { output, previewing: true, building: !final } : { output, baseOutput: output, previewing: false, building: !final, selection: remapSelection(get().selection, get().baseOutput, output) });
      if (!preview && final) {
        shownDoc = doc;
        scheduleThumbnail();
        fillBodyProps(output);
        scheduleOutputCache();
      }
      // Once per session: a slow textured part gets the hint that textures can be hidden while editing.
      if (final && textures && textured && !texturesHinted && performance.now() - t0 > SLOW_TEXTURE_MS) {
        texturesHinted = true;
        toast(t("Lithophane pictures slow down rebuilding. Hide them while you edit with the wave button at the bottom right; exports keep them."));
      }
    };
    // Volume and area (integrals over every face) follow once the new shape is on screen.
    kernel.rebuild(doc, { props: false, draft: draftTextures || quick, textures, onProgress: task.onProgress }).then(
      (output) => {
        task.done();
        rebuildsPending--;
        lastRebuildMs = performance.now() - t0;
        show(output, !quick);
        if (!quick) return;
        rebuildsPending++;
        kernel.rebuild(doc, { props: false }).then(
          (fine) => {
            rebuildsPending--;
            if (gen === rebuildGeneration) show(fine, true);
          },
          (e: unknown) => {
            rebuildsPending--;
            if (gen === rebuildGeneration && !(e instanceof SupersededError)) set({ building: false });
          },
        );
      },
      (e: unknown) => {
        task.done();
        rebuildsPending--;
        // A newer rebuild replaced this one; it clears the flag when it finishes.
        if (e instanceof SupersededError) return;
        set({ building: false });
        const msg = e instanceof Error ? e.message : String(e);
        if (preview) set({ previewError: msg });
        else toast(t("Rebuild failed: {msg}", { msg }), "error");
      },
    );
  });
}

/** Puts volume and area into a result that was built without them, unless a newer one replaced it. */
function fillBodyProps(output: RebuildOutput): void {
  void kernel.bodyProps().then(
    (bodies) => {
      if (get().output !== output) return;
      const filled = { ...output, report: { ...output.report, bodies } };
      set({ output: filled, ...(get().baseOutput === output ? { baseOutput: filled } : {}) });
    },
    () => undefined,
  );
}

kernel.ready.then(
  ({ initMs, threads }) => {
    const mode = threads ? `, ${navigator.hardwareConcurrency} threads` : !wantThreads ? ", single thread: turned off" : crossOriginIsolated ? ", single thread: threaded build failed to start" : ", single thread: page not cross-origin isolated";
    set({ kernel: { ready: true, info: `Kernel ready (${initMs.toFixed(0)} ms${mode})` } });
  },
  (e: Error) => set({ kernel: { ready: false, info: "Kernel failed", error: e.message } }),
);

// ---------------------------------------------------------------- feature dialogs

/** Whether the selection is on a part made from an imported mesh (edited only as a whole). */
export function selectionOnMesh(): boolean {
  const s = get();
  const meshParts = meshBodyIds(docStore.doc.features, s.output?.meshes ?? []);
  return s.selection.some((p) => (p.kind === "face" || p.kind === "edge") && meshParts.has(p.bodyId));
}

/** Hides the parts (and sketches) the selection touches. */
export function hideSelectedParts(): void {
  const s = get();
  const ids = new Set<string>();
  for (const p of s.selection) {
    if (p.kind === "face" || p.kind === "edge") ids.add(p.bodyId);
    else if (p.kind === "region" || p.kind === "sketch_curve") ids.add(p.sketchId);
  }
  if (!ids.size) return;
  set({ hidden: new Set([...s.hidden, ...ids]), selection: [] });
}

let lastStarted: FeatureOp | null = null;
/** The tool started last, for "repeat last command". */
export const lastStartedFeature = (): FeatureOp | null => lastStarted;

export function startFeature(op: FeatureOp): void {
  const s = get();
  lastStarted = op;
  if (s.dialog) cancelDialog();
  if (FACE_TOOLS.has(op) && selectionOnMesh()) {
    if (op === "sketch") set({ selection: [] });
    else return toast(meshHint(hasPack("scan")));
  }
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
  // A design shared with someone keeps its gears and springs, but only the pack changes them.
  if (refuseLocked(f, featureName(f))) return;
  set({ dialog: { feature: structuredClone(f), isNew: false, field: null }, selection: [] });
  scheduleRebuild();
}

/** A hole dialog with its face and first hole where the face was tapped. */
export function startHoleAt(pick: Pick): void {
  if (pick.kind !== "face" || !pick.normal) return;
  const plane = planeSpecForPick(pick, get().output?.meshes ?? []);
  if (!plane) return;
  // The right-click selected the face; the dialog would take that as a second tap.
  set({ selection: [] });
  startFeature("hole");
  const [u, v] = toSketch(frameFromPlane(pick.point, pick.normal), pick.point);
  updateDraft({ plane, points: [[Math.round(u * 100) / 100, Math.round(v * 100) / 100]] } as Partial<Feature>);
  setDialogField("points");
}

/** Opens the dialog for a prepared draft, e.g. the mating gear of the one just added. */
export function openDraft(feature: Feature): void {
  if (get().dialog) cancelDialog();
  set({ dialog: { feature, isNew: true, field: null }, selection: [] });
  scheduleRebuild();
}

/** Opens a dialog for an already-built draft (used by drag gestures). */
export function startDraft(feature: Feature): void {
  if (get().dialog) cancelDialog();
  set({ dialog: { feature, isNew: true, field: null, gesture: true }, selection: [] });
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
  // A rail with its carriage or a lead screw with its nut gets the joints that make them move.
  if (d.isNew) ok = apply(...withMotion([{ type: "add_features", features: [d.feature] }], docStore.doc));
  else {
    // Keys the draft dropped must be deleted (null) rather than merged back from the original.
    const original = docStore.doc.features.find((f) => f.id === d.feature.id) ?? {};
    const patch: Record<string, unknown> = { ...(d.feature as unknown as Record<string, unknown>) };
    for (const k of Object.keys(original)) if (!(k in patch)) patch[k] = null;
    ok = apply(...withMotion([{ type: "edit_feature", id: d.feature.id, patch }], docStore.doc));
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
      gear: "plane",
      coil: "profile",
      spring: "plane",
      cable: "points",
      screw: "plane",
      hole: "plane",
      standard_part: "plane",
      label: "plane",
      box: "plane",
      snap_hook: "plane",
      draft: "faces",
      offset_face: "faces",
      texture: "faces",
      align: "from",
      scale: "bodies",
      bend: "bodies",
      loft: "profiles",
      sweep: "profile",
      mesh_convert: "body",
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
  // Sketching ends measuring (one mode at a time).
  set({ sketchId: id, selection: [], dialog: null, selectedFeature: id, measure: { active: false, picks: [], result: null } });
}

export function closeSketch(): void {
  set({ sketchId: null, selection: [] });
}

// ---------------------------------------------------------------- projects

// Projects changed outside the app (another device through iCloud, the Finder): list them again.
if (typeof window !== "undefined") window.addEventListener("meercad:projects-changed", () => void refreshProjects());

export async function refreshProjects(): Promise<void> {
  const [projects, folders] = await Promise.all([listProjects(), listFolders()]);
  set({ projects, folders, folder: folders.includes(get().folder) ? get().folder : "" });
  // Tabs of projects that no longer exist close; names follow renames made elsewhere.
  const byId = new Map(projects.map((p) => [p.id, p]));
  const tabs = get().tabs.filter((t) => byId.has(t.id) || t.id === get().project?.id).map((t) => (byId.has(t.id) ? { ...t, name: byId.get(t.id)!.name } : t));
  if (tabs.length !== get().tabs.length || tabs.some((t, i) => t.name !== get().tabs[i]!.name)) setTabs(tabs);
}

/** Another window saved a project: a copy kept in memory for a tab in the background would be stale. */
export function dropCachedTab(id: string): void {
  if (get().project?.id !== id) tabStores.delete(id);
}

/** Openings running (see lib/opening): another tap on the card while one runs starts no second one. */
const opening = openGuard();

/**
 * Opens a project in a tab. A project an assistant works on is open in its tab only: that tab
 * comes to the front instead. While it is being opened, opening it again waits for that opening.
 */
export function openProject(id: string): Promise<void> {
  if (get().project?.id === id && get().screen === "editor") return Promise.resolve();
  return opening.run(id, (current) => openProjectNow(id, current));
}

async function openProjectNow(id: string, current: () => boolean): Promise<void> {
  const held = assistantWindow ? undefined : get().assistantTabs.find((a) => a.project === id);
  if (held) return showAssistantTab(held.session);
  await flushSave(true);
  const cached = tabStores.get(id);
  const tab = get().tabs.find((t) => t.id === id);
  if (cached && tab) {
    if (!current()) return;
    loadDoc(cached.doc, { id, name: tab.name, folder: tab.folder ?? "", updatedAt: Date.now() }, cached);
    history.replaceState(null, "", `#/p/${encodeURIComponent(id)}`);
    return;
  }
  // Reading can take a while (a big design, or one still coming from iCloud): shown as a task.
  const reading = startTask(t("Opening {name} …", { name: id.split("/").pop() ?? id }), null, { untilEditor: true });
  const p = await loadProject(id)
    .catch(() => undefined)
    .finally(() => reading.done());
  // Another project was asked for meanwhile: that one gets the editor.
  if (!current()) return;
  if (!p) {
    toast(t("Project not found"), "error");
    closeTab(id, false);
    return;
  }
  loadDoc(p.doc, { id: p.id, name: p.name, folder: p.folder ?? "", updatedAt: p.updatedAt });
  history.replaceState(null, "", `#/p/${encodeURIComponent(p.id)}`);
}

/**
 * Switches the unit this design shows and takes lengths in. Nothing changes size: plain values are
 * millimetres underneath and values with a unit keep it. Undoable like any edit.
 */
setUnitSource(() => get().doc.units ?? "mm");
setFeatureLabels((id) => {
  const f = get().doc.features.find((x) => x.id === id);
  return f ? featureName(f) : id;
});
/** The open design's length unit, for components that re-render when it changes. */
export const useDocUnit = (): LengthUnit => useApp((s) => s.doc.units ?? "mm");

export function setDesignUnits(units: "mm" | "in"): void {
  const doc = docStore.doc;
  if ((doc.units ?? "mm") === units) return;
  const { units: _old, ...rest } = doc;
  if (!apply({ type: "replace", doc: units === "in" ? { ...rest, units } : rest })) return;
  toast(units === "in" ? t("This design now uses inches") : t("This design now uses millimetres"));
}

/** `doc` with the fit measured on this device's printer, unless it has its own. */
export function withPrinterFit(doc: MeercadDocument): MeercadDocument {
  const fit = usePrefs.getState().printerFit;
  return fit === null || doc.fit !== undefined ? doc : { ...doc, fit: `${fit} mm` };
}

/** `fresh`: a starter model rather than a file, which takes this device's settings like a blank design. */
export async function newProject(doc: MeercadDocument = emptyDocument(), name = t("Untitled part"), fresh = false): Promise<void> {
  await flushSave();
  // A blank design starts in the measuring system chosen in Settings.
  if (!doc.features.length && !Object.keys(doc.params).length && !doc.units && usePrefs.getState().units === "imperial") doc = { ...doc, units: "in" };
  // A blank design (or a starter model) gets the fit measured on this device's printer; a file
  // opened keeps what it has, so its sizes stay as they were.
  if (!doc.features.length || fresh) doc = withPrinterFit(doc);
  // New parts land next to the open project, or in the folder the overview shows.
  const meta = await createProject(name, doc, get().project?.folder ?? get().folder);
  loadDoc(doc, meta);
  history.replaceState(null, "", `#/p/${encodeURIComponent(meta.id)}`);
}

function loadDoc(doc: MeercadDocument, meta: ProjectMeta, store?: DocumentStore): void {
  // Steps an earlier version had and this one no longer offers (the surface texture) are left out;
  // the next save writes the design without them.
  const cleaned = store ? { doc, removed: [] } : withoutRemovedFeatures(doc);
  if (cleaned.removed.length) {
    doc = cleaned.doc;
    toast(t("This design had a surface texture. meerCAD no longer has it, so the part now shows smooth."), "info");
  }
  // Nothing of this project is on screen until its first rebuild ends.
  shownDoc = null;
  thumbDoc = null;
  const leaving = get().project;
  if (leaving) tabStores.set(leaving.id, docStore);
  // The same design again (back from the overview) is built from what the kernel kept.
  if (!desktop) {
    const kind = kernelKindFor(doc.features.length, { mobile: true, threads: kernelName === "kernel-threads" });
    if (kind !== kernelKind) kernel.restart(new KernelWorker({ name: kind }));
    else if (kernelProject !== meta.id) kernel.restartIfAbove(RESTART_ABOVE, () => new KernelWorker({ name: kind }));
    kernelKind = kind;
  }
  kernelProject = meta.id;
  docStore = store ?? new DocumentStore(doc);
  tabStores.set(meta.id, docStore);
  if (!get().tabs.some((t) => t.id === meta.id)) setTabs([...get().tabs, { id: meta.id, name: meta.name, ...(meta.folder ? { folder: meta.folder } : {}) }]);
  set((s) => ({
    screen: "editor",
    // The editor shows its own progress from here on ("Building the model").
    tasks: tasksOnEditor(s.tasks),
    assistantTab: null,
    project: meta,
    dialog: null,
    sketchId: null,
    selection: [],
    output: null,
    // A rebuild still running for the tab left behind reports on that tab, not here.
    buildProgress: null,
    hidden: new Set(),
    measure: { active: false, picks: [], result: null },
    proposalDoc: null,
    saveState: "saved",
    selectedFeature: null,
  }));
  syncDoc();
  set({ saveState: "saved" });
  showKeptOutput(meta.id);
  void notePacks(meta.id, doc);
}

/**
 * Whether a design's last result is kept for its next opening. Not a big design's on the iPad and
 * iPhone: the kept result and the new one are both in memory for a moment (and a copy while it is
 * written), which the page has no room for next to the kernel of such a design.
 */
const keepsOutput = (doc: MeercadDocument) => !!desktop || doc.features.length <= BIG_STEPS;

/**
 * Shows what the project looked like when it was last built here (openCache), while the kernel
 * builds it again; only for exactly the same document, and only until the real result is there.
 */
function showKeptOutput(project: string): void {
  const store = docStore;
  const doc = store.doc;
  if (!doc.features.length || !keepsOutput(doc)) return;
  void readOutput(project, outputKey(doc, editorMeshOptions())).then((kept) => {
    if (!kept || docStore !== store || store.doc !== doc || get().output || get().dialog || get().proposalDoc) return;
    set({ output: kept, baseOutput: kept, previewing: false, buildProgress: null });
  });
}

/** After a finished rebuild the result is kept for the next opening (openCache), once things are quiet. */
let outputCacheTimer: number | undefined;
function scheduleOutputCache(): void {
  const project = get().project?.id;
  const store = docStore;
  const doc = store.doc;
  if (!project || !keepsOutput(doc)) return;
  clearTimeout(outputCacheTimer);
  outputCacheTimer = window.setTimeout(() => {
    // Still this project's latest result (with volumes and areas filled in by now)?
    if (docStore !== store || store.doc !== doc || shownDoc !== doc || get().previewing) return;
    const output = get().baseOutput;
    if (output) void writeOutput(project, outputKey(doc, editorMeshOptions()), output);
  }, 1500);
}

export const undoAvailable = () => docStore.canUndo;

export function goHome(): void {
  const p = get().project;
  if (p) tabStores.set(p.id, docStore);
  void flushSave(true).then(refreshProjects);
  set({ screen: "home", assistantTab: null, project: null, sketchId: null, dialog: null });
  history.replaceState(null, "", "#/");
}

// ---------------------------------------------------------------- assistants' tabs

/** Shows an assistant's tab: the project open here stays in its tab in the background. */
export function showAssistantTab(session: string): void {
  if (get().assistantTab === session) return;
  const p = get().project;
  if (p) tabStores.set(p.id, docStore);
  // Saves before the project is let go (flushSave reads it right away).
  void flushSave(true);
  set({ screen: "home", assistantTab: session, project: null, sketchId: null, dialog: null });
  history.replaceState(null, "", "#/");
}

/** Sessions being handed over: their tab disappearing is expected. */
const handingOver = new Set<string>();

/** The assistants' tabs changed (main process): a closed one that was open falls back to a neighbour or Home. */
export function setAssistantTabs(list: AssistantTab[]): void {
  const open = get().assistantTab;
  set({ assistantTabs: list });
  if (open && !list.some((a) => a.session === open) && !handingOver.has(open)) leaveAssistantTab();
}

function leaveAssistantTab(): void {
  const next = get().tabs.at(-1);
  if (next) void openProject(next.id);
  else goHome();
}

/**
 * The user takes over an assistant's tab (`keep`: its project stays open in a tab of the user's),
 * or closes it; also when the assistant's session ended, it closed the project itself (close_project,
 * `why` "released") or sat idle ("idle"). The assistant's page saves and goes.
 */
export async function handOverAssistantTab(session: string, keep = true, why: "closed" | "released" | "idle" = "closed"): Promise<void> {
  const a = desktop?.assistant;
  if (!a || handingOver.has(session)) return;
  handingOver.add(session);
  try {
    const project = await a.handOver(session, why);
    const wasOpen = get().assistantTab === session;
    if (project && keep) {
      // Its copy in memory (if the user had it open before) is stale.
      tabStores.delete(project.id);
      if (!get().tabs.some((t) => t.id === project.id)) setTabs([...get().tabs, { id: project.id, name: project.name }]);
      if (wasOpen) await openProject(project.id);
    } else if (wasOpen) leaveAssistantTab();
  } finally {
    handingOver.delete(session);
    set({ assistantTabs: get().assistantTabs.filter((x) => x.session !== session) });
  }
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
    toast(t("Could not rename: {msg}", { msg: e instanceof Error ? e.message : String(e) }), "error");
  }
}

let saveTimer: number | undefined;
function scheduleSave(): void {
  if (!get().project) return;
  set({ saveState: "unsaved" });
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flushSave(), 800);
}

/** The document whose final rebuild the view shows (pictureState.ts). */
let shownDoc: MeercadDocument | null = null;
/** The document the open project's saved picture shows. */
let thumbDoc: MeercadDocument | null = null;

/**
 * After every finished rebuild the project's picture is brought up to date (a save during a long
 * rebuild leaves it out, see pictureState.ts), also when nothing was changed yet.
 */
let thumbTimer: number | undefined;
function scheduleThumbnail(): void {
  const p = get().project;
  if (!p || thumbDoc === docStore.doc) return;
  clearTimeout(thumbTimer);
  thumbTimer = window.setTimeout(() => {
    if (get().project?.id !== p.id || get().sketchId || get().dialog || thumbDoc === docStore.doc) return;
    // A pending save takes the picture along.
    if (get().saveState !== "saved") return void flushSave();
    const doc = docStore.doc;
    const thumbnail = snapshot();
    if (!thumbnail) return;
    thumbDoc = doc;
    saveThumbnail(p.id, thumbnail).catch(() => undefined);
  }, 1200);
}

function snapshot(): string | undefined {
  // Without its terrain while that is still being read: the picture waits for the next save.
  if (viewportRef?.sceneryLoading) return undefined;
  // Still rebuilding: the view shows an earlier state, or nothing yet.
  if (!viewIsCurrent({ shown: shownDoc, current: docStore.doc, previewing: get().previewing || !!get().proposalDoc })) return undefined;
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
  const doc = docStore.doc;
  const thumbnail = snapshot();
  try {
    await saveProject({ ...p, updatedAt: Date.now(), doc, ...(thumbnail ? { thumbnail } : {}) });
    if (thumbnail && get().project?.id === p.id) thumbDoc = doc;
    set({ saveState: "saved" });
  } catch (e) {
    set({ saveState: "unsaved" });
    toast(t("Could not save: {msg}", { msg: e instanceof Error ? e.message : String(e) }), "error");
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

/**
 * An assistant opens this project in its own tab: it is saved and the user's tab of it closes (the
 * open one switches to its neighbour, or home), so the project is open in one tab only.
 */
export async function releaseProject(id: string): Promise<void> {
  const tabs = get().tabs;
  const i = tabs.findIndex((t) => t.id === id);
  const active = get().project?.id === id && get().screen === "editor";
  if (active) await flushSave(true);
  tabStores.delete(id);
  if (i >= 0) setTabs(get().tabs.filter((t) => t.id !== id));
  if (!active) return;
  const next = tabs[i + 1] ?? tabs[i - 1];
  if (next) await openProject(next.id);
  else goHome();
  // Switching away kept a copy of it for its tab, which is gone.
  tabStores.delete(id);
}

export function reopenClosedTab(): void {
  const id = closedTabs.pop();
  if (id) void openProject(id);
}

/** Switches to the next (+1) or previous (-1) tab, wrapping around; the assistants' tabs come after the user's. */
export function cycleTab(step: 1 | -1): void {
  const all = [...get().tabs.map((t) => ({ id: t.id, session: null as string | null })), ...get().assistantTabs.map((a) => ({ id: "", session: a.session as string | null }))];
  if (!all.length) return;
  const open = get().assistantTab;
  const i = all.findIndex((t) => (open ? t.session === open : t.session === null && t.id === get().project?.id));
  const next = all[(i < 0 && step < 0 ? 0 : i + step + all.length) % all.length]!;
  if (next.session) showAssistantTab(next.session);
  else void openProject(next.id);
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
