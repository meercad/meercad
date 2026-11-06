/**
 * meerCAD MCP server. Claude (or any MCP client) launches this over stdio; the running meerCAD app
 * connects to it over a local WebSocket and executes every tool call against the open document.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { MCP_NOTES, SYSTEM_PROMPT } from "@meercad/ai/prompt";
import { read3mf, readObj, writeStl } from "@meercad/io";
import { gearCalc } from "./gearCalc.js";
import { DEFAULT_PORT, type BridgeHello, type BridgeMethod, type BridgeResponse } from "./protocol.js";

const port = Number(process.env["MEERCAD_MCP_PORT"] ?? DEFAULT_PORT);
// Only the app may connect: browsers always send Origin, and web pages cannot forge it.
const extraOrigins = (process.env["MEERCAD_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const originAllowed = (origin: string | undefined) =>
  !origin || origin === "null" || origin.startsWith("file://") || origin.startsWith("app://") || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || extraOrigins.includes(origin);

const log = (...a: unknown[]) => console.error("[meercad-mcp]", ...a);

let app: WebSocket | null = null;
let hello: BridgeHello | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

/** True while another process holds the bridge port; we keep retrying until it is free. */
let portBusy = false;
/** Set once this server handed the port to a newer one: from then on it only waits for it to free up. */
let yielded = false;
let bridge: WebSocketServer | null = null;

/**
 * Several clients may start this server (e.g. a chat and a coding session); only one can own the
 * port. The newest wins: a server that finds the port taken asks the owner to step aside, and the
 * app reconnects to it. A server that stepped aside only waits, and takes over again if the port
 * frees up (so the two never trade it back and forth).
 */
function startBridge(): void {
  const wss = new WebSocketServer({ host: "127.0.0.1", port, verifyClient: ({ origin }: { origin?: string }) => originAllowed(origin) });
  wss.on("listening", () => {
    portBusy = false;
    bridge = wss;
    log(`waiting for the meerCAD app on ws://127.0.0.1:${port}`);
  });
  wss.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      if (!portBusy) log(`port ${port} is in use by another meerCAD MCP server; ${yielded ? "waiting" : "asking it to hand over"}`);
      if (!portBusy && !yielded) askForTakeover();
      portBusy = true;
      wss.close();
      setTimeout(startBridge, yielded ? 2000 : 500).unref();
      return;
    }
    log(`bridge error: ${e.message}`);
  });
  wss.on("connection", onConnection);
}

/** Tells the server that owns the port that a newer one is here. */
function askForTakeover(): void {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("open", () => {
    ws.send(JSON.stringify({ takeover: "meercad" }));
    ws.close();
  });
  ws.on("error", () => undefined);
}

/** A newer server asked for the port: let the app go (it reconnects to the newcomer) and wait. */
function handOver(): void {
  log("a newer meerCAD MCP server took over; this one waits until it exits");
  yielded = true;
  app?.close(4001, "handed over to a newer assistant session");
  const wss = bridge;
  bridge = null;
  wss?.close(() => setTimeout(startBridge, 2000).unref());
  for (const c of wss?.clients ?? []) c.terminate();
}

function onConnection(ws: WebSocket): void {
  ws.on("message", (raw) => {
    let msg: BridgeResponse | BridgeHello | { takeover: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if ("takeover" in msg) return handOver();
    if ("hello" in msg) {
      if (app && app !== ws) app.close(4000, "replaced by a newer connection");
      app = ws;
      hello = msg;
      log(`app connected (project: ${msg.project ?? "none"})`);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if ("error" in msg) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  });
  ws.on("close", () => {
    if (app === ws) {
      app = null;
      hello = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("the meerCAD app disconnected"));
        pending.delete(id);
      }
    }
  });
}

startBridge();

function call<T = unknown>(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
  if (!app || app.readyState !== app.OPEN) {
    if (yielded && portBusy) return Promise.reject(new Error("A newer assistant session is connected to meerCAD now. Use that session, or close it and try again here."));
    return Promise.reject(
      new Error(
        "The meerCAD app is not connected. Open meerCAD and enable 'Connect AI assistants (MCP)' in the toolbar menu, then try again.",
      ),
    );
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    const info = server.server.getClientVersion();
    app!.send(JSON.stringify({ id, method, params, client: info?.title ?? info?.name ?? "Assistant" }));
  });
}

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const guard =
  <A,>(fn: (a: A) => Promise<ReturnType<typeof text> | { content: unknown[] }>) =>
  async (a: A) => {
    try {
      return (await fn(a)) as ReturnType<typeof text>;
    } catch (e) {
      return { ...text(e instanceof Error ? e.message : String(e)), isError: true };
    }
  };

