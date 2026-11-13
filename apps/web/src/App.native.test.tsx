/**
 * The app in the iPhone/iPad shell (App.tsx with `nativeApp`): a meerCAD file opened from the Files
 * app becomes a new project, a project in the app's folder opens, a file that is no design or cannot
 * be read says so; the Apple Pencil's double tap switches a sketch between Select and the tool used
 * last.
 */
import { act, cleanup } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyDocument } from "@meercad/schema";

const native = vi.hoisted(() => ({ open: null as ((f: unknown) => void) | null, tap: null as (() => void) | null }));
vi.mock("./lib/native", async (orig) => ({
  ...(await orig<typeof import("./lib/native")>()),
  nativeApp: true,
  onFileOpened: (cb: (f: unknown) => void) => ((native.open = cb), () => void (native.open = null)),
  Pencil: { addListener: (_: string, cb: () => void) => ((native.tap = cb), Promise.resolve({ remove: () => undefined })) },
}));
vi.mock("./lib/thumbnails", async (orig) => ({ ...(await orig<typeof import("./lib/thumbnails")>()), startBackgroundPictures: () => undefined, fillThumbnails: async () => undefined }));

import { App } from "./App";
import { newProject, startSketch, useApp } from "./store";
import { createProject } from "./lib/persistence";
import { renderUi, withScreen } from "../test/ui";
import { acceptRecord } from "./lib/terms";
import { saveTerms } from "./lib/termsStore";
import { setTool, useSketchUi } from "./sketch/state";

const settle = (ms = 50) => act(async () => new Promise((r) => setTimeout(r, ms)));
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");

beforeAll(async () => {
  withScreen(1024, 768);
  localStorage.setItem("meercad.tourDone", "1");
  saveTerms(acceptRecord("test", "en"));
  renderUi(<App />);
  await settle();
});
afterAll(cleanup);

describe("the iPad app", () => {
  it("marks the page as native, and opens files from the Files app", async () => {
    expect(document.documentElement.classList.contains("native")).toBe(true);
    await act(async () => native.open!({ name: "From Files", text: JSON.stringify({ ...emptyDocument(), params: { a: "4 mm" } }) }));
    await settle();
    expect(useApp.getState().project?.name).toBe("From Files");
    expect(useApp.getState().doc.params["a"]).toBe("4 mm");
    const meta = await createProject("Kept here", emptyDocument());
    await act(async () => native.open!({ id: meta.id }));
    await settle();
    expect(useApp.getState().project?.id).toBe(meta.id);
    await act(async () => native.open!({ name: "Odd", text: JSON.stringify({ format: "other" }) }));
    expect(toasts()).toMatch(/Not a valid meerCAD file/);
    await act(async () => native.open!({ name: "Broken", text: "{" }));
    expect(toasts()).toMatch(/Could not read Broken/);
  });

  it("switches a sketch between Select and the last tool with the Pencil's double tap", async () => {
    await act(async () => void (await newProject(undefined, "Pencil")));
    // Outside a sketch the tap does nothing.
    native.tap!();
    await act(async () => startSketch({ ref: "origin.XY" }));
    await act(async () => setTool("circle"));
    await act(async () => native.tap!());
    expect(useSketchUi.getState().tool).toBe("select");
    await act(async () => native.tap!());
    expect(useSketchUi.getState().tool).not.toBe("select");
  });
});
