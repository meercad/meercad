import { stopAssistant } from "../lib/mcpBridge";
import { t } from "../lib/i18n";
import { useApp } from "../store";

/**
 * While an assistant works on the model (MCP), a layer over the whole app takes clicks and touches,
 * and a bar says who is working and offers to stop it. Keys are held back in mcpBridge.
 */
export function AiLock() {
  const lock = useApp((s) => s.aiLock);
  const tool = useApp((s) => s.aiActivity?.tool);
  if (!lock) return null;
  return (
    <div className="ai-lock" onContextMenu={(e) => e.preventDefault()}>
      <div className="ai-lock-bar" role="status">
        <span className="pulse" />
        <span>
          {t("{client} is working on the model", { client: lock.client })}
          {tool ? <span className="muted"> · {tool.replace(/_/g, " ")}</span> : null}
        </span>
        <button className="btn primary" onClick={stopAssistant}>
          {t("Stop editing")}
        </button>
      </div>
    </div>
  );
}
