/**
 * Choosing a new sketch's plane (PlaneChooser.tsx) in the real 3D view: every plane has a tag, the
 * bar offers the three origin planes, either starts the sketch there, and Cancel stops choosing.
 * And the probe the iPhone and iPad UI tests read (uitestProbe.ts): the open sketch with its
 * region's area, the parts' sizes and the origin's place on screen.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, closeSketch, currentDoc, getViewport, newProject, rebuildNow, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { installProbe, probeState, uiTesting } from "../lib/uitestProbe";
import { ViewportView } from "./ViewportView";

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
  { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 30 },
];
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Planes");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
});
afterAll(cleanup);

describe("choosing a sketch plane", () => {
  it("tags every plane and starts the sketch on the one clicked", async () => {
    await act(async () => useApp.setState({ pickingSketchPlane: true }));
    await settle();

    const tags = [...document.querySelectorAll<HTMLButtonElement>(".plane-tag")];
    expect(tags.map((t) => t.dataset["plane"]).sort()).toEqual([
      "origin.XY",
      "origin.XZ",
      "origin.YZ",
      "pl1",
    ]);

    const tag = tags.find((t) => t.dataset["plane"] === "pl1")!;
    await act(async () => void fireEvent.pointerEnter(tag));
    await act(async () => void fireEvent.pointerLeave(tag));
    await act(async () => void fireEvent.click(tag));

    const sk = currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as Extract<
      Feature,
      { op: "sketch" }
    >;
    expect(sk.plane).toEqual({ ref: "pl1" });
    await act(async () => closeSketch());
  });

  it("offers the origin planes in a bar, and Cancel stops choosing", async () => {
    await act(async () => useApp.setState({ pickingSketchPlane: true }));
    await settle();

    const bar = screen.getByRole("toolbar", { name: "Sketch plane" });
    const xz = [...bar.querySelectorAll("button")].find((b) => /Front/.test(b.textContent ?? ""))!;
    await act(async () => void fireEvent.click(xz));

    const sk = currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as Extract<
      Feature,
      { op: "sketch" }
    >;
    expect(sk.plane).toEqual({ ref: "origin.XZ" });
    await act(async () => closeSketch());
    await act(async () => useApp.setState({ pickingSketchPlane: true }));
    await settle();
    await act(async () => void fireEvent.click(screen.getByTitle("Cancel (Esc)")));
    expect(useApp.getState().pickingSketchPlane).toBe(false);
  });
});

describe("the UI tests' probe", () => {
  it("is off unless the iOS app turns it on", () => {
    expect(uiTesting()).toBe(false);
    (window as unknown as { __meercadUITest?: boolean }).__meercadUITest = true;
    expect(uiTesting()).toBe(true);
    delete (window as unknown as { __meercadUITest?: boolean }).__meercadUITest;
  });

  it("reports the parts' sizes, the sketch's region and the origin on screen", async () => {
    await rebuildNow();

    const vp = getViewport()!;
    const st = probeState(
      useApp,
      () => false,
      (p) => vp.worldToScreen(p),
    );
    expect(st.screen).toBe(useApp.getState().screen);
    expect(st.features).toEqual(expect.arrayContaining(["sk1", "ex1", "pl1"]));
    expect(st.bodies.find((b) => b.id === "ex1")!.size).toEqual([40, 20, 10]);
    expect(st.axes).not.toBeNull();
    await act(async () => (await import("../store")).openSketch("sk1"));
    await rebuildNow();

    const inSketch = probeState(useApp);
    expect(inSketch.sketchInfo).toMatchObject({ lines: 4, circles: 0, regions: [800] });
    await act(async () => closeSketch());
    installProbe(
      useApp,
      () => false,
      () => null,
    );
    expect(document.getElementById("uitest-probe")!.textContent).toMatch(/^UITEST \{/);
  });
});
