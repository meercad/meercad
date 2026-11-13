/**
 * The design's fit (FitRow.tsx): a value outside 0–1 mm is refused; the first fit someone enters
 * becomes their printer's fit for new designs; the menu offers the printer's fit when the design's
 * differs, saving the design's as the printer's, going back to the default (0.2 mm), and the test
 * part; an own variable called "fit" from before hides the row.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
import { setPrefs, usePrefs } from "../lib/keymap";
import { pickMenu, renderUi } from "../../test/ui";
import { FitRow } from "./FitRow";

const rebuilt = () => act(async () => void (await rebuildNow()));
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
async function type(value: string) {
  const input = document.querySelector<HTMLInputElement>(".fit-row input")!;
  await act(async () => void fireEvent.change(input, { target: { value } }));
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
  await act(async () => void fireEvent.blur(input));
  await rebuilt();
}
const menu = async () => act(async () => void fireEvent.click(screen.getByTitle("Fit options")));

beforeAll(async () => {
  await newProject(undefined, "Fit");
  await rebuildNow();
  setPrefs({ printerFit: null });
  renderUi(<FitRow />);
  await rebuilt();
});
afterAll(() => {
  setPrefs({ printerFit: null });
  cleanup();
});

describe("the design's fit", () => {
  it("refuses a fit outside 0–1 mm, and takes the first one as the printer's", async () => {
    await type("1.5");
    expect(toasts()).toMatch(/A fit is between 0 and 1 mm/);
    expect(currentDoc().fit).toBeUndefined();
    await type("0.25");
    expect(currentDoc().fit).toBe(0.25);
    expect(usePrefs.getState().printerFit).toBe(0.25);
    expect(toasts()).toMatch(/0\.25 mm is now your printer's fit/);
  });

  it("uses the printer's fit, saves the design's as the printer's, and goes back to the default", async () => {
    await type("0.3");
    expect(usePrefs.getState().printerFit).toBe(0.25);
    await menu();
    await pickMenu(/^Use my printer's fit \(0\.25 mm\)/);
    await rebuilt();
    expect(currentDoc().fit).toBe("0.25 mm");
    await type("0.35");
    await menu();
    await pickMenu("Save as my printer's fit");
    expect(usePrefs.getState().printerFit).toBe(0.35);
    await act(async () => void fireEvent.contextMenu(document.querySelector(".fit-row")!));
    await pickMenu(/^Back to the default \(0\.2 mm\)/);
    await rebuilt();
    expect(currentDoc().fit).toBeUndefined();
    await menu();
    await pickMenu("Print the fit test part…");
  });

  it("hides when the design has an own variable called fit", async () => {
    // (A new variable cannot be called fit any more; an old file can have one.)
    apply({ type: "replace", doc: { ...currentDoc(), params: { ...currentDoc().params, fit: "0.1 mm" } } });
    await rebuilt();
    expect(document.querySelector(".fit-row")).toBeNull();
  });
});
