/** A project's picture next to its file, as written and read on every device. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSidecar, parseSidecar, sha256Hex, sidecarName, sidecarShows } from "./sharedPicture";

const picture = { size: 1234, sha256: "ab12", look: 3, thumbnail: "data:image/png;base64,iVBORw0" };

afterEach(() => vi.unstubAllGlobals());

describe("sidecar", () => {
  it("is named after the project file and reads back what it wrote", () => {
    expect(sidecarName("Bracket.meercad")).toBe(".Bracket.meercad-preview");
    expect(sidecarName("Notes")).toBe(".Notes.meercad-preview");
    expect(JSON.parse(formatSidecar(picture))).toEqual({
      v: 1,
      size: 1234,
      sha256: "ab12",
      look: 3,
      png: "iVBORw0",
    });
    expect(parseSidecar(formatSidecar(picture))).toEqual(picture);
  });

  it("refuses what this version cannot read", () => {
    const good = JSON.parse(formatSidecar(picture));

    expect(parseSidecar("not json")).toBeNull();
    expect(parseSidecar(JSON.stringify({ ...good, v: 2 }))).toBeNull();
    expect(parseSidecar(JSON.stringify({ ...good, size: "1234" }))).toBeNull();
    expect(parseSidecar(JSON.stringify({ ...good, sha256: 1 }))).toBeNull();
    expect(parseSidecar(JSON.stringify({ ...good, look: "3" }))).toBeNull();
    expect(parseSidecar(JSON.stringify({ ...good, png: 5 }))).toBeNull();
    expect(parseSidecar(JSON.stringify({ ...good, png: "" }))).toBeNull();
  });

  it("shows the file only while its size and hash match", () => {
    expect(sidecarShows(picture, { size: 1234, sha256: "ab12" })).toBe(true);
    expect(sidecarShows(picture, { size: 1234, sha256: "cd34" })).toBe(false);
    expect(sidecarShows(picture, { size: 1, sha256: "ab12" })).toBe(false);
  });
});

describe("sha256Hex", () => {
  it("hashes bytes as hex", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("gives null without Web Crypto", async () => {
    vi.stubGlobal("crypto", undefined);
    expect(await sha256Hex(new Uint8Array(1))).toBeNull();
  });
});
