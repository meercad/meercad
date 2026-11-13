/**
 * Designs that use packs not on here (packNotice.ts): two packs are named together; the note comes
 * once per design and session; a gear cannot be changed without the mechanics pack and says why, a
 * plain extrude can.
 */
import { cleanup, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import { premiumReady, usePremium } from "./premium";
import { notePacks, packNote, refuseLocked } from "./packNotice";
import { answer, renderUi } from "../../test/ui";

const doc = { ...emptyDocument(), features: [{ id: "g1", op: "gear", teeth: 20, module: 1 }], variants: [{ name: "Big", params: {} }] } as unknown as MeercadDocument;

beforeAll(async () => {
  await premiumReady;
  usePremium.setState({ tester: true, off: { mechanics: true, versions: true } });
  renderUi(<div />);
});
afterAll(() => {
  usePremium.setState({ off: {} });
  cleanup();
});

describe("designs with packs not on here", () => {
  it("names two packs together", () => {
    expect(packNote(doc)!.title).toBe("This design uses the packs Mechanics and robotics, Versions and variants");
  });

  it("tells once per design", async () => {
    const first = notePacks("pn1", doc);
    await screen.findByRole("alertdialog");
    await answer();
    await first;
    // Twice at once and again later: no second note.
    await Promise.all([notePacks("pn1", doc), notePacks("pn1", doc)]);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("refuses to change a gear without the mechanics pack, not an extrude", async () => {
    expect(refuseLocked({ op: "extrude" }, "Extrude 1")).toBe(false);
    expect(refuseLocked({ op: "gear" }, "Gear 1")).toBe(true);
    const note = await screen.findByRole("alertdialog");
    expect(note.textContent).toMatch(/Gear 1 needs the Mechanics and robotics pack/);
    await answer();
  });
});
