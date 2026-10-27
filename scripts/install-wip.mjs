#!/usr/bin/env node
/**
 * Builds the current working tree as "meerCAD WIP" and installs it to /Applications next to the
 * released meerCAD, so changes can be tried in the real desktop app before they are pushed.
 *
 * The WIP app has its own app id (separate settings, window state and single-instance lock), starts
 * on the release's projects folder, never self-updates and does not claim .meercad files.
 *
 *   pnpm wip            build, install and open
 *   pnpm wip --no-open  build and install only
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const APP_ID = "dev.meercad.app.wip";
const NAME = "meerCAD WIP";
const target = `/Applications/${NAME}.app`;
const arch = process.arch === "arm64" ? "arm64" : "x64";

const run = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

console.log("› building web app, MCP server and desktop shell");
run("pnpm", ["--filter", "@meercad/web", "build"]);
run("pnpm", ["--filter", "@meercad/mcp", "build"]);
run("node", ["build.mjs"], desktop);

// The release config with the WIP identity on top.
const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
const sha = git("rev-parse", "--short", "HEAD") + (git("status", "--porcelain") ? "-dirty" : "");
const config = {
  ...pkg.build,
  appId: APP_ID,
  productName: NAME,
  directories: { ...pkg.build.directories, output: "release-wip" },
  mac: { ...pkg.build.mac, icon: "build/icon-wip.png", target: [{ target: "dir", arch: [arch] }] },
  extraMetadata: { productName: NAME, meercadChannel: "wip", buildSha: sha },
};
delete config.fileAssociations;
delete config.dmg;
const configFile = join(mkdtempSync(join(tmpdir(), "meercad-wip-")), "electron-builder.json");
writeFileSync(configFile, JSON.stringify(config, null, 2));

console.log(`› packaging ${NAME} (${arch}, ${sha})`);
run("pnpm", ["exec", "electron-builder", "--mac", "--dir", `--${arch}`, "--config", configFile, "--publish", "never"], desktop);

const outDir = join(desktop, "release-wip");
const built = readdirSync(outDir)
  .filter((d) => d.startsWith("mac"))
  .map((d) => join(outDir, d, `${NAME}.app`))
  .find((p) => existsSync(p));
if (!built) {
  console.error(`✗ no ${NAME}.app found in ${outDir}`);
  process.exit(1);
}

// Replace a running copy cleanly.
spawnSync("osascript", ["-e", `tell application id "${APP_ID}" to quit`], { stdio: "ignore" });
for (let i = 0; i < 50 && spawnSync("pgrep", ["-f", `${NAME}.app/Contents/MacOS/`]).status === 0; i++) spawnSync("sleep", ["0.2"]);

console.log(`› installing to ${target}`);
run("rm", ["-rf", target]);
run("ditto", [built, target]);
spawnSync("xattr", ["-dr", "com.apple.quarantine", target], { stdio: "ignore" });

if (!process.argv.includes("--no-open")) run("open", [target]);
console.log(`✓ ${NAME} ${sha} installed`);