/**
 * Import features may name a local file in `path` instead of carrying it as base64 in `data`: this
 * server runs on the user's computer, so it reads the file and fills in `data`, `fileName` and
 * `format` (from the extension) before the ops reach the app. 3MF and OBJ meshes go in as STL, one
 * feature per object (ids get a suffix from the second one on).
 */
async function inlineImportFiles(ops: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  // (also: set_reference with `path` reads the .glb)
  const inline = async (f: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    if (f["op"] !== "import" || typeof f["path"] !== "string") return [f];
    const path = resolve(f["path"].replace(/^~(?=\/|$)/, homedir()));
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch {
      throw new Error(`import ${String(f["id"] ?? "")}: cannot read the file "${path}"`);
    }
    const ext = extname(path).toLowerCase();
    const { path: _path, ...rest } = f;
    const name = (f["fileName"] as string | undefined) ?? basename(path);
    if (ext === ".3mf" || ext === ".obj") {
      const meshes = ext === ".3mf" ? read3mf(new Uint8Array(bytes)) : [{ ...readObj(bytes.toString("utf8")), name }];
      return meshes.map((m, i) => ({ ...rest, id: i ? `${String(f["id"])}_${i + 1}` : f["id"], format: "stl", fileName: meshes.length > 1 ? `${name} › ${m.name}` : name, data: Buffer.from(writeStl([m])).toString("base64") }));
    }
    const format = f["format"] ?? (ext === ".stl" ? "stl" : ext === ".step" || ext === ".stp" ? "step" : undefined);
    if (!format) throw new Error(`import ${String(f["id"] ?? "")}: unknown file type "${ext}" (use .step, .stp, .stl, .3mf or .obj, or set format)`);
    return [{ ...rest, format, fileName: name, data: bytes.toString("base64") }];
  };
  const reference = async (o: Record<string, unknown>) => {
    const r = o["reference"] as Record<string, unknown> | undefined;
    if (o["type"] !== "set_reference" || !r || typeof r["path"] !== "string") return o;
    const path = resolve(r["path"].replace(/^~(?=\/|$)/, homedir()));
    const { path: _p, ...rest } = r;
    return { ...o, reference: { ...rest, data: (await readFile(path)).toString("base64") } };
  };
  ops = await Promise.all(ops.map(reference));
  return Promise.all(
    ops.map(async (o) => (o["type"] === "add_features" && Array.isArray(o["features"]) ? { ...o, features: (await Promise.all((o["features"] as Record<string, unknown>[]).map(inline))).flat() } : o)),
  );
}

const server = new McpServer({ name: "meercad", version: "0.1.0" }, { instructions: "Parametric CAD. Call get_guide once before modelling; change the model only with apply_ops (or preview_ops to try ideas)." });

const op = z.record(z.string(), z.unknown()).describe("One Operations-API op, see get_guide");
const selector = z.record(z.string(), z.unknown());

server.registerTool("get_guide", { title: "Modelling guide", description: "How meerCAD documents, sketches, features, face tags and selectors work, with the JSON Schema of every op. Read before editing." }, async () => text(`${SYSTEM_PROMPT.replace("The user previews your changes before accepting them.", "")}\n\n${MCP_NOTES}`));

server.registerTool(
  "get_model",
  {
    title: "Current model",
    description:
      "The open project: document (params + features), rebuild status per feature, bodies with volume and bounding box, sketch degrees of freedom. Embedded files (imported meshes, pictures, terrains) are left out as \"…elided:<n> chars…\"; ops may send such a placeholder back unchanged to keep the value. full: true returns them whole.",
    inputSchema: { full: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ full }) => text(await call("get_model", { full }))),
);

