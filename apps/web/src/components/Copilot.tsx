import { Check, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { DEFAULT_MODEL, proposeWithClaude, type Proposal } from "@opencad/ai";
import { apply, currentDoc, kernel, scheduleRebuild, toast, useApp } from "../store";

const KEY = "opencad.anthropicKey";
const MODEL = "opencad.model";
const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const write = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    // private mode: the key lives only for this session
  }
};

export function CopilotPanel() {
  const [key, setKey] = useState(read(KEY));
  const [model, setModel] = useState(read(MODEL) || DEFAULT_MODEL);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [base, setBase] = useState<ReturnType<typeof currentDoc> | null>(null);

  const run = async () => {
    if (!key) return toast("Enter your Anthropic API key first", "error");
    if (!prompt.trim()) return;
    write(KEY, key);
    write(MODEL, model);
    setBusy("Thinking…");
    setProposal(null);
    const doc = currentDoc();
    setBase(doc);
    try {
      const p = await proposeWithClaude({
        apiKey: key,
        model,
        prompt,
        doc,
        ...(useApp.getState().output ? { report: useApp.getState().output!.report } : {}),
        sandbox: async (d) => (await kernel.sandbox(d)).report,
        onProgress: setBusy,
      });
      setProposal(p);
      if (p.ops.length) {
        useApp.setState({ proposalDoc: p.doc });
        scheduleRebuild();
      }
    } catch (e) {
      toast(`Copilot failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setBusy("");
    }
  };

  const discard = () => {
    setProposal(null);
    useApp.setState({ proposalDoc: null });
    scheduleRebuild();
  };
  const accept = () => {
    if (!proposal) return;
    if (currentDoc() !== base) {
      toast("The model changed while the copilot was working. Run it again.", "error");
      return discard();
    }
    useApp.setState({ proposalDoc: null });
    if (apply(...proposal.ops)) {
      setProposal(null);
      setPrompt("");
    }
  };

  const diff = proposal ? diffDocs(base ?? currentDoc(), proposal.doc) : [];

  return (
    <aside className="panel-right">
      <div className="head">
        <Sparkles size={16} /> Copilot
        <span className="spacer" />
        <button className="icon-btn sm" onClick={() => (discard(), useApp.setState({ copilotOpen: false }))}>
          <X />
        </button>
      </div>
      <div className="body">
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>
          Describe a part or a change. Uses your own Anthropic API key — requests go straight from this browser to Anthropic. Answers are AI-generated; review the preview before accepting.
        </p>
        <div className="fld">
          <label>API key</label>
          <input className="field" type="password" placeholder="sk-ant-…" value={key} autoComplete="off" onChange={(e) => setKey(e.target.value)} onBlur={() => write(KEY, key)} />
        </div>
        <div className="fld">
          <label>Model</label>
          <input className="field" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <textarea
          className="field"
          rows={5}
          placeholder="e.g. Wall bracket 60×40, 4 mm thick, two countersunk 4 mm holes, 3 mm fillets"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void run()}
        />
        <button className="btn primary" disabled={!!busy} onClick={() => void run()}>
          <Sparkles /> {busy || "Propose changes ⌘↵"}
        </button>
        {proposal ? (
          <div className="col" style={{ gap: 8, border: "1px solid var(--border)", borderRadius: 10, padding: 10 }}>
            <b>{proposal.ok ? "Proposal (previewing)" : "Proposal incomplete"}</b>
            {proposal.summary ? <div>{proposal.summary}</div> : null}
            {proposal.errors.map((e, i) => (
              <div key={i} className="callout err">
                {e}
              </div>
            ))}
            <div className="mono" style={{ fontSize: 12 }}>
              {diff.length ? diff.map((d, i) => <div key={i} style={{ color: d[0] === "+" ? "var(--ok)" : d[0] === "−" ? "var(--err)" : "var(--warn)" }}>{d}</div>) : <span className="muted">no changes</span>}
            </div>
            <details>
              <summary className="muted" style={{ fontSize: 12 }}>
                {proposal.ops.length} ops · {proposal.iterations} model calls
              </summary>
              <pre style={{ fontSize: 11, maxHeight: 220, overflow: "auto" }}>{JSON.stringify(proposal.ops, null, 2)}</pre>
            </details>
            <div className="row">
              <button className="btn primary" disabled={!proposal.ops.length} onClick={accept}>
                <Check /> Accept
              </button>
              <button className="btn" onClick={discard}>
                Discard
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function diffDocs(a: ReturnType<typeof currentDoc>, b: ReturnType<typeof currentDoc>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(b.params)) if (a.params[k] !== v) out.push(`${a.params[k] === undefined ? "+" : "~"} ${k} = ${v}`);
  for (const k of Object.keys(a.params)) if (!(k in b.params)) out.push(`− ${k}`);
  const before = new Map(a.features.map((f) => [f.id, f]));
  for (const f of b.features) {
    const o = before.get(f.id);
    if (!o) out.push(`+ ${f.id} ${f.op}`);
    else if (JSON.stringify(o) !== JSON.stringify(f)) out.push(`~ ${f.id} ${f.op}`);
  }
  for (const f of a.features) if (!b.features.some((x) => x.id === f.id)) out.push(`− ${f.id}`);
  return out;
}
