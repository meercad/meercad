/**
 * leocad MCP server. Claude (or any MCP client) launches this over stdio; the running leocad app
 * connects to it over a local WebSocket and executes every tool call against the open document.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import { SYSTEM_PROMPT } from "@leocad/ai/prompt";
import { DEFAULT_PORT, type BridgeHello, type BridgeMethod, type BridgeResponse } from "./protocol.js";

const port = Number(process.env["LEOCAD_MCP_PORT"] ?? DEFAULT_PORT);
// Only the app may connect: browsers always send Origin, and web pages cannot forge it.
const extraOrigins = (process.env["LEOCAD_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const originAllowed = (origin: string | undefined) =>
  !origin || origin === "null" || origin.startsWith("file://") || origin.startsWith("app://") || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || extraOrigins.includes(origin);

const log = (...a: unknown[]) => console.error("[leocad-mcp]", ...a);

let app: WebSocket | null = null;
let hello: BridgeHello | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

/** True while another process holds the bridge port; we keep retrying until it is free. */
let portBusy = false;

/**
 * Several clients may start this server at once (e.g. a chat and a coding session); only one can own
 * the port. The others retry, so whichever is left takes over when the owner exits.
 */
function startBridge(): void {
  const wss = new WebSocketServer({ host: "127.0.0.1", port, verifyClient: ({ origin }: { origin?: string }) => originAllowed(origin) });
  wss.on("listening", () => {
    portBusy = false;
    log(`waiting for the leocad app on ws://127.0.0.1:${port}`);
  });
  wss.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      if (!portBusy) log(`port ${port} is in use by another leocad MCP server; retrying`);
      portBusy = true;
      wss.close();
      setTimeout(startBridge, 2000).unref();
      return;
    }
    log(`bridge error: ${e.message}`);
  });
  wss.on("connection", onConnection);
}

function onConnection(ws: WebSocket): void {
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
        p.reject(new Error("the leocad app disconnected"));
        pending.delete(id);
      }
    }
  });
}

startBridge();

function call<T = unknown>(method: BridgeMethod, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
  if (!app || app.readyState !== app.OPEN) {
    return Promise.reject(
      new Error(
        "The leocad app is not connected. Open leocad and enable 'Connect AI assistants (MCP)' in the toolbar menu, then try again.",
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

const server = new McpServer({ name: "leocad", version: "0.1.0" }, { instructions: "Parametric CAD. Call get_guide once before modelling; change the model only with apply_ops (or preview_ops to try ideas)." });

const op = z.record(z.string(), z.unknown()).describe("One Operations-API op, see get_guide");
const selector = z.record(z.string(), z.unknown());

server.registerTool("get_guide", { title: "Modelling guide", description: "How leocad documents, sketches, features, face tags and selectors work, with the JSON Schema of every op. Read before editing." }, async () => text(SYSTEM_PROMPT));

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
  {
    title: "Try changes",
    description: "Shows the model with the ops applied as a live preview in the app (not saved) and returns the rebuild result. Use to try ideas; then apply_ops to keep them or clear_preview.",
    inputSchema: { ops: z.array(op).min(1) },
  },
  guard(async ({ ops }) => text(await call("preview_ops", { ops }))),
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
    inputSchema: { format: z.enum(["stl", "3mf", "step", "dxf", "svg", "leocad"]), path: z.string().describe("Absolute or relative output path"), sketch: z.string().optional() },
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

server.registerTool(
  "status",
  { title: "Connection status", description: "Whether the leocad app is connected, which project is open, and the available projects.", annotations: { readOnlyHint: true } },
  async () => {
    if (!app)
      return text({
        connected: false,
        hint: portBusy
          ? `Another leocad MCP server (e.g. from a different chat or session) is using port ${port}, so the app talks to that one. Close that session or restart this one; this server takes over as soon as the port is free.`
          : `Open leocad and enable 'Allow assistants to control leocad' (plug icon). Listening on ws://127.0.0.1:${port}.`,
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
