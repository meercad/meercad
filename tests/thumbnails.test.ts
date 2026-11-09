import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import { describe, expect, it } from "vitest";
import { needsPicture, viewIsCurrent } from "../apps/web/src/lib/pictureState";

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
});
