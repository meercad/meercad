/**
 * The check of built apps against their oldest supported system (scripts/min-os.mjs): versions compare
 * number by number, the build versions are read from vtool's output, and only Mach-O files are checked.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVersions, machOFiles, parseMinos } from "../scripts/min-os.mjs";

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });

  dir = null;
});

describe("system versions", () => {
  it("compare number by number", () => {
    expect(compareVersions("18.0", "18.0")).toBe(0);
    expect(compareVersions("18", "18.0")).toBe(0);
    expect(compareVersions("18.10", "18.2")).toBeGreaterThan(0);
    expect(compareVersions("17.6", "18.0")).toBeLessThan(0);
    expect(compareVersions("26.0", "18.0")).toBeGreaterThan(0);
  });

  it("are read from vtool's build output, one per architecture", () => {
    const text = [
      "App (architecture arm64):",
      "Load command 10",
      "      cmd LC_BUILD_VERSION",
      "  platform IOS",
      "    minos 18.0",
      "      sdk 27.1",
      "App (architecture x86_64):",
      "    minos 13.0",
    ].join("\n");

    expect(parseMinos(text)).toEqual(["18.0", "13.0"]);
    expect(parseMinos("not a Mach-O file")).toEqual([]);
  });
});

describe("Mach-O files in a bundle", () => {
  it("are found by their magic number, in folders too, without following links", () => {
    dir = mkdtempSync(join(tmpdir(), "min-os-"));
    mkdirSync(join(dir, "Frameworks/A.framework"), { recursive: true });
    writeFileSync(join(dir, "App"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0]));
    writeFileSync(join(dir, "Frameworks/A.framework/A"), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0]));
    writeFileSync(join(dir, "Info.plist"), "<plist/>");
    writeFileSync(join(dir, "tiny"), "ab");
    symlinkSync(join(dir, "App"), join(dir, "link"));

    expect(machOFiles(dir).sort()).toEqual([join(dir, "App"), join(dir, "Frameworks/A.framework/A")]);
  });
});
