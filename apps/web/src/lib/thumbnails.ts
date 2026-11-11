/**
 * Pictures for projects that have none, or an outdated one: files put into the projects folder from
 * outside (Finder, iCloud, an assistant), never opened here, changed elsewhere (the iPad, another
 * meerCAD copy), saved while their rebuild was still running, empty, or drawn in an older look (see
 * pictureState.ts). From
 * the app's start, each one is rebuilt and pictured off screen, one at a time, before the examples'
 * pictures.
 *
 * They are built in a kernel of their own, so a project that takes minutes to rebuild never holds up
 * the editor; a picture taking longer than its limit ends that kernel.
 * A project that could not be pictured is not tried again until its file changes.
 *
 * On the iPad and iPhone the page has room for one kernel only: OCCT keeps the memory of every cut
 * and join (docs/REBUILD.md) and takes it in blocks of up to a GB (a box with a shell and three
 * roundings went from 100 MB to over 1 GB), and a page that grows past the system's limit is ended
 * and loaded again. A second kernel for the pictures did that, also for small designs, and as the
 * reloaded overview wanted the same picture again, the app went round in circles. There (see
 * `oneKernel`) pictures are built in the editor's own kernel, only while no project is open, and
 * only for designs of up to `BIG_STEPS` steps (a bigger one gets its picture from the editor when it
 * is opened); the kernel starts over once the pictures have taken `PICTURES_KERNEL_MAX`. A picture
 * whose build took the page down is not tried again until its file changes (`BUILDING_KEY`).
 */
import type { KernelClient, RebuildOutput } from "@meercad/kernel/client";
import type { MeercadDocument } from "@meercad/schema";
import { LOOK_VERSION, Viewport } from "@meercad/viewport";
import { editorMeshOptions, freshKernelIfAbove, kernel, refreshProjects, spareKernel, useApp } from "../store";
import { outputKey, writeOutput } from "./openCache";
import { usePrefs } from "./keymap";
import { meshBodyIds } from "./meshParts";
import { partColors } from "./partColors";
import { partLooks } from "./materials";
import { sceneryOf } from "./terrain";
import { desktop, loadProject, saveThumbnail, type ProjectMeta } from "./persistence";
import { BIG_FILE_BYTES, backgroundBuildAllowed, blankPixels, lookSince, needsPicture, pictureRunner, type LookMark } from "./pictureState";

/** A project gets a few minutes (the background kernel has one thread); an example a minute. */
const PROJECT_LIMIT_MS = 180_000;
const EXAMPLE_LIMIT_MS = 60_000;
/** iPad and iPhone: the kernel starts over once the pictures have taken this much (see above). */
const PICTURES_KERNEL_MAX = 600 * 2 ** 20;
/** The picture being built now, so that one which takes the page down is not tried again. */
const BUILDING_KEY = "meercad.picture-building";
/** iPad and iPhone: no room for the background kernel next to the editor's (see above). */
const oneKernel = !desktop;
/** Examples that took too long, by content key: not tried again (they ship with the app). */
const EXAMPLES_FAILED_KEY = "meercad.example-no-picture";
const FAILED_KEY = "meercad.no-picture";
const LOOK_KEY = "meercad.picture-look";

/** Since when pictures show the current look (see lookSince); older ones are made again. */
let lookTime: number | null = null;
function currentLookSince(): number {
  if (lookTime !== null) return lookTime;
  let stored: LookMark | null = null;
  try {
    stored = JSON.parse(localStorage.getItem(LOOK_KEY) ?? "null") as LookMark | null;
  } catch {
    // Unreadable: taken as a new look.
  }
  const mark = lookSince(stored, LOOK_VERSION, Date.now());
  try {
    if (mark !== stored) {
      localStorage.setItem(LOOK_KEY, JSON.stringify(mark));
      // The examples' pictures of the old look are not needed any more.
      const old: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith("meercad.example-thumb.") && !k.endsWith(`.v${LOOK_VERSION}`)) old.push(k);
      }
      old.forEach((k) => localStorage.removeItem(k));
    }
  } catch {
    // Without storage the pictures are made again next time too.
  }
  return (lookTime = mark.since);
}

