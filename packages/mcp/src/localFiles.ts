/**
 * Files on the user's computer, read and written by this server. On macOS a process needs the user's
 * OK for Documents, Desktop, Downloads and iCloud Drive; until it has it, opening a file there does
 * not fail but waits (for a prompt the user may never see, since this server runs in the
 * background). The MCP client gives up on a call after 60 s and drops the server, so a file that does
 * not open within a few seconds is handed to the meerCAD app instead, which usually has that access
 * (it is the app the user works with), and a clear error comes back when neither can reach it.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";

/** What the app does for us when this server cannot reach a file. */
export interface AppFiles {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
}

/** How long this server waits for a file before it asks the app. */
export const LOCAL_WAIT_MS = 5000;

/** `~` expanded, relative paths from the working directory. */
export const localPath = (path: string) => resolve(path.replace(/^~(?=\/|$)/, homedir()));

/**
 * Folders this server waited on in vain: the next files there go to the app at once (each wait
 * holds one of Node's few file threads until the user answers, so they must not pile up).
 */
const blocked = new Set<string>();
/** The folders macOS guards (and the file's own folder elsewhere): one wait there blocks them all. */
const guarded = () => ["Documents", "Desktop", "Downloads", "Library/Mobile Documents"].map((d) => resolve(homedir(), d));
const guardOf = (file: string) => guarded().find((d) => file.startsWith(d + sep)) ?? dirname(file);
const isBlocked = (path: string) => [...blocked].some((d) => path === d || path.startsWith(d + sep));

type Outcome<T> = { ok: T } | { error: NodeJS.ErrnoException } | null;

/** The result of `p`, or null when it takes longer than `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  try {
    return await Promise.race([p.then((ok) => ({ ok }), (error: NodeJS.ErrnoException) => ({ error })), late]);
  } finally {
    clearTimeout(timer);
  }
}

const denied = (e: NodeJS.ErrnoException) => e.code === "EPERM" || e.code === "EACCES";

const noAccess = (path: string, why: string) =>
  new Error(
    `cannot reach "${path}": macOS has not given meerCAD access to this folder yet (Documents, Desktop, Downloads and iCloud Drive need the user's OK: a prompt, or System Settings › Privacy & Security › Files and Folders), and the app could not either (${why}). Ask the user to allow it, or use a file in another folder.`,
  );

async function viaApp<T>(path: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw noAccess(path, e instanceof Error ? e.message : String(e));
  }
}

/** Reads a file, through the app when this server may not open it. */
export async function readLocal(path: string, app: AppFiles, waitMs = LOCAL_WAIT_MS): Promise<Buffer> {
  const file = localPath(path);
  if (!isBlocked(file)) {
    const r = await within(readFile(file), waitMs);
    if (r && "ok" in r) return r.ok;
    if (r && !denied(r.error)) throw new Error(`cannot read the file "${file}" (${r.error.code ?? r.error.message})`);
    if (!r) blocked.add(guardOf(file));
  }
  return Buffer.from(await viaApp(file, () => app.read(file)));
}

/** Writes a file (and its folder), through the app when this server may not write there. */
export async function writeLocal(path: string, data: Uint8Array, app: AppFiles, waitMs = LOCAL_WAIT_MS): Promise<string> {
  const file = localPath(path);
  if (!isBlocked(file)) {
    const r = await within(
      mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, data)),
      waitMs,
    );
    if (r && "ok" in r) return file;
    if (r && !denied(r.error)) throw new Error(`cannot write the file "${file}" (${r.error.code ?? r.error.message})`);
    if (!r) blocked.add(guardOf(file));
  }
  await viaApp(file, () => app.write(file, data));
  return file;
}

/** Forgets the folders waited on (tests). */
export const resetBlocked = () => blocked.clear();
