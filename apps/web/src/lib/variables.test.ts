/** How variables are grouped. */
import { describe, expect, it } from "vitest";
import { GROUP_LABEL, GROUP_ORDER, variableGroup } from "./variables";

describe("variableGroup", () => {
  const params = { w: 40, h: "w / 2", self: "self + 1", other: "outside * 2", auto1: 3 };

  it("calls formulas of other variables calculated, the rest own or automatic", () => {
    expect(variableGroup("h", params)).toBe("calculated");
    expect(variableGroup("self", params)).toBe("own");
    expect(variableGroup("other", params)).toBe("own");
    expect(variableGroup("auto1", params, ["auto1"])).toBe("auto");
    expect(variableGroup("missing", params)).toBe("own");
  });

  it("labels every group in order", () => {
    expect(GROUP_ORDER.map((group) => typeof GROUP_LABEL[group])).toEqual(["string", "string", "string"]);
  });
});