let spare: KernelClient | null = null;
function endSpare(): void {
  spare?.terminate();
  spare = null;
}
/** A background build given up for the editor (oneKernel): not a failure, the project is tried again. */
class Stopped extends Error {
  constructor() {
    super("stopped for the editor");
  }
}
/** Ends the running background build, if any, with Stopped. */
let stopBuild: (() => void) | null = null;
const editorOpen = () => useApp.getState().project !== null;
/**
 * Rebuilds `doc` for a picture: in the background kernel, or on the iPad and iPhone in the editor's
 * (see oneKernel). Rejects after `limit` ms, or with Stopped. `building` names the picture while it
 * is built (see BUILDING_KEY).
 */
async function build(doc: MeercadDocument, limit: number, building: Building): Promise<RebuildOutput> {
  if (!backgroundBuildAllowed(doc, { oneKernel, editorOpen: editorOpen() })) throw new Stopped();
  const k = oneKernel ? kernel : (spare ??= spareKernel());
  let timer: ReturnType<typeof setTimeout> | undefined;
  remember(building);
  try {
    return await Promise.race([
      k.sandbox(doc),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // The editor's kernel is not ended: the build runs out there, before the next request.
          if (!oneKernel) endSpare();
          reject(new Error(`took longer than ${limit / 1000} s`));
        }, limit);
        stopBuild = () => {
          if (!oneKernel) endSpare();
          reject(new Stopped());
        };
      }),
    ]);
  } finally {
    clearTimeout(timer);
    stopBuild = null;
    remember(null);
    if (oneKernel) freshKernelIfAbove(PICTURES_KERNEL_MAX);
  }
}

/** A picture being built: a project at a file time, or an example by its key. */
type Building = { project: string; at: number } | { example: string };
function remember(b: Building | null): void {
  try {
    if (b) localStorage.setItem(BUILDING_KEY, JSON.stringify(b));
    else localStorage.removeItem(BUILDING_KEY);
  } catch {
    // Without storage a picture that takes the page down is tried again.
  }
}
/** At start: a picture still marked as being built took the page down; it is not tried again. */
function forgetCrashedPicture(): void {
  try {
    const b = JSON.parse(localStorage.getItem(BUILDING_KEY) ?? "null") as Building | null;
    localStorage.removeItem(BUILDING_KEY);
    if (!b) return;
    if ("project" in b) localStorage.setItem(FAILED_KEY, JSON.stringify({ ...failed(), [b.project]: b.at }));
    else exampleFailed(b.example);
    console.warn("a picture took the app down last time and is not made again:", b);
  } catch {
    // Nothing remembered.
  }
}

/** Projects that could not be pictured (or show nothing), by id, with the file's time then. */
function failed(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FAILED_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}
function markFailed(p: ProjectMeta): void {
  try {
    localStorage.setItem(FAILED_KEY, JSON.stringify({ ...failed(), [p.id]: p.updatedAt }));
  } catch {
    // Without storage it is tried again next time.
  }
}

/** Parts in the colours and materials the editor shows them in. */
function paintAsEditor(vp: Viewport, doc: MeercadDocument, output: RebuildOutput): void {
  const ids = output.report.bodies.map((b) => b.id);
  vp.setBodyColors(partColors(doc, ids, usePrefs.getState().colorParts));
  vp.setBodyLooks(partLooks(doc, ids));
}

