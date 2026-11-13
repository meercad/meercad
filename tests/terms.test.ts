import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DE } from "../apps/web/src/lib/i18n/de";
import {
  acceptRecord,
  needsAcceptance,
  parseRecord,
  scrolledToEnd,
  TERMS_KEY,
  TERMS_MCP_ERROR,
  TERMS_POINTS,
  TERMS_VERSION,
  type TermsRecord,
} from "../apps/web/src/lib/terms";

const root = join(import.meta.dirname, "..");
const good: TermsRecord = {
  version: TERMS_VERSION,
  acceptedAt: "2026-11-12T10:00:00.000Z",
  appVersion: "1.4.0",
  lang: "de",
  points: TERMS_POINTS.map((p) => p.id),
};

describe("terms of use record", () => {
  it("reads a valid record, also as JSON text, and copies it", () => {
    expect(parseRecord(good)).toEqual(good);
    expect(parseRecord(good)).not.toBe(good);
    expect(parseRecord(good)!.points).not.toBe(good.points);
    expect(parseRecord(JSON.stringify(good))).toEqual(good);
    expect(parseRecord({ ...good, extra: 1 })).toEqual(good);
  });

  it("rejects anything that is not a whole record", () => {
    for (const raw of [undefined, null, "", "{", "null", "[]", 42, true, [], [good]]) {
      expect(parseRecord(raw)).toBeNull();
    }

    const broken: Record<string, unknown>[] = [
      { ...good, version: "" },
      { ...good, version: 1 },
      { ...good, acceptedAt: "yesterday" },
      { ...good, acceptedAt: 0 },
      { ...good, appVersion: null },
      { ...good, lang: undefined },
      { ...good, points: "hobby" },
      { ...good, points: ["hobby", 2] },
    ];
    for (const r of broken) expect(parseRecord(r)).toBeNull();

    const { version: _v, ...noVersion } = good;
    expect(parseRecord(noVersion)).toBeNull();
  });

  it("asks when there is no record, a broken one, another version or a missing point", () => {
    expect(needsAcceptance(null)).toBe(true);
    expect(needsAcceptance(parseRecord("not json"))).toBe(true);
    expect(needsAcceptance({ ...good, version: "2020-01-01" })).toBe(true);
    expect(needsAcceptance(good, "2099-01-01")).toBe(true);
    expect(needsAcceptance({ ...good, points: good.points.slice(1) })).toBe(true);
    expect(needsAcceptance({ ...good, points: [] })).toBe(true);
  });

  it("does not ask again for the current text with every point", () => {
    expect(needsAcceptance(good)).toBe(false);
    expect(needsAcceptance(good, TERMS_VERSION)).toBe(false);
    expect(needsAcceptance({ ...good, points: [...good.points, "old-point"] })).toBe(false);
  });

  it("makes a record that is accepted and survives storage", () => {
    const now = new Date("2026-11-12T12:34:56.000Z");
    const r = acceptRecord("1.4.0", "en", now);
    expect(r).toEqual({
      version: TERMS_VERSION,
      acceptedAt: "2026-11-12T12:34:56.000Z",
      appVersion: "1.4.0",
      lang: "en",
      points: TERMS_POINTS.map((p) => p.id),
    });
    expect(needsAcceptance(parseRecord(JSON.stringify(r)))).toBe(false);
    expect(Date.parse(acceptRecord("", "de").acceptedAt)).not.toBeNaN();
  });

  it("knows when the text is read to the end", () => {
    // shorter than the box
    expect(scrolledToEnd({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(true);
    expect(scrolledToEnd({ scrollTop: 0, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
    // within the tolerance
    expect(scrolledToEnd({ scrollTop: 690, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(scrolledToEnd({ scrollTop: 690, scrollHeight: 1000, clientHeight: 300 }, 0)).toBe(false);
    expect(scrolledToEnd({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 }, 0)).toBe(true);
  });

  it("has distinct points, each translated", () => {
    expect(new Set(TERMS_POINTS.map((p) => p.id)).size).toBe(TERMS_POINTS.length);
    for (const p of TERMS_POINTS) expect(DE[p.text], p.text).toBeTruthy();
  });

  it("tells the assistant why it is refused, in both languages", () => {
    expect(TERMS_MCP_ERROR).toContain("accept the terms of use");
    expect(TERMS_MCP_ERROR).toContain("Nutzungsvereinbarung akzeptieren");
  });

  it("ships the terms in English and German, naming the version and the EULA", () => {
    for (const [file, eula] of [
      ["TERMS.md", "https://meercad.app/eula"],
      ["TERMS.de.md", "https://meercad.app/de/eula"],
    ] as const) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text, file).toContain(`Version ${TERMS_VERSION}`);
      expect(text, file).toContain(eula);
      expect(text, file).toContain("Torben Berger UG (haftungsbeschränkt)");
    }
  });

  it("is accepted for the current version in the app profiles the test runs start", () => {
    // tests/e2e/app.ts imports the record; the bench script (plain JavaScript) names the version itself.
    expect(readFileSync(join(root, "tests/e2e/app.ts"), "utf8")).toContain("TERMS_KEY");

    const bench = readFileSync(join(root, "packages/mcp/scripts/bench.mjs"), "utf8");
    expect(bench).toContain(`"${TERMS_VERSION}"`);
    expect(bench).toContain(TERMS_KEY);
    for (const p of TERMS_POINTS) expect(bench).toContain(`"${p.id}"`);
  });
});
