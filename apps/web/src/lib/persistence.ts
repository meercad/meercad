/**
 * Local-first project storage. In the desktop app projects are plain .leocad files (open JSON
 * format) in a folder the user picks on first launch; in the browser they live in IndexedDB.
 */
import type { LeocadDocument } from "@leocad/schema";

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  thumbnail?: string;
}
export interface Project extends ProjectMeta {
  doc: LeocadDocument;
}

interface DesktopApi {
  isDesktop: true;
  info(): Promise<{ version: string; projectsDir: string; mcpCommand: { command: string; args: string[]; env?: Record<string, string> } }>;
  projects: {
    list(): Promise<ProjectMeta[]>;
    load(id: string): Promise<Project>;
    save(p: { id: string; doc: LeocadDocument; thumbnail?: string }): Promise<void>;
    create(p: { name: string; doc: LeocadDocument }): Promise<ProjectMeta>;
    rename(p: { id: string; name: string }): Promise<{ id: string; name: string }>;
    delete(id: string): Promise<void>;
    reveal(id?: string): Promise<void>;
  };
  storage: {
    status(): Promise<{ dir: string; defaultDir: string; chosen: boolean }>;
    choose(): Promise<string | null>;
    count(): Promise<number>;
    set(p: { dir: string; move: boolean }): Promise<{ dir: string; moved: number; skipped: number }>;
  };
  saveFile(p: { name: string; data: Uint8Array | string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  updates: { check(): Promise<void>; install(): Promise<void> };
  on(channel: "menu" | "open-project" | "update-none" | "update-error" | "error", fn: (arg: string) => void): () => void;
  on(channel: "update-available", fn: (arg: { version: string; notes: string; page: string; canInstall: boolean }) => void): () => void;
  on(channel: "update-progress", fn: (arg: number) => void): () => void;
}

export const desktop: DesktopApi | undefined = (window as unknown as { leocadDesktop?: DesktopApi }).leocadDesktop;

// ---------------------------------------------------------------- IndexedDB (browser)

const DB = "leocad";
const STORE = "projects";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("storage error"));
  });
}

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------- API

export async function listProjects(): Promise<ProjectMeta[]> {
  if (desktop) return desktop.projects.list();
  try {
    const all = await tx<Project[]>("readonly", (s) => s.getAll() as IDBRequest<Project[]>);
    return all.map(({ id, name, updatedAt, thumbnail }) => ({ id, name, updatedAt, ...(thumbnail ? { thumbnail } : {}) })).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function loadProject(id: string): Promise<Project | undefined> {
  if (desktop) return desktop.projects.load(id);
  return tx<Project | undefined>("readonly", (s) => s.get(id) as IDBRequest<Project | undefined>);
}

export async function createProject(name: string, doc: LeocadDocument): Promise<ProjectMeta> {
  if (desktop) return desktop.projects.create({ name, doc });
  const meta = { id: newId(), name, updatedAt: Date.now() };
  await tx("readwrite", (s) => s.put({ ...meta, doc }));
  return meta;
}

export async function saveProject(p: Project): Promise<void> {
  if (desktop) return desktop.projects.save({ id: p.id, doc: p.doc, ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}) });
  await tx("readwrite", (s) => s.put(p));
}

/** Renames a project; in the desktop app this renames the file, so the id changes. */
export async function renameProjectFile(id: string, name: string): Promise<ProjectMeta> {
  if (desktop) {
    const r = await desktop.projects.rename({ id, name });
    return { ...r, updatedAt: Date.now() };
  }
  const p = await loadProject(id);
  if (p) await saveProject({ ...p, name });
  return { id, name, updatedAt: Date.now() };
}

export async function deleteProject(id: string): Promise<void> {
  if (desktop) return desktop.projects.delete(id);
  await tx("readwrite", (s) => s.delete(id));
}
