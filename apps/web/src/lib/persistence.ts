/**
 * Project storage: plain .meercad files (open JSON format). In the Mac app they are in a folder the
 * user picks on first launch, in the iPad app in its Documents or iCloud folder (see native.ts).
 */
import type { MeercadDocument } from "@meercad/schema";
import { nativeFiles } from "./native";
import { t } from "./i18n";
import { dropOutput } from "./openCache";
import { LOOK_VERSION } from "@meercad/viewport";

export interface ProjectMeta {
  id: string;
  name: string;
  /** Folder path like "Clients/Acme"; "" is the top level. */
  folder?: string;
  updatedAt: number;
  /** When the project was created (the file's birth time), where the file system knows it. */
  createdAt?: number;
  thumbnail?: string;
  /** When the picture was written; a picture older than the file shows an earlier state. */
  thumbnailAt?: number;
  /**
   * The file's size in bytes, where the store says (the iPad: big designs are not built in the background).
   */
  size?: number;
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

/** An assistant session's tab, as the main process reports it. */
export interface AssistantTab {
  session: string;
  client: string;
  project: string | null;
  name: string | null;
  busy: boolean;
  tool: string | null;
}

interface DesktopApi {
  isDesktop: true;
  /**
   * The Claude Desktop config file written, or null when Claude Desktop was handed the extension to install.
   */
  installClaudeDesktop(): Promise<string | null>;
  /** This build's MCP bridge port (older desktop builds: absent, the default). */
  mcpPort?: number;
  /** Flags shared by every meerCAD on this Mac, as read at start, and how to set one. */
  shared?: { initial: Record<string, unknown>; set(key: string, value: unknown): Promise<void> };
  info(): Promise<{
    version: string;
    projectsDir: string;
    mcpCommand: { command: string; args: string[]; env?: Record<string, string> };
    mcpName?: string;
    channel?: "release" | "rc" | "wip";
    mas?: boolean;
    store?: "production" | "sandbox" | null;
  }>;
  projects: {
    list(): Promise<ProjectMeta[]>;
    load(id: string): Promise<Project>;
    /**
     * `look`: the look the picture shows (LOOK_VERSION), kept with it next to the file (see
     * sharedPicture.ts).
     */
    save(p: { id: string; doc: MeercadDocument; thumbnail?: string; look?: number }): Promise<void>;
    /**
     * Stores a project's picture without touching its file; also next to the file (see
     * sharedPicture.ts), unless `local` (a picture just taken from there).
     */
    thumbnail(p: { id: string; thumbnail: string; look?: number; local?: boolean }): Promise<void>;
    /**
     * The picture kept next to the project's file (see sharedPicture.ts) if it shows the file as it
     * is now, else null. Missing in older desktop apps.
     */
    sharedThumbnail?(id: string): Promise<{ thumbnail: string; look: number } | null>;
    create(p: { name: string; doc: MeercadDocument; folder?: string; test?: boolean }): Promise<ProjectMeta>;
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
    status(): Promise<{
      dir: string;
      defaultDir: string;
      chosen: boolean;
      iCloudDir: string;
      iCloudAvailable: boolean;
    }>;
    choose(): Promise<string | null>;
    count(): Promise<number>;
    set(p: { dir: string; move: boolean }): Promise<{ dir: string; moved: number; skipped: number }>;
  };
  /** A model from a folder of photos the user picks (null: none picked); see lib/terrain. */
  photos: {
    build(folder?: string): Promise<(TerrainResult & { folder: string; data: Uint8Array }) | null>;
    cancel(): Promise<void>;
  };
  /** The interface size: the choice ("auto" or a factor), what automatic means on this display, the steps. */
  uiScale: {
    get(): Promise<UiScale | null>;
    set(choice: number | "auto"): Promise<void>;
  };
  editNative(cmd: "cut" | "copy" | "paste" | "selectAll"): Promise<void>;
  saveFile(p: {
    name: string;
    data: Uint8Array | string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string | null>;
  /** Files the MCP server cannot reach itself (macOS privacy), as base64; missing in older desktop apps. */
  readLocalFile?(path: string): Promise<string>;
  writeLocalFile?(p: { path: string; base64: string }): Promise<void>;
  /**
   * Slicers installed on this Mac and opening a 3MF in one (see lib/slicers); missing in older desktop apps.
   */
  slicers?: {
    list(): Promise<{ id: "bambu" | "prusa"; name: string }[]>;
    open(p: {
      slicer: "bambu" | "prusa";
      name: string;
      data: Uint8Array;
    }): Promise<{ slicer: string; file: string }>;
  };
  /** Missing in desktop apps from before sharing. */
  shareFile?(p: { name: string; data: Uint8Array | string; x?: number; y?: number }): Promise<void>;
  /** The MCP bridge, held by the window's page (see lib/mcpBridge); missing in older desktop apps. */
  mcp?: {
    status(s: "off" | "connecting" | "connected"): void;
    hostStatus(): Promise<"off" | "connecting" | "connected">;
    setEnabled(on: boolean): Promise<void>;
  };
  /** Assistant sessions' own tabs (MCP), see lib/mcpBridge. */
  assistant?: {
    open(p: { session: string; client: string }): Promise<number>;
    windowOf(session: string): Promise<number | "closed" | "released" | "idle" | null>;
    call(window: number, req: unknown): Promise<unknown>;
    /** The assistants' tabs (also sent as "assistant-tabs" when they change). */
    tabs(): Promise<AssistantTab[]>;
    /** Lays an assistant's tab over `rect` (CSS pixels of the window's page), or shows none. */
    show(p: { session: string; rect: { x: number; y: number; width: number; height: number } } | null): void;
    /** A picture of the open assistant's tab (PNG data URL), shown in its room while a dialog covers it. */
    snapshot(session: string): Promise<string | null>;
    /**
     * Takes an assistant's tab over: its page saves and goes; its project, for a tab of the user's.
     * `why`: the user did (closed), the assistant itself (released, close_project) or it sat idle.
     */
    handOver(
      session: string,
      why?: "closed" | "released" | "idle",
    ): Promise<{ id: string; name: string } | null>;
    // In an assistant's tab:
    ready(): void;
    project(p: { id: string; name: string } | null): void;
    busy(p: { busy: boolean; tool: string | null }): void;
    stop(): void;
    released(callId: number): void;
    respond(p: { callId: number; result?: unknown; error?: string }): void;
  };
  on(
    channel:
      | "menu"
      | "open-project"
      | "projects-changed"
      | "project-saved"
      | "error"
      | "assistant-stop"
      | "assistant-idle",
    fn: (arg: string) => void,
  ): () => void;
  on(channel: "assistant-tabs", fn: (arg: AssistantTab[]) => void): () => void;
  on(channel: "mcp-status", fn: (arg: "off" | "connecting" | "connected") => void): () => void;
  on(channel: "mcp-set-enabled", fn: (arg: boolean) => void): () => void;
  on(channel: "bridge-request", fn: (arg: { callId: number; req: unknown }) => void): () => void;
  on(channel: "release-project", fn: (arg: { callId: number }) => void): () => void;
  on(channel: "photos-progress", fn: (arg: { progress: number; step: string }) => void): () => void;
  on(channel: "ui-scale", fn: (arg: UiScale) => void): () => void;
}

/** The desktop app's interface size (1 = 100 %), set in the main process. */
export interface UiScale {
  choice: number | "auto";
  auto: number;
  current: number;
  steps: number[];
}

export const desktop: DesktopApi | undefined = (window as unknown as { meercadDesktop?: DesktopApi })
  .meercadDesktop;

/**
 * This page is an assistant session's tab (MCP, a view inside the app's window): the session and the
 * assistant's name, else null.
 */
export const assistantWindow: { session: string; client: string } | null = (() => {
  const q = new URLSearchParams(location.search);
  const session = q.get("assistant");

  return session ? { session, client: q.get("client") || "Assistant" } : null;
})();

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

/**
 * While an assistant's request runs that may create a project (open_example, new_project,
 * import_file without `keep`): the Mac's WIP build puts what it creates in its test folder rather
 * than the user's projects folder. Other builds ignore it.
 */
let creatingTest = 0;

export async function asTestProjects<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  if (!on) return fn();

  creatingTest++;

  try {
    return await fn();
  } finally {
    creatingTest--;
  }
}

/** A test project's id (see asTestProjects): in the WIP's own folder, not in the user's list. */
export const isTestProject = (id: string) => id.startsWith(".tests/");

export async function createProject(name: string, doc: MeercadDocument, folder = ""): Promise<ProjectMeta> {
  return files.projects.create({ name, doc, folder, ...(creatingTest > 0 ? { test: true } : {}) });
}

export async function saveProject(p: Project): Promise<void> {
  return files.projects.save({
    id: p.id,
    doc: p.doc,
    ...(p.thumbnail ? { thumbnail: p.thumbnail, look: LOOK_VERSION } : {}),
  });
}

/** Stores a picture for a project that has none, leaving the project itself (and its date) alone. */
export async function saveThumbnail(id: string, thumbnail: string): Promise<void> {
  return files.projects.thumbnail({ id, thumbnail, look: LOOK_VERSION });
}

/**
 * The picture another device left next to the project's file, if it shows the file as it is now in
 * the current look (see sharedPicture.ts); it is then kept in this app's data too. Null otherwise.
 */
export async function takeSharedThumbnail(id: string): Promise<string | null> {
  const shared = await files.projects.sharedThumbnail?.(id).catch(() => null);
  if (!shared || shared.look !== LOOK_VERSION) return null;

  await files.projects.thumbnail({ id, thumbnail: shared.thumbnail, local: true });

  return shared.thumbnail;
}

/** Renames a project; in the desktop app this renames the file, so the id changes. */
export async function renameProjectFile(id: string, name: string): Promise<ProjectMeta> {
  const r = await files.projects.rename({ id, name });

  return { ...r, updatedAt: Date.now() };
}

export async function deleteProject(id: string): Promise<void> {
  void dropOutput(id);

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
