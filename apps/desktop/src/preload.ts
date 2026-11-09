/** The only bridge between the web app and the desktop: a small, explicit API. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { contextBridge, ipcRenderer } from "electron";

/** An assistant's tab as the tab strip shows it. */
export interface AssistantTabInfo {
  session: string;
  client: string;
  project: string | null;
  name: string | null;
  busy: boolean;
  tool: string | null;
}

const api = {
  isDesktop: true,
  info: () => ipcRenderer.invoke("app:info"),
  /** The interface language, so the menu bar and system dialogs match it. */
  setLanguage: (lang: string) => ipcRenderer.send("app:language", lang),
  /** The interface size: the choice ("auto" or a factor), what automatic means here, and the steps. */
  uiScale: {
    get: () => ipcRenderer.invoke("ui:scale"),
    set: (choice: number | "auto") => ipcRenderer.invoke("ui:scale:set", choice),
  },
  installClaudeDesktop: () => ipcRenderer.invoke("mcp:install-claude-desktop"),
  /** The port this build's MCP server listens on (RC, WIP and the store release each have their own). */
  mcpPort: ipcRenderer.sendSync("mcp:port") as number,
  /** The MCP bridge, held by the window's page: its state, and turning it on or off from an assistant's tab. */
  mcp: {
    /** The window's page reports its state. */
    status: (s: string) => ipcRenderer.send("mcp:status", s),
    hostStatus: (): Promise<"off" | "connecting" | "connected"> => ipcRenderer.invoke("mcp:host-status"),
    setEnabled: (on: boolean): Promise<void> => ipcRenderer.invoke("mcp:set-enabled", on),
  },
  /** Flags shared by every meerCAD on this Mac (e.g. the tour was seen), read once at start. */
  shared: {
    initial: ipcRenderer.sendSync("shared:get") as Record<string, unknown>,
    set: (key: string, value: unknown) => ipcRenderer.invoke("shared:set", { key, value }),
  },
  /** Assistant sessions' own tabs (MCP): the window's page passes their requests on to them. */
  assistant: {
    open: (p: { session: string; client: string }): Promise<number> => ipcRenderer.invoke("assistant:open", p),
    windowOf: (session: string): Promise<number | "closed" | null> => ipcRenderer.invoke("assistant:window", session),
    call: (window: number, req: unknown): Promise<unknown> => ipcRenderer.invoke("assistant:call", { window, req }),
    /** The assistants' tabs (also sent as "assistant-tabs" whenever they change). */
    tabs: (): Promise<AssistantTabInfo[]> => ipcRenderer.invoke("assistant:tabs"),
    /** Opens an assistant's tab in the room `rect` leaves (CSS pixels), or none. */
    show: (p: { session: string; rect: { x: number; y: number; width: number; height: number } } | null) => ipcRenderer.send("assistant:show", p),
    /** Takes an assistant's tab over: it saves and closes; returns its project for a tab of the user's. */
    handOver: (session: string): Promise<{ id: string; name: string } | null> => ipcRenderer.invoke("assistant:hand-over", session),
    // In an assistant's tab:
    ready: () => ipcRenderer.send("assistant:ready"),
    project: (p: { id: string; name: string } | null) => ipcRenderer.send("assistant:project", p),
    busy: (p: { busy: boolean; tool: string | null }) => ipcRenderer.send("assistant:busy", p),
    stop: () => ipcRenderer.send("assistant:stop"),
    released: (callId: number) => ipcRenderer.send("window:released", callId),
    respond: (p: { callId: number; result?: unknown; error?: string }) => ipcRenderer.send("assistant:respond", p),
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    load: (id: string) => ipcRenderer.invoke("projects:load", id),
    save: (p: { id: string; doc: unknown; thumbnail?: string }) => ipcRenderer.invoke("projects:save", p),
    thumbnail: (p: { id: string; thumbnail: string }) => ipcRenderer.invoke("projects:thumbnail", p),
    create: (p: { name: string; doc: unknown; folder?: string; test?: boolean }) => ipcRenderer.invoke("projects:create", p),
    move: (p: { id: string; folder: string }) => ipcRenderer.invoke("projects:move", p),
    folders: () => ipcRenderer.invoke("projects:folders"),
    rename: (p: { id: string; name: string }) => ipcRenderer.invoke("projects:rename", p),
    delete: (id: string) => ipcRenderer.invoke("projects:delete", id),
    reveal: (p?: string | { folder: string }) => ipcRenderer.invoke("projects:reveal", p),
  },
  folders: {
    create: (p: { parent: string; name: string }) => ipcRenderer.invoke("folders:create", p),
    rename: (p: { folder: string; name: string }) => ipcRenderer.invoke("folders:rename", p),
    delete: (folder: string) => ipcRenderer.invoke("folders:delete", folder),
  },
  storage: {
    status: () => ipcRenderer.invoke("storage:status"),
    choose: () => ipcRenderer.invoke("storage:choose"),
    count: () => ipcRenderer.invoke("storage:count"),
    set: (p: { dir: string; move: boolean }) => ipcRenderer.invoke("storage:set", p),
  },
  photos: {
    build: (folder?: string) => ipcRenderer.invoke("photos:build", folder),
    cancel: () => ipcRenderer.invoke("photos:cancel"),
  },
  /** The system's text editing in the focused field: cut, copy, paste, selectAll. */
  editNative: (cmd: string) => ipcRenderer.invoke("edit:native", cmd),
  saveFile: (p: { name: string; data: Uint8Array | string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke("files:save", p),
  /** A file the MCP server may not reach (macOS guards Documents, Desktop …; this app has the user's OK): absolute paths, base64. */
  readLocalFile: (path: string) => ipcRenderer.invoke("files:read-local", path),
  writeLocalFile: (p: { path: string; base64: string }) => ipcRenderer.invoke("files:write-local", p),
  /** The system's share menu (AirDrop, Messages, Mail …) for a file, at the pointer or at x/y. */
  shareFile: (p: { name: string; data: Uint8Array | string; x?: number; y?: number }) => ipcRenderer.invoke("files:share", p),
  on: (channel: "menu" | "open-project" | "projects-changed" | "project-saved" | "error" | "photos-progress" | "ui-scale" | "bridge-request" | "release-project" | "assistant-tabs" | "assistant-stop" | "mcp-status" | "mcp-set-enabled", fn: (arg: any) => void) => {
    const listener = (_e: unknown, arg: unknown) => fn(arg);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("meercadDesktop", api);
export type DesktopApi = typeof api;
