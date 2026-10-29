import { ArrowUp, RotateCcw, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ask, checkCopilot, resetCopilot, useCopilot } from "../lib/copilot";

/** Top bar button for the copilot; nothing where Apple's language model is not available. */
export function CopilotButton() {
  const [ok, setOk] = useState(false);
  const open = useCopilot((s) => s.open);
  useEffect(() => void checkCopilot().then(setOk), []);
  if (!ok) return null;
  return (
    <button className={`icon-btn ${open ? "active" : ""}`} title="Copilot" onClick={() => useCopilot.setState({ open: !open })}>
      <Sparkles />
    </button>
  );
}

const EXAMPLES = ["Box 40 × 30 × 15 with 3 mm rounded top edges", "Hollow it out with 2 mm walls, open at the top", "Add a Ø10 post, 20 high, next to it"];

/** The copilot's chat: what was asked, what it did, what it says. */
export function CopilotPanel() {
  const { open, busy, chat, model } = useCopilot();
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" });
  }, [chat.length, busy]);
  if (!open) return null;
  const send = () => {
    const t = text;
    setText("");
    void ask(t);
  };
  return (
    <div className="copilot">
      <div className="dialog-head">
        <Sparkles className="ficon" />
        <h3>Copilot</h3>
        {model ? <span className="copilot-model">{model}</span> : null}
        <button className="icon-btn sm" title="New conversation" onClick={() => void resetCopilot()} disabled={busy || !chat.length}>
          <RotateCcw />
        </button>
        <button className="icon-btn sm" title="Close" onClick={() => useCopilot.setState({ open: false })}>
          <X />
        </button>
      </div>
      <div className="copilot-chat" ref={list}>
        {chat.length ? null : (
          <div className="copilot-empty">
            <p>Describe what to build or change. Apple's language model does the steps in this design; every step can be undone.</p>
            {EXAMPLES.map((e) => (
              <button key={e} className="copilot-example" onClick={() => void ask(e)}>
                {e}
              </button>
            ))}
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`copilot-msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy ? <div className="copilot-msg assistant thinking">…</div> : null}
      </div>
      <form
        className="copilot-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What should I do? (any language)" enterKeyHint="send" disabled={busy} />
        <button className="icon-btn" type="submit" disabled={busy || !text.trim()} title="Send">
          <ArrowUp />
        </button>
      </form>
    </div>
  );
}