server.registerTool(
  "get_sketch",
  { title: "Solved sketch", description: "Solved geometry of a sketch: points, curves, closed regions (keys usable in extrude profiles), DOF and conflicts.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
  guard(async ({ id }) => text(await call("get_sketch", { id }))),
);

server.registerTool(
  "apply_ops",
  {
    title: "Change the model",
    description:
      "Applies Operations-API ops atomically as one undo step and returns the rebuild result; rejected ops leave the model unchanged. Ops: add_features, edit_feature, delete_feature, move_feature, set_param, rename_param, set_rollback; parts: set_material, set_part_color, set_see_through, set_part_list (folders, order), set_units; joints: set_joint, delete_joint, set_coupling, delete_coupling; reference models (terrains, scans): set_reference, delete_reference; variants: set_variant, delete_variant, use_variant; versions: save_version, restore_version, rename_version, delete_version; replace (whole document; saved versions are kept). The changes apply at once (no confirmation step), undo reverts them. An import feature may give `path` (a file on this computer) instead of base64 `data`, a reference may give `path` (a .glb) instead of `data`.",
    inputSchema: { ops: z.array(op).min(1) },
  },
  guard(async ({ ops }) => text(await call("apply_ops", { ops: await inlineImportFiles(ops) }))),
);

server.registerTool(
  "preview_ops",
  {
    title: "Try changes",
    description: "Shows the model with the ops applied as a live preview in the app (not saved) and returns the rebuild result. Use to try ideas; then apply_ops to keep them or clear_preview.",
    inputSchema: { ops: z.array(op).min(1) },
  },
  guard(async ({ ops }) => text(await call("preview_ops", { ops: await inlineImportFiles(ops) }))),
);

server.registerTool("clear_preview", { title: "Clear preview", description: "Removes a preview shown by preview_ops." }, guard(async () => text(await call("clear_preview"))));

server.registerTool("undo", { title: "Undo", description: "Undoes the last change." }, guard(async () => text(await call("undo"))));
server.registerTool("redo", { title: "Redo", description: "Redoes the last undone change." }, guard(async () => text(await call("redo"))));

server.registerTool("list_projects", { title: "List projects", description: "Saved projects (id, name, last change).", annotations: { readOnlyHint: true } }, guard(async () => text(await call("list_projects"))));
server.registerTool(
  "open_project",
  { title: "Open project", description: "Opens a saved project by id (see list_projects); the app switches to it so the user sees your work live.", inputSchema: { id: z.string() } },
  guard(async ({ id }) => text(await call("open_project", { id }))),
);
server.registerTool(
  "new_project",
  { title: "New project", description: "Creates and opens an empty project.", inputSchema: { name: z.string().optional() } },
  guard(async ({ name }) => text(await call("new_project", { name }))),
);

const view = z.enum(["iso", "front", "back", "left", "right", "top", "bottom"]);
const shot = {
  view: view.optional(),
  direction: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Look along this direction (camera towards model), e.g. [1,-1,-0.5] from front-left above; overrides view"),
  focus: z.array(z.string()).optional().describe("Part ids to zoom onto"),
  isolate: z.boolean().optional().describe("With focus: hide all other parts"),
  section: z
    .object({ plane: z.enum(["XY", "XZ", "YZ"]).optional(), normal: z.tuple([z.number(), z.number(), z.number()]).optional(), offset: z.number().optional() })
    .optional()
    .describe("Cut the model open: the side the normal points to is removed; the cut faces show red. offset moves the plane along its normal (mm)"),
  highlight: z.object({ parts: z.array(z.string()).optional(), faces: z.array(selector).optional() }).optional().describe("Parts drawn orange, faces (selectors) drawn as selected (blue)"),
};

server.registerTool(
  "render_view",
  {
    title: "Look at the model",
    description:
      "Renders the model as a PNG to check the result: from a standard view or any direction, zoomed onto parts (focus, isolate), cut open by a plane (section, cut faces red) and with parts or faces highlighted. Moving parts show in their current pose (set_pose). Does not move the user's camera. style \"rendered\" makes a presentable picture: parts in their materials (set_material) under studio light with a soft shadow on a ground, no edges; with path the PNG is also written to that file (up to 4096 px a side).",
    inputSchema: {
      ...shot,
      width: z.number().int().min(64).max(4096).optional(),
      height: z.number().int().min(64).max(4096).optional(),
      style: z.enum(["working", "rendered"]).optional().describe("working (default): shaded with edges, for checking; rendered: materials, studio light and shadow, for showing"),
      path: z.string().optional().describe("Also write the PNG to this file"),
    },
    annotations: { readOnlyHint: true },
  },
  guard(async (a) => {
    const { path, ...shotArgs } = a;
    const r = await call<{ png: string }>("render_view", shotArgs);
    if (path) await writeFile(resolve(path), Buffer.from(r.png, "base64"));
    return { content: [{ type: "image", data: r.png, mimeType: "image/png" }, ...(path ? [{ type: "text" as const, text: `wrote ${resolve(path)}` }] : [])] };
  }),
);

server.registerTool(
  "render_motion",
  {
    title: "Watch a motion",
    description:
      "Moves one joint from `from` to `to` (default: its limits, a full turn, or ±20 mm) and returns the poses as one contact-sheet PNG, each frame labelled with the joint value; frames where parts overlap get a red border naming them (collisions: false skips that check, faster). With `video.path` it also writes an animated GIF of the motion there (for people to watch). Takes the same picture options as render_view. The joints go back where they were.",
    inputSchema: {
      joint: z.string(),
      from: z.number().optional(),
      to: z.number().optional(),
      frames: z.number().int().min(2).max(16).optional().describe("Frames on the sheet, default 9"),
      collisions: z.boolean().optional(),
      ...shot,
      width: z.number().int().min(256).max(2400).optional().describe("Width of the whole sheet, default 1200"),
      video: z.object({ path: z.string(), frames: z.number().int().min(4).max(120).optional(), width: z.number().int().min(64).max(1280).optional(), height: z.number().int().min(64).max(1280).optional() }).optional(),
    },
  },
  guard(async ({ video, ...a }) => {
    const r = await call<{ png: string; frames: unknown; gif?: string }>("render_motion", { ...a, ...(video ? { video: { frames: video.frames, width: video.width, height: video.height } } : {}) });
    const content: ({ type: "image"; data: string; mimeType: string } | { type: "text"; text: string })[] = [{ type: "image", data: r.png, mimeType: "image/png" }];
    let note = JSON.stringify({ frames: r.frames });
    if (video && r.gif) {
      const out = resolve(video.path);
      const data = Buffer.from(r.gif, "base64");
      await writeFile(out, data);
      note += `\nwrote a ${data.length} byte GIF to ${out}`;
    }
    content.push({ type: "text", text: note });
    return { content };
  }),
);

server.registerTool(
  "export_drawing",
  {
    title: "Make a technical drawing",
    description:
      "Lays the parts out on a drawing sheet (ISO first-angle projection: front, from above, from the left, isometric, optionally section A-A through the middle), with hidden edges dashed, overall dimensions, a title block and a parts list (several parts), and returns a picture of the sheet. With `path` it also writes the sheet there as PDF (default), SVG or DXF for a workshop.",
    inputSchema: {
      views: z.array(z.enum(["front", "top", "left", "iso", "section"])).optional().describe("Default front, top, left, iso"),
      paper: z.enum(["A4", "A3", "A2"]).optional(),
      title: z.string().max(80).optional(),
      material: z.string().max(40).optional(),
      drawnBy: z.string().max(40).optional(),
      number: z.string().max(40).optional(),
      bom: z.boolean().optional().describe("Parts list on the sheet (default when there are several parts)"),
      format: z.enum(["pdf", "svg", "dxf"]).optional(),
      path: z.string().optional().describe("Where to write the file"),
    },
  },
  guard(async ({ path, ...a }) => {
    const r = await call<{ file: string; png: string; scale: string; paper: string; views: string[]; parts: unknown[] }>("drawing", a);
    let note = JSON.stringify({ scale: r.scale, paper: r.paper, views: r.views, parts: r.parts });
    if (path) {
      const out = resolve(path);
      const data = Buffer.from(r.file, "base64");
      await writeFile(out, data);
      note += `\nwrote ${data.length} bytes to ${out}`;
    }
    return { content: [{ type: "image", data: r.png, mimeType: "image/png" }, { type: "text", text: note }] };
  }),
);

server.registerTool(
  "set_view",
  { title: "Move the camera", description: "Points the app's camera at a standard view (or fits everything).", inputSchema: { view: z.enum(["iso", "front", "back", "left", "right", "top", "bottom", "fit"]) } },
  guard(async ({ view }) => text(await call("set_view", { view }))),
);

server.registerTool(
  "export",
  {
    title: "Export a file",
    description:
      "Exports the model (stl, 3mf, obj, step) or a sketch (dxf, svg; needs sketch) to a file path on this computer, as the app's own export does: the parts not hidden (or `parts`), with their names, colours and materials (3mf assigns parts with different materials or colours to different filaments, slots, for multi-material slicers), moved parts where they are shown (posed: false takes them at rest). obj also takes the visible terrains and scans with their textures: their .mtl and pictures are written next to the .obj. variants: true writes one file per variant into the folder of `path` (named after the project and variant).",
    inputSchema: {
      format: z.enum(["stl", "3mf", "obj", "step", "dxf", "svg", "meercad"]),
      path: z.string().describe("Absolute or relative output path"),
      sketch: z.string().optional(),
      parts: z.array(z.string()).optional().describe("Part ids; default every part not hidden"),
      posed: z.boolean().optional(),
      variants: z.boolean().optional(),
    },
  },
  guard(async ({ format, path, sketch, parts, posed, variants }) => {
    const out = resolve(path);
    const name = basename(out).replace(/\.[^.]+$/, "");
    const r = await call<{ files: Record<string, string>; filaments?: { slot: number; material?: string; color: string }[] }>("export", { format, sketch, parts, posed, variants, name }, 300_000);
    const files = Object.entries(r.files);
    const written: string[] = [];
    for (const [file, b64] of files) {
      // One file goes to `path`; the main file of several goes there and the rest next to it.
      const main = files.length === 1 || (!variants && file.toLowerCase().endsWith(`.${format}`));
      const target = main && !variants ? out : join(variants ? (extname(out) ? dirname(out) : out) : dirname(out), file);
      await writeFile(target, Buffer.from(b64, "base64"));
      written.push(target);
    }
    return text(`wrote ${written.join(", ")}${r.filaments?.length ? `; filaments: ${r.filaments.map((f) => `${f.slot} = ${f.material ?? "any"} ${f.color}`).join(", ")}` : ""}`);
  }),
);

server.registerTool(
  "list_materials",
  {
    title: "Materials",
    description:
      "The materials parts can be made of: the built-in library (id, name, density g/cm³, filament type, nozzle and bed temperature, Shore hardness, finish) and the document's own materials, with each part's material. Assign with apply_ops [{type:\"set_material\", part, material}] (one op per part); make an own material (a library material under an own name and colour) with {type:\"define_material\", material:{id, name, base, color?, density?}}.",
    annotations: { readOnlyHint: true },
  },
  guard(async () => text(await call("list_materials"))),
);

server.registerTool(
  "measure",
  {
    title: "Measure",
    description: "Measures one face/edge (area, length, radius) or the distance and angle between two. Pass face selectors ({face:\"ex1.end_cap\"}) or edge selectors ({edge:[tagA, tagB]}).",
    inputSchema: { a: selector, b: selector.optional() },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ a, b }) => text(await call("measure", { a, b }))),
);

