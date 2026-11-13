/**
 * Where projects are kept (storage.ts): the projects folder changed by the system dialog, with the
 * question whether the projects already there move along (and how many were left because they
 * existed), a folder the Mac app refuses, a dialog closed without a choice; on the iPad and iPhone
 * the switch to iCloud asked first, refused when iCloud is off.
 */
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyDocument } from "@meercad/schema";
import { refreshProjects, useApp } from "../store";
import { createProject } from "./persistence";
import { answer, renderUi } from "../../test/ui";
import { changeProjectsFolder, folderLabel, switchNativeStorage } from "./storage";
import * as native from "./native";

const desktop = () => (window as unknown as { meercadDesktop: { storage: Record<string, (...a: never[]) => Promise<unknown>> } }).meercadDesktop.storage;
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");

beforeAll(async () => {
  await createProject("Kept", emptyDocument());
  await refreshProjects();
});
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the projects folder", () => {
  it("names the App Store app's own folder and iCloud as people know them", () => {
    expect(folderLabel("/Users/a/Library/Containers/de.meercad/Data/Documents/Projects")).toBe("On this Mac › Projects");
    expect(folderLabel("/Users/a/iCloud/meerCAD", "/Users/a/iCloud/meerCAD")).toBe("iCloud Drive › meerCAD");
    expect(folderLabel("/Volumes/NAS/cad")).toBe("/Volumes/NAS/cad");
  });

  it("moves the projects along when asked, and says how many were left in place", async () => {
    renderUi(<div />);
    vi.spyOn(desktop(), "set").mockResolvedValueOnce({ dir: "/new", moved: 2, skipped: 1 });
    let done: Promise<string | null> = Promise.resolve(null);
    await act(async () => void (done = changeProjectsFolder("/new")));
    await answer();
    expect(await done).toBe("/new");
    expect(toasts()).toMatch(/Moved 2 projects to \/new \(1 already existed there and was left in place\)/);
  });

  it("leaves them when told, and goes on without asking where nothing is to move", async () => {
    renderUi(<div />);
    const set = vi.spyOn(desktop(), "set");
    let done: Promise<string | null> = Promise.resolve(null);
    await act(async () => void (done = changeProjectsFolder("/other")));
    await answer(null);
    expect(await done).toBe("/other");
    expect(set).toHaveBeenLastCalledWith({ dir: "/other", move: false });
    expect(toasts()).toMatch(/Projects are now saved in \/other/);
    // The folder in use already: nothing to move, no question.
    expect(await changeProjectsFolder("/test")).toBe("/test");
  });

  it("says when the folder cannot be used, and does nothing when the dialog is closed", async () => {
    vi.spyOn(desktop(), "set").mockRejectedValueOnce(new Error("read-only volume"));
    expect(await changeProjectsFolder("/ro", { askToMove: false })).toBeNull();
    expect(toasts()).toMatch(/Could not use that folder: read-only volume/);
    // The system dialog closed without a folder.
    expect(await changeProjectsFolder()).toBeNull();
  });
});

describe("iCloud on the iPad", () => {
  it("switches after asking, and says so", async () => {
    renderUi(<div />);
    vi.spyOn(native, "switchStorage").mockResolvedValueOnce({ moved: 1, skipped: 0 });
    let done: Promise<boolean> = Promise.resolve(false);
    await act(async () => void (done = switchNativeStorage("icloud")));
    await answer();
    expect(await done).toBe(true);
    expect(toasts()).toMatch(/Moved 1 project to iCloud/);
    vi.spyOn(native, "switchStorage").mockResolvedValueOnce({ moved: 3, skipped: 2 });
    await act(async () => void (done = switchNativeStorage("local")));
    await answer();
    expect(await done).toBe(true);
    expect(toasts()).toMatch(/Moved 3 projects to this device \(2 already existed/);
  });

  it("does nothing when not confirmed, and says why when iCloud is off", async () => {
    renderUi(<div />);
    let done: Promise<boolean> = Promise.resolve(true);
    await act(async () => void (done = switchNativeStorage("icloud")));
    await answer(null);
    expect(await done).toBe(false);
    vi.spyOn(native, "switchStorage").mockRejectedValueOnce(new Error("iCloud Drive is not available"));
    await act(async () => void (done = switchNativeStorage("icloud")));
    await answer();
    expect(await done).toBe(false);
    expect(toasts()).toMatch(/iCloud Drive is not available/);
  });
});
