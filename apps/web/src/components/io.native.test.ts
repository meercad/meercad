/**
 * Saving a file on the iPhone and iPad (io.ts): it goes to the share sheet, text as it is and bytes as
 * bytes; a share sheet that fails says why.
 */
import { describe, expect, it, vi } from "vitest";

const shared = vi.hoisted(() => ({ calls: [] as [string, unknown][], fail: false }));
vi.mock("../lib/native", async (orig) => ({
  ...(await orig<typeof import("../lib/native")>()),
  nativeApp: true,
  shareFile: async (name: string, data: unknown) => {
    if (shared.fail) throw new Error("sheet closed");
    shared.calls.push([name, data]);
  },
}));

import { useApp } from "../store";
import { download } from "./io";

describe("saving on the iPad", () => {
  it("shares text, bytes and buffers, and says when sharing failed", async () => {
    download("a.svg", "<svg/>");
    download("b.stl", new Uint8Array([1, 2]));
    download("c.bin", new Uint8Array([3]).buffer);
    await new Promise((r) => setTimeout(r, 10));
    expect(shared.calls.map(([n, d]) => [n, typeof d === "string" ? d : Array.from(d as Uint8Array)])).toEqual([["a.svg", "<svg/>"], ["b.stl", [1, 2]], ["c.bin", [3]]]);
    shared.fail = true;
    download("d.svg", "<svg/>");
    await new Promise((r) => setTimeout(r, 10));
    expect(useApp.getState().toasts.map((t) => t.text).join(" | ")).toMatch(/Could not share d\.svg: sheet closed/);
  });
});
