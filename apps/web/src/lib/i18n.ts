/**
 * The interface in English and German. Texts are written in English in the code and looked up by
 * that text in the German dictionary (./i18n/de); a text without a translation stays English.
 * Values go in placeholders so the sentence can be reordered: t("Moved {n} parts to {dir}", { n, dir }).
 * A text that needs different German in different places gets a context before "::", e.g.
 * t("feature::Draft") (Formschräge) and t("Draft") (Entwurf); English shows the part after it.
 *
 * The language is fixed when the app starts (from the setting, else the system language), so
 * module-level tables can call t() too; changing it in Settings reloads the app.
 *
 * Messages for the AI (MCP) and the kernel's error messages stay English.
 */
import { DE } from "./i18n/de";

export type Lang = "en" | "de";
export type LangChoice = Lang | "auto";

const KEY = "meercad.lang";

export function langChoice(): LangChoice {
  try {
    const v = localStorage.getItem(KEY);

    return v === "en" || v === "de" ? v : "auto";
  } catch {
    return "auto";
  }
}

function resolve(): Lang {
  const c = langChoice();
  if (c !== "auto") return c;

  const sys =
    typeof navigator !== "undefined" ? (navigator.languages?.[0] ?? navigator.language ?? "en") : "en";

  return sys.toLowerCase().startsWith("de") ? "de" : "en";
}

/** The interface language for this run. */
export const lang: Lang = resolve();
if (typeof document !== "undefined") document.documentElement.lang = lang;

// The Mac app names its menu bar in the same language (older desktop builds lack the call).
if (typeof window !== "undefined") {
  (window as { meercadDesktop?: { setLanguage?: (l: Lang) => void } }).meercadDesktop?.setLanguage?.(lang);
}

/** Saves the choice and restarts the interface in it. */
export function setLang(choice: LangChoice): void {
  try {
    if (choice === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Without storage the choice only lasts until the reload.
  }

  location.reload();
}

const fill = (s: string, vars?: Readonly<Record<string, string | number>>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;

/** The text in the interface language. */
export function t(s: string, vars?: Readonly<Record<string, string | number>>): string {
  const de = lang === "de" ? DE[s] : undefined;
  const ctx = s.indexOf("::");

  return fill(de ?? (ctx >= 0 ? s.slice(ctx + 2) : s), vars);
}

/** One or many: tn(n, "{n} part", "{n} parts"); `n` is filled in. */
export function tn(
  n: number,
  one: string,
  other: string,
  vars?: Readonly<Record<string, string | number>>,
): string {
  return t(n === 1 ? one : other, { n, ...vars });
}
