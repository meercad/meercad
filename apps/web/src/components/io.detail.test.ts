/** Very fine meshes: the app asks before making them lighter, the assistant does not. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const asked: { title: string; message?: string }[] = [];
let answer = true;
vi.mock("./Ask", async (orig) => ({
  ...(await orig<typeof import("./Ask")>()),
  askConfirm: vi.fn(async (o: { title: string; message?: string }) => (asked.push(o), answer)),
}));

const { lighten } = await import("./io");

describe("very fine meshes", () => {
  beforeEach(() => (asked.length = 0));

  it("asks in the app, with the triangles and the time it would take", async () => {
    answer = true;
    expect(await lighten(1_500_000, "ask")).toBe(true);
    expect(asked).toHaveLength(1);
    // 1.5 million × 0.3 ms ≈ 7.5 min.
    expect(asked[0]!.message).toMatch(/1[.,]500[.,]000/);
    expect(asked[0]!.message).toMatch(/8 min/);
    answer = false;
    expect(await lighten(1_500_000, "ask")).toBe(false);
  });

  it("does not ask for the assistant or when every triangle is wanted", async () => {
    expect(await lighten(1_500_000, "light")).toBe(true);
    expect(await lighten(1_500_000, "full")).toBe(false);
    expect(asked).toEqual([]);
  });
});