server.registerTool(
  "gear_calc",
  {
    title: "Gear sizes",
    description:
      "Sizes of an involute gear (pitch, tip and root diameters, span over k teeth, undercut warning) and, with teeth2, of a pair: centre distance and ratio. Use it to plan a drive before adding gear features. kind2 'internal' puts the second gear around the first (a ring gear), 'rack' makes it a rack.",
    inputSchema: {
      module: z.number().positive(),
      teeth: z.number().int().min(4).max(1000),
      teeth2: z.number().int().min(1).max(1000).optional(),
      kind2: z.enum(["spur", "internal", "rack"]).optional(),
      pressureAngle: z.number().min(10).max(35).optional(),
      profileShift: z.number().optional(),
      helix: z.number().gt(-45).lt(45).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (a) => text(gearCalc(a)),
);

server.registerTool(
  "set_pose",
  {
    title: "Move a mechanism",
    description: "Sets joint values (degrees for revolute joints, mm for sliders; driven joints move their drivers, linkages follow) and shows the pose in the app. Returns every joint's value and whether all were reached (limits and dead points stop a joint short).",
    inputSchema: { values: z.record(z.string(), z.number()).describe("joint id → value") },
  },
  guard(async ({ values }) => text(await call("set_pose", { values }))),
);

server.registerTool(
  "check_clearance",
  {
    title: "Check clearance",
    description: "In the pose shown now: the gap between every moving part and the parts near it (mm), and the overlapping volume where they collide (mm³), with the wanted print-in-place gap (mechanism.clearance, default 0.3 mm).",
    annotations: { readOnlyHint: true },
  },
  guard(async () => text(await call("check_clearance"))),
);

server.registerTool(
  "check_motion",
  {
    title: "Check a motion",
    description: "Moves one joint from `from` to `to` in `steps` (default 12) and checks the gaps at each: the first value where parts touch (faces against each other: fused when printed in place) or overlap (they collide), the smallest gap per pair of parts and where, and where the joint stopped if a limit or dead point held it. The joints go back where they were afterwards.",
    inputSchema: { joint: z.string(), from: z.number(), to: z.number(), steps: z.number().int().min(1).max(90).optional() },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ joint, from, to, steps }) => text(await call("check_motion", { joint, from, to, steps }))),
);

