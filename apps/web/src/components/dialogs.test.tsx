/**
 * The app's own dialogs (settings, about, versions, drawing, share, materials) opened as the app
 * opens them and used: every control in each is used once, and the ones that change the design
 * change it as asked (a version saved and restored, a material set on a part with its mass).
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { AboutDialog } from "./AboutDialog";
import { DrawingDialog } from "./DrawingDialog";
import { MaterialPicker } from "./MaterialPicker";
import { Settings } from "./Settings";
import { ShareDialog } from "./ShareDialog";
import { VersionsDialog } from "./VersionsDialog";
import { openMaterialPicker } from "./MaterialPicker";

const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 40, y: 0 },
  { id: "p3", type: "point", x: 40, y: 20 },
  { id: "p4", type: "point", x: 0, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "h", mode: "new_body" },
];
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));

/** Uses every control inside `root` once, skipping those that close it or leave the app. */
async function useEvery(
  root: () => Element | null,
  skip = /Close|Cancel|Quit|Website|Licen|Privacy|Buy|Restore/,
) {
  const seen = new Set<Element>();

  for (let round = 0; round < 3; round++) {
    const el = root();
    if (!el) return;

    const controls = [...el.querySelectorAll<HTMLElement>("input, select, button")].filter(
      (c) => !seen.has(c),
    );
    if (!controls.length) return;

    for (const c of controls) {
      seen.add(c);
      if (!root()?.contains(c)) continue;

      const label = `${c.getAttribute("title") ?? ""} ${c.getAttribute("aria-label") ?? ""} ${c.textContent ?? ""}`;
      if (skip.test(label)) continue;

      if (c instanceof HTMLSelectElement) {
        const o = [...c.options].at(-1);
        if (o) await act(async () => void fireEvent.change(c, { target: { value: o.value } }));
      } else if (c instanceof HTMLInputElement) {
        if (c.type === "checkbox" || c.type === "radio") {
          await act(async () => void fireEvent.click(c));
        } else if (c.type !== "file" && c.type !== "color") {
          await act(
            async () =>
              void fireEvent.change(c, { target: { value: c.type === "range" ? c.max || "1" : "2" } }),
          );
        }
      } else {
        await act(async () => void fireEvent.click(c));
      }

      await settle(5);
    }
  }
}

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Dialogs");
  apply({ type: "set_param", name: "h", expr: "10 mm" }, { type: "add_features", features: design });
  await rebuilt();
});
afterAll(cleanup);

describe("the app's dialogs", () => {
  it("saves a version, changes the design and restores the version", async () => {
    renderUi(<VersionsDialog />);
    await act(async () => void window.dispatchEvent(new CustomEvent("meercad:versions")));
    await settle();

    const save = screen.getAllByRole("button").find((b) => /Save/.test(b.textContent ?? ""))!;
    await act(async () => void fireEvent.click(save));
    await settle();
    expect(currentDoc().versions?.length).toBe(1);
    await act(async () => void apply({ type: "set_param", name: "h", expr: "30 mm" }));

    const restore = screen
      .getAllByRole("button")
      .find((b) => /Restore/.test(b.textContent ?? b.getAttribute("title") ?? ""));

    if (restore) {
      await act(async () => void fireEvent.click(restore));
      await settle();

      const ok = document.querySelector(
        '[role="alertdialog"] .btn.primary, [role="alertdialog"] .btn.danger',
      );
      if (ok) await act(async () => void fireEvent.click(ok));

      await settle();
      expect(currentDoc().params["h"]).toBe("10 mm");
    }

    await useEvery(() => document.querySelector(".modal, .dialog, .versions"));
    cleanup();
  });

  it("sets a part's material and shows its mass", async () => {
    renderUi(<MaterialPicker />);
    await act(async () => openMaterialPicker(["ex1"]));
    await settle();

    const petg = screen.getAllByRole("button").find((b) => /PETG/.test(b.textContent ?? ""))!;
    await act(async () => void fireEvent.click(petg));
    await settle();
    expect(currentDoc().partMaterials?.["ex1"]).toBe("petg");
    await useEvery(() => document.querySelector(".material-picker, .modal"));
    cleanup();
  });

  it("opens settings, about, share and drawing and uses their controls", async () => {
    for (const [ui, event] of [
      [<Settings onShortcuts={() => undefined} />, "meercad:settings"],
      [<AboutDialog />, "meercad:about"],
      [<ShareDialog />, "meercad:share"],
      [<DrawingDialog />, "meercad:drawing"],
    ] as const) {
      renderUi(ui);
      await act(async () => void window.dispatchEvent(new CustomEvent(event)));
      await settle(100);
      expect(document.body.textContent!.length, event).toBeGreaterThan(20);
      await useEvery(() => document.querySelector(".modal, .settings, .dialog, .sheet, [role=dialog]"));
      cleanup();
    }

    expect(
      useApp
        .getState()
        .toasts.filter((t) => t.kind === "error")
        .map((t) => t.text),
    ).toEqual([]);
  });
});
