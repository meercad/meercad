/**
 * meerCAD desktop shell. Serves the web app from an app:// origin (with the cross-origin isolation
 * headers it needs), stores projects as plain .meercad files in a folder the user picks on first
 * launch (default ~/Documents/meerCAD) and exposes a small, explicit file API to the renderer.
 *
 * The Mac App Store build (process.mas) runs sandboxed: a folder the user picks is kept with a
 * security-scoped bookmark, iCloud Drive is found through the system, and Claude gets meerCAD as an
 * extension instead of an entry written into its config.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, protocol, screen, ShareMenu, shell, WebContentsView, type MenuItemConstructorOptions, type WebContents } from "electron";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ASSISTANT_IDLE_MS, CHANNEL_PORTS, CHANNEL_MCP_NAMES, idleAssistants, type Channel, type EndedTab } from "@meercad/mcp";
import { adoptSiblingData, carryOverAppData, fixClaudeConfig, LEGACY_EXT, moveLegacyDefaultFolder, renameLegacyFiles } from "./legacy";
import { clearOldSends, findSlicer, SLICERS, writeSend, type SlicerId } from "./slicers";
import { moveToTrash } from "./trash";

const DEV = process.argv.includes("--dev");
const MAS = process.mas === true;
/**
 * Which build this is (see CHANNEL_PORTS): the App Store build is "testflight" or "prod" by its
 * receipt; "rc" (the stable build the maintainer works with, `pnpm rc`) and "wip" (the test build
 * agents rebuild at will, `pnpm wip`) are installed next to each other and to the store build, never
 * self-update and do not claim .meercad files.
 */
const CHANNEL: Channel = MAS
  ? storeEnvironment() === "sandbox"
    ? "testflight"
    : "prod"
  : (() => {
      try {
        const c = (JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { meercadChannel?: string }).meercadChannel;
        return c === "rc" || c === "wip" ? c : "prod";
      } catch {
        return "prod";
      }
    })();
/** A side-by-side build (RC or WIP): starts on the other builds' projects folder, leaves their files alone. */
const SIDE_BY_SIDE = CHANNEL === "rc" || CHANNEL === "wip";
/**
 * The bridge port of this build: the one in the bundled server.json, which the bundled server.js
 * reads too (a private test copy of a build gets its own there), else its channel's.
 */
const MCP_PORT: number = (() => {
  try {
    const p = (JSON.parse(readFileSync(join(process.resourcesPath, "mcp", "server.json"), "utf8")) as { port?: unknown }).port;
    if (app.isPackaged && typeof p === "number" && Number.isInteger(p) && p > 1024 && p < 65536) return p;
  } catch {
    // no server.json (App Store build, development)
  }
  return CHANNEL_PORTS[CHANNEL];
})();
/** This build's name in an assistant's MCP configuration ("meercad", "meercad-rc", …): added next to the others' entries. */
const MCP_NAME = CHANNEL_MCP_NAMES[CHANNEL];
/** The app data of the other builds a side-by-side build takes over from on its first start, closest first. */
const siblingDataDirs = () => (CHANNEL === "rc" ? ["meerCAD WIP", "meerCAD"] : CHANNEL === "wip" ? ["meerCAD RC", "meerCAD"] : []).map((n) => join(app.getPath("appData"), n));
// MEERCAD_DEV_URL: another dev server (the UI end-to-end run starts its own on a free port).
const DEV_URL = process.env["MEERCAD_DEV_URL"] ?? "http://localhost:5173";
const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : join(__dirname, "../../web/dist");
const mcpServer = app.isPackaged ? join(process.resourcesPath, "mcp", "server.js") : join(__dirname, "../../../packages/mcp/dist/server.js");
const settingsPath = () => join(app.getPath("userData"), "settings.json");
const defaultProjectsDir = () => join(app.getPath("documents"), "meerCAD");
/**
 * meerCAD's folder in iCloud Drive, shared with the iPhone and iPad app ("iCloud Drive › meerCAD").
 * Outside the sandbox it appears once the app has used iCloud on one of them; the App Store build
 * asks the system, which also sets it up (null without iCloud).
 */
let iCloudDir: string | null = null;
async function findICloud(): Promise<void> {
  if (!MAS) {
    const container = join(homedir(), "Library", "Mobile Documents", "iCloud~app~meercad");
    iCloudDir = existsSync(container) ? join(container, "Documents") : null;
    return;
  }
  try {
    // Native code cannot load from inside the asar archive; it is unpacked next to it.
    const helper = join(__dirname, "native", "icloud.node").replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
    const mod = { exports: {} as { containerPath(): Promise<string | null> } };
    process.dlopen(mod, helper);
    iCloudDir = await mod.exports.containerPath();
  } catch {
    iCloudDir = null;
  }
}

/** App-level settings that must live outside the projects folder (it is one of them). */
interface Settings {
  projectsDir?: string;
  /** App Store build: the security-scoped bookmark that reopens a folder the user picked. */
  projectsBookmark?: string;
  /** The interface size as a factor (1 = 100 %); absent: automatic, see autoUiScale. */
  uiScale?: number;
}
function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8")) as Settings;
  } catch {
    return {};
  }
}
let settings: Settings = {};
const projectsDir = () => process.env["MEERCAD_PROJECTS_DIR"] ?? settings.projectsDir ?? defaultProjectsDir();
const thumbsDir = () => join(app.getPath("userData"), "thumbnails");

/**
 * What the user has seen, for every meerCAD on this Mac (the release, the WIP build, test copies
 * with their own app data): one file next to the release's app data, so the tour is not shown
 * again by each copy. MEERCAD_SHARED_DIR puts it elsewhere (the UI end-to-end run's temp folder).
 */
const sharedPath = () => join(process.env["MEERCAD_SHARED_DIR"] ?? (MAS ? app.getPath("userData") : join(app.getPath("appData"), "meerCAD")), "shared.json");
const readShared = (): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(sharedPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};
ipcMain.on("shared:get", (e) => void (e.returnValue = readShared()));
/** The bridge port the window connects to: this build's own (see CHANNEL_PORTS). */
ipcMain.on("mcp:port", (e) => void (e.returnValue = MCP_PORT));

/** Every page of the app: the window's, and each assistant's tab (a view inside the window). */
function allContents(): WebContents[] {
  const list: WebContents[] = [];
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) list.push(mainWindow.webContents);
  for (const a of assistantViews.values()) if (!a.view.webContents.isDestroyed()) list.push(a.view.webContents);
  return list;
}

/**
 * Sends a message to every page (`arg` per page, by its webContents id). Skips pages that are
 * closing: this runs from close and destroy events, where a send would throw.
 */
function sendToAll(channel: string, arg: (wc: number) => unknown, except?: number): void {
  for (const wc of allContents()) {
    if (wc.id === except) continue;
    try {
      wc.send(channel, arg(wc.id));
    } catch {
      // closed meanwhile
    }
  }
}

