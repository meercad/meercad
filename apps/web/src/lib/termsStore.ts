/**
 * Where the terms record (terms.ts) is kept: like the tour, in the flags every meerCAD on a Mac
 * shares (so the release, the WIP build and test copies ask once), elsewhere in this app's
 * localStorage. Only on the device; nothing is sent anywhere.
 */
import { desktop } from "./persistence";
import { needsAcceptance, parseRecord, TERMS_KEY, TERMS_MCP_ERROR, type TermsRecord } from "./terms";

const LOCAL_KEY = `meercad.${TERMS_KEY}`;

/** Accepted in this window since it started (shared.json is only read at start). */
let accepted: TermsRecord | null = null;

function local(): TermsRecord | null {
  try {
    return parseRecord(localStorage.getItem(LOCAL_KEY));
  } catch {
    return null;
  }
}

/** The record for the current text, if it is accepted; null otherwise. */
export function termsRecord(): TermsRecord | null {
  for (const r of [accepted, parseRecord(desktop?.shared?.initial[TERMS_KEY]), local()]) {
    if (r && !needsAcceptance(r)) return r;
  }

  return null;
}

export const termsAccepted = (): boolean => termsRecord() !== null;

/** Every assistant request (mcpBridge) first: refused with TERMS_MCP_ERROR until the terms are accepted. */
export function requireTerms(): void {
  if (!termsAccepted()) throw new Error(TERMS_MCP_ERROR);
}

/** Keeps the record and tells the other meerCAD copies on this Mac. */
export function saveTerms(record: TermsRecord): void {
  accepted = record;
  void desktop?.shared?.set(TERMS_KEY, record).catch(() => undefined);

  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(record));
  } catch {
    // On the Mac shared.json keeps it; elsewhere the screen shows again next start.
  }

  window.dispatchEvent(new Event("meercad:terms-accepted"));
}
