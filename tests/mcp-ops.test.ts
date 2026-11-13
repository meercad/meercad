import { describe, expect, it } from "vitest";
import { applyOp } from "../packages/model/src/store.js";
import { snapshot } from "../packages/model/src/versions.js";
import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import { lightDocument, restoreElided } from "../apps/web/src/lib/elide";

const doc = (): MeercadDocument => ({
  ...emptyDocument(),
  features: [
    {
      id: "im1",
      op: "import",
      format: "stl",
      fileName: "scan.stl",
      data: "D".repeat(5000),
      texture: { image: "J".repeat(4000), mime: "image/jpeg", uvs: "U".repeat(3000) },
    },
  ],
});

describe("ops for what the parts list shows", () => {
  it("sets and clears a part's colour", () => {
    const d = applyOp(doc(), { type: "set_part_color", part: "im1", color: "#AABBCC" });
    expect(d.partColors).toEqual({ im1: "#aabbcc" });
    expect(applyOp(d, { type: "set_part_color", part: "im1", color: null }).partColors).toBeUndefined();
    expect(() => applyOp(doc(), { type: "set_part_color", part: "im1", color: "red" })).toThrow();
  });

  it("draws parts see-through and solid again", () => {
    const d = applyOp(doc(), { type: "set_see_through", parts: ["im1", "ex1"], on: true });
    expect(d.seeThrough?.sort()).toEqual(["ex1", "im1"]);
    expect(
      applyOp(applyOp(d, { type: "set_see_through", parts: ["im1"], on: false }), {
        type: "set_see_through",
        parts: ["ex1"],
        on: false,
      }).seeThrough,
    ).toBeUndefined();
  });

  it("sets folders and order, and clears them", () => {
    const d = applyOp(doc(), {
      type: "set_part_list",
      groups: [{ name: "Lid", parts: ["im1"] }],
      order: ["im1"],
    });
    expect(d.partGroups).toEqual([{ name: "Lid", parts: ["im1"] }]);
    expect(d.partOrder).toEqual(["im1"]);

    const cleared = applyOp(d, { type: "set_part_list", groups: null });
    expect(cleared.partGroups).toBeUndefined();
    expect(cleared.partOrder).toEqual(["im1"]);
  });

  it("switches units", () => {
    const d = applyOp(doc(), { type: "set_units", units: "in" });
    expect(d.units).toBe("in");
    expect(applyOp(d, { type: "set_units", units: "mm" }).units).toBeUndefined();
  });

  it("replace keeps saved versions when the document sent has none", () => {
    const base = doc();
    const blobs: Record<string, string> = {};
    const withVersion = { ...base, versions: [snapshot(base, "v1", 0, blobs)], blobs };
    const { versions: _v, blobs: _b, ...sent } = withVersion;
    const after = applyOp(withVersion, { type: "replace", doc: { ...sent, params: { w: "5" } } });
    expect(after.versions?.map((v) => v.name)).toEqual(["v1"]);
    expect(after.blobs).toEqual(blobs);
    expect(after.params).toEqual({ w: "5" });
  });
});

describe("embedded files left out for assistants", () => {
  it("are elided in what get_model returns", () => {
    const light = lightDocument(doc());
    const f = light.features[0]!;
    expect(f.op === "import" && f.data.startsWith("…elided:5000")).toBe(true);
    expect(JSON.stringify(light).length).toBeLessThan(1000);
  });

  it("come back unchanged when an op sends the placeholder", () => {
    const d = doc();
    const f = lightDocument(d).features[0]!;
    if (f.op !== "import" || !f.texture) throw new Error("no texture");

    const [op] = restoreElided(
      [{ type: "edit_feature", id: "im1", patch: { texture: { ...f.texture, hidden: true } } }],
      d,
    );
    const next = applyOp(d, op!);
    const g = next.features[0]!;
    expect(g.op === "import" && g.texture).toEqual({
      image: "J".repeat(4000),
      mime: "image/jpeg",
      uvs: "U".repeat(3000),
      hidden: true,
    });
    expect(g.op === "import" && g.data).toBe("D".repeat(5000));
  });

  it("refuse a placeholder where the model has nothing", () => {
    expect(() =>
      restoreElided([{ type: "edit_feature", id: "nope", patch: { data: "…elided:5000 chars…" } }], doc()),
    ).toThrow(/elided/);
  });

  it("a whole document sent back with replace keeps its files", () => {
    const d = doc();
    const [op] = restoreElided([{ type: "replace", doc: { ...lightDocument(d), params: { a: "1" } } }], d);
    const next = applyOp(d, op!);
    expect(next.features[0]).toEqual(d.features[0]);
  });
});

describe("assistant names", () => {
  it("shows the connected program by the name people know", async () => {
    const { clientLabel } = await import("../apps/web/src/lib/mcpClient");
    expect(clientLabel("claude-code")).toBe("Claude Code");
    expect(clientLabel("claude-ai")).toBe("Claude");
    expect(clientLabel("my-agent")).toBe("My Agent");
    expect(clientLabel("Zed Editor")).toBe("Zed Editor");
    expect(clientLabel(undefined)).toBe("Assistant");
  });
});
