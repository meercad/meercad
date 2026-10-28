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
