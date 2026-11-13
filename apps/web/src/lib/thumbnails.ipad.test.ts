/**
 * Background pictures on the iPad and iPhone (thumbnails.ts with `oneKernel`): there is room for the
 * editor's kernel only, so pictures are built in it while no project is open. A project opened
 * meanwhile stops the picture being built (it is not noted as failed), and closing it again makes
 * the pictures go on; a project file too big to read there gets its picture from the editor.
 */
import { describe, expect, it, vi } from "vitest";
import { EXAMPLES } from "./examples";

vi.mock("./persistence", async (orig) => ({ ...(await orig<typeof import("./persistence")>()), desktop: undefined }));

import { startBackgroundPictures } from "./thumbnails";
import { createProject } from "./persistence";
import { goHome, newProject, refreshProjects, useApp } from "../store";
import { testFiles } from "../../test/setup";

const failed = () => JSON.parse(localStorage.getItem("meercad.no-picture") ?? "{}") as Record<string, number>;
const thumb = (id: string) => testFiles.projects.get(id)?.thumbnail ?? null;

describe("pictures with one kernel", () => {
  it("waits while a project is open, and goes on once it is closed", async () => {
    const meta = await createProject("Later", { ...EXAMPLES[0]!.doc });
    await newProject(undefined, "Open now");
    await refreshProjects();
    startBackgroundPictures([]);
    await new Promise((r) => setTimeout(r, 1500));
    // The editor is open: nothing is built, nothing noted as failed.
    expect(thumb(meta.id)).toBeNull();
    expect(failed()[meta.id]).toBeUndefined();
    goHome();
    await vi.waitFor(() => expect(thumb(meta.id)).not.toBeNull(), { timeout: 30_000, interval: 100 });
  }, 60_000);

  it("stops the picture being built when a project is opened, and tries it again later", async () => {
    // A design that takes a while: the biggest example.
    const slow = [...EXAMPLES].sort((a, b) => b.doc.features.length - a.doc.features.length)[0]!;
    const meta = await createProject("Stopped", { ...slow.doc });
    await refreshProjects();
    // Opened while its picture is (about to be) built.
    await new Promise((r) => setTimeout(r, 20));
    await newProject(undefined, "Editor wins");
    await new Promise((r) => setTimeout(r, 300));
    expect(failed()[meta.id]).toBeUndefined();
    goHome();
    await vi.waitFor(() => expect(thumb(meta.id) ?? failed()[meta.id]).toBeTruthy(), { timeout: 50_000, interval: 100 });
    expect(useApp.getState().project).toBeNull();
  }, 90_000);
});
