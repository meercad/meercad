/**
 * Sending a model straight to a slicer installed on this Mac (Bambu Studio, PrusaSlicer): the 3MF is
 * written to a temporary folder of its own and opened with the slicer; folders older than an hour
 * are cleared away on the next send and when the app starts.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type SlicerId = "bambu" | "prusa";

export interface SlicerSpec {
  id: SlicerId;
  name: string;
  /** Where the app usually lies (PrusaSlicer's installer puts it into "Original Prusa Drivers"). */
  bundles: string[];
  /** The URL scheme the slicer claims: finds it wherever it lies. */
  scheme: string;
}

/** Bambu first: the printer most likely used with meerCAD. */
export const SLICERS: readonly SlicerSpec[] = [
  {
    id: "bambu",
    name: "Bambu Studio",
    bundles: ["BambuStudio.app", "Bambu Studio.app"],
    scheme: "bambustudioopen://",
  },
  {
    id: "prusa",
    name: "PrusaSlicer",
    bundles: ["PrusaSlicer.app", "Original Prusa Drivers/PrusaSlicer.app"],
    scheme: "prusaslicer://",
  },
];

/** The folders apps are installed in. */
export const appDirs = (home = homedir()) => ["/Applications", join(home, "Applications")];

/**
 * Where `spec` is installed: a known place, else the app that claims its URL scheme (asked with
 * `byScheme`, e.g. Electron's app.getApplicationInfoForProtocol) if it is that slicer; null if none.
 */
export async function findSlicer(
  spec: SlicerSpec,
  byScheme?: (url: string) => Promise<string | null>,
  dirs = appDirs(),
  exists: (path: string) => boolean = existsSync,
): Promise<string | null> {
  for (const dir of dirs) for (const b of spec.bundles) if (exists(join(dir, b))) return join(dir, b);

  const path = await byScheme?.(spec.scheme).catch(() => null);
  // Another slicer may claim the scheme too (forks of Bambu Studio do): only the slicer itself counts.
  const want = spec.bundles.map((b) => basename(b, ".app").replace(/\s+/g, "").toLowerCase());

  return path && want.includes(basename(path, ".app").replace(/\s+/g, "").toLowerCase()) ? path : null;
}

export const TEMP_PREFIX = "meercad-slicer-";
/** How long a sent file stays: the slicer reads it when it opens it, and may read it again soon after. */
export const KEEP_MS = 60 * 60 * 1000;

/** Removes the folders of files sent to a slicer more than `keepMs` ago. */
export async function clearOldSends(temp: string, now = Date.now(), keepMs = KEEP_MS): Promise<number> {
  let removed = 0;

  for (const name of await readdir(temp).catch(() => [] as string[])) {
    if (!name.startsWith(TEMP_PREFIX)) continue;

    const dir = join(temp, name);

    try {
      if (now - (await stat(dir)).mtimeMs < keepMs) continue;

      await rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // gone already, or not ours to remove
    }
  }

  return removed;
}

/** A file name without path separators or characters the Finder refuses. */
export const sendName = (name: string) => name.replace(/[\\/:*?"<>|\0]+/g, "-").trim() || "model.3mf";

/** Writes `data` as `name` into a fresh temporary folder; returns the file. */
export async function writeSend(temp: string, name: string, data: Uint8Array): Promise<string> {
  await clearOldSends(temp);

  const dir = await mkdtemp(join(temp, TEMP_PREFIX));
  const file = join(dir, sendName(name));
  await writeFile(file, data);

  return file;
}