/** The window a page is in (an assistant's tab is a view inside the app's one window). */
const windowFor = (wc: WebContents): BrowserWindow | null => BrowserWindow.fromWebContents(wc) ?? (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

// ---------------------------------------------------------------- MCP bridge host

/**
 * The app's window (mainWindow) holds the connection to the MCP server; the assistants' tabs show
 * its state and turn it on or off through it.
 */
type BridgeState = "off" | "connecting" | "connected";
let bridgeState: BridgeState = "off";
/** What a window asked for while there was no first window: applied once the new one reports in. */
let bridgeWanted: boolean | null = null;
const broadcastBridge = () => sendToAll("mcp-status", () => bridgeState);
ipcMain.on("mcp:status", (e, s: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || e.sender !== mainWindow.webContents) return;
  if (s !== "off" && s !== "connecting" && s !== "connected") return;
  bridgeState = s;
  broadcastBridge();
  if (bridgeWanted === null) return;
  const on = bridgeWanted;
  bridgeWanted = null;
  if ((s !== "off") !== on) mainWindow.webContents.send("mcp-set-enabled", on);
});
ipcMain.handle("mcp:host-status", () => bridgeState);
ipcMain.handle("mcp:set-enabled", (_e, on: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) return void mainWindow.webContents.send("mcp-set-enabled", on === true);
  // The first window was closed: a new one takes the connection over.
  bridgeWanted = on === true;
  mainWindow = createWindow();
});
ipcMain.handle("shared:set", async (_e, p: { key: string; value: unknown }) => {
  if (typeof p?.key !== "string" || !/^[a-zA-Z][\w.]{0,40}$/.test(p.key)) return;
  const all = { ...readShared(), [p.key]: p.value };
  await mkdir(dirname(sharedPath()), { recursive: true });
  await writeFile(sharedPath(), `${JSON.stringify(all, null, 2)}\n`);
});

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function serveApp(): void {
  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    let path = normalize(join(webRoot, decodeURIComponent(url.pathname)));
    if (!path.startsWith(webRoot + sep) && path !== webRoot) return new Response("forbidden", { status: 403 });
    if (!existsSync(path) || (await stat(path)).isDirectory()) path = join(webRoot, "index.html");
    const res = await net.fetch(pathToFileURL(path).toString());
    const headers = new Headers(res.headers);
    headers.set("Content-Type", MIME[extname(path)] ?? "application/octet-stream");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(res.body, { status: 200, headers });
  });
}

// ---------------------------------------------------------------- project files

/**
 * Project ids are paths relative to the projects folder without the extension ("Clients/bracket"),
 * so folders in the app are real folders on disk. Anything that could escape the folder is rejected.
 */
