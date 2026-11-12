/**
 * Choosing several projects on the overview (Home.tsx) and acting on them together: selecting by
 * click, Shift-click and Select all; moving them into a folder by the bar's menu, by the right-click
 * menu and by dragging onto the folder; deleting them after one question; Escape and Done leave
 * the choosing. Then the folder's own menu: opened, and deleted with what it holds.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyDocument } from "@meercad/schema";
import { goHome, refreshProjects, useApp } from "../store";
import { createFolder, createProject } from "../lib/persistence";
import { answer, pickMenu, renderUi, withScreen } from "../../test/ui";
import { testFiles } from "../../test/setup";
import { Home } from "./Home";

vi.mock("../lib/thumbnails", async (orig) => ({ ...(await orig<typeof import("../lib/thumbnails")>()), fillThumbnails: async () => undefined }));

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const card = (name: string) => screen.getAllByText(name).map((e) => e.closest(".card")).find(Boolean) as HTMLElement;
const button = (text: string | RegExp) => screen.getAllByRole("button").find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")))!;
const folderOf = (name: string) => [...testFiles.projects.values()].find((p) => p.name === name)?.folder ?? "";
const exists = (name: string) => [...testFiles.projects.values()].some((p) => p.name === name);
const click = async (el: Element, opts: MouseEventInit = {}) => {
  await act(async () => void fireEvent.click(el, opts));
  await settle();
};

beforeAll(async () => {
  withScreen();
  for (const n of ["One", "Two", "Three", "Four", "Five"]) await createProject(n, emptyDocument());
  await createFolder("", "Box");
  await refreshProjects();
  goHome();
  renderUi(<Home />);
  await settle();
});
afterAll(cleanup);

describe("several projects at once", () => {
  it("chooses by click and Shift-click, and Select all / none", async () => {
    await click(screen.getByTitle("Select several parts to move or delete them together"));
    await click(card("One"));
    expect(screen.getByText("1 part selected")).toBeTruthy();
    await click(card("One"));
    expect(screen.getByText("Choose the parts to move or delete")).toBeTruthy();
    await click(button("Select all"));
    expect(screen.getByText(/^\d+ parts selected$/)).toBeTruthy();
    await click(button("Select none"));
    expect(screen.getByText("Choose the parts to move or delete")).toBeTruthy();
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    await settle();
    expect(screen.queryByText("Choose the parts to move or delete")).toBeNull();
  });

  it("moves two chosen projects into a folder from the bar", async () => {
    await click(card("One"), { metaKey: true });
    await click(card("Two"), { metaKey: true });
    expect(screen.getByText("2 parts selected")).toBeTruthy();
    await click(button("Move to…"));
    await pickMenu("Box");
    await settle();
    expect([folderOf("One"), folderOf("Two")]).toEqual(["Box", "Box"]);
    expect(useApp.getState().toasts.at(-1)!.text).toBe("Moved 2 parts to Box");
  });

  it("moves chosen ones by their right-click menu, and by dragging onto a folder", async () => {
    await click(card("Three"), { metaKey: true });
    await click(card("Four"), { metaKey: true });
    await act(async () => void fireEvent.contextMenu(card("Three"), { clientX: 5, clientY: 5 }));
    await pickMenu("Move 2 parts to");
    await pickMenu("Box");
    await settle();
    expect([folderOf("Three"), folderOf("Four")]).toEqual(["Box", "Box"]);
    // Drag "Five" onto the folder.
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => void data.set(k, v), getData: (k: string) => data.get(k) ?? "", effectAllowed: "" };
    await act(async () => void fireEvent.dragStart(card("Five"), { dataTransfer }));
    const box = screen.getAllByText("Box").map((e) => e.closest(".card, .folder")).find(Boolean) as HTMLElement;
    await act(async () => void fireEvent.drop(box, { dataTransfer }));
    await settle();
    expect(folderOf("Five")).toBe("Box");
  });

  it("deletes the chosen ones after asking once", async () => {
    // Into the folder, where they all are now.
    await act(async () => useApp.setState({ folder: "Box" }));
    await settle();
    await click(card("One"), { metaKey: true });
    await click(card("Two"), { shiftKey: true });
    await click(button("Delete…"));
    await answer(null);
    expect(exists("One")).toBe(true);
    await click(button("Delete…"));
    await answer();
    await settle();
    expect([exists("One"), exists("Two")]).toEqual([false, false]);
    // Done: the choosing ends with the deletion.
    expect(screen.queryByText(/parts? selected$/)).toBeNull();
  });

  it("deletes a folder with what it holds, after saying how much", async () => {
    await act(async () => useApp.setState({ folder: "" }));
    await settle();
    await act(async () => void fireEvent.click(screen.getAllByTitle("Folder actions")[0]!));
    await pickMenu("Open");
    expect(useApp.getState().folder).toBe("Box");
    await act(async () => useApp.setState({ folder: "" }));
    await settle();
    await act(async () => void fireEvent.click(screen.getAllByTitle("Folder actions")[0]!));
    await pickMenu("Delete folder…");
    const inside = [...testFiles.projects.values()].filter((p) => p.folder === "Box").length;
    expect(inside).toBeGreaterThan(1);
    expect(screen.getByRole("alertdialog").textContent).toMatch(new RegExp(`It contains ${inside} parts, which will be deleted too`));
    await answer();
    await settle();
    expect(testFiles.folders.has("Box")).toBe(false);
    expect([...testFiles.projects.values()].filter((p) => p.folder === "Box")).toEqual([]);
  });
});
