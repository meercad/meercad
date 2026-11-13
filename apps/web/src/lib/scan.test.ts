/** Scanning an object or a surface on iPhone and iPad: what comes into the design and what is said. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = { capabilities: vi.fn(), scan: vi.fn(), imported: vi.fn(async () => undefined) };
const readFile = vi.fn();
const toast = vi.fn();
const importFile = vi.fn();
let platform = "ios";
let nativeApp = true;

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => platform },
  registerPlugin: () => plugin,
}));
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: { readFile: (...args: unknown[]) => readFile(...args) },
}));
vi.mock("../store", () => ({ toast: (...args: unknown[]) => toast(...args) }));
vi.mock("../components/io", () => ({ importFile: (...args: unknown[]) => importFile(...args) }));
vi.mock("./native", () => ({
  get nativeApp() {
    return nativeApp;
  },
}));

/** The module asks the device once what it can do, so every test loads it afresh. */
async function load(caps: unknown) {
  vi.resetModules();

  if (caps instanceof Error) plugin.capabilities.mockRejectedValue(caps);
  else plugin.capabilities.mockResolvedValue(caps);

  return import("./scan");
}

const result = (more: object = {}) => ({
  path: "/tmp/scan.stl",
  folder: "/tmp/scan",
  triangles: 12345,
  size: [120.4, 35.26, 8] as [number, number, number],
  photos: 0,
  seconds: 20,
  ...more,
});

beforeEach(() => {
  for (const mock of [plugin.capabilities, plugin.scan, plugin.imported, readFile, toast, importFile]) {
    mock.mockReset();
  }

  plugin.imported.mockResolvedValue(undefined);
  readFile.mockResolvedValue({ data: btoa("stl") });
  importFile.mockResolvedValue(true);
  platform = "ios";
  nativeApp = true;
});

describe("scanning", () => {
  it("is offered in the iPhone and iPad app only", async () => {
    const { canScan } = await load({ scan: true });

    expect(await canScan()).toBe(true);

    platform = "web";
    expect(await canScan()).toBe(false);

    platform = "ios";
    nativeApp = false;
    expect(await canScan()).toBe(false);
  });

  it("says why a device cannot scan", async () => {
    let scan = await load({ scan: false, reason: "No LiDAR here" });

    await scan.scanObject();
    expect(toast).toHaveBeenLastCalledWith("No LiDAR here", "error");

    scan = await load({ scan: false });
    await scan.scanObject("object");
    expect(toast).toHaveBeenLastCalledWith("This device cannot scan objects.", "error");

    scan = await load({ scan: true, surface: false });
    await scan.scanObject("surface");
    expect(toast).toHaveBeenLastCalledWith(
      "Scanning with LiDAR needs an iPhone or iPad with LiDAR.",
      "error",
    );

    scan = await load(new Error("timeout"));
    await scan.scanObject();
    expect(toast).toHaveBeenLastCalledWith("The scanner did not answer: timeout", "error");
    expect(plugin.scan).not.toHaveBeenCalled();
  });

  it("stays quiet when the scan is cancelled and shows any other failure", async () => {
    const { scanObject } = await load({ scan: true, surface: true });

    plugin.scan.mockRejectedValueOnce({ code: "cancelled" });
    await scanObject();
    expect(toast).not.toHaveBeenCalled();

    plugin.scan.mockRejectedValueOnce({ message: "Too dark" });
    await scanObject();
    expect(toast).toHaveBeenLastCalledWith("Too dark", "error");

    plugin.scan.mockRejectedValueOnce({});
    await scanObject("lidar");
    expect(toast).toHaveBeenLastCalledWith("Scanning failed", "error");
    expect(importFile).not.toHaveBeenCalled();
  });

  it("imports a plain scan see-through, tells its size and marks it as imported", async () => {
    const { scanObject } = await load({ scan: true, surface: true });

    plugin.scan.mockResolvedValue(result({ photos: 24 }));
    await scanObject("lidar");

    const [file, options] = importFile.mock.calls[0] as [File, unknown];

    expect(file.name).toMatch(/^LiDAR scan .*\.stl$/);
    expect(options).toEqual({ seeThrough: true });
    expect(plugin.imported).toHaveBeenCalledWith({ folder: "/tmp/scan" });
    expect(toast.mock.lastCall![0]).toMatch(/^Scan: 120 × 35\.3 × 8\.0 mm · 12.345 triangles · 24 photos$/);
  });

  it("imports an object scan with its colours, solid", async () => {
    const { scanObject } = await load({ scan: true });

    plugin.scan.mockResolvedValue(result({ uvs: "/tmp/uvs.bin", texture: "/tmp/tex.jpg" }));
    readFile.mockImplementation(async ({ path }: { path: string }) => ({
      data: path.endsWith("uvs.bin") ? "UVS" : path.endsWith("tex.jpg") ? "JPEG" : btoa("stl"),
    }));
    await scanObject("object");

    expect(importFile.mock.calls[0]![1]).toEqual({
      texture: { image: "JPEG", mime: "image/jpeg", uvs: "UVS" },
    });
  });

  it("imports a scan without colours when its picture cannot be read", async () => {
    const { scanObject } = await load({ scan: true });

    plugin.scan.mockResolvedValue(result({ uvs: "/tmp/uvs.bin", texture: "/tmp/tex.jpg" }));
    readFile.mockImplementation(async ({ path }: { path: string }) => {
      if (path.endsWith("tex.jpg")) throw new Error("gone");

      return { data: btoa("stl") };
    });
    await scanObject("object");

    expect(importFile.mock.calls[0]![1]).toEqual({ seeThrough: true });
  });

  it("numbers the pieces of a scan, and keeps the scan for later when one does not come in", async () => {
    const { scanObject } = await load({ scan: true, surface: true });

    plugin.scan.mockResolvedValue(result({ paths: ["/tmp/a.stl", "/tmp/b.stl"] }));
    await scanObject("surface");

    expect(importFile.mock.calls.map(([file]) => (file as File).name)).toEqual([
      expect.stringMatching(/^Surface scan .* \(1\)\.stl$/),
      expect.stringMatching(/^Surface scan .* \(2\)\.stl$/),
    ]);
    expect(plugin.imported).toHaveBeenCalledTimes(1);

    plugin.imported.mockClear();
    toast.mockClear();
    importFile.mockResolvedValue(false);
    await scanObject("surface");

    expect(plugin.imported).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });
});
