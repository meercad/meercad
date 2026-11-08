#!/usr/bin/env node
// Everything before a release, in order, with a summary at the end (docs/TESTING.md):
// licences, typecheck, all unit and integration tests, performance, the web build, and the
// end-to-end run in the WIP app (`pnpm test:e2e`). Stops at nothing: every step runs, so one
// run shows all that is wrong. Exit code 1 if any step failed or E2E is missing.
//
//   pnpm test:release              everything
//   pnpm test:release --skip e2e   leave out steps by name (comma-separated), e.g. on a machine without the app
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const scripts = JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts ?? {};
const skipArg = process.argv.indexOf("--skip");
const skip = new Set(skipArg >= 0 ? (process.argv[skipArg + 1] ?? "").split(",") : []);

const steps = [
  ["licences", "node", ["scripts/third-party-licenses.mjs", "--check"]],
  ["typecheck", "pnpm", ["typecheck"]],
  ["tests", "pnpm", ["test"]],
  ["perf", "pnpm", ["test:perf"]],
  ["build", "pnpm", ["build"]],
  ["e2e", "pnpm", ["test:e2e"]],
];

const results = [];
for (const [name, cmd, args] of steps) {
  if (skip.has(name)) {
    results.push([name, "skipped", 0]);
    continue;
  }
  if (name === "e2e" && !scripts["test:e2e"]) {
    results.push([name, "missing (no test:e2e script yet)", 0]);
    continue;
  }
  console.log(`\n=== ${name}: ${cmd} ${args.join(" ")}\n`);
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  results.push([name, r.status === 0 ? "ok" : `FAILED (exit ${r.status ?? r.signal})`, Date.now() - t]);
}

console.log("\n=== release check\n");
for (const [name, status, ms] of results) console.log(`${name.padEnd(10)} ${status.padEnd(36)} ${ms ? `${(ms / 1000).toFixed(0)} s` : ""}`);
const bad = results.filter(([, s]) => s !== "ok" && s !== "skipped");
console.log(bad.length ? `\nNot ready: ${bad.map(([n]) => n).join(", ")}` : "\nReady for a release.");
process.exit(bad.length ? 1 : 0);
