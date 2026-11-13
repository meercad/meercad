/**
 * The whole app (App.tsx) driven by the keyboard and the Mac app's menu: undo and redo, starting
 * tools and repeating the last, measuring and cancelling, deleting what is selected, the views, the
 * shortcut help, tabs; menu commands for new, home, undo, shortcuts and settings; a project opened
 * from a link (#/p/<id>) and from the Mac app; a file dropped on the window is imported.
 */
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
vi.mock("./lib/thumbnails", async (orig) => ({ ...(await orig<typeof import("./lib/thumbnails")>()), startBackgroundPictures: () => undefined, fillThumbnails: async () => undefined }));
import { App } from "./App";
import { apply, currentDoc, getViewport, newProject, rebuildNow, useApp } from "./store";
import { rebuilt, renderUi, withScreen } from "../test/ui";
import { acceptRecord } from "./lib/terms";
import { saveTerms } from "./lib/termsStore";

const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 40, y: 0 },
  { id: "p3", type: "point", x: 40, y: 20 },
  { id: "p4", type: "point", x: 0, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
type Handler = (arg: unknown) => void;
const handlers = new Map<string, Handler[]>();
const emit = async (event: string, arg?: unknown) => {
  await act(async () => {
    for (const h of handlers.get(event) ?? []) h(arg);
  });
  await act(async () => new Promise((r) => setTimeout(r, 30)));
};
const key = async (k: string, opts: Partial<KeyboardEventInit> = {}, target: Window | Element = window) => {
  await act(async () => void fireEvent.keyDown(target, { key: k, ...opts }));
  await act(async () => new Promise((r) => setTimeout(r, 20)));
};
const distance = () => (currentDoc().features.find((f) => f.id === "ex1") as { distance: unknown } | undefined)?.distance;

beforeAll(async () => {
  withScreen(1280, 800);
  localStorage.setItem("meercad.tourDone", "1");
  // A user who has accepted the terms of use (before that, keys, menu and drops do nothing: tests/terms-store.test.ts).
  saveTerms(acceptRecord("test", "en"));
  const desktop = (window as unknown as { meercadDesktop: { on: (e: string, h: Handler) => () => void } }).meercadDesktop;
  desktop.on = (e, h) => {
    handlers.set(e, [...(handlers.get(e) ?? []), h]);
    return () => handlers.set(e, (handlers.get(e) ?? []).filter((x) => x !== h));
  };
  renderUi(<App />);
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  await act(async () => newProject(undefined, "Keys"));
  await act(async () => void apply({ type: "add_features", features: design }));
  await rebuilt();
});
afterAll(cleanup);

describe("the keyboard", () => {
  it("undoes and redoes with ⌘Z, ⇧⌘Z and ⌘Y, but not while typing", async () => {
    apply({ type: "edit_feature", id: "ex1", patch: { distance: 15 } });
    await key("z", { metaKey: true });
    expect(distance()).toBe(10);
    await key("z", { metaKey: true, shiftKey: true });
    expect(distance()).toBe(15);
    await key("z", { metaKey: true });
    await key("y", { ctrlKey: true });
    expect(distance()).toBe(15);
    // In a text field ⌘Z undoes the typing.
    const typed: string[] = [];
    (document as unknown as { execCommand: (c: string) => boolean }).execCommand = (c) => (typed.push(c), true);
    const input = document.createElement("input");
    document.body.append(input);
    await key("z", { metaKey: true }, input);
    await key("z", { metaKey: true, shiftKey: true }, input);
    expect(distance()).toBe(15);
    expect(typed).toEqual(["undo", "redo"]);
    input.remove();
  });

  it("starts a tool, cancels it with Escape and repeats it with ⇧R", async () => {
    await key("F");
    expect(useApp.getState().dialog?.feature.op).toBe("fillet");
    await key("Escape");
    expect(useApp.getState().dialog).toBeNull();
    await key("R", { shiftKey: true });
    expect(useApp.getState().dialog?.feature.op).toBe("fillet");
    await key("Escape");
  });

  it("measures with ⇧M, and Escape ends it, then clears the selection", async () => {
    await key("M", { shiftKey: true });
    expect(useApp.getState().measure.active).toBe(true);
    await key("Escape");
    expect(useApp.getState().measure.active).toBe(false);
    useApp.setState({ selectedFeature: "ex1" });
    await key("Escape");
    expect(useApp.getState().selectedFeature).toBeNull();
  });

  it("opens a selected step with Enter and deletes it with Backspace", async () => {
    useApp.setState({ selectedFeature: "ex1" });
    await key("Enter");
    expect(useApp.getState().dialog?.feature.id).toBe("ex1");
    await key("Enter");
    expect(useApp.getState().dialog).toBeNull();
    useApp.setState({ selectedFeature: "ex1", selection: [] });
    await key("Backspace");
    await waitFor(() => expect(currentDoc().features.map((f) => f.id)).toEqual(["sk1"]));
    await key("z", { metaKey: true });
    expect(currentDoc().features.map((f) => f.id)).toEqual(["sk1", "ex1"]);
  });

  it("turns the view, fits it, toggles the side panel and the shortcut help", async () => {
    const vp = getViewport()!;
    const views: string[] = [];
    const [setView, fit] = [vp.setView.bind(vp), vp.fit.bind(vp)];
    let fitted = 0;
    vp.setView = (v, ...rest) => (views.push(v), setView(v, ...rest));
    vp.fit = (...a) => (fitted++, fit(...a));
    await key("4");
    await key("1", { metaKey: true });
    await key("Z");
    expect(views).toEqual(["top", "iso"]);
    expect(fitted).toBe(1);
    vp.setView = setView;
    vp.fit = fit;
    const side = useApp.getState().sideOpen;
    await key("\\", { metaKey: true });
    expect(useApp.getState().sideOpen).toBe(!side);
    await key("\\", { metaKey: true });
    await key("?");
    expect(document.querySelector(".help, [role=dialog]")).not.toBeNull();
    await key("Escape");
    await key("X");
    await key("Escape");
  });

  it("opens new tabs with ⌘T, goes round them with ⌃Tab, closes with ⌘W and reopens with ⇧⌘T", async () => {
    const first = useApp.getState().project!.id;
    await key("t", { metaKey: true });
    await waitFor(() => expect(useApp.getState().project?.id).not.toBe(first));
    const second = useApp.getState().project!.id;
    await key("Tab", { ctrlKey: true });
    await waitFor(() => expect(useApp.getState().project?.id).toBe(first));
    await key("Tab", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(useApp.getState().project?.id).toBe(second));
    await key("w", { metaKey: true });
    await waitFor(() => expect(useApp.getState().project?.id).toBe(first));
    await key("t", { metaKey: true, shiftKey: true });
    await waitFor(() => expect(useApp.getState().project?.id).toBe(second));
    await key("w", { metaKey: true });
    await waitFor(() => expect(useApp.getState().project?.id).toBe(first));
  });
});

describe("the Mac app's menu", () => {
  it("undoes, shows shortcuts and settings, goes home and back by a link", async () => {
    const id = useApp.getState().project!.id;
    apply({ type: "edit_feature", id: "ex1", patch: { distance: 12 } });
    // Outside a text field the menu's Undo acts on the model.
    (document.activeElement as HTMLElement | null)?.blur();
    await emit("menu", "undo");
    expect(distance()).not.toBe(12);
    await emit("menu", "redo");
    expect(distance()).toBe(12);
    let settings = 0;
    window.addEventListener("meercad:settings", () => settings++, { once: true });
    await emit("menu", "settings");
    expect(settings).toBe(1);
    await emit("menu", "shortcuts");
    await emit("menu", "shortcuts");
    await emit("menu", "home");
    expect(useApp.getState().screen).toBe("home");
    // A link to the project opens it again.
    await act(async () => {
      location.hash = `#/p/${encodeURIComponent(id)}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(useApp.getState().project?.id).toBe(id));
    await emit("error", "Disk full");
    expect(useApp.getState().toasts.at(-1)!.text).toBe("Disk full");
    await emit("open-project", id);
    expect(useApp.getState().project?.id).toBe(id);
    await emit("project-saved", "someone-else");
    let changed = 0;
    window.addEventListener("meercad:projects-changed", () => changed++, { once: true });
    await emit("projects-changed");
    expect(changed).toBe(1);
  });

  it("opens the guides from the palette, the tour and the shortcuts from there, and closes them", async () => {
    await act(async () => void window.dispatchEvent(new Event("meercad:palette")));
    // The palette toggles: it may have been open already.
    if (!document.querySelector(".palette")) await act(async () => void window.dispatchEvent(new Event("meercad:palette")));
    const input = document.querySelector<HTMLInputElement>(".palette input")!;
    await act(async () => void fireEvent.change(input, { target: { value: "Help & guides" } }));
    await act(async () => void fireEvent.click([...document.querySelectorAll<HTMLButtonElement>(".palette-list button")].find((b) => b.textContent?.includes("Help & guides"))!));
    const restart = () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Restart tour"));
    expect(restart()).toBeDefined();
    await act(async () => void fireEvent.click([...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith("Shortcuts"))!));
    expect(document.querySelector(".shortcut-help, [aria-label='Keyboard shortcuts']")).not.toBeNull();
    await key("Escape");
    await act(async () => void fireEvent.click(restart()!));
    expect(restart()).toBeUndefined();
    expect(document.querySelector(".tour-card")).not.toBeNull();
    await key("Escape");
    expect(document.querySelector(".tour-card")).toBeNull();
  });

  it("waits with menu commands while an assistant works", async () => {
    useApp.setState({ aiLock: { client: "Claude" } as never });
    const id = useApp.getState().project!.id;
    await emit("menu", "home");
    expect(useApp.getState().project?.id).toBe(id);
    expect(useApp.getState().screen).toBe("editor");
    useApp.setState({ aiLock: null } as never);
  });

  it("imports a file dropped on the window", async () => {
    const svg = `<svg width="100mm" viewBox="0 0 100 100"><rect x="0" y="0" width="30" height="10"/></svg>`;
    const file = new File([svg], "plate.svg", { type: "image/svg+xml" });
    await act(async () => void fireEvent.drop(window, { dataTransfer: { files: [file] } }));
    await waitFor(() => expect(currentDoc().features.some((f) => f.op === "sketch" && f.name === "plate.svg")).toBe(true));
    const sk = currentDoc().features.find((f) => f.op === "sketch" && f.name === "plate.svg")!;
    const out = await rebuildNow();
    expect(out.report.sketches.find((s) => s.id === sk.id)!.regions[0]!.area).toBeCloseTo(300, 6);
  });

  it("hides and shows parts, turns to the face under the mouse, sketches on it (Plasticity keys)", async () => {
    await act(async () => newProject(undefined, "Keys 2"));
    await act(async () => void apply({ type: "add_features", features: design }));
    await rebuilt();
    const { usePrefs } = await import("./lib/keymap");
    usePrefs.setState({ keys: "plasticity" } as never);
    try {
      useApp.setState({ selection: [{ kind: "face", bodyId: "ex1", face: 0, tags: [], point: [0, 0, 0], normal: null }] } as never);
      await key("h", { code: "KeyH" });
      expect(useApp.getState().hidden.has("ex1")).toBe(true);
      await key("h", { code: "KeyH", altKey: true });
      expect(useApp.getState().hidden.size).toBe(0);
    } finally {
      usePrefs.setState({ keys: "meercad" } as never);
    }
    // Space looks square onto the face under the mouse, S sketches on it.
    const vp = getViewport()!;
    const top = { kind: "face", bodyId: "ex1", face: 0, tags: ["ex1.end_cap"], point: [20, 10, 10], normal: [0, 0, 1] } as never;
    vp.setHover(top);
    const q = vp.cameraQuaternion.clone();
    await key(" ", { code: "Space" });
    await act(async () => new Promise((r) => setTimeout(r, 600)));
    (vp as unknown as { frame(): void }).frame();
    expect(vp.cameraQuaternion.equals(q)).toBe(false);
    vp.setHover(top);
    await key("s", { code: "KeyS" });
    const sk = currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as Extract<Feature, { op: "sketch" }>;
    expect(sk.plane).toMatchObject({ face: expect.anything() });
    const { closeSketch, undo } = await import("./store");
    await act(async () => closeSketch());
    await act(async () => undo());
  });

  it("edits parts from the Mac app's Edit menu, and text when a field has the focus", async () => {
    await act(async () => newProject(undefined, "Keys 3"));
    await act(async () => void apply({ type: "add_features", features: design }));
    await rebuilt();
    const before = (await rebuildNow()).report.bodies.length;
    await emit("menu", "selectAll");
    expect(useApp.getState().selection.length).toBeGreaterThan(0);
    await emit("menu", "copy");
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    await emit("menu", "paste");
    await act(async () => new Promise((r) => setTimeout(r, 300)));
    await rebuilt();
    expect((await rebuildNow()).report.bodies.length).toBe(before + 1);
    await emit("menu", "duplicate");
    await rebuilt();
    await emit("menu", "cut");
    await rebuilt();
    // With a text field focused the menu edits its text (through the Mac app).
    const native: string[] = [];
    const desktop = (window as unknown as { meercadDesktop: { editNative?: (c: string) => Promise<void> } }).meercadDesktop;
    const own = desktop.editNative;
    desktop.editNative = async (c) => void native.push(c);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await emit("menu", "copy");
    await emit("menu", "duplicate");
    input.remove();
    desktop.editNative = own;
    expect(native).toEqual(["copy"]);
    const { undo } = await import("./store");
    for (let i = 0; i < 3; i++) await act(async () => undo());
    await rebuilt();
  });

  it("takes ⌥⌘H and ⌘\\ for the side panel, and ⌘O to import", async () => {
    const before = useApp.getState().sideOpen;
    await key("h", { metaKey: true, altKey: true });
    expect(useApp.getState().sideOpen).toBe(!before);
    await key("\\", { metaKey: true });
    expect(useApp.getState().sideOpen).toBe(before);
    // ⌘O asks for a file (the stand-in Mac app answers with none): nothing changes.
    const n = currentDoc().features.length;
    await key("o", { metaKey: true });
    expect(currentDoc().features.length).toBe(n);
  });
});

