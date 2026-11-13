/**
 * Open projects as tabs: click to switch, double-click the active one to rename, drag to reorder.
 * After them the assistants' tabs (Mac app): locked, they show who works on what.
 */
import { Lock, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  closeTab,
  handOverAssistantTab,
  moveTab,
  newProject,
  openProject,
  renameProject,
  showAssistantTab,
  useApp,
} from "../store";
import { AiOrb, toolLabel } from "./AiOrb";
import { t } from "../lib/i18n";

const DRAG_TYPE = "application/x-meercad-tab";

export function TabStrip() {
  const tabs = useApp((state) => state.tabs);
  const activeId = useApp((state) => (state.screen === "editor" ? state.project?.id : null));
  const saveState = useApp((state) => state.saveState);
  const tasks = useApp((state) => state.tasks);
  const assistantTabs = useApp((state) => state.assistantTabs);
  const openAssistant = useApp((state) => state.assistantTab);
  const [editing, setEditing] = useState(false);
  const [dropBefore, setDropBefore] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  // With more tabs than fit, the strip scrolls: keep the open one in view.
  useEffect(() => {
    strip.current?.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, openAssistant, tabs.length, assistantTabs.length]);

  return (
    <div className="tabs" role="tablist" aria-label={t("Open projects")} ref={strip}>
      {tabs.map((tab) => {
        const active = tab.id === activeId;

        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className={`tab ${active ? "active" : ""} ${dropBefore === tab.id ? "drop-before" : ""}`}
            title={((name) => (active ? t("{name} — double-click to rename", { name }) : name))(
              `${tab.folder ? `${tab.folder.split("/").join(" › ")} › ` : ""}${tab.name}`,
            )}
            draggable={!editing}
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_TYPE, tab.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;

              event.preventDefault();
              setDropBefore(tab.id);
            }}
            onDragLeave={() => setDropBefore(null)}
            onDrop={(event) => {
              event.preventDefault();
              setDropBefore(null);

              const id = event.dataTransfer.getData(DRAG_TYPE);
              if (id && id !== tab.id) moveTab(id, tab.id);
            }}
            onClick={() => void openProject(tab.id)}
            onKeyDown={(event) => event.key === "Enter" && !editing && void openProject(tab.id)}
            onAuxClick={(event) => event.button === 1 && closeTab(tab.id)}
            onDoubleClick={() => active && setEditing(true)}
          >
            {active && editing ? (
              <input
                autoFocus
                className="tab-name-input"
                defaultValue={tab.name}
                aria-label={t("Project name")}
                onFocus={(event) => event.target.select()}
                onClick={(event) => event.stopPropagation()}
                onBlur={(event) => {
                  setEditing(false);
                  void renameProject(event.target.value);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();

                  if (event.key === "Escape") {
                    (event.target as HTMLInputElement).value = tab.name;
                    (event.target as HTMLInputElement).blur();
                  }
                }}
              />
            ) : (
              <span className="tab-name">{tab.name}</span>
            )}
            {((work) =>
              work ? (
                <i
                  className={`tab-progress ${work.progress === null ? "indeterminate" : ""}`}
                  title={`${work.label}${work.progress !== null ? ` · ${Math.round(work.progress * 100)} %` : ""}`}
                  style={{ "--p": `${Math.round((work.progress ?? 0.25) * 360)}deg` } as CSSProperties}
                />
              ) : null)(tasks.find((x) => x.project === tab.id))}
            {active && saveState !== "saved" ? (
              <i className="tab-dirty" title={saveState === "saving" ? t("Saving…") : t("Unsaved changes")} />
            ) : null}
            <button
              className="tab-close"
              title={t("Close tab (⌘W)")}
              onClick={(event) => {
                event.stopPropagation();
                closeTab(tab.id);
              }}
            >
              <X />
            </button>
          </div>
        );
      })}
      {assistantTabs.map((a) => {
        const active = a.session === openAssistant;
        const doing = a.busy ? toolLabel(a.tool) : null;

        return (
          <div
            key={a.session}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            className={`tab ai-tab ${active ? "active" : ""} ${a.busy ? "busy" : ""}`}
            title={[
              a.name,
              a.busy ? (doing ?? t("Being worked on")) : null,
              t("Locked while an assistant works on it"),
            ]
              .filter(Boolean)
              .join("\n")}
            onClick={() => showAssistantTab(a.session)}
            onKeyDown={(event) => event.key === "Enter" && showAssistantTab(a.session)}
          >
            {a.busy && <AiOrb busy small />}
            <span className="tab-name">{a.name ?? t("Opening…")}</span>
            <Lock className="tab-lock" />
            <button
              className="tab-close"
              title={t("Close: the assistant stops working on it")}
              onClick={(event) => {
                event.stopPropagation();
                void handOverAssistantTab(a.session, false);
              }}
            >
              <X />
            </button>
          </div>
        );
      })}
      <button className="icon-btn sm tab-new" title={t("New part (⌘T)")} onClick={() => void newProject()}>
        <Plus />
      </button>
    </div>
  );
}
