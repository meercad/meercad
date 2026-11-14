import { afterEach, describe, expect, it } from "vitest";
import { TERMS_POINTS, TERMS_VERSION } from "./terms";
import { requireTerms, saveTerms, termsAccepted, termsRecord } from "./termsStore";

const scope = window as unknown as { __meercadUITest?: boolean };

afterEach(() => {
  delete scope.__meercadUITest;
  localStorage.clear();
});

describe("the terms record on this device", () => {
  it("is asked for until it is there; an assistant's request is refused until then", () => {
    expect(termsAccepted()).toBe(false);
    expect(() => requireTerms()).toThrow();
  });

  it("a UI test passes the screen without a record being written", () => {
    scope.__meercadUITest = true;
    expect(termsAccepted()).toBe(true);
    expect(() => requireTerms()).not.toThrow();
    expect(termsRecord()).toBeNull();
    expect(localStorage.length).toBe(0);
    delete scope.__meercadUITest;
    expect(termsAccepted()).toBe(false);
  });

  // Last: what was accepted stays for this window.
  it("accepting keeps the record, here and for the next start", () => {
    let told = 0;
    window.addEventListener("meercad:terms-accepted", () => told++, { once: true });
    saveTerms({
      version: TERMS_VERSION,
      acceptedAt: "2026-11-13T12:00:00.000Z",
      appVersion: "",
      lang: "de",
      points: TERMS_POINTS.map((p) => p.id),
    });
    expect(termsAccepted()).toBe(true);
    expect(told).toBe(1);
    expect(JSON.parse(localStorage.getItem("meercad.termsAccepted")!).version).toBe(TERMS_VERSION);
  });
});
