/**
 * The section view's state: the plane cutting the parts open for viewing (null: off) and whether the
 * next tap on a flat face lays the plane on it. Only the view: the model never changes.
 */
import { faceSection, flipSection, type Pick, type Section, type SectionAxis } from "@meercad/viewport";
import { create } from "zustand";
import { t } from "./i18n";
import { actionFor, COMMON_ACTIONS } from "./keymap";
import { faceNormal } from "./printability";
import { toast } from "../store";

export interface ViewSectionState {
  section: Section | null;
  /** The axis the plane stands square to, "face" when it was laid on a face. */
  axis: SectionAxis | "face";
  /** Where a plane laid on a face started (the face), to tell how deep it cuts. */
  start: number;
  /** Turned round since it was laid (keeps the other side). */
  flipped: boolean;
  picking: boolean;
}

export const useViewSection = create<ViewSectionState>(() => ({
  section: null,
  axis: "y",
  start: 0,
  flipped: false,
  picking: false,
}));

/** Something that can find a section facing the viewer (the viewport). */
interface Facing {
  facingSection(axis?: SectionAxis): Section | null;
}

/** Switches the section view on (square to the axis the view looks most along) or off. */
export function toggleSection(viewport: Facing | null): void {
  if (useViewSection.getState().section) return closeSection();

  const section = viewport?.facingSection() ?? null;
  if (!section) return toast(t("There is nothing to cut yet."), "error");

  const i = section.normal.findIndex((c) => Math.abs(c) > 0.5);
  useViewSection.setState({ section, axis: (["x", "y", "z"] as const)[i]!, flipped: false, picking: false });
}

export function closeSection(): void {
  useViewSection.setState({ section: null, picking: false });
}

/** The plane square to `axis` through the middle, cutting the half toward the viewer. */
export function sectionOnAxis(viewport: Facing, axis: SectionAxis): void {
  const section = viewport.facingSection(axis);
  if (section) useViewSection.setState({ section, axis, flipped: false, picking: false });
}

export function flipViewSection(): void {
  const { section, flipped } = useViewSection.getState();
  if (section) useViewSection.setState({ section: flipSection(section), flipped: !flipped });
}

export function moveViewSection(offset: number): void {
  const { section } = useViewSection.getState();
  if (section) useViewSection.setState({ section: { normal: section.normal, offset } });
}

/** The next face tapped or clicked takes the plane (Esc or a tap on nothing ends it). */
export function pickSectionFace(on = true): void {
  useViewSection.setState({ picking: on });
  if (!on) return;

  const keys = (event: KeyboardEvent) => {
    if (actionFor(event, COMMON_ACTIONS) === "cancel") useViewSection.setState({ picking: false });
  };

  window.addEventListener("keydown", keys, true);

  const stop = useViewSection.subscribe((s) => {
    if (s.picking) return;

    window.removeEventListener("keydown", keys, true);
    stop();
  });
}

/** Lays the plane on the face picked (only a flat face has one plane). */
export function sectionOnPick(pick: Pick | null): void {
  if (pick?.kind !== "face") return pickSectionFace(false);

  const normal = pick.normal ?? faceNormal(pick.bodyId, pick.face);
  if (!normal) return toast(t("Only a flat face can take the section plane."), "error");

  const section = faceSection(pick.point, normal);
  useViewSection.setState({ section, axis: "face", start: section.offset, flipped: false, picking: false });
}
