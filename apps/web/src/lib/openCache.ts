/**
 * What a project looked like when it was last built, so it shows at once when opened again.
 *
 * Opening a design replays its whole feature history in the kernel and meshes every part; a big
 * design (threads, imported STEP parts, many fillets) takes seconds to minutes. The finished result
 * (report and meshes) is kept per project on this device, in IndexedDB, never in the file: it is
 * large (tens of MB for a big assembly) and can always be computed again. When a project opens and
 * its document is exactly the one the result was made from, the result is shown at once while the
 * kernel builds the real one in the background; that replaces it when done (same faces, same
 * picks). Anything that needs the kernel (editing, measuring, exporting) waits behind that rebuild
 * in the kernel's queue, as before.
 *
 * An entry is found by the project and used only for the same document, mesh settings and kernel
 * build (the worker script's URL carries a content hash in a built app). The least recently used
 * entries go once the cache is larger than its budget.
 */
import type { RebuildOutput } from "@meercad/kernel/client";
import type { MeercadDocument } from "@meercad/schema";

/** Raise when what is stored changes shape. */
const FORMAT = 1;
const DB_NAME = "meercad-open-cache";
const OUTPUTS = "outputs";
const META = "meta";
/** Touch devices (iPad, iPhone) get a smaller share of storage. */
const coarsePointer = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
let BUDGET = (coarsePointer ? 256 : 768) * 1024 * 1024;

/** For tests: another budget in bytes. */
export function setBudget(bytes: number): void {
  BUDGET = bytes;
}

/** How the meshes were made: the same document gives other triangles with other settings. */
export interface MeshOptions {
  /** The kernel build (the worker script's URL, which carries a content hash in a built app). */
  build: string;
  /** The kernel's `meshCoarse` (2 on touch devices). */
  coarse: number;
  /** Surface textures shown (a textured part's triangles differ). */
  textures: boolean;
}

interface Stored {
  key: string;
  output: RebuildOutput;
}
interface Meta {
  bytes: number;
  at: number;
}

/** 53-bit string hash (cyrb53): enough to tell documents apart, and quick on megabytes of JSON. */
export function hashText(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;

  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Identifies a build result: the document as a whole, the mesh settings and the kernel build. */
export function outputKey(doc: MeercadDocument, opts: MeshOptions): string {
  const text = JSON.stringify(doc);

  return `${FORMAT}|${opts.build}|${opts.coarse}|${opts.textures ? 1 : 0}|${text.length}|${hashText(text)}`;
}

/** Bytes an output takes (its typed arrays; the report is small next to them). */
export function outputBytes(o: RebuildOutput): number {
  let n = 0;

  for (const mesh of o.meshes) {
    n +=
      mesh.positions.byteLength +
      mesh.normals.byteLength +
      mesh.indices.byteLength +
      mesh.faceRanges.byteLength +
      mesh.edgeLines.byteLength +
      mesh.edgeRanges.byteLength;
  }

  for (const r of o.references) n += r.positions.byteLength + r.indices.byteLength;

  return n + 4096;
}

let opened: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  opened ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);

      req.onupgradeneeded = () => {
        req.result.createObjectStore(OUTPUTS);
        req.result.createObjectStore(META);
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      // No IndexedDB (private mode, tests): every project builds as before.
      resolve(null);
    }
  });

  return opened;
}

const done = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
const result = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Results last written per project in this window, so the same one is not written again. */
const written = new Map<string, string>();

/** The kept result for `project`, if it was made from exactly `key`. */
export async function readOutput(project: string, key: string): Promise<RebuildOutput | null> {
  const database = await db();
  if (!database) return null;

  try {
    const transaction = database.transaction([OUTPUTS, META], "readwrite");
    const stored = (await result(transaction.objectStore(OUTPUTS).get(project))) as Stored | undefined;

    if (!stored || stored.key !== key) {
      // Whatever this window wrote is gone or outdated (storage cleared, another window): write again.
      written.delete(project);

      return null;
    }

    const meta = (await result(transaction.objectStore(META).get(project))) as Meta | undefined;
    transaction
      .objectStore(META)
      .put({ bytes: meta?.bytes ?? outputBytes(stored.output), at: Date.now() } satisfies Meta, project);

    return stored.output;
  } catch {
    return null;
  }
}

/** Keeps `output` (built from `key`) as the project's result, making room by dropping the oldest. */
export async function writeOutput(project: string, key: string, output: RebuildOutput): Promise<void> {
  if (written.get(project) === key) return;

  const bytes = outputBytes(output);
  if (bytes > BUDGET / 2) return;

  const database = await db();
  if (!database) return;

  try {
    const metaTx = database.transaction(META, "readonly");
    const all = new Map<string, Meta>();
    const keys = (await result(metaTx.objectStore(META).getAllKeys())) as string[];
    const metas = (await result(metaTx.objectStore(META).getAll())) as Meta[];
    keys.forEach((k, i) => all.set(k, metas[i]!));
    all.delete(project);

    let total = bytes + [...all.values()].reduce((n, m) => n + m.bytes, 0);
    const drop: string[] = [];

    for (const [k, m] of [...all].sort((a, b) => a[1].at - b[1].at)) {
      if (total <= BUDGET) break;

      drop.push(k);
      total -= m.bytes;
    }

    const transaction = database.transaction([OUTPUTS, META], "readwrite");

    for (const k of drop) {
      transaction.objectStore(OUTPUTS).delete(k);
      transaction.objectStore(META).delete(k);
    }

    transaction.objectStore(OUTPUTS).put({ key, output } satisfies Stored, project);
    transaction.objectStore(META).put({ bytes, at: Date.now() } satisfies Meta, project);
    await done(transaction);
    written.set(project, key);
  } catch {
    // Out of space or storage cleared: the project simply builds when opened.
  }
}

/** Forgets a project's result (it was deleted). */
export async function dropOutput(project: string): Promise<void> {
  written.delete(project);

  const database = await db();
  if (!database) return;

  try {
    const transaction = database.transaction([OUTPUTS, META], "readwrite");
    transaction.objectStore(OUTPUTS).delete(project);
    transaction.objectStore(META).delete(project);
    await done(transaction);
  } catch {
    // Left for the budget to remove.
  }
}
