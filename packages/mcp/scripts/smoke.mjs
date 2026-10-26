// Drives a running leocad app through the MCP server like an assistant would.
// Usage: node scripts/smoke.mjs   (open the app with the MCP bridge enabled first)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";

const client = new Client({ name: "smoke", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [new URL("../dist/server.js", import.meta.url).pathname] }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content[0];
  if (r.isError) throw new Error(`${name}: ${t.text}`);
  return t.type === "text" ? t.text : t;
};
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("tools:", tools.join(", "));
for (let i = 0; i < 40 && !JSON.parse(await call("status")).connected; i++) await new Promise((r) => setTimeout(r, 500));
console.log("status:", await call("status"));
console.log("new_project:", await call("new_project", { name: "MCP smoke test" }));
const rect = [
  { id: "p1", type: "point", x: 0, y: 0 }, { id: "p2", type: "point", x: 30, y: 0 }, { id: "p3", type: "point", x: 30, y: 20 }, { id: "p4", type: "point", x: 0, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" }, { id: "l2", type: "line", p1: "p2", p2: "p3" }, { id: "l3", type: "line", p1: "p3", p2: "p4" }, { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const applied = JSON.parse(await call("apply_ops", { ops: [
  { type: "set_param", name: "h", expr: "12 mm" },
  { type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "h", mode: "new_body" },
    { id: "fi1", op: "fillet", edges: { select: "edges", of: "ex1", where: { face: "end_cap" } }, radius: 2 },
  ] },
] }));
console.log("apply_ops:", applied.features.map((f) => `${f.id}:${f.status}`).join(" "), "volume", applied.bodies[0].volume);
const bad = await client.callTool({ name: "apply_ops", arguments: { ops: [{ type: "delete_feature", id: "nope" }] } });
console.log("bad op rejected:", bad.isError, bad.content[0].text);
console.log("measure:", await call("measure", { a: { face: "ex1.end_cap" }, b: { face: "ex1.start_cap" } }));
const img = await call("render_view", { view: "iso", width: 400, height: 300 });
writeFileSync("/tmp/leocad-smoke.png", Buffer.from(img.data, "base64"));
console.log("render_view: png", img.data.length, "b64 chars");
console.log("export:", await call("export", { format: "step", path: "/tmp/leocad-smoke.step" }));
console.log("undo:", JSON.parse(await call("undo")).features.length, "features after undo");
await client.close();
process.exit(0);
