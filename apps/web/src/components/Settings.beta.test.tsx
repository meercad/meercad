/**
 * Settings → Beta (Settings.tsx): the section is missing in an App Store build, shown in a test
 * build, and its switch turns the function on and off.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { hasBeta, useBeta } from "../lib/beta";
import { renderUi } from "../../test/ui";
import { Settings } from "./Settings";

async function openSettings() {
  renderUi(<Settings onShortcuts={() => undefined} />);
  await act(async () => void fireEvent.keyDown(window, { key: ",", metaKey: true }));
}

afterEach(() => {
  cleanup();
  useBeta.setState({ available: false, on: {} });
});

describe("beta section", () => {
  it("is not there in an App Store build", async () => {
    await openSettings();
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("switches topology optimisation on and off in a test build", async () => {
    useBeta.setState({ available: true });
    await openSettings();

    const box = screen.getByLabelText(/Topology optimisation/) as HTMLInputElement;

    expect(box.checked).toBe(false);
    await act(async () => void fireEvent.click(box));
    expect(hasBeta("topology")).toBe(true);
    await act(async () => void fireEvent.click(box));
    expect(hasBeta("topology")).toBe(false);
  });
});
