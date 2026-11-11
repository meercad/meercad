#!/usr/bin/env node
/**
 * Builds meerCAD for this Mac and installs it to /Applications as one of two side-by-side builds:
 *
 *   meerCAD RC   the stable build the maintainer works with. Built from a clean main only, and
 *                only together with an upload (pnpm testflight + pnpm mas), see docs/RELEASE.md.
 *   meerCAD WIP  the working tree, to try changes in the real app; agents rebuild it at will.
 *
 * Each has its own app id (settings, window state, single-instance lock), its own app data and its
 * own MCP bridge port with its own entry in Claude's configuration ("meercad-rc" for the RC,
 * "meercad-wip" for the WIP, next to the store builds' "meercad" and "meercad-testflight";
 * `pnpm claude-config` adds both), so an assistant set up for one never
 * drives the other. Both work on the same projects folder (iCloud), never self-update and do not
 * claim .meercad files. On its first start a build takes over the other's projects folder,
 * thumbnails and preferences.
 *
 *   pnpm wip            build the working tree as meerCAD WIP, install and open it
 *   pnpm rc             build main as meerCAD RC, install and open it
 *   … --no-open         build and install only
 *   pnpm rc --force     allow a dirty tree or another branch (not for the real RC)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHANNELS = {
  rc: { appId: "app.meercad.rc", name: "meerCAD RC", icon: "build/icon.png", port: 47822 },
  wip: { appId: "app.meercad.wip", name: "meerCAD WIP", icon: "build/icon-wip.png", port: 47823 },
};
const channel = process.argv[2];
const c = CHANNELS[channel];
if (!c) {
  console.error(`usage: node scripts/install-mac.mjs <${Object.keys(CHANNELS).join("|")}> [--no-open] [--force]`);
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const target = `/Applications/${c.name}.app`;
const arch = process.arch === "arm64" ? "arm64" : "x64";

const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// Must match CHANNEL_PORTS in packages/mcp/src/protocol.ts.
const protocol = readFileSync(join(root, "packages/mcp/src/protocol.ts"), "utf8");
if (!new RegExp(`\\b${channel}: ${c.port}\\b`).test(protocol)) {
  console.error(`✗ port ${c.port} of ${c.name} is not the one in packages/mcp/src/protocol.ts (CHANNEL_PORTS)`);
  process.exit(1);
}

const dirty = git("status", "--porcelain") !== "";
if (channel === "rc" && !process.argv.includes("--force")) {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main" || dirty) {
    console.error(`✗ meerCAD RC is built from a clean main only (here: ${branch}${dirty ? ", uncommitted changes" : ""}). Use pnpm wip, or --force.`);
    process.exit(1);
  }
}

console.log("› building web app, MCP server and desktop shell");
run("pnpm", ["--filter", "@meercad/web", "build"]);
run("pnpm", ["--filter", "@meercad/mcp", "build"]);
run("node", ["build.mjs"], desktop);

const work = mkdtempSync(join(tmpdir(), `meercad-${channel}-`));
// The bundled MCP server reads its port from here (the app knows it from its channel).
const serverJson = join(work, "server.json");
writeFileSync(serverJson, `${JSON.stringify({ channel, port: c.port })}\n`);

// The release config with this build's identity on top.
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const sha = git("rev-parse", "--short", "HEAD") + (dirty ? "-dirty" : "");
const output = `release-${channel}`;
const config = {
  ...pkg.build,
  appId: c.appId,
  productName: c.name,
  directories: { ...pkg.build.directories, output },
  extraResources: [...pkg.build.extraResources, { from: serverJson, to: "mcp/server.json" }],
  mac: { ...pkg.build.mac, icon: c.icon, target: [{ target: "dir", arch: [arch] }] },
  extraMetadata: { productName: c.name, meercadChannel: channel, buildSha: sha },
};
delete config.fileAssociations;
delete config.dmg;
const configFile = join(work, "electron-builder.json");
writeFileSync(configFile, JSON.stringify(config, null, 2));

console.log(`› packaging ${c.name} (${arch}, ${sha})`);
run("pnpm", ["exec", "electron-builder", "--mac", "--dir", `--${arch}`, "--config", configFile, "--publish", "never"], desktop);

const outDir = join(desktop, output);
const built = readdirSync(outDir)
  .filter((d) => d.startsWith("mac"))
  .map((d) => join(outDir, d, `${c.name}.app`))
  .find((p) => existsSync(p));
if (!built) {
  console.error(`✗ no ${c.name}.app found in ${outDir}`);
  process.exit(1);
}

// Replace a running copy cleanly (it saves on quit); the other build keeps running. Only the app
// itself counts, not MCP servers started from its bundle (they keep running for their assistant).
spawnSync("osascript", ["-e", `tell application id "${c.appId}" to quit`], { stdio: "ignore" });
for (let i = 0; i < 50 && spawnSync("pgrep", ["-f", `^${target}/Contents/MacOS/${c.name}$`]).status === 0; i++) spawnSync("sleep", ["0.2"]);

console.log(`› installing to ${target}`);
run("rm", ["-rf", target]);
run("ditto", [built, target]);
spawnSync("xattr", ["-dr", "com.apple.quarantine", target], { stdio: "ignore" });
// Drop the build copy so Spotlight and launchers only find the installed app.
run("rm", ["-rf", outDir]);

if (!process.argv.includes("--no-open")) run("open", [target]);
console.log(`✓ ${c.name} ${sha} installed (MCP port ${c.port})`);
