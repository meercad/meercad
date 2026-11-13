/**
 * A picture another meerCAD on this Mac drew of a project (persistence.ts): taken over when it shows
 * the current look, left when it is older or not there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOK_VERSION } from "@meercad/viewport";
import { takeSharedThumbnail } from "./persistence";

const projects = () => (window as unknown as { meercadDesktop: { projects: Record<string, unknown> } }).meercadDesktop.projects;
afterEach(() => {
  delete projects()["sharedThumbnail"];
  vi.restoreAllMocks();
});

describe("shared pictures", () => {
  it("takes a picture of the current look, not an older one or none", async () => {
    const saved: unknown[] = [];
    const was = projects()["thumbnail"];
    projects()["thumbnail"] = async (p: unknown) => void saved.push(p);
    try {
      projects()["sharedThumbnail"] = async () => ({ thumbnail: "data:image/png;base64,AA", look: LOOK_VERSION });
      expect(await takeSharedThumbnail("p1")).toBe("data:image/png;base64,AA");
      expect(saved).toEqual([{ id: "p1", thumbnail: "data:image/png;base64,AA", local: true }]);
      projects()["sharedThumbnail"] = async () => ({ thumbnail: "x", look: LOOK_VERSION - 1 });
      expect(await takeSharedThumbnail("p1")).toBeNull();
      projects()["sharedThumbnail"] = async () => {
        throw new Error("gone");
      };
      expect(await takeSharedThumbnail("p1")).toBeNull();
      expect(saved).toHaveLength(1);
    } finally {
      projects()["thumbnail"] = was;
    }
  });
});
