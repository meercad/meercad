/**
 * The iPad app (Capacitor shell, apps/ios). Projects are plain .meercad files in the app's
 * Documents folder, which the Files app shows under "On My iPad › meerCAD"; folders there are real
 * folders, like in the desktop app. Thumbnails live in Library, out of sight. Exports go through
 * the share sheet instead of a download.
 */
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { MeercadDocument } from "@meercad/schema";
import type { FileStore, Project, ProjectMeta } from "./persistence";

export const nativeApp = Capacitor.isNativePlatform();

/** The installed app's version, e.g. "1.0 (3)". */
export async function appVersion(): Promise<string> {
  const info = await App.getInfo();
  return info.build && info.build !== info.version ? `${info.version} (${info.build})` : info.version;
}

const DOCS = Directory.Documents;
const LIB = Directory.Library;
const EXT = ".meercad";

const joinId = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const folderOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
const nameOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const safeName = (name: string, fallback: string) => name.replace(/[/\\:*?"<>|]+/g, "-").replace(/^\.+/, "").trim().slice(0, 100) || fallback;
const projectPath = (id: string) => `${id}${EXT}`;

/** Thumbnails are keyed by a hash of the project path, so renames carry them along explicitly. */
function thumbPath(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return `thumbnails/${(h >>> 0).toString(16)}.png`;
}

const exists = (path: string, directory = DOCS) =>
  Filesystem.stat({ path, directory }).then(
    () => true,
    () => false,
  );

async function ensureDir(path: string, directory = DOCS): Promise<void> {
  if (!path || (await exists(path, directory))) return;
  await Filesystem.mkdir({ path, directory, recursive: true });
}

/** All .meercad files below a folder, as ids ("Folder/Name"). */
async function projectIds(folder = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = (await Filesystem.readdir({ path: folder, directory: DOCS })).files;
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = joinId(folder, e.name);
    if (e.type === "directory") out.push(...(await projectIds(rel)));
    else if (e.name.endsWith(EXT)) out.push(rel.slice(0, -EXT.length));
  }
  return out;
}

async function folderList(folder = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = (await Filesystem.readdir({ path: folder, directory: DOCS })).files;
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.type !== "directory" || e.name.startsWith(".")) continue;
    const rel = joinId(folder, e.name);
    out.push(rel, ...(await folderList(rel)));
  }
  return out;
}

async function uniqueId(name: string, folder = ""): Promise<string> {
  const base = safeName(name, "Untitled part");
  let id = joinId(folder, base);
  for (let n = 2; await exists(projectPath(id)); n++) id = joinId(folder, `${base} ${n}`);
  return id;
}

async function readThumb(id: string): Promise<string | undefined> {
  try {
    const r = await Filesystem.readFile({ path: thumbPath(id), directory: LIB });
    return typeof r.data === "string" ? `data:image/png;base64,${r.data}` : undefined;
  } catch {
    return undefined;
  }
}

async function moveThumb(from: string, to: string): Promise<void> {
  if (!(await exists(thumbPath(from), LIB))) return;
  await Filesystem.deleteFile({ path: thumbPath(to), directory: LIB }).catch(() => undefined);
  await Filesystem.rename({ from: thumbPath(from), to: thumbPath(to), directory: LIB, toDirectory: LIB });
}

async function moveProject(from: string, to: string): Promise<void> {
  if (from === to) return;
  await ensureDir(folderOf(to));
  await Filesystem.rename({ from: projectPath(from), to: projectPath(to), directory: DOCS, toDirectory: DOCS });
  await moveThumb(from, to);
}

const writeDoc = (id: string, doc: unknown) =>
  Filesystem.writeFile({ path: projectPath(id), directory: DOCS, data: `${JSON.stringify(doc, null, 2)}\n`, encoding: Encoding.UTF8, recursive: true });

