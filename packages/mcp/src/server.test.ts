/**
 * The MCP server end to end, as an assistant uses it: the built server started over stdio, an MCP
 * client listing and calling its tools, and a stand-in for the meerCAD app on the bridge that
 * records what reaches it and answers. Checks that every tool is there and described, that
 * tools that need no app answer by themselves, that the rest reach the app with their arguments,
 * that local files are read and written on this computer, and that errors come back as errors.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { readStl, writeStl } from "@meercad/io";

const dir = mkdtempSync(join(tmpdir(), "meercad-mcp-test-"));
const port = 47900 + Math.floor(Math.random() * 40);
let client: Client;
let app: WebSocket | null = null;
const seen: { method: string; params: Record<string, unknown> }[] = [];
/** What the stand-in app answers per method (default: the method and its params back). */
const answers: Record<string, (p: Record<string, unknown>) => unknown> = {};

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };
const callTool = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connectApp(): Promise<void> {
  return new Promise((ok) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`);
    app = s;
    s.on("open", () => {
      s.send(JSON.stringify({ hello: "meercad", version: "test", project: "P" }));
      ok();
    });
    s.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.event || !m.id) return;
      seen.push({ method: m.method, params: m.params ?? {} });
      try {
        const result = answers[m.method]?.(m.params ?? {}) ?? { method: m.method, params: m.params };
        s.send(JSON.stringify({ id: m.id, result }));
      } catch (e) {
        s.send(JSON.stringify({ id: m.id, error: (e as Error).message }));
      }
    });
    s.on("error", () => undefined);
  });
}

beforeAll(async () => {
  const out = join(dir, "server.js");
  await build({
    entryPoints: [new URL("./server.ts", import.meta.url).pathname],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: out,
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "error",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [out],
    env: { ...(process.env as Record<string, string>), MEERCAD_MCP_PORT: String(port), MEERCAD_NO_LAUNCH: "1" },
    stderr: "ignore",
  });
  client = new Client({ name: "meercad-test", version: "1" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  app?.close();
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP server", () => {
  it("lists every tool with a title, a description and an input schema", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const want of ["get_guide", "get_model", "apply_ops", "preview_ops", "export", "measure", "render_view", "open_project", "new_project", "close_project", "gear_calc", "insert_sizes", "status", "undo", "redo"]) expect(names).toContain(want);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.description?.length, t.name).toBeGreaterThan(10);
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });

  it("answers the guide and gear and insert sizes without the app", async () => {
    const guide = textOf(await callTool("get_guide"));
    expect(guide).toMatch(/Ops \(type\): .*add_features/);
    expect(guide).toMatch(/Features \(op\): .*extrude/);
    expect(textOf(await callTool("get_guide", { schema: ["extrude"] }))).toContain("through_all");
    // Module 2, 20 teeth (DIN 867): pitch Ø 40, tip Ø 44, root Ø 35; with 40 teeth: centre distance 60, ratio 2.
    const gear = JSON.parse(textOf(await callTool("gear_calc", { module: 2, teeth: 20, teeth2: 40 })));
    expect(gear.gear).toMatchObject({ pitchDiameter: 40, outsideDiameter: 44, rootDiameter: 35 });
    expect(gear.mate).toMatchObject({ pitchDiameter: 80, outsideDiameter: 84, rootDiameter: 75 });
    expect(gear).toMatchObject({ centreDistance: 60, ratio: 2 });
    expect(textOf(await callTool("insert_sizes", { size: "M3" }))).toMatch(/M3/);
    expect(seen).toHaveLength(0);
  });

  it("says plainly when the app is not running, as an error", async () => {
    const r = await callTool("get_model");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/meerCAD/);
  });

  it("refuses arguments that do not fit the tool's schema", async () => {
    const r = await callTool("gear_calc", { module: -1, teeth: 2 });
    expect(r.isError).toBe(true);
  });

  it("passes calls to the app with their arguments and the project they name", async () => {
    await connectApp();
    await wait(300);
    const r = await callTool("get_model", { project: "P1", full: true });
    expect(r.isError).toBeFalsy();
    const got = seen.find((s) => s.method === "get_model")!;
    expect(got.params).toMatchObject({ full: true, project: "P1" });
    await callTool("apply_ops", { project: "P1", ops: [{ type: "set_param", name: "w", expr: "40 mm" }] });
    const ops = seen.find((s) => s.method === "apply_ops")!;
    expect(ops.params["ops"]).toEqual([{ type: "set_param", name: "w", expr: "40 mm" }]);
  });

  it("returns the app's errors as errors", async () => {
    answers["undo"] = () => {
      throw new Error("nothing to undo");
    };
    const r = await callTool("undo", { project: "P1" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/nothing to undo/);
  });

  it("reads a local STL for an import and sends its triangles to the app", async () => {
    const stl = join(dir, "tetra.stl");
    writeFileSync(stl, writeStl([{ positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) }]));
    seen.length = 0;
    await callTool("apply_ops", { project: "P1", ops: [{ type: "add_features", features: [{ id: "im1", op: "import", path: stl }] }] });
    const sent = (seen.find((s) => s.method === "apply_ops")!.params["ops"] as { features: Record<string, unknown>[] }[])[0]!.features[0]!;
    expect(sent).toMatchObject({ id: "im1", op: "import", format: "stl", fileName: "tetra.stl" });
    expect(sent["path"]).toBeUndefined();
    expect(readStl(Buffer.from(sent["data"] as string, "base64")).triangles).toBe(4);
    const bad = await callTool("apply_ops", { project: "P1", ops: [{ type: "add_features", features: [{ id: "im2", op: "import", path: join(dir, "x.dwg") }] }] });
    expect(bad.isError).toBe(true);
  });

  it("writes the files of an export where it was asked to, byte for byte", async () => {
    const bytes = Buffer.from("solid test\nendsolid test\n");
    answers["export"] = (p) => ({ files: { [`${p["name"]}.stl`]: bytes.toString("base64") } });
    const target = join(dir, "out", "part.stl");
    const r = await callTool("export", { project: "P1", format: "stl", path: target });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(target);
    expect(readFileSync(target).equals(bytes)).toBe(true);
    expect(seen.find((s) => s.method === "export")!.params).toMatchObject({ format: "stl", name: "part" });
  });
});
