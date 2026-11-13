/**
 * Big exports for an assistant (mcpBridge.ts): above the size one message holds, the files wait in
 * the app and are fetched piece by piece (staged_files), then let go; a token that is gone, a file
 * name that is not there, and an export too big for an old server are refused. The size limits are
 * made small here so a little STL is "big".
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";

vi.mock("@meercad/mcp", async (orig) => {
  const real = await orig<typeof import("@meercad/mcp")>();
  // Over 100 bytes: staged when the server can fetch pieces, else too big.
  return { ...real, exportTransport: (total: number, stages: boolean) => (total <= 100 ? "inline" : stages ? "stage" : "too_big") };
});

import { testCall } from "./mcpBridge";

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => testCall(method, params) as Promise<T>;
const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 20, y: 0 },
  { id: "p3", type: "point", x: 20, y: 20 },
  { id: "p4", type: "point", x: 0, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

beforeAll(async () => {
  await call("new_project", { name: "Staged" });
  await call("apply_ops", { ops: [{ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
  ] as Feature[] }] });
});

describe("big exports", () => {
  it("waits in the app and is fetched piece by piece, then let go", async () => {
    const r = await call<{ files: Record<string, string>; staged: { token: string; sizes: Record<string, number> } }>("export", { format: "stl", name: "block", stage: true });
    expect(r.files).toEqual({});
    const [name, size] = Object.entries(r.staged.sizes)[0]!;
    // A binary STL of a box: 84 bytes of header and count, 50 per triangle, 12 triangles.
    expect(size).toBe(84 + 50 * 12);
    const half = Math.floor(size / 2);
    const got = await call<{ data: string[] }>("staged_files", { token: r.staged.token, pieces: [{ name, offset: 0, length: half }, { name, offset: half, length: size - half }] });
    const bytes = new Uint8Array([...fromB64(got.data[0]!), ...fromB64(got.data[1]!)]);
    expect(bytes.length).toBe(size);
    expect(new DataView(bytes.buffer).getUint32(80, true)).toBe(12);
    await expect(call("staged_files", { token: r.staged.token, pieces: [{ name: "other.stl", offset: 0, length: 1 }] })).rejects.toThrow(/no exported file "other.stl"/);
    expect(await call("staged_files", { token: r.staged.token, done: true })).toEqual({ ok: true });
    await expect(call("staged_files", { token: r.staged.token, pieces: [] })).rejects.toThrow(/no longer here/);
  });

  it("refuses an export too big for a server that cannot fetch pieces", async () => {
    await expect(call("export", { format: "stl", name: "big" })).rejects.toThrow(/too big for the meerCAD MCP server/);
  });
});
