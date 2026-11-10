import { describe, expect, it } from "vitest";
import { chooseTab, newTabKey, tabOfSession } from "./protocol.js";

describe("a session's tabs, one per project", () => {
  const tab = (session: string, project: string | null) => ({ session, project });

  it("keys a session's first tab by the session, further ones by a number", () => {
    expect(newTabKey("s", [])).toBe("s");
    expect(newTabKey("s", ["s", "other"])).toBe("s~2");
    expect(newTabKey("s", ["s", "s~2", "s~3"])).toBe("s~4");
  });

  it("tells a session's tabs from another session's with a longer name", () => {
    expect(tabOfSession("s", "s")).toBe(true);
    expect(tabOfSession("s~2", "s")).toBe(true);
    expect(tabOfSession("s2", "s")).toBe(false);
    expect(tabOfSession("s", "s~2")).toBe(false);
  });

  it("sends a call naming a project to the session's tab of that project, never another session's", () => {
    const tabs = [tab("a", "p1"), tab("a~2", "p2"), tab("b", "p3")];
    expect(chooseTab(tabs, "a", "p2")).toEqual({ tab: tab("a~2", "p2") });
    expect(chooseTab(tabs, "a", "p3")).toEqual({ none: "project", project: "p3" });
  });

  it("sends a call naming none to the session's only tab, and asks which when there are several", () => {
    expect(chooseTab([tab("a", "p1"), tab("b", "p2")], "a")).toEqual({ tab: tab("a", "p1") });
    expect(chooseTab([tab("a", "p1"), tab("a~2", "p2")], "a")).toEqual({ several: [tab("a", "p1"), tab("a~2", "p2")] });
    expect(chooseTab([tab("b", "p2")], "a")).toEqual({ none: "open" });
  });
});
