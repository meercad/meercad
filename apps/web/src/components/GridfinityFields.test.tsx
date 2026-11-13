/**
 * The Gridfinity dialog (GridfinityFields.tsx) says what its numbers come to, and the part built
 * has that size: a 2 × 1 bin is 83.5 × 41.5 mm and 21 mm to its rim (7 mm a unit), split into four
 * compartments by three dividers; a baseplate for a 400 × 300 drawer holds 9 × 7 cells with the
 * border left over; a bin is made taller and given other dividers by its fields.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compartments, drawerFit, GRIDFINITY } from "@meercad/model";
import { cancelDialog, commitDialog, newProject, rebuildNow, startFeature, useApp } from "../store";
import { renderUi } from "../../test/ui";
import { FeatureDialog } from "./FeatureDialog";

/** As the dialog shows sizes: to a tenth of a millimetre. */
const mm = (v: number) => `${v.toFixed(1).replace(/\.0$/, "")} mm`;
const draft = <T,>() => useApp.getState().dialog!.feature as T;
const dialogText = () =>
  document.querySelector(".dialog, .feature-dialog, [role=dialog]")?.textContent ??
  document.body.textContent ??
  "";

async function preset(label: string) {
  const select = [...document.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
    [...s.options].some((o) => o.textContent === label),
  )!;
  const i = [...select.options].findIndex((o) => o.textContent === label);
  await act(async () => void fireEvent.change(select, { target: { value: select.options[i]!.value } }));
}

async function field(label: string, value: string) {
  const f = screen
    .getAllByText(label)
    .map((e) => e.closest(".fld"))
    .find(Boolean)!;
  const input = f.querySelector("input")!;
  await act(async () => void fireEvent.focus(input));
  await act(async () => void fireEvent.change(input, { target: { value } }));
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
}

beforeAll(async () => {
  await newProject(undefined, "Gridfinity");
  renderUi(<FeatureDialog />);
});
afterAll(async () => {
  await act(async () => cancelDialog());
  cleanup();
});

describe("the Gridfinity dialog", () => {
  it("tells a 2 × 1 bin's size and compartments, and builds it that size", async () => {
    await act(async () => startFeature("gridfinity"));
    await preset("2×1 bin, 3 dividers");
    expect(draft<{ units: number[]; dividers: number[] }>()).toMatchObject({
      units: [2, 1],
      dividers: [3, 0],
    });

    const w = 2 * GRIDFINITY.pitch - GRIDFINITY.gap;
    expect(w).toBe(83.5);
    expect(dialogText()).toContain(`${mm(83.5)} × ${mm(41.5)} × ${mm(21)} outside`);

    const c = compartments([2, 1], 3, [3, 0]);
    expect(c.count).toBe(4);
    expect(dialogText()).toContain(`4 compartments of ${mm(c.width)} × ${mm(c.depth)}`);

    let ok = false;
    await act(async () => void (ok = commitDialog()));
    expect(ok).toBe(true);

    const box = (await rebuildNow()).report.bodies.at(-1)!.bbox;
    expect(box.max[0]! - box.min[0]!).toBeCloseTo(83.5, 3);
    expect(box.max[1]! - box.min[1]!).toBeCloseTo(41.5, 3);
  });

  it("makes a bin taller and divides it otherwise by its fields", async () => {
    await act(async () => startFeature("gridfinity"));
    await preset("1×1 bin");
    await field("Height (units)", "6");
    expect(draft<{ height: unknown }>().height).toBe(6);
    expect(dialogText()).toContain(`× ${mm(42)} outside`);
    await field("Dividers across", "1");
    expect(draft<{ dividers: unknown[] }>().dividers).toEqual([1, 0]);
    expect(dialogText()).toMatch(/2 compartments of/);
    await act(async () => cancelDialog());
  });

  it("fits a baseplate into a 400 × 300 drawer: 9 × 7 cells and the border left", async () => {
    await act(async () => startFeature("gridfinity"));
    await preset("Baseplate for a drawer");

    const fit = drawerFit([400, 300], 0.5);
    expect(fit.units).toEqual([9, 7]);
    expect(dialogText()).toContain(`9 × 7 cells, border ${mm(fit.border[0])} and ${mm(fit.border[1])}`);
    await field("Area width", "300");

    const smaller = drawerFit([300, 300], 0.5);
    expect(dialogText()).toContain(`${smaller.units[0]} × ${smaller.units[1]} cells`);
    await act(async () => cancelDialog());
  });
});
