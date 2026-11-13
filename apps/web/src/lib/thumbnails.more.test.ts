/**
 * Pictures made in the background (thumbnails.ts), the cases that are not pictured: a picture
 * whose build took the app down last time is not tried again; pictures of an older look are thrown
 * away; an empty project and one that does not build (it shows nothing) are noted and left until their
 * file changes; an example that shows nothing gets no picture.
 */
import { describe, expect, it, vi } from "vitest";
import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import { LOOK_VERSION } from "@meercad/viewport";
import { fillThumbnails, startBackgroundPictures } from "./thumbnails";
import { createProject } from "./persistence";
import { refreshProjects } from "../store";

const failed = () => JSON.parse(localStorage.getItem("meercad.no-picture") ?? "{}") as Record<string, number>;
const broken: MeercadDocument = { ...emptyDocument(), features: [{ id: "ex1", op: "extrude", profile: { sketch: "nope" }, extent: "blind", distance: 1, mode: "new_body" }] };

describe("pictures not made", () => {
  it("forgets a picture that took the app down, throws old looks away, and notes empty and broken projects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Last time the app went down while picturing "crashed"; and a picture of an older look is kept.
    localStorage.setItem("meercad.picture-building", JSON.stringify({ project: "crashed", at: 5 }));
    localStorage.setItem("meercad.picture-look", "{not json");
    localStorage.setItem(`meercad.example-thumb.Old.abc.v${LOOK_VERSION - 1}`, "data:image/png;base64,old");
    localStorage.setItem(`meercad.example-thumb.New.abc.v${LOOK_VERSION}`, "data:image/png;base64,new");
    const empty = await createProject("Empty", emptyDocument());
    const bad = await createProject("Broken", broken);
    await refreshProjects();
    startBackgroundPictures([]);
    expect(failed()["crashed"]).toBe(5);
    expect(localStorage.getItem("meercad.picture-building")).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("took the app down"))).toBe(true);
    await vi.waitFor(() => expect(Object.keys(failed())).toEqual(expect.arrayContaining([empty.id, bad.id])), { timeout: 30_000, interval: 100 });
    // The look is stored again; only the old look's example picture went.
    expect(JSON.parse(localStorage.getItem("meercad.picture-look")!)).toMatchObject({ version: LOOK_VERSION });
    expect(localStorage.getItem(`meercad.example-thumb.Old.abc.v${LOOK_VERSION - 1}`)).toBeNull();
    expect(localStorage.getItem(`meercad.example-thumb.New.abc.v${LOOK_VERSION}`)).not.toBeNull();
    // Started once only.
    startBackgroundPictures([]);
    warn.mockRestore();
  }, 60_000);

  it("makes nothing for an example that shows nothing, or one shipped with its picture", async () => {
    let done = 0;
    await fillThumbnails([{ name: "Shipped", thumbnail: "data:x", doc: broken }, { name: "Nothing", doc: emptyDocument() }], () => done++);
    expect(done).toBe(0);
  }, 60_000);
});
