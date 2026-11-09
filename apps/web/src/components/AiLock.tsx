import { assistantStopped, stopAssistant } from "../lib/mcpBridge";
import { assistantWindow } from "../lib/persistence";
import { t } from "../lib/i18n";
import { useApp } from "../store";

/**
 * While an assistant works on the model (MCP), a layer over the whole app takes clicks and touches,
 * and a bar says who is working and offers to stop it. Keys are held back in mcpBridge.
 */
export function AiLock() {
  const lock = useApp((s) => s.aiLock);
  const tool = useApp((s) => s.aiActivity?.tool);
  const ended = useApp((s) => s.aiSessionEnded);
  // An assistant's own window says whose it is, also between its requests.
  if (!lock && assistantWindow)
    return (
      <div className="ai-window-badge" role="status">
        {ended ? t("{client} is done here; the window is yours now", { client: assistantWindow.client }) : assistantStopped() ? t("Stopped: {client} no longer edits in this window", { client: assistantWindow.client }) : t("{client}'s window", { client: assistantWindow.client })}
      </div>
    );
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
