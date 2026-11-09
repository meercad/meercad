/**
 * One-time carry-over from before the app was renamed (leocad → meerCAD): the old app's settings and
 * thumbnails, `.leocad` project files, and its entry in Claude Desktop's MCP configuration; and the
 * first start of a side-by-side build (RC, WIP) from its sibling.
 */
import { app } from "electron";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const LEGACY_EXT = ".leocad";
const oldUserData = () => join(app.getPath("appData"), "leocad");
const thumbName = (projectFile: string) => `${createHash("sha1").update(projectFile).digest("hex")}.png`;

/** Copies the old app's settings (projects folder) and thumbnails when this app has none yet. */
export async function carryOverAppData(settingsPath: string, thumbsDir: string): Promise<void> {
  const old = join(oldUserData(), "settings.json");
  if (existsSync(settingsPath) || !existsSync(old)) return;
  await mkdir(dirname(settingsPath), { recursive: true });
  await copyFile(old, settingsPath);
  const oldThumbs = join(oldUserData(), "thumbnails");
  if (existsSync(oldThumbs) && !existsSync(thumbsDir)) await cp(oldThumbs, thumbsDir, { recursive: true, preserveTimestamps: true });
}

/**
 * A projects folder still at the old default (~/Documents/leocad) moves to the new default, unless
 * that already exists; thumbnails (named after each file's path) move with it. A folder the user
 * picked themselves stays where it is. Returns the new folder, or null when nothing moved.
 */
export async function moveLegacyDefaultFolder(current: string | undefined, newDefault: string, thumbsDir: string): Promise<string | null> {
  const oldDefault = join(app.getPath("documents"), "leocad");
  if (!current || current !== oldDefault || !existsSync(oldDefault) || existsSync(newDefault)) return null;
  const files = await projectFilesBelow(oldDefault);
  await rename(oldDefault, newDefault);
  for (const rel of files) {
    const thumb = join(thumbsDir, thumbName(join(oldDefault, rel)));
    if (existsSync(thumb)) await rename(thumb, join(thumbsDir, thumbName(join(newDefault, rel)))).catch(() => undefined);
  }
  return newDefault;
}

async function projectFilesBelow(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const r = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...(await projectFilesBelow(root, r)));
    else if (entry.name.endsWith(".meercad") || entry.name.endsWith(LEGACY_EXT)) out.push(r);
  }
  return out;
}

/** Renames `.leocad` files below `root` to `.meercad`, keeping their thumbnails. Returns how many. */
export async function renameLegacyFiles(root: string, thumbsDir: string): Promise<number> {
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) n += await renameLegacyFiles(path, thumbsDir);
    else if (entry.name.endsWith(LEGACY_EXT)) {
      const next = `${path.slice(0, -LEGACY_EXT.length)}.meercad`;
      if (existsSync(next)) continue;
      await rename(path, next);
      const thumb = join(thumbsDir, thumbName(path));
      if (existsSync(thumb)) await rename(thumb, join(thumbsDir, thumbName(next))).catch(() => undefined);
      n++;
    }
  }
  return n;
}

/**
 * Claude Desktop still pointing at the old app (which no longer exists) gets the meerCAD entry
 * instead; a working custom setup is left alone. The previous file is kept as a .bak.
 */
export async function fixClaudeConfig(entry: { command: string; args: string[]; env?: Record<string, string> }): Promise<void> {
  const file = join(app.getPath("appData"), "Claude", "claude_desktop_config.json");
  if (!existsSync(file)) return;
  const raw = await readFile(file, "utf8");
  let config: { mcpServers?: Record<string, { command?: unknown }> };
  try {
    config = JSON.parse(raw) as typeof config;
  } catch {
    return;
  }
  const old = config.mcpServers?.["leocad"];
  if (!old || (typeof old.command === "string" && existsSync(old.command))) return;
  const servers = { ...config.mcpServers };
  delete servers["leocad"];
  servers["meercad"] ??= entry;
  await writeFile(`${file}.bak`, raw);
  await writeFile(file, `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`);
}

/**
 * First start of a side-by-side build (RC or WIP): copies settings (projects folder), thumbnails and
 * the window's local storage (preferences) from the first sibling build that has them, so switching
 * from one to the other loses nothing. Does nothing once this build has settings of its own.
 */
export async function adoptSiblingData(userData: string, siblings: string[]): Promise<string | null> {
  if (existsSync(join(userData, "settings.json"))) return null;
  const from = siblings.find((d) => existsSync(join(d, "settings.json")));
  if (!from) return null;
  await mkdir(userData, { recursive: true });
  // Pictures keep their dates: one older than its project file is made again (pictureState.ts).
  for (const part of ["thumbnails", "Local Storage"]) {
    if (existsSync(join(from, part)) && !existsSync(join(userData, part))) await cp(join(from, part), join(userData, part), { recursive: true, preserveTimestamps: true });
  }
  // Last: its presence marks the carry-over as done.
  await copyFile(join(from, "settings.json"), join(userData, "settings.json"));
  return from;
}
