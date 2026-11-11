/**
 * About meerCAD: version, licence, the no-warranty notice, the privacy policy and every third-party
 * licence, all shipped inside the app (the iPad has no files next to the app to point at).
 */
import { FileText, Info, Scale, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import privacy from "../../../../PRIVACY.md?raw";
import notices from "../../../../THIRD_PARTY_NOTICES.md?raw";
import lgpl from "../../../../licenses/LGPL-2.1.txt?raw";
import licenceTexts from "../../../../licenses/THIRD_PARTY_LICENSES.txt?raw";
import { desktop } from "../lib/persistence";
import { t } from "../lib/i18n";

type Tab = "about" | "privacy" | "licenses";

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
                  "meerCAD is a design tool, provided free of charge and as is, without warranty. All results (dimensions, masses, fits, overhangs, checks and any analysis) are estimates and can be wrong. Check every part yourself before you make or use it. Do not use meerCAD as the basis for anything whose failure could hurt people or cause serious damage, such as aircraft, vehicles, lifting gear, load-bearing structures, pressure vessels or medical devices, unless qualified professionals verify the design independently. As far as the law allows, we are not liable for parts or products designed or made with meerCAD; see the licence agreement at meercad.app/eula.",
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

/** Just enough Markdown for our own notices: headings, paragraphs, lists, tables, `code`, **bold**, _italic_, links. */
function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      out.push(h[1]!.length === 1 ? <h3 key={i}>{inline(h[2]!)}</h3> : <h4 key={i}>{inline(h[2]!)}</h4>);
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.startsWith("|"); i++) {
        const cells = lines[i]!.split("|").slice(1, -1).map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
      }
      i--;
      out.push(
        <table key={i}>
          <tbody>
            {rows.map((r, k) => (
              <tr key={k}>{r.map((c, j) => (k === 0 ? <th key={j}>{inline(c)}</th> : <td key={j}>{inline(c)}</td>))}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (/^\s*- /.test(line)) {
      const items: string[] = [];
      for (; i < lines.length && (/^\s*- /.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length)); i++) {
        if (/^\s*- /.test(lines[i]!)) items.push(lines[i]!.replace(/^\s*- /, ""));
        else items[items.length - 1] += ` ${lines[i]!.trim()}`;
      }
      i--;
      out.push(
        <ul key={i}>
          {items.map((t, k) => (
            <li key={k}>{inline(t)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    // A paragraph runs to the next blank line; lines join with a space, or break after two trailing spaces.
    const para: string[] = [];
    for (; i < lines.length && lines[i]!.trim() && !/^(#|\||\s*- )/.test(lines[i]!); i++) para.push(lines[i]!);
    i--;
    out.push(<p key={i}>{para.flatMap((t, k) => [...(k ? [/ {2}$/.test(para[k - 1]!) ? <br key={`b${k}`} /> : " "] : []), ...inline(t.trim())])}</p>);
  }
  return <>{out}</>;
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|_[^_]+_|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s)]+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${m.index}`;
    if (t.startsWith("`")) parts.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) parts.push(<b key={k}>{t.slice(2, -2)}</b>);
    else if (t.startsWith("_")) parts.push(<em key={k}>{t.slice(1, -1)}</em>);
    else if (t.startsWith("[")) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      parts.push(
        <a key={k} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    } else
      parts.push(
        <a key={k} href={t} target="_blank" rel="noreferrer">
          {t}
        </a>,
      );
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
