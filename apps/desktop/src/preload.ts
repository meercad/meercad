/** The only bridge between the web app and the desktop: a small, explicit API. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { contextBridge, ipcRenderer } from "electron";

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
  /** Flags shared by every meerCAD on this Mac (e.g. the tour was seen), read once at start. */
  shared: {
    initial: ipcRenderer.sendSync("shared:get") as Record<string, unknown>,
    set: (key: string, value: unknown) => ipcRenderer.invoke("shared:set", { key, value }),
  },
  /** Assistant sessions' own windows (MCP): the user's window passes their requests on. */
  assistant: {
    open: (p: { session: string; client: string; project?: string }): Promise<number> => ipcRenderer.invoke("assistant:open", p),
    windowOf: (session: string): Promise<number | "closed" | null> => ipcRenderer.invoke("assistant:window", session),
    call: (window: number, req: unknown): Promise<unknown> => ipcRenderer.invoke("assistant:call", { window, req }),
    holder: (id: string): Promise<{ session: string; client: string; ended: boolean; user: boolean } | null> => ipcRenderer.invoke("assistant:holder", id),
    take: (id: string, client: string): Promise<void> => ipcRenderer.invoke("assistant:take", { id, client }),
    reclaim: (id: string): Promise<void> => ipcRenderer.invoke("assistant:reclaim", id),
    released: (callId: number) => ipcRenderer.send("window:released", callId),
    focusHolder: (id: string, assistants = false): Promise<boolean> => ipcRenderer.invoke("assistant:focus-holder", { id, assistants }),
    ended: (session: string) => ipcRenderer.send("assistant:ended", session),
    // In an assistant's window:
    ready: () => ipcRenderer.send("assistant:ready"),
    project: (id: string | null) => ipcRenderer.send("assistant:project", id),
    respond: (p: { callId: number; result?: unknown; error?: string }) => ipcRenderer.send("assistant:respond", p),
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    load: (id: string) => ipcRenderer.invoke("projects:load", id),
    save: (p: { id: string; doc: unknown; thumbnail?: string }) => ipcRenderer.invoke("projects:save", p),
    thumbnail: (p: { id: string; thumbnail: string }) => ipcRenderer.invoke("projects:thumbnail", p),
    create: (p: { name: string; doc: unknown; folder?: string }) => ipcRenderer.invoke("projects:create", p),
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
  on: (channel: "menu" | "open-project" | "projects-changed" | "project-saved" | "error" | "photos-progress" | "ui-scale" | "bridge-request" | "assistant-ended" | "assistant-adopted" | "release-project" | "project-free" | "assistant-stop", fn: (arg: any) => void) => {
    const listener = (_e: unknown, arg: unknown) => fn(arg);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("meercadDesktop", api);
export type DesktopApi = typeof api;
