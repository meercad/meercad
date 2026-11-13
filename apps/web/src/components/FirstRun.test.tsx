/**
 * The Mac app's first start (FirstRun.tsx): it asks where projects live; iCloud Drive, another folder
 * or the folder offered each close it once chosen; a folder not chosen keeps it open; without iCloud
 * there is no iCloud button; once chosen it never shows.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as storage from "../lib/storage";
import { FirstRun } from "./FirstRun";

const desktop = () => (window as unknown as { meercadDesktop: { storage: { status: () => Promise<unknown> } } }).meercadDesktop;
const status = (o: object = {}) => ({ dir: "/d", defaultDir: "/Users/x/meerCAD", chosen: false, iCloudDir: "/icloud/meerCAD", iCloudAvailable: true, ...o });
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the first start", () => {
  it("takes iCloud Drive, another folder or the folder offered", async () => {
    const change = vi.spyOn(storage, "changeProjectsFolder");
    for (const [button, answer, args] of [
      ["Use iCloud Drive (same projects on iPhone and iPad)", "/icloud/meerCAD", ["/icloud/meerCAD", { askToMove: false }]],
      ["Choose another folder…", null, []],
      ["Choose another folder…", "/elsewhere", []],
      ["Use this folder", "/Users/x/meerCAD", ["/Users/x/meerCAD", { askToMove: false }]],
    ] as const) {
      cleanup();
      vi.spyOn(desktop().storage, "status").mockResolvedValue(status());
      change.mockResolvedValueOnce(answer);
      render(<FirstRun />);
      await settle();
      await act(async () => void fireEvent.click(screen.getByText(button)));
      await settle();
      expect(change).toHaveBeenLastCalledWith(...args);
      expect(!!screen.queryByRole("dialog"), button).toBe(answer === null);
    }
  });

  it("has no iCloud button without iCloud, and does not show once chosen", async () => {
    vi.spyOn(desktop().storage, "status").mockResolvedValue(status({ iCloudAvailable: false }));
    render(<FirstRun />);
    await settle();
    expect(screen.queryByText(/Use iCloud Drive/)).toBeNull();
    cleanup();
    vi.spyOn(desktop().storage, "status").mockResolvedValue(status({ chosen: true }));
    render(<FirstRun />);
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
