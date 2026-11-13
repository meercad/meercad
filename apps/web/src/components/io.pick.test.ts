/**
 * Picking files (io.ts): a file chooser closed without a file imports nothing and brings in no
 * version; a version file that cannot be read says why.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyDocument } from "@meercad/schema";
import * as model from "@meercad/model";
import { newProject, useApp } from "../store";
import { importFile, importVersionFile } from "./io";

const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
beforeAll(async () => {
  await newProject(undefined, "Picking");
});
afterEach(() => vi.restoreAllMocks());

describe("picking files", () => {
  it("does nothing when the chooser closes without a file", async () => {
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      this.onchange?.(new Event("change"));
    });
    expect(await importFile()).toBe(false);
    expect(await importVersionFile()).toEqual([]);
  });

  it("says why a version file cannot be read", async () => {
    expect(await importVersionFile(new File(["{ not json"], "Old.meercad"))).toEqual([]);
    expect(toasts()).toMatch(/Not a valid meerCAD file/);
    vi.spyOn(model, "applyOp").mockImplementationOnce(() => {
      throw new Error("cannot keep it");
    });
    expect(await importVersionFile(new File([JSON.stringify(emptyDocument())], "Odd.meercad"))).toEqual([]);
    expect(toasts()).toMatch(/Could not bring in Odd\.meercad: cannot keep it/);
  });
});
