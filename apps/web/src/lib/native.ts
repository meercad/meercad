/**
 * The iPad and iPhone app (Capacitor shell, apps/ios). Projects are plain .meercad files, either in
 * the app's iCloud Drive folder ("iCloud Drive › meerCAD", the same projects on every device and
 * the Mac) or in its Documents folder ("On My iPad › meerCAD", this device only); folders there are
 * real folders, like in the desktop app. Thumbnails live in Library, out of sight, and a copy next
 * to each file (see sharedPicture.ts), so other devices need not build the model again for it.
 * Exports go through the share sheet instead of a download.
 */
import { App } from "@capacitor/app";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type { MeercadDocument } from "@meercad/schema";
import type { FileStore, Project, ProjectMeta } from "./persistence";
import { t } from "./i18n";
import { formatSidecar, parseSidecar, sha256Hex, sidecarName, sidecarShows } from "./sharedPicture";

export const nativeApp = Capacitor.isNativePlatform();

/** The installed app's version, e.g. "1.0 (3)". */
export async function appVersion(): Promise<string> {
  const info = await App.getInfo();

  return info.build && info.build !== info.version ? `${info.version} (${info.build})` : info.version;
}

const DOCS = Directory.Documents;
const LIB = Directory.Library;
const EXT = ".meercad";

interface ICloudPlugin {
  status(): Promise<{ available: boolean; url?: string }>;
  download(o: { url: string; timeout?: number }): Promise<void>;
  watch(): Promise<void>;
  addListener(event: "change", fn: () => void): Promise<{ remove(): Promise<void> }>;
}

const ICloud = registerPlugin<ICloudPlugin>("ICloud");

/** Where the projects are: the app's Documents, or the iCloud folder (its file URL, ending in "/"). */
type Root = { kind: "local" } | { kind: "icloud"; base: string };

const LOCAL: Root = { kind: "local" };
const STORAGE_KEY = "meercad.storage";

/** The iCloud folder if iCloud Drive is on for the app, else null. */
export async function iCloudFolder(): Promise<string | null> {
  if (!nativeApp) return null;

  try {
    const s = await ICloud.status();

    return s.available && s.url ? s.url.replace(/\/?$/, "/") : null;
  } catch {
    return null;
  }
}

let rootPromise: Promise<Root> | null = null;

/**
 * The projects' place. A fresh install with iCloud starts there; an install that already has
 * projects on the device stays local until the user switches (Settings).
 */
function root(): Promise<Root> {
  return (rootPromise ??= (async (): Promise<Root> => {
    let choice: string | null = null;

    try {
      choice = localStorage.getItem(STORAGE_KEY);
    } catch {
      // no stored choice
    }

    const cloud = await iCloudFolder();
    if (choice === "local") return LOCAL;

    if (cloud && (choice === "icloud" || !(await projectIds(LOCAL)).length)) {
      remember("icloud");
      void watchICloud();

      return { kind: "icloud", base: cloud };
    }

    if (choice === "icloud" && !cloud) return LOCAL;

    remember("local");

    return LOCAL;
  })());
}

function remember(choice: "local" | "icloud"): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // asked again next start
  }
}

/** Where projects are saved now. */
export async function storageKind(): Promise<"local" | "icloud"> {
  return (await root()).kind;
}

let watching = false;

/** Changes from other devices refresh the projects list (debounced: an edit brings several events). */
async function watchICloud(): Promise<void> {
  if (watching) return;

  watching = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  await ICloud.addListener("change", () => {
    clearTimeout(timer);
    timer = setTimeout(() => window.dispatchEvent(new Event("meercad:projects-changed")), 400);
  });
  await ICloud.watch();
}

/** A path below the projects' place as Filesystem options: relative to Documents, or a file URL in iCloud. */
function at(r: Root, path: string): { path: string; directory?: Directory } {
  if (r.kind === "local") return { path, directory: DOCS };

  return { path: r.base + path.split("/").filter(Boolean).map(encodeURIComponent).join("/") };
}

const renameOpts = (r: Root, from: string, to: string) => {
  const a = at(r, from),
    b = at(r, to);

  return {
    from: a.path,
    to: b.path,
    ...(a.directory ? { directory: a.directory, toDirectory: a.directory } : {}),
  };
};

