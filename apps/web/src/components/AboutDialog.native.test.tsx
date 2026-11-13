/**
 * About meerCAD on the iPhone and iPad (AboutDialog.tsx): the version comes from the app; the link to
 * the privacy policy opens that tab; the terms tab says when they were accepted; the close button and
 * a press beside the dialog close it.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/native", async (orig) => ({ ...(await orig<typeof import("../lib/native")>()), nativeApp: true, appVersion: async () => "2.4.1 (77)" }));
vi.mock("../lib/persistence", async (orig) => ({ ...(await orig<typeof import("../lib/persistence")>()), desktop: undefined }));

import { renderUi } from "../../test/ui";
import { acceptRecord } from "../lib/terms";
import { saveTerms } from "../lib/termsStore";
import { AboutDialog } from "./AboutDialog";
const openAbout = () => void window.dispatchEvent(new CustomEvent("meercad:about"));

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
beforeAll(async () => {
  saveTerms(acceptRecord("2.4.1", "en"));
  renderUi(<AboutDialog />);
  await act(async () => openAbout());
  await settle();
});
afterAll(cleanup);

describe("About meerCAD on the iPad", () => {
  it("shows the app's version, opens the privacy policy and the accepted terms, and closes", async () => {
    expect(screen.getByRole("heading", { level: 2 }).textContent).toContain("2.4.1 (77)");
    await act(async () => void fireEvent.click(screen.getByText("Read the privacy policy")));
    expect(document.querySelector(".about-tabs .on, .about-tabs [aria-selected=true]")?.textContent).toMatch(/Privacy/);
    await act(async () => void fireEvent.click(screen.getByText("Terms")));
    expect(screen.getByText(/Accepted on .* \(version .*, app 2\.4\.1\)/)).toBeTruthy();
    await act(async () => void fireEvent.pointerDown(screen.getByRole("dialog")));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await act(async () => void fireEvent.click(screen.getByTitle("Close (Esc)")));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => openAbout());
    await act(async () => void fireEvent.pointerDown(document.querySelector(".modal-backdrop")!));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