const SEGMENT = /^[^/\\:*?"<>|]{1,120}$/;
function checkRel(rel: string, what: string): string[] {
  const parts = rel.split("/");
  if (parts.some((p) => !SEGMENT.test(p) || p.startsWith(".") || p.trim() !== p || !p)) throw new Error(`invalid ${what} "${rel}"`);
  return parts;
}
/**
 * Test projects: what an assistant creates in the WIP build (open_example, new_project, import_file
 * without `keep`) goes to a folder of this build's own, not the user's projects folder (shared with
 * the user's other builds and iCloud), so test runs leave nothing in the user's list. Their ids
 * start with TEST_FOLDER, which no user folder can (a leading "." is refused).
 */
const TEST_FOLDER = ".tests";
const TEST_PROJECTS = CHANNEL === "wip";
const testProjectsDir = () => join(app.getPath("userData"), "Test projects");
const isTest = (rel: string) => rel === TEST_FOLDER || rel.startsWith(`${TEST_FOLDER}/`);
/** The file system path of a project id or folder ("a/b"; "" is the top level). */
function pathOf(rel: string, what: string): string {
  if (isTest(rel)) return rel === TEST_FOLDER ? testProjectsDir() : join(testProjectsDir(), ...checkRel(rel.slice(TEST_FOLDER.length + 1), what));
  return rel ? join(projectsDir(), ...checkRel(rel, what)) : projectsDir();
}
const projectPath = (id: string) => `${pathOf(id, "project name")}.meercad`;
const folderPath = (folder: string) => pathOf(folder, "folder name");
const joinId = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const folderOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
const nameOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const toId = (rel: string) => rel.split(sep).join("/").replace(/\.meercad$/, "");

const thumbPath = (id: string) => join(thumbsDir(), `${createHash("sha1").update(projectPath(id)).digest("hex")}.png`);

/**
 * A project's picture also next to its file (".Bracket.meercad-preview"), so that it travels with
 * the project through iCloud and other devices need not build the model again for it: JSON with
 * the file's size and SHA-256 when pictured, the look (LOOK_VERSION) and the PNG. Same format as
 * on the iPad (apps/web/src/lib/sharedPicture.ts).
 */
const sidecarPath = (id: string) => join(dirname(projectPath(id)), `.${nameOf(id)}.meercad-preview`);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** Writes the picture next to the file, for `bytes`, the file as it is now. Never fails. */
async function writeSidecar(id: string, thumbnail: string, look: number, bytes: Buffer): Promise<void> {
  try {
    const text = JSON.stringify({ v: 1, size: bytes.length, sha256: sha256(bytes), look, png: thumbnail.slice(22) });
    const tmp = `${sidecarPath(id)}.tmp`;
    await writeFile(tmp, text);
    await rename(tmp, sidecarPath(id));
  } catch (e) {
    console.warn(`picture next to ${id} not written:`, e);
  }
}
/** The picture next to the file if it shows the file as it is now, else null. */
async function readSidecar(id: string): Promise<{ thumbnail: string; look: number } | null> {
  try {
    const o = JSON.parse(await readFile(sidecarPath(id), "utf8")) as { v?: unknown; size?: unknown; sha256?: unknown; look?: unknown; png?: unknown };
    if (o.v !== 1 || typeof o.size !== "number" || typeof o.sha256 !== "string" || typeof o.look !== "number" || typeof o.png !== "string" || !o.png) return null;
    if ((await stat(projectPath(id))).size !== o.size) return null;
    if (sha256(await readFile(projectPath(id))) !== o.sha256) return null;
    return { thumbnail: `data:image/png;base64,${o.png}`, look: o.look };
  } catch {
    return null;
  }
}

async function listProjects() {
  await mkdir(projectsDir(), { recursive: true });
  const out = await Promise.all(
    (await projectFiles(projectsDir())).map(async (rel) => {
      const id = toId(rel);
      const st = await stat(join(projectsDir(), rel));
      let thumbnail: string | undefined;
      let thumbnailAt: number | undefined;
      try {
        thumbnail = `data:image/png;base64,${(await readFile(thumbPath(id))).toString("base64")}`;
        thumbnailAt = (await stat(thumbPath(id))).mtimeMs;
      } catch {
        thumbnail = undefined;
      }
      return { id, name: nameOf(id), folder: folderOf(id), updatedAt: st.mtimeMs, createdAt: st.birthtimeMs, ...(thumbnail ? { thumbnail, thumbnailAt } : {}) };
    }),
  );
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Every folder below the projects folder (including empty ones), as "a/b" paths. */
async function listFolders(rel = ""): Promise<string[]> {
  const out: string[] = [];
  const dir = rel ? join(projectsDir(), ...rel.split("/")) : projectsDir();
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    out.push(r, ...(await listFolders(r)));
  }
  return out;
}

const safeName = (name: string, fallback: string) => name.replace(/[/\\:*?"<>|]+/g, "-").replace(/^\.+/, "").trim().slice(0, 100) || fallback;

async function uniqueId(name: string, folder = ""): Promise<string> {
  const base = safeName(name, "Untitled part");
  let id = joinId(folder, base);
  for (let n = 2; existsSync(projectPath(id)); n++) id = joinId(folder, `${base} ${n}`);
  return id;
}

/** Moves a project file (and its thumbnail) to a new id. */
async function moveProject(from: string, to: string): Promise<void> {
  if (from === to) return;
  await mkdir(dirname(projectPath(to)), { recursive: true });
  await rename(projectPath(from), projectPath(to));
  if (existsSync(thumbPath(from))) await rename(thumbPath(from), thumbPath(to));
  if (existsSync(sidecarPath(from))) await rename(sidecarPath(from), sidecarPath(to)).catch(() => undefined);
}

ipcMain.handle("projects:list", () => listProjects());
ipcMain.handle("projects:folders", () => listFolders());
ipcMain.handle("projects:load", async (_e, id: string) => {
  const st = await stat(projectPath(id));
  return { id, name: nameOf(id), folder: folderOf(id), updatedAt: st.mtimeMs, doc: JSON.parse(await readFile(projectPath(id), "utf8")) };
});
ipcMain.handle("projects:save", async (e, p: { id: string; doc: unknown; thumbnail?: string; look?: number }) => {
  await mkdir(dirname(projectPath(p.id)), { recursive: true });
  // Write atomically so a crash never leaves a half-written project.
  const tmp = `${projectPath(p.id)}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(p.doc, null, 2)}\n`);
  await writeFile(tmp, bytes);
  await rename(tmp, projectPath(p.id));
  // Other windows drop what they keep of it in memory (a tab in the background).
  sendToAll("project-saved", () => p.id, e.sender.id);
  if (p.thumbnail?.startsWith("data:image/png;base64,")) {
    await mkdir(thumbsDir(), { recursive: true });
    await writeFile(thumbPath(p.id), Buffer.from(p.thumbnail.slice(22), "base64"));
    if (p.look !== undefined) await writeSidecar(p.id, p.thumbnail, p.look, bytes);
  }
});
ipcMain.handle("projects:thumbnail", async (e, p: { id: string; thumbnail: string; look?: number; local?: boolean }) => {
  if (!p.thumbnail.startsWith("data:image/png;base64,") || !existsSync(projectPath(p.id))) return;
  await mkdir(thumbsDir(), { recursive: true });
  await writeFile(thumbPath(p.id), Buffer.from(p.thumbnail.slice(22), "base64"));
  if (!p.local && p.look !== undefined) await writeSidecar(p.id, p.thumbnail, p.look, await readFile(projectPath(p.id)));
  // An overview open in another window shows the new picture.
  sendToAll("projects-changed", () => undefined, e.sender.id);
});
ipcMain.handle("projects:shared-thumbnail", (_e, id: string) => readSidecar(id));
ipcMain.handle("projects:create", async (_e, p: { name: string; doc: unknown; folder?: string; test?: boolean }) => {
  // Only an assistant's request makes a test project: anything else next to one goes to the top level.
  const folder = p.test && TEST_PROJECTS ? TEST_FOLDER : isTest(p.folder ?? "") ? "" : (p.folder ?? "");
  const id = await uniqueId(p.name, folder);
  await mkdir(dirname(projectPath(id)), { recursive: true });
  await writeFile(projectPath(id), `${JSON.stringify(p.doc, null, 2)}\n`);
  return { id, name: nameOf(id), folder: folderOf(id), updatedAt: Date.now(), createdAt: Date.now() };
});
ipcMain.handle("projects:rename", async (_e, p: { id: string; name: string }) => {
  const id = await uniqueId(p.name, folderOf(p.id));
  await moveProject(p.id, id);
  return { id, name: nameOf(id), folder: folderOf(id) };
});
ipcMain.handle("projects:move", async (_e, p: { id: string; folder: string }) => {
  if (folderOf(p.id) === p.folder) return { id: p.id, name: nameOf(p.id), folder: p.folder };
  folderPath(p.folder);
  const id = await uniqueId(nameOf(p.id), p.folder);
  await moveProject(p.id, id);
  return { id, name: nameOf(id), folder: folderOf(id) };
});
ipcMain.handle("projects:delete", async (_e, id: string) => {
  // Move to the Trash rather than deleting for good.
  await moveToTrash(projectPath(id), (p) => shell.trashItem(p));
  await rm(thumbPath(id), { force: true });
  await rm(sidecarPath(id), { force: true });
});
ipcMain.handle("folders:create", async (_e, p: { parent: string; name: string }) => {
  const base = safeName(p.name, "New folder");
  let folder = joinId(p.parent, base);
  for (let n = 2; existsSync(folderPath(folder)); n++) folder = joinId(p.parent, `${base} ${n}`);
  await mkdir(folderPath(folder), { recursive: true });
  return folder;
});
ipcMain.handle("folders:rename", async (_e, p: { folder: string; name: string }) => {
  const target = joinId(folderOf(p.folder), safeName(p.name, nameOf(p.folder)));
  if (target === p.folder) return target;
  if (existsSync(folderPath(target))) throw new Error(`a folder named "${nameOf(target)}" already exists`);
  // Thumbnails are keyed by file path; carry them over.
  const inside = (await projectFiles(folderPath(p.folder))).map((rel) => toId(rel));
  const thumbs = inside.map((rel) => [thumbPath(`${p.folder}/${rel}`), `${target}/${rel}`] as const);
  await rename(folderPath(p.folder), folderPath(target));
  for (const [from, id] of thumbs) if (existsSync(from)) await rename(from, thumbPath(id));
  return target;
});
ipcMain.handle("folders:delete", async (_e, folder: string) => {
  // Trash the folder with everything in it; the renderer confirms first.
  for (const rel of await projectFiles(folderPath(folder))) await rm(thumbPath(`${folder}/${toId(rel)}`), { force: true });
  await moveToTrash(folderPath(folder), (p) => shell.trashItem(p));
});
ipcMain.handle("projects:reveal", (_e, p?: string | { folder: string }) =>
  typeof p === "string" ? shell.showItemInFolder(projectPath(p)) : shell.openPath(folderPath(p?.folder ?? "")),
);
ipcMain.handle("files:save", async (e, p: { name: string; data: Uint8Array | string; filters?: { name: string; extensions: string[] }[] }) => {
  const win = windowFor(e.sender);
  // The UI end-to-end run (tests/e2e/app.ts) saves without the dialog, into its own temp folder.
  const testDir = process.env["MEERCAD_E2E_SAVE_DIR"];
  const r = testDir ? { canceled: false, filePath: join(testDir, basename(p.name)) } : await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath("downloads"), p.name), ...(p.filters ? { filters: p.filters } : {}) });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, typeof p.data === "string" ? p.data : Buffer.from(p.data));
  return r.filePath;
});
/**
 * Files the MCP server asks for but may not open itself: macOS lets a process into Documents,
 * Desktop, Downloads and iCloud Drive only with the user's OK, and the server, running in the
 * background, waits for it in vain. This app has that OK (or asks for it in front).
 */
const localFile = (path: unknown) => {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("an absolute path is needed");
  return normalize(path);
};
ipcMain.handle("files:read-local", async (_e, path: unknown) => (await readFile(localFile(path))).toString("base64"));
ipcMain.handle("files:write-local", async (_e, p: { path: unknown; base64: unknown }) => {
  const file = localFile(p.path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(String(p.base64), "base64"));
});
/**
 * Shares a file through the system's share menu (AirDrop, Messages, Mail …) at the pointer, or at
 * x/y in the window. The file is written to a fresh temporary folder under the given name. Where
 * there is no share menu (not macOS) the file is shown in the file manager instead.
 */