const joinId = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const folderOf = (id: string) => (id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "");
const nameOf = (id: string) => id.slice(id.lastIndexOf("/") + 1);
const safeName = (name: string, fallback: string) =>
  name
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 100) || fallback;
const projectPath = (id: string) => `${id}${EXT}`;

/** Thumbnails are keyed by a hash of the project path, so renames carry them along explicitly. */
function thumbPath(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);

  return `thumbnails/${(h >>> 0).toString(16)}.png`;
}

const thumbExists = (path: string) =>
  Filesystem.stat({ path, directory: LIB }).then(
    () => true,
    () => false,
  );
const exists = (r: Root, path: string) =>
  Filesystem.stat(at(r, path)).then(
    () => true,
    () => false,
  );

async function ensureDir(r: Root, path: string): Promise<void> {
  if (!path || (await exists(r, path))) return;

  await Filesystem.mkdir({ ...at(r, path), recursive: true });
}

/** Where the Scan plugin keeps its captures (photos, meshes): not a project folder. */
const SCANS = "Scans";
const hidden = (folder: string, name: string) => name.startsWith(".") || (!folder && name === SCANS);
/** A project still only in iCloud shows up as ".Name.meercad.icloud" (before iOS 17). */
const PLACEHOLDER = /^\.(.+\.meercad)\.icloud$/;

/** All .meercad files below a folder: ids ("Folder/Name") and the file that stands for each now. */
async function projectFiles(r: Root, folder = ""): Promise<{ id: string; file: string }[]> {
  const out: { id: string; file: string }[] = [];
  let entries;

  try {
    entries = (await Filesystem.readdir(at(r, folder))).files;
  } catch {
    return out;
  }

  for (const e of entries) {
    const cloud = r.kind === "icloud" ? PLACEHOLDER.exec(e.name) : null;

    if (cloud) {
      out.push({ id: joinId(folder, cloud[1]!).slice(0, -EXT.length), file: joinId(folder, e.name) });
      continue;
    }

    if (hidden(folder, e.name)) continue;

    const rel = joinId(folder, e.name);
    if (e.type === "directory") out.push(...(await projectFiles(r, rel)));
    else if (e.name.endsWith(EXT)) out.push({ id: rel.slice(0, -EXT.length), file: rel });
  }

  return out;
}

const projectIds = async (r: Root, folder = "") => (await projectFiles(r, folder)).map((p) => p.id);

async function folderList(r: Root, folder = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;

  try {
    entries = (await Filesystem.readdir(at(r, folder))).files;
  } catch {
    return out;
  }

  for (const e of entries) {
    if (e.type !== "directory" || hidden(folder, e.name)) continue;

    const rel = joinId(folder, e.name);
    out.push(rel, ...(await folderList(r, rel)));
  }

  return out;
}

