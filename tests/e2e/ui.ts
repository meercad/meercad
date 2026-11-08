/**
 * What a person does in the app, as steps for the UI end-to-end run. Every step that changes the
 * model goes through real mouse and keyboard events on the visible interface; the page is only
 * read (where a button is, where a point of the model is on screen, what came out).
 */
import { sleep, type Page } from "./cdp.js";

type Vec2 = [number, number];
type Vec3 = [number, number, number];

export class Ui {
  constructor(readonly page: Page) {}

  /** Centre of the first visible element matching the selector whose text or title contains `text`. */
  async find(selector: string, text?: string | null, { exact = false } = {}): Promise<Vec2 | null> {
    const at = await this.page.eval<Vec2 | null>(`(() => {
      const want = ${JSON.stringify(text ?? null)}, exact = ${exact};
      const ok = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
      const label = (el) => [el.getAttribute("aria-label"), el.getAttribute("title"), el.textContent].filter(Boolean).map((s) => s.trim());
      const hit = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(ok).find((el) => want === null || label(el).some((s) => exact ? s === want : s.includes(want)));
      if (!hit) return null;
      const r = hit.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    })()`);
    return at;
  }

  async waitFind(selector: string, text?: string | null, opts = {}, ms = 10000): Promise<Vec2> {
    const end = Date.now() + ms;
    for (;;) {
      const at = await this.find(selector, text, opts);
      if (at) return at;
      if (Date.now() > end) throw new Error(`not on screen: ${selector}${text ? ` "${text}"` : ""}`);
      await sleep(150);
    }
  }

  /** Clicks a button (or other element) by its text, title or aria-label. */
  async press(text: string, selector = "button, [role=menuitem], [role=button], a", opts = {}): Promise<void> {
    const [x, y] = await this.waitFind(selector, text, opts);
    await this.page.click(x, y);
    await sleep(150);
  }

  /** Centre of the control in the dialog field labelled `label` (the n-th such control). */
  async fieldAt(label: string, control = "input, select, textarea", n = 0): Promise<Vec2 | null> {
    return this.page.eval<Vec2 | null>(`(() => {
      const f = [...document.querySelectorAll(".fld")].find((f) => f.querySelector(".fld-label")?.textContent.trim() === ${JSON.stringify(label)});
      const el = f && f.querySelectorAll(${JSON.stringify(control)})[${n}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return [r.left + Math.min(r.width / 2, 60), r.top + r.height / 2];
    })()`);
  }

  /** Types a value into a dialog field: click it, select what is there, type, Tab out. */
  async field(label: string, value: string | number): Promise<void> {
    const at = await this.fieldAt(label);
    if (!at) throw new Error(`no field "${label}"`);
    await this.page.click(at[0], at[1]);
    await sleep(80);
    await this.page.key("Meta+a");
    await this.page.type(String(value));
    await this.page.key("Tab");
    await sleep(200);
  }