ipcMain.handle("files:share", async (e, p: { name: string; data: Uint8Array | string; x?: number; y?: number }) => {
  const win = windowFor(e.sender);
  const dir = await mkdtemp(join(app.getPath("temp"), "meercad-share-"));
  const file = join(dir, safeName(p.name, "design.meercad"));
  await writeFile(file, typeof p.data === "string" ? p.data : Buffer.from(p.data));
  if (process.platform !== "darwin") {
    shell.showItemInFolder(file);
    return;
  }
  await new Promise<void>((resolve) => {
    new ShareMenu({ filePaths: [file] }).popup({
      ...(win ? { window: win } : {}),
      ...(p.x !== undefined && p.y !== undefined ? { x: Math.round(p.x), y: Math.round(p.y) } : {}),
      callback: () => resolve(),
    });
  });
});
/** The installed slicers a model can be sent to (see slicers.ts), Bambu Studio first. */
const slicerApp = (url: string) => app.getApplicationInfoForProtocol(url).then((i) => i.path || null);
const installedSlicers = async () =>
  process.platform !== "darwin" ? [] : (await Promise.all(SLICERS.map(async (s) => ({ id: s.id, name: s.name, path: await findSlicer(s, slicerApp) })))).filter((s) => s.path);
ipcMain.handle("slicers:list", async () => (await installedSlicers()).map(({ id, name }) => ({ id, name })));
/** Opens a file (a 3MF) in an installed slicer: written to a temporary folder, cleared away later. */
ipcMain.handle("slicers:open", async (_e, p: { slicer: SlicerId; name: string; data: Uint8Array }) => {
  const slicer = (await installedSlicers()).find((s) => s.id === p.slicer);
  if (!slicer) throw new Error(`${SLICERS.find((s) => s.id === p.slicer)?.name ?? String(p.slicer)} is not installed`);
  const file = await writeSend(app.getPath("temp"), p.name, Buffer.from(p.data));
  await new Promise<void>((resolve, reject) => execFile("/usr/bin/open", ["-a", slicer.path!, file], (err, _out, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve())));
  return { slicer: slicer.name, file };
});
/**
 * A textured model of an area from a folder of photos (a drone flight), built by the native helper
 * with Apple's photogrammetry. Progress goes to the window as "photos-progress"; null when the user
 * picks no folder. One build at a time; "photos:cancel" stops it.
 */
let photoBuild: ChildProcess | null = null;
ipcMain.handle("photos:build", async (e, given?: unknown) => {
  if (photoBuild) throw new Error("busy");
  const win = windowFor(e.sender);
  // MEERCAD_PHOTOS_DIR skips the folder dialog (automated tests of the whole build in the app).
  // An assistant (MCP) names the folder itself.
  const folder = (typeof given === "string" && given) || process.env["MEERCAD_PHOTOS_DIR"] || (await dialog.showOpenDialog(win!, { properties: ["openDirectory"], message: lang === "de" ? "Ordner mit den Fotos" : "Folder with the photos" })).filePaths[0];
  if (!folder) return null;
  const helper = join(__dirname, "native", "meercad-photos").replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
  const work = join(app.getPath("temp"), `meercad-photos-${Date.now()}`);
  const glb = join(work, "model.glb");
  await mkdir(work, { recursive: true });
  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = (photoBuild = spawn(helper, [folder, glb, work, "full"]));
      let rest = "";
      let failure = "";
      child.stdout.on("data", (chunk: Buffer) => {
        const lines = (rest + chunk.toString()).split("\n");
        rest = lines.pop() ?? "";
        for (const line of lines) {
          try {
            const m = JSON.parse(line) as { progress?: number; step?: string; done?: Record<string, unknown>; error?: string };
            if (m.progress !== undefined) {
              e.sender.send("photos-progress", { progress: m.progress, step: m.step });
              // In the Dock too, so it can be followed from another app.
              win?.setProgressBar(m.step === "writing" ? 2 : m.progress);
            }
            if (m.done) resolve(m.done);
            if (m.error) failure = m.error;
          } catch {
            // not a message
          }
        }
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => reject(new Error(signal ? "cancelled" : failure || `the photo helper stopped (${code})`)));
    });
    if (win && !win.isFocused()) {
      new Notification({ title: "meerCAD", body: lang === "de" ? "Das Modell aus den Fotos ist fertig." : "The model from the photos is ready." }).show();
      app.dock?.bounce("informational");
    }
    return { ...result, folder: basename(folder), data: new Uint8Array(await readFile(glb)) };
  } finally {
    win?.setProgressBar(-1);
    photoBuild = null;
    await rm(work, { recursive: true, force: true });
  }
});
ipcMain.handle("photos:cancel", () => void photoBuild?.kill());
// The page asks for the system's own text editing (a field or selected text has the focus).
ipcMain.handle("edit:native", (e, cmd: "cut" | "copy" | "paste" | "selectAll") => {
  if (["cut", "copy", "paste", "selectAll"].includes(cmd)) e.sender[cmd]();
});
ipcMain.handle("storage:status", async () => {
  await findICloud();
  return {
    dir: projectsDir(),
    defaultDir: defaultProjectsDir(),
    chosen: Boolean(process.env["MEERCAD_PROJECTS_DIR"] ?? settings.projectsDir),
    iCloudDir: iCloudDir ?? "",
    iCloudAvailable: iCloudDir !== null,
  };
});
/** Bookmarks of folders picked in this session (App Store build), saved once one becomes the projects folder. */
const picked = new Map<string, string>();
ipcMain.handle("storage:choose", async (e) => {
  const win = windowFor(e.sender);
  const r = await dialog.showOpenDialog(win!, {
    title: tr("Choose a folder for your meerCAD projects"),
    buttonLabel: tr("Use this folder"),
    defaultPath: projectsDir(),
    properties: ["openDirectory", "createDirectory"],
    securityScopedBookmarks: MAS,
  });
  const dir = r.canceled ? null : (r.filePaths[0] ?? null);
  if (dir && r.bookmarks?.[0]) picked.set(dir, r.bookmarks[0]);
  return dir;
});
/** All .meercad files below a folder, as paths relative to it. */
async function projectFiles(root: string, rel = ""): Promise<string[]> {
  if (!existsSync(join(root, rel))) return [];
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const r = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...(await projectFiles(root, r)));
    else if (entry.name.endsWith(".meercad")) out.push(r);
  }
  return out;
}
/** Test projects untouched for a week go (with their pictures): a thread that ran then has ended. */
async function dropOldTestProjects(): Promise<void> {
  const before = Date.now() - 7 * 24 * 3600_000;
  for (const rel of await projectFiles(testProjectsDir())) {
    const id = `${TEST_FOLDER}/${toId(rel)}`;
    if ((await stat(projectPath(id))).mtimeMs > before) continue;
    await rm(thumbPath(id), { force: true });
    await rm(sidecarPath(id), { force: true });
    await rm(projectPath(id), { force: true });
  }
}
ipcMain.handle("storage:count", async () => (await projectFiles(projectsDir())).length);
/** Switches the projects folder, optionally moving the existing projects (and their subfolders) along. */
ipcMain.handle("storage:set", async (_e, p: { dir: string; move: boolean }) => {
  const from = projectsDir();
  await mkdir(p.dir, { recursive: true });
  let moved = 0;
  let skipped = 0;
  if (p.move && normalize(from) !== normalize(p.dir)) {
    if (normalize(p.dir).startsWith(normalize(from) + sep)) throw new Error("The new folder is inside the current one; pick a folder outside it.");
    for (const rel of await projectFiles(from)) {
      const target = join(p.dir, rel);
      // Never overwrite a project that already exists in the new folder.
      if (existsSync(target)) {
        skipped++;
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(from, rel), target);
      await rm(join(from, rel));
      moved++;
    }
    // Carry the folder structure over (empty folders too) and tidy up folders left empty.
    const folders = await listFolders();
    for (const f of folders) await mkdir(join(p.dir, ...f.split("/")), { recursive: true });
    for (const f of folders.reverse()) await rmdir(join(from, ...f.split("/"))).catch(() => undefined);
  }
  // iCloud and the default folder are the app's own; any other needs the bookmark from the picker.
  const bookmark = picked.get(p.dir);
  settings = { ...settings, projectsDir: p.dir };
  if (bookmark) settings.projectsBookmark = bookmark;
  else delete settings.projectsBookmark;
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  watchProjects();
  return { dir: p.dir, moved, skipped };
});
/**
 * Projects changed outside the app (from the iPad through iCloud, in the Finder) refresh the list
 * in the window; several changes in a row are reported once.
 */
