/**
 * Local-first project storage. In the desktop app projects are plain .meercad files (open JSON
 * format) in a folder the user picks on first launch, in the iPad app they are such files in the
 * app's Documents (see native.ts); in the browser they live in IndexedDB.
 */
import type { MeercadDocument } from "@meercad/schema";
import { nativeFiles } from "./native";
import { t } from "./i18n";

export interface ProjectMeta {
  id: string;
  name: string;
  /** Folder path like "Clients/Acme"; "" is the top level. */
  folder?: string;
  updatedAt: number;
  /** When the project was created (the file's birth time); older browser projects lack it. */
  createdAt?: number;
  thumbnail?: string;
}
export interface Project extends ProjectMeta {
  doc: MeercadDocument;
}

interface DesktopApi {
  isDesktop: true;
  /** The Claude Desktop config file written, or null when Claude Desktop was handed the extension to install. */
  installClaudeDesktop(): Promise<string | null>;
  info(): Promise<{ version: string; projectsDir: string; mcpCommand: { command: string; args: string[]; env?: Record<string, string> }; mas?: boolean; store?: "production" | "sandbox" | null }>;
  projects: {
    list(): Promise<ProjectMeta[]>;
    load(id: string): Promise<Project>;
    save(p: { id: string; doc: MeercadDocument; thumbnail?: string }): Promise<void>;
    /** Stores a project's picture without touching its file. */
    thumbnail(p: { id: string; thumbnail: string }): Promise<void>;
    create(p: { name: string; doc: MeercadDocument; folder?: string }): Promise<ProjectMeta>;
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
    status(): Promise<{ dir: string; defaultDir: string; chosen: boolean; iCloudDir: string; iCloudAvailable: boolean }>;
    choose(): Promise<string | null>;
    count(): Promise<number>;
    set(p: { dir: string; move: boolean }): Promise<{ dir: string; moved: number; skipped: number }>;
  };
  saveFile(p: { name: string; data: Uint8Array | string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  on(channel: "menu" | "open-project" | "projects-changed" | "error", fn: (arg: string) => void): () => void;
}

export const desktop: DesktopApi | undefined = (window as unknown as { meercadDesktop?: DesktopApi }).meercadDesktop;

/** Project files on disk: the desktop app's folder, or the iPad app's Documents. */
export interface FileStore {
  projects: Omit<DesktopApi["projects"], "reveal">;
  folders: DesktopApi["folders"];
}
const files: FileStore | undefined = desktop ?? nativeFiles;

// ---------------------------------------------------------------- IndexedDB (browser)

const DB = "meercad";
/** Where projects lived before the app was renamed; copied over once. */
const LEGACY_DB = "leocad";
const STORE = "projects";

let opened: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  return (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    let fresh = false;
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      fresh = true;
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!fresh) return resolve(db);
      void copyLegacyProjects(db).finally(() => resolve(db));
    };
    req.onerror = () => {
      opened = null;
      reject(req.error ?? new Error(t("IndexedDB unavailable")));
    };
  }));
}

