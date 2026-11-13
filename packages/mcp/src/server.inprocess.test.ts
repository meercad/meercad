/**
 * The MCP server in this process (so the coverage run counts it), as an assistant uses it: an MCP
 * client over an in-memory transport, and a stand-in for the meerCAD app on the bridge that records
 * what reaches it and answers. Every tool is called; what a tool does on this computer (reading the
 * files an import names, writing the files of an export, staged exports piece by piece) is checked
 * byte for byte. server.test.ts starts the built server over stdio as a separate process.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSocket } from "ws";
import { readStl, write3mf, writeObj, writeStl } from "@meercad/io";

let stale = false;
vi.mock("./staleServer.js", async (orig) => ({
  ...(await orig<typeof import("./staleServer.js")>()),
  staleCheck: () => () => stale,
}));

const dir = mkdtempSync(join(tmpdir(), "meercad-mcp-inproc-"));
const port = 47940 + Math.floor(Math.random() * 40);
let client: Client;
let mod: typeof import("./server.js");
let app: WebSocket | null = null;
const seen: { method: string; params: Record<string, unknown> }[] = [];
/** What the stand-in app answers per method (default: the method and its params back). */
const answers: Record<string, (p: Record<string, unknown>) => unknown> = {};

type Content = { type: string; text?: string; data?: string; mimeType?: string };
type ToolResult = { content: Content[]; isError?: boolean };

