import "./style.css";
import { DEFAULT_MODEL, proposeWithClaude, type Proposal } from "@opencad/ai";
import { decodeShareFragment, encodeShareFragment, writeStl } from "@opencad/io";
import { KernelClient, SupersededError, type RebuildOutput } from "@opencad/kernel/client";
import { DocumentStore, nextFeatureId, OpError } from "@opencad/model";
import { edgeSelectorFor } from "@opencad/naming";
import { emptyDocument, validateDocument, type DocOp, type EdgeSelector, type Expr, type Feature, type OpencadDocument } from "@opencad/schema";
import { Viewport, type Pick } from "@opencad/viewport";
import { DEFAULT_DOC } from "./defaultDoc.js";
import { download, h } from "./dom.js";
import KernelWorker from "./kernel.worker.ts?worker";

const KEY_STORAGE = "opencad.anthropicKey";
const MODEL_STORAGE = "opencad.model";

// ---------- layout ----------
const app = document.getElementById("app")!;
const toolbar = h("header", { class: "toolbar" });
const sidebar = h("aside", { class: "sidebar" });
const viewportEl = h("main", { class: "viewport" });
const drawer = h("aside", { class: "drawer", hidden: true });
const status = h("footer", { class: "status" });
const toast = h("div", { class: "toast", role: "status", hidden: true });
app.append(toolbar, sidebar, viewportEl, drawer, status, toast);

// ---------- state ----------
const t0 = performance.now();
const client = new KernelClient(new KernelWorker());
let store = new DocumentStore(DEFAULT_DOC);
let last: RebuildOutput | null = null;
let kernelInfo = "Loading geometry kernel…";
let hoverInfo = "";
let selection: Pick[] = [];
let proposal: Proposal | null = null;
let copilotBusy = "";
let filletRadius = "1 mm";

const viewport = new Viewport(viewportEl, {
  onPick: (pick, additive) => {
    if (!pick) selection = additive ? selection : [];
    else if (additive) {
      const i = selection.findIndex((s) => s.kind === pick.kind && s.bodyId === pick.bodyId && (s.kind === "edge" ? s.edge === (pick as typeof s).edge : s.face === (pick as typeof s).face));
      selection = i >= 0 ? selection.filter((_, j) => j !== i) : [...selection, pick];
    } else selection = [pick];
    viewport.setSelection(selection);
    render();
  },
  onHover: (pick) => {
    hoverInfo = !pick ? "" : pick.kind === "face" ? `face ${pick.tags.join(", ")}` : `edge ${pick.faceTags.map((t) => t[0] ?? "?").join(" | ")}`;
    renderStatus();
  },
});

function flash(message: string, kind: "info" | "error" = "info"): void {
  toast.textContent = message;
  toast.className = `toast ${kind}`;
  toast.hidden = false;
  clearTimeout((flash as { timer?: number }).timer);
  (flash as { timer?: number }).timer = window.setTimeout(() => (toast.hidden = true), kind === "error" ? 6000 : 2500);
}

function apply(...ops: DocOp[]): boolean {
  try {
    store.apply(...ops);
    return true;
  } catch (e) {
    flash(e instanceof OpError ? e.message : String(e), "error");
    return false;
  }
}

