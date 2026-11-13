/**
 * The assistants' button and dialog (McpButton.tsx): it opens and closes (button, Escape, backdrop);
 * the switch turns the bridge on and off; "Add to Claude Desktop" says where it wrote the entry, or
 * that Claude Desktop installs the extension, or why it could not; the configuration shown is the
 * Mac app's server command and is copied; the App Store build adds the Node.js note.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApp } from "../store";
import * as bridge from "../lib/mcpBridge";
import { renderUi } from "../../test/ui";
import { McpButton } from "./McpButton";

const desktop = () => (window as unknown as { meercadDesktop: Record<string, (...a: never[]) => Promise<unknown>> }).meercadDesktop;
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("the assistants' dialog", () => {
  it("opens and closes, switches the bridge, and shows and copies the Mac app's server command", async () => {
    vi.spyOn(desktop(), "info").mockResolvedValue({ mcpCommand: { command: "/Apps/meerCAD", args: ["--mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } }, mcpName: "meercad-rc", mas: false } as never);
    const enable = vi.spyOn(bridge, "setBridgeEnabled").mockImplementation(() => undefined);
    renderUi(<McpButton />);
    await settle();
    await act(async () => void fireEvent.click(screen.getByTitle(/^AI assistants \(MCP\)/)));
    expect(screen.getByText("Connect AI assistants (MCP)")).toBeTruthy();
    expect(document.querySelector("pre")!.textContent).toContain('"meercad-rc"');
    expect(document.querySelector(".dialog-body .mono:not(pre)")!.textContent).toBe('claude mcp add meercad-rc -e ELECTRON_RUN_AS_NODE=1 -- "/Apps/meerCAD" "--mcp"');
    await act(async () => void fireEvent.click(screen.getByRole("checkbox")));
    expect(enable).toHaveBeenCalled();
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (s: string) => void copied.push(s) }, configurable: true });
    await act(async () => void fireEvent.click(screen.getByText("Copy configuration")));
    await settle();
    expect(JSON.parse(copied[0]!)).toEqual({ mcpServers: { "meercad-rc": { command: "/Apps/meerCAD", args: ["--mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } } } });
    expect(toasts()).toMatch(/Configuration copied/);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(screen.queryByText("Connect AI assistants (MCP)")).toBeNull();
    await act(async () => void fireEvent.click(screen.getByTitle(/^AI assistants \(MCP\)/)));
    await act(async () => void fireEvent.click(screen.getByLabelText("Close")));
    expect(screen.queryByText("Connect AI assistants (MCP)")).toBeNull();
    await act(async () => void fireEvent.click(screen.getByTitle(/^AI assistants \(MCP\)/)));
    await act(async () => void fireEvent.pointerDown(document.querySelector(".modal-backdrop")!));
    expect(screen.queryByText("Connect AI assistants (MCP)")).toBeNull();
  });

  it("adds meerCAD to Claude Desktop, as an entry or as the extension, and says why it could not", async () => {
    vi.spyOn(desktop(), "info").mockResolvedValue({ mcpCommand: { command: "node", args: ["server.js"] }, mas: true } as never);
    const install = vi.spyOn(desktop(), "installClaudeDesktop");
    renderUi(<McpButton />);
    await settle();
    await act(async () => void fireEvent.click(screen.getByTitle(/^AI assistants \(MCP\)/)));
    expect(screen.getByText(/Other assistants start the server with Node\.js/)).toBeTruthy();
    install.mockResolvedValueOnce("/Users/x/claude_desktop_config.json" as never);
    await act(async () => void fireEvent.click(screen.getByText("Add to Claude Desktop")));
    await settle();
    expect(toasts()).toMatch(/Added to Claude Desktop \(\/Users\/x\/claude_desktop_config\.json\)/);
    install.mockResolvedValueOnce(null as never);
    await act(async () => void fireEvent.click(screen.getByText("Add to Claude Desktop")));
    await settle();
    expect(toasts()).toMatch(/Claude Desktop opens the meerCAD extension/);
    install.mockRejectedValueOnce(new Error("config is read-only"));
    await act(async () => void fireEvent.click(screen.getByText("Add to Claude Desktop")));
    await settle();
    expect(toasts()).toMatch(/Could not update the Claude Desktop config: config is read-only/);
  });
});
