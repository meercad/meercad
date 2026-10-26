/** The only bridge between the web app and the desktop: a small, explicit API. */
import { contextBridge, ipcRenderer } from "electron";

const api = {
  isDesktop: true,
  info: () => ipcRenderer.invoke("app:info"),
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    load: (id: string) => ipcRenderer.invoke("projects:load", id),
    save: (p: { id: string; doc: unknown; thumbnail?: string }) => ipcRenderer.invoke("projects:save", p),
    create: (p: { name: string; doc: unknown }) => ipcRenderer.invoke("projects:create", p),
    rename: (p: { id: string; name: string }) => ipcRenderer.invoke("projects:rename", p),
    delete: (id: string) => ipcRenderer.invoke("projects:delete", id),
    reveal: (id?: string) => ipcRenderer.invoke("projects:reveal", id),
  },
  saveFile: (p: { name: string; data: Uint8Array | string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke("files:save", p),
  on: (channel: "menu" | "open-project", fn: (arg: string) => void) => {
    const listener = (_e: unknown, arg: string) => fn(arg);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("leocadDesktop", api);
export type DesktopApi = typeof api;
