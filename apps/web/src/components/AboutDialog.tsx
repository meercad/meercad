/**
 * About meerCAD: version, licence, the no-warranty notice, the privacy policy and every third-party
 * licence, all shipped inside the app (the iPad has no files next to the app to point at).
 */
import { FileCheck, FileText, Info, Scale, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import privacy from "../../../../PRIVACY.md?raw";
import notices from "../../../../THIRD_PARTY_NOTICES.md?raw";
import lgpl from "../../../../licenses/LGPL-2.1.txt?raw";
import licenceTexts from "../../../../licenses/THIRD_PARTY_LICENSES.txt?raw";
import { desktop } from "../lib/persistence";
import { lang, t } from "../lib/i18n";
import { termsRecord } from "../lib/termsStore";
import { Markdown } from "./Markdown";
import { termsText } from "./TermsGate";

type Tab = "about" | "terms" | "privacy" | "licenses";

const SOURCE = "https://github.com/meercad/meercad";

export function AboutDialog() {
  const [tab, setTab] = useState<Tab | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    const open = (e: Event) => setTab(((e as CustomEvent<Tab | undefined>).detail ?? "about") as Tab);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setTab(null);
    window.addEventListener("meercad:about", open);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("meercad:about", open);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => {
    if (!tab || version) return;
    if (desktop) void desktop.info().then((i) => setVersion(i.version));
    else
      void import("../lib/native").then(async ({ nativeApp, appVersion }) => {
        if (nativeApp) setVersion(await appVersion());
      });
  }, [tab, version]);

  if (!tab) return null;
  const tabs: [Tab, string, ReactNode][] = [
    ["about", t("about::About"), <Info key="i" />],
    ["terms", t("tab::Terms"), <FileCheck key="t" />],
    ["privacy", t("Privacy"), <ShieldCheck key="p" />],
    ["licenses", t("Licences"), <Scale key="l" />],
  ];
  return (
    <div className="modal-backdrop" onPointerDown={() => setTab(null)}>
      <div className="modal settings about" role="dialog" aria-label={t("About meerCAD")} onPointerDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>meerCAD{version ? <span className="muted"> {version}</span> : null}</h2>
          <button className="icon-btn" onClick={() => setTab(null)} title={t("Close (Esc)")}>
            <X />
          </button>
        </header>
        <nav className="about-tabs">
          {tabs.map(([id, label, icon]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {icon} {label}
            </button>
          ))}
        </nav>

        {tab === "about" ? (
          <>
            <section>
              <p>{t("Parametric CAD for makers: sketch, extrude, fillet and print. Everything runs on your device.")}</p>
              <p className="muted">
                {t("© 2026 Torben Berger UG (haftungsbeschränkt). The source code is public under the FSL-1.1-ALv2:")}{" "}
                <a href={SOURCE} target="_blank" rel="noreferrer">
                  {SOURCE.replace("https://", "")}
                </a>
              </p>
            </section>
            <section>
              <h3>
                <FileText /> {t("No warranty")}
              </h3>
              <p className="muted">
                {t(
                  "meerCAD is provided as is, without warranty of any kind. Check dimensions, fits and strength before you print, mill or use a part, especially where it carries loads or matters for safety. The authors are not liable for damage arising from designs made with meerCAD or from parts made from them, as far as the law allows.",
                )}
              </p>
            </section>
            <section>
              <h3>
                <ShieldCheck /> {t("Privacy")}
              </h3>
              <p className="muted">
                {t("meerCAD collects no personal data: no account, no analytics, no tracking. Your designs stay on your device.")}{" "}
                <button className="link" onClick={() => setTab("privacy")}>
                  {t("Read the privacy policy")}
                </button>
              </p>
            </section>
          </>
        ) : tab === "terms" ? (
          <section className="doc">
            <TermsAccepted />
            <Markdown text={termsText()} />
          </section>
        ) : tab === "privacy" ? (
          <section className="doc">
            <Markdown text={privacy} />
          </section>
        ) : (
          <section className="doc">
            <Markdown text={notices} />
            <details>
              <summary>{t("Open CASCADE and PlaneGCS: GNU Lesser General Public License 2.1")}</summary>
              <p className="muted">
                {t(
                  "Both libraries are used unmodified; their source is linked above. The App Store apps are signed, so the WebAssembly modules cannot be swapped inside them. To use a modified version, build meerCAD yourself from its public source.",
                )}
              </p>
              <pre className="licence-text">{lgpl}</pre>
            </details>
            <details>
              <summary>{t("Licence texts of all components")}</summary>
              <pre className="licence-text">{licenceTexts}</pre>
            </details>
          </section>
        )}
      </div>
    </div>
  );
}

/** When the user accepted the terms on this device, above the text. */
function TermsAccepted() {
  const r = termsRecord();
  if (!r) return null;
  const at = new Date(r.acceptedAt).toLocaleString(lang === "de" ? "de-DE" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
  return <p className="terms-accepted">{t("Accepted on {date} (version {version}, app {app})", { date: at, version: r.version, app: r.appVersion || "–" })}</p>;
}
