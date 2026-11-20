/**
 * Setting parts down on the ground (origin.XY) with the real view and kernel, seen from above: a
 * standard part's face and places come from taps on empty ground as well as on a part's face, a tap
 * on the ground after a face moves the parts down there, a spring is centred where the ground was
 * tapped, and a hole (which needs a part to cut) ignores the ground. One 40 × 20 × 10 block at the
 * origin; the ground taps are beside it.
 */
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import {
  apply,
  cancelDialog,
  commitDialog,
  dialogPick,
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
import { FeatureDialog, pickKindsFor, placesOnGround } from "./FeatureDialog";
import { clickInView, groundPick } from "./viewport/click";
import type { DialogState } from "../store";

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
];
let vp: Viewport;
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const draft = <T,>() => useApp.getState().dialog!.feature as T;
type Placed = { plane: unknown; points: [number, number][] };

async function clickAt(world: [number, number, number]) {
  const [x, y] = vp.worldToScreen(world)!;
  const ev = { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  // Far enough apart that two clicks on one spot are not a double-click.
  await settle(350);
}

/** A finger's tap on the iPad or iPhone: the touch path hands the click on with the screen point. */
async function tapAt(world: [number, number, number]) {
  const at = vp.worldToScreen(world)!;
  await act(async () =>
    clickInView(vp, vp.pick(at[0], at[1], pickKindsFor(useApp.getState().dialog)), true, at),
  );
}

const expectPoint = (p: [number, number] | undefined, x: number, y: number) => {
  expect(p![0]).toBeCloseTo(x, 1);
  expect(p![1]).toBeCloseTo(y, 1);
};

/** The lowest and highest z of a part's drawn mesh. */
const zRange = (bodyId: string) => {
  const m = useApp.getState().output!.meshes.find((x) => x.bodyId === bodyId)!;
  let lo = Infinity;
  let hi = -Infinity;

  for (let i = 2; i < m.positions.length; i += 3) {
    lo = Math.min(lo, m.positions[i]!);
    hi = Math.max(hi, m.positions[i]!);
  }

  return [lo, hi];
};

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Ground");
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
afterAll(async () => {
  await act(async () => cancelDialog());
  cleanup();
});

describe("parts on the ground", () => {
  it("sets standard parts onto empty ground where it is clicked, each its own part standing on it", async () => {
    await act(async () => startFeature("standard_part"));
    await act(async () =>
      updateDraft({
        kind: "magnet",
        size: undefined,
        length: undefined,
        diameter: 6,
        height: 3,
      } as Partial<Feature>),
    );
    expect(useApp.getState().dialog!.field).toBe("plane");
    await clickAt([55, 10, 0]);

    expect(draft<Placed>().plane).toEqual({ ref: "origin.XY" });
    expect(draft<Placed>().points).toHaveLength(1);
    expectPoint(draft<Placed>().points[0], 55, 10);
    expect(useApp.getState().dialog!.field).toBe("points");
    expect(pickKindsFor(useApp.getState().dialog)).toEqual(new Set(["face", "plane"]));

    await clickAt([-15, 5, 0]);
    expect(draft<Placed>().points).toHaveLength(2);
    expectPoint(draft<Placed>().points[1], -15, 5);

    let ok = false;
    await act(async () => void (ok = commitDialog()));
    expect(ok).toBe(true);
    await rebuilt();

    const bodies = useApp
      .getState()
      .output!.meshes.map((m) => m.bodyId)
      .filter((id) => id !== "ex1");
    expect(bodies).toHaveLength(2);

    for (const id of bodies) {
      const [lo, hi] = zRange(id);
      expect(lo).toBeCloseTo(0, 3);
      expect(hi).toBeCloseTo(3, 3);
    }

    await waitFor(() =>
      expect(useApp.getState().output!.report.bodies.every((b) => Number.isFinite(b.volume))).toBe(true),
    );

    const magnets = useApp.getState().output!.report.bodies.filter((b) => b.id !== "ex1");
    for (const b of magnets) expect(b.volume).toBeCloseTo(Math.PI * 3 ** 2 * 3, 0);

    await act(async () => undo());
    await rebuilt();
  });

  it("takes a tap on the ground on iPad and iPhone, and moves parts from a face down to the ground", async () => {
    await act(async () => startFeature("standard_part"));
    // First on the block's top face …
    await tapAt([10, 10, 10]);
    expect(draft<Placed>().plane).toHaveProperty("face");
    expectPoint(draft<Placed>().points[0], 10, 10);

    // … then beside it: the parts go down on the ground, starting over with this place.
    await tapAt([60, -10, 0]);
    expect(draft<Placed>().plane).toEqual({ ref: "origin.XY" });
    expect(draft<Placed>().points).toHaveLength(1);
    expectPoint(draft<Placed>().points[0], 60, -10);

    await act(async () => cancelDialog());
  });

  it("centres a spring where the ground is tapped", async () => {
    await act(async () => startFeature("spring"));
    expect(useApp.getState().dialog!.field).toBe("plane");
    await clickAt([70, 30, 0]);
    expect(draft<{ plane: unknown }>().plane).toEqual({ ref: "origin.XY" });
    expectPoint(draft<{ center: [number, number] }>().center, 70, 30);
    await act(async () => cancelDialog());
  });

  it("starts a box where the ground is tapped", async () => {
    await act(async () => startFeature("box"));
    await act(async () => setDialogField("plane"));
    await clickAt([80, -20, 0]);
    expect(draft<{ plane: unknown }>().plane).toEqual({ ref: "origin.XY" });
    expectPoint(draft<{ position: [number, number] }>().position, 80, -20);
    await act(async () => cancelDialog());
    await rebuilt();
  });

  it("shows the ground as the target while the pointer is over nothing", async () => {
    await act(async () => startFeature("standard_part"));

    const hover = vi.spyOn(vp, "setHover");
    const [x, y] = vp.worldToScreen([55, 10, 0])!;
    await act(async () => {
      fireEvent.pointerMove(vp.canvas, {
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: "mouse",
        buttons: 0,
      });
    });
    await settle(60);
    expect(hover).toHaveBeenLastCalledWith({ kind: "plane", planeId: "origin.XY", point: [0, 0, 0] });
    hover.mockRestore();
    await act(async () => cancelDialog());
  });

  it("takes a plane of the model as the face, but places parts only on flat ones it knows", async () => {
    await act(async () => startFeature("standard_part"));
    await act(async () => dialogPick!({ kind: "plane", planeId: "pl1", point: [1, 2, 3] }, false));
    expect(draft<Placed>().plane).toEqual({ ref: "pl1" });
    expect(draft<Placed>().points).toEqual([]);
    await act(async () => dialogPick!({ kind: "plane", planeId: "pl1", point: [4, 5, 6] }, false));
    expect(draft<Placed>().points).toEqual([]);
    await act(async () => cancelDialog());
  });

  it("leaves a hole's face empty on a tap on the ground: a hole needs a part", async () => {
    await act(async () => startFeature("hole"));

    const before = structuredClone(draft<Placed>());
    await clickAt([60, 10, 0]);
    expect(draft<Placed>()).toEqual(before);
    expect(useApp.getState().dialog!.field).toBe("plane");
    await act(async () => cancelDialog());
  });
});

describe("the ground under a tap", () => {
  const dialog = (op: string, field: string | null, extra: object = {}) =>
    ({ feature: { op, ...extra }, field }) as unknown as DialogState;
  const fake = (origin: [number, number, number], dir: [number, number, number]) =>
    ({ ray: () => ({ origin, dir }) }) as unknown as Viewport;
  const down = fake([5, 6, 100], [0, 0, -1]);

  it("is the point straight below on the ground", () => {
    expect(groundPick(down, [1, 1], dialog("standard_part", "points"))).toEqual({
      kind: "plane",
      planeId: "origin.XY",
      point: [5, 6, 0],
    });
  });

  it("is none without a screen point, looking along the ground or away from it", () => {
    const d = dialog("standard_part", "plane");
    expect(groundPick(down, undefined, d)).toBeNull();
    expect(groundPick(fake([0, 0, 10], [1, 0, 0]), [1, 1], d)).toBeNull();
    expect(groundPick(fake([0, 0, 10], [0, 0, 1]), [1, 1], d)).toBeNull();
  });

  it("is only for steps that set a part down, in their face or places field", () => {
    expect(placesOnGround(dialog("standard_part", "plane"))).toBe(true);
    expect(placesOnGround(dialog("standard_part", "points"))).toBe(true);
    expect(placesOnGround(dialog("screw", "plane"))).toBe(true);
    expect(placesOnGround(dialog("spring", "plane"))).toBe(true);
    expect(placesOnGround(dialog("box", "plane"))).toBe(true);
    expect(placesOnGround(dialog("hole", "plane"))).toBe(false);
    expect(placesOnGround(dialog("hole", "points"))).toBe(false);
    expect(placesOnGround(dialog("spring", "points"))).toBe(false);
    expect(placesOnGround(dialog("mirror", "plane"))).toBe(false);
    expect(placesOnGround(dialog("standard_part", null))).toBe(false);
    expect(groundPick(down, [1, 1], dialog("mirror", "plane"))).toBeNull();
  });
});