const callTool = async (name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;
const textOf = (r: ToolResult) =>
  r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const last = (method: string) => [...seen].reverse().find((s) => s.method === method);
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const PNG = b64("png-bytes");

function connectApp(): Promise<void> {
  return new Promise((ok) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`);
    app = s;
    s.on("open", () => {
      s.send(JSON.stringify({ hello: "meercad", version: "test", project: "P" }));
      ok();
    });
    s.on("message", async (raw) => {
      const m = JSON.parse(String(raw));
      if (m.event || !m.id) return;

      seen.push({ method: m.method, params: m.params ?? {} });

      try {
        const result = (await answers[m.method]?.(m.params ?? {})) ?? { method: m.method, params: m.params };
        s.send(JSON.stringify({ id: m.id, result }));
      } catch (e) {
        s.send(JSON.stringify({ id: m.id, error: (e as Error).message }));
      }
    });
    s.on("error", () => undefined);
  });
}

beforeAll(async () => {
  vi.stubEnv("MEERCAD_MCP_INPROCESS", "1");
  vi.stubEnv("MEERCAD_MCP_PORT", String(port));
  vi.stubEnv("MEERCAD_NO_LAUNCH", "1");
  vi.stubEnv("MEERCAD_MCP_ANSWER_MS", "1500");
  mod = await import("./server.js");
  // The bridge first finds out whether another server holds the port.
  while (mod.bridge.role === "starting") await wait(20);

  const [a, b] = InMemoryTransport.createLinkedPair();
  await mod.server.connect(b);
  client = new Client({ name: "meercad-inproc", version: "1" });
  await client.connect(a);
}, 60_000);

afterAll(async () => {
  app?.close();
  await client?.close();
  await mod?.bridge.stop();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP server in process", () => {
  it("says the app is not there, and that the status shows where it listens", async () => {
    const r = await callTool("get_model", { project: "P1" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not connected/);

    const st = JSON.parse(textOf(await callTool("status")));
    expect(st.connected).toBe(false);
    expect(st.hint).toContain(`ws://127.0.0.1:${port}`);
  });

  it("answers the guide, a schema, gear sizes and inserts by itself", async () => {
    expect(textOf(await callTool("get_guide"))).toMatch(/Ops \(type\): /);
    expect(textOf(await callTool("get_guide", { schema: ["extrude"] }))).toContain("through_all");
    expect(JSON.parse(textOf(await callTool("gear_calc", { module: 2, teeth: 20 }))).gear.pitchDiameter).toBe(
      40,
    );
    expect(textOf(await callTool("insert_sizes", {}))).toMatch(/M3/);
  });

  it("passes every tool's call to the app with its arguments and project", async () => {
    await connectApp();
    await wait(300);

    const calls: [
      tool: string,
      args: Record<string, unknown>,
      method: string,
      sent?: Record<string, unknown>,
    ][] = [
      ["get_model", { full: true }, "get_model", { full: true }],
      ["get_sketch", { id: "sk1" }, "get_sketch", { id: "sk1" }],
      ["clear_preview", {}, "clear_preview"],
      ["undo", {}, "undo"],
      ["redo", {}, "redo"],
      ["list_projects", {}, "list_projects"],
      ["open_project", { id: "p9" }, "open_project", { id: "p9" }],
      ["open_project", { id: "p9", takeover: true }, "open_project", { id: "p9", takeover: true }],
      ["close_project", {}, "close_project"],
      ["new_project", { name: "N" }, "new_project", { name: "N" }],
      ["set_view", { view: "top" }, "set_view", { view: "top" }],
      ["send_to_slicer", { slicer: "prusa" }, "send_to_slicer", { slicer: "prusa" }],
      ["list_materials", {}, "list_materials"],
      ["measure", { a: { face: "ex1.end_cap" } }, "measure", { a: { face: "ex1.end_cap" } }],
      ["set_pose", { values: { j1: 30 } }, "set_pose", { values: { j1: 30 } }],
      ["check_clearance", {}, "check_clearance"],
      ["check_motion", { joint: "j1", steps: 4 }, "check_motion", { joint: "j1", steps: 4 }],
      ["play_motion", { motion: null }, "play_motion", { motion: null }],
      ["get_version", { name: "v1" }, "get_version", { name: "v1" }],
      ["check_interference", { seconds: 5 }, "check_interference", { seconds: 5 }],
      ["wall_thickness", { part: "ex1" }, "wall_thickness", { part: "ex1" }],
      ["print_check", { part: "ex1", turn: "best" }, "print_check", { part: "ex1", turn: "best" }],
      ["deviation", { part: "ex1", mesh: "im1" }, "deviation", { part: "ex1", mesh: "im1" }],
      ["repair_mesh", { part: "im1", reduce: 0.05 }, "repair_mesh", { part: "im1", reduce: 0.05 }],
      ["rebuild_mesh", { part: "im1" }, "rebuild_mesh", { part: "im1" }],
      ["measure_scan", { part: "im1", point: [0, 0, 0] }, "measure_scan", { part: "im1", point: [0, 0, 0] }],
      ["joints_from_gears", {}, "joints_from_gears"],
      ["set_visibility", { only: ["ex1"] }, "set_visibility", { only: ["ex1"] }],
      ["rename_project", { name: "R" }, "rename_project", { name: "R" }],
      ["list_folders", {}, "list_folders"],
      ["create_folder", { name: "F" }, "create_folder", { name: "F" }],
      ["move_project", { folder: "F" }, "move_project", { folder: "F" }],
      ["list_examples", {}, "list_examples"],
      ["open_example", { id: 3 }, "open_example", { id: 3 }],
      ["terrain_height", { points: [[1, 2]] }, "terrain_height", { points: [[1, 2]] }],
      ["place_on_terrain", { part: "ex1", offset: 1 }, "place_on_terrain", { part: "ex1", offset: 1 }],
      ["photo_terrain", { folder: dir }, "photo_terrain", { folder: dir }],
    ];

    for (const [tool, args, method, sent] of calls) {
      seen.length = 0;

      const r = await callTool(tool, { ...args, project: "P1" });
      expect(r.isError, `${tool}: ${textOf(r)}`).toBeFalsy();

      const got = last(method);
      expect(got, tool).toBeDefined();
      if (sent) expect(got!.params, tool).toMatchObject(sent);
    }

    // Tools that act on a project send it along; lookups do not.
    seen.length = 0;
    await callTool("undo", { project: "P7" });
    expect(last("undo")!.params["project"]).toBe("P7");
    await callTool("list_projects", {});
    expect(last("list_projects")!.params["project"]).toBeUndefined();
  });

  it("shows the connected app's status, or what it said when it said hello", async () => {
    answers["get_status"] = () => ({ project: "P1", tab: "own" });
    expect(JSON.parse(textOf(await callTool("status")))).toEqual({
      connected: true,
      project: "P1",
      tab: "own",
    });

    answers["get_status"] = () => {
      throw new Error("old app");
    };

    expect(JSON.parse(textOf(await callTool("status")))).toMatchObject({
      connected: true,
      hello: "meercad",
      project: "P",
    });
    delete answers["get_status"];
  });

  it("returns pictures, and writes them where it is asked to", async () => {
    answers["render_view"] = () => ({ png: PNG });

    const plain = await callTool("render_view", { view: "iso" });
    expect(plain.content).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }]);

    const file = join(dir, "pics", "a.png");
    const saved = await callTool("render_view", { view: "top", path: file, width: 640 });
    expect(textOf(saved)).toBe(`wrote ${file}`);
    expect(readFileSync(file).toString()).toBe("png-bytes");
    expect(last("render_view")!.params).toMatchObject({ view: "top", width: 640 });
    expect(last("render_view")!.params["path"]).toBeUndefined();

    answers["render_motion"] = (p) => ({
      png: PNG,
      frames: [0, 90],
      ...(p["video"] ? { gif: b64("GIF89a") } : {}),
    });

    const sheet = await callTool("render_motion", { joint: "j1" });
    expect(sheet.content[0]).toMatchObject({ type: "image", data: PNG });
    expect(JSON.parse(textOf(sheet))).toEqual({ frames: [0, 90] });

    const gif = join(dir, "m.gif");
    const video = await callTool("render_motion", { joint: "j1", video: { path: gif, frames: 8 } });
    expect(textOf(video)).toContain(`wrote a 6 byte GIF to ${gif}`);
    expect(readFileSync(gif).toString()).toBe("GIF89a");
    expect(last("render_motion")!.params["video"]).toEqual({ frames: 8 });

    answers["drawing"] = () => ({
      file: b64("%PDF-1.7"),
      png: PNG,
      scale: "1:2",
      paper: "A4",
      views: ["front"],
      parts: [],
    });

    const sheetOnly = await callTool("export_drawing", { views: ["front"] });
    expect(JSON.parse(textOf(sheetOnly))).toEqual({ scale: "1:2", paper: "A4", views: ["front"], parts: [] });

    const pdf = join(dir, "d.pdf");
    const drawn = await callTool("export_drawing", { path: pdf, title: "T" });
    expect(textOf(drawn)).toContain(`wrote 8 bytes to ${pdf}`);
    expect(readFileSync(pdf).toString()).toBe("%PDF-1.7");
  });

  it("applies and previews ops with a picture of the result, or says why there is none", async () => {
    answers["render_view"] = () => ({ png: PNG });

    const r = await callTool("apply_ops", {
      project: "P1",
      ops: [{ type: "set_param", name: "w", expr: "4" }],
      look: { view: "iso" },
    });
    expect(r.content.map((c) => c.type)).toEqual(["text", "image"]);
    expect(last("render_view")!.params).toMatchObject({ width: 800, height: 600, view: "iso" });

    answers["render_view"] = () => {
      throw new Error("no window");
    };

    const p = await callTool("preview_ops", {
      ops: [{ type: "set_param", name: "w", expr: "4" }],
      look: {},
      detail: "full",
    });
    expect(textOf(p)).toContain("no picture: no window");
    seen.length = 0;

    const bad = await callTool("apply_ops", {
      ops: [{ type: "set_param", name: "w", expr: "4" }],
      look: { view: "sideways" },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^look: view: .*nothing was changed/);
    expect(last("apply_ops")).toBeUndefined();
  });

  it("reads the files ops name on this computer and sends their contents", async () => {
    const tetra = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
      indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    };
    writeFileSync(
      join(dir, "two.3mf"),
      write3mf([
        { ...tetra, name: "A" },
        { ...tetra, name: "B" },
      ]),
    );
    writeFileSync(join(dir, "one.obj"), writeObj([{ ...tetra, name: "O" }]));
    writeFileSync(join(dir, "part.step"), "ISO-10303-21;");
    writeFileSync(join(dir, "x.dwg"), "x");
    writeFileSync(join(dir, "terrain.glb"), "glTF");

    const design = {
      format: "meercad/1",
      params: {},
      features: [
        { id: "f1", op: "sketch" },
        { id: "f2", op: "extrude" },
      ],
      versions: [{ name: "v" }],
      blobs: {},
    };
    writeFileSync(join(dir, "d.meercad"), JSON.stringify(design));

    const ops = async (o: Record<string, unknown>[]) => {
      seen.length = 0;

      const r = await callTool("apply_ops", { project: "P1", ops: o });

      return { r, sent: last("apply_ops")?.params["ops"] as Record<string, unknown>[] | undefined };
    };

    const three = (
      await ops([
        { type: "add_features", features: [{ id: "im", op: "import", path: join(dir, "two.3mf") }] },
      ])
    ).sent![0]!["features"] as Record<string, unknown>[];
    expect(three.map((f) => [f["id"], f["fileName"], f["format"]])).toEqual([
      ["im", "two.3mf › A", "stl"],
      ["im_2", "two.3mf › B", "stl"],
    ]);
    expect(readStl(Buffer.from(three[1]!["data"] as string, "base64")).triangles).toBe(4);

    const obj = (
      await ops([
        {
          type: "add_features",
          features: [{ id: "io", op: "import", path: join(dir, "one.obj"), fileName: "named.obj" }],
        },
      ])
    ).sent![0]!["features"] as Record<string, unknown>[];
    expect(obj.map((f) => [f["id"], f["fileName"]])).toEqual([["io", "named.obj"]]);

    const step = (
      await ops([
        {
          type: "add_features",
          features: [
            { id: "is", op: "import", path: join(dir, "part.step") },
            { id: "keep", op: "sketch" },
          ],
        },
      ])
    ).sent![0]!["features"] as Record<string, unknown>[];
    expect(step[0]).toMatchObject({
      id: "is",
      format: "step",
      fileName: "part.step",
      data: b64("ISO-10303-21;"),
    });
    expect(step[1]).toEqual({ id: "keep", op: "sketch" });

    const dwg = await ops([
      { type: "add_features", features: [{ id: "id", op: "import", path: join(dir, "x.dwg") }] },
    ]);
    expect(textOf(dwg.r)).toMatch(/import id: unknown file type "\.dwg"/);

    const gone = await ops([
      { type: "add_features", features: [{ id: "ig", op: "import", path: join(dir, "nope.stl") }] },
    ]);
    expect(gone.r.isError).toBe(true);
    expect(textOf(gone.r)).toMatch(/^import ig: /);

    const ref = (
      await ops([{ type: "set_reference", reference: { id: "t", path: join(dir, "terrain.glb") } }])
    ).sent![0]!;
    expect(ref).toEqual({ type: "set_reference", reference: { id: "t", data: b64("glTF") } });

    const replaced = (await ops([{ type: "replace", path: join(dir, "d.meercad") }])).sent![0]!;
    expect(replaced["doc"]).toMatchObject({ features: design.features });

    const version = (await ops([{ type: "save_version", name: "old", path: join(dir, "d.meercad") }]))
      .sent![0]!;
    expect((version["doc"] as Record<string, unknown>)["versions"]).toBeUndefined();

    const all = (await ops([{ type: "add_features", path: join(dir, "d.meercad") }])).sent![0]!;
    expect((all["features"] as unknown[]).length).toBe(2);

    const some = (await ops([{ type: "add_features", path: join(dir, "d.meercad"), ids: ["f2"] }])).sent![0]!;
    expect(some["features"]).toEqual([{ id: "f2", op: "extrude" }]);
    expect(
      textOf((await ops([{ type: "add_features", path: join(dir, "d.meercad"), ids: ["f9"] }])).r),
    ).toMatch(/has no feature f9; it has f1, f2/);
    expect(
      textOf((await ops([{ type: "add_features", path: join(dir, "d.meercad"), ids: "f1" }])).r),
    ).toMatch(/ids must be a list of feature ids/);
    // Ops that name no file go as they are.
    expect((await ops([{ type: "replace", doc: { features: [] } }])).sent).toEqual([
      { type: "replace", doc: { features: [] } },
    ]);
  });

  it("imports a file, and a design as a project of its own", async () => {
    answers["import_file"] = (p) => ({
      name: p["name"],
      bytes: Buffer.from(p["base64"] as string, "base64").length,
    });
    writeFileSync(join(dir, "plate.stl"), "solid x\nendsolid x\n");
    expect(
      JSON.parse(textOf(await callTool("import_file", { project: "P1", path: join(dir, "plate.stl") }))),
    ).toEqual({ name: "plate.stl", bytes: 19 });

    const wrapped = { name: "Wrapped", document: { format: "meercad/1", params: {}, features: [] } };
    writeFileSync(join(dir, "w.json"), JSON.stringify(wrapped));

    const r = JSON.parse(
      textOf(await callTool("import_file", { project: "P1", path: join(dir, "w.json"), keep: true })),
    );
    expect(r.name).toBe("Wrapped.meercad");
    expect(last("import_file")!.params["keep"]).toBe(true);

    const plainDesign = join(dir, "Bare.meercad");
    writeFileSync(plainDesign, JSON.stringify(wrapped.document));
    expect(JSON.parse(textOf(await callTool("import_file", { path: plainDesign }))).name).toBe(
      "Bare.meercad",
    );
  });

  it("writes an export's files: one, several next to each other, per variant, and staged in pieces", async () => {
    const one = join(dir, "exp", "part.stl");
    answers["export"] = (p) => ({
      files: { [`${p["name"]}.stl`]: b64("solid") },
      filaments: [
        { slot: 1, color: "#fff" },
        { slot: 2, material: "PETG", color: "#000" },
      ],
    });

    const r1 = textOf(await callTool("export", { project: "P1", format: "stl", path: one }));
    expect(r1).toBe(`wrote ${one}; filaments: 1 = any #fff, 2 = PETG #000`);
    expect(readFileSync(one).toString()).toBe("solid");

    const obj = join(dir, "exp", "scene.obj");
    answers["export"] = () => ({
      files: { "scene.obj": b64("o"), "scene.mtl": b64("m"), "tex.png": b64("p") },
    });
    expect(textOf(await callTool("export", { format: "obj", path: obj }))).toBe(
      `wrote ${obj}, ${join(dir, "exp", "scene.mtl")}, ${join(dir, "exp", "tex.png")}`,
    );

    answers["export"] = () => ({ files: { "P A.stl": b64("a"), "P B.stl": b64("b") } });

    const vdir = join(dir, "variants");
    mkdirSync(vdir);
    await callTool("export", { format: "stl", path: join(vdir, "x.stl"), variants: true });
    expect(readFileSync(join(vdir, "P B.stl")).toString()).toBe("b");

    const vdir2 = join(dir, "variants2");
    await callTool("export", { format: "stl", path: vdir2, variants: true });
    expect(readFileSync(join(vdir2, "P A.stl")).toString()).toBe("a");

    // A big export waits in the app and is fetched piece by piece.
    const big = Buffer.alloc(17 * 1024 * 1024, 7);
    const small = Buffer.from("small");
    const staged: Record<string, Buffer> = { "big.3mf": big, "small.txt": small };
    const asked: unknown[] = [];
    answers["export"] = () => ({
      files: {},
      staged: { token: "tk", sizes: { "big.3mf": big.length, "small.txt": small.length } },
    });

    answers["staged_files"] = (p) => {
      asked.push(p["done"] ? "done" : (p["pieces"] as { name: string }[]).map((x) => x.name));
      if (p["done"]) return {};

      return {
        data: (p["pieces"] as { name: string; offset: number; length: number }[]).map((x) =>
          staged[x.name]!.subarray(x.offset, x.offset + x.length).toString("base64"),
        ),
      };
    };

    const out3mf = join(dir, "exp", "big.3mf");
    // Fetching 17 MB may outlast the answer window on a slow runner: the same call again picks up the result.
    let wrote = textOf(await callTool("export", { format: "3mf", path: out3mf }));

    while (wrote.includes('"stillWorking":true')) {
      wrote = textOf(await callTool("export", { format: "3mf", path: out3mf }));
    }

    expect(wrote).toContain(out3mf);
    expect(readFileSync(out3mf).equals(big)).toBe(true);
    expect(readFileSync(join(dir, "exp", "small.txt")).toString()).toBe("small");
    expect(asked).toEqual([["big.3mf"], ["big.3mf", "small.txt"], "done"]);
    expect(last("export")!.params).toMatchObject({ format: "3mf", name: "big", stage: true });

    // A piece that cannot be fetched: an error, and the app is still told to let go.
    asked.length = 0;

    answers["staged_files"] = (p) => {
      asked.push(p["done"] ? "done" : "piece");
      if (p["done"]) throw new Error("gone already");

      throw new Error("token expired");
    };

    const failed = await callTool("export", { format: "3mf", path: out3mf });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toMatch(/token expired/);
    expect(asked).toEqual(["piece", "done"]);
    delete answers["staged_files"];
  });

  it("writes a robot's files into its folder", async () => {
    answers["export_robot"] = () => ({
      files: { "r.xml": b64("<mujoco/>"), "r.urdf": b64("<robot/>"), "meshes/a.stl": b64("s") },
      links: [{ name: "base", parts: ["a"], mass: 0.1, parent: null, joint: null }],
      warnings: ["no material"],
    });

    const out = join(dir, "robot");
    const r = JSON.parse(
      textOf(await callTool("export_robot", { project: "P1", path: out, collision: "mesh" })),
    );
    expect(r.wrote).toEqual([join(out, "r.xml"), join(out, "r.urdf")]);
    expect(r.meshes).toBe(`1 STL files in ${join(out, "meshes")}`);
    expect(readFileSync(join(out, "meshes", "a.stl")).toString()).toBe("s");
    expect(r.warnings).toEqual(["no material"]);
  });

  it("opens in a slicer and says what it sent", async () => {
    answers["send_to_slicer"] = () => ({
      slicer: "Bambu Studio",
      file: "/tmp/x.3mf",
      moved: true,
      filaments: [{ slot: 1, color: "#f00" }],
    });
    expect(textOf(await callTool("send_to_slicer", {}))).toBe(
      "opened /tmp/x.3mf in Bambu Studio (moved parts where they are shown); filaments: 1 = any #f00",
    );
    answers["send_to_slicer"] = () => ({ slicer: "PrusaSlicer", file: "/tmp/y.3mf", moved: false });
    expect(textOf(await callTool("send_to_slicer", {}))).toBe("opened /tmp/y.3mf in PrusaSlicer");
  });

  it("answers in time while the app works on, and gives the result to the same call again", async () => {
    let finish: (v: unknown) => void = () => undefined;
    answers["check_interference"] = () => new Promise((r) => (finish = r));

    const first = JSON.parse(textOf(await callTool("check_interference", { project: "P1", seconds: 9 })));
    expect(first).toMatchObject({ stillWorking: true, tool: "check_interference" });
    finish({ pairs: [] });
    await wait(50);
    expect(JSON.parse(textOf(await callTool("check_interference", { project: "P1", seconds: 9 })))).toEqual({
      pairs: [],
    });
    delete answers["check_interference"];
  });

  it("says when meerCAD was updated under it", async () => {
    stale = true;

    try {
      const r = await callTool("insert_sizes", { size: "M3" });
      expect(textOf(r)).not.toContain("updated after this MCP server started");

      const g = await callTool("get_guide", {});
      expect(textOf(g)).toContain("updated after this MCP server started");

      const e = await callTool("get_sketch", { id: "zz" });
      expect(textOf(e)).toContain("updated after this MCP server started");
    } finally {
      stale = false;
    }
  });

  it("opens the app when it went away and says so when it does not come", async () => {
    app?.close();
    await wait(300);

    const r = await callTool("get_model", { project: "P1" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/not connected/);
  });
});
