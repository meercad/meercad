/**
 * Pictures of projects and examples (thumbnails.ts), made in the background with a spare kernel and
 * an off-screen view: each example gets one, a design that cannot be built is noted and not tried
 * again, and a project without a picture gets one written next to it.
 */
import { describe, expect, it, vi } from "vitest";
import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import { EXAMPLES } from "./examples";
import { LOOK_VERSION } from "@meercad/viewport";
import { exampleThumbnail, fillThumbnails, startBackgroundPictures } from "./thumbnails";
import { testFiles } from "../../test/setup";
import { createProject } from "./persistence";
import { refreshProjects } from "../store";

describe("pictures", () => {
  it("makes a picture of each example and keeps it", async () => {
    const two = EXAMPLES.slice(0, 2);
    let done = 0;
    await fillThumbnails(two, () => done++);
    expect(done).toBe(2);
    for (const ex of two) expect(exampleThumbnail(ex.name, ex.doc)).toMatch(/^data:image\/png/);
    // Asked again: nothing is made twice.
    await fillThumbnails(two, () => done++);
    expect(done).toBe(2);
  });

  it("notes an example that does not build and leaves it", async () => {
    const broken: MeercadDocument = {
      ...emptyDocument(),
      features: [
        {
          id: "ex1",
          op: "extrude",
          profile: { sketch: "nope" },
          extent: "blind",
          distance: 1,
          mode: "new_body",
        },
      ],
    };
    let done = 0;
    await fillThumbnails([{ name: "Broken", doc: broken }], () => done++);
    expect(done).toBe(0);
    expect(exampleThumbnail("Broken", broken)).toBeNull();
  });

  it("pictures the saved projects that have none", async () => {
    const doc: MeercadDocument = { ...EXAMPLES[0]!.doc };
    const meta = await createProject("Pictured", doc);
    await refreshProjects();
    startBackgroundPictures([]);
    await vi.waitFor(() => expect(testFiles.projects.get(meta.id)!.thumbnail ?? null).not.toBeNull(), {
      timeout: 30_000,
      interval: 100,
    });
  }, 60_000);

  /**
   * The iPhone showed none of the pictures the Mac had left next to the files in iCloud: each
   * project's was looked at only when its turn came in the build queue, and a project without one
   * (just changed on the Mac) was built first, minutes there or until the page died, on every visit.
   */
  it("takes the pictures other devices left next to the files before building any project", async () => {
    const doc: MeercadDocument = { ...EXAMPLES[0]!.doc };
    // The list's order is the build queue's: the one without a picture comes first.
    const newer = await createProject("Changed just now", doc);
    const older = await createProject("From the Mac", doc);
    const picture = "data:image/png;base64,c2hhcmVk";
    testFiles.shared.set(older.id, { thumbnail: picture, look: LOOK_VERSION });
    testFiles.calls.length = 0;
    await refreshProjects();
    await fillThumbnails([], () => undefined);
    await vi.waitFor(() => expect(testFiles.projects.get(newer.id)!.thumbnail ?? null).not.toBeNull(), {
      timeout: 30_000,
      interval: 100,
    });
    expect(testFiles.projects.get(older.id)!.thumbnail).toBe(picture);
    // Both shared pictures looked at before the one without was read for its build.
    expect(testFiles.calls.indexOf(`shared:${older.id}`)).toBeLessThan(
      testFiles.calls.indexOf(`load:${newer.id}`),
    );
    expect(testFiles.calls).not.toContain(`load:${older.id}`);
  }, 60_000);
});
