/**
 * Submenus (Menu.tsx): Escape or the left arrow in a submenu goes back up one level instead of closing,
 * and the back entry does the same; Escape at the top closes the menu.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";
import { renderUi } from "../../test/ui";
import { showMenu } from "./Menu";

afterAll(cleanup);
const labels = () => screen.queryAllByRole("menuitem").map((m) => m.textContent);

describe("submenus", () => {
  it("go back up on Escape, the left arrow and the back entry", async () => {
    renderUi(<div />);
    await act(async () => showMenu(10, 10, [{ label: "Export", submenu: [{ label: "STL", onClick: () => undefined }, { label: "3MF", onClick: () => undefined }] }, { label: "Close", onClick: () => undefined }]));
    const open = async () => act(async () => void fireEvent.click(screen.getByText("Export")));
    await open();
    expect(labels()).toContain("STL");
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(labels()).toEqual(["Export", "Close"]);
    await open();
    await act(async () => void fireEvent.keyDown(window, { key: "ArrowLeft" }));
    expect(labels()).toEqual(["Export", "Close"]);
    await open();
    await act(async () => void fireEvent.keyDown(window, { key: "ArrowDown" }));
    expect(labels()).toContain("STL");
    await act(async () => void fireEvent.click(document.querySelector(".menu-back")!));
    expect(labels()).toEqual(["Export", "Close"]);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(labels()).toEqual([]);
  });
});
