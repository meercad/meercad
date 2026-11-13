/**
 * The overview's smaller controls (Home.tsx): the footer's links open About on each tab; the examples
 * fold away and back; inside a folder the path leads back up and Finder shows the folder; a card's
 * "…" button opens its menu.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyDocument } from "@meercad/schema";
import { goHome, refreshProjects, useApp } from "../store";
import { usePrefs } from "../lib/keymap";
import { createFolder, createProject } from "../lib/persistence";
import { renderUi, withScreen } from "../../test/ui";
import { Home } from "./Home";

vi.mock("../lib/thumbnails", async (orig) => ({ ...(await orig<typeof import("../lib/thumbnails")>()), fillThumbnails: async () => undefined }));

const desktop = () => (window as unknown as { meercadDesktop: { projects: Record<string, (...a: never[]) => Promise<unknown>> } }).meercadDesktop;
const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeAll(async () => {
  withScreen();
  await createFolder("", "Bench");
  await createProject("Vise", emptyDocument(), "Bench");
  await refreshProjects();
  goHome();
  renderUi(<Home />);
  await settle();
});
afterAll(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the overview's smaller controls", () => {
  it("opens About on each tab from the footer", async () => {
    const asked: unknown[] = [];
    const on = (e: Event) => asked.push((e as CustomEvent).detail);
    window.addEventListener("meercad:about", on);
    for (const label of ["About meerCAD", "Terms of use", "Privacy", "Licences"]) await act(async () => void fireEvent.click(screen.getByText(label, { selector: "footer button" })));
    window.removeEventListener("meercad:about", on);
    expect(asked).toEqual(["about", "terms", "privacy", "licenses"]);
  });

  it("folds the examples away and back", async () => {
    const toggle = document.querySelector<HTMLButtonElement>(".home-section-toggle")!;
    const was = usePrefs.getState().examplesOpen;
    await act(async () => void fireEvent.click(toggle));
    expect(usePrefs.getState().examplesOpen).toBe(!was);
    await act(async () => void fireEvent.click(toggle));
    expect(usePrefs.getState().examplesOpen).toBe(was);
  });

  it("leads back up from a folder, shows it in Finder, and opens a card's menu", async () => {
    await act(async () => useApp.setState({ folder: "Bench" }));
    await settle();
    const reveal = vi.spyOn(desktop().projects, "reveal").mockResolvedValue(undefined);
    await act(async () => void fireEvent.click(screen.getByTitle("Show this folder in Finder")));
    expect(reveal).toHaveBeenCalledWith({ folder: "Bench" });
    await act(async () => void fireEvent.click(screen.getByTitle("Part actions")));
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(2);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    const top = document.querySelector<HTMLButtonElement>(".crumb:not(.current)")!;
    await act(async () => void fireEvent.click(top));
    expect(useApp.getState().folder).toBe("");
  });
});
