import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptRecord, TERMS_KEY, TERMS_MCP_ERROR, TERMS_POINTS, type TermsRecord } from "../apps/web/src/lib/terms";

/**
 * Where the consent to the terms of use is kept (termsStore.ts) and the lock it puts on assistants
 * (mcpBridge.ts): on the Mac in the flags every meerCAD shares (shared.json), elsewhere in
 * localStorage. A missing, broken, foreign or outdated record means: ask again, refuse the assistant.
 */

const root = join(import.meta.dirname, "..");
const LOCAL_KEY = `meercad.${TERMS_KEY}`;
const good = (): TermsRecord => acceptRecord("1.4.0", "de", new Date("2026-11-12T10:00:00.000Z"));
const old = (): TermsRecord => ({ ...good(), version: "2020-01-01" });

/** A localStorage over a Map; `broken` makes every call throw (private mode, blocked storage). */
function storage(broken = false, entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  const fail = (): never => {
    throw new Error("storage blocked");
  };
  return {
    map,
    getItem: (k: string) => (broken ? fail() : (map.get(k) ?? null)),
    setItem: (k: string, v: string) => (broken ? fail() : void map.set(k, v)),
  };
}
const localWith = (r: unknown) => storage(false, { [LOCAL_KEY]: typeof r === "string" ? r : JSON.stringify(r) });

/**
 * termsStore.ts loaded fresh (as at an app start) on a Mac with these shared flags, or with
 * `shared: undefined` on a device without them (iPad, iPhone: localStorage only).
 */
async function load({ shared, local = storage() }: { shared?: Record<string, unknown>; local?: ReturnType<typeof storage> } = {}) {
  vi.resetModules();
  const sharedApi = shared ? { initial: shared, set: vi.fn((_k: string, _v: unknown) => Promise.resolve()) } : undefined;
  vi.doMock("../apps/web/src/lib/persistence", () => ({ desktop: sharedApi ? { shared: sharedApi } : undefined }));
  const events: string[] = [];
  const win = new EventTarget();
  win.addEventListener("meercad:terms-accepted", (e) => events.push(e.type));
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", local);
  const store = await import("../apps/web/src/lib/termsStore");
  return { store, shared: sharedApi, local, events };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../apps/web/src/lib/persistence");
});

/** Records that must never count as consent. */
const BAD: unknown[] = [
  "{not json",
  "null",
  "",
  42,
  [],
  { hello: "world" },
  { ...good(), version: "" },
  { ...good(), acceptedAt: "yesterday" },
  { ...good(), points: TERMS_POINTS.slice(1).map((p) => p.id) },
  { ...good(), points: [] },
  old(),
  { ...good(), version: "2099-01-01" },
];

