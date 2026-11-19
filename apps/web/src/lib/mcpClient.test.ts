/** The connected program's name as people know it. */
import { describe, expect, it } from "vitest";
import { clientLabel } from "./mcpClient";

describe("clientLabel", () => {
  it("names known programs, turns machine names into titles and keeps proper titles", () => {
    expect(clientLabel(undefined)).toBe("Assistant");
    expect(clientLabel("  ")).toBe("Assistant");
    expect(clientLabel(" Claude-Code ")).toBe("Claude Code");
    expect(clientLabel("vscode")).toBe("VS Code");
    expect(clientLabel("my_cool-agent2")).toBe("My Cool Agent2");
    expect(clientLabel(" Zed Editor ")).toBe("Zed Editor");
  });
});
