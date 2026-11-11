import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { isFastener } from "../apps/web/src/lib/features";

describe("fasteners", () => {
  const features = [
    { id: "np1", op: "standard_part", kind: "socket_screw" },
    { id: "np2", op: "standard_part", kind: "bearing" },
    { id: "h1", op: "hole", kind: "insert" },
    { id: "ex2", op: "extrude" },
    { id: "lp1", op: "linear_pattern" },
    { id: "sc1", op: "screw" },
  ] as unknown as Feature[];
  it("screws, nuts, inserts and their copies; not bearings or printed parts", () => {
    expect(isFastener("np1", features)).toBe(true);
    expect(isFastener("np1_3", features)).toBe(true);
    expect(isFastener("np2", features)).toBe(false);
    expect(isFastener("h1_insert_2", features)).toBe(true);
    expect(isFastener("sc1", features)).toBe(true);
    expect(isFastener("ex2", features)).toBe(false);
    expect(isFastener("lp1_np1_3", features)).toBe(true);
    expect(isFastener("lp1_ex2_3", features)).toBe(false);
  });
});
