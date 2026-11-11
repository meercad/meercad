import { mkdtempSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import { describe, expect, it, vi } from "vitest";
import { BIG_STEPS, backgroundBuildAllowed, kernelKindFor, blankPixels, lookSince, needsPicture, pictureRunner, viewIsCurrent } from "../apps/web/src/lib/pictureState";

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

  it("are made again when parts are drawn in new colours", () => {
    // First start with the new look: pictures written before it are redone, newer ones kept.
    const first = lookSince({ version: 1, since: 10 }, 2, 3000);
    expect(first).toEqual({ version: 2, since: 3000 });
    expect(lookSince(null, 2, 3000)).toEqual({ version: 2, since: 3000 });
    expect(needsPicture({ updatedAt: 1000, thumbnail: "data:", thumbnailAt: 1000.5 }, false, first.since)).toBe(true);
    expect(needsPicture({ updatedAt: 1000, thumbnail: "data:", thumbnailAt: 3500 }, false, first.since)).toBe(false);
    // Later starts keep the first time, so the new pictures stay.
    const stored = { version: 2, since: 3000 };
    expect(lookSince(stored, 2, 9000)).toBe(stored);
    // Without a picture date nothing can be told: kept, as before.
    expect(needsPicture({ updatedAt: 1000, thumbnail: "data:" }, false, first.since)).toBe(false);
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

  /**
   * The iPad app died when Emil (1129 steps) was opened: the overview was building it for its picture
   * in the background kernel (1.5 GB) while the editor built it once more in its own, and the page
   * grew past what the system allows it.
   */
  it("on the iPad and iPhone are built in the background only for small designs and with no project open", () => {
    const steps = (n: number) => ({ features: Array.from({ length: n }, () => ({}) as MeercadDocument["features"][number]) });
    const big = steps(BIG_STEPS + 1);
    const small = steps(BIG_STEPS);
    expect(backgroundBuildAllowed(big, { oneKernel: false, editorOpen: true })).toBe(true);
    expect(backgroundBuildAllowed(small, { oneKernel: true, editorOpen: false })).toBe(true);
    expect(backgroundBuildAllowed(small, { oneKernel: true, editorOpen: true })).toBe(false);
    expect(backgroundBuildAllowed(big, { oneKernel: true, editorOpen: false })).toBe(false);
  });

  it("of big designs are made in a kernel without threads on the iPad and iPhone, as the editor builds them", () => {
    expect(kernelKindFor(BIG_STEPS + 1, { mobile: true, threads: true })).toBe("kernel");
    expect(kernelKindFor(BIG_STEPS, { mobile: true, threads: true })).toBe("kernel-threads");
    expect(kernelKindFor(BIG_STEPS + 1, { mobile: false, threads: true })).toBe("kernel-threads");
    expect(kernelKindFor(10, { mobile: false, threads: false })).toBe("kernel");
  });
});

/**
 * A project's picture travels with it through iCloud (".Name.meercad-preview" next to the file):
 * another device takes it only while the file is still the one pictured.
 */
describe("pictures next to the project file", async () => {
  const { formatSidecar, parseSidecar, sha256Hex, sidecarName, sidecarShows } = await import("../apps/web/src/lib/sharedPicture");
  const { createHash } = await import("node:crypto");
  const file = new TextEncoder().encode(`${JSON.stringify(emptyDocument(), null, 2)}\n`);

  it("are named after the file and hidden", () => {
    expect(sidecarName("Bracket.meercad")).toBe(".Bracket.meercad-preview");
  });

  it("hash the file as the Mac does", async () => {
    expect(await sha256Hex(file)).toBe(createHash("sha256").update(file).digest("hex"));
  });

  it("are taken only for the file as it was pictured", async () => {
    const sha256 = (await sha256Hex(file))!;
    const text = formatSidecar({ size: file.length, sha256, look: 7, thumbnail: "data:image/png;base64,AAAA" });
    const p = parseSidecar(text)!;
    expect(p).toEqual({ size: file.length, sha256, look: 7, thumbnail: "data:image/png;base64,AAAA" });
    expect(sidecarShows(p, { size: file.length, sha256 })).toBe(true);
    // Changed since (on another device): made again.
    const changed = new TextEncoder().encode(`${JSON.stringify({ ...emptyDocument(), params: { w: "2 mm" } }, null, 2)}\n`);
    expect(sidecarShows(p, { size: changed.length, sha256: (await sha256Hex(changed))! })).toBe(false);
    expect(sidecarShows(p, { size: file.length, sha256: "0".repeat(64) })).toBe(false);
  });

  it("from another version or broken are not read", () => {
    expect(parseSidecar("not json")).toBeNull();
    expect(parseSidecar(JSON.stringify({ v: 2, size: 1, sha256: "a", look: 7, png: "AAAA" }))).toBeNull();
    expect(parseSidecar(JSON.stringify({ v: 1, size: 1, sha256: "a", look: 7, png: "" }))).toBeNull();
  });
});
