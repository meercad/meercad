/**
 * Local-first project storage. In the desktop app projects are plain .leocad files (open JSON
 * format) in a folder the user picks on first launch; in the browser they live in IndexedDB.
 */
import type { LeocadDocument } from "@leocad/schema";

export interface ProjectMeta {
  id: string;
  name: string;
  /** Folder path like "Clients/Acme"; "" is the top level. */
  folder?: string;
  updatedAt: number;
  thumbnail?: string;
}
export interface Project extends ProjectMeta {
  doc: LeocadDocument;
}

interface DesktopApi {
  isDesktop: true;
  installClaudeDesktop(): Promise<string>;
  info(): Promise<{ version: string; projectsDir: string; mcpCommand: { command: string; args: string[]; env?: Record<string, string> } }>;
  projects: {
    list(): Promise<ProjectMeta[]>;
    load(id: string): Promise<Project>;
    save(p: { id: string; doc: LeocadDocument; thumbnail?: string }): Promise<void>;
    create(p: { name: string; doc: LeocadDocument; folder?: string }): Promise<ProjectMeta>;
    rename(p: { id: string; name: string }): Promise<{ id: string; name: string; folder: string }>;
    move(p: { id: string; folder: string }): Promise<{ id: string; name: string; folder: string }>;
    folders(): Promise<string[]>;
    delete(id: string): Promise<void>;
    reveal(p?: string | { folder: string }): Promise<void>;
  };
  folders: {
    create(p: { parent: string; name: string }): Promise<string>;
    rename(p: { folder: string; name: string }): Promise<string>;
    delete(folder: string): Promise<void>;
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

// Browser: projects carry a folder field; empty folders are remembered separately.
const FOLDERS_KEY = "leocad.folders";
function storedFolders(): string[] {
  try {
    return JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}
function storeFolders(list: string[]): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify([...new Set(list)].sort()));
  } catch {
    // folders without projects just won't persist
  }
}
const allProjects = () => tx<Project[]>("readonly", (s) => s.getAll() as IDBRequest<Project[]>);
const inFolder = (folder: string | undefined, root: string) => !!folder && (folder === root || folder.startsWith(`${root}/`));

// ---------------------------------------------------------------- API

export async function listProjects(): Promise<ProjectMeta[]> {
  if (desktop) return desktop.projects.list();
  try {
    const all = await allProjects();
    return all.map(({ id, name, folder, updatedAt, thumbnail }) => ({ id, name, folder: folder ?? "", updatedAt, ...(thumbnail ? { thumbnail } : {}) })).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function loadProject(id: string): Promise<Project | undefined> {
  if (desktop) return desktop.projects.load(id);
  return tx<Project | undefined>("readonly", (s) => s.get(id) as IDBRequest<Project | undefined>);
}

export async function createProject(name: string, doc: LeocadDocument, folder = ""): Promise<ProjectMeta> {
  if (desktop) return desktop.projects.create({ name, doc, folder });
  const meta = { id: newId(), name, folder, updatedAt: Date.now() };
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

// ---------------------------------------------------------------- folders

/** Every folder path, parents before children. */
export async function listFolders(): Promise<string[]> {
  if (desktop) return desktop.projects.folders();
  const set = new Set(storedFolders());
  for (const p of await allProjects().catch(() => [] as Project[])) {
    const parts = (p.folder ?? "").split("/").filter(Boolean);
    parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join("/")));
  }
  return [...set].sort();
}

export async function createFolder(parent: string, name: string): Promise<string> {
  if (desktop) return desktop.folders.create({ parent, name });
  const base = name.replace(/\//g, "-").trim() || "New folder";
  const existing = await listFolders();
  let folder = parent ? `${parent}/${base}` : base;
  for (let n = 2; existing.includes(folder); n++) folder = parent ? `${parent}/${base} ${n}` : `${base} ${n}`;
  storeFolders([...storedFolders(), folder]);
  return folder;
}

export async function renameFolder(folder: string, name: string): Promise<string> {
  if (desktop) return desktop.folders.rename({ folder, name });
  const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
  const target = (parent ? `${parent}/` : "") + (name.replace(/\//g, "-").trim() || folder);
  if ((await listFolders()).includes(target) && target !== folder) throw new Error(`a folder named "${name}" already exists`);
  const re = (f: string) => (inFolder(f, folder) ? target + f.slice(folder.length) : f);
  storeFolders(storedFolders().map(re));
  for (const p of await allProjects()) if (inFolder(p.folder, folder)) await tx("readwrite", (s) => s.put({ ...p, folder: re(p.folder!) }));
  return target;
}

/** Deletes a folder and every project inside it. */
export async function deleteFolder(folder: string): Promise<void> {
  if (desktop) return desktop.folders.delete(folder);
  storeFolders(storedFolders().filter((f) => !inFolder(f, folder)));
  for (const p of await allProjects()) if (inFolder(p.folder, folder)) await tx("readwrite", (s) => s.delete(p.id));
}

/** Moves a project into a folder; in the desktop app the file moves, so the id changes. */
export async function moveProject(id: string, folder: string): Promise<ProjectMeta> {
  if (desktop) return { ...(await desktop.projects.move({ id, folder })), updatedAt: Date.now() };
  const p = await loadProject(id);
  if (!p) throw new Error("project not found");
  await tx("readwrite", (s) => s.put({ ...p, folder }));
  return { id, name: p.name, folder, updatedAt: p.updatedAt };
}
