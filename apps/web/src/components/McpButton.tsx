import { Check, Copy, Plug, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { bridgeStatus, onBridgeStatus, setBridgeEnabled } from "../lib/mcpBridge";
import { toast } from "../store";
import { t } from "../lib/i18n";

import { desktop } from "../lib/persistence";

/** Toolbar button showing the MCP bridge state, with setup instructions for Claude. */
export function McpButton() {
  const [status, setStatus] = useState(bridgeStatus());
  const [open, setOpen] = useState(false);
  const [mas, setMas] = useState(false);
  const [cmd, setCmd] = useState<{ command: string; args: string[]; env?: Record<string, string> }>({ command: "node", args: ["<path to meerCAD>/packages/mcp/dist/server.js"] });
  useEffect(() => {
    const off = onBridgeStatus(setStatus);
    void desktop?.info().then((i) => {
      setCmd(i.mcpCommand);
      setMas(i.mas === true);
    });
    return () => void off();
  }, []);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  const config = JSON.stringify({ mcpServers: { meercad: cmd } }, null, 2);
  return (
    <>
      <button className={`icon-btn ${status === "connected" ? "active" : ""}`} title={t("AI assistants (MCP): {status}", { status: status === "connected" ? t("connected") : status === "connecting" ? t("connecting") : t("off") })} onClick={() => setOpen(true)}>
        <Plug />
        <span className="mcp-dot" data-status={status} />
      </button>
      {open ? createPortal(
        <div className="modal-backdrop" onPointerDown={() => setOpen(false)}>
          <div className="modal" style={{ width: "min(620px, 94vw)" }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <Plug className="ficon" />
              <h3>{t("Connect AI assistants (MCP)")}</h3>
              <button className="icon-btn sm" onClick={() => setOpen(false)} aria-label={t("Close")}>
                <X />
              </button>
            </div>
            <div className="dialog-body">
              <p style={{ margin: 0 }}>
                {t(
                  "Lets Claude Desktop, Claude Code or any MCP client read and change the open model: create sketches and features, edit parameters, render views, measure and export. Everything stays on this computer.",
                )}
              </p>
              <label className="checkbox">
                <input type="checkbox" checked={status !== "off"} onChange={(e) => setBridgeEnabled(e.target.checked)} />
                {t("Allow assistants to control meerCAD")}
                <span className="muted">— {status === "connected" ? t("connected") : status === "connecting" ? t("waiting for an assistant…") : t("off")}</span>
              </label>
              {desktop ? (
                <div className="row">
                  <button
                    className="btn primary"
                    onClick={() =>
                      void desktop!.installClaudeDesktop().then(
                        (file) =>
                          toast(file ? t("Added to Claude Desktop ({file}). Restart Claude Desktop to connect.", { file }) : t("Claude Desktop opens the meerCAD extension: confirm the installation there.")),
                        (e: unknown) => toast(t("Could not update the Claude Desktop config: {msg}", { msg: e instanceof Error ? e.message : String(e) }), "error"),
                      )
                    }
                  >
                    <Plug /> {t("Add to Claude Desktop")}
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {mas ? t("Installs meerCAD as an extension in Claude Desktop.") : t("Writes the entry below into Claude Desktop's config; other servers stay untouched.")}
                  </span>
                </div>
              ) : null}
              <div className="fld">
                <label>{desktop ? t("Or add this to any MCP client configuration (Claude Desktop: Settings → Developer → Edit Config)") : t("Add this to any MCP client configuration (Claude Desktop: Settings → Developer → Edit Config)")}</label>
                {mas ? <span className="muted" style={{ fontSize: 12 }}>{t("Other assistants start the server with Node.js; install it from nodejs.org if you do not have it yet.")}</span> : null}
                <pre className="mono" style={{ margin: 0, padding: 10, background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap" }}>{config}</pre>
              </div>
              <div className="row">
                <button
                  className="btn"
                  onClick={() => {
                    void navigator.clipboard.writeText(config).then(() => toast(t("Configuration copied")));
                  }}
                >
                  <Copy /> {t("Copy configuration")}
                </button>
                <span className="muted" style={{ fontSize: 12 }}>
                  Claude Code: <span className="mono">claude mcp add meercad {cmd.env ? Object.entries(cmd.env).map(([k, v]) => `-e ${k}=${v} `).join("") : ""}-- "{cmd.command}" {cmd.args.map((a) => `"${a}"`).join(" ")}</span>
                </span>
              </div>
              {status === "connected" ? (
                <div className="callout info">
                  <Check size={14} /> {t("An assistant is connected. Try: “Make a 60×40×4 mm mounting plate with two 4.5 mm holes”.")}
                </div>
              ) : null}
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
