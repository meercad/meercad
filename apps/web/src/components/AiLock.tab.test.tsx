/**
 * The lock in an assistant's own tab (AiLock.tsx in the Mac app's assistant window): always there,
 * glowing while the assistant works, with the assistant's bar; a right click on it opens no menu.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/persistence", async (orig) => ({ ...(await orig<typeof import("../lib/persistence")>()), assistantWindow: { session: "s1", client: "Claude" } }));

import { useApp } from "../store";
import { AiLock } from "./AiLock";

afterAll(() => {
  useApp.setState({ aiLock: null });
  cleanup();
});

describe("the lock in an assistant's tab", () => {
  it("is always there and glows while the assistant works", async () => {
    const { container } = render(<AiLock />);
    const lock = () => container.querySelector<HTMLElement>(".ai-lock.in-tab")!;
    expect(lock().className).not.toContain("busy");
    await act(async () => useApp.setState({ aiLock: { client: "Claude" } as never }));
    expect(lock().className).toContain("busy");
    const menu = fireEvent.contextMenu(lock());
    expect(menu).toBe(false);
  });
});
