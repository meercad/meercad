/**
 * The command palette's file commands (CommandPalette.tsx), the ones other tests leave: exporting a
 * robot for a design with joints, sending to an installed slicer, 3MF, a new part and importing; a
 * press beside the palette closes it.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./io", async (orig) => ({
  ...(await orig<typeof import("./io")>()),
  exportMesh: async (f: string) => void calls.push(`mesh:${f}`),
  exportRobot: async () => void calls.push("robot"),
  sendToSlicer: async (id: string) => void calls.push(`slicer:${id}`),
  importFile: async () => void calls.push("import"),
}));

import * as store from "../store";
import { usePremium } from "../lib/premium";
import { useSlicers } from "../lib/slicers";
import { renderUi } from "../../test/ui";
import { CommandPalette } from "./CommandPalette";

const run = async (label: string) => {
  await act(async () => void window.dispatchEvent(new Event("meercad:palette")));
  const input = document.querySelector<HTMLInputElement>(".palette input")!;
  await act(async () => void fireEvent.change(input, { target: { value: label } }));
  const item = [...document.querySelectorAll<HTMLButtonElement>(".palette-list button")].find((b) => b.textContent?.includes(label));
  if (!item) throw new Error(`no command ${label}: ${[...document.querySelectorAll(".palette-list button")].map((b) => b.textContent).join(" | ")}`);
  await act(async () => void fireEvent.click(item));
};

beforeAll(async () => {
  await store.newProject(undefined, "Palette files");
  usePremium.setState({ tester: true, off: {} });
  useSlicers.setState({ slicers: [{ id: "prusa", name: "PrusaSlicer" }] as never });
  store.useApp.setState((s) => ({ doc: { ...s.doc, mechanism: { joints: [{ id: "j1" }] } } as never }));
  renderUi(<CommandPalette onHelp={() => undefined} onShortcuts={() => undefined} onTour={() => undefined} />);
});
afterAll(() => {
  vi.restoreAllMocks();
  useSlicers.setState({ slicers: [] });
  cleanup();
});

describe("the palette's file commands", () => {
  it("exports a robot and 3MF, sends to a slicer, and imports", async () => {
    await run("Export robot");
    await run("Export 3MF");
    await run("Send to PrusaSlicer");
    await run("Import / open file");
    expect(calls).toEqual(["robot", "mesh:3mf", "slicer:prusa", "import"]);
  });

  it("starts a new part, and closes by a press beside it", async () => {
    const make = vi.spyOn(store, "newProject").mockResolvedValue(undefined as never);
    await run("New part");
    expect(make).toHaveBeenCalled();
    await act(async () => void window.dispatchEvent(new Event("meercad:palette")));
    await act(async () => void fireEvent.pointerDown(document.querySelector(".palette")!));
    expect(document.querySelector(".palette")).not.toBeNull();
    await act(async () => void fireEvent.pointerDown(document.querySelector(".palette-backdrop")!));
    expect(document.querySelector(".palette")).toBeNull();
  });
});
