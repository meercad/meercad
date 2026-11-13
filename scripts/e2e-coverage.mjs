#!/usr/bin/env node
// How much of the app's own code the E2E runs executed: merges what `E2E_COVERAGE=1 pnpm test:e2e`
// (and the iOS run, later) wrote to test-results/e2e-coverage, fetches each module's code from a
// fresh dev server's file on disk, and prints the share of code that ran, per folder and per file.
// The code is the dev server's transformed module (TypeScript without types), so the share is of
// characters that ran, a close stand-in for lines.
//
//   node scripts/e2e-coverage.mjs [--files]
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dir = join(root, "test-results/e2e-coverage");

if (!existsSync(dir)) {
  console.error("no coverage yet: run E2E_COVERAGE=1 pnpm test:e2e");
  process.exit(1);
}

/** Per source path: the source text and which of its characters ran in any run. */
const files = new Map();

for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const { devUrl, scripts } = JSON.parse(readFileSync(join(dir, f), "utf8"));

  for (const s of scripts) {
    const path = decodeURIComponent(new URL(s.url).pathname).replace(/^\/@fs/, "");
    const rel = path.startsWith(root) ? path.slice(root.length) : `apps/web${path}`;
    if (!/\.(tsx?|jsx?)$/.test(rel) || rel.includes("node_modules")) continue;

    // Block coverage: a function's ranges in order, inner ranges overriding outer ones.
    // The module's code without its inline source map (written by tests/e2e/app.ts).
    const len = s.codeLength ?? Math.max(...s.functions.flatMap((fn) => fn.ranges.map((r) => r.endOffset)));
    const ran = new Uint8Array(len);

    for (const fn of s.functions) {
      for (const r of fn.ranges) ran.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, len));
    }

    const old = files.get(rel);

    if (!old) {
      files.set(rel, { ran, len });
    } else {
      const n = new Uint8Array(Math.max(old.len, len));
      n.set(old.ran);
      for (let i = 0; i < len; i++) n[i] |= ran[i];
      files.set(rel, { ran: n, len: n.length });
    }
  }
}

const rows = [...files].map(([rel, { ran, len }]) => {
  let c = 0;
  for (const b of ran) c += b;

  return { rel, covered: c, total: len };
});
// Files of the app that never loaded count as not run at all.
const listAll = (d) =>
  readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? listAll(join(d, e.name))
      : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".test.ts")
        ? [join(d, e.name)]
        : [],
  );

for (const rel of [...listAll("apps/web/src"), ...listAll("packages/viewport/src")]) {
  if (!files.has(rel)) {
    rows.push({ rel, covered: 0, total: readFileSync(join(root, rel), "utf8").length, unloaded: true });
  }
}

const groups = new Map();

for (const r of rows) {
  const g = r.rel
    .split("/")
    .slice(0, r.rel.startsWith("apps/web/src/") ? 4 : 2)
    .join("/");
  const a = groups.get(g) ?? { covered: 0, total: 0 };
  a.covered += r.covered;
  a.total += r.total;
  groups.set(g, a);
}

const pct = (a) => ((100 * a.covered) / Math.max(1, a.total)).toFixed(1).padStart(5);
console.log("E2E coverage (share of each module's code that ran)\n");
for (const [g, a] of [...groups].sort()) console.log(`${pct(a)} %  ${g}`);

const all = rows.reduce((a, r) => ({ covered: a.covered + r.covered, total: a.total + r.total }), {
  covered: 0,
  total: 0,
});
console.log(`\n${pct(all)} %  all app code`);

if (process.argv.includes("--files")) {
  console.log("");

  for (const r of rows.sort((a, b) => a.covered / a.total - b.covered / b.total)) {
    console.log(`${pct(r)} %  ${r.rel}${r.unloaded ? "  (never loaded)" : ""}`);
  }
}

writeFileSync(
  join(root, "test-results/e2e-coverage.json"),
  JSON.stringify({ all, groups: Object.fromEntries(groups), files: rows }, null, 1),
);
