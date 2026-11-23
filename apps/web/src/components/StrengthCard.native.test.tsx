/**
 * The strength card on iPhone and iPad (StrengthCard.tsx): the fine level of the topology is not
 * offered there, as the app gets one core only.
 */
import { act, cleanup, screen } from "@testing-library/react";
import { afterAll, expect, it, vi } from "vitest";

vi.mock("../lib/native", async (original) => ({ ...(await original<object>()), nativeApp: true }));

import { closeStrength, openStrength } from "../lib/strength";
import { renderUi } from "../../test/ui";
import { StrengthCard } from "./StrengthCard";

afterAll(() => {
  closeStrength();
  cleanup();
});

it("offers no fine level", async () => {
  renderUi(<StrengthCard />);
  await act(async () => openStrength("pr1"));
  expect(screen.getByLabelText("Share of material to keep, per cent")).toBeTruthy();
  expect(screen.queryByLabelText("Detail of the topology")).toBeNull();
});