let watcher: FSWatcher | null = null;
function watchProjects(): void {
  watcher?.close();
  watcher = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    watcher = watch(projectsDir(), { recursive: true }, (_event, file) => {
      if (file && !String(file).endsWith(".meercad") && extname(String(file)) !== "") return;
      clearTimeout(timer);
      timer = setTimeout(() => sendToAll("projects-changed", () => undefined), 400);
    });
    watcher.on("error", () => undefined);
  } catch {
    // no folder yet: watched once it is chosen
  }
}

/**
 * Adds meerCAD to Claude Desktop's MCP configuration (keeps everything else, backs the file up first)
 * and returns the file. The sandboxed App Store build cannot write there: it hands Claude Desktop the
 * meerCAD extension to install instead and returns null.
 */
ipcMain.handle("mcp:install-claude-desktop", async () => {
  if (MAS) {
    // One extension per store channel, each with its own name and port (see scripts/mas.mjs).
    const error = await shell.openPath(join(process.resourcesPath, `${MCP_NAME}.mcpb`));
    if (error) throw new Error(error);
    return null;
  }
  const file = join(app.getPath("appData"), "Claude", "claude_desktop_config.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    const raw = await readFile(file, "utf8");
    try {
      config = JSON.parse(raw) as typeof config;
    } catch {
      throw new Error(`${file} is not valid JSON; fix or remove it first`);
    }
    await writeFile(`${file}.bak`, raw);
  }
  const servers: Record<string, unknown> = { ...config.mcpServers, [MCP_NAME]: mcpEntry() };
  // The entry from before the rename would start an app that no longer exists.
  delete servers["leocad"];
  config.mcpServers = servers;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
});
/** How an MCP client starts the server: the app's own runtime, or Node for the sandboxed build (whose binary cannot run as Node). */
function mcpEntry(): { command: string; args: string[]; env?: Record<string, string> } {
  // The App Store build's server.js has no server.json: its port comes with the entry (TestFlight's differs),
  // and the app it opens when an assistant needs it (see packages/mcp/src/launchApp.ts).
  return MAS ? { command: "node", args: [mcpServer], env: { MEERCAD_MCP_PORT: String(MCP_PORT), MEERCAD_APP: "app.meercad" } } : { command: process.execPath, args: [mcpServer], env: { ELECTRON_RUN_AS_NODE: "1" } };
}
/**
 * Where an App Store build came from: TestFlight and development installs carry a sandbox receipt
 * (its environment field reads "ProductionSandbox"), App Store downloads a production one. Null
 * outside the App Store build or without a receipt; the web app treats anything but "production"
 * as a test build and shows the premium packs.
 */
function storeEnvironment(): "production" | "sandbox" | null {
  if (!MAS) return null;
  try {
    const receipt = readFileSync(join(process.resourcesPath, "..", "_MASReceipt", "receipt"));
    return receipt.includes("ProductionSandbox") ? "sandbox" : "production";
  } catch {
    return null;
  }
}

ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  projectsDir: projectsDir(),
  mcpCommand: mcpEntry(),
  mcpName: MCP_NAME,
  channel: CHANNEL,
  mas: MAS,
  store: storeEnvironment(),
}));

// ---------------------------------------------------------------- interface size

/** The sizes the interface steps through (⌘+ / ⌘−, Settings). */
const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
/**
 * The automatic interface size for the display a window is on. A big monitor run at its full
 * resolution without Retina scaling (a 4K or 5K2K screen at "1x") shows everything tiny at 100 %:
 * there it grows with the screen height, in quarter steps up to 200 %. Retina displays and the
 * usual resolutions keep 100 %; someone who picked "more space" on a Retina display chose it.
 */
