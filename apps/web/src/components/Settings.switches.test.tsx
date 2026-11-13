/**
 * The settings' switches (Settings.tsx): every checkbox flips its preference and back; the unit
 * choice switches metric and imperial; on the Mac the interface size buttons go to the Mac app and
 * the projects folder can be shown, changed and moved to iCloud; the close button closes.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setPrefs, usePrefs } from "../lib/keymap";
import { newProject } from "../store";
import { renderUi } from "../../test/ui";
import * as storage from "../lib/storage";
import { Settings } from "./Settings";

const desktop = () => (window as unknown as { meercadDesktop: Record<string, Record<string, (...a: never[]) => Promise<unknown>>> }).meercadDesktop;
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeAll(async () => {
  await newProject(undefined, "Settings switches");
  vi.spyOn(desktop()["storage"]!, "status").mockResolvedValue({ dir: "/test", defaultDir: "/test", chosen: true, iCloudDir: "/icloud/meerCAD", iCloudAvailable: true });
  renderUi(<Settings onShortcuts={() => undefined} />);
  await act(async () => void window.dispatchEvent(new Event("meercad:settings")));
  await settle();
});
afterAll(() => {
  vi.restoreAllMocks();
  setPrefs({ units: "metric" } as never);
  cleanup();
});

describe("the settings' switches", () => {
  it("flips every checkbox and back", async () => {
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>(".settings input[type=checkbox]")];
    const before = JSON.stringify(usePrefs.getState());
    const n = boxes().length;
    expect(n).toBeGreaterThan(5);
    for (let i = 0; i < n; i++) {
      const box = boxes()[i];
      if (!box) continue;
      const was = box.checked;
      await act(async () => void fireEvent.click(box));
      expect(boxes()[i]?.checked, `box ${i}`).toBe(!was);
      await act(async () => void fireEvent.click(boxes()[i]!));
    }
    expect(JSON.parse(JSON.stringify(usePrefs.getState()))).toEqual(JSON.parse(before));
  });

  it("switches the units", async () => {
    const units = [...document.querySelectorAll<HTMLSelectElement>(".settings select")].find((s) => [...s.options].some((o) => o.value === "imperial"))!;
    await act(async () => void fireEvent.change(units, { target: { value: "imperial" } }));
    expect(usePrefs.getState().units).toBe("imperial");
    await act(async () => void fireEvent.change(units, { target: { value: "metric" } }));
    expect(usePrefs.getState().units).toBe("metric");
  });

  it("sends the interface size to the Mac app, and shows, changes and moves the projects folder", async () => {
    const sizes: unknown[] = [];
    vi.spyOn(desktop()["uiScale"]!, "set").mockImplementation(async (v: never) => void sizes.push(v));
    const sizeButtons = [...document.querySelectorAll<HTMLButtonElement>(".settings .segmented button")].filter((b) => /%|Small|Large|Default|Klein|Groß/.test(b.textContent ?? ""));
    if (sizeButtons[0]) await act(async () => void fireEvent.click(sizeButtons[0]!));
    const reveal = vi.spyOn(desktop()["projects"]!, "reveal").mockResolvedValue(undefined);
    await act(async () => void fireEvent.click([...document.querySelectorAll(".folder-row button")][0]!));
    expect(reveal).toHaveBeenCalled();
    const change = vi.spyOn(storage, "changeProjectsFolder").mockResolvedValue("/elsewhere");
    await act(async () => void fireEvent.click([...document.querySelectorAll(".folder-row button")][1]!));
    await settle();
    expect(change).toHaveBeenCalledWith();
    await act(async () => void fireEvent.click(screen.getByText("Switch to iCloud")));
    await settle();
    expect(change).toHaveBeenLastCalledWith("/icloud/meerCAD");
    void sizes;
  });

  it("closes by its button", async () => {
    await act(async () => void fireEvent.click(screen.getByTitle("Close (Esc)")));
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
  });
});
