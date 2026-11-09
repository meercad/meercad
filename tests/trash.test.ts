import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moveToTrash, trashDirFor } from "../apps/desktop/src/trash";

/**
 * Deleting 43 parts at once left one in iCloud Drive with "could not be moved to the Trash because
 * you don't have the required permission", although the file could be trashed fine right after.
 */
describe("moving projects to the Trash", () => {
  const home = () => mkdtempSync(join(tmpdir(), "meercad-trash-"));
  const refuse = async () => {
    throw new Error("could not be moved to the Trash because you don't have the required permission");
  };

  it("picks iCloud Drive's own Trash for files in iCloud Drive", () => {
    const h = "/Users/x";
    expect(trashDirFor("/Users/x/Library/Mobile Documents/iCloud~dev~meercad~app/Documents/A.meercad", h)).toBe("/Users/x/Library/Mobile Documents/.Trash");
    expect(trashDirFor("/Users/x/Documents/meerCAD/A.meercad", h)).toBe("/Users/x/.Trash");
  });

  it("tries again when the system refuses once", async () => {
    const h = home();
    const file = join(h, "A.meercad");
    writeFileSync(file, "{}");
    let calls = 0;
    await moveToTrash(file, async (p) => {
      if (++calls === 1) return refuse();
      expect(p).toBe(file);
    }, { home: h, waitMs: 1 });
    expect(calls).toBe(2);
  });

  it("moves the file into the Trash folder itself when the system keeps refusing", async () => {
    const h = home();
    const dir = join(h, "Library", "Mobile Documents", "iCloud~dev~meercad~app", "Documents");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(h, "Library", "Mobile Documents", ".Trash"));
    writeFileSync(join(h, "Library", "Mobile Documents", ".Trash", "Raum.meercad"), "older");
    const file = join(dir, "Raum.meercad");
    writeFileSync(file, "{}");
    await moveToTrash(file, refuse, { home: h, waitMs: 1 });
    expect(existsSync(file)).toBe(false);
    // An item of the same name already in the Trash stays; the new one is numbered.
    expect(existsSync(join(h, "Library", "Mobile Documents", ".Trash", "Raum.meercad"))).toBe(true);
    expect(existsSync(join(h, "Library", "Mobile Documents", ".Trash", "Raum 2.meercad"))).toBe(true);
  });

  it("reports the system's error when nothing works", async () => {
    const h = home();
    await expect(moveToTrash(join(h, "missing-dir", "A.meercad"), async () => {
      throw new Error("no permission");
    }, { home: h, waitMs: 1 })).resolves.toBeUndefined(); // already gone: nothing to report
    const file = join(h, "B.meercad");
    writeFileSync(file, "{}");
    // The Trash folder cannot be made: a file stands where it would go.
    writeFileSync(join(h, ".Trash"), "");
    await expect(moveToTrash(file, refuse, { home: h, waitMs: 1 })).rejects.toThrow("required permission");
    expect(existsSync(file)).toBe(true);
  });
});
