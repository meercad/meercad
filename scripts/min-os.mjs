/**
 * Checks a built app bundle against the oldest system it is meant to run on: every Mach-O file in it
 * (the app, its frameworks, native helpers) must be built for that system or an older one. A framework
 * or helper built for a newer system will not load there, and the app ends at launch or later.
 *
 * Used by pnpm testflight (iOS) and pnpm mas (macOS) before the upload.
 */
import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Mach-O and universal-binary magic numbers, as the first four bytes read big-endian. */
const MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

/** "18.0" < "18.10": compares dotted versions number by number; negative when a is older. */
export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);

  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }

  return 0;
}

/** The minimum system versions in `vtool -show-build` output (one per architecture), or [] if none. */
export function parseMinos(text) {
  return [...text.matchAll(/^\s*minos\s+([\d.]+)/gm)].map((m) => m[1]);
}

/** Mach-O files under `dir` (symbolic links are not followed). */
export function machOFiles(dir) {
  const out = [];
  const head = Buffer.alloc(4);

  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;

    if (e.isDirectory()) {
      out.push(...machOFiles(p));
      continue;
    }

    if (!e.isFile() || lstatSync(p).size < 4) continue;

    const fd = openSync(p, "r");
    readSync(fd, head, 0, 4, 0);
    closeSync(fd);
    if (MAGIC.has(head.readUInt32BE(0))) out.push(p);
  }

  return out;
}

/**
 * The Mach-O files in `bundle` built for a system newer than `minimum`, with the version each needs.
 * Files without a build version (old object formats) are left out.
 */
export function newerThan(bundle, minimum) {
  const found = [];

  for (const file of machOFiles(bundle)) {
    const r = spawnSync("xcrun", ["vtool", "-show-build", file], { encoding: "utf8" });
    const versions = parseMinos(r.stdout ?? "");
    const newest = versions.sort(compareVersions).at(-1);

    if (newest && compareVersions(newest, minimum) > 0) {
      found.push({ file: relative(bundle, file), minos: newest });
    }
  }

  return found;
}

/**
 * Stops the script (exit 1) when anything in `bundle` needs a system newer than `minimum`. `allowed`
 * names helpers the app starts as processes of their own and only where they run (path in the bundle →
 * the newest system version they may need); the app itself never loads them.
 */
export function assertMinOs(bundle, minimum, system, allowed = {}) {
  const files = machOFiles(bundle);

  if (!files.length) {
    console.error(`✗ no Mach-O files in ${bundle}`);
    process.exit(1);
  }

  const newer = newerThan(bundle, minimum).filter(
    (x) => !(x.file in allowed && compareVersions(x.minos, allowed[x.file]) <= 0),
  );

  if (newer.length) {
    console.error(`✗ built for a system newer than ${system} ${minimum}, would not run there:`);
    for (const x of newer) console.error(`    ${x.file} (needs ${system} ${x.minos})`);
    process.exit(1);
  }

  console.log(`✓ all ${files.length} binaries run on ${system} ${minimum}`);
}
