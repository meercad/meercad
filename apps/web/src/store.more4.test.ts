/**
 * More of the app's state (store.ts): the last tab closed goes home; an assistant taking over the
 * open project closes its tab here (home when it was the only one, else the neighbour); a rename the
 * files refuse says so; a project that cannot be read is not opened; an old design with a surface
 * texture or cables opens without them and says so; an assistant's tab is shown and, closed by the
 * Mac app, falls back to the user's tab.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDocument, type Feature } from "@meercad/schema";
import { closeTab, newProject, openProject, releaseProject, renameProject, replaceDocument, setAssistantTabs, showAssistantTab, useApp } from "./store";
import * as persistence from "./lib/persistence";
import { createProject } from "./lib/persistence";

const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
afterEach(() => vi.restoreAllMocks());

describe("tabs", () => {
  it("goes home when the last tab closes, and when an assistant takes the only open project", async () => {
    useApp.setState({ tabs: [] } as never);
    await newProject(undefined, "Only tab");
    const id = useApp.getState().project!.id;
    closeTab(id);
    await vi.waitFor(() => expect(useApp.getState().screen).toBe("home"));
    await openProject(id);
    await releaseProject(id);
    expect(useApp.getState().screen).toBe("home");
    expect(useApp.getState().tabs.some((t) => t.id === id)).toBe(false);
  });

  it("switches to the neighbour when an assistant takes the open project", async () => {
    useApp.setState({ tabs: [] } as never);
    await newProject(undefined, "Left");
    const left = useApp.getState().project!.id;
    await newProject(undefined, "Right");
    const right = useApp.getState().project!.id;
    await releaseProject(right);
    expect(useApp.getState().project?.id).toBe(left);
    // A tab not open just goes.
    await newProject(undefined, "Third");
    await releaseProject(left);
    expect(useApp.getState().tabs.some((t) => t.id === left)).toBe(false);
  });
});

describe("projects", () => {
  it("says so when the files refuse a rename", async () => {
    await newProject(undefined, "To rename");
    vi.spyOn(persistence, "renameProjectFile").mockRejectedValueOnce(new Error("name taken"));
    await renameProject("Other name");
    expect(toasts()).toMatch(/Could not rename: name taken/);
    expect(useApp.getState().project?.name).toBe("To rename");
  });

  it("does not open a project that cannot be read", async () => {
    await newProject(undefined, "Stays open");
    const before = useApp.getState().project!.id;
    vi.spyOn(persistence, "loadProject").mockRejectedValueOnce(new Error("iCloud not there"));
    await openProject("gone-project");
    expect(useApp.getState().project?.id).toBe(before);
  });

  it("opens an old design without its surface texture and cables, and says so", async () => {
    const old = { ...emptyDocument(), features: [
      { id: "tx1", op: "texture", faces: [], image: { width: 1, height: 1, pixels: "AA==" }, depth: 1, pitch: 5 } as unknown as Feature,
      { id: "cb1", op: "cable", path: { sketch: "sk1" }, diameter: 3 } as unknown as Feature,
    ] };
    const meta = await createProject("Old one", old);
    await openProject(meta.id);
    await settle();
    expect(useApp.getState().doc.features).toEqual([]);
    expect(toasts()).toMatch(/surface texture/);
    expect(toasts()).toMatch(/cables/);
    // A whole design put in place at once.
    replaceDocument({ ...emptyDocument(), params: { k: "2 mm" } });
    expect(useApp.getState().doc.params["k"]).toBe("2 mm");
  });
});

describe("assistants' tabs", () => {
  it("shows one, and when the Mac app closes it falls back to the user's tab", async () => {
    useApp.setState({ tabs: [] } as never);
    await newProject(undefined, "Users own");
    const own = useApp.getState().project!.id;
    setAssistantTabs([{ session: "S1", client: "Claude", project: null } as never]);
    showAssistantTab("S1");
    expect(useApp.getState().assistantTab).toBe("S1");
    expect(useApp.getState().project).toBeNull();
    showAssistantTab("S1");
    expect(useApp.getState().assistantTab).toBe("S1");
    setAssistantTabs([]);
    await vi.waitFor(() => expect(useApp.getState().project?.id).toBe(own));
  });
});