function autoUiScale(win: BrowserWindow): number {
  const d = screen.getDisplayMatching(win.getBounds());
  const h = d.workAreaSize.height;
  if (d.scaleFactor > 1 || h < 1800) return 1;
  return Math.min(2, Math.max(1, Math.round((h / 1440) * 4) / 4));
}
const uiScaleOf = (win: BrowserWindow) => settings.uiScale ?? autoUiScale(win);
function applyUiScale(win: BrowserWindow): void {
  const f = uiScaleOf(win);
  // The assistants' tabs in the window take its size too.
  for (const wc of win === mainWindow ? allContents() : [win.webContents]) {
    if (Math.abs(wc.getZoomFactor() - f) > 1e-3) wc.setZoomFactor(f);
    wc.send("ui-scale", uiScaleState(win));
  }
  placeAssistants();
}
const uiScaleState = (win: BrowserWindow) => ({ choice: settings.uiScale ?? "auto", auto: autoUiScale(win), current: uiScaleOf(win), steps: UI_SCALES });
async function setUiScale(choice: number | "auto"): Promise<void> {
  const next = { ...settings };
  if (choice === "auto") delete next.uiScale;
  else next.uiScale = Math.min(2, Math.max(0.8, choice));
  settings = next;
  await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`).catch(() => undefined);
  for (const w of BrowserWindow.getAllWindows()) applyUiScale(w);
}
/** One step bigger (+1) or smaller (−1) from the size in use. */
function stepUiScale(dir: 1 | -1): void {
  if (!mainWindow) return;
  const cur = uiScaleOf(mainWindow);
  const next = dir > 0 ? UI_SCALES.find((s) => s > cur + 1e-3) : [...UI_SCALES].reverse().find((s) => s < cur - 1e-3);
  if (next !== undefined) void setUiScale(next);
}
ipcMain.handle("ui:scale", (e) => {
  const win = windowFor(e.sender);
  return win ? uiScaleState(win) : null;
});
ipcMain.handle("ui:scale:set", (_e, choice: unknown) => {
  if (choice === "auto" || (typeof choice === "number" && Number.isFinite(choice))) return setUiScale(choice);
});

// ---------------------------------------------------------------- the window

/** The app's one window: Home and the user's tabs, and the assistants' tabs as views inside it. */
let mainWindow: BrowserWindow | null = null;
const pendingOpen: string[] = [];

/** The page's settings, also for the assistants' tabs. */
const webPreferences = (assistant: boolean) => ({ preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, ...(assistant ? { backgroundThrottling: false } : {}) });

/** External links open in the browser; the app never navigates away from itself. */
function guardNavigation(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://") && !url.startsWith(DEV_URL)) e.preventDefault();
  });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "meerCAD",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 26, y: 29 },
    backgroundColor: "#eef0f8",
    icon: join(__dirname, "../build/icon.png"),
    show: false,
    webPreferences: webPreferences(false),
  });
  win.once("ready-to-show", () => win.show());
  // The interface size follows the display the window is on (when automatic).
  win.webContents.on("did-finish-load", () => applyUiScale(win));
  win.on("moved", () => applyUiScale(win));
  win.on("resize", placeAssistants);
  guardNavigation(win.webContents);
  // MEERCAD_MCP_BRIDGE=off keeps a test run's window away from the user's assistants.
  void win.loadURL(`${DEV ? DEV_URL : "app://meercad/"}${process.env["MEERCAD_MCP_BRIDGE"] === "off" ? "?bridge=off" : ""}`);
  win.on("closed", () => {
    // The assistants' tabs go with it (their sessions learn that the user closed them).
    for (const a of [...assistantViews.values()]) closeView(a);
    if (mainWindow !== win) return;
    mainWindow = null;
    // Its connection to the assistants went with it.
    bridgeState = "off";
  });
  return win;
}

// ---------------------------------------------------------------- assistants' tabs

/**
 * Every assistant session (one MCP server each) works in a tab of its own in the app's window: a
 * page of its own (a view laid over the window's page below the tab strip while that tab is the
 * open one, hidden otherwise), so the user keeps working on Home and in their tabs meanwhile. The
 * window's page holds the connection to the MCP server and passes each session's requests on to
 * its tab (see the web app's mcpBridge); it draws the tab strip, with the assistants' tabs in it.
 */
interface AssistantView {
  view: WebContentsView;
  session: string;
  client: string;
  /** The project it has open, and its name. */
  project: string | null;
  name: string | null;
  /** It is working right now, and on which tool. */
  busy: boolean;
  tool: string | null;
  /** When its session last made a request (see idleAssistants). */
  lastCall: number;
  /** The window's page was asked to hand it back for being idle. */
  idleSent: boolean;
  ready: Promise<void>;
  markReady: () => void;
}
/** By the view's webContents id. */
const assistantViews = new Map<number, AssistantView>();
/** Sessions whose tab went, and why (their later requests get an answer that says so). */
const endedSessions = new Map<string, EndedTab>();
const assistantOf = (webContentsId: number) => assistantViews.get(webContentsId);
/** Menu commands and Finder opens go to the window's page. */
const commandWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

/** What the tab strip shows of the assistants' tabs. */
const assistantTabs = () => [...assistantViews.values()].filter((a) => !a.view.webContents.isDestroyed()).map((a) => ({ session: a.session, client: a.client, project: a.project, name: a.name, busy: a.busy, tool: a.tool }));
const broadcastTabs = () => mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && mainWindow.webContents.send("assistant-tabs", assistantTabs());

/** The open assistant tab (by session) and where the window's page leaves room for it (CSS pixels). */
let shown: { session: string; rect: { x: number; y: number; width: number; height: number } } | null = null;
/** Lays the open assistant tab over its room in the page; the others stay hidden (and keep working). */
function placeAssistants(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const zoom = mainWindow.webContents.getZoomFactor();
  const [w, h] = mainWindow.getContentSize() as [number, number];
  // Before the page said where: everything below the top bar.
  const r = shown?.rect ?? { x: 0, y: 44, width: w / zoom, height: h / zoom - 44 };
  const bounds = { x: Math.round(r.x * zoom), y: Math.round(r.y * zoom), width: Math.max(1, Math.round(r.width * zoom)), height: Math.max(1, Math.round(r.height * zoom)) };
  for (const a of assistantViews.values()) {
    if (a.view.webContents.isDestroyed()) continue;
    a.view.setBounds(bounds);
    a.view.setVisible(a.session === shown?.session);
  }
}

function openAssistantView(session: string, client: string): AssistantView {
  const known = [...assistantViews.values()].find((a) => a.session === session && !a.view.webContents.isDestroyed());
  if (known) return known;
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error("meerCAD's window is closed.");
  let markReady = () => undefined as void;
  const ready = new Promise<void>((r) => (markReady = r));
  endedSessions.delete(session);
  // It works in the background: its timers and drawing must not be slowed down there.
  const view = new WebContentsView({ webPreferences: webPreferences(true) });
  view.setBackgroundColor("#eef0f8");
  view.setVisible(false);
  mainWindow.contentView.addChildView(view);
  const wc = view.webContents;
  const a: AssistantView = { view, session, client, project: null, name: null, busy: false, tool: null, lastCall: Date.now(), idleSent: false, ready, markReady };
  assistantViews.set(wc.id, a);
  placeAssistants();
  guardNavigation(wc);
  // Its page holds keys back (it is the assistant's); ⌘, still opens the settings, in the window's page.
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown" || input.key !== "," || !(input.meta || input.control) || input.shift || input.alt) return;
    e.preventDefault();
    const w = commandWindow();
    if (!w) return;
    w.webContents.focus();
    w.webContents.send("menu", "settings");
  });
  wc.on("did-finish-load", () => mainWindow && !mainWindow.isDestroyed() && wc.setZoomFactor(uiScaleOf(mainWindow)));
  const id = wc.id;
  wc.once("destroyed", () => {
    assistantViews.delete(id);
    if (!endedSessions.has(session)) endedSessions.set(session, "closed");
    if (shown?.session === session) shown = null;
    broadcastTabs();
    for (const [callId, c] of bridgeCalls) {
      if (c.window !== id) continue;
      bridgeCalls.delete(callId);
      c.reject(new Error(CLOSED));
    }
  });
  void wc.loadURL(`${DEV ? DEV_URL : "app://meercad/"}?assistant=${encodeURIComponent(session)}&client=${encodeURIComponent(client)}`);
  broadcastTabs();
  return a;
}

const CLOSED = "The user closed your meerCAD tab or took the project over. Open the project again (open_project) to go on.";

/** Closes an assistant's tab (its page goes; its session's later requests get CLOSED). */
function closeView(a: AssistantView): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(a.view);
  } catch {
    // the window is gone
  }
  if (!a.view.webContents.isDestroyed()) a.view.webContents.close();
}

let bridgeCallSeq = 0;
const bridgeCalls = new Map<number, { window: number; resolve: (v: unknown) => void; reject: (e: Error) => void }>();

ipcMain.handle("assistant:open", async (_e, p: { session: string; client: string }) => {
  const a = openAssistantView(String(p.session), String(p.client || "Assistant"));
  await a.ready;
  return a.view.webContents.id;
});
/** The session's tab; "closed" when the user closed it (its requests must not land in the user's page then). */
ipcMain.handle("assistant:window", (_e, session: string) => [...assistantViews.values()].find((a) => a.session === session && !a.view.webContents.isDestroyed())?.view.webContents.id ?? endedSessions.get(session) ?? null);
ipcMain.handle("assistant:call", (_e, p: { window: number; req: unknown }) => {
  const a = assistantViews.get(p.window);
  if (!a || a.view.webContents.isDestroyed()) throw new Error(CLOSED);
  a.lastCall = Date.now();
  a.idleSent = false;
  const callId = ++bridgeCallSeq;
  return new Promise((resolve, reject) => {
    bridgeCalls.set(callId, { window: p.window, resolve, reject });
    a.view.webContents.send("bridge-request", { callId, req: p.req });
  });
});
ipcMain.on("assistant:respond", (_e, p: { callId: number; result?: unknown; error?: string }) => {
  const c = bridgeCalls.get(p.callId);
  if (!c) return;
  bridgeCalls.delete(p.callId);
  if (typeof p.error === "string") c.reject(new Error(p.error));
  else c.resolve(p.result);
});
ipcMain.on("assistant:ready", (e) => assistantOf(e.sender.id)?.markReady());
ipcMain.handle("assistant:tabs", () => assistantTabs());
/** An assistant's tab says which project it has open. */
ipcMain.on("assistant:project", (e, p: unknown) => {
  const a = assistantOf(e.sender.id);
  if (!a) return;
  const { id, name } = (p ?? {}) as { id?: unknown; name?: unknown };
  a.project = typeof id === "string" ? id : null;
  a.name = typeof name === "string" ? name : null;
  broadcastTabs();
});
/** An assistant's tab says whether it is working, and on what. */
ipcMain.on("assistant:busy", (e, p: unknown) => {
  const a = assistantOf(e.sender.id);
  if (!a) return;
  const { busy, tool } = (p ?? {}) as { busy?: unknown; tool?: unknown };
  a.busy = busy === true;
  a.tool = typeof tool === "string" ? tool : null;
  broadcastTabs();
});
/** The window's page opens an assistant's tab (rect: its room in the page) or one of its own (null). */
ipcMain.on("assistant:show", (e, p: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || e.sender !== mainWindow.webContents) return;
  const q = p as { session?: unknown; rect?: { x: number; y: number; width: number; height: number } } | null;
  shown = q && typeof q.session === "string" && q.rect ? { session: q.session, rect: q.rect } : null;
  placeAssistants();
});
ipcMain.handle("assistant:snapshot", async (e, session: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || e.sender !== mainWindow.webContents) return null;
  const a = [...assistantViews.values()].find((x) => x.session === session && !x.view.webContents.isDestroyed());
  if (!a || !a.view.getVisible()) return null;
  const img = await a.view.webContents.capturePage();
  return img.isEmpty() ? null : img.toDataURL();
});
let releaseSeq = 0;
const releases = new Map<number, () => void>();
ipcMain.on("window:released", (_e, callId: number) => releases.get(callId)?.());
/**
 * The user takes an assistant's tab over (or closes it), or its session ended: its page saves the
 * project and goes. Returns the project, which the window's page opens as a tab of the user's.
 */
ipcMain.handle("assistant:hand-over", async (_e, session: string, why?: unknown) => {
  const a = [...assistantViews.values()].find((x) => x.session === session && !x.view.webContents.isDestroyed());
  if (!a) return null;
  endedSessions.set(session, why === "released" || why === "idle" ? why : "closed");
  const callId = ++releaseSeq;
  await new Promise<void>((resolve) => {
    releases.set(callId, resolve);
    a.view.webContents.send("release-project", { callId });
    setTimeout(resolve, 15_000).unref();
  });
  releases.delete(callId);
  const project = a.project ? { id: a.project, name: a.name ?? a.project } : null;
  closeView(a);
  return project;
});
/**
 * A tab whose session has made no request for a while goes back to the user (the window's page
 * hands it over): an assistant's session often stays open for hours after its last call.
 * MEERCAD_ASSISTANT_IDLE_MS shortens it for test runs.
 */
const ASSISTANT_IDLE: number = (() => {
  const v = Number(process.env["MEERCAD_ASSISTANT_IDLE_MS"]);
  return Number.isFinite(v) && v >= 1000 ? v : ASSISTANT_IDLE_MS;
})();
setInterval(
  () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    const live = [...assistantViews.values()].filter((a) => !a.view.webContents.isDestroyed() && !a.idleSent);
    const pending = (a: AssistantView) => [...bridgeCalls.values()].filter((c) => c.window === a.view.webContents.id).length;
    for (const a of idleAssistants(live.map((a) => ({ a, lastCall: a.lastCall, busy: a.busy, pending: pending(a) })), Date.now(), ASSISTANT_IDLE)) {
      a.a.idleSent = true;
      mainWindow.webContents.send("assistant-idle", a.a.session);
    }
  },
  Math.min(30_000, Math.max(1000, ASSISTANT_IDLE / 4)),
).unref();

/** The Stop button in an assistant's tab: the window's page takes the tab over. */
ipcMain.on("assistant:stop", (e) => {
  const a = assistantOf(e.sender.id);
  if (a && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("assistant-stop", a.session);
});

/** Imports an .meercad file opened from Finder into the projects folder and opens it. */
async function openExternalFile(file: string): Promise<void> {
  if (!mainWindow) {
    pendingOpen.push(file);
    return;
  }
  try {
    const doc = JSON.parse(await readFile(file, "utf8")) as unknown;
    const inProjects = normalize(file).startsWith(projectsDir() + sep) && extname(file) === ".meercad";
    const id = inProjects ? toId(relative(projectsDir(), file)) : await uniqueId(basename(file, extname(file)));
    if (!inProjects) await writeFile(projectPath(id), `${JSON.stringify(doc, null, 2)}\n`);
    mainWindow.webContents.send("open-project", id);
    mainWindow.focus();
  } catch (e) {
    mainWindow.webContents.send("error", `Could not open ${basename(file)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

app.on("open-file", (e, file) => {
  e.preventDefault();
  void openExternalFile(file);
});

/** The web app's interface language (it says so when it starts); the menu bar follows it. */
let lang: "en" | "de" = "en";
const MENU_DE: Record<string, string> = {
  "Settings…": "Einstellungen …",
  File: "Ablage",
  "New Part": "Neues Teil",
  "Open…": "Öffnen …",
  "All Projects": "Alle Projekte",
  "Save Copy As .meercad…": "Kopie als .meercad sichern …",
  "Share…": "Teilen …",
  "Show Projects Folder": "Projektordner zeigen",
  "New Tab": "Neuer Tab",
  "Close Tab": "Tab schließen",
  "Reopen Closed Tab": "Geschlossenen Tab wieder öffnen",
  "Show Next Tab": "Nächsten Tab zeigen",
  "Show Previous Tab": "Vorherigen Tab zeigen",
  "Close Window": "Fenster schließen",
  Edit: "Bearbeiten",
  Undo: "Rückgängig",
  Redo: "Wiederholen",
  View: "Darstellung",
  "Keyboard Shortcuts": "Tastenkürzel",
  "Choose a folder for your meerCAD projects": "Ordner für deine meerCAD-Projekte wählen",
  "Use this folder": "Diesen Ordner verwenden",
  "Bigger Interface": "Oberfläche größer",
  "Smaller Interface": "Oberfläche kleiner",
  "Automatic Interface Size": "Oberfläche automatisch",
  // Standard items, which Electron names in English.
  about: "Über meerCAD",
  services: "Dienste",
  hide: "meerCAD ausblenden",
  hideOthers: "Andere ausblenden",
  unhide: "Alle einblenden",
  quit: "meerCAD beenden",
  cut: "Ausschneiden",
  copy: "Kopieren",
  paste: "Einsetzen",
  selectAll: "Alles auswählen",
  reload: "Neu laden",
  toggleDevTools: "Entwicklerwerkzeuge",
  togglefullscreen: "Vollbild",
  windowMenu: "Fenster",
  help: "Hilfe",
};
const tr = (s: string) => (lang === "de" ? (MENU_DE[s] ?? s) : s);
/** A standard menu item, named in German when the app is. */
const role = (r: NonNullable<MenuItemConstructorOptions["role"]>, more: MenuItemConstructorOptions = {}): MenuItemConstructorOptions => ({ role: r, ...(lang === "de" && MENU_DE[r] ? { label: MENU_DE[r] } : {}), ...more });

ipcMain.on("app:language", (_e, l: unknown) => {
  if ((l === "en" || l === "de") && l !== lang) {
    lang = l;
    buildMenu();
  }
});

function buildMenu(): void {
  const send = (channel: string, ...args: unknown[]) => () => commandWindow()?.webContents.send(channel, ...args);
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        role("about"),
        { type: "separator" },
        { label: tr("Settings…"), accelerator: "CmdOrCtrl+,", registerAccelerator: false, click: send("menu", "settings") },
        { type: "separator" },
        role("services"),
        { type: "separator" },
        role("hide"),
        role("hideOthers"),
        role("unhide"),
        { type: "separator" },
        role("quit"),
      ],
    },
    {
      label: tr("File"),
      submenu: [
        { label: tr("New Part"), accelerator: "CmdOrCtrl+N", click: send("menu", "new") },
        { label: tr("Open…"), accelerator: "CmdOrCtrl+O", click: send("menu", "import") },
        { label: tr("All Projects"), accelerator: "CmdOrCtrl+Shift+H", click: send("menu", "home") },
        { type: "separator" },
        { label: tr("Share…"), click: send("menu", "share") },
        { label: tr("Save Copy As .meercad…"), accelerator: "CmdOrCtrl+Shift+S", click: send("menu", "save-as") },
        { label: tr("Show Projects Folder"), click: () => void shell.openPath(projectsDir()) },
        { type: "separator" },
        // Tab keys are handled in the page; the menu only lists them.
        { label: tr("New Tab"), accelerator: "CmdOrCtrl+T", registerAccelerator: false, click: send("menu", "new") },
        { label: tr("Close Tab"), accelerator: "CmdOrCtrl+W", registerAccelerator: false, click: send("menu", "close-tab") },
        { label: tr("Reopen Closed Tab"), accelerator: "CmdOrCtrl+Shift+T", registerAccelerator: false, click: send("menu", "reopen-tab") },
        { label: tr("Show Next Tab"), accelerator: "Ctrl+Tab", registerAccelerator: false, click: send("menu", "next-tab") },
        { label: tr("Show Previous Tab"), accelerator: "Ctrl+Shift+Tab", registerAccelerator: false, click: send("menu", "prev-tab") },
        { type: "separator" },
        { label: tr("Close Window"), accelerator: "CmdOrCtrl+Shift+W", role: "close" },
      ],
    },
    {
      // Undo/Redo act on the model (or on the text field being typed in); the page handles the keys,
      // so the shortcuts are shown here but not registered twice.
      label: tr("Edit"),
      submenu: [
        { label: tr("Undo"), accelerator: "CmdOrCtrl+Z", registerAccelerator: false, click: send("menu", "undo") },
        { label: tr("Redo"), accelerator: "Shift+CmdOrCtrl+Z", registerAccelerator: false, click: send("menu", "redo") },
        { type: "separator" },
        // Cut, copy, paste and select all: on parts in the model, on text in a field (the page decides, see "edit:native").
        ...(["cut", "copy", "paste", "selectAll"] as const).map((r) => ({ ...role(r), click: send("menu", r) })),
        { label: lang === "de" ? "Duplizieren" : "Duplicate", accelerator: "CmdOrCtrl+D", click: send("menu", "duplicate") },
      ],
    },
    {
      label: tr("View"),
      submenu: [
        { label: tr("Keyboard Shortcuts"), accelerator: "CmdOrCtrl+/", click: send("menu", "shortcuts") },
        { type: "separator" },
        { label: tr("Bigger Interface"), accelerator: "CmdOrCtrl+Plus", click: () => stepUiScale(1) },
        // ⌘= is the same key without Shift on most layouts; it works too but is not listed twice.
        { label: tr("Bigger Interface"), accelerator: "CmdOrCtrl+=", visible: false, acceleratorWorksWhenHidden: true, click: () => stepUiScale(1) },
        { label: tr("Smaller Interface"), accelerator: "CmdOrCtrl+-", click: () => stepUiScale(-1) },
        { label: tr("Automatic Interface Size"), accelerator: "CmdOrCtrl+0", click: () => void setUiScale("auto") },
        { type: "separator" },
        role("reload"),
        role("toggleDevTools"),
        { type: "separator" },
        role("togglefullscreen"),
      ],
    },
    role("windowMenu"),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_e, argv) => {
    const file = argv.find((a) => a.endsWith(".meercad") || a.endsWith(LEGACY_EXT));
    if (file) void openExternalFile(file);
    mainWindow?.focus();
  });
  void app.whenReady().then(async () => {
    // Coming from the app's earlier name: keep its projects folder, thumbnails and files.
    if (!SIDE_BY_SIDE) await carryOverAppData(settingsPath(), thumbsDir()).catch(() => undefined);
    // A side-by-side build's first start continues where its sibling left off: projects folder,
    // thumbnails and the window's preferences (switching from the WIP to the RC keeps everything).
    if (SIDE_BY_SIDE) await adoptSiblingData(app.getPath("userData"), siblingDataDirs()).catch(() => undefined);
    settings = readSettings();
    // Files sent to a slicer in an earlier session.
    void clearOldSends(app.getPath("temp"));
    // Reopen access to a folder picked in an earlier session (held for the app's lifetime).
    if (MAS && settings.projectsBookmark) app.startAccessingSecurityScopedResource(settings.projectsBookmark);
    // Otherwise it starts on the same projects folder as an installed sibling.
    if (SIDE_BY_SIDE && !settings.projectsDir) {
      for (const dir of [...siblingDataDirs(), join(app.getPath("appData"), "leocad")]) {
        try {
          const other = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Settings;
          if (other.projectsDir) {
            settings = { ...settings, projectsDir: other.projectsDir };
            break;
          }
        } catch {
          // not installed: the first-run folder picker asks
        }
      }
    }
    if (!SIDE_BY_SIDE && !process.env["MEERCAD_PROJECTS_DIR"]) {
      const moved = await moveLegacyDefaultFolder(settings.projectsDir, defaultProjectsDir(), thumbsDir()).catch(() => null);
      if (moved) {
        settings = { ...settings, projectsDir: moved };
        await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`).catch(() => undefined);
      }
    }
    await renameLegacyFiles(projectsDir(), thumbsDir()).catch(() => 0);
    if (TEST_PROJECTS) void dropOldTestProjects().catch(() => undefined);
    if (app.isPackaged && CHANNEL === "prod" && !MAS) void fixClaudeConfig(mcpEntry()).catch(() => undefined);
    await findICloud();
    serveApp();
    buildMenu();
    mainWindow = createWindow();
    screen.on("display-metrics-changed", () => mainWindow && !mainWindow.isDestroyed() && applyUiScale(mainWindow));
    watchProjects();
    mainWindow.webContents.once("did-finish-load", () => {
      for (const f of pendingOpen.splice(0)) void openExternalFile(f);
    });
    app.on("activate", () => {
      // The user gets the window back, and with it the connection to the assistants.
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
