/**
 * Rendering the app's components in tests: with the hosts for menus and in-app dialogs, and helpers
 * to pick a menu entry and answer a dialog the way a person would.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { AskHost } from "../src/components/Ask";
import { MenuHost } from "../src/components/Menu";
import { rebuildNow } from "../src/store";

/** Renders `ui` with the menu and dialog hosts next to it. */
export function renderUi(ui: ReactElement) {
  return render(
    <>
      {ui}
      <MenuHost />
      <AskHost />
    </>,
  );
}

/** Rebuilds the design and lets React show the result. */
export async function rebuilt(): Promise<void> {
  await act(async () => void (await rebuildNow()));
}

/** Clicks the entry of the open menu whose text starts with `label`. */
export async function pickMenu(label: string | RegExp): Promise<void> {
  const item = await waitFor(() => {
    const found = screen.getAllByRole("menuitem").find((el) => (typeof label === "string" ? el.textContent?.startsWith(label) : label.test(el.textContent ?? "")));
    if (!found) throw new Error(`no menu entry ${String(label)}: ${screen.getAllByRole("menuitem").map((e) => e.textContent).join(" | ")}`);
    return found;
  });
  await act(async () => void fireEvent.click(item));
}

/** Answers the open in-app dialog: with text typed into its field, or just confirms (`null` cancels). */
export async function answer(text?: string | null): Promise<void> {
  const dialog = await waitFor(() => screen.getByRole("alertdialog"));
  if (text === null) {
    await act(async () => void fireEvent.keyDown(dialog, { key: "Escape" }));
    return;
  }
  const input = dialog.querySelector("input");
  if (text !== undefined && input) fireEvent.change(input, { target: { value: text } });
  await act(async () => void fireEvent.keyDown(dialog, { key: "Enter" }));
}

/** Opens the context menu of an element. */
export async function contextMenu(el: Element): Promise<void> {
  await act(async () => void fireEvent.contextMenu(el, { clientX: 10, clientY: 10 }));
}