// ---------- rebuild loop ----------
async function rebuild(doc: OpencadDocument): Promise<void> {
  try {
    last = await client.rebuild(doc);
    viewport.setMeshes(last.meshes);
    render();
  } catch (e) {
    if (!(e instanceof SupersededError)) flash(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

function attach(s: DocumentStore): void {
  s.subscribe((doc) => {
    proposal = null;
    void rebuild(doc);
    void syncFragment(doc);
    render();
  });
}

async function syncFragment(doc: OpencadDocument): Promise<void> {
  const frag = await encodeShareFragment(doc);
  history.replaceState(null, "", `#${frag}`);
}

// ---------- toolbar ----------
function renderToolbar(): void {
  const edges = selection.filter((s) => s.kind === "edge");
  toolbar.replaceChildren(
    h("div", { class: "brand" }, h("strong", null, "opencad"), h("span", { class: "muted" }, " Phase 0")),
    h("div", { class: "group" },
      h("button", { onclick: () => apply({ type: "replace", doc: emptyDocument() }), title: "New empty document" }, "New"),
      h("button", { onclick: addBox, title: "Add a rectangle sketch and extrude it" }, "＋ Box"),
      h("button", { onclick: addFillet, disabled: edges.length === 0, title: "Fillet the selected edges (Shift-click to select several)" }, `Fillet${edges.length ? ` (${edges.length})` : ""}`),
    ),
    h("div", { class: "group" },
      h("button", { onclick: () => store.undo(), disabled: !store.canUndo, title: "Undo (⌘Z)" }, "↶"),
      h("button", { onclick: () => store.redo(), disabled: !store.canRedo, title: "Redo (⇧⌘Z)" }, "↷"),
    ),
    h("div", { class: "group" },
      h("button", { onclick: exportStl, disabled: !last?.meshes.length }, "Export STL"),
      h("button", { onclick: share }, "Share link"),
      h("button", { class: drawer.hidden ? "" : "active", onclick: toggleCopilot }, "✦ Copilot"),
    ),
  );
}

function addBox(): void {
  const doc = store.doc;
  const sk = nextFeatureId(doc, "sketch");
  const ex = nextFeatureId(doc, "extrude");
  const offset = doc.features.filter((f) => f.op === "sketch").length * 50;
  apply({
    type: "add_features",
    features: [
      { id: sk, op: "sketch", plane: { ref: "origin.XY" }, entities: [{ id: "r1", type: "rectangle", corner: [offset, 0], size: [40, 20] }] },
      { id: ex, op: "extrude", profile: { ref: `${sk}.r1.region` }, distance: 10, mode: "new_body" },
    ],
  });
}

function addFillet(): void {
  const selectors: EdgeSelector[] = [];
  for (const s of selection) {
    if (s.kind !== "edge") continue;
    const sel = edgeSelectorFor(s.faceTags[0], s.faceTags[1]);
    if (sel) selectors.push(sel);
  }
  if (!selectors.length) return flash("Select edges first (click an edge, Shift-click for more)", "error");
  const id = nextFeatureId(store.doc, "fillet");
  if (apply({ type: "add_features", features: [{ id, op: "fillet", edges: selectors.length === 1 ? selectors[0]! : selectors, radius: parseExpr(filletRadius) }] })) {
    selection = [];
    viewport.setSelection([]);
  }
}

function exportStl(): void {
  if (!last?.meshes.length) return;
  download("model.stl", writeStl(last.meshes) as BlobPart, "model/stl");
}

async function share(): Promise<void> {
  await syncFragment(store.doc);
  try {
    await navigator.clipboard.writeText(location.href);
    flash("Share link copied. The model lives in the link itself and never reaches a server.");
  } catch {
    flash("Copy the address bar: it contains the whole model.");
  }
}

function toggleCopilot(): void {
  drawer.hidden = !drawer.hidden;
  app.classList.toggle("with-drawer", !drawer.hidden);
  render();
}

// ---------- sidebar ----------
const parseExpr = (s: string): Expr => (/^\s*-?\d+(\.\d+)?\s*$/.test(s) ? Number(s) : s.trim());

/** Expression input: commits on Enter/blur; ArrowUp/Down nudges numbers for live rebuilds. */
function exprInput(key: string, value: Expr, commit: (e: Expr) => void, error?: string): HTMLInputElement {
  const input = h("input", { class: `expr${error ? " invalid" : ""}`, value: String(value), title: error ?? "", "data-key": key, spellcheck: false });
  const done = () => {
    if (input.value.trim() && input.value !== String(value)) commit(parseExpr(input.value));
  };
  input.addEventListener("change", done);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && /^\s*-?\d+(\.\d+)?\s*(mm)?\s*$/.test(input.value)) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
      const n = parseFloat(input.value) + step;
      const unit = /mm/.test(input.value) ? " mm" : "";
      commit(unit ? `${n}${unit}` : n);
    }
  });
  return input;
}

