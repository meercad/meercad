/**
 * First start (and after the terms change): the terms of use over everything, until the user has
 * read them to the end, ticked every point and accepted. It cannot be closed otherwise; there is no
 * button that quits the app (the App Store does not want one), only a note that meerCAD needs it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import termsEn from "../../../../TERMS.md?raw";
import termsDe from "../../../../TERMS.de.md?raw";
import { lang, t } from "../lib/i18n";
import { desktop } from "../lib/persistence";
import { acceptRecord, scrolledToEnd, TERMS_POINTS } from "../lib/terms";
import { saveTerms } from "../lib/termsStore";
import { Markdown } from "./Markdown";
import { Logo } from "./TopBar";

/** The terms in the interface language. */
export const termsText = () => (lang === "de" ? termsDe : termsEn);

async function appVersion(): Promise<string> {
  try {
    if (desktop) return (await desktop.info()).version;

    const { nativeApp, appVersion } = await import("../lib/native");

    return nativeApp ? await appVersion() : "";
  } catch {
    return "";
  }
}

export function TermsGate({ onAccept }: { onAccept: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [read, setRead] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const all = TERMS_POINTS.every((p) => ticked.has(p.id));

  // Read to the end: scrolled down, or the text fits the box as it is (also after the window grows).
  const check = () => {
    if (box.current && scrolledToEnd(box.current)) setRead(true);
  };

  useLayoutEffect(() => {
    check();

    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(check);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  // Keys stay in this screen: nothing behind it reacts, Escape does nothing, Tab cannot leave it.
  useEffect(() => {
    const element = root.current!;
    box.current?.focus();

    const outside = (event: KeyboardEvent) => {
      if (event.target instanceof Node && element.contains(event.target)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "keydown" && event.key === "Tab") box.current?.focus();
    };

    const inside = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === "Escape") event.preventDefault();
      if (event.key !== "Tab") return;

      const items = [
        ...element.querySelectorAll<HTMLElement>(
          "[tabindex='0'], input:not(:disabled), button:not(:disabled)",
        ),
      ];
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) (event.preventDefault(), last?.focus());
      else if (!event.shiftKey && document.activeElement === last) (event.preventDefault(), first?.focus());
    };

    for (const type of ["keydown", "keyup"] as const) window.addEventListener(type, outside, true);
    element.addEventListener("keydown", inside);
    element.addEventListener("keyup", inside);

    return () => {
      for (const type of ["keydown", "keyup"] as const) window.removeEventListener(type, outside, true);
      element.removeEventListener("keydown", inside);
      element.removeEventListener("keyup", inside);
    };
  }, []);

  const toggle = (id: string) =>
    setTicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);

      return next;
    });

  const accept = async () => {
    if (!read || !all) return;

    saveTerms(acceptRecord(await appVersion(), lang));
    onAccept();
  };

  return (
    <div className="modal-backdrop first-run terms-gate" ref={root}>
      <div
        className="ask terms-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terms-title"
        aria-describedby="terms-note"
      >
        <header className="terms-head">
          <Logo />
          <h3 id="terms-title">{t("Terms of use")}</h3>
        </header>
        <div
          className="doc terms-text"
          ref={box}
          onScroll={check}
          tabIndex={0}
          aria-label={t("Text of the terms of use")}
        >
          <Markdown text={termsText()} />
        </div>
        <p className={`terms-hint ${read ? "done" : ""}`} aria-live="polite">
          {read
            ? t("Thanks for reading. Please confirm each point:")
            : t("Please read to the end — the boxes below unlock then.")}
        </p>
        <ul className="terms-points">
          {TERMS_POINTS.map((p) => (
            <li key={p.id}>
              <label className={`checkbox ${read ? "" : "disabled"}`}>
                <input
                  type="checkbox"
                  checked={ticked.has(p.id)}
                  disabled={!read}
                  onChange={() => toggle(p.id)}
                />
                <span>{t(p.text)}</span>
              </label>
            </li>
          ))}
        </ul>
        <p className="terms-note muted" id="terms-note">
          {t("meerCAD can only be used once you accept.")}
        </p>
        <div className="ask-actions">
          <button className="btn primary terms-accept" disabled={!read || !all} onClick={() => void accept()}>
            {t("Accept and get started")}
          </button>
        </div>
      </div>
    </div>
  );
}
