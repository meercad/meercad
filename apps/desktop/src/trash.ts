/**
 * Moving project files and folders to the Trash. The system call (shell.trashItem) refuses files in
 * iCloud Drive that another app wrote (they carry its com.apple.provenance, e.g. parts synced from the
 * iPhone/iPad or written by another meerCAD build) with "you don't have the required permission";
 * moving them into iCloud Drive's Trash folder ourselves works.
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
 * Moves `path` to the Trash with `trashItem`; when the system refuses, moves the item into the Trash
 * folder itself. Throws the system's error when that fails too (the App Store build cannot reach the
 * Trash folder), so the caller still reports it.
 */
export async function moveToTrash(path: string, trashItem: (path: string) => Promise<void>, home?: string): Promise<void> {
  try {
    await trashItem(path);
  } catch (e) {
    if (!existsSync(path)) return; // gone after all
    try {
      const dir = trashDirFor(path, home);
      await mkdir(dir, { recursive: true });
      await rename(path, freeName(dir, basename(path)));
    } catch {
      throw e;
    }
  }
}