function renderParams(): HTMLElement {
  const doc = store.doc;
  const errors = last?.report.paramErrors ?? {};
  const values = last?.report.params ?? {};
  const rows = Object.entries(doc.params).map(([name, expr]) =>
    h("div", { class: "param" },
      h("span", { class: "name" }, name),
      exprInput(`param:${name}`, expr, (e) => apply({ type: "set_param", name, expr: e }), errors[name]),
      h("span", { class: "value muted" }, errors[name] ? "⚠" : values[name] !== undefined ? fmt(values[name]!) : ""),
      h("button", { class: "icon", title: `Delete ${name}`, onclick: () => apply({ type: "set_param", name, expr: null }) }, "×"),
    ),
  );
  const newName = h("input", { placeholder: "name", class: "name-input", "data-key": "param:new:name" });
  const newExpr = h("input", { placeholder: "= expression", class: "expr", "data-key": "param:new:expr" });
  const add = () => {
    if (newName.value && newExpr.value && apply({ type: "set_param", name: newName.value.trim(), expr: parseExpr(newExpr.value) })) {
      newName.value = newExpr.value = "";
    }
  };
  newExpr.addEventListener("keydown", (e) => e.key === "Enter" && add());
  return h("section", null, h("h2", null, "Parameters"), ...rows, h("div", { class: "param new" }, newName, newExpr, h("button", { class: "icon", onclick: add, title: "Add parameter" }, "＋")));
}

const STATUS_LABEL: Record<string, string> = { ok: "OK", warning: "Warning", error: "Error", suppressed: "Suppressed", rolled_back: "Rolled back" };

function renderTimeline(): HTMLElement {
  const doc = store.doc;
  const statuses = new Map(last?.report.features.map((f) => [f.id, f]) ?? []);
  const items = doc.features.map((f) => {
    const st = statuses.get(f.id);
    const edit = (patch: Record<string, unknown>) => apply({ type: "edit_feature", id: f.id, patch });
    return h("li", { class: `feature ${st?.status ?? "pending"}` },
      h("div", { class: "row" },
        h("span", { class: "dot", title: st ? STATUS_LABEL[st.status] : "pending" }),
        h("span", { class: "fid" }, f.id),
        h("span", { class: "op muted" }, f.op),
        h("span", { class: "spacer" }),
        st && !st.cached && st.ms > 0 ? h("span", { class: "ms muted" }, `${st.ms.toFixed(1)} ms`) : null,
        h("button", { class: "icon", title: f.suppressed ? "Unsuppress" : "Suppress", onclick: () => edit({ suppressed: f.suppressed ? null : true }) }, f.suppressed ? "◌" : "◉"),
        h("button", { class: "icon", title: doc.rollback === f.id ? "Roll forward to the end" : "Roll back to here", onclick: () => apply({ type: "set_rollback", id: doc.rollback === f.id ? null : f.id }) }, doc.rollback === f.id ? "⏭" : "⏮"),
        h("button", { class: "icon", title: `Delete ${f.id}`, onclick: () => apply({ type: "delete_feature", id: f.id }) }, "×"),
      ),
      featureFields(f, edit),
      st?.message ? h("div", { class: "message" }, st.message) : null,
      st?.hint ? h("div", { class: "hint" }, `→ ${st.hint}`) : null,
      doc.rollback === f.id ? h("div", { class: "rollback-bar" }, "rollback marker") : null,
    );
  });
  return h("section", null, h("h2", null, "Timeline"), items.length ? h("ol", { class: "timeline" }, ...items) : h("p", { class: "muted" }, "Empty. Add a box or ask the copilot."));
}

