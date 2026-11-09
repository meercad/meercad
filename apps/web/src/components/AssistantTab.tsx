/**
 * Assistants' tabs (Mac app, MCP): every assistant session works on its project in a tab of its
 * own, a page of its own that the main process lays over the window below the top bar while the
 * tab is open. The window's page draws the top bar with the tab strip and leaves the room
 * (AssistantPane); the assistant's page shows the model, locked, with a bar that says what the
 * assistant is doing and lets the user take over (AssistantBar).
 */
import { House } from "lucide-react";
import { useEffect, useRef } from "react";
import { ASSISTANT_IDLE_MS } from "@meercad/mcp";
import { stopAssistant } from "../lib/mcpBridge";
import { assistantWindow, desktop } from "../lib/persistence";
import { t } from "../lib/i18n";
import { goHome, useApp } from "../store";
import { AiOrb, toolLabel } from "./AiOrb";
import { McpButton } from "./McpButton";
import { TabStrip } from "./Tabs";

/** In the window's page: the top bar with the tabs, and room for the assistant's tab below it. */
export function AssistantPane({ session }: { session: string }) {
  const slot = useRef<HTMLDivElement>(null);
  const tab = useApp((s) => s.assistantTabs.find((a) => a.session === session));
  useEffect(() => {
    const el = slot.current;
    const a = desktop?.assistant;
    if (!el || !a) return;
    const place = () => {
      const r = el.getBoundingClientRect();
      a.show({ session, rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      a.show(null);
    };
  }, [session]);
  return (
    <div className="assistant-pane">
      <header className={`topbar ${desktop ? "desktop" : ""}`}>
        <button className="icon-btn" onClick={goHome} title={t("All projects")}>
          <House />
        </button>
        <TabStrip />
        <span className="mcp-anchor">
          <McpButton />
        </span>
      </header>
      {/* The assistant's page is laid over this room; until it has loaded, this shows. */}
      <div className="assistant-slot" ref={slot}>
        <AiOrb busy />
        <span>{t("{client} is opening the project…", { client: tab?.client ?? "Claude" })}</span>
      </div>
    </div>
  );
}

/** In an assistant's tab: who is working and on what, and Take over. */
export function AssistantBar() {
  const lock = useApp((s) => s.aiLock);
  const tool = useApp((s) => s.aiActivity?.tool);
  const project = useApp((s) => s.project);
  const client = assistantWindow?.client ?? lock?.client ?? "Claude";
  const busy = !!lock;
  const doing = busy ? toolLabel(tool) : null;
  return (
    <div className={`assistant-bar ${busy ? "busy" : ""}`} role="status">
      <AiOrb busy={busy} />
      <div className="assistant-bar-text">
        <b>{busy ? t("{client} is working on this model", { client }) : t("{client} has this model open", { client })}</b>
        <small>
          {doing ? (
            <span className="assistant-tool" key={doing}>
              {doing}
            </span>
          ) : (
            <span>{busy ? t("Working…") : t("Waiting for the next step · yours again after {min} minutes without one", { min: ASSISTANT_IDLE_MS / 60_000 })}</span>
          )}
          {project ? <span className="muted"> · {project.name}</span> : null}
        </small>
      </div>
      <button className="btn" onClick={stopAssistant} title={t("{client} stops working on it; the project opens in a tab of yours", { client })}>
        {t("Take over")}
      </button>
    </div>
  );
}
