/**
 * The terms of use (TERMS.md / TERMS.de.md) the user accepts on first start, and the record of that.
 * A new TERMS_VERSION asks again; so does a record that cannot be read. Pure: storing the record is
 * termsStore.ts, the screen is components/TermsGate.tsx.
 */

/** Date of the current text. Raise it whenever TERMS.md changes in substance: everyone accepts again. */
export const TERMS_VERSION = "2026-11-12";

/** Key of the record in the flags every meerCAD on a Mac shares (shared.json) and in localStorage. */
export const TERMS_KEY = "termsAccepted";

/** The points the user ticks one by one (English; the screen translates them). */
export const TERMS_POINTS = [
  { id: "hobby", text: "meerCAD is a tool for hobby projects, not certified professional CAD." },
  { id: "accuracy", text: "There is no guarantee that dimensions, calculations or exports are correct." },
  { id: "check", text: "I check dimensions, fits and strength myself before I print or use a part." },
  {
    id: "safety",
    text: "I do not use it for safety-critical, load-bearing or medical parts without my own expert check.",
  },
  { id: "ai", text: "The AI assistant can make mistakes; I check what it builds." },
  { id: "risk", text: "I use meerCAD at my own risk and have read the terms of use and the EULA." },
] as const;

export type TermsPointId = (typeof TERMS_POINTS)[number]["id"];

export interface TermsRecord {
  /** TERMS_VERSION of the text accepted. */
  version: string;
  /** When, as an ISO date. */
  acceptedAt: string;
  /** The app's version then ("" where unknown, e.g. the web app). */
  appVersion: string;
  /** Interface language the text was shown in. */
  lang: string;
  /** The points ticked. */
  points: string[];
}

/** The record as stored, or null if it is missing or not a valid record. */
export function parseRecord(raw: unknown): TermsRecord | null {
  let v = raw;

  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }

  if (!v || typeof v !== "object" || Array.isArray(v)) return null;

  const r = v as Record<string, unknown>;
  if (typeof r["version"] !== "string" || !r["version"]) return null;
  if (typeof r["acceptedAt"] !== "string" || Number.isNaN(Date.parse(r["acceptedAt"]))) return null;
  if (typeof r["appVersion"] !== "string" || typeof r["lang"] !== "string") return null;
  if (!Array.isArray(r["points"]) || !r["points"].every((p) => typeof p === "string")) return null;

  return {
    version: r["version"],
    acceptedAt: r["acceptedAt"],
    appVersion: r["appVersion"],
    lang: r["lang"],
    points: [...(r["points"] as string[])],
  };
}

/** True unless `record` accepts this `version` with every point ticked. */
export function needsAcceptance(record: TermsRecord | null, version: string = TERMS_VERSION): boolean {
  if (!record || record.version !== version) return true;

  return !TERMS_POINTS.every((p) => record.points.includes(p.id));
}

/** The record for accepting the current text now. */
export function acceptRecord(appVersion: string, lang: string, now: Date = new Date()): TermsRecord {
  return {
    version: TERMS_VERSION,
    acceptedAt: now.toISOString(),
    appVersion,
    lang,
    points: TERMS_POINTS.map((p) => p.id),
  };
}

/** What an MCP call gets while the terms are not accepted. */
export const TERMS_MCP_ERROR =
  "The user must first accept the terms of use in meerCAD (Der Nutzer muss zuerst in meerCAD die Nutzungsvereinbarung akzeptieren). Ask them to open meerCAD and accept; then try again.";

/** True once the scroll box is read to the end (a text shorter than the box counts as read). */
export function scrolledToEnd(
  box: { scrollTop: number; scrollHeight: number; clientHeight: number },
  tolerance = 24,
): boolean {
  return box.scrollTop + box.clientHeight >= box.scrollHeight - tolerance;
}