function featureFields(f: Feature, edit: (patch: Record<string, unknown>) => void): HTMLElement {
  const field = (label: string, input: HTMLElement) => h("label", { class: "field" }, h("span", null, label), input);
  switch (f.op) {
    case "sketch": {
      const plane = h("select", { "data-key": `${f.id}:plane`, onchange: (e: Event) => edit({ plane: { ref: (e.target as HTMLSelectElement).value } }) },
        ...["origin.XY", "origin.XZ", "origin.YZ"].map((p) => h("option", { value: p, selected: f.plane.ref === p }, p.slice(7))),
      );
      const rects = f.entities.map((e, i) => {
        const set = (key: "corner" | "size", k: 0 | 1) => (v: Expr) => {
          const entities = structuredClone(f.entities);
          entities[i]![key][k] = v;
          edit({ entities });
        };
        return h("div", { class: "fields" },
          field(`${e.id} x`, exprInput(`${f.id}:${e.id}:cx`, e.corner[0], set("corner", 0))),
          field("y", exprInput(`${f.id}:${e.id}:cy`, e.corner[1], set("corner", 1))),
          field("w", exprInput(`${f.id}:${e.id}:w`, e.size[0], set("size", 0))),
          field("h", exprInput(`${f.id}:${e.id}:h`, e.size[1], set("size", 1))),
        );
      });
      return h("div", null, h("div", { class: "fields" }, field("plane", plane)), ...rects);
    }
    case "extrude":
      return h("div", { class: "fields" }, field("distance", exprInput(`${f.id}:distance`, f.distance, (v) => edit({ distance: v }))), h("span", { class: "muted small" }, f.profile.ref));
    case "fillet": {
      const edges = Array.isArray(f.edges) ? f.edges : [f.edges];
      return h("div", null,
        h("div", { class: "fields" }, field("radius", exprInput(`${f.id}:radius`, f.radius, (v) => edit({ radius: v })))),
        h("div", { class: "muted small selectors" }, ...edges.map((s) => h("div", null, describeSelector(s)))),
      );
    }
  }
}

function describeSelector(s: EdgeSelector): string {
  if ("edge" in s) return `edge ${s.edge[0]} ∩ ${s.edge[1]}`;
  return `edges of ${s.of ?? "?"}${s.where?.face ? ` on ${s.where.face}` : ""}`;
}

function renderSelection(): HTMLElement | null {
  if (!selection.length) return null;
  const edges = selection.filter((s) => s.kind === "edge");
  const radius = h("input", { class: "expr", value: filletRadius, "data-key": "sel:radius" });
  radius.addEventListener("input", () => (filletRadius = radius.value));
  radius.addEventListener("keydown", (e) => e.key === "Enter" && addFillet());
  return h("section", { class: "selection" },
    h("h2", null, "Selection"),
    ...selection.map((s) => h("div", { class: "small" }, s.kind === "face" ? `face: ${s.tags.join(", ")}` : `edge: ${s.faceTags.map((t) => t[0]).join(" ∩ ")}`)),
    edges.length ? h("div", { class: "fields" }, h("label", { class: "field" }, h("span", null, "radius"), radius), h("button", { class: "primary", onclick: addFillet }, `Fillet ${edges.length} edge${edges.length > 1 ? "s" : ""}`)) : null,
    h("p", { class: "muted small" }, "Shift-click adds to the selection, Esc clears it."),
  );
}

