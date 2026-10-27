/**
 * meerCAD desktop shell. Serves the web app from an app:// origin (with the cross-origin isolation
 * headers it needs), stores projects as plain .meercad files in a folder the user picks on first
 * launch (default ~/Documents/meerCAD) and exposes a small, explicit file API to the renderer.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell, type MenuItemConstructorOptions } from "electron";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { carryOverAppData, fixClaudeConfig, LEGACY_EXT, moveLegacyDefaultFolder, renameLegacyFiles } from "./legacy";
import { canSelfUpdate, checkForUpdate, installUpdate, type UpdateInfo } from "./updater";

const DEV = process.argv.includes("--dev");
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

/** App-level settings that must live outside the projects folder (it is one of them). */
interface Settings {
  projectsDir?: string;
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
      return { id, name: nameOf(id), folder: folderOf(id), updatedAt: st.mtimeMs, ...(thumbnail ? { thumbnail } : {}) };
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
ipcMain.handle("projects:create", async (_e, p: { name: string; doc: unknown; folder?: string }) => {
  const id = await uniqueId(p.name, p.folder ?? "");
  await mkdir(dirname(projectPath(id)), { recursive: true });
  await writeFile(projectPath(id), `${JSON.stringify(p.doc, null, 2)}\n`);
  return { id, name: nameOf(id), folder: folderOf(id), updatedAt: Date.now() };
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
ipcMain.handle("storage:status", () => ({
  dir: projectsDir(),
  defaultDir: defaultProjectsDir(),
  chosen: Boolean(process.env["MEERCAD_PROJECTS_DIR"] ?? settings.projectsDir),
}));
ipcMain.handle("storage:choose", async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win!, {
    title: "Choose a folder for your meerCAD projects",
    buttonLabel: "Use this folder",
    defaultPath: projectsDir(),
    properties: ["openDirectory", "createDirectory"],
  });
  return r.canceled ? null : (r.filePaths[0] ?? null);
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
  settings = { ...settings, projectsDir: p.dir };
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
  return { dir: p.dir, moved, skipped };
});
/** Adds meerCAD to Claude Desktop's MCP configuration (keeps everything else, backs the file up first). */
ipcMain.handle("mcp:install-claude-desktop", async () => {
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
function mcpEntry() {
  return { command: process.execPath, args: [mcpServer], env: { ELECTRON_RUN_AS_NODE: "1" } };
}
ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  projectsDir: projectsDir(),
  mcpCommand: { command: process.execPath, args: [mcpServer], env: { ELECTRON_RUN_AS_NODE: "1" } },
}));

// ---------------------------------------------------------------- updates

let pendingUpdate: UpdateInfo | null = null;
async function runUpdateCheck(manual = false): Promise<void> {
  if (WIP) {
    if (manual) mainWindow?.webContents.send("update-error", "This is the local WIP build. It is replaced by running pnpm wip in the repository.");
    return;
  }
  try {
    const info = await checkForUpdate();
    if (info) {
      pendingUpdate = info;
      mainWindow?.webContents.send("update-available", { version: info.version, notes: info.notes, changes: info.changes, page: info.page, canInstall: await canSelfUpdate() });
    } else if (manual) mainWindow?.webContents.send("update-none", app.getVersion());
  } catch (e) {
    if (manual) mainWindow?.webContents.send("update-error", e instanceof Error ? e.message : String(e));
  }
}
ipcMain.handle("update:check", () => runUpdateCheck(true));
ipcMain.handle("update:install", async () => {
  if (!pendingUpdate) return;
  try {
    await installUpdate(pendingUpdate, mainWindow);
  } catch (e) {
    mainWindow?.webContents.send("update-error", e instanceof Error ? e.message : String(e));
  }
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

function buildMenu(): void {
  const send = (channel: string, ...args: unknown[]) => () => mainWindow?.webContents.send(channel, ...args);
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", registerAccelerator: false, click: send("menu", "settings") },
        ...(WIP ? [] : [{ label: "Check for Updates…", click: () => void runUpdateCheck(true) }]),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Part", accelerator: "CmdOrCtrl+N", click: send("menu", "new") },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: send("menu", "import") },
        { label: "All Projects", accelerator: "CmdOrCtrl+Shift+H", click: send("menu", "home") },
        { type: "separator" },
        { label: "Save Copy As .meercad…", accelerator: "CmdOrCtrl+Shift+S", click: send("menu", "save-as") },
        { label: "Show Projects Folder", click: () => void shell.openPath(projectsDir()) },
        { type: "separator" },
        // Tab keys are handled in the page; the menu only lists them.
        { label: "New Tab", accelerator: "CmdOrCtrl+T", registerAccelerator: false, click: send("menu", "new") },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", registerAccelerator: false, click: send("menu", "close-tab") },
        { label: "Reopen Closed Tab", accelerator: "CmdOrCtrl+Shift+T", registerAccelerator: false, click: send("menu", "reopen-tab") },
        { label: "Show Next Tab", accelerator: "Ctrl+Tab", registerAccelerator: false, click: send("menu", "next-tab") },
        { label: "Show Previous Tab", accelerator: "Ctrl+Shift+Tab", registerAccelerator: false, click: send("menu", "prev-tab") },
        { type: "separator" },
        { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", role: "close" },
      ],
    },
    {
      // Undo/Redo act on the model (or on the text field being typed in); the page handles the keys,
      // so the shortcuts are shown here but not registered twice.
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", registerAccelerator: false, click: send("menu", "undo") },
        { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", registerAccelerator: false, click: send("menu", "redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Keyboard Shortcuts", accelerator: "CmdOrCtrl+/", click: send("menu", "shortcuts") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "meerCAD on GitHub", click: () => void shell.openExternal("https://github.com/") }] },
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
    if (!WIP) await carryOverAppData(settingsPath(), thumbsDir()).catch(() => undefined);
    settings = readSettings();
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
    if (!WIP && !process.env["MEERCAD_PROJECTS_DIR"]) {
      const moved = await moveLegacyDefaultFolder(settings.projectsDir, defaultProjectsDir(), thumbsDir()).catch(() => null);
      if (moved) {
        settings = { ...settings, projectsDir: moved };
        await writeFile(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`).catch(() => undefined);
      }
    }
    await renameLegacyFiles(projectsDir(), thumbsDir()).catch(() => 0);
    if (app.isPackaged && !WIP) void fixClaudeConfig(mcpEntry()).catch(() => undefined);
    serveApp();
    buildMenu();
    mainWindow = createWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      for (const f of pendingOpen.splice(0)) void openExternalFile(f);
      // Check shortly after start, then hourly.
      if (app.isPackaged && !WIP) {
        setTimeout(() => void runUpdateCheck(), 5000);
        setInterval(() => void runUpdateCheck(), 60 * 60 * 1000);
        // Also look again when the app comes back to the front after a while.
        let lastCheck = Date.now();
        app.on("browser-window-focus", () => {
          if (Date.now() - lastCheck < 10 * 60 * 1000) return;
          lastCheck = Date.now();
          void runUpdateCheck();
        });
      }
    });
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) mainWindow = createWindow();
    });
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
