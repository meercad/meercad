/**
 * Pictures for projects that have none: files put into the projects folder from outside (Finder,
 * iCloud, an assistant) or never opened here. While the overview is shown, each one is rebuilt and
 * pictured off screen, one at a time; opening a project stops it.
 */
import { SupersededError } from "@meercad/kernel/client";
import type { MeercadDocument } from "@meercad/schema";
import { Viewport } from "@meercad/viewport";
import { kernel, useApp } from "../store";
import { meshBodyIds } from "./meshParts";
import { loadProject, saveThumbnail } from "./persistence";

const tried = new Set<string>();
let running = false;

export async function fillMissingThumbnails(): Promise<void> {
  if (running) return;
  running = true;
  let host: HTMLDivElement | null = null;
  let vp: Viewport | null = null;
  try {
    for (;;) {
      const s = useApp.getState();
      if (s.screen !== "home") return;
      const next = s.projects.find((p) => !p.thumbnail && !tried.has(p.id));
      if (!next) return;
      tried.add(next.id);
      try {
        const project = await loadProject(next.id);
        if (!project || useApp.getState().screen !== "home") continue;
        const output = await kernel.sandbox(project.doc);
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
        // A project being opened takes over the kernel: stop. A broken file just stays without a picture.
        if (e instanceof SupersededError) return;
        console.warn(`no picture for ${next.id}:`, e);
      }
    }
  } finally {
    vp?.dispose();
    host?.remove();
    running = false;
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

let examplesRunning = false;
/** Makes the missing example pictures one by one; `done` is called after each. */
export async function fillExampleThumbnails(examples: readonly { name: string; thumbnail?: string; doc: MeercadDocument }[], done: () => void): Promise<void> {
  if (examplesRunning) return;
  examplesRunning = true;
  let host: HTMLDivElement | null = null;
  let vp: Viewport | null = null;
  try {
    for (const ex of examples) {
      if (ex.thumbnail || exampleThumbnail(ex.name, ex.doc) || useApp.getState().screen !== "home") continue;
      try {
        const output = await kernel.sandbox(ex.doc);
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
        if (e instanceof SupersededError) return;
        console.warn(`no picture for example ${ex.name}:`, e);
      }
    }
  } finally {
    vp?.dispose();
    host?.remove();
    examplesRunning = false;
  }
}
