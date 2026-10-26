/** Local-first project storage in IndexedDB. Nothing leaves the browser. */
import type { OpencadDocument } from "@opencad/schema";

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  thumbnail?: string;
}
export interface Project extends ProjectMeta {
  doc: OpencadDocument;
}

const DB = "opencad";
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

export async function listProjects(): Promise<ProjectMeta[]> {
  try {
    const all = await tx<Project[]>("readonly", (s) => s.getAll() as IDBRequest<Project[]>);
    return all.map(({ id, name, updatedAt, thumbnail }) => ({ id, name, updatedAt, ...(thumbnail ? { thumbnail } : {}) })).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function loadProject(id: string): Promise<Project | undefined> {
  return tx<Project | undefined>("readonly", (s) => s.get(id) as IDBRequest<Project | undefined>);
}

export async function saveProject(p: Project): Promise<void> {
  await tx("readwrite", (s) => s.put(p));
}

export async function deleteProject(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
}

export function newProjectId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
