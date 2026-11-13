/** Scanning a room or an area on iPhone and iPad: what opens, and what is said when it cannot. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = { capabilities: vi.fn(), scanRoom: vi.fn(), scanArea: vi.fn() };
const readFile = vi.fn();
const toast = vi.fn();
const newProject = vi.fn(async (_doc: unknown, _name: string) => undefined);
const addTerrain = vi.fn();
const names: string[] = [];

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "ios" },
  registerPlugin: () => plugin,
}));
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { readFile: (...args: unknown[]) => readFile(...args) },
}));
vi.mock("../store", () => ({
  newProject: (doc: unknown, name: string) => newProject(doc, name),
  toast: (...args: unknown[]) => toast(...args),
}));
vi.mock("./native", () => ({ nativeApp: true }));
vi.mock("./terrain", () => ({ addTerrain: (...args: unknown[]) => addTerrain(...args) }));
// The room's parts are built elsewhere (roomDoc.test.ts); here only the names it is given matter.
vi.mock("./roomDoc", () => ({
  roomDocument: (
    _scan: unknown,
    label: {
      wall: (n: number) => string;
      floor: string;
      furniture: string;
      object: (category: string) => string;
      door: string;
      window: string;
      opening: string;
    },
  ) => {
    names.push(label.wall(2), label.object("sofa"), label.object("spaceship"), label.floor, label.door);

    return { features: [] };
  },
}));

/** The module asks the device once what it can do, so every test loads it afresh. */
async function load(caps: unknown) {
  vi.resetModules();

  if (caps instanceof Error) plugin.capabilities.mockRejectedValue(caps);
  else plugin.capabilities.mockResolvedValue(caps);

  return import("./roomScan");
}

const room = (walls: number) => ({
  walls: Array.from({ length: walls }, () => ({})),
  doors: [{}],
  windows: [{}, {}],
  openings: [],
  objects: [{}, {}, {}],
});

beforeEach(() => {
  for (const mock of [plugin.capabilities, plugin.scanRoom, plugin.scanArea, readFile, toast, newProject]) {
    mock.mockReset();
  }

  addTerrain.mockReset();
  names.length = 0;
});

describe("scanning a room", () => {
  it("is offered in the iPhone and iPad app", async () => {
    expect((await load({ room: true, area: true })).canScanSpaces).toBe(true);
  });

  it("needs a device that can, also when the scanner does not answer", async () => {
    const needs = "Scanning rooms needs an iPhone or iPad with LiDAR and iOS 17 or later.";

    await (await load({ room: false, area: true })).scanRoom();
    expect(toast).toHaveBeenLastCalledWith(needs, "error");

    await (await load(new Error("no answer"))).scanRoom();
    expect(toast).toHaveBeenLastCalledWith(needs, "error");
    expect(plugin.scanRoom).not.toHaveBeenCalled();
  });

  it("stays quiet when cancelled, shows other failures, and asks for another scan without walls", async () => {
    const { scanRoom } = await load({ room: true, area: true });

    plugin.scanRoom.mockRejectedValueOnce({ code: "cancelled" });
    await scanRoom();
    expect(toast).not.toHaveBeenCalled();

    plugin.scanRoom.mockRejectedValueOnce({});
    await scanRoom();
    expect(toast).toHaveBeenLastCalledWith("Scanning failed", "error");

    plugin.scanRoom.mockResolvedValueOnce(room(0));
    await scanRoom();
    expect(toast).toHaveBeenLastCalledWith(
      "No walls were found. Scan again and show every wall for a moment.",
      "error",
    );
    expect(newProject).not.toHaveBeenCalled();
  });

  it("opens the room as a new project with named parts and sums up what it found", async () => {
    const { scanRoom } = await load({ room: true, area: true });

    plugin.scanRoom.mockResolvedValue(room(4));
    await scanRoom();

    expect(names).toEqual(["Wall 2", "Sofa", "Object", "Floor", "Door"]);
    expect(newProject.mock.calls[0]![0]).toEqual({ features: [] });
    expect(newProject.mock.calls[0]![1]).toMatch(/^Room /);
    expect(toast).toHaveBeenLastCalledWith(
      "4 walls, 3 doors and windows, 3 pieces of furniture. Every wall is a part you can push, move or cut.",
    );
  });
});

describe("scanning an area", () => {
  it("needs LiDAR", async () => {
    await (await load({ room: true, area: false })).scanArea();

    expect(toast).toHaveBeenLastCalledWith("Scanning areas needs an iPhone or iPad with LiDAR.", "error");
    expect(plugin.scanArea).not.toHaveBeenCalled();
  });

  it("adds the scanned area round the design", async () => {
    const { scanArea } = await load({ room: true, area: true });

    plugin.scanArea.mockResolvedValue({ path: "/tmp/area.glb", folder: "/tmp/area", size: [2, 3] });
    readFile.mockResolvedValue({ data: btoa("glb") });
    await scanArea();

    expect(readFile).toHaveBeenCalledWith({ path: "file:///tmp/area.glb" });

    const [terrain, bytes] = addTerrain.mock.calls[0] as [{ folder: string; size: number[] }, Uint8Array];

    expect(terrain).toMatchObject({ folder: "", size: [2, 3] });
    expect(new TextDecoder().decode(bytes)).toBe("glb");
  });

  it("stays quiet when cancelled and shows other failures", async () => {
    const { scanArea } = await load({ room: true, area: true });

    plugin.scanArea.mockRejectedValueOnce({ code: "cancelled" });
    await scanArea();
    expect(toast).not.toHaveBeenCalled();

    plugin.scanArea.mockRejectedValueOnce({ message: "Moved too fast" });
    await scanArea();
    expect(toast).toHaveBeenLastCalledWith("Moved too fast", "error");
  });
});
