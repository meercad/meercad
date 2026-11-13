/**
 * The cards the 3D view shows over a part (ViewportView.tsx), with the real kernel: printability of
 * a T standing on its stem (its two arms overhang: 2.0 cm² of underside, about 4.0 cm³ of support;
 * upside down it prints without), the wall thickness of a 2 mm plate, and the deviation of a drawn
 * plate from a mesh of it. The numbers they show are the part's.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { writeStl } from "@meercad/io";
import { prism, turnedAboutX } from "../../../../tests/acceptance/meshes";
import { testCall } from "../lib/mcpBridge";
import { apply, rebuildNow, useApp } from "../store";
import { hidePrintCheck, showPrintCheck } from "../lib/printability";
import { hideThickness, showThickness } from "../lib/thickness";
import { hideDeviation, showDeviation } from "../lib/deviation";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const stlOf = (corners: Float64Array) =>
  writeStl([
    {
      positions: Float32Array.from(corners),
      indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i),
    },
  ]);
const card = () => document.querySelector(".deviation-card")?.textContent ?? "";
let tee = "";
let plate = "";
const rect = (x: number, y: number, w: number, h: number): SketchEntity[] => [
  { id: "p1", type: "point", x, y },
  { id: "p2", type: "point", x: x + w, y },
  { id: "p3", type: "point", x: x + w, y: y + h },
  { id: "p4", type: "point", x, y: y + h },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];

beforeAll(async () => {
  withScreen();
  await testCall("new_project", { name: "Cards" });

  // A T in XZ, 10 deep: stem 10 wide and 20 high, bar 30 wide and 5 thick on top.
  const t = turnedAboutX(
    prism(
      [
        [10, 0],
        [20, 0],
        [20, 20],
        [30, 20],
        [30, 25],
        [0, 25],
        [0, 20],
        [10, 20],
      ],
      10,
    ),
    90,
  );
  tee = ((await testCall("import_file", { name: "tee.stl", base64: b64(stlOf(t)) })) as { added: string[] })
    .added[0]!;
  plate = (
    (await testCall("import_file", {
      name: "plate.stl",
      base64: b64(
        stlOf(
          prism(
            [
              [100, 0],
              [130, 0],
              [130, 30],
              [100, 30],
            ],
            2,
          ),
        ),
      ),
    })) as { added: string[] }
  ).added[0]!;
  renderUi(<ViewportView />);
  await rebuilt();
});
afterAll(cleanup);

describe("cards over a part", () => {
  it("shows the T's overhang and support, and that upside down it needs none", async () => {
    await act(async () => showPrintCheck(tee));
    await waitFor(() => expect(card()).toMatch(/Overhang:/), { timeout: 30_000 });
    expect(card()).toMatch(/Printability of/);
    expect(card()).toMatch(/Overhang: 2\.0 cm² \(\d+ % of the surface\) · support about 4\.0 cm³/);
    expect(card()).toMatch(/Turned another way up it prints without support/);

    // A limit of 0°: every face that leans out at all needs support; the numbers stay the T's here.
    const limit = document.querySelector<HTMLInputElement>(".deviation-card input[type=number]")!;
    await act(async () => void fireEvent.change(limit, { target: { value: "0" } }));
    await act(async () => void fireEvent.click(screen.getByText("Turn the best way up")));
    await rebuilt();
    await waitFor(() => expect(card()).toMatch(/No overhangs|already stands/), { timeout: 30_000 });
    await act(async () => hidePrintCheck());
    expect(document.querySelector(".deviation-card")).toBeNull();
  });

  it("shows the plate's thinnest wall: 2 mm", async () => {
    await act(async () => showThickness(plate));
    await waitFor(() => expect(card()).toMatch(/Thinnest:/), { timeout: 30_000 });
    expect(card()).toMatch(/Wall thickness of/);
    expect(card()).toMatch(/Thinnest: 2(\.00)? mm · 0 % of the surface below 1 mm/);
    await act(async () => void fireEvent.click(screen.getByTitle("Close")));
    expect(document.querySelector(".deviation-card")).toBeNull();
    await act(async () => hideThickness());
  });

  it("shows how far a drawn plate is from the mesh of it", async () => {
    apply({
      type: "add_features",
      features: [
        {
          id: "sk1",
          op: "sketch",
          plane: { ref: "origin.XY" },
          entities: rect(100, 0, 30, 30),
          constraints: [],
        },
        {
          id: "ex1",
          op: "extrude",
          profile: { sketch: "sk1" },
          extent: "blind",
          distance: 2.1,
          mode: "new_body",
        },
      ] as Feature[],
    });
    await rebuildNow();
    await act(async () => showDeviation("ex1", plate));
    await waitFor(() => expect(card()).toMatch(/within/), { timeout: 30_000 });
    expect(card()).toMatch(/Deviation from/);
    // The drawn top is 0.1 mm higher than the mesh's: the largest deviation is +0.10 mm.
    expect(card()).toMatch(/to \+0\.10 mm/);
    await act(async () => hideDeviation());
    expect(useApp.getState().toasts.filter((t) => t.kind === "error")).toEqual([]);
  });
});
