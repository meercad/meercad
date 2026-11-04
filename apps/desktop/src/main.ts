/**
 * meerCAD desktop shell. Serves the web app from an app:// origin (with the cross-origin isolation
 * headers it needs), stores projects as plain .meercad files in a folder the user picks on first
 * launch (default ~/Documents/meerCAD) and exposes a small, explicit file API to the renderer.
 *
 * The Mac App Store build (process.mas) runs sandboxed: a folder the user picks is kept with a
 * security-scoped bookmark, iCloud Drive is found through the system, and Claude gets meerCAD as an
 * extension instead of an entry written into its config.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, Notification, protocol, screen, shell, type MenuItemConstructorOptions } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { carryOverAppData, fixClaudeConfig, LEGACY_EXT, moveLegacyDefaultFolder, renameLegacyFiles } from "./legacy";

const DEV = process.argv.includes("--dev");
const MAS = process.mas === true;
/** "wip" for the local test build that lives next to the release (built by `pnpm wip`); it never self-updates. */
const WIP = (() => {
  try {
    return (JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { meercadChannel?: string }).meercadChannel === "wip";
  } catch {
    return false;
  }
})();
const DEV_URL = "http://localhost:5173";
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
    const container = join(homedir(), "Library", "Mobile Documents", "iCloud~dev~meercad~app");
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
const projectPath = (id: string) => `${join(projectsDir(), ...checkRel(id, "project name"))}.meercad`;
const folderPath = (folder: string) => (folder ? join(projectsDir(), ...checkRel(folder, "folder name")) : projectsDir());
const joinId = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const folderOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
const nameOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const toId = (rel: string) => rel.split(sep).join("/").replace(/\.meercad$/, "");

const thumbPath = (id: string) => join(thumbsDir(), `${createHash("sha1").update(projectPath(id)).digest("hex")}.png`);

async function listProjects() {
  await mkdir(projectsDir(), { recursive: true });
  const out = await Promise.all(
    (await projectFiles(projectsDir())).map(async (rel) => {
      const id = toId(rel);
      const st = await stat(join(projectsDir(), rel));
      let thumbnail: string | undefined;
      try {
        thumbnail = `data:image/png;base64,${(await readFile(thumbPath(id))).toString("base64")}`;
      } catch {
        thumbnail = undefined;
      }
      return { id, name: nameOf(id), folder: folderOf(id), updatedAt: st.mtimeMs, createdAt: st.birthtimeMs, ...(thumbnail ? { thumbnail } : {}) };
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
}

ipcMain.handle("projects:list", () => listProjects());
ipcMain.handle("projects:folders", () => listFolders());
ipcMain.handle("projects:load", async (_e, id: string) => {
  const st = await stat(projectPath(id));
  return { id, name: nameOf(id), folder: folderOf(id), updatedAt: st.mtimeMs, doc: JSON.parse(await readFile(projectPath(id), "utf8")) };
});
ipcMain.handle("projects:save", async (_e, p: { id: string; doc: unknown; thumbnail?: string }) => {
  await mkdir(dirname(projectPath(p.id)), { recursive: true });
  // Write atomically so a crash never leaves a half-written project.
  const tmp = `${projectPath(p.id)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(p.doc, null, 2)}\n`);
  await rename(tmp, projectPath(p.id));
  if (p.thumbnail?.startsWith("data:image/png;base64,")) {
    await mkdir(thumbsDir(), { recursive: true });
    await writeFile(thumbPath(p.id), Buffer.from(p.thumbnail.slice(22), "base64"));
  }
});
ipcMain.handle("projects:thumbnail", async (_e, p: { id: string; thumbnail: string }) => {
  if (!p.thumbnail.startsWith("data:image/png;base64,") || !existsSync(projectPath(p.id))) return;
  await mkdir(thumbsDir(), { recursive: true });
  await writeFile(thumbPath(p.id), Buffer.from(p.thumbnail.slice(22), "base64"));
});
ipcMain.handle("projects:create", async (_e, p: { name: string; doc: unknown; folder?: string }) => {
  const id = await uniqueId(p.name, p.folder ?? "");
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
  await shell.trashItem(projectPath(id));
  await rm(thumbPath(id), { force: true });
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
  await shell.trashItem(folderPath(folder));
});
ipcMain.handle("projects:reveal", (_e, p?: string | { folder: string }) =>
  typeof p === "string" ? shell.showItemInFolder(projectPath(p)) : shell.openPath(folderPath(p?.folder ?? "")),
);
ipcMain.handle("files:save", async (e, p: { name: string; data: Uint8Array | string; filters?: { name: string; extensions: string[] }[] }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath("downloads"), p.name), ...(p.filters ? { filters: p.filters } : {}) });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, typeof p.data === "string" ? p.data : Buffer.from(p.data));
  return r.filePath;
});
/**
 * A textured model of an area from a folder of photos (a drone flight), built by the native helper
 * with Apple's photogrammetry. Progress goes to the window as "photos-progress"; null when the user
 * picks no folder. One build at a time; "photos:cancel" stops it.
 */