server.registerTool(
  "get_version",
  { title: "Look at a version", description: "A saved version's design (see the version names in get_model), without restoring it.", inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } },
  guard(async ({ name }) => text(await call("get_version", { name }))),
);

server.registerTool(
  "check_interference",
  { title: "Check for overlaps", description: "Every part against every other where they are modelled (no joints needed): pairs that overlap with the shared volume (mm³), and pairs that only touch.", annotations: { readOnlyHint: true } },
  guard(async () => text(await call("check_interference", {}, 300_000))),
);

server.registerTool(
  "wall_thickness",
  {
    title: "Wall thickness",
    description: "Measures a part's walls (rays into the material from all over the surface) against the wall a printer needs (minWall, default 1 mm): the thinnest wall and where, and the share of the surface thinner than minWall. The colour map stays shown in the app (red thin → green) unless show: false.",
    inputSchema: { part: z.string(), minWall: z.number().positive().optional(), show: z.boolean().optional() },
  },
  guard(async (a) => text(await call("wall_thickness", a, 300_000))),
);

server.registerTool(
  "deviation",
  {
    title: "Deviation from a mesh",
    description: "How far a part's surface is from a mesh part (e.g. the scan it was modelled after): smallest and largest distance (mm, negative inside) and the share within the tolerance. The colour map stays shown unless show: false.",
    inputSchema: { part: z.string(), mesh: z.string(), show: z.boolean().optional() },
  },
  guard(async (a) => text(await call("deviation", a, 300_000))),
);