type ExampleDoc = { name: string; thumbnail?: string; doc: MeercadDocument };
let examplesToPicture: { list: readonly ExampleDoc[]; done: () => void } = { list: [], done: () => undefined };
const runPictures = pictureRunner({
  projects: fillMissingThumbnails,
  // The background kernel's memory is given back once everything is pictured.
  examples: () => fillExampleThumbnails(examplesToPicture.list, examplesToPicture.done).finally(endSpare),
});
/** The projects' pictures first, then the examples' (see pictureRunner); `done` after each example. */
export function fillThumbnails(examples: readonly ExampleDoc[], done: () => void): Promise<void> {
  examplesToPicture = { list: examples, done };
  return runPictures();
}

/**
 * From the app's start on, whatever screen is shown: pictures that are missing, empty or older than
 * their file are made in the background, again whenever the list of projects changes.
 */
let started = false;
export function startBackgroundPictures(examples: readonly ExampleDoc[]): void {
  if (started) return;
  started = true;
  forgetCrashedPicture();
  if (examplesToPicture.list.length === 0) examplesToPicture = { list: examples, done: () => undefined };
  let seen = useApp.getState().projects;
  let open = editorOpen();
  useApp.subscribe((s) => {
    if (oneKernel && (s.project !== null) !== open) {
      open = s.project !== null;
      // The editor's kernel needs the room now; back on the overview, the pictures go on.
      if (open) stopBuild?.();
      else void runPictures();
    }
    if (s.projects === seen) return;
    seen = s.projects;
    void runPictures();
  });
  void refreshProjects().then(() => runPictures());
}

/** Tried this session, by id and file time: a file changed again gets another go. */
const tried = new Set<string>();

/** Pictures looked at for showing nothing, by their data URL. */
const blank = new Map<string, boolean>();
/** Empty pictures are small: only those are opened and looked at. */
const BLANK_MAX = 40_000;
async function findBlank(projects: readonly ProjectMeta[]): Promise<void> {
  for (const p of projects) {
    const url = p.thumbnail;
    if (!url || blank.has(url)) continue;
    if (url.length > BLANK_MAX) {
      blank.set(url, false);
      continue;
    }
    try {
      const img = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(96, 72);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 96, 72);
      img.close();
      blank.set(url, blankPixels(ctx.getImageData(0, 0, 96, 72).data));
    } catch {
      blank.set(url, false);
    }
  }
}
const triedKey = (p: ProjectMeta) => `${p.id}@${p.updatedAt}`;

async function fillMissingThumbnails(): Promise<void> {
  let host: HTMLDivElement | null = null;
  let vp: Viewport | null = null;
  try {
    for (;;) {
      await findBlank(useApp.getState().projects);
      const s = useApp.getState();
      const gaveUp = failed();
      // The project open in the editor gets its picture from there.
      const next = s.projects.find((p) => p.id !== s.project?.id && needsPicture(p, blank.get(p.thumbnail ?? "") ?? false, currentLookSince()) && !tried.has(triedKey(p)) && gaveUp[p.id] !== p.updatedAt);
      if (!next) return;
      tried.add(triedKey(next));
      // Too big to be read here at all; its picture comes from the editor.
      if (oneKernel && (next.size ?? 0) > BIG_FILE_BYTES) continue;
      try {
        const project = await loadProject(next.id);
        if (!project) continue;
        if (oneKernel && editorOpen()) {
          // Tried again once the editor is closed.
          tried.delete(triedKey(next));
          return;
        }
        if (!backgroundBuildAllowed(project.doc, { oneKernel, editorOpen: false })) continue;
        const output = await build(project.doc, PROJECT_LIMIT_MS, { project: next.id, at: next.updatedAt });
        // Built the way the editor builds it (sandbox: textures on, fine meshes): kept, so the
        // project opens at once (openCache).
        const opts = editorMeshOptions();
        if (opts.coarse === 1 && opts.textures) void writeOutput(project.id, outputKey(project.doc, opts), output);
        // Nothing to picture (an empty part): remembered like a failure, until the file changes.
        if (!output.meshes.length && !project.doc.references?.length) {
          markFailed(next);
          continue;
        }
        if (!vp) {
          host = document.createElement("div");
          host.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:360px;pointer-events:none";
          document.body.append(host);
          vp = new Viewport(host);
        }
        // Mesh parts without their triangle outlines, as in the editor.
        const meshParts = meshBodyIds(project.doc.features, output.meshes);
        const bodies = output.meshes.map((m) => (meshParts.has(m.bodyId) ? { ...m, edgeLines: new Float32Array(), edgeRanges: new Int32Array() } : m));
        vp.setScene({ bodies, sketches: [], planes: [], references: [] });
        paintAsEditor(vp, project.doc, output);
        await vp.setScenery(sceneryOf(project.doc));
        vp.setView("iso", false);
        const thumbnail = vp.snapshot(480, 360, true);
        await saveThumbnail(next.id, thumbnail);
        useApp.setState((st) => ({ projects: st.projects.map((p) => (p.id === next.id ? { ...p, thumbnail, thumbnailAt: Date.now() } : p)) }));
      } catch (e) {
        if (e instanceof Stopped) {
          tried.delete(triedKey(next));
          return;
        }
        // A broken or very slow file stays without one.
        markFailed(next);
        console.warn(`no picture for ${next.id}:`, e);
      }
    }
  } finally {
    vp?.dispose();
    host?.remove();
  }
}

