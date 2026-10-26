const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Renders a shortcut like "⇧R" or "Mod+Z" in the platform's notation. */
export function Kbd({ k, className }: { k: string; className?: string }) {
  const text = k.replace("Mod+", MAC ? "⌘" : "Ctrl+").replace("Shift+", "⇧").replace("Alt+", MAC ? "⌥" : "Alt+");
  return <kbd className={`kbd ${className ?? ""}`}>{text}</kbd>;
}
