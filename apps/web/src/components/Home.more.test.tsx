/**
 * More of the overview (Home.tsx): how long ago each project changed (minutes, hours, a date); the
 * keys while choosing several (⌘A takes all, Delete deletes them after one question, Space and
 * Enter pick a card) and Enter opening a project; a project's menu (open, show in Finder); a folder
 * opened by click and by Enter, a drag held over it; the buttons for new and import; an example kept
 * as a file is fetched, and one that cannot be fetched says so.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyDocument } from "@meercad/schema";
import { goHome, refreshProjects, useApp } from "../store";
import { createFolder, createProject } from "../lib/persistence";
import { answer, pickMenu, renderUi, withScreen } from "../../test/ui";
import { testFiles } from "../../test/setup";
import { Home, openExample } from "./Home";

vi.mock("../lib/thumbnails", async (orig) => ({ ...(await orig<typeof import("../lib/thumbnails")>()), fillThumbnails: async () => undefined }));

const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const card = (name: string) => screen.getAllByText(name).map((e) => e.closest(".card")).find(Boolean) as HTMLElement;
const exists = (name: string) => [...testFiles.projects.values()].some((p) => p.name === name);
const MIN = 60_000;

beforeAll(async () => {
  withScreen();
  const now = Date.now();
  for (const [n, ago] of [["Minutes", 5 * MIN], ["Hours", 3 * 60 * MIN], ["Days", 4 * 24 * 60 * MIN], ["Other", 2 * MIN]] as const) {
    const meta = await createProject(n, emptyDocument());
    testFiles.projects.get(meta.id)!.modified = now - ago;
  }
  await createFolder("", "Shelf");
  await refreshProjects();
  goHome();
  renderUi(<Home />);
  await settle();
});
afterAll(cleanup);

describe("the overview, more", () => {
  it("says how long ago each project changed", () => {
    expect(card("Minutes").textContent).toMatch(/5 min ago/);
    expect(card("Hours").textContent).toMatch(/3 h ago/);
    expect(card("Days").textContent).toContain(new Date(Date.now() - 4 * 24 * 60 * MIN).toLocaleDateString());
  });

  it("opens a project by Enter and by its menu", async () => {
    await act(async () => void fireEvent.keyDown(card("Minutes"), { key: "Enter" }));
    await settle(50);
    expect(useApp.getState().project?.name).toBe("Minutes");
    await act(async () => goHome());
    await settle();
    await act(async () => void fireEvent.contextMenu(card("Hours")));
    await pickMenu("Open");
    await settle(50);
    expect(useApp.getState().project?.name).toBe("Hours");
    await act(async () => goHome());
    await settle();
    // On the Mac, a project's menu also shows it in the Finder.
    const desktop = (window as unknown as { meercadDesktop: { projects: { reveal: (x: unknown) => Promise<void> } } }).meercadDesktop;
    const shown: unknown[] = [];
    const own = desktop.projects.reveal;
    desktop.projects.reveal = async (x) => void shown.push(x);
    await act(async () => void fireEvent.contextMenu(card("Days")));
    await pickMenu("Show in Finder");
    desktop.projects.reveal = own;
    expect(shown).toHaveLength(1);
  });

  it("takes all with ⌘A while choosing, and deletes them with Delete after one question", async () => {
    await act(async () => void fireEvent.click(screen.getByTitle("Select several parts to move or delete them together")));
    await act(async () => void fireEvent.keyDown(card("Other"), { key: " " }));
    expect(screen.getByText("1 part selected")).toBeTruthy();
    await act(async () => void fireEvent.keyDown(window, { key: "a", metaKey: true }));
    expect(screen.getByText(/^\d+ parts selected$/)).toBeTruthy();
    // Back to the one, then Delete.
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    await act(async () => void fireEvent.click(screen.getByTitle("Select several parts to move or delete them together")));
    await act(async () => void fireEvent.keyDown(card("Other"), { key: "Enter" }));
    await act(async () => void fireEvent.keyDown(window, { key: "Delete" }));
    await answer();
    await settle(50);
    expect(exists("Other")).toBe(false);
  });

  it("opens a folder by click and by Enter, and takes a drag held over it", async () => {
    const folderCard = () => screen.getAllByText("Shelf").map((e) => e.closest(".card")).find(Boolean) as HTMLElement;
    await act(async () => void fireEvent.dragOver(folderCard(), { dataTransfer: { types: ["application/x-meercad-project"] } }));
    await act(async () => void fireEvent.dragLeave(folderCard()));
    await act(async () => void fireEvent.keyDown(folderCard(), { key: "Enter" }));
    expect(useApp.getState().folder).toBe("Shelf");
    await act(async () => useApp.setState({ folder: "" }));
    await settle();
    await act(async () => void fireEvent.click(folderCard()));
    expect(useApp.getState().folder).toBe("Shelf");
    await act(async () => useApp.setState({ folder: "" }));
    await settle();
  });

  it("starts a new project from its card", async () => {
    const before = testFiles.projects.size;
    const newCard = document.querySelector<HTMLElement>(".card.new")!;
    await act(async () => void fireEvent.click(newCard));
    await settle(50);
    expect(testFiles.projects.size).toBe(before + 1);
    await act(async () => goHome());
    await settle();
  });

  it("fetches an example kept as a file, and says when it cannot", async () => {
    const doc = { ...emptyDocument(), params: { w: "12 mm" } };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(doc)));
    await act(async () => void (await openExample({ name: "Fetched example", url: "/examples/x.json", doc: emptyDocument() } as never)));
    expect(useApp.getState().project?.name).toMatch(/Fetched example/);
    expect(useApp.getState().doc.params["w"]).toBe("12 mm");
    await act(async () => goHome());
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    await act(async () => void (await openExample({ name: "Gone example", url: "/examples/y.json", doc: emptyDocument() } as never)));
    expect(useApp.getState().toasts.map((t) => t.text).join(" ")).toMatch(/Could not open .*offline/);
    fetchSpy.mockRestore();
  });
});