server.registerTool(
  "repair_mesh",
  {
    title: "Clean up a mesh",
    description: "Cleans up an imported mesh part (STL/3MF/OBJ/scan): removes loose pieces, closes holes, and with reduce (a tolerance in mm, e.g. 0.05) uses fewer triangles. One undo step; a scan's texture is dropped as it belongs to the old triangles.",
    inputSchema: { part: z.string(), removePieces: z.boolean().optional(), fillHoles: z.boolean().optional(), reduce: z.number().positive().optional() },
  },
  guard(async (a) => text(await call("repair_mesh", a, 300_000))),
);

server.registerTool(
  "rebuild_mesh",
  { title: "Rebuild a mesh with features", description: "Fits sketches and extrudes to a mesh part (planes and cylinders it is made of) and adds them as editable steps with parameters; the mesh stays, hidden, to compare (deviation).", inputSchema: { part: z.string() } },
  guard(async (a) => text(await call("rebuild_mesh", a, 300_000))),
);

server.registerTool(
  "measure_scan",
  {
    title: "Measure on a scan",
    description: "On a mesh part, fits the plane, cylinder, cone or sphere the surface follows at a point (within tolerance mm, default 0.1) and gives its sizes; with `other` (a second point, on the same or another part) also the distance and angle between the two shapes.",
    inputSchema: { part: z.string(), point: z.tuple([z.number(), z.number(), z.number()]), other: z.object({ part: z.string().optional(), point: z.tuple([z.number(), z.number(), z.number()]) }).optional(), tolerance: z.number().positive().optional() },
    annotations: { readOnlyHint: true },
  },
  guard(async (a) => text(await call("measure_scan", a))),
);

server.registerTool(
  "joints_from_gears",
  { title: "Joints for gears", description: "Adds a joint to every gear that has none (turning on its axis, a rack sliding) and couples gears in mesh by their ratio, as one undo step." },
  guard(async () => text(await call("joints_from_gears"))),
);

server.registerTool(
  "import_file",
  {
    title: "Import a file",
    description: "Imports a file from this computer as the app does: STEP/STL/3MF/OBJ as parts, DXF/SVG as a sketch on XY, a .meercad file as a new project. (apply_ops with an import feature and `path` also works for STEP/STL/3MF/OBJ.)",
    inputSchema: { path: z.string() },
  },
  guard(async ({ path }) => {
    const file = resolve(path.replace(/^~(?=\/|$)/, homedir()));
    const data = await readFile(file);
    return text(await call("import_file", { name: basename(file), base64: data.toString("base64") }, 300_000));
  }),
);

