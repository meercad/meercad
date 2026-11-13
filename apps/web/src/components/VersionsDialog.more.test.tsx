/**
 * The versions dialog (VersionsDialog.tsx), the parts other tests leave: one or several versions
 * brought in from a file say so, none says nothing; renaming takes a new name on Enter or leaving
 * the field, keeps it on Escape or when blank; a look at a version that cannot be made says why; a
 * press beside the dialog closes it.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as io from "./io";
import * as model from "@meercad/model";
import { apply, newProject, useApp } from "../store";
import { renderUi } from "../../test/ui";
import { VersionsDialog, openVersions } from "./VersionsDialog";

const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
const names = () => (useApp.getState().doc.versions ?? []).map((v) => v.name);

beforeAll(async () => {
  await newProject(undefined, "Versions more");
  apply({ type: "save_version", name: "First" });
  renderUi(<VersionsDialog />);
  await act(async () => openVersions());
});
afterAll(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the versions dialog", () => {
  it("says what came in from a file", async () => {
    const from = vi.spyOn(io, "importVersionFile").mockResolvedValueOnce(["Old"]).mockResolvedValueOnce(["A", "B"]).mockResolvedValueOnce([]);
    const before = useApp.getState().toasts.length;
    for (let i = 0; i < 3; i++) await act(async () => void fireEvent.click(screen.getByText("From file…")));
    expect(from).toHaveBeenCalledTimes(3);
    expect(toasts()).toMatch(/Brought in as version “Old”/);
    expect(toasts()).toMatch(/Brought in 2 versions/);
    expect(useApp.getState().toasts.length).toBe(before + 2);
  });

  it("renames on Enter and on leaving the field, and keeps the name on Escape or when blank", async () => {
    const field = () => document.querySelector<HTMLInputElement>(".version-main input")!;
    await act(async () => void fireEvent.click(screen.getByTitle("Rename")));
    await act(async () => void fireEvent.change(field(), { target: { value: "Second" } }));
    await act(async () => void fireEvent.keyDown(field(), { key: "Enter" }));
    expect(names()).toEqual(["Second"]);
    await act(async () => void fireEvent.click(screen.getByTitle("Rename")));
    await act(async () => void fireEvent.change(field(), { target: { value: "Third" } }));
    await act(async () => void fireEvent.keyDown(field(), { key: "Escape" }));
    expect(names()).toEqual(["Second"]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByTitle("Rename")));
    await act(async () => void fireEvent.change(field(), { target: { value: "  " } }));
    await act(async () => void fireEvent.blur(field()));
    expect(names()).toEqual(["Second"]);
    await act(async () => void fireEvent.click(screen.getByTitle("Rename")));
    await act(async () => void fireEvent.change(field(), { target: { value: "Fourth" } }));
    await act(async () => void fireEvent.blur(field()));
    expect(names()).toEqual(["Fourth"]);
  });

  it("says why a version cannot be looked at, and closes by a press beside it", async () => {
    vi.spyOn(model, "designOf").mockImplementationOnce(() => {
      throw new Error("version is broken");
    });
    await act(async () => void fireEvent.click(screen.getByTitle("Look at it (the design stays as it is)")));
    expect(toasts()).toMatch(/version is broken/);
    await act(async () => void fireEvent.pointerDown(screen.getByRole("dialog")));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await act(async () => void fireEvent.pointerDown(document.querySelector(".modal-backdrop")!));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
