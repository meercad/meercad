/** Part names in a tool call: ids, folders and the hint for an unknown name. */
import { describe, expect, it } from "vitest";
import { partsNamed } from "./partNames";

const ids = ["kopf_schale", "kopf_deckel", "rumpf", "arm"];
const groups = [
  { name: "Kopf", parts: ["kopf_schale", "kopf_deckel", "gone"] },
  { name: "Kopfteile", parts: ["arm"] },
];

describe("partsNamed", () => {
  it("takes ids and folders (any case), each part once", () => {
    expect(partsNamed(["rumpf", "kopf", "kopf_schale"], ids, groups)).toEqual([
      "rumpf",
      "kopf_schale",
      "kopf_deckel",
    ]);
    expect(partsNamed([], ids)).toEqual([]);
  });

  it("names what comes close to an unknown name", () => {
    expect(() => partsNamed(["kop"], ids, groups)).toThrow(
      'no part "kop"; close: folder "Kopf", folder "Kopfteile", kopf_schale, kopf_deckel',
    );
    expect(() => partsNamed(["bein"], ids)).toThrow(/^no part "bein"$/);
  });

  it("shortens a long list of close parts", () => {
    const many = Array.from({ length: 14 }, (_, i) => `teil${i}`);

    expect(() => partsNamed(["teil"], many)).toThrow(/teil11, … \(14 parts\)$/);
  });
});
