/**
 * About meerCAD: version, licence, the no-warranty notice, the privacy policy and every third-party
 * licence, all shipped inside the app (the iPad has no files next to the app to point at).
 */
import { FileText, Info, Scale, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import privacy from "../../../../PRIVACY.md?raw";
import notices from "../../../../THIRD_PARTY_NOTICES.md?raw";
import lgpl from "../../../../licenses/LGPL-2.1.txt?raw";
import license from "../../../../LICENSE?raw";
import { desktop } from "../lib/persistence";

const SOURCE = "https://github.com/torbenberger/meercad";
type Tab = "about" | "privacy" | "licenses";

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
    ["about", "About", <Info key="i" />],
    ["privacy", "Privacy", <ShieldCheck key="p" />],
    ["licenses", "Licences", <Scale key="l" />],
  ];
  return (
    <div className="modal-backdrop" onPointerDown={() => setTab(null)}>
      <div className="modal settings about" role="dialog" aria-label="About meerCAD" onPointerDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <h2>meerCAD{version ? <span className="muted"> {version}</span> : null}</h2>
          <button className="icon-btn" onClick={() => setTab(null)} title="Close (Esc)">
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
              <p>Free parametric CAD for makers: sketch, extrude, fillet and print. Everything runs on your device.</p>
              <p className="muted">© 2026 Torben Berger. meerCAD is free to use, also commercially. Its source is public under the Functional Source License 1.1: anything goes except building a competing product from it, and each release becomes Apache-2.0 two years after it ships.</p>
              <p>
                <a href={SOURCE} target="_blank" rel="noreferrer">
                  Source code on GitHub
                </a>
              </p>
            </section>
            <section>
              <h3>
                <FileText /> No warranty
              </h3>
              <p className="muted">
                meerCAD is provided as is, without warranty of any kind. Check dimensions, fits and strength before you print, mill or use a part, especially where it carries loads or matters for safety. The authors are not liable for damage arising from designs made with meerCAD or from parts made from them, as far as the law allows.
              </p>
            </section>
            <section>
              <h3>
                <ShieldCheck /> Privacy
              </h3>
              <p className="muted">
                meerCAD collects no personal data: no account, no analytics, no tracking. Your designs stay on your device.{" "}
                <button className="link" onClick={() => setTab("privacy")}>
                  Read the privacy policy
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
              <summary>Open CASCADE and PlaneGCS: GNU Lesser General Public License 2.1</summary>
              <p className="muted">
                On the iPad the WebAssembly modules are part of the signed app and cannot be swapped there. The full source of meerCAD is public, so you can build the app yourself with your own build of either library.
              </p>
              <pre className="licence-text">{lgpl}</pre>
            </details>
            <details>
              <summary>meerCAD: Functional Source License 1.1</summary>
              <pre className="licence-text">{license}</pre>
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
