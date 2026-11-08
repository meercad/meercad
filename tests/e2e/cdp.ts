/**
 * A small Chrome DevTools Protocol client for the UI end-to-end run: real mouse and keyboard
 * events into the app's window, screenshots, and reading results back from the page.
 */
import { writeFileSync } from "node:fs";

type Pending = { ok: (v: any) => void; fail: (e: Error) => void };

export class Page {
  private n = 0;
  private pending = new Map<number, Pending>();
  /** Console errors and uncaught exceptions seen since the last `takeErrors()`. */
  errors: string[] = [];

  static async open(wsUrl: string): Promise<Page> {
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, fail) => (ws.addEventListener("open", ok), ws.addEventListener("error", fail)));
    return new Page(ws);
  }
  constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.pending.has(m.id)) {
        const { ok, fail } = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        m.error ? fail(new Error(`${m.error.message}`)) : ok(m.result);
      } else if (m.method === "Runtime.exceptionThrown") this.errors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
      else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") this.errors.push(m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
    });
  }
  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.n;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  takeErrors(): string[] {
    return this.errors.splice(0);
  }
  /** Runs `expr` (an expression, may await) in the page and returns its JSON value. */
  async eval<T = any>(expr: string): Promise<T> {
    const r = await this.call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  async move(x: number, y: number, buttons = 0): Promise<void> {
    await this.call("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons, ...(buttons ? { button: "left" } : {}) });
  }
  async click(x: number, y: number, { button = "left", count = 1 }: { button?: "left" | "right"; count?: number } = {}): Promise<void> {
    await this.move(x, y);
    // Hover and snapping follow the pointer on the next frame, as with a hand on the mouse.
    await sleep(60);
    for (let c = 1; c <= count; c++) {
      await this.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "left" ? 1 : 2, clickCount: c });
      await this.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: c });
    }
  }
  /** A held-down left drag through the points, in steps like a hand. */
  async drag(points: [number, number][], { modifiers = 0 } = {}): Promise<void> {
    const [x0, y0] = points[0]!;
    await this.move(x0, y0);
    await this.call("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1, modifiers });
    for (let i = 1; i < points.length; i++) {
      const [ax, ay] = points[i - 1]!;
      const [bx, by] = points[i]!;
      for (let k = 1; k <= 8; k++) await this.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: ax + ((bx - ax) * k) / 8, y: ay + ((by - ay) * k) / 8, button: "left", buttons: 1, modifiers });
    }
    const [xn, yn] = points.at(-1)!;
    await this.call("Input.dispatchMouseEvent", { type: "mouseReleased", x: xn, y: yn, button: "left", buttons: 0, clickCount: 1, modifiers });
  }
  /** One key: "Enter", "Escape", "Tab", "Backspace", a character, or with modifiers ("Meta+z"). */
  async key(spec: string): Promise<void> {
    const parts = spec.split("+");
    const key = parts.pop()!;
    const mods: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
    const modifiers = parts.reduce((m, p) => m | (mods[p] ?? 0), 0);
    const named: Record<string, [number, string]> = { Enter: [13, "\r"], Escape: [27, ""], Tab: [9, ""], Backspace: [8, ""], Delete: [46, ""], ArrowLeft: [37, ""], ArrowRight: [39, ""], ArrowUp: [38, ""], ArrowDown: [40, ""] };
    // Virtual key codes only for letters and digits; other characters come as text alone (a code
    // like 40 for "(" would be the down arrow).
    const vk = /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : key === "." ? 190 : key === "-" ? 189 : key === " " ? 32 : 0;
    const [code, text] = named[key] ?? [vk, modifiers & ~8 ? "" : key];
    const codeName = named[key] ? key : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : key === "." ? "Period" : key === "-" ? "Minus" : "";
    // On the Mac the editing shortcuts are menu commands; the protocol needs them named.
    const commands = modifiers === 4 ? ({ a: ["selectAll"], z: ["undo"], c: ["copy"], v: ["paste"], x: ["cut"] } as Record<string, string[]>)[key.toLowerCase()] : undefined;
    const base = { key, code: codeName, windowsVirtualKeyCode: code, modifiers, ...(commands ? { commands } : {}) };
    await this.call("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await this.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }
  /** Types text key by key (as a keyboard does, so key handlers see every key). */
  async type(text: string): Promise<void> {
    for (const ch of text) await this.key(ch);
  }
  async shot(file: string): Promise<void> {
    const { data } = await this.call("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(data, "base64"));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
