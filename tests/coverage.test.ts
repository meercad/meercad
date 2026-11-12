import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { SLOW } from "../vitest.config.js";

/**
 * Nothing the app can do goes without a test. Each feature op, document op and MCP tool must show
 * up in an automated test (or test model); MCP tools that only the end-to-end run checks are listed
 * below by name, so a new one is a decision and not an oversight (docs/TESTING.md).
 */

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function files(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === "node_modules") return [];
    if (statSync(p).isDirectory()) return files(p, keep);
    return keep(name) ? [p] : [];
  });
}

const testFiles = [
  ...files(join(root, "tests"), (n) => /\.(test|perf)\.ts$/.test(n) || n === "models.ts"),
  ...readdirSync(join(root, "packages")).flatMap((p) => files(join(root, "packages", p, "src"), (n) => n.endsWith(".test.ts"))),
].filter((p) => !p.endsWith("coverage.test.ts"));
const corpusFiles = files(join(root, "tests", "corpus"), (n) => n.endsWith(".json") || n.endsWith(".meercad"));
const tested = testFiles.map((p) => readFileSync(p, "utf8")).join("\n");
const corpus = corpusFiles.map((p) => readFileSync(p, "utf8")).join("\n");
// Test models may load real designs shipped with the app.
const shipped = files(join(root, "apps", "web", "src", "examples"), (n) => n.endsWith(".meercad")).map((p) => readFileSync(p, "utf8")).join("\n");

const types = read("packages/schema/src/types.ts");
const featureOps = [...new Set([...types.matchAll(/\bop: "([a-z_]+)"/g)].map((m) => m[1]!))].sort();
// The DocOp union runs from its declaration to the next blank line.
const docOpBlock = types.slice(types.indexOf("export type DocOp ="));
const docOps = [...new Set([...docOpBlock.slice(0, docOpBlock.indexOf("\n\n")).matchAll(/type: "([a-z_]+)"/g)].map((m) => m[1]!))].sort();
const mcpTools = [...read("packages/mcp/src/server.ts").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!).sort();

/**
 * MCP tools that run inside the app (mcpBridge) and are only checked by the end-to-end run against
 * the WIP app (`pnpm test:e2e`). Take a tool off this list once a unit or integration test calls it.
 */
const MCP_E2E_ONLY: string[] = [
  // Empty since Nov 2026: packages/mcp/src/server.inprocess.test.ts calls every tool against a
  // stand-in app. What the app does with a call is still checked by the E2E run.
];

describe("test coverage of what the app can do", () => {
  it("finds the lists it checks", () => {
    expect(featureOps.length).toBeGreaterThan(30);
    expect(docOps).toContain("add_features");
    expect(docOps).toContain("set_units");
    expect(mcpTools.length).toBeGreaterThan(30);
  });

  it("builds every feature op in a test, test model or corpus file", () => {
    const missing = featureOps.filter((op) => !new RegExp(`\\bop"?: ?"${op}"`).test(tested + corpus + shipped));
    expect(missing, "feature ops without any test").toEqual([]);
  });

  it("applies every document op in a test", () => {
    const missing = docOps.filter((op) => !new RegExp(`type: "${op}"`).test(tested));
    expect(missing, "document ops without a test").toEqual([]);
  });

  it("tests every MCP tool, or lists it as checked end to end", () => {
    const missing = mcpTools.filter((t) => !tested.includes(`"${t}"`) && !MCP_E2E_ONLY.includes(t));
    expect(missing, "MCP tools without a test: add one, or add the tool to MCP_E2E_ONLY and the E2E run").toEqual([]);
    // Keep the list honest: names that are gone or now have a test come off it.
    expect(MCP_E2E_ONLY.filter((t) => !mcpTools.includes(t)), "listed tools that no longer exist").toEqual([]);
    expect(MCP_E2E_ONLY.filter((t) => tested.includes(`"${t}"`)), "listed tools that now have a test").toEqual([]);
  });

  it("lists only existing files as slow", () => {
    for (const f of SLOW) expect(existsSync(join(root, f)), `${f} in SLOW does not exist`).toBe(true);
    const acceptance = files(join(root, "tests", "acceptance"), (n) => n.endsWith(".test.ts")).map((p) => relative(root, p));
    expect(acceptance.length).toBeGreaterThan(20);
  });
});
