/**
 * Pictures for projects that have none: files put into the projects folder from outside (Finder,
 * iCloud, an assistant) or never opened here. While the overview is shown, each one is rebuilt and
 * pictured off screen, one at a time.
 *
 * They are built in a kernel of their own, so a project that takes minutes to rebuild never holds up
 * the editor: opening a project, or a picture taking longer than LIMIT_MS, ends that kernel at once.
 * A project that could not be pictured is not tried again until its file changes.
 */
import type { KernelClient, RebuildOutput } from "@meercad/kernel/client";
import type { MeercadDocument } from "@meercad/schema";
import { Viewport } from "@meercad/viewport";
import { spareKernel, useApp } from "../store";
import { meshBodyIds } from "./meshParts";
import { loadProject, saveThumbnail, type ProjectMeta } from "./persistence";

const LIMIT_MS = 60_000;
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

/** Rebuilds `doc` in the background kernel; rejects with Stopped on leaving the overview or after LIMIT_MS. */
async function build(doc: MeercadDocument): Promise<RebuildOutput> {
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
          reject(new Error(`took longer than ${LIMIT_MS / 1000} s`));
        }, LIMIT_MS);
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

let busy = false;
/** The examples' pictures first (quick), then the projects'; one run at a time. */
export async function fillThumbnails(examples: readonly { name: string; thumbnail?: string; doc: MeercadDocument }[], done: () => void): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await fillExampleThumbnails(examples, done);
    await fillMissingThumbnails();
  } finally {
    busy = false;
  }
}

const tried = new Set<string>();

async function fillMissingThumbnails(): Promise<void> {
  let host: HTMLDivElement | null = null;
  let vp: Viewport | null = null;
  try {
    for (;;) {
      const s = useApp.getState();
      if (s.screen !== "home") return;
      const gaveUp = failed();
      const next = s.projects.find((p) => !p.thumbnail && !tried.has(p.id) && gaveUp[p.id] !== p.updatedAt);
      if (!next) return;
      tried.add(next.id);
      try {
        const project = await loadProject(next.id);
        if (!project || useApp.getState().screen !== "home") continue;
        const output = await build(project.doc);
        if (!output.meshes.length || useApp.getState().screen !== "home") continue;
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
        vp.setView("iso", false);
        const thumbnail = vp.snapshot(480, 360, true);
        await saveThumbnail(next.id, thumbnail);
        useApp.setState((st) => ({ projects: st.projects.map((p) => (p.id === next.id ? { ...p, thumbnail } : p)) }));
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
 * browser's storage (keyed by the example's content, so a changed example gets a new picture).
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

/** Makes the missing example pictures one by one; `done` is called after each. */
async function fillExampleThumbnails(examples: readonly { name: string; thumbnail?: string; doc: MeercadDocument }[], done: () => void): Promise<void> {
  let host: HTMLDivElement | null = null;
  let vp: Viewport | null = null;
  try {
    for (const ex of examples) {
      if (ex.thumbnail || exampleThumbnail(ex.name, ex.doc) || useApp.getState().screen !== "home") continue;
      try {
        const output = await build(ex.doc);
        if (!output.meshes.length || useApp.getState().screen !== "home") continue;
        if (!vp) {
          host = document.createElement("div");
          host.style.cssText = "position:fixed;left:-10000px;top:0;width:480px;height:360px;pointer-events:none";
          document.body.append(host);
          vp = new Viewport(host);
        }
        vp.setScene({ bodies: output.meshes, sketches: [], planes: [], references: [] });
        vp.setView("iso", false);
        const shot = vp.snapshot(480, 360, true);
        const key = keyOf(ex.name, ex.doc);
        exampleShots.set(key, shot);
        try {
          localStorage.setItem(key, shot);
        } catch {
          // Full or off: kept for this session only.
        }
        done();
      } catch (e) {
        if (e instanceof Stopped) return;
        console.warn(`no picture for example ${ex.name}:`, e);
      }
    }
  } finally {
    vp?.dispose();
    host?.remove();
  }
}
