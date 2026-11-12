// @vitest-environment happy-dom
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMS_KEY, TERMS_POINTS, TERMS_VERSION } from "../apps/web/src/lib/terms";

/**
 * The terms-of-use screen (components/TermsGate.tsx) in a DOM: the boxes unlock only once the text
 * is read to the end, Accept only with every box, nothing closes it, keys stay inside, and
 * accepting stores the record. The Mac app and the iPhone/iPad layouts run it for real in
 * tests/e2e/terms.e2e.ts.
 */

const root = join(import.meta.dirname, "..");
// React from the app (the tests package has none of its own); typed just as far as used here.
const fromWeb = createRequire(join(root, "apps/web/package.json"));
type Root = { render(node: unknown): void; unmount(): void };
const React = (await import(fromWeb.resolve("react"))) as { createElement(type: unknown, props: unknown): unknown; act(fn: () => unknown): Promise<void> };
const { createRoot } = (await import(fromWeb.resolve("react-dom/client"))) as { createRoot(el: Element): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** happy-dom lays nothing out: the text box gets the sizes a window would give it. */
const box = { scrollHeight: 2000, clientHeight: 300, scrollTop: 0 };
const proto = (globalThis as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
const saved = (["scrollHeight", "clientHeight", "scrollTop"] as const).map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
for (const k of ["scrollHeight", "clientHeight", "scrollTop"] as const)
  Object.defineProperty(proto, k, {
    configurable: true,
    get(this: Element) {
      return this.classList.contains("terms-text") ? box[k] : 0;
    },
    set(this: Element, v: number) {
      if (this.classList.contains("terms-text") && k === "scrollTop") box.scrollTop = v;
    },
  });

/** ResizeObserver as a window has it: the test says when the box changes size. */
let resized: (() => void)[] = [];
class FakeResizeObserver {
  constructor(private fn: () => void) {}
  observe() {
    resized.push(this.fn);
  }
  disconnect() {
    resized = resized.filter((f) => f !== this.fn);
  }
}

interface Env {
  /** The Mac (shared flags and the app's version), or a device with neither (iPad, iPhone). */
  desktop?: { version?: string; infoFails?: boolean };
  /** On a device: the iOS app (with its version) or not. */
  native?: { app: boolean; version?: string; fails?: boolean };
  lang?: "de" | "en";
  resizeObserver?: boolean;
}

const GATE = join(root, "apps/web/src/components/TermsGate.tsx");
let rootEl: HTMLElement;
let reactRoot: Root | null = null;

async function mount(env: Env = {}) {
  vi.resetModules();
  localStorage.clear();
  if (env.lang) localStorage.setItem("meercad.lang", env.lang);
  const shared = { initial: {} as Record<string, unknown>, set: vi.fn((_k: string, _v: unknown) => Promise.resolve()) };
  const desktop = env.desktop
    ? { shared, info: vi.fn(async () => (env.desktop!.infoFails ? Promise.reject(new Error("no info")) : { version: env.desktop!.version ?? "9.9.9" })) }
    : undefined;
  vi.doMock("../apps/web/src/lib/persistence", () => ({ desktop }));
  vi.doMock("../apps/web/src/lib/native", () => ({
    nativeApp: env.native?.app ?? false,
    appVersion: async () => (env.native?.fails ? Promise.reject(new Error("no plugin")) : (env.native?.version ?? "")),
  }));
  // The logo pulls in the whole app (store, kernel); the screen only shows it.
  vi.doMock("../apps/web/src/components/TopBar", () => ({ Logo: () => null }));
  vi.stubGlobal("ResizeObserver", env.resizeObserver === false ? undefined : FakeResizeObserver);
  // A .tsx file: loaded by path, since this package's type check has no JSX (vitest compiles it).
  const { TermsGate, termsText } = (await import(GATE)) as { TermsGate: (p: { onAccept: () => void }) => unknown; termsText(): string };
  const { termsAccepted } = await import("../apps/web/src/lib/termsStore");
  const onAccept = vi.fn();
  // Behind the screen: the app, with a key handler of its own.
  const appKeys: string[] = [];
  const behind = document.createElement("button");
  behind.textContent = "Behind";
  document.body.append(behind);
  window.addEventListener("keydown", (e) => appKeys.push(e.key));
  rootEl = document.createElement("div");
  document.body.append(rootEl);
  await React.act(() => {
    reactRoot = createRoot(rootEl);
    reactRoot.render(React.createElement(TermsGate, { onAccept }));
  });
  return { onAccept, shared, desktop, termsText, termsAccepted, appKeys, behind };
}

const q = <T extends Element = HTMLElement>(sel: string) => rootEl.querySelector(sel) as T;
const checkboxes = () => [...rootEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
const acceptButton = () => q<HTMLButtonElement>("button.terms-accept");
const textBox = () => q(".terms-text");
const act = (fn: () => unknown) => React.act(fn);
const click = (el: Element) => act(() => (el as HTMLElement).click());
const key = (target: EventTarget, init: KeyboardEventInit, type = "keydown") => {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
async function scrollToEnd() {
  await act(() => {
    box.scrollTop = box.scrollHeight - box.clientHeight;
    textBox().dispatchEvent(new Event("scroll"));
  });
}
async function tickAll() {
  for (const c of checkboxes()) if (!c.checked) await click(c);
}

beforeEach(() => {
  Object.assign(box, { scrollHeight: 2000, clientHeight: 300, scrollTop: 0 });
  resized = [];
});
afterEach(async () => {
  if (reactRoot) await act(() => reactRoot!.unmount());
  reactRoot = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  for (const m of ["persistence", "native"]) vi.doUnmock(`../apps/web/src/lib/${m}`);
  vi.doUnmock("../apps/web/src/components/TopBar");
});

describe("terms of use screen", () => {
  it("is a modal dialog with the text, one box per point, one button and no way to close it", async () => {
    await mount();
    const dialog = q("[role=dialog]");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(q("#terms-title").textContent).toBe("Terms of use");
    expect(textBox().textContent).toContain(`Version ${TERMS_VERSION}`);
    expect(checkboxes()).toHaveLength(TERMS_POINTS.length);
    for (const p of TERMS_POINTS) expect(rootEl.textContent).toContain(p.text);
    // No X, no Cancel, no Quit: the only button accepts.
    expect([...rootEl.querySelectorAll("button")].map((b) => b.className)).toEqual(["btn primary terms-accept"]);
    expect(rootEl.querySelector("[aria-label=Close], .close, .x")).toBeNull();
  });

  it("locks the boxes and the button until the text is read to the end", async () => {
    const { onAccept } = await mount();
    expect(checkboxes().every((c) => c.disabled)).toBe(true);
    expect(acceptButton().disabled).toBe(true);
    expect(q(".terms-hint").textContent).toMatch(/read to the end/);
    // Clicking a locked box does nothing.
    await click(checkboxes()[0]!);
    expect(checkboxes()[0]!.checked).toBe(false);
    // Half way down is not the end.
    await act(() => {
      box.scrollTop = 800;
      textBox().dispatchEvent(new Event("scroll"));
    });
    expect(checkboxes().every((c) => c.disabled)).toBe(true);
    await scrollToEnd();
    expect(checkboxes().every((c) => !c.disabled)).toBe(true);
    expect(q(".terms-hint").className).toContain("done");
    expect(acceptButton().disabled).toBe(true);
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("unlocks at once when the text fits the box", async () => {
    box.scrollHeight = 250;
    await mount();
    expect(checkboxes().every((c) => !c.disabled)).toBe(true);
  });

  it("unlocks when the window grows until the whole text fits", async () => {
    await mount();
    expect(checkboxes()[0]!.disabled).toBe(true);
    // Growing, but the text still runs on.
    box.clientHeight = 900;
    await act(() => resized.forEach((f) => f()));
    expect(checkboxes()[0]!.disabled).toBe(true);
    box.clientHeight = 2000;
    await act(() => resized.forEach((f) => f()));
    expect(checkboxes()[0]!.disabled).toBe(false);
  });

  it("works without ResizeObserver (older web views)", async () => {
    await mount({ resizeObserver: false });
    expect(checkboxes()[0]!.disabled).toBe(true);
    await scrollToEnd();
    expect(checkboxes()[0]!.disabled).toBe(false);
  });

  it("enables Accept only with every box ticked; one missing box disables it", async () => {
    await mount();
    await scrollToEnd();
    for (let skip = 0; skip < TERMS_POINTS.length; skip++) {
      for (const [i, c] of checkboxes().entries()) if (c.checked !== (i !== skip)) await click(c);
      expect(acceptButton().disabled, `without ${TERMS_POINTS[skip]!.id}`).toBe(true);
    }
    await tickAll();
    expect(acceptButton().disabled).toBe(false);
    // Unticking one again.
    await click(checkboxes()[2]!);
    expect(acceptButton().disabled).toBe(true);
  });

  it("does not accept through a button forced on before every box is ticked", async () => {
    const { onAccept } = await mount();
    // Not read yet.
    acceptButton().disabled = false;
    await click(acceptButton());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(onAccept).not.toHaveBeenCalled();
    // Read, one box ticked.
    await scrollToEnd();
    await click(checkboxes()[0]!);
    acceptButton().disabled = false;
    await click(acceptButton());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(onAccept).not.toHaveBeenCalled();
    expect(localStorage.getItem(`meercad.${TERMS_KEY}`)).toBeNull();
  });

  it("Escape, clicks on the backdrop and keys for the app behind do nothing", async () => {
    const { onAccept, appKeys, behind } = await mount();
    const esc = key(textBox(), { key: "Escape" });
    expect(esc.defaultPrevented).toBe(true);
    await click(q(".terms-gate"));
    await click(q(".terms-card"));
    expect(q("[role=dialog]")).not.toBeNull();
    expect(onAccept).not.toHaveBeenCalled();
    // Keys inside the screen never reach the app's own handlers.
    key(textBox(), { key: "z", metaKey: true });
    expect(appKeys).toEqual([]);
    // Keys aimed at the app behind (focus outside the screen) are swallowed, also when let go.
    for (const type of ["keydown", "keyup"]) {
      const e = key(behind, { key: "Delete" }, type);
      expect(e.defaultPrevented, type).toBe(true);
    }
    expect(appKeys).toEqual([]);
  });

  it("keeps the keyboard focus inside: Tab from outside comes back, Tab and Shift+Tab wrap around", async () => {
    const { behind } = await mount();
    expect(document.activeElement).toBe(textBox());
    behind.focus();
    key(behind, { key: "Tab" });
    expect(document.activeElement).toBe(textBox());
    // Shift+Tab on the first stop goes to the last (the text box while the rest is locked).
    const back = key(textBox(), { key: "Tab", shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    await scrollToEnd();
    await tickAll();
    const last = acceptButton();
    textBox().focus();
    key(textBox(), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    const fwd = key(last, { key: "Tab" });
    expect(fwd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(textBox());
    // In between, Tab is left to the browser.
    const box1 = checkboxes()[0]!;
    box1.focus();
    expect(key(box1, { key: "Tab" }).defaultPrevented).toBe(false);
    expect(key(box1, { key: "Tab", shiftKey: true }).defaultPrevented).toBe(false);
    // Letting go of a key inside stays inside too.
    expect(key(box1, { key: "a" }, "keyup").defaultPrevented).toBe(false);
  });

  it("on the Mac: accepting saves the record with the app's version for every meerCAD copy, then lets the app go on", async () => {
    const { onAccept, shared, termsAccepted } = await mount({ desktop: { version: "1.7.0" } });
    expect(termsAccepted()).toBe(false);
    await scrollToEnd();
    await tickAll();
    await click(acceptButton());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(termsAccepted()).toBe(true);
    const [k, record] = shared.set.mock.calls[0]!;
    expect(k).toBe(TERMS_KEY);
    expect(record).toMatchObject({ version: TERMS_VERSION, appVersion: "1.7.0", lang: "en", points: TERMS_POINTS.map((p) => p.id) });
    expect(JSON.parse(localStorage.getItem(`meercad.${TERMS_KEY}`)!)).toEqual(record);
  });

  it("on the iPad and iPhone: saves to localStorage with the app's version", async () => {
    const { onAccept } = await mount({ native: { app: true, version: "1.7.0 (42)" } });
    await scrollToEnd();
    await tickAll();
    await click(acceptButton());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(`meercad.${TERMS_KEY}`)!)).toMatchObject({ version: TERMS_VERSION, appVersion: "1.7.0 (42)" });
  });

  it("still accepts when the app's version cannot be read", async () => {
    for (const env of [{ desktop: { infoFails: true } }, { native: { app: true, fails: true } }, { native: { app: false } }] as Env[]) {
      const { onAccept } = await mount(env);
      await scrollToEnd();
      await tickAll();
      await click(acceptButton());
      await act(() => new Promise((r) => setTimeout(r, 0)));
      expect(onAccept, JSON.stringify(env)).toHaveBeenCalledTimes(1);
      expect(JSON.parse(localStorage.getItem(`meercad.${TERMS_KEY}`)!).appVersion).toBe("");
      await act(() => reactRoot!.unmount());
      reactRoot = null;
      document.body.innerHTML = "";
    }
  });

  it("shows the German text and points in German", async () => {
    const { termsText } = await mount({ lang: "de" });
    expect(q("#terms-title").textContent).toBe("Nutzungsvereinbarung");
    expect(termsText()).toContain("Torben Berger UG (haftungsbeschränkt)");
    expect(textBox().textContent).toContain("Nutzungsvereinbarung");
    expect(rootEl.textContent).not.toContain(TERMS_POINTS[0]!.text);
    await scrollToEnd();
    await tickAll();
    await click(acceptButton());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(JSON.parse(localStorage.getItem(`meercad.${TERMS_KEY}`)!).lang).toBe("de");
  });

  it("stops holding the keys once it is gone", async () => {
    const { appKeys, behind } = await mount();
    await act(() => reactRoot!.unmount());
    reactRoot = null;
    const e = key(behind, { key: "Delete" });
    expect(e.defaultPrevented).toBe(false);
    expect(appKeys).toEqual(["Delete"]);
  });
});

// Leave HTMLElement as it was.
afterAll(() => {
  for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d);
  else delete (proto as Record<string, unknown>)[k];
});
