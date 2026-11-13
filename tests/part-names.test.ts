import { describe, expect, it } from "vitest";
import { partsNamed } from "../apps/web/src/lib/partNames";

describe("parts named in a call", () => {
  const ids = ["kopf_schale", "kopf_deckel", "hals", "arm_l"];
  const groups = [{ name: "Kopf", parts: ["kopf_schale", "kopf_deckel", "gone"] }];
  it("takes part ids and folders of the parts list", () => {
    expect(partsNamed(["hals"], ids, groups)).toEqual(["hals"]);
    expect(partsNamed(["kopf", "kopf_schale"], ids, groups)).toEqual(["kopf_schale", "kopf_deckel"]);
  });
  it("an unknown name fails at once and names what comes close", () => {
    expect(() => partsNamed(["kop"], ids, groups)).toThrow(
      'no part "kop"; close: folder "Kopf", kopf_schale, kopf_deckel',
    );
    expect(() => partsNamed(["bein"], ids, groups)).toThrow(/^no part "bein"$/);
  });
});
