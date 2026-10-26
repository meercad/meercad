/**
 * opencad MCP server. Claude (or any MCP client) launches this over stdio; the running opencad app
 * connects to it over a local WebSocket and executes every tool call against the open document.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { SYSTEM_PROMPT } from "@opencad/ai/prompt";
import { DEFAULT_PORT, type BridgeHello, type BridgeMethod, type BridgeResponse } from "./protocol.js";

const port = Number(process.env["OPENCAD_MCP_PORT"] ?? DEFAULT_PORT);
// Only the app may connect: browsers always send Origin, and web pages cannot forge it.
const extraOrigins = (process.env["OPENCAD_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const originAllowed = (origin: string | undefined) =>
  !origin || origin === "null" || origin.startsWith("file://") || origin.startsWith("app://") || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || extraOrigins.includes(origin);

const log = (...a: unknown[]) => console.error("[opencad-mcp]", ...a);

let app: WebSocket | null = null;
let hello: BridgeHello | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

const wss = new WebSocketServer({ host: "127.0.0.1", port, verifyClient: ({ origin }: { origin?: string }) => originAllowed(origin) });
wss.on("listening", () => log(`waiting for the opencad app on ws://127.0.0.1:${port}`));
wss.on("error", (e) => log(`bridge error: ${e.message}`));
wss.on("connection", (ws) => {
  app?.close(4000, "replaced by a newer connection");
  app = ws;
  ws.on("message", (raw) => {
    let msg: BridgeResponse | BridgeHello;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if ("hello" in msg) {
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
        p.reject(new Error("the opencad app disconnected"));
        pending.delete(id);
      }
    }
  });
});

function call<T = unknown>(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
  if (!app || app.readyState !== app.OPEN) {
    return Promise.reject(
      new Error(
        "The opencad app is not connected. Open opencad and enable 'Connect AI assistants (MCP)' in the toolbar menu, then try again.",
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
    app!.send(JSON.stringify({ id, method, params }));
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

const server = new McpServer({ name: "opencad", version: "0.1.0" }, { instructions: "Parametric CAD. Call get_guide once before modelling; change the model only with apply_ops (or preview_ops to try ideas)." });

const op = z.record(z.string(), z.unknown()).describe("One Operations-API op, see get_guide");
const selector = z.record(z.string(), z.unknown());

server.registerTool("get_guide", { title: "Modelling guide", description: "How opencad documents, sketches, features, face tags and selectors work, with the JSON Schema of every op. Read before editing." }, async () => text(SYSTEM_PROMPT));

server.registerTool(
  "get_model",
  { title: "Current model", description: "The open project: document (params + features), rebuild status per feature, bodies with volume and bounding box, sketch degrees of freedom.", annotations: { readOnlyHint: true } },
  guard(async () => text(await call("get_model"))),
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
    description: "Applies Operations-API ops atomically as one undo step (add_features, edit_feature, delete_feature, move_feature, set_param, rename_param, set_rollback, replace) and returns the rebuild result. Rejected ops leave the model unchanged.",
    inputSchema: { ops: z.array(op).min(1) },
  },
  guard(async ({ ops }) => text(await call("apply_ops", { ops }))),
);

server.registerTool(
  "preview_ops",
  { title: "Try changes", description: "Rebuilds the model with the ops applied in a sandbox without changing it. Use to check an idea before apply_ops.", inputSchema: { ops: z.array(op).min(1) }, annotations: { readOnlyHint: true } },
  guard(async ({ ops }) => text(await call("preview_ops", { ops }))),
);

server.registerTool("undo", { title: "Undo", description: "Undoes the last change." }, guard(async () => text(await call("undo"))));
server.registerTool("redo", { title: "Redo", description: "Redoes the last undone change." }, guard(async () => text(await call("redo"))));

server.registerTool("list_projects", { title: "List projects", description: "Saved projects (id, name, last change).", annotations: { readOnlyHint: true } }, guard(async () => text(await call("list_projects"))));
server.registerTool(
  "open_project",
  { title: "Open project", description: "Opens a saved project by id.", inputSchema: { id: z.string() } },
  guard(async ({ id }) => text(await call("open_project", { id }))),
);
server.registerTool(
  "new_project",
  { title: "New project", description: "Creates and opens an empty project.", inputSchema: { name: z.string().optional() } },
  guard(async ({ name }) => text(await call("new_project", { name }))),
);

server.registerTool(
  "render_view",
  {
    title: "Look at the model",
    description: "Renders the current model as a PNG from a standard view, for visual checks.",
    inputSchema: { view: z.enum(["iso", "front", "back", "left", "right", "top", "bottom"]).optional(), width: z.number().int().min(64).max(2048).optional(), height: z.number().int().min(64).max(2048).optional() },
    annotations: { readOnlyHint: true },
  },
  guard(async (a) => {
    const r = await call<{ png: string }>("render_view", a);
    return { content: [{ type: "image", data: r.png, mimeType: "image/png" }] };
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
    description: "Exports the model (stl, 3mf, step) or a sketch (dxf, svg; needs sketch) to a file path on this computer.",
    inputSchema: { format: z.enum(["stl", "3mf", "step", "dxf", "svg", "ocad"]), path: z.string().describe("Absolute or relative output path"), sketch: z.string().optional() },
  },
  guard(async ({ format, path, sketch }) => {
    const r = await call<{ base64: string }>("export", { format, sketch });
    const out = resolve(path);
    const data = Buffer.from(r.base64, "base64");
    await writeFile(out, data);
    return text(`wrote ${data.length} bytes to ${out}`);
  }),
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

server.registerTool("status", { title: "Connection status", description: "Whether the opencad app is connected and which project is open.", annotations: { readOnlyHint: true } }, async () =>
  text(app ? { connected: true, ...hello } : { connected: false, hint: `Open opencad and enable 'Connect AI assistants (MCP)'. Listening on ws://127.0.0.1:${port}.` }),
);

await server.connect(new StdioServerTransport());
log("MCP server ready on stdio");
