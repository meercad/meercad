/**
 * Sharing a design (ShareDialog.tsx), the parts other tests leave: sharing that fails says why and
 * keeps the dialog; Cancel, the close button and a press beside it close it.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newProject, useApp } from "../store";
import { renderUi } from "../../test/ui";
import { ShareDialog, openShare } from "./ShareDialog";

const desktop = () => (window as unknown as { meercadDesktop: Record<string, unknown> }).meercadDesktop;
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

beforeAll(async () => {
  await newProject(undefined, "Shared");
  renderUi(<ShareDialog />);
});
afterAll(() => {
  delete desktop()["shareFile"];
  cleanup();
});

describe("sharing a design", () => {
  it("says why sharing failed and stays open", async () => {
    desktop()["shareFile"] = vi.fn(async () => {
      throw new Error("no share sheet");
    });
    await act(async () => openShare());
    await act(async () => void fireEvent.click(screen.getByText("Share…")));
    await settle();
    expect(toasts()).toMatch(/Could not share .*: no share sheet/);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes by Cancel, its button and a press beside it", async () => {
    await act(async () => void fireEvent.click(screen.getByText("Cancel")));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => openShare());
    await act(async () => void fireEvent.pointerDown(screen.getByRole("dialog")));
    await act(async () => void fireEvent.click(screen.getByTitle("Close (Esc)")));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => openShare());
    await act(async () => void fireEvent.pointerDown(document.querySelector(".modal-backdrop")!));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