function renderLog(): HTMLElement {
  const text = h("textarea", { class: "log", spellcheck: false, "data-key": "log" });
  text.value = JSON.stringify(store.doc, null, 2);
  const applyJson = () => {
    try {
      const parsed = validateDocument(JSON.parse(text.value));
      if (!parsed.ok) return flash(parsed.errors.slice(0, 3).join("\n"), "error");
      apply({ type: "replace", doc: parsed.value });
    } catch (e) {
      flash(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  };
  return h("details", { class: "log-box" }, h("summary", null, "Feature log (JSON)"), text, h("button", { onclick: applyJson }, "Apply JSON"));
}

// ---------- copilot ----------
function renderCopilot(): void {
  if (drawer.hidden) return;
  const key = h("input", { type: "password", placeholder: "sk-ant-…", value: readStorage(KEY_STORAGE) ?? "", autocomplete: "off", "data-key": "ai:key" });
  key.addEventListener("change", () => writeStorage(KEY_STORAGE, key.value.trim()));
  const model = h("input", { value: readStorage(MODEL_STORAGE) ?? DEFAULT_MODEL, "data-key": "ai:model" });
  model.addEventListener("change", () => writeStorage(MODEL_STORAGE, model.value.trim()));
  const prompt = h("textarea", { class: "prompt", placeholder: "e.g. Box 40×20×10, 2 mm fillet on the top edges", "data-key": "ai:prompt", rows: 4 });
  prompt.value = copilotPrompt;
  prompt.addEventListener("input", () => (copilotPrompt = prompt.value));
  prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void runCopilot(key.value.trim(), model.value.trim());
  });

  drawer.replaceChildren(
    ...nodes(
    h("h2", null, "✦ Copilot"),
    h("p", { class: "muted small" }, "Uses your own Anthropic API key. Requests go directly from this browser to Anthropic; the key is stored only in this browser. Responses are AI-generated: review the diff before accepting."),
    h("label", { class: "field col" }, h("span", null, "API key"), key),
    h("label", { class: "field col" }, h("span", null, "Model"), model),
    prompt,
    h("button", { class: "primary", disabled: !!copilotBusy, onclick: () => runCopilot(key.value.trim(), model.value.trim()) }, copilotBusy || "Propose changes  ⌘↵"),
    proposal ? renderProposal(proposal) : null,
    ),
  );
}

let copilotPrompt = "";