/** Copies the projects of the old database into a freshly created one. */
async function copyLegacyProjects(db: IDBDatabase): Promise<void> {
  try {
    const names = (await indexedDB.databases?.()) ?? [];
    if (!names.some((d) => d.name === LEGACY_DB)) return;
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(LEGACY_DB);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    if (!legacy.objectStoreNames.contains(STORE)) return legacy.close();
    const all = await new Promise<Project[]>((resolve, reject) => {
      const r = legacy.transaction(STORE, "readonly").objectStore(STORE).getAll();
      r.onsuccess = () => resolve(r.result as Project[]);
      r.onerror = () => reject(r.error);
    });
    legacy.close();
    await new Promise<void>((resolve, reject) => {
      const tr = db.transaction(STORE, "readwrite");
      for (const p of all) tr.objectStore(STORE).put(p);
      tr.oncomplete = () => resolve();
      tr.onerror = () => reject(tr.error);
    });
  } catch {
    // nothing to carry over
  }
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tr = db.transaction(STORE, mode);
    const req = fn(tr.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(t("storage error")));
  });
}

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// Browser: projects carry a folder field; empty folders are remembered separately.
const FOLDERS_KEY = "meercad.folders";
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
  if (files) return files.projects.list();
  try {
    const all = await allProjects();
    return all
      .map(({ id, name, folder, updatedAt, createdAt, thumbnail }) => ({ id, name, folder: folder ?? "", updatedAt, ...(createdAt ? { createdAt } : {}), ...(thumbnail ? { thumbnail } : {}) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function loadProject(id: string): Promise<Project | undefined> {
  if (files) return files.projects.load(id);
  return tx<Project | undefined>("readonly", (s) => s.get(id) as IDBRequest<Project | undefined>);
}

export async function createProject(name: string, doc: MeercadDocument, folder = ""): Promise<ProjectMeta> {
  if (files) return files.projects.create({ name, doc, folder });
  const meta = { id: newId(), name, folder, updatedAt: Date.now(), createdAt: Date.now() };
  await tx("readwrite", (s) => s.put({ ...meta, doc }));
  return meta;
}

export async function saveProject(p: Project): Promise<void> {
  if (files) return files.projects.save({ id: p.id, doc: p.doc, ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}) });
  await tx("readwrite", (s) => s.put(p));
}

/** Stores a picture for a project that has none, leaving the project itself (and its date) alone. */
export async function saveThumbnail(id: string, thumbnail: string): Promise<void> {
  if (files) return files.projects.thumbnail({ id, thumbnail });
  const p = await loadProject(id);
  if (p) await tx("readwrite", (s) => s.put({ ...p, thumbnail }));
}

/** Renames a project; in the desktop app this renames the file, so the id changes. */
export async function renameProjectFile(id: string, name: string): Promise<ProjectMeta> {
  if (files) {
    const r = await files.projects.rename({ id, name });
    return { ...r, updatedAt: Date.now() };
  }
  const p = await loadProject(id);
  if (p) await saveProject({ ...p, name });
  return { id, name, updatedAt: Date.now() };
}

export async function deleteProject(id: string): Promise<void> {
  if (files) return files.projects.delete(id);
  await tx("readwrite", (s) => s.delete(id));
}

// ---------------------------------------------------------------- folders

/** Every folder path, parents before children. */
export async function listFolders(): Promise<string[]> {
  if (files) return files.projects.folders();
  const set = new Set(storedFolders());
  for (const p of await allProjects().catch(() => [] as Project[])) {
    const parts = (p.folder ?? "").split("/").filter(Boolean);
    parts.forEach((_, i) => set.add(parts.slice(0, i + 1).join("/")));
  }
  return [...set].sort();
}

export async function createFolder(parent: string, name: string): Promise<string> {
  if (files) return files.folders.create({ parent, name });
  const base = name.replace(/\//g, "-").trim() || t("New folder");
  const existing = await listFolders();
  let folder = parent ? `${parent}/${base}` : base;
  for (let n = 2; existing.includes(folder); n++) folder = parent ? `${parent}/${base} ${n}` : `${base} ${n}`;
  storeFolders([...storedFolders(), folder]);
  return folder;
}

export async function renameFolder(folder: string, name: string): Promise<string> {
  if (files) return files.folders.rename({ folder, name });
  const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
  const target = (parent ? `${parent}/` : "") + (name.replace(/\//g, "-").trim() || folder);
  if ((await listFolders()).includes(target) && target !== folder) throw new Error(t("a folder named “{name}” already exists", { name }));
  const re = (f: string) => (inFolder(f, folder) ? target + f.slice(folder.length) : f);
  storeFolders(storedFolders().map(re));
  for (const p of await allProjects()) if (inFolder(p.folder, folder)) await tx("readwrite", (s) => s.put({ ...p, folder: re(p.folder!) }));
  return target;
}

/** Deletes a folder and every project inside it. */
export async function deleteFolder(folder: string): Promise<void> {
  if (files) return files.folders.delete(folder);
  storeFolders(storedFolders().filter((f) => !inFolder(f, folder)));
  for (const p of await allProjects()) if (inFolder(p.folder, folder)) await tx("readwrite", (s) => s.delete(p.id));
}

/** Moves a project into a folder; in the desktop app the file moves, so the id changes. */
export async function moveProject(id: string, folder: string): Promise<ProjectMeta> {
  if (files) return { ...(await files.projects.move({ id, folder })), updatedAt: Date.now() };
  const p = await loadProject(id);
  if (!p) throw new Error(t("project not found"));
  await tx("readwrite", (s) => s.put({ ...p, folder }));
  return { id, name: p.name, folder, updatedAt: p.updatedAt };
}
