import { describe, expect, it } from "vitest";
import { chooseTab, newTabKey, openBlock, openBlockMessage, tabOfSession } from "./protocol.js";

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

describe("one open project per session", () => {
  const tab = (session: string, project: string | null, name: string | null = null) => ({ session, project, name });

  it("lets a session open a project while it has none, and ignores other sessions' tabs", () => {
    expect(openBlock([], "a", [])).toBeNull();
    expect(openBlock([tab("b", "p1")], "a", [], "p2")).toBeNull();
    // A tab left without a project (an open that failed) blocks nothing.
    expect(openBlock([tab("a", null)], "a", [], "p1")).toBeNull();
  });

  it("refuses a second project while the session has one open, naming it and how it is freed", () => {
    const block = openBlock([tab("a", "p1", "Box")], "a", [], "p2");
    expect(block).toEqual({ tab: tab("a", "p1", "Box"), same: false });
    const msg = openBlockMessage(block!, 90_000);
    expect(msg).toContain('"Box" (id "p1")');
    expect(msg).toContain("last call 2 min ago");
    expect(msg).toContain("close_project");
    expect(msg).toContain("30 minutes");
    expect(msg).toContain("cannot tell the chats");
    // new_project / open_example: no target.
    expect(openBlock([tab("a~2", "p1")], "a", [])).toEqual({ tab: tab("a~2", "p1"), same: false });
  });

  it("refuses opening the open project again, telling its own chat to just go on", () => {
    const block = openBlock([tab("a", "p1", "Box")], "a", [], "p1");
    expect(block).toEqual({ tab: tab("a", "p1", "Box"), same: true });
    expect(openBlockMessage(block!)).toContain("If this chat opened it, just go on");
  });

  it("refuses while another open of the session is under way", () => {
    expect(openBlock([], "a", ["a~2"], "p1")).toEqual({ opening: true });
    expect(openBlock([], "a", ["b"], "p1")).toBeNull();
  });
});
