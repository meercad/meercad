import { stopAssistant } from "../lib/mcpBridge";
import { assistantWindow } from "../lib/persistence";
import { t } from "../lib/i18n";
import { useApp } from "../store";
import { AiOrb, toolLabel } from "./AiOrb";
import { AssistantBar } from "./AssistantTab";

/**
 * While an assistant works on the model (MCP), a layer over the app takes clicks and touches. An
 * assistant's own tab (Mac app) is locked all the time, glowing while it works, with a bar that says
 * what it does and offers Take over; elsewhere (the web app) a bar says who is working and offers to
 * stop it. Keys are held back in mcpBridge.
 */
export function AiLock() {
  const lock = useApp((state) => state.aiLock);
  const tool = useApp((state) => state.aiActivity?.tool);

  if (assistantWindow) {
    return (
      <>
        <div
          className={`ai-lock in-tab ${lock ? "busy" : ""}`}
          onContextMenu={(event) => event.preventDefault()}
        />
        <AssistantBar />
      </>
    );
  }

  if (!lock) return null;

  const doing = toolLabel(tool);

  return (
    <div className="ai-lock" onContextMenu={(event) => event.preventDefault()}>
      <div className="ai-lock-bar" role="status">
        <AiOrb busy />
        <span>
          <b>{t("{client} is working on the model", { client: lock.client })}</b>
          {doing ? <span className="muted"> · {doing}</span> : null}
        </span>
        <button className="btn primary" onClick={stopAssistant}>
          {t("Stop editing")}
        </button>
      </div>
    </div>
  );
}
