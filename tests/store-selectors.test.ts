import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A store hook re-renders whenever its selector returns something new. A selector that builds a
 * fresh array or object on every call (`s.doc.mechanism?.motions ?? []`) never settles: React
 * renders again and again until it gives up ("Maximum update depth exceeded") and the interface
 * goes white. That happened with the joints panel of a design with joints but no motions.
 * Fallbacks belong outside the selector (`useApp((s) => s.x) ?? []`) or in a shared constant.
 */

const root = join(import.meta.dirname, "..", "apps", "web", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [p] : [];
  });
}

/** The selector bodies of every `useX((s) => …)` call: the text between the arrow and its closing parenthesis. */
function selectors(code: string): { line: number; body: string }[] {
  const found: { line: number; body: string }[] = [];
  const start = /\buse[A-Z]\w*\(\s*\(?\s*(\w+)\s*\)?\s*=>/g;
  for (let m = start.exec(code); m; m = start.exec(code)) {
    // Walk to the parenthesis that closes the hook call.
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    for (; i < code.length && depth > 0; i++) {
      const ch = code[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
    }
    found.push({ line: code.slice(0, m.index).split("\n").length, body: code.slice(from, i - 1) });
  }
  return found;
}

/** What makes a new value on every call. */
const FRESH = [/\?\?\s*\[\s*\]/, /\?\?\s*\{\s*\}/, /\|\|\s*\[\s*\]/, /\|\|\s*\{\s*\}/, /\.(map|filter|flatMap|slice|concat)\(/, /\bnew\s+[A-Z]/, /Object\.(keys|values|entries|fromEntries)\(/];

describe("store selectors", () => {
  it("finds a fallback array built inside a selector", () => {
    const bad = selectors("const motions = useApp((s) => s.doc.mechanism?.motions ?? []);");
    expect(bad).toHaveLength(1);
    expect(FRESH.some((r) => r.test(bad[0]!.body))).toBe(true);
    const good = selectors("const versions = useApp((s) => s.doc.versions) ?? [];");
    expect(FRESH.some((r) => r.test(good[0]!.body))).toBe(false);
  });

  it("never build a new array or object on every call", () => {
    const offenders: string[] = [];
    for (const file of sources(root)) {
      const code = readFileSync(file, "utf8");
      for (const { line, body } of selectors(code))
        if (!/useShallow/.test(body) && FRESH.some((r) => r.test(body))) offenders.push(`${relative(root, file)}:${line}  ${body.trim().replace(/\s+/g, " ").slice(0, 120)}`);
    }
    expect(offenders).toEqual([]);
  });
});
