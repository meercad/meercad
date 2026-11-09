import { describe, expect, it } from "vitest";
import { holderOf, openElsewhere, type ProjectWindow } from "../apps/desktop/src/openProjects";

/** The user's first window (1) shows A, an extra window (2) B, Claude's window (3) C, a finished assistant's (4) D. */
const windows: ProjectWindow[] = [
  { wc: 1, project: "A", assistant: null },
  { wc: 2, project: "B", assistant: null },
  { wc: 3, project: "C", assistant: "Claude" },
  { wc: 4, project: "D", assistant: "Codex", ended: true },
  { wc: 5, project: null, assistant: "Claude" },
];

describe("a project is open in one window only", () => {
  it("lists what the other windows have open, with the assistant's name", () => {
    expect(openElsewhere(windows, 1)).toEqual({ B: "", C: "Claude", D: "" });
    expect(openElsewhere(windows, 3)).toEqual({ A: "", B: "", D: "" });
  });
  it("finds the window to bring to the front instead of opening a project twice", () => {
    expect(holderOf(windows, "B", 1)?.wc).toBe(2);
    expect(holderOf(windows, "C", 1)?.wc).toBe(3);
    expect(holderOf(windows, "D", 1)?.wc).toBe(4);
    expect(holderOf(windows, "A", 1)).toBeNull();
    expect(holderOf(windows, "X", 1)).toBeNull();
  });
  it("prefers the assistant's window when a user window still shows the project too", () => {
    const both: ProjectWindow[] = [...windows, { wc: 6, project: "C", assistant: null }];
    expect(holderOf(both, "C", 1)?.wc).toBe(3);
    expect(openElsewhere(both, 1)["C"]).toBe("Claude");
  });
});
