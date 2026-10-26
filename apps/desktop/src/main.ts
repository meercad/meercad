/**
 * leocad desktop shell. Serves the web app from an app:// origin (with the cross-origin isolation
 * headers it needs), stores projects as plain .leocad files in ~/Documents/leocad and exposes a
 * small, explicit file API to the renderer.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell, type MenuItemConstructorOptions } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { canSelfUpdate, checkForUpdate, installUpdate, type UpdateInfo } from "./updater";

const DEV = process.argv.includes("--dev");
const DEV_URL = "http://localhost:5173";
const webRoot = app.isPackaged ? join(process.resourcesPath, "web") : join(__dirname, "../../web/dist");
const mcpServer = app.isPackaged ? join(process.resourcesPath, "mcp", "server.js") : join(__dirname, "../../../packages/mcp/dist/server.js");
const projectsDir = () => process.env["LEOCAD_PROJECTS_DIR"] ?? join(app.getPath("documents"), "leocad");
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

/** Project ids are file names without the extension; reject anything that could escape the folder. */
function projectPath(id: string): string {
  if (!/^[^/\\:*?"<>|]{1,120}$/.test(id) || id.startsWith(".")) throw new Error(`invalid project name "${id}"`);
  return join(projectsDir(), `${id}.leocad`);
}

const thumbPath = (id: string) => join(thumbsDir(), `${createHash("sha1").update(projectPath(id)).digest("hex")}.png`);

async function listProjects() {
  await mkdir(projectsDir(), { recursive: true });
  const files = (await readdir(projectsDir())).filter((f) => f.endsWith(".leocad"));
  const out = await Promise.all(
    files.map(async (f) => {
      const id = basename(f, ".leocad");
      const st = await stat(join(projectsDir(), f));
      let thumbnail: string | undefined;
      try {
        thumbnail = `data:image/png;base64,${(await readFile(thumbPath(id))).toString("base64")}`;
      } catch {
        thumbnail = undefined;
      }
      return { id, name: id, updatedAt: st.mtimeMs, ...(thumbnail ? { thumbnail } : {}) };
    }),
  );
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function uniqueId(name: string): Promise<string> {
  const base = name.replace(/[/\\:*?"<>|]+/g, "-").trim().slice(0, 100) || "Untitled part";
  let id = base;
  for (let n = 2; existsSync(projectPath(id)); n++) id = `${base} ${n}`;
  return id;
}

ipcMain.handle("projects:list", () => listProjects());
ipcMain.handle("projects:load", async (_e, id: string) => {
  const st = await stat(projectPath(id));
  return { id, name: id, updatedAt: st.mtimeMs, doc: JSON.parse(await readFile(projectPath(id), "utf8")) };
});
ipcMain.handle("projects:save", async (_e, p: { id: string; doc: unknown; thumbnail?: string }) => {
  await mkdir(projectsDir(), { recursive: true });
  // Write atomically so a crash never leaves a half-written project.
  const tmp = `${projectPath(p.id)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(p.doc, null, 2)}\n`);
  await rename(tmp, projectPath(p.id));
  if (p.thumbnail?.startsWith("data:image/png;base64,")) {
    await mkdir(thumbsDir(), { recursive: true });
    await writeFile(thumbPath(p.id), Buffer.from(p.thumbnail.slice(22), "base64"));
  }
});
ipcMain.handle("projects:create", async (_e, p: { name: string; doc: unknown }) => {
  const id = await uniqueId(p.name);
  await mkdir(projectsDir(), { recursive: true });
  await writeFile(projectPath(id), `${JSON.stringify(p.doc, null, 2)}\n`);
  return { id, name: id, updatedAt: Date.now() };
});
ipcMain.handle("projects:rename", async (_e, p: { id: string; name: string }) => {
  const id = await uniqueId(p.name);
  await rename(projectPath(p.id), projectPath(id));
  if (existsSync(thumbPath(p.id))) await rename(thumbPath(p.id), thumbPath(id));
  return { id, name: id };
});
ipcMain.handle("projects:delete", async (_e, id: string) => {
  // Move to the Trash rather than deleting for good.
  await shell.trashItem(projectPath(id));
  await rm(thumbPath(id), { force: true });
});
ipcMain.handle("projects:reveal", (_e, id?: string) => (id ? shell.showItemInFolder(projectPath(id)) : shell.openPath(projectsDir())));
ipcMain.handle("files:save", async (e, p: { name: string; data: Uint8Array | string; filters?: { name: string; extensions: string[] }[] }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath("downloads"), p.name), ...(p.filters ? { filters: p.filters } : {}) });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, typeof p.data === "string" ? p.data : Buffer.from(p.data));
  return r.filePath;
});
ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  projectsDir: projectsDir(),
  mcpCommand: { command: process.execPath, args: [mcpServer], env: { ELECTRON_RUN_AS_NODE: "1" } },
}));

// ---------------------------------------------------------------- updates

let pendingUpdate: UpdateInfo | null = null;
async function runUpdateCheck(manual = false): Promise<void> {
  try {
    const info = await checkForUpdate();
    if (info) {
      pendingUpdate = info;
      mainWindow?.webContents.send("update-available", { version: info.version, notes: info.notes, page: info.page, canInstall: await canSelfUpdate() });
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
    title: "leocad",
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
  void win.loadURL(DEV ? DEV_URL : "app://leocad/");
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

/** Imports an .leocad file opened from Finder into the projects folder and opens it. */
async function openExternalFile(file: string): Promise<void> {
  if (!mainWindow) {
    pendingOpen.push(file);
    return;
  }
  try {
    const doc = JSON.parse(await readFile(file, "utf8")) as unknown;
    const inProjects = normalize(file).startsWith(projectsDir() + sep);
    const id = inProjects ? basename(file, ".leocad") : await uniqueId(basename(file, extname(file)));
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
        { label: "Check for Updates…", click: () => void runUpdateCheck(true) },
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
        { label: "Save Copy As .leocad…", accelerator: "CmdOrCtrl+Shift+S", click: send("menu", "save-as") },
        { label: "Show Projects Folder", click: () => void shell.openPath(projectsDir()) },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
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
    { role: "help", submenu: [{ label: "leocad on GitHub", click: () => void shell.openExternal("https://github.com/") }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_e, argv) => {
    const file = argv.find((a) => a.endsWith(".leocad"));
    if (file) void openExternalFile(file);
    mainWindow?.focus();
  });
  void app.whenReady().then(() => {
    serveApp();
    buildMenu();
    mainWindow = createWindow();
    mainWindow.webContents.once("did-finish-load", () => {
      for (const f of pendingOpen.splice(0)) void openExternalFile(f);
      // Check shortly after start, then hourly.
      if (app.isPackaged) {
        setTimeout(() => void runUpdateCheck(), 5000);
        setInterval(() => void runUpdateCheck(), 60 * 60 * 1000);
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
