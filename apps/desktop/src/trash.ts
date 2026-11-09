/**
 * Moving project files and folders to the Trash. The system call (shell.trashItem) sometimes refuses
 * an item in iCloud Drive with "you don't have the required permission" while the file is fine, for
 * example while iCloud is still busy with it during a delete of many parts. The same item can be
 * trashed a moment later, or moved into the Trash folder directly.
 */
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, sep } from "node:path";

/** The Trash folder an item belongs in: iCloud Drive keeps its own, everything else the user's. */
export function trashDirFor(path: string, home = homedir()): string {
  const mobile = join(home, "Library", "Mobile Documents");
  const rel = relative(mobile, path);
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? join(mobile, ".Trash") : join(home, ".Trash");
}

/** A free name in `dir` for `name`, numbered like the Finder does ("Part 2.meercad"). */
export function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; existsSync(join(dir, candidate)); n++) candidate = `${stem} ${n}${ext}`;
  return join(dir, candidate);
}

/**
 * Moves `path` to the Trash with `trashItem`; when that fails, tries again after a short wait and
 * then moves the item into the Trash folder itself. Throws the system's error when all of that fails
 * (the App Store build cannot reach the Trash folder), so the caller still reports it.
 */
export async function moveToTrash(
  path: string,
  trashItem: (path: string) => Promise<void>,
  opts: { retries?: number; waitMs?: number; home?: string } = {},
): Promise<void> {
  const { retries = 2, waitMs = 400, home } = opts;
  let first: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await trashItem(path);
      return;
    } catch (e) {
      first ??= e;
      if (!existsSync(path)) return; // gone after all
      if (attempt < retries) await new Promise((r) => setTimeout(r, waitMs * (attempt + 1)));
    }
  }
  try {
    const dir = trashDirFor(path, home);
    await mkdir(dir, { recursive: true });
    await rename(path, freeName(dir, basename(path)));
  } catch {
    throw first;
  }
}
