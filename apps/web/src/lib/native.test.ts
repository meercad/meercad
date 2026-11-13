/**
 * The iPad and iPhone app's project files (native.ts) over an in-memory stand-in for Capacitor's
 * file system and the iCloud plugin: projects are written, listed, read, renamed, moved into
 * folders and deleted as plain .meercad files; pictures go along; switching to iCloud moves every
 * project there and back without losing one; a file opened from the Files app opens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyDocument, type MeercadDocument } from "@meercad/schema";

/** Files by place ("<directory>:<path>" or the iCloud URL), with their text or base64 contents. */
const fs = new Map<string, { data: string; mtime: number; ctime: number }>();
const dirs = new Set<string>();
let cloudOn = true;
const listeners: Record<string, ((e: { url: string }) => void)[]> = {};
const shared: unknown[] = [];
const CLOUD = "file:///iCloud/meerCAD/";

const key = (o: { path: string; directory?: string }) =>
  (o.directory ? `${o.directory}:${o.path}` : o.path).replace(/\/+$/, "");
const parentOf = (k: string) =>
  k.slice(0, Math.max(k.lastIndexOf("/"), k.indexOf(":") + 1)).replace(/\/+$/, "");
const notFound = () => Promise.reject(new Error("File does not exist"));
let clock = 1000;

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    convertFileSrc: (u: string) => `capacitor://file/${encodeURIComponent(u)}`,
  },
  registerPlugin: (name: string) =>
    name === "ICloud"
      ? {
          status: async () => ({ available: cloudOn, url: cloudOn ? CLOUD : undefined }),
          download: async () => undefined,
          watch: async () => undefined,
          addListener: async (_e: string, fn: () => void) => (
            (listeners["change"] ??= []).push(fn as never),
            { remove: async () => undefined }
          ),
        }
      : name === "AR"
        ? { available: async () => ({ ar: true }), show: async (o: { url: string }) => void shared.push(o) }
        : { addListener: async () => ({ remove: async () => undefined }) },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    getInfo: async () => ({ version: "1.0", build: "3" }),
    getLaunchUrl: async () => null,
    addListener: async (e: string, fn: (x: { url: string }) => void) => (
      (listeners[e] ??= []).push(fn),
      { remove: async () => undefined }
    ),
  },
}));
vi.mock("@capacitor/share", () => ({ Share: { share: async (o: unknown) => void shared.push(o) } }));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Documents: "DOCUMENTS", Library: "LIBRARY", Cache: "CACHE" },
  Encoding: { UTF8: "utf8" },
  Filesystem: {
    async writeFile(o: { path: string; directory?: string; data: string; encoding?: string }) {
      const k = key(o);
      const had = fs.get(k);
      fs.set(k, { data: o.encoding ? o.data : o.data, mtime: ++clock, ctime: had?.ctime ?? clock });

      for (let p = parentOf(k); p && !p.endsWith(":") && p !== CLOUD.replace(/\/$/, ""); p = parentOf(p)) {
        dirs.add(p);
      }

      return { uri: `file:///${k}` };
    },
    async readFile(o: { path: string; directory?: string; encoding?: string }) {
      const f = fs.get(key(o));
      if (!f) return notFound();

      return { data: f.data };
    },
    async stat(o: { path: string; directory?: string }) {
      const k = key(o);
      const f = fs.get(k);

      if (f) {
        return { type: "file", mtime: f.mtime, ctime: f.ctime, size: f.data.length, uri: `file:///${k}` };
      }

      if (dirs.has(k)) return { type: "directory", mtime: clock, size: 0, uri: `file:///${k}` };

      return notFound();
    },
    async readdir(o: { path: string; directory?: string }) {
      const base = key(o);
      const prefix = base && !base.endsWith(":") ? `${base}/` : base;
      const names = new Map<string, "file" | "directory">();

      for (const k of fs.keys()) {
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) {
          names.set(k.slice(prefix.length), "file");
        }
      }

      for (const d of dirs) {
        if (d.startsWith(prefix) && d !== base && !d.slice(prefix.length).includes("/")) {
          names.set(d.slice(prefix.length), "directory");
        }
      }

      // The system lists names as they are, not as they are written in a URL.
      return {
        files: [...names].map(([name, type]) => ({
          name: decodeURIComponent(name),
          type,
          mtime: clock,
          size: 0,
          uri: "",
        })),
      };
    },
    async mkdir(o: { path: string; directory?: string }) {
      dirs.add(key(o));
    },
    async rmdir(o: { path: string; directory?: string }) {
      const k = key(o);
      for (const f of [...fs.keys()]) if (f.startsWith(`${k}/`)) fs.delete(f);
      for (const d of [...dirs]) if (d === k || d.startsWith(`${k}/`)) dirs.delete(d);
    },
    async deleteFile(o: { path: string; directory?: string }) {
      if (!fs.delete(key(o))) return notFound();
    },
    async rename(o: { from: string; to: string; directory?: string; toDirectory?: string }) {
      const from = key({ path: o.from, directory: o.directory });
      const to = key({ path: o.to, directory: o.toDirectory ?? o.directory });

      if (fs.has(from)) {
        fs.set(to, fs.get(from)!);
        fs.delete(from);

        return;
      }

      if (!dirs.has(from)) return notFound();

      for (const k of [...fs.keys()]) {
        if (k.startsWith(`${from}/`)) (fs.set(to + k.slice(from.length), fs.get(k)!), fs.delete(k));
      }

      for (const d of [...dirs]) {
        if (d === from || d.startsWith(`${from}/`)) (dirs.delete(d), dirs.add(to + d.slice(from.length)));
      }
    },
    async getUri(o: { path: string; directory?: string }) {
      return { uri: `file:///${key(o)}` };
    },
  },
}));

