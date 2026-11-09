import { mkdtempSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import { describe, expect, it, vi } from "vitest";
import { blankPixels, needsPicture, pictureRunner, viewIsCurrent } from "../apps/web/src/lib/pictureState";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() } }));
const { adoptSiblingData } = await import("../apps/desktop/src/legacy");

/**
 * Overview pictures went stale (again): a save took the picture from the 3D view while the rebuild
 * of a slow model was still running, so it showed the previous state, or nothing at all when an
 * assistant opened several projects in a row (empty pictures over good ones). After that no new
 * picture was taken for as long as the project stayed open.
 */
describe("project pictures", () => {
  const before: MeercadDocument = emptyDocument();
  const after: MeercadDocument = { ...before, params: { width: "60 mm" } };

  it("are taken only when the view shows the document as it is now", () => {
    expect(viewIsCurrent({ shown: after, current: after, previewing: false })).toBe(true);
    // Just opened, first rebuild still running: the view is empty.
    expect(viewIsCurrent({ shown: null, current: after, previewing: false })).toBe(false);
    // Changed, rebuild still running: the view shows the state before the change.
    expect(viewIsCurrent({ shown: before, current: after, previewing: false })).toBe(false);
    // A dialog's live preview is not the saved model.
    expect(viewIsCurrent({ shown: after, current: after, previewing: true })).toBe(false);
  });

  it("are made again in the overview when older than their file", () => {
    expect(needsPicture({ updatedAt: 1000 })).toBe(true);
    // Saved with its picture: the picture is written right after the file.
    expect(needsPicture({ updatedAt: 1000, thumbnail: "data:", thumbnailAt: 1000.5 })).toBe(false);
    // Saved during a rebuild (no picture), or changed on the iPad or in another meerCAD copy.
    expect(needsPicture({ updatedAt: 5000, thumbnail: "data:", thumbnailAt: 1000 })).toBe(true);
    // Stores that do not say when the picture was written keep it.
    expect(needsPicture({ updatedAt: 5000, thumbnail: "data:" })).toBe(false);
  });

  /**
   * Pictures went missing again (2026-11-09): empty pictures saved before the fix above were copied
   * to the RC on its first start with a new date, so they counted as current and stayed empty.
   */
  it("that show nothing are made again, whatever their date", () => {
    const empty = new Uint8ClampedArray(96 * 72 * 4);
    expect(blankPixels(empty)).toBe(true);
    const drawn = empty.slice();
    drawn[(40 * 96 + 50) * 4 + 3] = 255;
    expect(blankPixels(drawn)).toBe(false);
    expect(needsPicture({ updatedAt: 1000, thumbnail: "data:", thumbnailAt: 5000 }, true)).toBe(true);
    expect(needsPicture({ updatedAt: 1000, thumbnail: "data:", thumbnailAt: 5000 }, false)).toBe(false);
  });

  it("keep their dates when the RC or WIP takes over its sibling's data", async () => {
    const root = mkdtempSync(join(tmpdir(), "meercad-sibling-"));
    const sibling = join(root, "meerCAD WIP");
    mkdirSync(join(sibling, "thumbnails"), { recursive: true });
    writeFileSync(join(sibling, "settings.json"), "{}");
    const picture = join(sibling, "thumbnails", "a.png");
    writeFileSync(picture, "png");
    const then = new Date("2026-11-09T09:05:33Z");
    utimesSync(picture, then, then);
    const rc = join(root, "meerCAD RC");
    expect(await adoptSiblingData(rc, [sibling])).toBe(sibling);
    expect(Math.abs(statSync(join(rc, "thumbnails", "a.png")).mtimeMs - then.getTime())).toBeLessThan(1000);
  });

  /**
   * Pictures went missing (2026-11-09): the overview made the examples' pictures first, and the coil
   * and springs examples each ran into the one-minute limit on every visit, so the projects' turn
   * came after two minutes or not at all; a project added meanwhile waited for the next visit.
   */
  it("are made for projects before examples, and again for projects changed meanwhile", async () => {
    const log: string[] = [];
    let finishExamples: () => void = () => undefined;
    let examplesStarted: () => void = () => undefined;
    const started = new Promise<void>((r) => (examplesStarted = r));
    let round = 0;
    const run = pictureRunner({
      projects: async () => void log.push(`projects ${++round}`),
      examples: () => {
        log.push(`examples ${round}`);
        if (round > 1) return Promise.resolve();
        examplesStarted();
        return new Promise<void>((r) => (finishExamples = r));
      },
    });
    const first = run();
    await started;
    // A project arrives while the slow examples are still being pictured.
    const second = run();
    finishExamples();
    await Promise.all([first, second]);
    expect(log).toEqual(["projects 1", "examples 1", "projects 2", "examples 2"]);
  });
});
