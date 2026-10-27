/** The only bridge between the web app and the desktop: a small, explicit API. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { contextBridge, ipcRenderer } from "electron";

const api = {
  isDesktop: true,
  info: () => ipcRenderer.invoke("app:info"),
  installClaudeDesktop: () => ipcRenderer.invoke("mcp:install-claude-desktop"),
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    load: (id: string) => ipcRenderer.invoke("projects:load", id),
    save: (p: { id: string; doc: unknown; thumbnail?: string }) => ipcRenderer.invoke("projects:save", p),
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
  saveFile: (p: { name: string; data: Uint8Array | string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke("files:save", p),
  updates: {
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
  },
  on: (channel: "menu" | "open-project" | "update-available" | "update-progress" | "update-none" | "update-error" | "error", fn: (arg: any) => void) => {
    const listener = (_e: unknown, arg: unknown) => fn(arg);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("meercadDesktop", api);
export type DesktopApi = typeof api;
