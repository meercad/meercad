/**
 * Picking in the 3D view for a step's selection fields (FeatureDialog.tsx handlePick), with the
 * real view and kernel, seen from above: a hole goes exactly where the face was tapped, more holes
 * where tapped next; edges, faces and parts toggle in and out of their lists; a sketch region is the
 * profile; a part picked as a cut's target leaves its tools. Each step built gives the volume its
 * picks mean. The parts: a 40 × 20 × 10 block at the origin and a 10 × 10 × 25 post at x = 60.
 */
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import {
  apply,
  cancelDialog,
  commitDialog,
  getViewport,
  newProject,
  setDialogField,
  startFeature,
  undo,
  updateDraft,
  useApp,
} from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";
import { FeatureDialog, pickKindsFor } from "./FeatureDialog";

const rect = (p: string, x: number, y: number, w: number, h: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y },
  { id: `${p}2`, type: "point", x: x + w, y },
  { id: `${p}3`, type: "point", x: x + w, y: y + h },
  { id: `${p}4`, type: "point", x, y: y + h },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const design: Feature[] = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("b", 0, 0, 40, 20),
    constraints: [],
  },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("c", 60, 0, 10, 10),
    constraints: [],
  },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 25, mode: "new_body" },
];
let vp: Viewport;
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const draft = <T,>() => useApp.getState().dialog!.feature as T;

async function clickAt(world: [number, number, number], opts: { shiftKey?: boolean } = {}) {
  const [x, y] = vp.worldToScreen(world)!;
  const ev = {
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    isPrimary: true,
    ...opts,
  };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  // Far enough apart that two clicks on one spot are not a double-click.
  await settle(350);
}

/** The parts' volumes, smallest first, once the app has filled them in after the rebuild. */
const volumes = async () => {
  await waitFor(() =>
    expect(
      useApp
        .getState()
        .output!.report.bodies.every((b) => typeof b.volume === "number" && Number.isFinite(b.volume)),
    ).toBe(true),
  );

  return useApp
    .getState()
    .output!.report.bodies.map((b) => b.volume!)
    .sort((a, b) => a - b);
};

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Dialog picks");
  apply({ type: "add_features", features: design });
  renderUi(
    <>
      <ViewportView />
      <FeatureDialog />
    </>,
  );
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
  });
});
beforeEach(() => useApp.setState({ selection: [] }));
afterAll(async () => {
  await act(async () => cancelDialog());
  cleanup();
});

describe("picking for a step", () => {
  it("puts holes exactly where the top face is tapped", async () => {
    await act(async () => startFeature("hole"));
    expect(useApp.getState().dialog!.field).toBe("plane");
    await clickAt([10, 5, 10]);

    const h = draft<{ points: [number, number][]; plane: unknown }>();
    expect(h.plane).toBeTruthy();
    expect(h.points).toHaveLength(1);
    expect(h.points[0]![0]).toBeCloseTo(10, 2);
    expect(h.points[0]![1]).toBeCloseTo(5, 2);
    expect(useApp.getState().dialog!.field).toBe("points");
    await clickAt([30, 15, 10]);

    const pts = draft<{ points: [number, number][] }>().points;
    expect(pts).toHaveLength(2);
    expect(pts[1]![0]).toBeCloseTo(30, 2);
    expect(pts[1]![1]).toBeCloseTo(15, 2);
    // Two 5 mm holes through the 10 mm block.
    await act(async () =>
      updateDraft({ kind: "simple", diameter: 5, depth: undefined, allowance: 0 } as Partial<Feature>),
    );

    let ok = false;
    await act(async () => void (ok = commitDialog()));
    expect(ok).toBe(true);
    await rebuilt();
    expect((await volumes())[1]).toBeCloseTo(8000 - 2 * Math.PI * 2.5 ** 2 * 10, 1);
    await act(async () => undo());
    await rebuilt();
  });

  it("toggles edges for a fillet, and a part for a cut's tools but not its target", async () => {
    await act(async () => startFeature("fillet"));
    expect(pickKindsFor(useApp.getState().dialog)).toEqual(new Set(["edge", "face"]));
    await clickAt([20, 0, 10]);
    expect(draft<{ edges: unknown[] }>().edges).toHaveLength(1);
    await clickAt([20, 20, 10]);
    expect(draft<{ edges: unknown[] }>().edges).toHaveLength(2);

    // The preview already rounds the picked edges, so one comes out by its chip's ✕.
    const chip = [...document.querySelectorAll<HTMLElement>(".selbox .chip")].find((c) =>
      c.title.endsWith("side bc"),
    )!;
    await act(async () => void fireEvent.click(chip.querySelector("button")!));
    expect(draft<{ edges: { edge: string[] }[] }>().edges.map((e) => e.edge.join())).toEqual([
      "ex1.end_cap,ex1.side[sk1.ba]",
    ]);
    await act(async () => cancelDialog());

    await act(async () => startFeature("boolean"));
    await act(async () => setDialogField("target"));
    await clickAt([20, 10, 10]);
    expect(draft<{ target: string }>().target).toBe("ex1");
    expect(useApp.getState().dialog!.field).toBe("tools");
    await clickAt([65, 5, 25]);
    expect(draft<{ tools: string[] }>().tools).toEqual(["ex2"]);
    // The target cannot be its own tool.
    await clickAt([20, 10, 10]);
    expect(draft<{ tools: string[] }>().tools).toEqual(["ex2"]);
    await act(async () => cancelDialog());
  });

  it("takes faces for a shell and a sketch region as an extrusion's profile", async () => {
    await act(async () => startFeature("shell"));
    await act(async () => setDialogField("faces"));
    await clickAt([20, 10, 10]);
    expect(draft<{ faces: unknown[] }>().faces).toHaveLength(1);
    await act(async () => updateDraft({ thickness: 2 } as Partial<Feature>));
    await act(async () => void commitDialog());
    await rebuilt();
    // Open at the top, 2 mm walls and floor: 40·20·10 − 36·16·8.
    expect((await volumes())[1]).toBeCloseTo(8000 - 36 * 16 * 8, 1);
    await act(async () => undo());
    await rebuilt();

    await act(async () => startFeature("extrude"));
    await act(async () => setDialogField("profile"));
    // The block's top hides the sketch: the face itself is the profile.
    await clickAt([20, 10, 10]);
    expect(draft<{ profile: { face?: unknown } }>().profile.face).toBeTruthy();
    await act(async () => cancelDialog());
  });

  it("moves a picked part and its axis comes from an edge", async () => {
    await act(async () => startFeature("transform"));
    await act(async () => setDialogField("bodies"));
    await clickAt([65, 5, 25]);
    expect(draft<{ bodies: string[] }>().bodies).toEqual(["ex2"]);
    await act(async () => cancelDialog());
    await act(async () => startFeature("circular_pattern"));
    await act(async () => setDialogField("axis"));
    await clickAt([20, 0, 10]);
    expect(draft<{ axis: unknown }>().axis).toBeTruthy();
    await act(async () => cancelDialog());
  });
});
