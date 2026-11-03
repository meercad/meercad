/**
 * Drives the running Mac app for hands-on test runs (docs/TESTING.md): start it with
 *   open -a "meerCAD WIP" --args --remote-debugging-port=9333
 * then
 *   node scripts/drive-app.mjs eval "<js run in the app's window>"
 *   node scripts/drive-app.mjs shot screen.png
 */
import { writeFileSync } from "node:fs";
const list = await (await fetch("http://localhost:9333/json")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let n = 0;
const call = (method, params = {}) => new Promise((resolve) => {
  const id = ++n;
  const on = (e) => { const m = JSON.parse(e.data); if (m.id === id) { ws.removeEventListener("message", on); resolve(m); } };
  ws.addEventListener("message", on);
  ws.send(JSON.stringify({ id, method, params }));
});
const [cmd, arg] = process.argv.slice(2);
if (cmd === "eval") {
  const r = await call("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 1));
} else if (cmd === "shot") {
  const r = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log("saved", arg);
}
ws.close();
