/**
 * The page inside an assistant's own tab (mcpBridge.ts initAssistantWindow), opened as
 * `?assistant=S1&client=Claude`, with a stand-in for the Mac app's main process: requests arrive
 * from the window's page and are answered back by their call id (errors without Electron's
 * prefix); the main process learns which project is open and when the assistant works; the user
 * taking the tab over saves the project first; keys do nothing in the page while it is the
 * assistant's.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL("http://localhost/?assistant=S1&client=Claude");
});

import { initBridge } from "./mcpBridge";
import { assistantWindow } from "./persistence";
import { newProject, useApp } from "../store";
import { testFiles } from "../../test/setup";
import { acceptRecord } from "./terms";
import { saveTerms } from "./termsStore";

type Handler = (arg: unknown) => void;
const handlers = new Map<string, Handler>();
const responses: { callId: number; result?: unknown; error?: string }[] = [];
const projects: unknown[] = [];
const busy: unknown[] = [];
const released: number[] = [];
let ready = 0;
const desktop = () => (window as unknown as { meercadDesktop: Record<string, unknown> }).meercadDesktop;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  desktop()["on"] = (e: string, h: Handler) => (handlers.set(e, h), () => handlers.delete(e));
  desktop()["assistant"] = {
    respond: (p: { callId: number; result?: unknown; error?: string }) => void responses.push(p),
    released: (id: number) => void released.push(id),
    project: (p: unknown) => void projects.push(p),
    busy: (b: unknown) => void busy.push(b),
    ready: () => void ready++,
  };
  saveTerms(acceptRecord("test", "en"));
  initBridge();
});

describe("an assistant's own tab", () => {
  it("knows it is the assistant's tab, and says it is ready", () => {
    expect(assistantWindow).toEqual({ session: "S1", client: "Claude" });
    expect(ready).toBe(1);
    expect(projects).toEqual([]);
    expect(document.title).toBe("meerCAD · Claude");
  });

  it("answers the window's requests by their call id, errors without Electron's prefix", async () => {
    handlers.get("bridge-request")!({ callId: 7, req: { id: 0, method: "new_project", params: { name: "Assistant's" }, client: "claude-ai" } });
    await vi.waitFor(() => expect(responses.some((r) => r.callId === 7)).toBe(true), { timeout: 20_000 });
    expect(responses.find((r) => r.callId === 7)!.error).toBeUndefined();
    // The main process learns the project it now has open, and the title says so.
    await vi.waitFor(() => expect(projects.at(-1)).toMatchObject({ name: "Assistant's" }));
    expect(document.title).toBe("Assistant's · Claude");
    handlers.get("bridge-request")!({ callId: 8, req: { id: 0, method: "get_sketch", params: { id: "nope" } } });
    await vi.waitFor(() => expect(responses.some((r) => r.callId === 8)).toBe(true));
    expect(responses.find((r) => r.callId === 8)!.error).toBe('sketch "nope" not found');
  });

  it("tells the main process when the assistant works and on what", async () => {
    useApp.setState({ aiLock: { client: "Claude" } as never, aiActivity: { client: "Claude", tool: "apply_ops", at: Date.now() } as never });
    expect(busy.at(-1)).toEqual({ busy: true, tool: "apply_ops" });
    useApp.setState({ aiLock: null } as never);
    expect(busy.at(-1)).toEqual({ busy: false, tool: null });
  });

  it("saves the project before the user takes the tab over", async () => {
    await newProject(undefined, "Taken over");
    const id = useApp.getState().project!.id;
    const before = testFiles.saves;
    handlers.get("release-project")!({ callId: 42 });
    await vi.waitFor(() => expect(released).toContain(42));
    expect(testFiles.saves).toBeGreaterThan(before);
    expect(testFiles.projects.has(id)).toBe(true);
    await settle();
  });

  it("swallows keys in the page: the tab is the assistant's", () => {
    const ev = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});
