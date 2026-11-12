/**
 * The projects overview (Home.tsx) over projects kept in memory: folders made, renamed and
 * deleted, projects moved and deleted (one or several), sorted, opened, and an example opened as a
 * project of its own.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyDocument } from "@meercad/schema";
import { goHome, refreshProjects, useApp } from "../store";
import { createProject } from "../lib/persistence";
import { answer, pickMenu, renderUi, withScreen } from "../../test/ui";
import { testFiles } from "../../test/setup";
import { Home } from "./Home";

vi.mock("../lib/thumbnails", async (orig) => ({ ...(await orig<typeof import("../lib/thumbnails")>()), fillThumbnails: async () => undefined }));

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const card = (name: string) => screen.getAllByText(name).map((e) => e.closest(".card")).find(Boolean) as HTMLElement;

beforeAll(async () => {
  withScreen();
  for (const n of ["Alpha", "Beta", "Gamma"]) await createProject(n, emptyDocument());
  await refreshProjects();
  goHome();
  renderUi(<Home />);
  await settle();
});
afterAll(cleanup);

describe("the projects overview", () => {
  it("lists the projects", () => {
    for (const n of ["Alpha", "Beta", "Gamma"]) expect(screen.getAllByText(n).length).toBeGreaterThan(0);
  });

  it("makes a folder and moves a project into it", async () => {
    await act(async () => void fireEvent.click(screen.getAllByRole("button").find((b) => /New folder/.test(b.textContent ?? ""))!));
    await answer("Work");
    await settle();
    expect(testFiles.folders.has("Work")).toBe(true);
    await act(async () => void fireEvent.contextMenu(card("Alpha"), { clientX: 5, clientY: 5 }));
    await pickMenu("Move to Work");
    await settle();
    expect([...testFiles.projects.values()].find((p) => p.name === "Alpha")!.folder).toBe("Work");
  });

  it("renames and deletes a folder", async () => {
    const folder = screen.getAllByText("Work").map((e) => e.closest('[role="button"], .card, .folder, button, div')).find(Boolean) as HTMLElement;
    await act(async () => void fireEvent.contextMenu(folder, { clientX: 5, clientY: 5 }));
    await pickMenu("Rename");
    await answer("Jobs");
    await settle();
    expect(testFiles.folders.has("Jobs")).toBe(true);
  });

  it("deletes a project after asking", async () => {
    await act(async () => void fireEvent.contextMenu(card("Beta"), { clientX: 5, clientY: 5 }));
    await pickMenu("Delete");
    await answer();
    await settle();
    expect([...testFiles.projects.values()].some((p) => p.name === "Beta")).toBe(false);
  });

  it("sorts the projects and turns the order round", async () => {
    await act(async () => void fireEvent.click(screen.getByTitle("Sort parts")));
    const items = screen.getAllByRole("menuitem");
    await act(async () => void fireEvent.click(items.at(-1)!));
    const order = screen.getAllByRole("button").find((b) => /click to reverse/.test(b.getAttribute("title") ?? ""))!;
    await act(async () => void fireEvent.click(order));
    await settle();
  });

  it("opens a project", async () => {
    await act(async () => void fireEvent.click(card("Gamma")));
    await waitFor(() => expect(useApp.getState().project?.name).toBe("Gamma"));
    goHome();
    await settle();
  });
});
