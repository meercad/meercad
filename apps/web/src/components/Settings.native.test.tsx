/**
 * The settings on the iPhone and iPad (Settings.tsx with `nativeApp`): where projects are saved, on
 * this device or in iCloud, and switching between them; without iCloud it says how to turn it on.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ kind: "local" as "local" | "icloud", cloud: "/icloud" as string | null }));
vi.mock("../lib/native", async (orig) => ({
  ...(await orig<typeof import("../lib/native")>()),
  nativeApp: true,
  storageKind: async () => native.kind,
  iCloudFolder: async () => native.cloud,
}));
vi.mock("../lib/persistence", async (orig) => ({ ...(await orig<typeof import("../lib/persistence")>()), desktop: undefined }));

import * as storage from "../lib/storage";
import { renderUi } from "../../test/ui";
import { Settings } from "./Settings";

const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const open = async () => {
  renderUi(<Settings onShortcuts={() => undefined} />);
  await act(async () => void window.dispatchEvent(new Event("meercad:settings")));
  await settle();
};
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("where projects are saved on the iPad", () => {
  it("switches from this device to iCloud and back", async () => {
    native.kind = "local";
    native.cloud = "/icloud";
    const sw = vi.spyOn(storage, "switchNativeStorage").mockResolvedValue(true);
    await open();
    expect(screen.getByText(/On this device \(Files/)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByText("Switch to iCloud")));
    await settle();
    expect(sw).toHaveBeenLastCalledWith("icloud");
    expect(screen.getByText(/In iCloud Drive › meerCAD/)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByText("Keep on this device only…")));
    await settle();
    expect(sw).toHaveBeenLastCalledWith("local");
    expect(screen.getByText(/On this device \(Files/)).toBeTruthy();
  });

  it("stays put when the switch was not made, and says how to turn on iCloud", async () => {
    native.kind = "icloud";
    vi.spyOn(storage, "switchNativeStorage").mockResolvedValue(false);
    await open();
    await act(async () => void fireEvent.click(screen.getByText("Keep on this device only…")));
    await settle();
    expect(screen.getByText(/In iCloud Drive › meerCAD/)).toBeTruthy();
    cleanup();
    native.kind = "local";
    native.cloud = null;
    await open();
    expect(screen.getByText(/sign in to iCloud and turn on iCloud Drive/)).toBeTruthy();
    // A press inside stays open; a press beside it closes.
    await act(async () => void fireEvent.pointerDown(screen.getByRole("dialog")));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await act(async () => void fireEvent.pointerDown(document.querySelector(".modal-backdrop")!));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
