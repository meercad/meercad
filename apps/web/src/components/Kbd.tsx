import type { ReactNode } from "react";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Renders a shortcut like "⇧R" or "Mod+Z" in the platform's notation. */
export function Kbd({ k, className }: { k: string; className?: string }) {
  const text = kbdText(k);
  return <kbd className={`kbd ${className ?? ""}`}>{text}</kbd>;
}

/** A shortcut in the platform's notation, as plain text (for tooltips). */
export const kbdText = (k: string): string => k.replace("Mod+", MAC ? "⌘" : "Ctrl+").replace("Shift+", "⇧").replace("Alt+", MAC ? "⌥" : "Alt+");

/** "Label (key)" for a tooltip, or just the label when the preset has no key for it. */
export const withKey = (label: string, k: string | undefined): string => (k ? `${label} (${kbdText(k)})` : label);

/** A translated text with light markup: **bold**, `mono` and [Key] for a key badge. */
export function rich(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\])/).map((p, i) => {
    if (i % 2 === 0) return p;
    if (p.startsWith("**")) return <b key={i}>{p.slice(2, -2)}</b>;
    if (p.startsWith("`")) return <span key={i} className="mono">{p.slice(1, -1)}</span>;
    return <Kbd key={i} k={p.slice(1, -1)} />;
  });
}