async function runCopilot(apiKey: string, model: string): Promise<void> {
  if (!apiKey) return flash("Enter your Anthropic API key first", "error");
  if (!copilotPrompt.trim()) return;
  writeStorage(KEY_STORAGE, apiKey);
  copilotBusy = "Thinking…";
  render();
  const base = store.doc;
  try {
    const result = await proposeWithClaude({
      apiKey,
      model: model || DEFAULT_MODEL,
      prompt: copilotPrompt,
      doc: base,
      ...(last ? { report: last.report } : {}),
      sandbox: (doc) => client.sandbox(doc),
      onProgress: (m) => {
        copilotBusy = m;
        renderCopilot();
      },
    });
    if (store.doc !== base) return flash("The document changed while the copilot was working; proposal discarded.", "error");
    proposal = result;
    // Preview the proposal in the viewport; the store stays untouched until the user accepts.
    if (result.ops.length) void rebuild(result.doc);
  } catch (e) {
    flash(`Copilot failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    copilotBusy = "";
    render();
  }
}

function renderProposal(p: Proposal): HTMLElement {
  const before = new Set(store.doc.features.map((f) => f.id));
  const after = new Map(p.doc.features.map((f) => [f.id, f]));
  const diff: HTMLElement[] = [];
  for (const [name, expr] of Object.entries(p.doc.params)) {
    if (store.doc.params[name] !== expr) diff.push(h("div", { class: store.doc.params[name] === undefined ? "add" : "mod" }, `${store.doc.params[name] === undefined ? "+" : "~"} param ${name} = ${expr}`));
  }
  for (const name of Object.keys(store.doc.params)) if (!(name in p.doc.params)) diff.push(h("div", { class: "del" }, `− param ${name}`));
  for (const [id, f] of after) {
    const old = store.doc.features.find((x) => x.id === id);
    if (!old) diff.push(h("div", { class: "add" }, `+ ${id} ${f.op}`));
    else if (JSON.stringify(old) !== JSON.stringify(f)) diff.push(h("div", { class: "mod" }, `~ ${id} ${f.op}`));
  }
  for (const id of before) if (!after.has(id)) diff.push(h("div", { class: "del" }, `− ${id}`));

  const accept = () => {
    const ops = p.ops;
    proposal = null;
    if (!apply(...ops)) void rebuild(store.doc);
  };
  const discard = () => {
    proposal = null;
    void rebuild(store.doc);
    render();
  };
  return h("div", { class: "proposal" },
    h("h3", null, p.ok ? "Proposal" : "Proposal (incomplete)"),
    p.summary ? h("p", null, p.summary) : null,
    ...p.errors.map((e) => h("div", { class: "message" }, e)),
    h("div", { class: "diff" }, ...(diff.length ? diff : [h("div", { class: "muted" }, "no changes")])),
    h("details", null, h("summary", { class: "small" }, `${p.ops.length} op(s), ${p.iterations} model call(s)`), h("pre", { class: "small" }, JSON.stringify(p.ops, null, 2))),
    h("div", { class: "group" }, h("button", { class: "primary", disabled: !p.ops.length, onclick: accept }, "Accept"), h("button", { onclick: discard }, "Discard")),
  );
}

function readStorage(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function writeStorage(k: string, v: string): void {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    // storage unavailable (private mode); the key then lives only in this session
  }
}

// ---------- status ----------
function renderStatus(): void {
  const r = last?.report;
  const body = r?.bodies.map((b) => `${b.id}: ${fmt(b.volume)} mm³, ${b.bbox.max.map((v, i) => fmt(v - b.bbox.min[i]!)).join("×")} mm`).join(" · ");
  status.replaceChildren(
    ...nodes(
    h("span", null, kernelInfo),
    r ? h("span", null, `rebuild ${r.rebuildMs.toFixed(1)} ms + mesh ${r.meshMs.toFixed(1)} ms`) : null,
    body ? h("span", null, body) : null,
    proposal ? h("span", { class: "badge" }, "previewing copilot proposal") : null,
    h("span", { class: "spacer" }),
    h("span", { class: "muted" }, hoverInfo),
    ),
  );
}

function nodes(...items: (Node | null)[]): Node[] {
  return items.filter((x): x is Node => x !== null);
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : String(Math.round(n * 100) / 100));

// ---------- render ----------
function render(): void {
  const active = document.activeElement as HTMLElement | null;
  const key = active?.getAttribute("data-key");
  const caret = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null;
  renderToolbar();
  sidebar.replaceChildren(...[renderSelection(), renderParams(), renderTimeline(), renderLog()].filter((x): x is HTMLElement => !!x));
  renderCopilot();
  renderStatus();
  if (key) {
    const el = app.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    if (el) {
      el.focus();
      if (caret && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.setSelectionRange(caret[0] ?? null, caret[1] ?? null);
    }
  }
}

window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) {
    e.preventDefault();
    if (e.shiftKey) store.redo();
    else store.undo();
  }
  if (e.key === "Escape" && selection.length) {
    selection = [];
    viewport.setSelection([]);
    render();
  }
});

// ---------- boot ----------
async function boot(): Promise<void> {
  if (location.hash.length > 1) {
    try {
      const parsed = validateDocument(await decodeShareFragment(location.hash));
      if (parsed.ok) store = new DocumentStore(parsed.value);
      else flash(`Share link is not a valid model: ${parsed.errors[0]}`, "error");
    } catch (e) {
      flash(`Could not open share link: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }
  attach(store);
  render();
  client.ready.then(
    ({ initMs }) => {
      kernelInfo = `kernel ready in ${(performance.now() - t0).toFixed(0)} ms (wasm init ${initMs.toFixed(0)} ms)`;
      renderStatus();
    },
    (e: Error) => {
      kernelInfo = e.message;
      flash(e.message, "error");
      renderStatus();
    },
  );
  await rebuild(store.doc);
  void syncFragment(store.doc);
}

void boot();

// For debugging and the e2e checks.
Object.assign(window, { opencad: { get store() { return store; }, get last() { return last; }, viewport } });
