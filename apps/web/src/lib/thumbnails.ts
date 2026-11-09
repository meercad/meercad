/**
 * Pictures for projects that have none, or an outdated one: files put into the projects folder from
 * outside (Finder, iCloud, an assistant), never opened here, changed elsewhere (the iPad, another
 * meerCAD copy), saved while their rebuild was still running, or empty (see pictureState.ts). While
 * the overview is shown, each one is rebuilt and pictured off screen, one at a time, before the
 * examples' pictures.
 *
 * They are built in a kernel of their own, so a project that takes minutes to rebuild never holds up
 * the editor: opening a project, or a picture taking longer than its limit, ends that kernel at once.
 * A project that could not be pictured is not tried again until its file changes.
 */
import type { KernelClient, RebuildOutput } from "@meercad/kernel/client";
import type { MeercadDocument } from "@meercad/schema";
import { Viewport } from "@meercad/viewport";
import { spareKernel, useApp } from "../store";
import { usePrefs } from "./keymap";
import { meshBodyIds } from "./meshParts";
import { partColors } from "./partColors";
import { partLooks } from "./materials";
import { sceneryOf } from "./terrain";
import { loadProject, saveThumbnail, type ProjectMeta } from "./persistence";
import { blankPixels, needsPicture, pictureRunner } from "./pictureState";

/** A project gets a few minutes (the background kernel has one thread); an example a minute. */
const PROJECT_LIMIT_MS = 180_000;
const EXAMPLE_LIMIT_MS = 60_000;
/** Examples that took too long, by content key: not tried again (they ship with the app). */
const EXAMPLES_FAILED_KEY = "meercad.example-no-picture";
const FAILED_KEY = "meercad.no-picture";

class Stopped extends Error {}

let spare: KernelClient | null = null;
let stop: ((e: Error) => void) | null = null;
function endSpare(): void {
  spare?.terminate();
  spare = null;
}
// Leaving the overview ends the background kernel and whatever it was building.
useApp.subscribe((s) => {
  if (s.screen !== "home" && (spare || stop)) {
    stop?.(new Stopped());
    endSpare();
  }
});

/** Rebuilds `doc` in the background kernel; rejects with Stopped on leaving the overview or after `limit` ms. */
async function build(doc: MeercadDocument, limit: number): Promise<RebuildOutput> {
  if (useApp.getState().screen !== "home") throw new Stopped();
  spare ??= spareKernel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      spare.sandbox(doc),
      new Promise<never>((_, reject) => {
        stop = reject;
        timer = setTimeout(() => {
          endSpare();
          reject(new Error(`took longer than ${limit / 1000} s`));
        }, limit);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    stop = null;
  }
}

/** Projects that could not be pictured, by id, with the file's time then. */
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
  examples: () => fillExampleThumbnails(examplesToPicture.list, examplesToPicture.done),
});
/** The projects' pictures first, then the examples' (see pictureRunner). */
export function fillThumbnails(examples: readonly ExampleDoc[], done: () => void): Promise<void> {
  examplesToPicture = { list: examples, done };
  return runPictures();
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
      const s = useApp.getState();
      if (s.screen !== "home") return;
      await findBlank(s.projects);
      if (useApp.getState().screen !== "home") return;
      const gaveUp = failed();
      const next = s.projects.find((p) => needsPicture(p, blank.get(p.thumbnail ?? "") ?? false) && !tried.has(triedKey(p)) && gaveUp[p.id] !== p.updatedAt);
      if (!next) return;
      tried.add(triedKey(next));
      try {
        const project = await loadProject(next.id);
        if (!project || useApp.getState().screen !== "home") continue;
        const output = await build(project.doc, PROJECT_LIMIT_MS);
        if ((!output.meshes.length && !project.doc.references?.length) || useApp.getState().screen !== "home") continue;
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
        // Opening a project stops the pictures. A broken or very slow file stays without one.
        if (e instanceof Stopped) return;
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
  return `meercad.example-thumb.${name}.${(h >>> 0).toString(36)}`;
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
      if (ex.thumbnail || exampleThumbnail(ex.name, ex.doc) || useApp.getState().screen !== "home") continue;
      const key = keyOf(ex.name, ex.doc);
      if (examplesFailed().includes(key)) continue;
      try {
        const output = await build(ex.doc, EXAMPLE_LIMIT_MS);
        if (!output.meshes.length || useApp.getState().screen !== "home") continue;
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
