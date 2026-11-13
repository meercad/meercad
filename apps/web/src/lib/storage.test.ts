/** Choosing where projects are stored: what is asked, what is moved and what the user is told. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const askConfirm = vi.fn();
const toast = vi.fn();
const refreshProjects = vi.fn(async () => undefined);
const switchStorage = vi.fn();
const storage = { choose: vi.fn(), status: vi.fn(), count: vi.fn(), set: vi.fn() };
let projects: unknown[] = [];

vi.mock("../components/Ask", () => ({ askConfirm: (...args: unknown[]) => askConfirm(...args) }));
vi.mock("../store", () => ({
  refreshProjects: () => refreshProjects(),
  toast: (...args: unknown[]) => toast(...args),
  useApp: { getState: () => ({ projects }) },
}));
vi.mock("./native", () => ({ switchStorage: (...args: unknown[]) => switchStorage(...args) }));
vi.mock("./persistence", () => ({ desktop: { storage } }));

const { changeProjectsFolder, folderLabel, switchNativeStorage } = await import("./storage");

beforeEach(() => {
  for (const mock of [askConfirm, toast, refreshProjects, switchStorage, ...Object.values(storage)]) {
    mock.mockReset();
  }
});

describe("how a projects folder is named", () => {
  it("calls the iCloud folder iCloud Drive and the app's own folder On this Mac", () => {
    const own = "/Users/me/Library/Containers/app.meercad/Data/Documents";

    expect(folderLabel("/cloud/meerCAD", "/cloud/meerCAD")).toBe("iCloud Drive › meerCAD");
    expect(folderLabel(own)).toBe("On this Mac");
    expect(folderLabel(`${own}/Work/Parts`)).toBe("On this Mac › Work › Parts");
    expect(folderLabel("/Users/me/CAD")).toBe("/Users/me/CAD");
  });
});

describe("changing the projects folder on the Mac", () => {
  it("does nothing when the folder dialog is cancelled", async () => {
    storage.choose.mockResolvedValue(null);

    expect(await changeProjectsFolder()).toBeNull();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("asks whether the projects should move along, and moves them on a yes", async () => {
    storage.status.mockResolvedValue({ dir: "/old" });
    storage.count.mockResolvedValue(3);
    storage.set.mockResolvedValue({ dir: "/new", moved: 3, skipped: 1 });
    askConfirm.mockResolvedValue(true);

    expect(await changeProjectsFolder("/new")).toBe("/new");
    expect(askConfirm.mock.calls[0]![0].title).toBe("Move your 3 projects?");
    expect(askConfirm.mock.calls[0]![0].message).toContain("They are currently in /old.");
    expect(storage.set).toHaveBeenCalledWith({ dir: "/new", move: true });
    expect(refreshProjects).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "Moved 3 projects to /new (1 already existed there and was left in place)",
    );
  });

  it("switches without asking when there is nothing to move or asking is off", async () => {
    storage.status.mockResolvedValue({ dir: "/old" });
    storage.count.mockResolvedValue(0);
    storage.set.mockResolvedValue({ dir: "/new", moved: 0, skipped: 0 });

    expect(await changeProjectsFolder("/new")).toBe("/new");
    expect(askConfirm).not.toHaveBeenCalled();
    expect(toast).toHaveBeenLastCalledWith("Projects are now saved in /new");

    storage.count.mockResolvedValue(2);
    await changeProjectsFolder("/new", { askToMove: false });
    expect(askConfirm).not.toHaveBeenCalled();
    expect(storage.set).toHaveBeenLastCalledWith({ dir: "/new", move: false });

    // The folder already in use holds the projects: none to move.
    storage.count.mockClear();
    await changeProjectsFolder("/old");
    expect(storage.count).not.toHaveBeenCalled();
  });

  it("says why a folder cannot be used", async () => {
    storage.status.mockResolvedValue({ dir: "/old" });
    storage.count.mockResolvedValue(0);
    storage.set.mockRejectedValue(new Error("read-only"));

    expect(await changeProjectsFolder("/new")).toBeNull();
    expect(toast).toHaveBeenCalledWith("Could not use that folder: read-only", "error");
  });
});

describe("switching between iCloud and the device on iPhone and iPad", () => {
  it("leaves everything as it is when the question is declined", async () => {
    askConfirm.mockResolvedValue(false);

    expect(await switchNativeStorage("icloud")).toBe(false);
    expect(switchStorage).not.toHaveBeenCalled();
  });

  it("moves to iCloud and back, and says how many projects moved", async () => {
    projects = [{}, {}];
    askConfirm.mockResolvedValue(true);
    switchStorage.mockResolvedValue({ moved: 2, skipped: 0 });

    expect(await switchNativeStorage("icloud")).toBe(true);
    expect(askConfirm.mock.calls[0]![0].title).toBe("Switch to iCloud?");
    expect(askConfirm.mock.calls[0]![0].message).toContain("Your 2 projects move to iCloud Drive › meerCAD");
    expect(switchStorage).toHaveBeenCalledWith("icloud");
    expect(toast).toHaveBeenLastCalledWith("Moved 2 projects to iCloud");

    switchStorage.mockResolvedValue({ moved: 1, skipped: 2 });
    expect(await switchNativeStorage("local")).toBe(true);
    expect(askConfirm.mock.lastCall![0].title).toBe("Keep projects on this device only?");
    expect(toast).toHaveBeenLastCalledWith(
      "Moved 1 project to this device (2 already existed there and were left in place)",
    );
  });

  it("shows the reason when the move fails", async () => {
    askConfirm.mockResolvedValue(true);
    switchStorage.mockRejectedValue(new Error("iCloud is off"));

    expect(await switchNativeStorage("icloud")).toBe(false);
    expect(toast).toHaveBeenCalledWith("iCloud is off", "error");
  });
});
