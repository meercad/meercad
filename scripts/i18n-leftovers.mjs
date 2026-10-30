#!/usr/bin/env node
/**
 * Lists English interface texts in the web app that do not go through t() yet: JSX text, common
 * text attributes and toast()/label fields with a plain string. A rough net, not a parser: it
 * flags a few false positives (CSS classes never, but e.g. key names) and misses texts built in
 * other ways. Usage: node scripts/i18n-leftovers.mjs [files…] (default: all of apps/web/src).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === "i18n" ? [] : walk(join(d, n))) : /\.tsx?$/.test(n) ? [join(d, n)] : []));
const targets = process.argv.length > 2 ? process.argv.slice(2).map((f) => join(process.cwd(), f)) : walk(join(root, "apps/web/src"));

const words = /[A-Za-z]{2,}.*\s.*[A-Za-z]|^[A-Z][a-z]{2,}/;
const checks = [
  // >Some text< in JSX
  [/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g, (m) => m[1].trim()],
  // title="…", placeholder="…", aria-label="…", alt="…", label="…"
  [/\b(?:title|placeholder|aria-label|alt|label|hint|confirmLabel|cancelLabel)=\s*"([^"]+)"/g, (m) => m[1]],
  // label: "…", hint: "…", title: "…", message: "…", name: "…", help: "…"
  [/\b(?:label|hint|title|message|help|desc|description|tip|placeholder|confirmLabel|cancelLabel|text|empty)\s*:\s*"([^"]*[A-Za-z][^"]*)"/g, (m) => m[1]],
  // toast("…") / toast(`…`)
  [/\btoast\(\s*["`]([^"`]+)["`]/g, (m) => m[1]],
  // throw new Error("…") shown to the user
  [/new Error\(\s*["`]([^"`]+)["`]/g, (m) => m[1]],
];

let total = 0;
for (const f of targets) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line) || /\bimport\b/.test(line)) return;
    for (const [re, get] of checks)
      for (const m of line.matchAll(re)) {
        const s = get(m);
        if (!s || !words.test(s) || /^[\w.-]+$/.test(s) && !/^[A-Z][a-z]/.test(s)) continue;
        // Already translated on this line.
        const before = line.slice(Math.max(0, m.index - 4), m.index + 4);
        if (/\bt\(|tn\(/.test(before)) continue;
        total++;
        console.log(`${relative(root, f)}:${i + 1}: ${s}`);
      }
  });
}
console.error(`${total} possible untranslated text(s)`);