/**
 * Pictures for home-screen examples that ship without one, made the same way and kept in the
 * app's web storage (keyed by the example's content, so a changed example gets a new picture).
 */
const exampleShots = new Map<string, string>();
const keyOf = (name: string, doc: MeercadDocument) => {
  let h = 0;
  for (const ch of JSON.stringify(doc)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  // The look's version too: a picture of an older look is made again.
  return `meercad.example-thumb.${name}.${(h >>> 0).toString(36)}.v${LOOK_VERSION}`;
};

export function exampleThumbnail(name: string, doc: MeercadDocument): string | null {
  const key = keyOf(name, doc);
  if (exampleShots.has(key)) return exampleShots.get(key)!;
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      exampleShots.set(key, stored);
      return stored;
    }
  } catch {
    // Storage can be off (private windows): the picture is just made again.
  }
  return null;
}

function examplesFailed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(EXAMPLES_FAILED_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function exampleFailed(key: string): void {
  try {
    localStorage.setItem(EXAMPLES_FAILED_KEY, JSON.stringify([...examplesFailed(), key]));
  } catch {
    // Without storage it is tried again next time.
  }
}

/** Makes the missing example pictures one by one; `done` is called after each. */
async function fillExampleThumbnails(examples: readonly { name: string; thumbnail?: string; doc: MeercadDocument }[], done: () => void): Promise<void> {
  let host: HTMLDivElement | null = null;
  let vp: Viewport | null = null;
  try {
    for (const ex of examples) {
      if (ex.thumbnail || exampleThumbnail(ex.name, ex.doc)) continue;
      const key = keyOf(ex.name, ex.doc);
      if (examplesFailed().includes(key)) continue;
      try {
        const output = await build(ex.doc, EXAMPLE_LIMIT_MS, { example: key });
        if (!output.meshes.length) continue;
        if (!vp) {
          host = document.createElement("div");
          host.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:360px;pointer-events:none";
          document.body.append(host);
          vp = new Viewport(host);
        }
        vp.setScene({ bodies: output.meshes, sketches: [], planes: [], references: [] });
        paintAsEditor(vp, ex.doc, output);
        vp.setView("iso", false);
        const shot = vp.snapshot(480, 360, true);
        exampleShots.set(key, shot);
        try {
          localStorage.setItem(key, shot);
        } catch {
          // Full or off: kept for this session only.
        }
        done();
      } catch (e) {
        if (e instanceof Stopped) return;
        exampleFailed(key);
        console.warn(`no picture for example ${ex.name}:`, e);
      }
    }
  } finally {
    vp?.dispose();
    host?.remove();
  }
}
