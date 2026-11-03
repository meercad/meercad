/**
 * Project storage: plain .meercad files (open JSON format). In the Mac app they are in a folder the
 * user picks on first launch, in the iPad app in its Documents or iCloud folder (see native.ts).
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
  /** When the project was created (the file's birth time), where the file system knows it. */
  createdAt?: number;
  thumbnail?: string;
}
export interface Project extends ProjectMeta {
  doc: MeercadDocument;
}

/** What the native photo build reports besides the model itself. */
export interface TerrainResult {
  photos: number;
  triangles: number;
  /** Size in mm (east, north, up). */
  size: [number, number, number];
  seconds: number;
  /** Scanned with LiDAR: true size and level without GPS. */
  measured?: boolean;
  /** Where the model's origin is, when the photos had GPS; `error` how well they agreed (m). */
  geo?: { lat: number; lon: number; alt: number; error: number; cameras: number };
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
  /** A model from a folder of photos the user picks (null: none picked); see lib/terrain. */
  photos: {
    build(): Promise<(TerrainResult & { folder: string; data: Uint8Array }) | null>;
    cancel(): Promise<void>;
  };
  saveFile(p: { name: string; data: Uint8Array | string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  on(channel: "menu" | "open-project" | "projects-changed" | "error", fn: (arg: string) => void): () => void;
  on(channel: "photos-progress", fn: (arg: { progress: number; step: string }) => void): () => void;
}

export const desktop: DesktopApi | undefined = (window as unknown as { meercadDesktop?: DesktopApi }).meercadDesktop;

/** Project files on disk: the desktop app's folder, or the iPad app's Documents. */
export interface FileStore {
  projects: Omit<DesktopApi["projects"], "reveal">;
  folders: DesktopApi["folders"];
}
/** The app's files: the Mac app's folder or the iPad app's Documents (main.tsx starts nothing elsewhere). */
const files: FileStore = (desktop ?? nativeFiles)!;

// ---------------------------------------------------------------- API

export async function listProjects(): Promise<ProjectMeta[]> {
  return files.projects.list();
}

export async function loadProject(id: string): Promise<Project | undefined> {
  return files.projects.load(id);
}

export async function createProject(name: string, doc: MeercadDocument, folder = ""): Promise<ProjectMeta> {
  return files.projects.create({ name, doc, folder });
}

export async function saveProject(p: Project): Promise<void> {
  return files.projects.save({ id: p.id, doc: p.doc, ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}) });
}

/** Stores a picture for a project that has none, leaving the project itself (and its date) alone. */
export async function saveThumbnail(id: string, thumbnail: string): Promise<void> {
  return files.projects.thumbnail({ id, thumbnail });
}

/** Renames a project; in the desktop app this renames the file, so the id changes. */
export async function renameProjectFile(id: string, name: string): Promise<ProjectMeta> {
  const r = await files.projects.rename({ id, name });
  return { ...r, updatedAt: Date.now() };
}

export async function deleteProject(id: string): Promise<void> {
  return files.projects.delete(id);
}

// ---------------------------------------------------------------- folders

/** Every folder path, parents before children. */
export async function listFolders(): Promise<string[]> {
  return files.projects.folders();
}

export async function createFolder(parent: string, name: string): Promise<string> {
  return files.folders.create({ parent, name });
}

export async function renameFolder(folder: string, name: string): Promise<string> {
  return files.folders.rename({ folder, name });
}

/** Deletes a folder and every project inside it. */
export async function deleteFolder(folder: string): Promise<void> {
  return files.folders.delete(folder);
}

/** Moves a project into a folder; in the desktop app the file moves, so the id changes. */
export async function moveProject(id: string, folder: string): Promise<ProjectMeta> {
  return { ...(await files.projects.move({ id, folder })), updatedAt: Date.now() };
}
