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

  /** Types into the n-th input of a field with several (e.g. X of "Move by (X / Y / Z)"). */
  async fieldN(label: string, n: number, value: string | number): Promise<void> {
    const at = await this.fieldAt(label, "input", n);
    if (!at) throw new Error(`no input ${n} in "${label}"`);
    await this.page.click(at[0], at[1]);
    await sleep(80);
    await this.page.key("Meta+a");
    await this.page.type(String(value));
    await this.page.key("Tab");
    await sleep(200);
  }

  /**
   * Picks an option of a drop-down field. The system menu of a <select> is not part of the page and
   * cannot be clicked through the protocol, so the option is set the way that menu sets it.
   */
  async choose(label: string, option: string): Promise<void> {
    const at = await this.fieldAt(label, "select");
    if (!at) throw new Error(`no drop-down "${label}"`);
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
    try {
      await this.until("the dialog to close", "!s.dialog", 5000);
    } catch {
      const why = await this.page.eval<string>(`[...document.querySelectorAll(".dialog .hint, .dialog .problem, .dialog [class*=warn], .dialog [class*=error]")].map((e) => e.textContent.trim()).join(" · ")`);
      throw new Error(`the dialog does not accept: ${why || "(no reason shown)"}`);
    }
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

  /**
   * Zooms the open sketch with the mouse wheel (over its origin) until `size` mm across fit in
   * about a third of the window's height, so points that far out are on screen and apart.
   */
  async zoomSketch(size: number): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const [x0, y0] = await this.sketchScreen([0, 0]);
      const [x1] = await this.sketchScreen([size, 0]);
      const px = Math.abs(x1 - x0);
      if (px > 220 && px < 380) return;
      await this.page.call("Input.dispatchMouseEvent", { type: "mouseWheel", x: x0, y: y0, deltaX: 0, deltaY: px < 220 ? -120 : 120 });
      await sleep(120);
    }
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
  async spotOf(kind: "edge" | "face", test: string, any = false): Promise<Vec2> {
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
      if (found.length > 1 && !${any}) return found.length + " match, want one";
      // The dialog on the left covers part of the view.
      const dlg = document.querySelector(".dialog")?.getBoundingClientRect();
      for (const f of found) {
        // Spots nearest the middle first.
        const c = [0, 1, 2].map((j) => f.spots.reduce((a, p) => a + p[j], 0) / f.spots.length);
        f.spots.sort((a, b) => Math.hypot(...a.map((x, j) => x - c[j])) - Math.hypot(...b.map((x, j) => x - c[j])));
        for (const p of f.spots) {
          const q = v.worldToScreen(p);
          if (!q) continue;
          const x = r.left + q[0], y = r.top + q[1];
          if (x < r.left + 120 || y < r.top + 80 || x > r.right - 20 || y > r.bottom - 60) continue;
          if (dlg && x < dlg.right + 8 && y < dlg.bottom + 8) continue;
          // What the app would take there, edges winning near them as for a person's click.
          const hit = v.pick(x, y, new Set(["face", "edge"]));
          if (hit && hit.kind === ${JSON.stringify(kind)} && hit.bodyId === f.body && hit[${JSON.stringify(kind)}] === f.index) return [x, y];
        }
      }
      return "not visible from here";
    })()`);
    if (typeof at === "string") throw new Error(`${kind} ${test}: ${at}`);
    return at;
  }

  /** Clicks the model's edge matching `test` (see spotOf); with shift to add to a selection. */
  async clickEdge(test: string): Promise<void> {
    const [x, y] = await this.visibleSpot("edge", test);
    await this.page.click(x, y);
    await sleep(200);
  }

  async clickFace(test: string): Promise<void> {
    const [x, y] = await this.visibleSpot("face", test);
    await this.page.click(x, y);
    await sleep(200);
  }

  /** Clicks a part (any visible face of the body with this id). */
  async clickBody(id: string): Promise<void> {
    const [x, y] = await this.visibleSpot("face", `(f) => f.body === ${JSON.stringify(id)}`, true);
    await this.page.click(x, y);
    await sleep(200);
  }

  /** Like spotOf; when the edge or face is hidden from here, turns the view the way a person would. */
  private async visibleSpot(kind: "edge" | "face", test: string, any = false): Promise<Vec2> {
    let last: unknown;
    // From where it is, then isometric and turned round in quarter turns (the view cube's buttons).
    for (const v of [null, "Isometric view", "Rotate view 90° left", "Rotate view 90° left", "Rotate view 90° left"]) {
      if (v) {
        await this.press(v, ".icon-btn");
        await sleep(700);
      }
      try {
        return await this.spotOf(kind, test, any);
      } catch (e) {
        last = e;
        if (!String(e).includes("not visible")) throw e;
      }
    }
    throw last;
  }

  /** A standard view by its key (1 iso, 2 front, … 7 left, Z fit), as a person presses it. */
  async view(k: "1" | "2" | "3" | "4" | "5" | "6" | "7" | "z"): Promise<void> {
    // Keys go to a focused field; a person first clicks out of it.
    await this.page.eval(`(document.activeElement instanceof HTMLElement && document.activeElement.blur(), true)`);
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

  /** Starts a sketch on a plane: an origin plane from the bar ("Top", "Front", "Right") or another by its tag. */
  async sketchOn(plane: string): Promise<void> {
    await this.press("Sketch", ".rail button");
    await this.press(plane, ".plane-bar button, .plane-tag", { exact: true });
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
    if (item) await this.menuItem(label, item);
    else await this.press(label, ".rail button");
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

  /** Lines from `start`, each [length, direction °] typed; closed by clicking the start again. */
  async polyline(start: Vec2, segments: [number, number][], close = true): Promise<void> {
    await this.tool("Line");
    await this.clickSketch(start);
    for (const [len, angle] of segments) {
      await this.type(String(len));
      await this.key("Tab");
      await this.type(String(angle));
      await this.key("Enter");
      await sleep(150);
    }
    // Open: the chain stays on for more clicks; closed: clicking the start ends it.
    if (close) {
      await this.clickSketch(start);
      await this.key("Escape");
      await sleep(200);
    }
  }

  /** A regular hexagon (the polygon tool) from its centre and a corner. */
  async polygon(center: Vec2, corner: Vec2): Promise<void> {
    await this.tool("More", "Polygon");
    await this.clickSketch(center);
    await this.clickSketch(corner);
    await sleep(200);
  }

  /**
   * A dimension: click one entity (or two) at the given sketch points, click where the dimension
   * goes, type its value.
   */
  async dimension(on: Vec2[], place: Vec2, value: number | string): Promise<void> {
    await this.tool("Dimension");
    for (const p of on) await this.clickSketch(p);
    await this.clickSketch(place);
    // The new dimension opens its value for typing.
    const end = Date.now() + 4000;
    while (!(await this.page.eval<boolean>(`document.activeElement?.classList.contains("value-input")`))) {
      if (Date.now() > end) throw new Error("the dimension did not open its value for typing");
      await sleep(100);
    }
    await this.page.key("Meta+a");
    await this.type(String(value));
    await this.key("Enter");
    await sleep(300);
  }

  /** Selects sketch entities at the points (Select tool, shift for more) and applies a constraint from the panel. */
  async constrain(name: string, at: Vec2[]): Promise<void> {
    await this.tool("Select");
    for (const [i, p] of at.entries()) {
      const [x, y] = await this.sketchScreen(p);
      if (i) {
        await this.page.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 8 });
        await this.page.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1, modifiers: 8 });
      } else await this.page.click(x, y);
      await sleep(150);
    }
    await this.press(name, "button", { exact: false });
    await sleep(300);
  }

  async finishSketch(): Promise<void> {
    await this.press("Finish", ".rail button");
    await this.until("the sketch to close", "!s.sketchId");
    await this.settle();
  }

  /** Waits until `expr` (on the app state `s`) holds. */
  async until(what: string, expr: string, ms = 15000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await this.state<boolean>(expr))) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  }

  /** Opens a feature's dialog from its group on the rail ("Create" › "Extrude"). */
  async feature(group: string, label: string): Promise<void> {
    await this.menuItem(group, label);
    await this.until(`the ${label} dialog`, "!!s.dialog");
    await sleep(300);
  }

  /** Opens a rail group's flyout (unless it is open) and clicks the item whose name is `label`. */
  async menuItem(group: string, label: string): Promise<void> {
    const item = () =>
      this.page.eval<Vec2 | null>(`(() => {
        const el = [...document.querySelectorAll("[role=menuitem]")].find((e) => (e.querySelector(".rail-flyout-label")?.firstChild?.textContent ?? e.textContent).trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.left + Math.min(40, r.width / 2), r.top + r.height / 2];
      })()`);
    let at = await item();
    if (!at) {
      await this.press(group, ".rail button");
      const end = Date.now() + 3000;
      while (!(at = await item()) && Date.now() < end) await sleep(100);
    }
    if (!at) throw new Error(`no "${label}" under ${group}`);
    await this.page.click(at[0], at[1]);
    await sleep(200);
  }

  /** Ticks a checkbox in the open dialog by its text. */
  async check(label: string): Promise<void> {
    await this.press(label, ".dialog label.checkbox", { exact: true });
  }

  /** Clicks a choice button in the open dialog ("Add", "Remove", …). */
  async option(label: string): Promise<void> {
    // A dialog can still set its defaults just after it opens: press until the choice holds.
    // By the visible text only: a chip's × is also called "Remove".
    const at = () =>
      this.page.eval<[number, number, boolean] | null>(`(() => {
        const b = [...document.querySelectorAll(".dialog button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && b.getBoundingClientRect().width > 0);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2, b.classList.contains("on") || b.classList.contains("active") || b.classList.contains("primary") || b.getAttribute("aria-pressed") === "true"];
      })()`);
    for (let i = 0; i < 4; i++) {
      const b = await at();
      if (!b) throw new Error(`no choice "${label}" in the dialog`);
      if (b[2] && i > 0) return;
      await this.page.click(b[0], b[1]);
      await sleep(250);
      if ((await at())?.[2]) return;
    }
    throw new Error(`the choice "${label}" does not stay on`);
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
