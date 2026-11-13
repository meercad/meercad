/** The overlap check of the whole model: what it reports for one part, touching parts and overlaps. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const clearances = vi.fn();
const toast = vi.fn();
let bodies: string[] = [];

vi.mock("../store", () => ({
  kernel: { clearances: (...args: unknown[]) => clearances(...args) },
  toast: (...args: unknown[]) => toast(...args),
  useApp: {
    getState: () => ({
      output: { report: { bodies: bodies.map((id) => ({ id })) } },
      doc: { features: bodies.map((id) => ({ id, op: "extrude", name: `Part ${id}` })) },
    }),
  },
}));

const { checkInterference } = await import("./interference");
const pair = (a: string, b: string, overlap: number, distance: number) => ({ a, b, overlap, distance });

describe("interference check", () => {
  beforeEach(() => {
    clearances.mockReset();
    toast.mockReset();
  });

  it("says that one part cannot overlap anything, without asking the kernel", async () => {
    bodies = ["a"];
    await checkInterference();

    expect(clearances).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("There is only one part: nothing can overlap", "info");
  });

  it("reports no overlap, and counts parts that only touch", async () => {
    bodies = ["a", "b", "c"];
    clearances.mockResolvedValueOnce([pair("a", "b", 0, 5), pair("a", "c", 0, 3)]);
    await checkInterference();
    expect(toast).toHaveBeenLastCalledWith("No parts overlap");

    clearances.mockResolvedValueOnce([pair("a", "b", 0, 0), pair("a", "c", 0.0005, 0), pair("b", "c", 0, 3)]);
    await checkInterference();
    expect(toast).toHaveBeenLastCalledWith("No parts overlap (2 pairs touch)");
    expect(clearances).toHaveBeenLastCalledWith(["a", "b", "c"], {}, 0);
  });

  it("lists overlaps largest first with their shared volume, four at most", async () => {
    bodies = ["a", "b", "c", "d"];
    clearances.mockResolvedValueOnce([pair("a", "b", 2.5, 0), pair("c", "d", 120.4, 0)]);
    await checkInterference();

    const [message, kind] = toast.mock.lastCall as [string, string];

    expect(kind).toBe("error");
    expect(message).toMatch(/^2 overlaps: Part c · Part d: 120 mm³; Part a · Part b: 2\.50 mm³$/);

    clearances.mockResolvedValueOnce([1, 2, 3, 4, 5].map((volume) => pair("a", "b", volume, 0)));
    await checkInterference();
    expect((toast.mock.lastCall as [string])[0]).toMatch(/^5 overlaps: .* …$/);
  });
});
