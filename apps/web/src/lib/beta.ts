/**
 * Beta functions: unfinished functions that only test builds can switch on (the WIP and RC Mac
 * apps, TestFlight and Xcode installs, development builds). Each one is off until switched on in
 * Settings → Beta. An App Store download never shows the section, and with a function off the app
 * looks and works exactly as without it.
 */
import { create } from "zustand";
import { registerPlugin } from "@capacitor/core";
import { desktop } from "./persistence";
import { nativeApp } from "./native";

export type BetaId = "topology";

export interface BetaFeature {
  id: BetaId;
  /** English; Settings translates it with t(). */
  name: string;
  about: string;
}

export const BETA_FEATURES: BetaFeature[] = [
  {
    id: "topology",
    name: "Topology optimisation",
    about:
      "Generates a lighter part that keeps material only along the load paths. A suggestion, not a verified part.",
  },
];

const STORAGE_KEY = "meercad.beta";

interface BetaState {
  /** A test build: the Beta section is shown and its switches count. */
  available: boolean;
  /** The switched-on functions; a missing one is off. */
  on: Partial<Record<BetaId, true>>;
}

function loadOn(): BetaState["on"] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;

    return Object.fromEntries(BETA_FEATURES.filter((f) => raw[f.id] === true).map((f) => [f.id, true]));
  } catch {
    return {};
  }
}

export const useBeta = create<BetaState>(() => ({ available: false, on: loadOn() }));

/** Whether a beta function is on (only ever in a test build). */
export function hasBeta(id: BetaId): boolean {
  const s = useBeta.getState();

  return s.available && !!s.on[id];
}

/** Re-renders when the function is switched. */
export function useHasBeta(id: BetaId): boolean {
  return useBeta((s) => s.available && !!s.on[id]);
}

export function setBeta(id: BetaId, on: boolean): void {
  const next = { ...useBeta.getState().on };

  if (on) next[id] = true;
  else delete next[id];

  useBeta.setState({ on: next });

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(Object.keys(next).map((k) => [k, true]))),
    );
  } catch {
    // the switch just won't persist
  }
}

const Store = registerPlugin<{ environment(): Promise<{ environment: "sandbox" | "production" }> }>("Store");

/** Whether this is a test build: asks the Mac or iOS shell once at start. */
export async function detectBetaBuild(): Promise<void> {
  let available = import.meta.env.DEV;

  try {
    if (desktop) {
      const info = await desktop.info();

      available ||= info.channel === "wip" || info.channel === "rc" || info.store === "sandbox";
    } else if (nativeApp) {
      available ||= (await Store.environment()).environment === "sandbox";
    }
  } catch {
    // an older shell without the answer: no beta
  }

  useBeta.setState({ available });
}
