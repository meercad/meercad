/**
 * The printer settings (Settings.tsx): the fit typed with a comma counts, a fit over 1 mm is not
 * taken and the field shows the old one again, an empty field goes back to the default; a custom
 * build volume takes sizes between 10 mm and 5 m only; the warning can be switched off; ⌘, opens and
 * Esc closes the settings; the fit test part opens as a project of its own.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePrefs } from "../lib/keymap";
import { newProject, useApp } from "../store";
import { renderUi } from "../../test/ui";
import { Settings } from "./Settings";

const fitInput = () => document.querySelector<HTMLInputElement>("input.fit-input")!;

async function typeFit(v: string) {
  await act(async () => void fireEvent.change(fitInput(), { target: { value: v } }));
  await act(async () => void fireEvent.blur(fitInput()));
}

beforeAll(async () => {
  await newProject(undefined, "Settings");
  renderUi(<Settings onShortcuts={() => undefined} />);
  await act(async () => void fireEvent.keyDown(window, { key: ",", metaKey: true }));
});
afterAll(cleanup);

describe("printer settings", () => {
  it("takes the fit with a comma, refuses one over 1 mm, and an empty field means the default", async () => {
    await typeFit("0,15");
    expect(usePrefs.getState().printerFit).toBe(0.15);
    await typeFit("2");
    expect(usePrefs.getState().printerFit).toBe(0.15);
    expect(fitInput().value).toBe("0.15");
    await typeFit("");
    expect(usePrefs.getState().printerFit).toBeNull();
  });

  it("takes a custom build volume between 10 mm and 5 m, and switches the warning off", async () => {
    const select = [...document.querySelectorAll<HTMLSelectElement>("select")].find((s) =>
      [...s.options].some((o) => o.value === "custom"),
    )!;
    await act(async () => void fireEvent.change(select, { target: { value: "custom" } }));

    const [x, , z] = [...document.querySelectorAll<HTMLInputElement>(".bed-size input")];
    await act(async () => void fireEvent.change(x!, { target: { value: "300" } }));
    await act(async () => void fireEvent.blur(x!));
    expect(usePrefs.getState().printBed![0]).toBe(300);
    await act(async () => void fireEvent.change(z!, { target: { value: "5" } }));
    await act(async () => void fireEvent.blur(z!));
    expect(usePrefs.getState().printBed![2]).not.toBe(5);

    const warn = screen
      .getByText(/Warn when a part does not fit the print bed/)
      .closest("label")!
      .querySelector("input")!;
    await act(async () => void fireEvent.click(warn));
    expect(usePrefs.getState().printBed).toBeNull();
    await act(async () => void fireEvent.click(warn));
    expect(usePrefs.getState().printBed).not.toBeNull();
  });

  it("opens the fit test part as a project of its own, and Esc closes the settings", async () => {
    await act(async () => void fireEvent.click(screen.getByText("Print the fit test part…")));
    await waitFor(() => expect(useApp.getState().project?.name).toMatch(/fit/i));
    expect(useApp.getState().doc.features.length).toBeGreaterThan(0);
    await act(async () => void fireEvent.keyDown(window, { key: ",", metaKey: true }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
});
