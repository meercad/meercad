/** The overlap check of the whole model: what it reports for one part, touching parts and overlaps. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const overlaps = vi.fn();
const toast = vi.fn();
let bodies: string[] = [];

vi.mock("../store", () => ({
  kernel: { overlaps: (...args: unknown[]) => overlaps(...args) },
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
/** What the kernel answers: the pairs it checked, and the imported meshes too fine to check. */
const checked = (pairs: unknown[], fine: string[] = []) => ({ pairs, left: 0, fine });

describe("interference check", () => {
  beforeEach(() => {
    overlaps.mockReset();
    toast.mockReset();
  });

  it("says that one part cannot overlap anything, without asking the kernel", async () => {
    bodies = ["a"];
    await checkInterference();

    expect(overlaps).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("There is only one part: nothing can overlap", "info");
  });

  it("reports no overlap, and counts parts that only touch", async () => {
    bodies = ["a", "b", "c"];
    overlaps.mockResolvedValueOnce(checked([pair("a", "b", 0, 5), pair("a", "c", 0, 3)]));
    await checkInterference();
    expect(toast).toHaveBeenLastCalledWith("No parts overlap");

    overlaps.mockResolvedValueOnce(
      checked([pair("a", "b", 0, 0), pair("a", "c", 0.0005, 0), pair("b", "c", 0, 3)]),
    );
    await checkInterference();
    expect(toast).toHaveBeenLastCalledWith("No parts overlap (2 pairs touch)");
    expect(overlaps).toHaveBeenLastCalledWith(["a", "b", "c"]);
  });

  it("lists overlaps largest first with their shared volume, four at most", async () => {
    bodies = ["a", "b", "c", "d"];
    overlaps.mockResolvedValueOnce(checked([pair("a", "b", 2.5, 0), pair("c", "d", 120.4, 0)]));
    await checkInterference();

    const [message, kind] = toast.mock.lastCall as [string, string];

    expect(kind).toBe("error");
    expect(message).toMatch(/^2 overlaps: Part c · Part d: 120 mm³; Part a · Part b: 2\.50 mm³$/);

    overlaps.mockResolvedValueOnce(checked([1, 2, 3, 4, 5].map((volume) => pair("a", "b", volume, 0))));
    await checkInterference();
    expect((toast.mock.lastCall as [string])[0]).toMatch(/^5 overlaps: .* …$/);
  });

  it("names imported meshes that are too fine to check, before the result", async () => {
    bodies = ["a", "b", "c"];
    overlaps.mockResolvedValueOnce(checked([pair("a", "b", 0, 5)], ["c"]));
    await checkInterference();

    expect(toast.mock.calls).toEqual([
      ["Not checked: the imported mesh Part c has too many triangles", "info"],
      ["No parts overlap"],
    ]);
  });
});
