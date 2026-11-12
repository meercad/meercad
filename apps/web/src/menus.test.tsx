/**
 * Every entry of every menu in the editor's bars runs without an error: on a small design with a
 * sketch, two parts and a joint, each entry is picked once, and what it opens is closed again.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The pictures of all examples, made in the background from the start, are tested on their own
// (lib/thumbnails.test.ts): here they would build every example while the test runs.
vi.mock("./lib/thumbnails", async (orig) => ({ ...(await orig<typeof import("./lib/thumbnails")>()), startBackgroundPictures: () => undefined, fillThumbnails: async () => undefined }));
import type { Feature, SketchEntity } from "@meercad/schema";
import { App } from "./App";
import { apply, cancelDialog, closeSketch, newProject, useApp } from "./store";
import { closeMenu } from "./components/Menu";
import { rebuilt, renderUi, withScreen } from "../test/ui";

const rect = (p: string, x: number, y: number, w: number, h: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y },
  { id: `${p}2`, type: "point", x: x + w, y },
  { id: `${p}3`, type: "point", x: x + w, y: y + h },
  { id: `${p}4`, type: "point", x, y: y + h },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 60, 0, 10, 10), constraints: [] },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const bar = (label: string) =>
  screen.getAllByRole("button").find((x) => (x.getAttribute("title") || x.getAttribute("aria-label") || x.textContent?.trim() || "").startsWith(label));

/** Closes whatever an entry opened: menus, dialogs, a sketch, the step dialog, modal panels. */
async function closeAll() {
  await act(async () => {
    closeMenu();
    for (const d of document.querySelectorAll('[role="alertdialog"]')) fireEvent.keyDown(d, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    cancelDialog();
    if (useApp.getState().sketchId) closeSketch();
    useApp.setState({ measure: { active: false, picks: [], result: null }, pickingSketchPlane: false });
  });
  for (const b of document.querySelectorAll<HTMLElement>(".modal-backdrop")) await act(async () => void fireEvent.pointerDown(b));
  await settle();
}

beforeAll(async () => {
  withScreen(1280, 800);
  localStorage.setItem("meercad.tourDone", "1");
  renderUi(<App />);
  await act(async () => newProject(undefined, "Menus"));
  apply({ type: "add_features", features: design }, { type: "set_joint", joint: { id: "j1", type: "slider", a: "ex2", b: "ground", anchor: { axis: { ref: "origin.X" } }, limits: [-30, 30] } });
  await rebuilt();
  await settle();
});
afterAll(cleanup);

describe("every menu entry", () => {
  for (const menu of ["Create", "Modify", "Transform", "View options", "Display mode", "More: settings, help, projects", "Import and export"]) {
    it(`runs in “${menu}”`, async () => {
      await act(async () => void fireEvent.click(bar(menu)!));
      await settle();
      const count = screen.queryAllByRole("menuitem").length;
      expect(count, menu).toBeGreaterThan(0);
      const done: string[] = [];
      for (let i = 0; i < count; i++) {
        await closeAll();
        await act(async () => void fireEvent.click(bar(menu)!));
        await settle();
        const items = screen.queryAllByRole("menuitem");
        const item = items[i];
        if (!item || (item as HTMLButtonElement).disabled) continue;
        // Entries that leave the app (quit, open a web page) are left out.
        if (/Quit|Website|Privacy|Licen|Feedback|Buy|Restore purchases|Choose another folder/.test(item.textContent ?? "")) continue;
        done.push(item.textContent ?? "");
        await act(async () => void fireEvent.click(item));
        await settle();
        // A submenu: each of its entries too.
        const sub = screen.queryAllByRole("menuitem").filter((x) => !items.includes(x));
        if (sub.length && document.querySelector(".menu-back")) {
          for (let j = 1; j < sub.length; j++) {
            const s = screen.queryAllByRole("menuitem")[j];
            if (!s || /Quit|Website/.test(s.textContent ?? "")) continue;
            await act(async () => void fireEvent.click(s));
            await settle();
            await closeAll();
            await act(async () => void fireEvent.click(bar(menu)!));
            await settle();
            const again = screen.queryAllByRole("menuitem")[i];
            if (!again) break;
            await act(async () => void fireEvent.click(again));
            await settle();
          }
        }
      }
      await closeAll();
      expect(done.length).toBeGreaterThan(0);
    }, 400_000);
  }
});
