/**
 * Every text the web app passes to t() or tn() has a German translation with the same placeholders,
 * and the dictionaries agree where they overlap.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DE, DE_PARTS } from "../apps/web/src/lib/i18n/de";

const SRC = join(__dirname, "../apps/web/src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "i18n" ? [] : files(p);
    if (n === "i18n.ts") return [];
    return /\.tsx?$/.test(n) ? [p] : [];
  });
}

/** A string literal: "…", '…' or `…` without ${}. */
const LIT = String.raw`("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\`(?:[^\`\\$]|\\.)*\`)`;
const unquote = (q: string) => JSON.parse(q[0] === '"' ? q : `"${q.slice(1, -1).replace(/\\(['`])/g, "$1").replace(/"/g, '\\"')}"`) as string;

function used(): Map<string, string> {
  const out = new Map<string, string>();
  const one = new RegExp(String.raw`\bt\(\s*` + LIT, "g");
  const many = new RegExp(String.raw`\btn\([^,]+,\s*` + LIT + String.raw`\s*,\s*` + LIT, "g");
  for (const f of files(SRC)) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(one)) out.set(unquote(m[1]!), f);
    for (const m of s.matchAll(many)) {
      out.set(unquote(m[1]!), f);
      out.set(unquote(m[2]!), f);
    }
  }
  return out;
}

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("German interface", () => {
  it("translates every text", () => {
    const missing = [...used()].filter(([s]) => !(s in DE)).map(([s, f]) => `${f.slice(SRC.length + 1)}: ${s}`);
    expect(missing).toEqual([]);
  });

  it("keeps the placeholders", () => {
    const wrong = Object.entries(DE).filter(([en, de]) => holes(en).join() !== holes(de).join());
    expect(wrong).toEqual([]);
  });

  it("translates a text the same way everywhere", () => {
    const seen = new Map<string, string>();
    const clash: string[] = [];
    for (const [part, dict] of Object.entries(DE_PARTS))
      for (const [en, de] of Object.entries(dict)) {
        const before = seen.get(en);
        if (before !== undefined && before !== de) clash.push(`${part}: ${en} → ${de} / ${before}`);
        seen.set(en, de);
      }
    expect(clash).toEqual([]);
  });
});