const docOf = (n: number): MeercadDocument => ({ ...emptyDocument(), params: { n: `${n} mm` } });
// The web view reading a file by its URL: served from the same files.
globalThis.fetch = (async (url: string) => {
  const k = decodeURIComponent(String(url).replace("capacitor://file/", "")).replace("file:///", "");
  const f = fs.get(k);

  return f ? new Response(f.data, { status: 200 }) : new Response("", { status: 404 });
}) as typeof fetch;

async function fresh() {
  vi.resetModules();

  return import("./native");
}

beforeEach(() => {
  fs.clear();
  dirs.clear();
  shared.length = 0;
  localStorage.clear();
  cloudOn = true;
});

describe("project files on the iPad and iPhone", () => {
  it("starts in iCloud on a fresh install and keeps projects there", async () => {
    const n = await fresh();
    expect(n.nativeApp).toBe(true);
    expect(await n.appVersion()).toBe("1.0 (3)");
    expect(await n.storageKind()).toBe("icloud");

    const files = n.nativeFiles!;
    const a = await files.projects.create({ name: "Bracket", doc: docOf(1) });
    expect(a).toMatchObject({ id: "Bracket", name: "Bracket", folder: "" });
    expect(fs.has(`${CLOUD}Bracket.meercad`)).toBe(true);
    // The same name again gets a number.
    expect((await files.projects.create({ name: "Bracket", doc: docOf(2) })).id).toBe("Bracket 2");
    // Names with characters a file cannot have are cleaned up.
    expect((await files.projects.create({ name: "a/b:c", doc: docOf(3) })).id).toBe("a-b-c");

    const list = await files.projects.list();
    expect(list.map((p) => p.id).sort()).toEqual(["Bracket", "Bracket 2", "a-b-c"]);
    expect((await files.projects.load("Bracket 2")).doc.params["n"]).toBe("2 mm");
  });

  it("stays on the device when it has projects there already", async () => {
    fs.set("DOCUMENTS:Old.meercad", { data: JSON.stringify(docOf(9)), mtime: 1, ctime: 1 });

    const n = await fresh();
    expect(await n.storageKind()).toBe("local");
    expect((await n.nativeFiles!.projects.list()).map((p) => p.id)).toEqual(["Old"]);
  });

  it("saves with a picture, renames, moves into a folder and deletes", async () => {
    localStorage.setItem("meercad.storage", "local");
    cloudOn = false;

    const n = await fresh();
    const files = n.nativeFiles!;
    const p = await files.projects.create({ name: "Lid", doc: docOf(1) });
    await files.projects.save({ id: p.id, doc: docOf(5), thumbnail: "data:image/png;base64,AAAA", look: 7 });
    expect(JSON.parse(fs.get("DOCUMENTS:Lid.meercad")!.data).params.n).toBe("5 mm");

    const listed = (await files.projects.list())[0]!;
    expect(listed.thumbnail).toBe("data:image/png;base64,AAAA");
    expect(await files.projects.sharedThumbnail!(p.id)).toEqual({
      thumbnail: "data:image/png;base64,AAAA",
      look: 7,
    });
    await files.projects.thumbnail({ id: p.id, thumbnail: "data:image/png;base64,BBBB", look: 7 });
    await files.projects.thumbnail({ id: p.id, thumbnail: "not a picture" });

    const folder = await files.folders.create({ parent: "", name: "Work" });
    expect(folder).toBe("Work");
    expect(await files.folders.create({ parent: "", name: "Work" })).toBe("Work 2");

    const moved = await files.projects.move({ id: p.id, folder: "Work" });
    expect(moved).toEqual({ id: "Work/Lid", name: "Lid", folder: "Work" });
    expect(await files.projects.move({ id: moved.id, folder: "Work" })).toEqual(moved);
    expect((await files.projects.list())[0]!.thumbnail).toBe("data:image/png;base64,BBBB");

    const renamed = await files.projects.rename({ id: moved.id, name: "Cover" });
    expect(renamed.id).toBe("Work/Cover");
    expect(await files.folders.rename({ folder: "Work", name: "Jobs" })).toBe("Jobs");
    await expect(files.folders.rename({ folder: "Jobs", name: "Work 2" })).rejects.toThrow(/already exists/);
    expect(await files.folders.rename({ folder: "Jobs", name: "Jobs" })).toBe("Jobs");
    expect((await files.projects.folders()).sort()).toEqual(["Jobs", "Work 2"]);
    expect((await files.projects.list()).map((x) => x.id)).toEqual(["Jobs/Cover"]);
    await files.projects.delete("Jobs/Cover");
    expect(await files.projects.list()).toEqual([]);
    await files.folders.delete("Jobs");
    expect(await files.projects.folders()).toEqual(["Work 2"]);
  });

  it("moves every project to iCloud and back, keeping one that is already there", async () => {
    localStorage.setItem("meercad.storage", "local");

    const n = await fresh();
    const files = n.nativeFiles!;
    await files.folders.create({ parent: "", name: "Work" });
    await files.projects.create({ name: "A", doc: docOf(1) });
    await files.projects.create({ name: "B", doc: docOf(2), folder: "Work" });
    fs.set(`${CLOUD}A.meercad`, { data: JSON.stringify(docOf(99)), mtime: 1, ctime: 1 });
    expect(await n.switchStorage("icloud")).toEqual({ moved: 1, skipped: 1 });
    expect(await n.storageKind()).toBe("icloud");
    expect(JSON.parse(fs.get(`${CLOUD}Work/B.meercad`)!.data).params.n).toBe("2 mm");
    expect(JSON.parse(fs.get(`${CLOUD}A.meercad`)!.data).params.n).toBe("99 mm");
    expect(await n.switchStorage("icloud")).toEqual({ moved: 0, skipped: 0 });
    // Back: B comes home, the A in iCloud stays as the A on the device is kept.
    expect(await n.switchStorage("local")).toEqual({ moved: 1, skipped: 1 });
    expect(JSON.parse(fs.get("DOCUMENTS:A.meercad")!.data).params.n).toBe("1 mm");
    expect(fs.has("DOCUMENTS:Work/B.meercad")).toBe(true);
    cloudOn = false;
    await expect(n.switchStorage("icloud")).rejects.toThrow(/iCloud Drive is not available/);
  });

  it("lists projects still only in iCloud and leaves the scans folder out", async () => {
    const n = await fresh();
    fs.set(`${CLOUD}.Remote.meercad.icloud`, { data: "", mtime: 1, ctime: 1 });
    fs.set(`${CLOUD}Here.meercad`, { data: JSON.stringify(docOf(1)), mtime: 2, ctime: 2 });
    dirs.add(`${CLOUD}Scans`);
    fs.set(`${CLOUD}Scans/room.meercad`, { data: "{}", mtime: 3, ctime: 3 });
    expect(await n.storageKind()).toBe("icloud");
    expect((await n.nativeFiles!.projects.list()).map((p) => p.id).sort()).toEqual(["Here", "Remote"]);

    // A change from another device tells the app to list the projects again.
    const seen = vi.fn();
    window.addEventListener("meercad:projects-changed", seen);
    for (const fn of listeners["change"] ?? []) (fn as () => void)();
    await new Promise((r) => setTimeout(r, 450));
    expect(seen).toHaveBeenCalled();
  });

  it("shares a file, shows a part in AR and opens a file from the Files app", async () => {
    localStorage.setItem("meercad.storage", "local");

    const n = await fresh();
    await n.shareFile("part.stl", new Uint8Array([1, 2, 3]));
    await n.shareFile("notes.txt", "hello");
    expect(shared).toHaveLength(2);
    expect(await n.arAvailable()).toBe(true);
    await n.showInAr("part.usdz", new Uint8Array([1]));

    const opened: unknown[] = [];
    n.onFileOpened((x) => opened.push(x));
    fs.set("file:///Inbox/Shared.meercad", { data: JSON.stringify(docOf(4)), mtime: 1, ctime: 1 });
    fs.set("DOCUMENTS:Mine.meercad", { data: "{}", mtime: 1, ctime: 1 });

    for (const fn of listeners["appUrlOpen"] ?? []) {
      fn({ url: "file:///Inbox/Shared.meercad" });
      fn({ url: "file:///DOCUMENTS:/Mine.meercad" });
      fn({ url: "file:///Inbox/picture.png" });
    }

    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toContainEqual({ name: "Shared", text: JSON.stringify(docOf(4)) });
  });
});
