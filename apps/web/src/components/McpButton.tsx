import { Check, Copy, Plug, X } from "lucide-react";
import { useEffect, useState } from "react";
import { bridgeStatus, onBridgeStatus, setBridgeEnabled } from "../lib/mcpBridge";
import { toast } from "../store";

import { desktop } from "../lib/persistence";

/** Toolbar button showing the MCP bridge state, with setup instructions for Claude. */
export function McpButton() {
  const [status, setStatus] = useState(bridgeStatus());
  const [open, setOpen] = useState(false);
  const [cmd, setCmd] = useState<{ command: string; args: string[]; env?: Record<string, string> }>({ command: "node", args: ["<path to leocad>/packages/mcp/dist/server.js"] });
  useEffect(() => {
    const off = onBridgeStatus(setStatus);
    void desktop?.info().then((i) => setCmd(i.mcpCommand));
    return () => void off();
  }, []);
  const config = JSON.stringify({ mcpServers: { leocad: cmd } }, null, 2);
  return (
    <>
      <button className={`icon-btn ${status === "connected" ? "active" : ""}`} title={`AI assistants (MCP): ${status}`} onClick={() => setOpen(true)}>
        <Plug />
        <span className="mcp-dot" data-status={status} />
      </button>
      {open ? (
        <div className="modal-backdrop" onPointerDown={() => setOpen(false)}>
          <div className="modal" style={{ width: "min(620px, 94vw)" }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <Plug className="ficon" />
              <h3>Connect AI assistants (MCP)</h3>
              <button className="icon-btn sm" onClick={() => setOpen(false)}>
                <X />
              </button>
            </div>
            <div className="dialog-body">
              <p style={{ margin: 0 }}>
                Lets Claude Desktop, Claude Code or any MCP client read and change the open model: create sketches and features, edit parameters, render views, measure and export. Everything stays on this computer.
              </p>
              <label className="checkbox">
                <input type="checkbox" checked={status !== "off"} onChange={(e) => setBridgeEnabled(e.target.checked)} />
                Allow assistants to control leocad
                <span className="muted">— {status === "connected" ? "connected" : status === "connecting" ? "waiting for an assistant…" : "off"}</span>
              </label>
              <div className="fld">
                <label>Add this to your MCP client configuration (Claude Desktop: Settings → Developer → Edit Config)</label>
                <pre className="mono" style={{ margin: 0, padding: 10, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap" }}>{config}</pre>
              </div>
              <div className="row">
                <button
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(config).then(() => toast("Configuration copied"));
                  }}
                >
                  <Copy /> Copy configuration
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  Claude Code: <span className="mono">claude mcp add leocad {cmd.env ? Object.entries(cmd.env).map(([k, v]) => `-e ${k}=${v} `).join("") : ""}-- "{cmd.command}" {cmd.args.map((a) => `"${a}"`).join(" ")}</span>
                </span>
              </div>
              {status === "connected" ? (
                <div className="callout info">
                  <Check size={14} /> An assistant is connected. Try: “Make a 60×40×4 mm mounting plate with two 4.5 mm holes”.
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
