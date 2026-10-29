/**
 * The in-app copilot (iPhone and iPad with Apple Intelligence): the native Copilot plugin runs
 * Apple's language model, this side runs its tool calls on the open design and keeps the chat.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { applyOp } from "@meercad/model";
import type { MeercadDocument } from "@meercad/schema";
import { create } from "zustand";
import { apply, currentDoc, getViewport, newProject, rebuildNow, undo, useApp } from "../store";
import { partName } from "./features";
import { INSTRUCTIONS, TOOLS, describe, planTool, type ModelInfo } from "./copilotTools";
import { nativeApp } from "./native";

interface CopilotPlugin {
  availability(): Promise<{ available: boolean; onDevice?: boolean; cloud?: boolean; reason?: string }>;
  ask(o: { prompt: string; tools: typeof TOOLS; instructions: string }): Promise<{ text: string; model: string }>;
  toolResult(o: { id: string; result: string }): Promise<void>;
  reset(): Promise<void>;
  addListener(event: "toolCall", fn: (call: { id: string; name: string; arguments: string }) => void): Promise<PluginListenerHandle>;
}
const Copilot = registerPlugin<CopilotPlugin>("Copilot");

export interface ChatEntry {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
}

export const useCopilot = create<{ open: boolean; busy: boolean; chat: ChatEntry[]; model: string; available: boolean | null; reason: string }>(() => ({
  open: false,
  busy: false,
  chat: [],
  model: "",
  available: null,
  reason: "",
}));

const say = (e: ChatEntry) => useCopilot.setState((s) => ({ chat: [...s.chat, e] }));

let listening: Promise<PluginListenerHandle> | null = null;

/** Whether this device has the copilot (asked once). */
export async function checkCopilot(): Promise<boolean> {
  if (!nativeApp || Capacitor.getPlatform() !== "ios") return false;
  if (useCopilot.getState().available !== null) return useCopilot.getState().available!;
  const a = await Copilot.availability().catch((e: { message?: string }) => ({ available: false, reason: e.message ?? "" }));
  useCopilot.setState({ available: a.available, reason: a.reason ?? "" });
  return a.available;
}

function modelInfo(): ModelInfo {
  const out = useApp.getState().baseOutput;
  const features = currentDoc().features;
  return {
    bodies: (out?.report.bodies ?? []).map((b) => ({ id: b.id, name: partName(b.id, features), bbox: b.bbox })),
    params: out?.report.params ?? {},
  };
}

/** Runs one tool call on the open design and says what happened, in words the model can act on. */
async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (!useApp.getState().project) await newProject();
    const plan = planTool(name, args, currentDoc(), modelInfo());
    if ("text" in plan) return plan.text;
    if ("action" in plan) {
      if (plan.action === "undo") {
        undo();
        await rebuildNow();
        return "undone";
      }
      const vp = getViewport();
      if (plan.view === "fit") vp?.fit();
      else vp?.setView(plan.view as "iso");
      return "ok";
    }
    // Checked first, so a bad call returns a precise error instead of a toast.
    plan.ops.reduce<MeercadDocument>((d, op) => applyOp(d, op), currentDoc());
    if (!apply(...plan.ops)) return "Error: the change was rejected.";
    const out = await rebuildNow();
    const failed = out.report.features.filter((f) => f.status === "error");
    if (failed.length) {
      undo();
      await rebuildNow();
      return `Error: ${failed.map((f) => `${f.message ?? "failed"}${f.hint ? ` (${f.hint})` : ""}`).join("; ")}. The change was undone.`;
    }
    say({ role: "tool", text: plan.note });
    // The current sizes come along, so "5 mm taller" next time starts from the right number.
    return `Done: ${plan.note}.\nNow: ${describe(modelInfo())}`;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function ask(prompt: string): Promise<void> {
  const text = prompt.trim();
  if (!text || useCopilot.getState().busy) return;
  listening ??= Copilot.addListener("toolCall", (c) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.arguments) as Record<string, unknown>;
    } catch {
      // the model sent no usable arguments; the tool says what is missing
    }
    void runTool(c.name, args).then((result) => Copilot.toolResult({ id: c.id, result }));
  });
  await listening;
  say({ role: "user", text });
  useCopilot.setState({ busy: true });
  try {
    const r = await Copilot.ask({ prompt: text, tools: TOOLS, instructions: INSTRUCTIONS });
    useCopilot.setState({ model: r.model });
    say({ role: "assistant", text: r.text });
  } catch (e) {
    say({ role: "error", text: (e as { message?: string }).message ?? String(e) });
  } finally {
    useCopilot.setState({ busy: false });
  }
}

/** Forgets the conversation (the model starts fresh). */
export async function resetCopilot(): Promise<void> {
  await Copilot.reset().catch(() => undefined);
  useCopilot.setState({ chat: [], model: "" });
}
