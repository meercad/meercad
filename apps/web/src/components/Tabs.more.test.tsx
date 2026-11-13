/**
 * The tab strip (Tabs.tsx), the parts other tests leave: Enter opens a tab; a drag that leaves a tab
 * takes its mark away; the name field selects its text on focus and a click in it opens nothing;
 * an assistant's tab opens on Enter and its close button hands the project back.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as store from "../store";
import { renderUi } from "../../test/ui";
import { TabStrip } from "./Tabs";

const { newProject, useApp } = store;
let first = "";

beforeAll(async () => {
  await newProject(undefined, "Tab one");
  first = useApp.getState().project!.id;
  await newProject(undefined, "Tab two");
  renderUi(<TabStrip />);
});
afterAll(() => {
  vi.restoreAllMocks();
  useApp.setState({ assistantTabs: [] });
  cleanup();
});

describe("the tab strip", () => {
  it("opens a tab on Enter, and drops the drag mark when a drag leaves", async () => {
    const tab = screen.getAllByRole("tab").find((t) => t.textContent?.includes("Tab one"))!;
    await act(async () => void fireEvent.keyDown(tab, { key: "Enter" }));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(useApp.getState().project?.id).toBe(first);
    const dt = { types: ["application/x-meercad-tab"], setData: () => undefined, getData: () => "" };
    await act(async () => void fireEvent.dragOver(tab, { dataTransfer: dt }));
    await act(async () => void fireEvent.dragLeave(tab));
    expect(tab.className).not.toContain("drop-before");
  });

  it("selects the name on focus, and a click in the field opens nothing", async () => {
    const tab = screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")!;
    await act(async () => void fireEvent.doubleClick(tab));
    const field = screen.getByLabelText("Project name") as HTMLInputElement;
    await act(async () => void fireEvent.focus(field));
    expect(field.selectionEnd! - field.selectionStart!).toBe(field.value.length);
    const open = vi.spyOn(store, "openProject");
    await act(async () => void fireEvent.click(field));
    expect(open).not.toHaveBeenCalled();
    await act(async () => void fireEvent.keyDown(field, { key: "Escape" }));
  });

  it("opens an assistant's tab on Enter and hands it back by its close button", async () => {
    const show = vi.spyOn(store, "showAssistantTab").mockImplementation(() => undefined);
    const hand = vi.spyOn(store, "handOverAssistantTab").mockResolvedValue(undefined);
    await act(async () => useApp.setState({ assistantTabs: [{ session: "s1", name: "Robot arm", busy: true, project: "p1" }] as never }));
    const tab = document.querySelector<HTMLElement>(".ai-tab")!;
    await act(async () => void fireEvent.keyDown(tab, { key: "Enter" }));
    expect(show).toHaveBeenCalledWith("s1");
    await act(async () => void fireEvent.click(screen.getByTitle("Close: the assistant stops working on it")));
    expect(hand).toHaveBeenCalledWith("s1", false);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