let photoBuild: ChildProcess | null = null;
ipcMain.handle("photos:build", async (e) => {
  if (photoBuild) throw new Error("busy");
  const win = BrowserWindow.fromWebContents(e.sender);
  // MEERCAD_PHOTOS_DIR skips the folder dialog (automated tests of the whole build in the app).
  const folder = process.env["MEERCAD_PHOTOS_DIR"] || (await dialog.showOpenDialog(win!, { properties: ["openDirectory"], message: lang === "de" ? "Ordner mit den Fotos" : "Folder with the photos" })).filePaths[0];
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
  const win = BrowserWindow.fromWebContents(e.sender);
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
      timer = setTimeout(() => mainWindow?.webContents.send("projects-changed"), 400);
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
    const error = await shell.openPath(join(process.resourcesPath, "meercad.mcpb"));
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
  const servers: Record<string, unknown> = { ...config.mcpServers, meercad: mcpEntry() };
  // The entry from before the rename would start an app that no longer exists.
  delete servers["leocad"];
  config.mcpServers = servers;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
});
/** How an MCP client starts the server: the app's own runtime, or Node for the sandboxed build (whose binary cannot run as Node). */
function mcpEntry(): { command: string; args: string[]; env?: Record<string, string> } {
  return MAS ? { command: "node", args: [mcpServer] } : { command: process.execPath, args: [mcpServer], env: { ELECTRON_RUN_AS_NODE: "1" } };
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
  if (Math.abs(win.webContents.getZoomFactor() - f) > 1e-3) win.webContents.setZoomFactor(f);
  win.webContents.send("ui-scale", uiScaleState(win));
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
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? uiScaleState(win) : null;
});
ipcMain.handle("ui:scale:set", (_e, choice: unknown) => {
  if (choice === "auto" || (typeof choice === "number" && Number.isFinite(choice))) return setUiScale(choice);
});

// ---------------------------------------------------------------- windows

let mainWindow: BrowserWindow | null = null;
const pendingOpen: string[] = [];

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
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.show());
  // The interface size follows the display the window is on (when automatic).
  win.webContents.on("did-finish-load", () => applyUiScale(win));
  win.on("moved", () => applyUiScale(win));
  // External links open in the browser; the app never navigates away from itself.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://") && !url.startsWith(DEV_URL)) e.preventDefault();
  });
  void win.loadURL(DEV ? DEV_URL : "app://meercad/");
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

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
  const send = (channel: string, ...args: unknown[]) => () => mainWindow?.webContents.send(channel, ...args);
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
    if (!WIP && !MAS) await carryOverAppData(settingsPath(), thumbsDir()).catch(() => undefined);
    settings = readSettings();
    // Reopen access to a folder picked in an earlier session (held for the app's lifetime).
    if (MAS && settings.projectsBookmark) app.startAccessingSecurityScopedResource(settings.projectsBookmark);
    // The WIP build starts on the same projects folder as the installed release.
    if (WIP && !settings.projectsDir) {
      for (const name of ["meerCAD", "leocad"]) {
        try {
          const release = JSON.parse(readFileSync(join(app.getPath("appData"), name, "settings.json"), "utf8")) as Settings;
          if (release.projectsDir) {
            settings = { ...settings, projectsDir: release.projectsDir };
            break;
          }
        } catch {
          // no release installed: the first-run folder picker asks
        }
      }
    }
    if (!WIP && !MAS && !process.env["MEERCAD_PROJECTS_DIR"]) {
      const moved = await moveLegacyDefaultFolder(settings.projectsDir, defaultProjectsDir(), thumbsDir()).catch(() => null);
      if (moved) {
        settings = { ...settings, projectsDir: moved };
        await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`).catch(() => undefined);
      }
    }
    await renameLegacyFiles(projectsDir(), thumbsDir()).catch(() => 0);
    if (app.isPackaged && !WIP && !MAS) void fixClaudeConfig(mcpEntry()).catch(() => undefined);
    await findICloud();
    serveApp();
    buildMenu();
    mainWindow = createWindow();
    screen.on("display-metrics-changed", () => BrowserWindow.getAllWindows().forEach(applyUiScale));
    watchProjects();
    mainWindow.webContents.once("did-finish-load", () => {
      for (const f of pendingOpen.splice(0)) void openExternalFile(f);
    });
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) mainWindow = createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
