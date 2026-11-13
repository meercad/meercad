/** Our own notices (privacy policy, terms of use, licences) rendered from their Markdown files. */
import type { ReactNode } from "react";

/**
 * Just enough Markdown for our own notices: headings, paragraphs, lists, tables, `code`, **bold**, _italic_,
 * links.
 */
export function Markdown({ text }: { text: string }) {
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
        const cells = lines[i]!.split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        if (!cells.every((c) => /^-+$/.test(c))) rows.push(cells);
      }

      i--;
      out.push(
        <table key={i}>
          <tbody>
            {rows.map((r, k) => (
              <tr key={k}>
                {r.map((c, j) => (k === 0 ? <th key={j}>{inline(c)}</th> : <td key={j}>{inline(c)}</td>))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    if (/^\s*- /.test(line)) {
      const items: string[] = [];

      for (
        ;
        i < lines.length && (/^\s*- /.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length));
        i++
      ) {
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

    for (; i < lines.length && lines[i]!.trim() && !/^(#|\||\s*- )/.test(lines[i]!); i++) {
      para.push(lines[i]!);
    }

    i--;
    out.push(
      <p key={i}>
        {para.flatMap((t, k) => [
          ...(k ? [/ {2}$/.test(para[k - 1]!) ? <br key={`b${k}`} /> : " "] : []),
          ...inline(t.trim()),
        ])}
      </p>,
    );
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

    if (t.startsWith("`")) {
      parts.push(<code key={k}>{t.slice(1, -1)}</code>);
    } else if (t.startsWith("**")) {
      parts.push(<b key={k}>{t.slice(2, -2)}</b>);
    } else if (t.startsWith("_")) {
      parts.push(<em key={k}>{t.slice(1, -1)}</em>);
    } else if (t.startsWith("[")) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      parts.push(
        <a key={k} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    } else {
      parts.push(
        <a key={k} href={t} target="_blank" rel="noreferrer">
          {t}
        </a>,
      );
    }

    last = m.index + t.length;
  }

  if (last < text.length) parts.push(text.slice(last));

  return parts;
}
