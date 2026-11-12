/**
 * The app's tests run in happy-dom with the Mac app's file interface (window.meercadDesktop) kept
 * in memory: projects and folders live in `testFiles` for the duration of a test file.
 */
import type { MeercadDocument } from "@meercad/schema";

interface Stored {
  id: string;
  name: string;
  folder: string;
  doc: MeercadDocument;
  modified: number;
  thumbnail?: string;
}

export const testFiles = { projects: new Map<string, Stored>(), folders: new Set<string>(), saves: 0 };

let n = 0;
const meta = (p: Stored) => ({ id: p.id, name: p.name, folder: p.folder, modified: p.modified, ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}) });

const desktop = {
  isDesktop: true,
  installClaudeDesktop: async () => null,
  info: async () => ({ version: "test", projectsDir: "/test", mcpCommand: { command: "node", args: [] }, channel: "wip" as const }),
  projects: {
    list: async () => [...testFiles.projects.values()].map(meta),
    load: async (id: string) => {
      const p = testFiles.projects.get(id);
      return p && { ...meta(p), doc: structuredClone(p.doc) };
    },
    save: async (p: { id: string; doc: MeercadDocument; thumbnail?: string }) => {
      const had = testFiles.projects.get(p.id);
      if (!had) throw new Error(`no project ${p.id}`);
      testFiles.saves++;
      testFiles.projects.set(p.id, { ...had, doc: structuredClone(p.doc), modified: Date.now(), ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}) });
    },
    thumbnail: async (p: { id: string; thumbnail: string }) => {
      const had = testFiles.projects.get(p.id);
      if (had) had.thumbnail = p.thumbnail;
    },
    create: async (p: { name: string; doc: MeercadDocument; folder?: string; test?: boolean }) => {
      const folder = p.test ? ".tests" : (p.folder ?? "");
      const id = `${folder ? `${folder}/` : ""}${p.name}-${++n}.meercad`;
      const s: Stored = { id, name: p.name, folder, doc: structuredClone(p.doc), modified: Date.now() };
      testFiles.projects.set(id, s);
      return meta(s);
    },
    rename: async (p: { id: string; name: string }) => {
      const had = testFiles.projects.get(p.id)!;
      testFiles.projects.delete(p.id);
      const id = `${had.folder ? `${had.folder}/` : ""}${p.name}.meercad`;
      testFiles.projects.set(id, { ...had, id, name: p.name });
      return { id, name: p.name, folder: had.folder };
    },
    move: async (p: { id: string; folder: string }) => {
      const had = testFiles.projects.get(p.id)!;
      testFiles.projects.delete(p.id);
      const id = `${p.folder ? `${p.folder}/` : ""}${had.name}.meercad`;
      testFiles.projects.set(id, { ...had, id, folder: p.folder });
      return { id, name: had.name, folder: p.folder };
    },
    folders: async () => [...testFiles.folders],
    delete: async (id: string) => void testFiles.projects.delete(id),
    reveal: async () => undefined,
  },
  folders: {
    create: async (p: { parent: string; name: string }) => {
      const f = p.parent ? `${p.parent}/${p.name}` : p.name;
      testFiles.folders.add(f);
      return f;
    },
    rename: async (p: { folder: string; name: string }) => {
      testFiles.folders.delete(p.folder);
      const f = [...p.folder.split("/").slice(0, -1), p.name].join("/");
      testFiles.folders.add(f);
      return f;
    },
    delete: async (folder: string) => void testFiles.folders.delete(folder),
  },
  storage: {
    status: async () => ({ dir: "/test", defaultDir: "/test", chosen: false, iCloudDir: "", iCloudAvailable: false }),
    choose: async () => null,
    count: async () => testFiles.projects.size,
    set: async (p: { dir: string }) => ({ dir: p.dir, moved: 0, skipped: 0 }),
  },
  photos: { build: async () => null, cancel: async () => undefined },
  uiScale: { get: async () => null, set: async () => undefined },
  editNative: async () => undefined,
  saveFile: async () => null,
  on: () => () => undefined,
};

(window as unknown as { meercadDesktop: typeof desktop }).meercadDesktop = desktop;

// A page that is not cross-origin isolated: the single-threaded kernel, as on a plain-http address.
(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = false;