async function uniqueId(r: Root, name: string, folder = ""): Promise<string> {
  const base = safeName(name, "Untitled part");
  let id = joinId(folder, base);
  for (let n = 2; await exists(r, projectPath(id)); n++) id = joinId(folder, `${base} ${n}`);

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

/** When the picture was written, where the file system says. */
async function thumbTime(id: string): Promise<number | undefined> {
  try {
    return (await Filesystem.stat({ path: thumbPath(id), directory: LIB })).mtime;
  } catch {
    return undefined;
  }
}

async function moveThumb(from: string, to: string): Promise<void> {
  if (!(await thumbExists(thumbPath(from)))) return;

  await Filesystem.deleteFile({ path: thumbPath(to), directory: LIB }).catch(() => undefined);
  await Filesystem.rename({ from: thumbPath(from), to: thumbPath(to), directory: LIB, toDirectory: LIB });
}

async function moveProject(r: Root, from: string, to: string): Promise<void> {
  if (from === to) return;

  await ensureDir(r, folderOf(to));
  await Filesystem.rename(renameOpts(r, projectPath(from), projectPath(to)));
  await moveThumb(from, to);

  if (await exists(r, sidecarPath(from))) {
    await Filesystem.rename(renameOpts(r, sidecarPath(from), sidecarPath(to))).catch(() => undefined);
  }
}

/** The picture next to a project's file (see sharedPicture.ts). */
const sidecarPath = (id: string) => joinId(folderOf(id), sidecarName(nameOf(id) + EXT));

/** A project file's bytes, read by the web view (see readDoc); in iCloud fetched first. */
async function fileBytes(r: Root, id: string): Promise<Uint8Array> {
  const where = at(r, projectPath(id));
  if (r.kind === "icloud") await ICloud.download({ url: where.path });

  try {
    const uri = where.directory
      ? (await Filesystem.getUri({ path: where.path, directory: where.directory })).uri
      : where.path;
    const res = await fetch(Capacitor.convertFileSrc(uri));
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
  } catch {
    // read through the plugin
  }

  const b64 = (await Filesystem.readFile(where)).data as string;

  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Keeps the picture next to the project's file, for `bytes`, the file as it is now. Never fails. */
async function writeSidecar(
  r: Root,
  id: string,
  thumbnail: string,
  look: number,
  bytes: Uint8Array,
): Promise<void> {
  try {
    const sha256 = await sha256Hex(bytes);
    if (!sha256) return;

    await Filesystem.writeFile({
      ...at(r, sidecarPath(id)),
      data: formatSidecar({ size: bytes.length, sha256, look, thumbnail }),
      encoding: Encoding.UTF8,
      recursive: true,
    });
  } catch (e) {
    console.warn(`picture next to ${id} not written: ${String(e)}`);
  }
}

/** The picture next to the project's file if it shows the file as it is now (see sharedPicture.ts). */
async function readSidecar(r: Root, id: string): Promise<{ thumbnail: string; look: number } | null> {
  const where = at(r, sidecarPath(id));
  if (r.kind === "icloud") await ICloud.download({ url: where.path, timeout: 20 }).catch(() => undefined);

  let text: string;

  try {
    text = (await Filesystem.readFile({ ...where, encoding: Encoding.UTF8 })).data as string;
  } catch {
    return null;
  }

  const shared = parseSidecar(text);
  if (!shared) return null;

  const bytes = await fileBytes(r, id);
  const sha256 = shared.size === bytes.length ? await sha256Hex(bytes) : null;

  return sha256 && sidecarShows(shared, { size: bytes.length, sha256 })
    ? { thumbnail: shared.thumbnail, look: shared.look }
    : null;
}

const writeDoc = (r: Root, id: string, text: string) =>
  Filesystem.writeFile({ ...at(r, projectPath(id)), data: text, encoding: Encoding.UTF8, recursive: true });
const docText = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;

/**
 * A project's design; in iCloud the file is fetched first if it is only in the cloud so far.
 *
 * Read by the web view itself (the file URL Capacitor serves to the page), not through the plugin:
 * the plugin hands the whole text over as one escaped string in a message, and for a design of
 * 40 MB (the robot) the page then held several copies at once, over 1 GB for a moment, which the
 * iPhone did not allow it. The plugin is the way back should the web view not reach the file.
 */
async function readDoc(r: Root, id: string): Promise<MeercadDocument> {
  const where = at(r, projectPath(id));
  if (r.kind === "icloud") await ICloud.download({ url: where.path });

  try {
    const uri = where.directory
      ? (await Filesystem.getUri({ path: where.path, directory: where.directory })).uri
      : where.path;
    const res = await fetch(Capacitor.convertFileSrc(uri));
    if (res.ok) return (await res.json()) as MeercadDocument;
  } catch (e) {
    console.warn(`reading ${id} in the web view failed, reading it through the plugin: ${String(e)}`);
  }

  return JSON.parse(
    (await Filesystem.readFile({ ...where, encoding: Encoding.UTF8 })).data as string,
  ) as MeercadDocument;
}

/**
 * Moves every project (and the folders they are in) to iCloud or back onto this device, then
 * saves there from now on. A project with the same name already at the target stays where it was.
 */
export async function switchStorage(to: "local" | "icloud"): Promise<{ moved: number; skipped: number }> {
  const from = await root();
  if (from.kind === to) return { moved: 0, skipped: 0 };

  const cloud = to === "icloud" ? await iCloudFolder() : null;

  if (to === "icloud" && !cloud) {
    throw new Error(
      t(
        "iCloud Drive is not available: sign in to iCloud and turn on iCloud Drive for meerCAD in the Settings app.",
      ),
    );
  }

  const target: Root = cloud ? { kind: "icloud", base: cloud } : LOCAL;
  let moved = 0,
    skipped = 0;
  for (const f of await folderList(from)) await ensureDir(target, f);

  for (const id of await projectIds(from)) {
    if (await exists(target, projectPath(id))) {
      skipped++;
      continue;
    }

    await writeDoc(target, id, docText(await readDoc(from, id)));
    await Filesystem.deleteFile(at(from, projectPath(id)));
    moved++;
  }

  // Folders left empty on the device go; nothing is deleted in iCloud.
  if (from.kind === "local") {
    for (const f of (await folderList(from)).reverse()) {
      if (!(await projectIds(from, f)).length) {
        await Filesystem.rmdir({ ...at(from, f), recursive: true }).catch(() => undefined);
      }
    }
  }

  rootPromise = Promise.resolve(target);
  remember(to);
  if (to === "icloud") void watchICloud();

  return { moved, skipped };
}

export const nativeFiles: FileStore | undefined = nativeApp
  ? {
      projects: {
        async list(): Promise<ProjectMeta[]> {
          const r = await root();
          const out = await Promise.all(
            (await projectFiles(r)).map(async ({ id, file }) => {
              const st = await Filesystem.stat(at(r, file));
              const thumbnail = await readThumb(id);
              const thumbnailAt = thumbnail ? await thumbTime(id) : undefined;

              return {
                id,
                name: nameOf(id),
                folder: folderOf(id),
                updatedAt: st.mtime,
                size: st.size,
                ...(st.ctime ? { createdAt: st.ctime } : {}),
                ...(thumbnail ? { thumbnail, ...(thumbnailAt !== undefined ? { thumbnailAt } : {}) } : {}),
              };
            }),
          );

          return out.sort((a, b) => b.updatedAt - a.updatedAt);
        },
        async load(id: string): Promise<Project> {
          const r = await root();
          const doc = await readDoc(r, id);
          const st = await Filesystem.stat(at(r, projectPath(id)));

          return { id, name: nameOf(id), folder: folderOf(id), updatedAt: st.mtime, size: st.size, doc };
        },
        async save(p: {
          id: string;
          doc: MeercadDocument;
          thumbnail?: string;
          look?: number;
        }): Promise<void> {
          const r = await root();
          const text = docText(p.doc);
          await writeDoc(r, p.id, text);

          if (p.thumbnail?.startsWith("data:image/png;base64,")) {
            await Filesystem.writeFile({
              path: thumbPath(p.id),
              directory: LIB,
              data: p.thumbnail.slice(22),
              recursive: true,
            });

            if (p.look !== undefined) {
              await writeSidecar(r, p.id, p.thumbnail, p.look, new TextEncoder().encode(text));
            }
          }
        },
        async thumbnail(p: { id: string; thumbnail: string; look?: number; local?: boolean }): Promise<void> {
          if (!p.thumbnail.startsWith("data:image/png;base64,")) return;

          await Filesystem.writeFile({
            path: thumbPath(p.id),
            directory: LIB,
            data: p.thumbnail.slice(22),
            recursive: true,
          });
          if (p.local || p.look === undefined) return;

          const r = await root();
          const bytes = await fileBytes(r, p.id).catch(() => null);
          if (bytes) await writeSidecar(r, p.id, p.thumbnail, p.look, bytes);
        },
        async sharedThumbnail(id: string) {
          return readSidecar(await root(), id).catch(() => null);
        },
        async create(p: { name: string; doc: MeercadDocument; folder?: string }): Promise<ProjectMeta> {
          const r = await root();
          const id = await uniqueId(r, p.name, p.folder ?? "");
          await writeDoc(r, id, docText(p.doc));

          return { id, name: nameOf(id), folder: folderOf(id), updatedAt: Date.now(), createdAt: Date.now() };
        },
        async rename(p: { id: string; name: string }) {
          const r = await root();
          const id = await uniqueId(r, p.name, folderOf(p.id));
          await moveProject(r, p.id, id);

          return { id, name: nameOf(id), folder: folderOf(id) };
        },
        async move(p: { id: string; folder: string }) {
          if (folderOf(p.id) === p.folder) return { id: p.id, name: nameOf(p.id), folder: p.folder };

          const r = await root();
          const id = await uniqueId(r, nameOf(p.id), p.folder);
          await moveProject(r, p.id, id);

          return { id, name: nameOf(id), folder: folderOf(id) };
        },
        folders: async () => folderList(await root()),
        async delete(id: string): Promise<void> {
          const r = await root();
          await Filesystem.deleteFile(at(r, projectPath(id)));
          await Filesystem.deleteFile({ path: thumbPath(id), directory: LIB }).catch(() => undefined);
          await Filesystem.deleteFile(at(r, sidecarPath(id))).catch(() => undefined);
        },
      },
      folders: {
        async create(p: { parent: string; name: string }): Promise<string> {
          const r = await root();
          const base = safeName(p.name, "New folder");
          let folder = joinId(p.parent, base);
          for (let n = 2; await exists(r, folder); n++) folder = joinId(p.parent, `${base} ${n}`);
          await ensureDir(r, folder);

          return folder;
        },
        async rename(p: { folder: string; name: string }): Promise<string> {
          const r = await root();
          const target = joinId(folderOf(p.folder), safeName(p.name, nameOf(p.folder)));
          if (target === p.folder) return target;

          if (await exists(r, target)) {
            throw new Error(t('a folder named "{name}" already exists', { name: nameOf(target) }));
          }

          const inside = await projectIds(r, p.folder);
          await Filesystem.rename(renameOpts(r, p.folder, target));
          for (const id of inside) await moveThumb(id, target + id.slice(p.folder.length));

          return target;
        },
        async delete(folder: string): Promise<void> {
          const r = await root();

          for (const id of await projectIds(r, folder)) {
            await Filesystem.deleteFile({ path: thumbPath(id), directory: LIB }).catch(() => undefined);
          }

          await Filesystem.rmdir({ ...at(r, folder), recursive: true });
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

interface ARPluginApi {
  available(): Promise<{ ar: boolean }>;
  show(o: { url: string }): Promise<void>;
}

const AR = registerPlugin<ARPluginApi>("AR");

/** Whether this iPhone or iPad can place a part in the room (false on the Mac and in the browser). */
export async function arAvailable(): Promise<boolean> {
  if (!nativeApp) return false;

  try {
    return (await AR.available()).ar;
  } catch {
    return false; // an app build without the AR plugin
  }
}

/**
 * Shows a USDZ in AR Quick Look: the part stands on the table in real size (pinching cannot
 * scale it). Resolves when the preview is closed. The file is named after the part, which
 * Quick Look shows as its title and uses when it is shared from there.
 */
export async function showInAr(name: string, usdz: Uint8Array): Promise<void> {
  await Filesystem.rmdir({ path: "ar", directory: Directory.Cache, recursive: true }).catch(() => undefined);

  const written = await Filesystem.writeFile({
    path: `ar/${name}`,
    directory: Directory.Cache,
    recursive: true,
    data: toBase64(usdz),
  });
  await AR.show({ url: written.uri });
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
export function onFileOpened(
  open: (target: { id: string } | { name: string; text: string }) => void,
): () => void {
  if (!nativeApp) return () => undefined;

  const handle = (url: string) => {
    if (!/\.meercad$/i.test(decodeURIComponent(url))) return;

    void (async () => {
      const place = await root();
      const docs =
        place.kind === "icloud"
          ? place.base
          : (await Filesystem.getUri({ path: "", directory: DOCS })).uri.replace(/\/?$/, "/");
      const path = decodeURIComponent(url);

      if (path.startsWith(decodeURIComponent(docs))) {
        return open({ id: path.slice(decodeURIComponent(docs).length, -EXT.length) });
      }

      const r = await Filesystem.readFile({ path: url, encoding: Encoding.UTF8 });
      open({ name: nameOf(path).slice(0, -EXT.length), text: r.data as string });
    })();
  };

  const sub = App.addListener("appUrlOpen", (e) => handle(e.url));
  void App.getLaunchUrl().then((r) => r?.url && handle(r.url));

  return () => void sub.then((s) => s.remove());
}

interface PencilPlugin {
  addListener(
    event: "tap",
    fn: (e: { kind: "tap" | "squeeze" }) => void,
  ): Promise<{ remove(): Promise<void> }>;
}
/** Apple Pencil double-tap (Pencil 2 and Pro) and squeeze (Pro), from the app's native Pencil plugin. */
export const Pencil = registerPlugin<PencilPlugin>("Pencil");
