/**
 * Assistants' tabs in the window (AssistantTab.tsx), with a stand-in for the Mac app: the pane lays
 * the assistant's page over its room, swaps it for a picture while a menu or dialog of this page is
 * open, and hides it when it goes; the bar in the assistant's page says who is working and on what,
 * and Take over hands the project back.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useApp } from "../store";
import { renderUi, withScreen } from "../../test/ui";
import { AssistantBar, AssistantPane } from "./AssistantTab";

const shown: unknown[] = [];
let snapshots = 0;
const desktop = () => (window as unknown as { meercadDesktop: Record<string, unknown> }).meercadDesktop;
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeAll(() => {
  withScreen(1280, 800);
  desktop()["assistant"] = {
    show: (p: unknown) => void shown.push(p),
    snapshot: async () => (snapshots++, "data:image/png;base64,AAAA"),
    tabs: async () => [],
    stop: () => undefined,
  };
  useApp.setState({
    assistantTabs: [
      { session: "S1", client: "Claude", project: "p1", name: "Bracket", busy: false, tool: null },
    ],
  });
});
afterAll(() => {
  cleanup();
  delete desktop()["assistant"];
});

describe("an assistant's tab in the window", () => {
  it("lays the assistant's page over its room, and a picture while a menu covers it", async () => {
    renderUi(<AssistantPane session="S1" />);
    await settle();
    expect(shown.at(-1)).toMatchObject({
      session: "S1",
      rect: { width: expect.any(Number), height: expect.any(Number) },
    });
    expect(screen.getByText("Claude is opening the project…")).toBeTruthy();

    // A menu of this page opens: the assistant's page makes way, its picture stands in.
    const menu = document.createElement("div");
    menu.className = "menu";
    await act(async () => void document.body.append(menu));
    await settle(60);
    expect(snapshots).toBe(1);
    expect(shown.at(-1)).toBeNull();
    expect(document.querySelector<HTMLImageElement>(".assistant-still")!.src).toMatch(/^data:image\/png/);
    await act(async () => void menu.remove());
    await settle(60);
    expect(shown.at(-1)).toMatchObject({ session: "S1" });
    cleanup();
    // Gone: hidden.
    expect(shown.at(-1)).toBeNull();
  });

  it("says in the assistant's page who works on what, and hands the project back on Take over", async () => {
    useApp.setState({ aiLock: null, project: { id: "p1", name: "Bracket" } as never });
    renderUi(<AssistantBar />);
    expect(screen.getByText("Claude has this model open")).toBeTruthy();
    expect(screen.getByText(/yours again after 30 minutes without one/)).toBeTruthy();
    await act(async () =>
      useApp.setState({
        aiLock: { client: "Claude" } as never,
        aiActivity: { client: "Claude", tool: "apply_ops" } as never,
      }),
    );
    expect(screen.getByText("Claude is working on this model")).toBeTruthy();
    expect(document.querySelector(".assistant-tool")!.textContent).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByText("Take over")));
    await act(async () => useApp.setState({ aiLock: null, aiActivity: null } as never));
  });
});
