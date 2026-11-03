/**
 * Drives the running Mac app for hands-on test runs (docs/TESTING.md): start it with
 *   "/Applications/meerCAD WIP.app/Contents/MacOS/meerCAD WIP" --remote-debugging-port=9334
 * (PORT selects another port), keep its window in front (a hidden window answers input slowly), then
 *   node scripts/drive-app.mjs eval "<js run in the app's window>"
 *   node scripts/drive-app.mjs shot screen.png
 *   node scripts/drive-app.mjs clicks x y [x y …]   (window pixels, several clicks in one session)
 *   node scripts/drive-app.mjs rclick x y | drag x y x y … | key Enter | type "text"
 */
import { writeFileSync } from "node:fs";
const list = await (await fetch(`http://localhost:${process.env.PORT ?? 9334}/json`)).json();
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
} else if (cmd === "click" || cmd === "rclick") {
  // CSS pixels of the window, as getBoundingClientRect gives them.
  const [x, y] = [Number(arg), Number(process.argv[4])];
  const button = cmd === "click" ? "left" : "right";
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1, buttons: button === "left" ? 1 : 2 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
  console.log(cmd, x, y);
} else if (cmd === "clicks") {
  // Several left clicks in one session: x y x y …, a moment apart.
  const xs = process.argv.slice(3).map(Number);
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const [x, y] = [xs[i], xs[i + 1]];
    await call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await new Promise((r) => setTimeout(r, 700));
  }
} else if (cmd === "drag") {
  // A held-down left drag through x y x y …
  const xs = process.argv.slice(3).map(Number);
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: xs[0], y: xs[1], buttons: 0 });
  await call("Input.dispatchMouseEvent", { type: "mousePressed", x: xs[0], y: xs[1], button: "left", buttons: 1, clickCount: 1 });
  for (let i = 2; i + 1 < xs.length; i += 2) {
    const [x0, y0, x1, y1] = [xs[i - 2], xs[i - 1], xs[i], xs[i + 1]];
    for (let k = 1; k <= 10; k++) {
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * k) / 10, y: y0 + ((y1 - y0) * k) / 10, button: "left", buttons: 1 });
      await new Promise((r) => setTimeout(r, 16));
    }
  }
  const [x, y] = xs.slice(-2);
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
} else if (cmd === "type") {
  await call("Input.insertText", { text: arg });
} else if (cmd === "key") {
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: arg, code: arg, windowsVirtualKeyCode: arg === "Escape" ? 27 : arg === "Enter" ? 13 : 0 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: arg, code: arg });
} else if (cmd === "shot") {
  const r = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(arg, Buffer.from(r.result.data, "base64"));
  console.log("saved", arg);
}
ws.close();
