/**
 * Shortcut hints only help with a keyboard. On a touch screen they stay hidden (`html.no-keyboard`)
 * until a hardware keyboard shows up: a key pressed outside a text field, a modifier or navigation
 * key, or a mouse or trackpad (which on an iPad comes with a keyboard case). Remembered per device.
 */
const KEY = "meercad.keyboard";
const NAV_KEYS = new Set(["Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export function installKeyboardDetection(): void {
  const root = document.documentElement;
  const coarse = matchMedia("(pointer: coarse)");
  const fine = matchMedia("(any-pointer: fine)");
  let seen = false;

  try {
    seen = localStorage.getItem(KEY) === "1";
  } catch {
    // Storage blocked: detect again on every visit.
  }

  const apply = () => root.classList.toggle("no-keyboard", coarse.matches && !fine.matches && !seen);

  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    const typing =
      !!t &&
      (t.isContentEditable ||
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t instanceof HTMLSelectElement);
    // The on-screen keyboard only types into fields and has no ⌘, ⌃, ⌥, Esc, Tab or arrows.
    if (typing && !e.metaKey && !e.ctrlKey && !e.altKey && !NAV_KEYS.has(e.key)) return;

    seen = true;

    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // Not remembered; the next key press shows the hints again.
    }

    apply();
    window.removeEventListener("keydown", onKey, true);
  };

  if (!seen) window.addEventListener("keydown", onKey, true);

  coarse.addEventListener("change", apply);
  fine.addEventListener("change", apply);
  apply();
}

/** True on a touch screen without a keyboard (the iPad on its own): hints then speak of taps and buttons. */
export function touchOnly(): boolean {
  return document.documentElement.classList.contains("no-keyboard");
}
