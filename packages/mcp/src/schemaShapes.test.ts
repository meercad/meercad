import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("tool schemas", () => {
  it("use no tuples: their list-form `items` makes MCP clients refuse the tool", () => {
    // What the MCP SDK sends (draft 7): a tuple's `items` is an array, a fixed-length array's an object.
    expect(Array.isArray(z.toJSONSchema(z.tuple([z.number(), z.number()]), { target: "draft-7" }).items)).toBe(true);
    expect(z.toJSONSchema(z.array(z.number()).length(2), { target: "draft-7" }).items).toEqual({ type: "number" });
    const code = readFileSync(new URL("./server.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/z\.tuple\(/);
  });
});
