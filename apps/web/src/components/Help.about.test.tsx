/**
 * The help's licence guide (Help.tsx): its links open About on the licences, the privacy policy, the
 * warranty (About itself) and the terms; a guide opened twice closes again.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, describe, expect, it } from "vitest";
import { HelpPanel } from "./Help";

afterAll(cleanup);

describe("the help's licence guide", () => {
  it("opens About on each tab, and closes again", async () => {
    const asked: (string | undefined)[] = [];
    const on = (e: Event) => asked.push((e as CustomEvent<string | undefined>).detail ?? undefined);
    window.addEventListener("meercad:about", on);
    render(<HelpPanel onClose={() => undefined} onTour={() => undefined} onShortcuts={() => undefined} />);
    const head = screen.getByText("Licenses").closest("button")!;
    await act(async () => void fireEvent.click(head));
    for (const link of ["All licences", "Privacy policy", "No warranty", "Terms of use"]) await act(async () => void fireEvent.click(screen.getByText(link)));
    expect(asked).toEqual(["licenses", "privacy", undefined, "terms"]);
    await act(async () => void fireEvent.click(head));
    expect(screen.queryByText("All licences")).toBeNull();
    window.removeEventListener("meercad:about", on);
  });
});
