/**
 * meerCAD MCP server. Claude (or any MCP client) launches this over stdio; the running meerCAD app
 * connects to it over a local WebSocket and executes every tool call against the open document.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { FEATURE_NAMES, GUIDE_TEXT, MCP_NOTES, OP_NAMES, schemaFor } from "@meercad/ai/prompt";
import { read3mf, readObj, writeStl } from "@meercad/io";
import { gearCalc } from "./gearCalc.js";
import { insertSizes } from "./insertSizes.js";
import { spawn } from "node:child_process";
import { createBridge, NOT_CONNECTED } from "./hub.js";
import { appTarget, createLauncher, launchEnv } from "./launchApp.js";
import { localPath, readLocal, writeLocal, type AppFiles } from "./localFiles.js";
import { meercadDocument } from "./meercadFile.js";
import { STALE_NOTE, staleCheck } from "./staleServer.js";
import { callKey, createPatience } from "./patience.js";
import { DEFAULT_PORT, PROJECT_PARAM, stagedRequests, type BridgeMethod, type ExportedFiles } from "./protocol.js";

/** The port of the build this server ships in (server.json next to it, see CHANNEL_PORTS); MEERCAD_MCP_PORT wins (test runs). */
function bundledPort(): number | undefined {
  try {
    const p = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "server.json"), "utf8")) as { port?: unknown }).port;
    return typeof p === "number" && Number.isInteger(p) ? p : undefined;
  } catch {
    return undefined;
  }
}
const port = Number(process.env["MEERCAD_MCP_PORT"] ?? bundledPort() ?? DEFAULT_PORT);
// Only the app may connect: browsers always send Origin, and web pages cannot forge it.
const extraOrigins = (process.env["MEERCAD_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const originAllowed = (origin: string | undefined) =>
  !origin || origin === "null" || origin.startsWith("file://") || origin.startsWith("app://") || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || extraOrigins.includes(origin);

const log = (...a: unknown[]) => console.error("[meercad-mcp]", ...a);

/** This server's session: the app keeps a tab and document per session. */
const session = randomUUID();
const bridge = createBridge({ port, session, originAllowed, log });

/** Opens the app this server belongs to when an assistant needs it (see launchApp). */
const launcher = createLauncher({
  target: appTarget({ serverPath: fileURLToPath(import.meta.url), env: process.env, port, platform: process.platform }),
  // `open` hands its environment to the app: without ELECTRON_RUN_AS_NODE (the RC's and WIP's servers
  // run on the app's own binary with it) the app would start as plain Node and quit at once.
  open: (args) => spawn("open", args, { stdio: "ignore", detached: true, env: launchEnv(process.env) }).on("error", (e) => log(`open: ${e.message}`)).unref(),
  connected: async () => (await bridge.status()).connected,
  log,
});
const NOT_CONNECTED_OPENED = "meerCAD was opened but has not connected yet. Ask the user to enable 'Allow assistants to control meerCAD' (plug icon in the top bar), then try again.";

/** Opens the app if it is not connected; throws if it still is not. */
async function ensureApp(): Promise<void> {
  const { connected, opened } = await launcher.ensure();
  if (!connected) throw new Error(opened ? NOT_CONNECTED_OPENED : NOT_CONNECTED);
}

/** The project the tool call being served names (see PROJECT_PARAM): every request it makes goes to that project's tab. */
const addressed = new AsyncLocalStorage<string | undefined>();

/**
 * For calls that rebuild or check a whole design: opening a big one (Mini v4: 900 steps, 580 parts)
 * takes over a minute, a change near its end 20 s, a motion check one gap check per pose. They
 * used to give up after 60 s while the app went on working, and the next calls waited behind it.
 * Opening Mini v4 in a fresh app took over 5 minutes (2026-11-10). The client never waits that
 * long (see patience): this is only how long a run may go on before the server gives up on it.
 * Exports and print checks too: the first 3MF of Mini v4 meshes every part in print quality
 * (over 3 minutes in a fresh app, more while the Mac is busy or the call waits behind a rebuild),
 * and gave up after 5 minutes while the app went on (2026-11-11).
 */
const LONG = 900_000;

/**
 * Every call may wait that long by default: one that is quick by itself (a picture, a lookup in the
 * open project) still waits in the app behind a rebuild that is running, and used to give up there.
 */
async function call<T = unknown>(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs = LONG): Promise<T> {
  const project = addressed.getStore();
  if (project !== undefined && params[PROJECT_PARAM] === undefined) params = { ...params, [PROJECT_PARAM]: project };
  const info = server.server.getClientVersion();
  const send = () => bridge.call<T>(method, params, timeoutMs, info?.title ?? info?.name ?? "Assistant");
  try {
    return await send();
  } catch (e) {
    // The app is not running (or not connected): open it, so the user sees the work, and try once more.
    if (!(e instanceof Error) || e.message !== NOT_CONNECTED) throw e;
    await ensureApp();
    return send();
  }
}

/** The app reads and writes the files this server may not reach (see localFiles). */
const appFiles: AppFiles = {
  read: async (path) => Buffer.from((await call<{ base64: string }>("read_file", { path }, 40_000)).base64, "base64"),
  write: async (path, data) => void (await call("write_file", { path, base64: Buffer.from(data).toString("base64") }, 40_000)),
};
const readFile = (path: string) => readLocal(path, appFiles);
const writeFile = (path: string, data: Uint8Array) => writeLocal(path, data, appFiles);
const resolve = localPath;

/** The names of an export's files. */
const namesOf = (r: ExportedFiles) => [...Object.keys(r.files), ...Object.keys(r.staged?.sizes ?? {})];

/**
 * Hands each file of an export to `each`; big exports wait in the app (see STAGE_OVER) and are
 * fetched piece by piece, each file whole before the next.
 */
async function eachFile(r: ExportedFiles, each: (name: string, data: Buffer) => Promise<void>): Promise<void> {
  for (const [name, b64] of Object.entries(r.files)) await each(name, Buffer.from(b64, "base64"));
  const st = r.staged;
  if (!st) return;
  try {
    const parts = new Map<string, Buffer[]>();
    for (const pieces of stagedRequests(st.sizes)) {
      const { data } = await call<{ data: string[] }>("staged_files", { token: st.token, pieces });
      for (const [i, piece] of pieces.entries()) {
        const got = [...(parts.get(piece.name) ?? []), Buffer.from(data[i] ?? "", "base64")];
        if (piece.offset + piece.length < st.sizes[piece.name]!) parts.set(piece.name, got);
        else {
          parts.delete(piece.name);
          await each(piece.name, Buffer.concat(got));
        }
      }
    }
  } finally {
    await call("staged_files", { token: st.token, done: true }).catch(() => undefined);
  }
}

// Compact JSON: indenting doubled the size of every answer (and with it the tokens an assistant pays for).
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
/** True once meerCAD was updated under this running server (see staleServer). */
const stale = staleCheck(fileURLToPath(import.meta.url));
const withStaleNote = <R extends { content: unknown[] }>(r: R): R => (stale() ? { ...r, content: [...r.content, { type: "text", text: STALE_NOTE }] } : r);

const guard =
  <A,>(fn: (a: A) => Promise<ReturnType<typeof text> | { content: unknown[] }>) =>
  async (a: A) => {
    try {
      return withStaleNote((await fn(a)) as ReturnType<typeof text>);
    } catch (e) {
      return withStaleNote({ ...text(e instanceof Error ? e.message : String(e)), isError: true });
    }
  };

/**
 * Ops may name a local file in `path` instead of carrying its contents: this server runs on the
 * user's computer, so it reads the file before the ops reach the app.
 * - import features: fills in `data`, `fileName` and `format` (from the extension); 3MF and OBJ
 *   meshes go in as STL, one feature per object (ids get a suffix from the second one on);
 * - set_reference: reads the .glb;
 * - replace {path}: the design in a .meercad file becomes the document;
 * - add_features {path, ids?}: adds that file's features (only `ids`, in the file's order, if given).
 */
async function inlineImportFiles(ops: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const inline = async (f: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    if (f["op"] !== "import" || typeof f["path"] !== "string") return [f];
    const path = resolve(f["path"]);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (e) {
      throw new Error(`import ${String(f["id"] ?? "")}: ${e instanceof Error ? e.message : String(e)}`);
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
  const fromFile = async (o: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = o["reference"] as Record<string, unknown> | undefined;
    if (o["type"] === "set_reference" && r && typeof r["path"] === "string") {
      const { path: _p, ...rest } = r;
      return { ...o, reference: { ...rest, data: (await readFile(r["path"])).toString("base64") } };
    }
    if ((o["type"] !== "replace" && o["type"] !== "add_features" && o["type"] !== "save_version") || typeof o["path"] !== "string") return o;
    const file = resolve(o["path"]);
    const { doc } = meercadDocument(await readFile(file), file);
    const { path: _p, ids, ...rest } = o;
    if (o["type"] === "replace") return { ...rest, doc };
    // A backup brought back in: the file's design becomes a version (its own versions stay out).
    if (o["type"] === "save_version") return { ...rest, doc: { ...doc, versions: undefined, blobs: undefined } };
    const all = doc["features"] as Record<string, unknown>[];
    if (ids !== undefined && !(Array.isArray(ids) && ids.every((x) => typeof x === "string"))) throw new Error("add_features: ids must be a list of feature ids");
    const want = ids as string[] | undefined;
    const missing = (want ?? []).filter((id) => !all.some((f) => f["id"] === id));
    if (missing.length) throw new Error(`add_features: "${file}" has no feature ${missing.join(", ")}; it has ${all.map((f) => String(f["id"])).join(", ")}`);
    return { ...rest, features: want ? all.filter((f) => want.includes(String(f["id"]))) : all };
  };
  ops = await Promise.all(ops.map(fromFile));
  return Promise.all(
    ops.map(async (o) => (o["type"] === "add_features" && Array.isArray(o["features"]) ? { ...o, features: (await Promise.all((o["features"] as Record<string, unknown>[]).map(inline))).flat() } : o)),
  );
}

const server = new McpServer(
  { name: "meercad", version: "0.1.0" },
  {
    instructions:
      "Parametric CAD. Call get_guide once before modelling; change the model only with apply_ops (or preview_ops to try ideas). Open the project you work on with open_project / new_project: it gets a tab of its own, locked for the user, who keeps working in their other tabs; close_project releases the lock and hands the project back. Several chats may share this connection, and meerCAD cannot tell them apart: one project is open per connection at a time, so while another chat works on one, opening a project is refused (the answer says which and how it is freed). Pass the project's id as `project` with every call (open_project, new_project and open_example return it), and call close_project when you are done so other chats can work.",
  },
);

/**
 * Tools that act on the open project take `project` (its id, see PROJECT_PARAM): one server can
 * serve several chats at once, and the app sends each call to the tab of the project it names.
 * Lookups and the tools that open a project do without.
 */
/**
 * How long a tool call may take before it answers that the work goes on (see patience): below the
 * ~80 s after which some clients give up and restart this server. MEERCAD_MCP_ANSWER_MS for tests.
 */
const ANSWER_WITHIN_MS = (() => {
  const v = Number(process.env["MEERCAD_MCP_ANSWER_MS"]);
  return Number.isFinite(v) && v >= 100 ? v : 50_000;
})();
const patience = createPatience({ answerWithinMs: ANSWER_WITHIN_MS, keepMs: 10 * 60_000 });
const stillWorking = (tool: string, ms: number) =>
  text({
    stillWorking: true,
    tool,
    seconds: Math.round(ms / 1000),
    note: `meerCAD is still working on this ${tool} call (big designs take a while). It keeps running and your project stays open in your tab: call ${tool} again with exactly the same arguments to get its result (that waits for this run instead of starting another one). Calls to other tools wait until it is done.`,
  });
const UNADDRESSED = new Set(["get_guide", "gear_calc", "insert_sizes", "list_projects", "open_project", "new_project", "list_examples", "open_example", "list_folders", "create_folder"]);
const projectParam = z.string().min(1).optional().describe("Id of the project this call acts on (open_project, new_project and open_example return it). Pass it every time: other chats may work in other projects over the same connection. Without it, the call goes to your only open project.");
{
  type Handler = (...a: unknown[]) => unknown;
  type Config = { inputSchema?: Record<string, unknown> } & Record<string, unknown>;
  const register = server.registerTool.bind(server) as unknown as (name: string, config: Config, cb: Handler) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) => {
    const takes = !!config.inputSchema;
    // Every call answers in time (see patience); the same call again picks up its result.
    const patiently = (args: unknown, run: () => unknown) => patience.run(callKey(name, args), async () => run(), (ms) => stillWorking(name, ms));
    if (UNADDRESSED.has(name)) return register(name, config, (...a) => patiently(takes ? a[0] : {}, () => cb(...a)));
    // A tool without input gets its handler called with (extra) only, one with input with (args, extra).
    return register(name, { ...config, inputSchema: { ...config.inputSchema, [PROJECT_PARAM]: projectParam } }, (args, extra) => {
      const { [PROJECT_PARAM]: project, ...rest } = args as Record<string, unknown>;
      return patiently(args, () => addressed.run(typeof project === "string" ? project : undefined, () => (takes ? cb(rest, extra) : cb(extra))));
    });
  };
}

const op = z.record(z.string(), z.unknown()).describe("One Operations-API op, see get_guide");
const selector = z.record(z.string(), z.unknown());

/**
 * Points as plain arrays of numbers with a fixed length, never z.tuple: a tuple becomes a JSON
 * Schema with `items` as a list (draft 7), which MCP clients reject ("items must be
 * object,boolean"), and they then refuse the whole tool.
 */
const vec3 = z.array(z.number()).length(3);
const vec2 = z.array(z.number()).length(2);

const view = z.enum(["iso", "front", "back", "left", "right", "top", "bottom"]);
const shot = {
  view: view.optional(),
  direction: vec3.optional().describe("Where the camera is, seen from the model (Z up, front is -Y), e.g. [-1,-1,0.6] from front-left above, [0,0,-1] from below; overrides view"),
  focus: z.array(z.string()).optional().describe("Part ids to zoom onto"),
  isolate: z.boolean().optional().describe("With focus: hide all other parts"),
  section: z
    .object({ plane: z.enum(["XY", "XZ", "YZ"]).optional(), normal: vec3.optional(), offset: z.number().optional() })
    .optional()
    .describe("Cut the model open: the side the normal points to is removed; the cut faces show red. offset moves the plane along its normal (mm)"),
  highlight: z.object({ parts: z.array(z.string()).optional(), faces: z.array(selector).optional() }).optional().describe("Parts drawn orange, faces (selectors) drawn as selected (blue)"),
  frame: z
    .object({ min: vec3, max: vec3 })
    .optional()
    .describe("Fixed region to frame (mm), instead of fitting the parts as they are posed: pictures of a series line up"),
};

const lookShape = z.object({ ...shot, width: z.number().int().min(64).max(2048).optional(), height: z.number().int().min(64).max(2048).optional() }).strict();
/** apply_ops / preview_ops `look`: the picture of the result comes with the answer, one call instead of two. */
const look = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Also return a picture of the result: render_view's options (e.g. {view:\"iso\"}, default 800×600); saves a render_view call");

/** The answer to apply_ops / preview_ops, with the picture asked for in `look`. */
async function changed(method: "apply_ops" | "preview_ops", ops: Record<string, unknown>[], detail: string | undefined, shotArgs: Record<string, unknown> | undefined) {
  // Checked first (a bad look must not leave the ops applied with an error), here: the tool's schema keeps it a plain object so the tool list stays short.
  const parsed = shotArgs ? lookShape.safeParse(shotArgs) : null;
  if (parsed && !parsed.success) throw new Error(`look: ${parsed.error.issues.map((i) => `${i.path.join(".") || "look"}: ${i.message}`).join("; ")} (render_view's options); nothing was changed`);
  const result = await call(method, { ops: await inlineImportFiles(ops), detail }, LONG);
  if (!parsed) return text(result);
  try {
    const r = await call<{ png: string }>("render_view", { width: 800, height: 600, ...parsed.data });
    return { content: [text(result).content[0]!, { type: "image" as const, data: r.png, mimeType: "image/png" }] };
  } catch (e) {
    // The change went through: say so, and why there is no picture.
    return { content: [text(result).content[0]!, { type: "text" as const, text: `no picture: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

server.registerTool(
  "get_guide",
  {
    title: "Modelling guide",
    description:
      "How meerCAD documents, sketches, features, face tags and selectors work. Read before editing. Without `schema` it returns the guide and the names of all ops; `schema: [names]` returns the exact JSON Schema of those ops and features (e.g. [\"extrude\", \"set_motion\"]), `schema: [\"all\"]` all of them (long).",
    inputSchema: { schema: z.array(z.string()).optional().describe("Op or feature names whose JSON Schema you want, or [\"all\"]") },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ schema }) => {
    if (schema?.length) return text(schemaFor(schema));
    return text(`${GUIDE_TEXT.replace("The user previews your changes before accepting them.", "")}\n\nOps (type): ${OP_NAMES.join(", ")}\nFeatures (op): ${FEATURE_NAMES.join(", ")}\nFor the exact fields of any of them call get_guide {schema:[names]}.\n\n${MCP_NOTES}`);
  }),
);

server.registerTool(
  "get_model",
  {
    title: "Current model",
    description:
      "The open project: document (params + features), rebuild status per feature, bodies with volume and bounding box, sketch degrees of freedom. Embedded files (imported meshes, pictures, terrains) are left out as \"…elided:<n> chars…\"; ops may send such a placeholder back unchanged to keep the value. full: true returns them whole.",
    inputSchema: { full: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ full }) => text(await call("get_model", { full }, LONG))),
);

server.registerTool(
  "get_sketch",
  { title: "Solved sketch", description: "Solved geometry of a sketch: points, curves, closed regions (keys usable in extrude profiles), DOF and conflicts.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
  guard(async ({ id }) => text(await call("get_sketch", { id }, LONG))),
);

server.registerTool(
  "apply_ops",
  {
    title: "Change the model",
    description:
      "Applies Operations-API ops atomically as one undo step and returns the rebuild result; rejected ops leave the model unchanged. Ops: add_features, edit_feature, delete_feature, move_feature, set_param, rename_param, set_rollback; parts: set_material, set_part_color, set_see_through, set_part_list (folders, order), set_units, set_fit (the design's fit: gap per side for printed fits, usable as `fit` in every expression); joints: set_joint, delete_joint, set_coupling, delete_coupling, set_motion, delete_motion (moves of several joints over time); reference models (terrains, scans): set_reference, delete_reference; variants: set_variant, delete_variant, use_variant; versions: save_version, restore_version, rename_version, delete_version (save_version may give `path`, a .meercad file such as a version saved with export, to bring that file's design in as a version; the design stays as it is); replace (whole document; saved versions are kept). The changes apply at once (no confirmation step), undo reverts them. An import feature may give `path` (a file on this computer) instead of base64 `data`, a reference may give `path` (a .glb) instead of `data`; replace may give `path` (a .meercad file) instead of `doc`, add_features may give `path` (a .meercad file, or a .json file with a list of features) instead of `features` to add that file's features (`ids`: only these, in the file's order). The result is brief: steps that are not ok, new or changed bodies, the sketches of the edited steps, the joints and params set; detail \"full\" lists everything. Put everything you already know into one call (a whole part: its sketches, features and joints): each call costs a round trip. `look` returns a picture of the result with the answer (instead of a render_view call after it).",
    inputSchema: { ops: z.array(op).min(1), detail: z.enum(["brief", "full"]).optional(), look },
  },
  guard(async ({ ops, detail, look }) => changed("apply_ops", ops, detail, look)),
);

server.registerTool(
  "preview_ops",
  {
    title: "Try changes",
    description: "Shows the model with the ops applied as a live preview in the app (not saved) and returns the rebuild result (brief like apply_ops; detail \"full\" lists everything). Use to try ideas; then apply_ops to keep them or clear_preview.",
    inputSchema: { ops: z.array(op).min(1), detail: z.enum(["brief", "full"]).optional(), look },
  },
  guard(async ({ ops, detail, look }) => changed("preview_ops", ops, detail, look)),
);

server.registerTool("clear_preview", { title: "Clear preview", description: "Removes a preview shown by preview_ops." }, guard(async () => text(await call("clear_preview"))));

server.registerTool("undo", { title: "Undo", description: "Undoes the last change." }, guard(async () => text(await call("undo", {}, LONG))));
server.registerTool("redo", { title: "Redo", description: "Redoes the last undone change." }, guard(async () => text(await call("redo", {}, LONG))));

server.registerTool("list_projects", { title: "List projects", description: "Saved projects (id, name, last change).", annotations: { readOnlyHint: true } }, guard(async () => text(await call("list_projects"))));
server.registerTool(
  "open_project",
  { title: "Open project", description: "Opens a saved project by id (see list_projects) for this session. It opens in a meerCAD tab of your own in the background, locked for the user, so they keep working in their other tabs (they can watch yours any time); a project the user has open in a tab moves over to yours. Pass its id as `project` with your later calls; before one is open, only lookups work. One project is open per connection at a time: while another chat (or this one) has one open, this is refused with who holds it; close_project frees it.", inputSchema: { id: z.string() } },
  guard(async ({ id }) => text(await call("open_project", { id }, LONG))),
);
server.registerTool(
  "close_project",
  {
    title: "Close project (release the lock)",
    description: "Releases the lock on this session's project and hands it back to the user (ends the assistant mode for it, unlocks it): it is saved, your meerCAD tab closes and the project opens unlocked in a tab of theirs. Call it when you are done with a project, wait for the user, or the user asks you to release, unlock or give back the project (a tab with no requests for 30 minutes goes back to them on its own). open_project to work on it again later.",
  },
  guard(async () => text(await call("close_project"))),
);
server.registerTool(
  "new_project",
  { title: "New project", description: "Creates and opens an empty project for this session (in a tab of your own, see open_project).", inputSchema: { name: z.string().optional(), keep: z.boolean().optional().describe("WIP test build only: true saves the new project in the user's projects; without it, it goes to the build's own test folder (never in the user's list) so test runs leave nothing behind") } },
  guard(async ({ name, keep }) => text(await call("new_project", { name, keep }))),
);


server.registerTool(
  "render_view",
  {
    title: "Look at the model",
    description:
      "Renders the model as a PNG to check the result: from a standard view or any direction, zoomed onto parts (focus, isolate), cut open by a plane (section, cut faces red) and with parts or faces highlighted. Moving parts show in their current pose (set_pose); joint symbols and other editing aids are left out. Does not move the user's camera. style \"rendered\" makes a presentable picture: parts in their materials (set_material) under studio light with a soft shadow on a ground, no edges; with path the PNG is also written to that file (up to 4096 px a side).",
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
    const out = path ? await writeFile(path, Buffer.from(r.png, "base64")) : null;
    return { content: [{ type: "image", data: r.png, mimeType: "image/png" }, ...(out ? [{ type: "text" as const, text: `wrote ${out}` }] : [])] };
  }),
);

server.registerTool(
  "render_motion",
  {
    title: "Watch a motion",
    description:
      "Moves one joint from `from` to `to` (default: its limits, a full turn, or ±20 mm), or plays a motion (`motion`: several joints over time, see set_motion), and returns the poses as one contact-sheet PNG, each frame labelled with the joint value or the time; frames where parts overlap get a red border naming them (collisions: false skips that check, faster). With `video.path` it also writes an animated GIF there (for people to watch; a motion's GIF runs in its own time). One framing for all frames. Takes the same picture options as render_view. The joints go back where they were.",
    inputSchema: {
      joint: z.string().optional(),
      motion: z.string().optional().describe("A motion's id instead of a joint"),
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
    const r = await call<{ png: string; frames: unknown; gif?: string }>("render_motion", { ...a, ...(video ? { video: { frames: video.frames, width: video.width, height: video.height } } : {}) }, LONG);
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
    const r = await call<{ file: string; png: string; scale: string; paper: string; views: string[]; parts: unknown[] }>("drawing", a, LONG);
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
      "Exports the model (stl, 3mf, obj, step, usdz) or a sketch (dxf, svg; needs sketch) to a file path on this computer, as the app's own export does: the parts not hidden (or `parts`), with their names, colours and materials (3mf: plain named parts by default, as the app's setting is off, so slicers import it without asking to map filaments; materials: true adds materials and colours and assigns parts with different materials or colours to different filaments, slots, for multi-material slicers; usdz is for AR Quick Look on iPhone and iPad: real size, standing on its lowest point), moved parts where they are shown (posed: false takes them at rest). obj also takes the visible terrains and scans with their textures: their .mtl and pictures are written next to the .obj. variants: true writes one file per variant into the folder of `path` (named after the project and variant). meercad writes the whole project with its saved versions; with `version` only that saved version, as a project file of its own (a backup kept outside the app; apply_ops save_version with `path` brings it back in as a version, and any meerCAD opens it as a project).",
    inputSchema: {
      format: z.enum(["stl", "3mf", "obj", "step", "usdz", "dxf", "svg", "meercad"]),
      path: z.string().describe("Absolute or relative output path"),
      sketch: z.string().optional(),
      parts: z.array(z.string()).optional().describe("Part ids; default every part not hidden"),
      posed: z.boolean().optional(),
      variants: z.boolean().optional(),
      materials: z.boolean().optional().describe("3mf: include materials, colours and filament slots (default: the app's setting, off)"),
      version: z.string().optional().describe("meercad: write only this saved version (see versions in get_model)"),
    },
  },
  guard(async ({ format, path, sketch, parts, posed, variants, materials, version }) => {
    const out = resolve(path);
    const name = basename(out).replace(/\.[^.]+$/, "");
    const r = await call<ExportedFiles & { filaments?: { slot: number; material?: string; color: string }[]; cablesLeftOut?: string[] }>("export", { format, sketch, parts, posed, variants, name, materials, version, stage: true });
    const count = namesOf(r).length;
    const written: string[] = [];
    await eachFile(r, async (file, data) => {
      // One file goes to `path`; the main file of several goes there and the rest next to it.
      const main = count === 1 || (!variants && file.toLowerCase().endsWith(`.${format}`));
      const target = main && !variants ? out : join(variants ? (extname(out) ? dirname(out) : out) : dirname(out), file);
      await writeFile(target, data);
      written.push(target);
    });
    const left = r.cablesLeftOut?.length ? `; cables left out (not printed; name them in parts to export them): ${r.cablesLeftOut.length}` : "";
    return text(`wrote ${written.join(", ")}${r.filaments?.length ? `; filaments: ${r.filaments.map((f) => `${f.slot} = ${f.material ?? "any"} ${f.color}`).join(", ")}` : ""}${left}`);
  }),
);

server.registerTool(
  "send_to_slicer",
  {
    title: "Open the model in a slicer",
    description:
      "Opens the model in a slicer installed on this Mac, ready to slice and print: the parts not hidden (or `parts`) as a 3MF, as the app's export makes it (materials as in export), moved parts where they are shown (posed: false takes them at rest). slicer: \"bambu\" (Bambu Studio) or \"prusa\" (PrusaSlicer); default the first installed, Bambu Studio before PrusaSlicer. The 3MF goes to a temporary file the app clears away later; use export for a file to keep. Fails when the slicer is not installed (only the Mac app can send).",
    inputSchema: {
      slicer: z.enum(["bambu", "prusa"]).optional(),
      parts: z.array(z.string()).optional().describe("Part ids; default every part not hidden"),
      posed: z.boolean().optional(),
      materials: z.boolean().optional().describe("Include materials, colours and filament slots (default: the app's setting, off)"),
    },
  },
  guard(async ({ slicer, parts, posed, materials }) => {
    const r = await call<{ slicer: string; file: string; moved: boolean; filaments?: { slot: number; material?: string; color: string }[]; cablesLeftOut?: string[] }>("send_to_slicer", { slicer, parts, posed, materials });
    const left = r.cablesLeftOut?.length ? `; cables left out (not printed): ${r.cablesLeftOut.length}` : "";
    return text(`opened ${r.file} in ${r.slicer}${r.moved ? " (moved parts where they are shown)" : ""}${r.filaments?.length ? `; filaments: ${r.filaments.map((f) => `${f.slot} = ${f.material ?? "any"} ${f.color}`).join(", ")}` : ""}${left}`);
  }),
);

server.registerTool(
  "export_robot",
  {
    title: "Export a robot for simulation",
    description:
      "Writes the design as a robot for physics simulation and robot learning into the folder `path`: <name>.xml (MJCF for MuJoCo and mjlab), <name>.urdf (ROS, Isaac Sim, PyBullet) and meshes/<part>.stl, in metres, kilograms and radians. Parts held together by fixed joints become one link; each revolute or slider joint becomes a joint with its limits; couplings become MJCF equalities and URDF mimic joints; each link gets mass, centre of gravity and inertia from its parts' materials. Each part collides as one simple shape (collision: \"shapes\", default): the box, cylinder or sphere of least volume around it, turned with the part, which Isaac Sim/PhysX and MuJoCo simulate fast and stably (the meshes stay the visuals); collision: \"mesh\" collides with the triangles instead. Links that hang on nothing get a free joint (floating: false fixes them). `masses` sets real grams per part (bought motors, printed parts with their infill). `actuators` gives drive data per joint id: effort (Nm or N), velocity (rad/s), kp and kv (then the MJCF gets a position actuator, else a torque motor), armature (kg·m²), damping, friction; joints without it stay passive. It takes the parts shown (see set_visibility) without cables, `parts` names the parts to take instead (cables too when named), `exclude` leaves more out; joints to a part left out go with it. Returns the links (name, parts, kg, parent, joint) and warnings (loops left out, parts without material, joints without drive data, parts their collision shape fits badly).",
    inputSchema: {
      path: z.string().describe("Folder to write into (created if missing)"),
      name: z.string().optional().describe("Model and file name; default the project's name"),
      floating: z.boolean().optional(),
      masses: z.record(z.string(), z.number().positive()).optional().describe("Grams per part id"),
      actuators: z
        .record(
          z.string(),
          z.object({ effort: z.number().positive().optional(), velocity: z.number().positive().optional(), kp: z.number().positive().optional(), kv: z.number().nonnegative().optional(), armature: z.number().nonnegative().optional(), damping: z.number().nonnegative().optional(), friction: z.number().nonnegative().optional() }),
        )
        .optional()
        .describe("Drive data per joint id"),
      collision: z.enum(["shapes", "mesh"]).optional().describe('What links collide with: "shapes" (default, one box/cylinder/sphere per part) or "mesh"'),
      parts: z.array(z.string()).optional().describe("Only these parts; default the parts shown, without cables"),
      exclude: z.array(z.string()).optional().describe("Parts to leave out"),
    },
  },
  guard(async ({ path, name, floating, masses, actuators, collision, parts, exclude }) => {
    const dir = resolve(path);
    const r = await call<ExportedFiles & { links: { name: string; parts: string[]; mass: number; parent: string | null; joint: string | null }[]; warnings: string[] }>("export_robot", { name, floating, masses, actuators, collision, parts, exclude, stage: true });
    const written: string[] = [];
    await eachFile(r, async (file, data) => {
      const target = join(dir, file);
      await writeFile(target, data);
      if (!file.startsWith("meshes/")) written.push(target);
    });
    const meshes = namesOf(r).filter((f) => f.startsWith("meshes/")).length;
    return text({ wrote: written, meshes: `${meshes} STL files in ${join(dir, "meshes")}`, links: r.links, warnings: r.warnings });
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
  guard(async ({ a, b }) => text(await call("measure", { a, b }, LONG))),
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
  "insert_sizes",
  {
    title: "Heat-set insert sizes",
    description:
      "Heat-set threaded inserts for printed parts (M2–M10): the lengths each size comes in, the hole to melt it into, its outside, the thinnest wall around it, and from that the smallest boss diameter, edge distance and spacing. Use it to plan bosses and hole positions before adding a hole feature with kind \"insert\".",
    inputSchema: { size: z.string().optional().describe("One size, e.g. \"M3\"; default all") },
    annotations: { readOnlyHint: true },
  },
  async (a) => text(insertSizes(a)),
);

server.registerTool(
  "set_pose",
  {
    title: "Move a mechanism",
    description: "Sets joint values (degrees for revolute joints, mm for sliders; driven joints move their drivers, linkages follow) and shows the pose in the app. Returns the value of every joint that can move (fixed joints are only counted, in fixedLeftOut) and whether all were reached; a joint a limit or dead point stopped short is named in problems with where it stopped.",
    inputSchema: { values: z.record(z.string(), z.number()).describe("joint id → value") },
  },
  guard(async ({ values }) => text(await call("set_pose", { values }, LONG))),
);

server.registerTool(
  "check_clearance",
  {
    title: "Check clearance",
    description: "In the pose shown now: the gap between every moving part and the parts near it (mm), and the overlapping volume where they collide (mm³), with the wanted print-in-place gap (mechanism.clearance; default the design's fit, at least 0.3 mm). Parts held together by fixed joints never move against each other and are left out (check_interference finds overlaps at rest).",
    annotations: { readOnlyHint: true },
  },
  guard(async () => text(await call("check_clearance", {}, LONG))),
);

server.registerTool(
  "check_motion",
  {
    title: "Check a motion",
    description:
      "Moves one joint from `from` to `to` in `steps` (default 12), or runs a motion (`motion`, steps = frames over one run, default 24), and checks the gaps at each pose: for a joint the first value where parts touch (faces against each other: fused when printed in place) or overlap (collide), for a motion every pose where parts collide and every joint a limit held short. Parts held together by fixed joints are left out (they never move against each other; check_interference finds overlaps at rest); parts meeting at the joint they turn on only count when they overlap. Also the smallest gap per pair of parts and where. The joints go back where they were afterwards.",
    inputSchema: { joint: z.string().optional(), from: z.number().optional(), to: z.number().optional(), motion: z.string().optional(), steps: z.number().int().min(1).max(240).optional() },
    annotations: { readOnlyHint: true },
  },
  guard(async ({ joint, from, to, motion, steps }) => text(await call("check_motion", { joint, from, to, motion, steps }, LONG))),
);

server.registerTool(
  "play_motion",
  {
    title: "Play a motion",
    description: "Plays a motion (several joints over time, see set_motion) in the app so the user can watch it: a loop runs until stopped. motion null stops it.",
    inputSchema: { motion: z.string().nullable() },
  },
  guard(async ({ motion }) => text(await call("play_motion", { motion }))),
);

server.registerTool(
  "get_version",
  { title: "Look at a version", description: "A saved version's design (see the version names in get_model), without restoring it.", inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } },
  guard(async ({ name }) => text(await call("get_version", { name }))),
);

server.registerTool(
  "check_interference",
  {
    title: "Check for overlaps",
    description: "Every part against every other where they are modelled (no joints needed): pairs that overlap with the shared volume (mm³), and pairs that only touch. In a design of hundreds of parts narrow it: `parts` checks only pairs with one of these parts, `box` only the parts reaching into it. What is not checked after `seconds` (default 120) is counted in `unchecked` instead of waited for.",
    inputSchema: { parts: z.array(z.string()).optional(), box: z.object({ min: vec3, max: vec3 }).optional(), seconds: z.number().min(1).max(800).optional() },
    annotations: { readOnlyHint: true },
  },
  guard(async (a) => text(await call("check_interference", a, LONG))),
);

server.registerTool(
  "wall_thickness",
  {
    title: "Wall thickness",
    description: "Measures a part's walls (rays into the material from all over the surface) against the wall a printer needs (minWall, default 1 mm): the thinnest wall and where, and the share of the surface thinner than minWall. The colour map stays shown in the app (red thin → green) unless show: false.",
    inputSchema: { part: z.string(), minWall: z.number().positive().optional(), show: z.boolean().optional() },
  },
  guard(async (a) => text(await call("wall_thickness", a))),
);

server.registerTool(
  "print_check",
  {
    title: "Printability",
    description: "Checks how a part prints on an FDM printer as it stands (bed under its lowest point, -Z down): area hanging over more steeply than limit degrees from vertical (default 45), a rough support volume (mm³) and the area on the bed, plus the best way up found (least support). turn: \"best\" or a direction [x,y,z] that should face the bed turns the part first (added as move steps; it lands on Z = 0 where it stood). The colour map stays shown (red needs support, blue on the bed, green fine) unless show: false.",
    inputSchema: { part: z.string(), limit: z.number().min(0).max(89).optional(), show: z.boolean().optional(), turn: z.union([z.literal("best"), vec3]).optional() },
  },
  guard(async (a) => text(await call("print_check", a))),
);

server.registerTool(
  "deviation",
  {
    title: "Deviation from a mesh",
    description: "How far a part's surface is from a mesh part (e.g. the scan it was modelled after): smallest and largest distance (mm, negative inside) and the share within the tolerance. The colour map stays shown unless show: false.",
    inputSchema: { part: z.string(), mesh: z.string(), show: z.boolean().optional() },
  },
  guard(async (a) => text(await call("deviation", a))),
);

server.registerTool(
  "repair_mesh",
  {
    title: "Clean up a mesh",
    description: "Cleans up an imported mesh part (STL/3MF/OBJ/scan): removes loose pieces, closes holes, and with reduce (a tolerance in mm, e.g. 0.05) uses fewer triangles. One undo step; a scan's texture is dropped as it belongs to the old triangles.",
    inputSchema: { part: z.string(), removePieces: z.boolean().optional(), fillHoles: z.boolean().optional(), reduce: z.number().positive().optional() },
  },
  guard(async (a) => text(await call("repair_mesh", a))),
);

server.registerTool(
  "rebuild_mesh",
  { title: "Rebuild a mesh with features", description: "Fits sketches and extrudes to a mesh part (planes and cylinders it is made of) and adds them as editable steps with parameters; the mesh stays, hidden, to compare (deviation).", inputSchema: { part: z.string() } },
  guard(async (a) => text(await call("rebuild_mesh", a))),
);

server.registerTool(
  "measure_scan",
  {
    title: "Measure on a scan",
    description: "On a mesh part, fits the plane, cylinder, cone or sphere the surface follows at a point (within tolerance mm, default 0.1) and gives its sizes; with `other` (a second point, on the same or another part) also the distance and angle between the two shapes.",
    inputSchema: { part: z.string(), point: vec3, other: z.object({ part: z.string().optional(), point: vec3 }).optional(), tolerance: z.number().positive().optional() },
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
    description: "Imports a file from this computer as the app does: STEP/STL/3MF/OBJ as parts, DXF/SVG as a sketch on XY, a .meercad file as a new project (opened in this session's tab; no project needs to be open first). (apply_ops with an import feature and `path` also works for STEP/STL/3MF/OBJ; replace {path} and add_features {path, ids?} take the design or features of a .meercad file into the open project.)",
    inputSchema: { path: z.string(), keep: z.boolean().optional().describe("WIP test build only: true saves the new project in the user's projects; without it, it goes to the build's own test folder (never in the user's list) so test runs leave nothing behind") },
  },
  guard(async ({ path, keep }) => {
    const file = resolve(path);
    const data = await readFile(file);
    // A design comes in as it is saved (also from a wrapped {name, document} file).
    if ([".meercad", ".json"].includes(extname(file).toLowerCase())) {
      const { doc, name } = meercadDocument(data, file);
      return text(await call("import_file", { name: `${name ?? basename(file, extname(file))}.meercad`, base64: Buffer.from(JSON.stringify(doc)).toString("base64"), keep }));
    }
    return text(await call("import_file", { name: basename(file), base64: data.toString("base64"), keep }));
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
server.registerTool("list_examples", { title: "Examples", description: "The example designs that come with meerCAD (finished designs to open and change).", annotations: { readOnlyHint: true } }, guard(async () => text(await call("list_examples"))));
server.registerTool("open_example", { title: "Open an example", description: "Opens an example (id or name from list_examples) as a new project of its own (in a tab of your own, see open_project).", inputSchema: { id: z.union([z.number().int(), z.string()]), keep: z.boolean().optional().describe("WIP test build only: true saves the new project in the user's projects; without it, it goes to the build's own test folder (never in the user's list) so test runs leave nothing behind") } }, guard(async (a) => text(await call("open_example", a, LONG))));

server.registerTool(
  "terrain_height",
  { title: "Ground height", description: "The extent of the shown terrains (models from drone photos, scanned areas) and their ground heights at x/y points in design coordinates (mm); null where there is no terrain.", inputSchema: { points: z.array(vec2).max(500).optional() }, annotations: { readOnlyHint: true } },
  guard(async (a) => text(await call("terrain_height", a))),
);

server.registerTool(
  "place_on_terrain",
  { title: "Stand a part on the terrain", description: "Moves a part so its lowest point sits on the terrain: where it is, or at `at` (x/y, mm), raised by `offset` mm. One undo step (a move step).", inputSchema: { part: z.string(), at: vec2.optional(), offset: z.number().optional() } },
  guard(async (a) => text(await call("place_on_terrain", a))),
);

server.registerTool(
  "photo_terrain",
  { title: "Terrain from drone photos", description: "Builds a textured terrain model from a folder of overlapping photos on this Mac (Apple photogrammetry; true size and north from their GPS) and adds it to the open design. Takes several minutes; the app shows progress.", inputSchema: { folder: z.string() } },
  guard(async ({ folder }) => text(await call("photo_terrain", { folder: resolve(folder) }, 3_600_000))),
);

server.registerTool(
  "status",
  { title: "Connection status", description: "Whether the meerCAD app is connected, which project this session works on (and whether in its own tab or the user's), and the newest projects (list_projects lists all).", annotations: { readOnlyHint: true } },
  guard(async () => {
    let st = await bridge.status();
    // Not connected: open the app (if this server knows which) and wait for it.
    if (!st.connected && st.role !== "starting" && (await launcher.ensure()).connected) st = await bridge.status();
    if (!st.connected) return text({ connected: false, hint: `Open meerCAD and enable 'Allow assistants to control meerCAD' (plug icon). ${st.role === "peer" ? "Another assistant session's meerCAD MCP server holds the connection; requests go through it." : `Listening on ws://127.0.0.1:${port}.`}` });
    try {
      return text({ connected: true, ...(await call<Record<string, unknown>>("get_status")) });
    } catch {
      return text({ connected: true, ...st.hello });
    }
  }),
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