export const nativeFiles: FileStore | undefined = nativeApp
  ? {
      projects: {
        async list(): Promise<ProjectMeta[]> {
          const out = await Promise.all(
            (await projectIds()).map(async (id) => {
              const st = await Filesystem.stat({ path: projectPath(id), directory: DOCS });
              const thumbnail = await readThumb(id);
              return { id, name: nameOf(id), folder: folderOf(id), updatedAt: st.mtime, ...(thumbnail ? { thumbnail } : {}) };
            }),
          );
          return out.sort((a, b) => b.updatedAt - a.updatedAt);
        },
        async load(id: string): Promise<Project> {
          const st = await Filesystem.stat({ path: projectPath(id), directory: DOCS });
          const r = await Filesystem.readFile({ path: projectPath(id), directory: DOCS, encoding: Encoding.UTF8 });
          return { id, name: nameOf(id), folder: folderOf(id), updatedAt: st.mtime, doc: JSON.parse(r.data as string) as MeercadDocument };
        },
        async save(p: { id: string; doc: MeercadDocument; thumbnail?: string }): Promise<void> {
          await writeDoc(p.id, p.doc);
          if (p.thumbnail?.startsWith("data:image/png;base64,")) {
            await Filesystem.writeFile({ path: thumbPath(p.id), directory: LIB, data: p.thumbnail.slice(22), recursive: true });
          }
        },
        async create(p: { name: string; doc: MeercadDocument; folder?: string }): Promise<ProjectMeta> {
          const id = await uniqueId(p.name, p.folder ?? "");
          await writeDoc(id, p.doc);
          return { id, name: nameOf(id), folder: folderOf(id), updatedAt: Date.now() };
        },
        async rename(p: { id: string; name: string }) {
          const id = await uniqueId(p.name, folderOf(p.id));
          await moveProject(p.id, id);
          return { id, name: nameOf(id), folder: folderOf(id) };
        },
        async move(p: { id: string; folder: string }) {
          if (folderOf(p.id) === p.folder) return { id: p.id, name: nameOf(p.id), folder: p.folder };
          const id = await uniqueId(nameOf(p.id), p.folder);
          await moveProject(p.id, id);
          return { id, name: nameOf(id), folder: folderOf(id) };
        },
        folders: () => folderList(),
        async delete(id: string): Promise<void> {
          await Filesystem.deleteFile({ path: projectPath(id), directory: DOCS });
          await Filesystem.deleteFile({ path: thumbPath(id), directory: LIB }).catch(() => undefined);
        },
      },
      folders: {
        async create(p: { parent: string; name: string }): Promise<string> {
          const base = safeName(p.name, "New folder");
          let folder = joinId(p.parent, base);
          for (let n = 2; await exists(folder); n++) folder = joinId(p.parent, `${base} ${n}`);
          await ensureDir(folder);
          return folder;
        },
        async rename(p: { folder: string; name: string }): Promise<string> {
          const target = joinId(folderOf(p.folder), safeName(p.name, nameOf(p.folder)));
          if (target === p.folder) return target;
          if (await exists(target)) throw new Error(`a folder named "${nameOf(target)}" already exists`);
          const inside = await projectIds(p.folder);
          await Filesystem.rename({ from: p.folder, to: target, directory: DOCS, toDirectory: DOCS });
          for (const id of inside) await moveThumb(id, target + id.slice(p.folder.length));
          return target;
        },
        async delete(folder: string): Promise<void> {
          for (const id of await projectIds(folder)) await Filesystem.deleteFile({ path: thumbPath(id), directory: LIB }).catch(() => undefined);
          await Filesystem.rmdir({ path: folder, directory: DOCS, recursive: true });
        },
      },
    }
  : undefined;

/** Hands an export to the share sheet (Save to Files, AirDrop, Mail, …). */
export async function shareFile(name: string, data: string | Uint8Array): Promise<void> {
  const written = await Filesystem.writeFile({
    path: `exports/${name}`,
    directory: Directory.Cache,
    recursive: true,
    ...(typeof data === "string" ? { data, encoding: Encoding.UTF8 } : { data: toBase64(data) }),
  });
  await Share.share({ title: name, files: [written.uri] }).catch(() => undefined);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A .meercad file opened from the Files app: one already in the projects folder opens in place,
 * any other is read and becomes a new project.
 */
export function onFileOpened(open: (target: { id: string } | { name: string; text: string }) => void): () => void {
  if (!nativeApp) return () => undefined;
  const handle = (url: string) => {
    if (!/\.meercad$/i.test(decodeURIComponent(url))) return;
    void (async () => {
      const docs = (await Filesystem.getUri({ path: "", directory: DOCS })).uri.replace(/\/?$/, "/");
      const path = decodeURIComponent(url);
      if (path.startsWith(decodeURIComponent(docs))) return open({ id: path.slice(decodeURIComponent(docs).length, -EXT.length) });
      const r = await Filesystem.readFile({ path: url, encoding: Encoding.UTF8 });
      open({ name: nameOf(path).slice(0, -EXT.length), text: r.data as string });
    })();
  };
  const sub = App.addListener("appUrlOpen", (e) => handle(e.url));
  void App.getLaunchUrl().then((r) => r?.url && handle(r.url));
  return () => void sub.then((s) => s.remove());
}

interface PencilPlugin {
  addListener(event: "tap", fn: (e: { kind: "tap" | "squeeze" }) => void): Promise<{ remove(): Promise<void> }>;
}
/** Apple Pencil double-tap (Pencil 2 and Pro) and squeeze (Pro), from the app's native Pencil plugin. */
export const Pencil = registerPlugin<PencilPlugin>("Pencil");