  /**
   * Picks an option of a drop-down field. The system menu of a <select> cannot be clicked through
   * the protocol, so this focuses it by click and sets the option as the menu would.
   */
  async choose(label: string, option: string): Promise<void> {
    const at = await this.fieldAt(label, "select");
    if (!at) throw new Error(`no drop-down "${label}"`);
    await this.page.click(at[0], at[1]);
    await this.page.key("Escape");
    const ok = await this.page.eval<true | string[]>(`(() => {
      const f = [...document.querySelectorAll(".fld")].find((f) => f.querySelector(".fld-label")?.textContent.trim() === ${JSON.stringify(label)});
      const sel = f.querySelector("select");
      const o = [...sel.options].find((o) => o.textContent.trim() === ${JSON.stringify(option)} || o.value === ${JSON.stringify(option)});
      if (!o) return [...sel.options].map((o) => o.textContent.trim());
      const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      set.call(sel, o.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (ok !== true) throw new Error(`"${label}" has no option "${option}" (${ok})`);
    await sleep(200);
  }

  /** Accepts the open dialog with its OK button and waits for the rebuild. */
  async accept(): Promise<void> {
    await this.press("Accept", "button.ok-btn");
    await this.settle();
  }

  async key(k: string): Promise<void> {
    await this.page.key(k);
    await sleep(80);
  }

  async type(text: string): Promise<void> {
    await this.page.type(text);
    await sleep(80);
  }

  /** Where a point of the model (world mm) is on screen, in window pixels. */
  async screenOf(p: Vec3): Promise<Vec2> {
    const at = await this.page.eval<Vec2 | null>(`(() => {
      const v = meercadTest.store.getViewport(), r = v.renderer.domElement.getBoundingClientRect();
      const s = v.worldToScreen(${JSON.stringify(p)});
      return s && [r.left + s[0], r.top + s[1]];
    })()`);
    if (!at) throw new Error(`point ${p} is not on screen`);
    return at;
  }

  /** Where a point of the open sketch (sketch mm) is on screen. */
  async sketchScreen([u, v]: Vec2): Promise<Vec2> {
    const f = await this.state<{ origin: Vec3; u: Vec3; v: Vec3 }>(`s.output.report.sketches.find((k) => k.id === s.sketchId).frame`);
    return this.screenOf([0, 1, 2].map((i) => f.origin[i]! + f.u[i]! * u + f.v[i]! * v) as Vec3);
  }

  /** Clicks a point of the open sketch. */
  async clickSketch(uv: Vec2): Promise<void> {
    const [x, y] = await this.sketchScreen(uv);
    await this.page.click(x, y);
    await sleep(150);
  }

  /** Clicks a point of the model. */
  async clickAt(p: Vec3): Promise<void> {
    const [x, y] = await this.screenOf(p);
    await this.page.click(x, y);
    await sleep(150);
  }

  /**
   * A spot on screen where the viewport picks the model's edge (or face) matching `test`, a function
   * given as source that runs in the page on {body, index, points, min, max, mid} for edges and
   * {body, index, tags, center, normal} for faces. Only spots where that edge or face is in front
   * count, so the click lands on it as a person's would.
   */
  async spotOf(kind: "edge" | "face", test: string): Promise<Vec2> {
    const at = await this.page.eval<Vec2 | string>(`(() => {
      const v = meercadTest.store.getViewport(), r = v.renderer.domElement.getBoundingClientRect();
      const s = meercadTest.app.getState(), test = (${test});
      const found = [];
      for (const m of s.output.meshes) {
        if (${JSON.stringify(kind)} === "edge") {
          for (let g = 0; g < m.edgeRanges.length; g += 3) {
            const [start, count, index] = [m.edgeRanges[g], m.edgeRanges[g + 1], m.edgeRanges[g + 2]];
            if (index < 0) continue;
            const points = [];
            for (let k = start; k < start + count; k++) points.push([m.edgeLines[k * 3], m.edgeLines[k * 3 + 1], m.edgeLines[k * 3 + 2]]);
            const min = [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i]))), max = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i])));
            const mid = points[Math.floor(points.length / 2)];
            if (test({ body: m.bodyId, index, points, min, max, mid })) found.push({ body: m.bodyId, index, spots: points.slice(0, -1).map((p, i) => p.map((c, j) => (c + points[i + 1][j]) / 2)) });
          }
        } else {
          for (let g = 0; g < m.faceRanges.length; g += 3) {
            const [start, count, index] = [m.faceRanges[g], m.faceRanges[g + 1], m.faceRanges[g + 2]];
            if (index < 0) continue;
            const spots = [];
            for (let k = start; k + 2 < start + count; k += 3) {
              const tri = [0, 1, 2].map((j) => { const i = m.indices[k + j] * 3; return [m.positions[i], m.positions[i + 1], m.positions[i + 2]]; });
              spots.push([0, 1, 2].map((c) => (tri[0][c] + tri[1][c] + tri[2][c]) / 3));
            }
            const center = [0, 1, 2].map((c) => spots.reduce((a, p) => a + p[c], 0) / Math.max(1, spots.length));
            const i0 = m.indices[start] * 3, n = [m.normals?.[i0], m.normals?.[i0 + 1], m.normals?.[i0 + 2]];
            if (test({ body: m.bodyId, index, tags: m.faceTags[index] ?? [], center, normal: n })) found.push({ body: m.bodyId, index, spots });
          }
        }
      }
      if (!found.length) return "nothing matches";
      if (found.length > 1) return found.length + " match, want one";
      const f = found[0];
      // Spots nearest the middle first.
      const c = [0, 1, 2].map((j) => f.spots.reduce((a, p) => a + p[j], 0) / f.spots.length);
      f.spots.sort((a, b) => Math.hypot(...a.map((x, j) => x - c[j])) - Math.hypot(...b.map((x, j) => x - c[j])));
      for (const p of f.spots) {
        const q = v.worldToScreen(p);
        if (!q) continue;
        const x = r.left + q[0], y = r.top + q[1];
        if (x < r.left + 120 || y < r.top + 80 || x > r.right - 20 || y > r.bottom - 60) continue;
        const hit = v.pick(x, y, new Set([${JSON.stringify(kind)}]));
        if (hit && hit.bodyId === f.body && hit[${JSON.stringify(kind)}] === f.index) return [x, y];
      }
      return "not visible from here";
    })()`);
    if (typeof at === "string") throw new Error(`${kind} ${test}: ${at}`);
    return at;
  }

  /** Clicks the model's edge matching `test` (see spotOf); with shift to add to a selection. */
  async clickEdge(test: string): Promise<void> {
    const [x, y] = await this.spotOf("edge", test);
    await this.page.click(x, y);
    await sleep(200);
  }

  async clickFace(test: string): Promise<void> {
    const [x, y] = await this.spotOf("face", test);
    await this.page.click(x, y);
    await sleep(200);
  }

  /** A standard view by its key (1 iso, 2 front, … 7 left, Z fit), as a person presses it. */
  async view(k: "1" | "2" | "3" | "4" | "5" | "6" | "7" | "z"): Promise<void> {
    await this.page.key(k);
    await sleep(700);
  }

  // ---------------------------------------------------------------- steps a maker takes

  /** A new, empty part from the overview (or the tab bar's + in the editor). */
  async newPart(): Promise<void> {
    // The first click into a window that has just come up can go to bringing it to the front.
    for (let i = 0; ; i++) {
      const home = await this.find("button", "New part");
      if (home) await this.page.click(...home);
      else await this.press("New part", "button.tab-new");
      try {
        await this.waitFind(".rail button", "Sketch", {}, 5000);
        break;
      } catch (e) {
        if (i === 2) throw e;
      }
    }
    await this.settle();
  }

  /** Starts a sketch on an origin plane from the bar ("Top", "Front", "Right"). */
  async sketchOn(plane: "Top" | "Front" | "Right"): Promise<void> {
    await this.press("Sketch", ".rail button");
    await this.press(plane, ".plane-bar button");
    await sleep(700);
  }

  /** Starts a sketch on a flat face of the model, clicked in the viewport. */
  async sketchOnFace(test: string): Promise<void> {
    await this.press("Sketch", ".rail button");
    await sleep(300);
    await this.clickFace(test);
    await sleep(700);
  }

  /** Picks a tool on the rail; `item` for one inside a group's flyout. */
  async tool(label: string, item?: string): Promise<void> {
    await this.press(label, ".rail button");
    if (item) await this.press(item, "[role=menuitem]");
    await sleep(200);
  }

  /** A rectangle from its first corner, with width and height typed. */
  async rect(corner: Vec2, w: number, h: number): Promise<void> {
    await this.tool("Rectangle", "Corner rectangle");
    await this.clickSketch(corner);
    await this.type(String(w));
    await this.key("Tab");
    await this.type(String(h));
    await this.key("Enter");
    await sleep(300);
  }

  /** A circle from its centre, with the diameter typed. */
  async circle(center: Vec2, d: number): Promise<void> {
    await this.tool("Circle");
    await this.clickSketch(center);
    await this.type(String(d));
    await this.key("Enter");
    await sleep(300);
  }

  async finishSketch(): Promise<void> {
    await this.press("Finish", ".rail button");
    await this.settle();
  }

  /** Opens a feature's dialog from its group on the rail ("Create" › "Extrude"). */
  async feature(group: string, label: string): Promise<void> {
    await this.press(group, ".rail button");
    await this.press(label, "[role=menuitem]", { exact: false });
    await sleep(600);
  }

  /** Clicks a choice button in the open dialog ("Add", "Remove", …). */
  async option(label: string): Promise<void> {
    await this.press(label, ".feature-dialog button, .dialog button, [role=dialog] button", { exact: true });
  }

  /** The app's state, read back (development builds only). */
  state<T = any>(expr: string): Promise<T> {
    return this.page.eval<T>(`(() => { const s = meercadTest.app.getState(); return ${expr}; })()`);
  }

  /** Waits until the model is rebuilt and nothing is pending. */
  async settle(ms = 60000): Promise<void> {
    const end = Date.now() + ms;
    await sleep(200);
    for (;;) {
      const busy = await this.page.eval<boolean>(`(() => { const s = meercadTest.app.getState(); return meercadTest.store.rebuilding() || s.tasks.length > 0; })()`).catch(() => true);
      if (!busy) return;
      if (Date.now() > end) throw new Error("rebuild did not finish");
      await sleep(150);
    }
  }
}