server.registerTool(
  "set_visibility",
  { title: "Show or hide parts", description: "Hides or shows parts in the user's view (not saved with the design; exports take the parts shown): hide, show, only (show just these), all (show every part).", inputSchema: { hide: z.array(z.string()).optional(), show: z.array(z.string()).optional(), only: z.array(z.string()).optional(), all: z.boolean().optional() } },
  guard(async (a) => text(await call("set_visibility", a))),
);

server.registerTool("rename_project", { title: "Rename the project", description: "Renames the open project.", inputSchema: { name: z.string().min(1).max(120) } }, guard(async (a) => text(await call("rename_project", a))));
server.registerTool("list_folders", { title: "List folders", description: "The folders projects are kept in (\"\" is the top level) and the open project's folder.", annotations: { readOnlyHint: true } }, guard(async () => text(await call("list_folders"))));
server.registerTool("create_folder", { title: "New folder", description: "Creates a folder for projects inside `parent` (\"\" for the top level).", inputSchema: { parent: z.string().optional(), name: z.string().min(1).max(120) } }, guard(async (a) => text(await call("create_folder", a))));
server.registerTool("move_project", { title: "Move the project", description: "Moves the open project into a folder (see list_folders; \"\" for the top level).", inputSchema: { folder: z.string() } }, guard(async (a) => text(await call("move_project", a))));
server.registerTool("list_examples", { title: "Examples", description: "The example designs that come with meerCAD (worked samples of features).", annotations: { readOnlyHint: true } }, guard(async () => text(await call("list_examples"))));
server.registerTool("open_example", { title: "Open an example", description: "Opens an example (id or name from list_examples) as a new project of its own.", inputSchema: { id: z.union([z.number().int(), z.string()]) } }, guard(async (a) => text(await call("open_example", a))));

server.registerTool(
  "terrain_height",
  { title: "Ground height", description: "The extent of the shown terrains (models from drone photos, scanned areas) and their ground heights at x/y points in design coordinates (mm); null where there is no terrain.", inputSchema: { points: z.array(z.tuple([z.number(), z.number()])).max(500).optional() }, annotations: { readOnlyHint: true } },
  guard(async (a) => text(await call("terrain_height", a))),
);

server.registerTool(
  "place_on_terrain",
  { title: "Stand a part on the terrain", description: "Moves a part so its lowest point sits on the terrain: where it is, or at `at` (x/y, mm), raised by `offset` mm. One undo step (a move step).", inputSchema: { part: z.string(), at: z.tuple([z.number(), z.number()]).optional(), offset: z.number().optional() } },
  guard(async (a) => text(await call("place_on_terrain", a))),
);

server.registerTool(
  "photo_terrain",
  { title: "Terrain from drone photos", description: "Builds a textured terrain model from a folder of overlapping photos on this Mac (Apple photogrammetry; true size and north from their GPS) and adds it to the open design. Takes several minutes; the app shows progress.", inputSchema: { folder: z.string() } },
  guard(async ({ folder }) => text(await call("photo_terrain", { folder: resolve(folder.replace(/^~(?=\/|$)/, homedir())) }, 3_600_000))),
);

server.registerTool(
  "status",
  { title: "Connection status", description: "Whether the meerCAD app is connected, which project is open, and the available projects.", annotations: { readOnlyHint: true } },
  async () => {
    if (!app)
      return text({
        connected: false,
        hint: portBusy
          ? `Another meerCAD MCP server (e.g. from a different chat or session) is using port ${port}, so the app talks to that one. Close that session or restart this one; this server takes over as soon as the port is free.`
          : `Open meerCAD and enable 'Allow assistants to control meerCAD' (plug icon). Listening on ws://127.0.0.1:${port}.`,
      });
    try {
      return text({ connected: true, ...(await call<Record<string, unknown>>("get_status")) });
    } catch {
      return text({ connected: true, ...hello });
    }
  },
);

await server.connect(new StdioServerTransport());
// When the client goes away (stdin closes), exit so no orphan keeps the bridge port.
const quit = () => {
  log("client disconnected, exiting");
  process.exit(0);
};
process.stdin.on("end", quit);
process.stdin.on("close", quit);
log("MCP server ready on stdio");
