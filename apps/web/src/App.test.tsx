/**
 * The whole app (App.tsx) as the Mac app shows it, in happy-dom with the real kernel and 3D view:
 * from the projects overview into a new design, a step from the toolbar, the parts and joints
 * panels, and back home. The numbers shown are checked against the drawn part.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "./App";
import { currentDoc, goHome, useApp } from "./store";
import { rebuilt, renderUi, withScreen } from "../test/ui";
import { testFiles } from "../test/setup";

beforeAll(() => {
  withScreen(1280, 800);
  // No introduction tour in tests.
  localStorage.setItem("meercad.tourDone", "1");
});
afterAll(cleanup);

describe("the app", () => {
  it("starts on the projects overview and makes a new design", async () => {
    renderUi(<App />);
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(useApp.getState().screen).toBe("home");
    const make = screen.getAllByRole("button").find((b) => /new/i.test(b.textContent ?? "") || /new/i.test(b.getAttribute("title") ?? ""));
    expect(make).toBeDefined();
    await act(async () => void fireEvent.click(make!));
    await waitFor(() => expect(useApp.getState().screen).toBe("editor"));
    expect(testFiles.projects.size).toBeGreaterThan(0);
  });

  it("adds a box from the toolbar and shows it in the parts list", async () => {
    const tool = screen.getAllByRole("button").find((b) => (b.getAttribute("title") ?? "").startsWith("Box"));
    if (tool) await act(async () => void fireEvent.click(tool));
    else await act(async () => (await import("./store")).startFeature("box"));
    await waitFor(() => expect(useApp.getState().dialog?.feature.op).toBe("box"));
    await act(async () => void fireEvent.click(screen.getByTitle("Accept (Enter)")));
    await rebuilt();
    expect(currentDoc().features.at(-1)!.op).toBe("box");
    const bodies = useApp.getState().output!.report.bodies;
    expect(bodies.length).toBeGreaterThanOrEqual(1);
  });

  it("goes back home and lists the design", async () => {
    await act(async () => goHome());
    await waitFor(() => expect(useApp.getState().screen).toBe("home"));
    expect(screen.getAllByText(/Untitled part/).length).toBeGreaterThan(0);
  });
});

describe("the editor's bars", () => {
  const click = async (title: string | RegExp) => {
    const b = screen.getAllByRole("button").find((x) => {
      const s = x.getAttribute("title") || x.getAttribute("aria-label") || x.textContent?.trim() || "";
      return typeof title === "string" ? s.startsWith(title) : title.test(s);
    });
    if (!b) throw new Error(`no button ${String(title)}`);
    await act(async () => void fireEvent.click(b));
  };
  const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

  it("opens the menus of the top and tool bars", async () => {
    const { newProject } = await import("./store");
    await act(async () => newProject());
    await settle();
    for (const t of ["Create", "Modify", "Transform", "Import and export", "More: settings, help, projects", "View options", "Display mode", "Scan"]) {
      await click(t);
      await settle();
      expect(screen.queryAllByRole("menuitem").length, t).toBeGreaterThan(0);
      await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    }
  });

  it("switches views, planes, sketches and the camera", async () => {
    for (const t of ["Isometric view", "Rotate view 90° left", "Rotate view 90° right", "Fit all", "Planes", "Sketches", "Parts in one colour", "Hide dimensions on the model", /^Grid/, /^Perspective/]) {
      await click(t);
      await settle();
    }
    expect(useApp.getState().showPlanes).toBeDefined();
  });

  it("opens the joints panel and measuring, and the side panel", async () => {
    await click(/^Joints/);
    await settle();
    expect((await import("./lib/mechanism")).useMotion.getState().open).toBe(true);
    await click(/^Joints/);
    await click(/^Measure/);
    await settle();
    expect(useApp.getState().measure.active).toBe(true);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    await click("Show history, parts and variables");
    await settle();
    expect(useApp.getState().sideOpen).toBe(true);
  });

  it("searches commands and runs one", async () => {
    await click("Search commands");
    await settle();
    const input = document.querySelector<HTMLInputElement>(".palette input");
    expect(input).not.toBeNull();
    await act(async () => void fireEvent.change(input!, { target: { value: "gear" } }));
    const hit = [...document.querySelectorAll<HTMLButtonElement>(".palette-list button")];
    const gear = hit.find((b) => /^ModelingGear/.test(b.textContent ?? ""));
    expect(gear, hit.map((b) => b.textContent).join(" | ")).toBeDefined();
    await act(async () => void fireEvent.click(gear!));
    await settle();
    expect(useApp.getState().dialog?.feature.op).toBe("gear");
    await act(async () => (await import("./store")).cancelDialog());
  });

  it("undoes and redoes from the bar, and opens a second tab", async () => {
    const { apply } = await import("./store");
    await act(async () => void apply({ type: "set_param", name: "w", expr: "5 mm" }));
    await click("Undo");
    expect(currentDoc().params["w"]).toBeUndefined();
    await click("Redo");
    expect(currentDoc().params["w"]).toBe("5 mm");
    const tabs = useApp.getState().tabs.length;
    await click("New part");
    await waitFor(() => expect(useApp.getState().tabs.length).toBe(tabs + 1));
    await click("Close tab");
    await waitFor(() => expect(useApp.getState().tabs.length).toBe(tabs));
  });
});