describe("terms consent store", () => {
  it("asks on a fresh device: nothing kept anywhere", async () => {
    for (const shared of [undefined, {}]) {
      const { store } = await load({ shared });
      expect(store.termsRecord()).toBeNull();
      expect(store.termsAccepted()).toBe(false);
    }
  });

  it("reads a valid record from the shared flags on the Mac, also as JSON text", async () => {
    for (const r of [good(), JSON.stringify(good())]) {
      const { store } = await load({ shared: { [TERMS_KEY]: r } });
      expect(store.termsRecord()).toEqual(good());
      expect(store.termsAccepted()).toBe(true);
    }
  });

  it("reads a valid record from localStorage (iPad, iPhone)", async () => {
    const { store } = await load({ local: localWith(good()) });
    expect(store.termsRecord()).toEqual(good());
    expect(store.termsAccepted()).toBe(true);
  });

  it("asks again for a broken, foreign, partial or outdated record, wherever it is kept", async () => {
    for (const r of BAD) {
      const mac = await load({ shared: { [TERMS_KEY]: r } });
      expect(mac.store.termsAccepted(), `shared ${JSON.stringify(r)}`).toBe(false);
      const device = await load({ local: localWith(r) });
      expect(device.store.termsAccepted(), `local ${JSON.stringify(r)}`).toBe(false);
    }
  });

  it("a current record in one place counts even if the other holds an outdated one", async () => {
    expect((await load({ shared: { [TERMS_KEY]: old() }, local: localWith(good()) })).store.termsAccepted()).toBe(true);
    expect((await load({ shared: { [TERMS_KEY]: good() }, local: localWith(old()) })).store.termsAccepted()).toBe(true);
  });

  it("survives a localStorage that throws", async () => {
    const { store, events } = await load({ local: storage(true) });
    expect(store.termsAccepted()).toBe(false);
    // Saving still counts for this window and tells the app.
    const r = good();
    store.saveTerms(r);
    expect(store.termsRecord()).toBe(r);
    expect(events).toEqual(["meercad:terms-accepted"]);
  });

  it("saves to the shared flags and localStorage, counts at once, tells the app, and holds after a restart", async () => {
    const { store, shared, local, events } = await load({ shared: {} });
    expect(store.termsAccepted()).toBe(false);
    const r = good();
    store.saveTerms(r);
    expect(store.termsAccepted()).toBe(true);
    expect(store.termsRecord()).toBe(r);
    expect(shared!.set).toHaveBeenCalledWith(TERMS_KEY, r);
    expect(JSON.parse(local.map.get(LOCAL_KEY)!)).toEqual(r);
    expect(events).toEqual(["meercad:terms-accepted"]);
    // After a restart, from either place.
    expect((await load({ shared: { [TERMS_KEY]: shared!.set.mock.calls[0]![1] } })).store.termsAccepted()).toBe(true);
    expect((await load({ local: localWith(local.map.get(LOCAL_KEY)!) })).store.termsAccepted()).toBe(true);
  });

  it("keeps going when writing the shared flags fails", async () => {
    const { store, shared } = await load({ shared: {} });
    shared!.set.mockImplementation(() => Promise.reject(new Error("disk full")));
    store.saveTerms(good());
    await new Promise((r) => setTimeout(r, 0));
    expect(store.termsAccepted()).toBe(true);
  });

  it("an outdated record saved does not count", async () => {
    const { store } = await load();
    store.saveTerms(old());
    expect(store.termsAccepted()).toBe(false);
  });
});

describe("assistant lock (MCP) until the terms are accepted", () => {
  it("refuses with a clear message before, allows after", async () => {
    for (const shared of [{}, undefined]) {
      const { store } = await load({ shared });
      expect(() => store.requireTerms()).toThrow(TERMS_MCP_ERROR);
      store.saveTerms(good());
      expect(() => store.requireTerms()).not.toThrow();
    }
  });

  it("refuses again once the terms change, or the record is broken", async () => {
    const accepted = await load({ shared: { [TERMS_KEY]: good() } });
    expect(() => accepted.store.requireTerms()).not.toThrow();
    for (const r of BAD) {
      const mac = await load({ shared: { [TERMS_KEY]: r } });
      expect(() => mac.store.requireTerms(), `shared ${JSON.stringify(r)}`).toThrow(TERMS_MCP_ERROR);
      const device = await load({ local: localWith(r) });
      expect(() => device.store.requireTerms(), `local ${JSON.stringify(r)}`).toThrow(TERMS_MCP_ERROR);
    }
  });

  it("checks every assistant request in the app before anything else", () => {
    const src = readFileSync(join(root, "apps/web/src/lib/mcpBridge.ts"), "utf8");
    // The only ways into the request handler: serve (every request, in the window and in each
    // assistant tab) and testCall (development builds' test hook, which no assistant reaches).
    expect([...src.matchAll(/\bhandle\(/g)].length).toBe(3); // the definition, serve, testCall
    expect(src).toMatch(/export const testCall = [^\n]*=> handle\(/);
    // route (the window holding the connection) and serve (every request) lock first.
    for (const fn of ["async function route(req: BridgeRequest)", "async function serve(req: BridgeRequest)"]) {
      expect(src, fn).toContain(fn);
      const body = src.slice(src.indexOf(fn));
      const first = body
        .slice(body.indexOf("{") + 1)
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("//"));
      expect(first, fn).toBe("requireTerms();");
    }
    // The connection hands every request to route, the assistant tabs theirs to serve.
    expect(src).toContain("const result = await route(msg);");
    expect(src).toContain("serve(req as BridgeRequest).then(");
    // The test hook exists only in development builds.
    const main = readFileSync(join(root, "apps/web/src/main.tsx"), "utf8");
    expect(main.slice(0, main.indexOf("mcp: bridge.testCall"))).toMatch(/if \(import\.meta\.env\.DEV\)\s*\n?\s*void Promise\.all/);
  });
});
