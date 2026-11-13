import { describe, expect, it } from "vitest";
import { staleCheck } from "./staleServer.js";

/** A fake file: its stamp, its contents, and whether it is there; counts the reads of its contents. */
function fakeFile() {
  const f = { stamp: 1, body: "v1", gone: false, reads: 0 };
  const probe = {
    stamp: () => {
      if (f.gone) throw new Error("ENOENT");

      return f.stamp;
    },
    hash: () => {
      if (f.gone) throw new Error("ENOENT");

      f.reads++;

      return f.body;
    },
  };

  return { f, probe };
}

describe("stale MCP server", () => {
  it("stays fresh while the file is unchanged, without reading it again", () => {
    const { f, probe } = fakeFile();
    const stale = staleCheck("/x/server.js", probe);
    expect([stale(), stale()]).toEqual([false, false]);
    expect(f.reads).toBe(1);
  });
  it("ignores the same build installed again (new stamp, same contents)", () => {
    const { f, probe } = fakeFile();
    const stale = staleCheck("/x/server.js", probe);
    f.stamp = 2;
    expect(stale()).toBe(false);
  });
  it("turns stale for good once the contents changed or the file went away", () => {
    const a = fakeFile();
    const stale = staleCheck("/x/server.js", a.probe);
    a.f.stamp = 2;
    a.f.body = "v2";
    expect(stale()).toBe(true);
    a.f.body = "v1";
    expect(stale()).toBe(true);

    const b = fakeFile();
    const gone = staleCheck("/x/server.js", b.probe);
    b.f.gone = true;
    expect(gone()).toBe(true);
  });
  it("never warns when the file could not be read at start", () => {
    const { f, probe } = fakeFile();
    f.gone = true;
    expect(staleCheck("/nope", probe)()).toBe(false);
  });

  it("watches a real file on disk", async () => {
    const { mkdtempSync, rmSync, writeFileSync, utimesSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "meercad-stale-"));

    try {
      const file = join(dir, "server.js");
      writeFileSync(file, "a");

      const stale = staleCheck(file);
      expect(stale()).toBe(false);
      writeFileSync(file, "b");
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      expect(stale()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
