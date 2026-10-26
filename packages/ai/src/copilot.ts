import Anthropic from "@anthropic-ai/sdk";
import { applyOp } from "@opencad/model";
import type { DocOp, OpencadDocument } from "@opencad/schema";
import { SYSTEM_PROMPT } from "./prompt.js";

/** What the copilot needs to know about a sandbox rebuild (a subset of the kernel's RebuildReport). */
export interface SandboxReport {
  features: { id: string; status: string; message?: string; hint?: string }[];
  paramErrors: Record<string, string>;
  bodies: { id: string; volume: number; bbox: { min: number[]; max: number[] } }[];
  sketches?: { id: string; diagnostics: { dof: number; ok: boolean } }[];
}

export type Sandbox = (doc: OpencadDocument) => Promise<SandboxReport>;

export interface Evaluation {
  ok: boolean;
  doc: OpencadDocument;
  report: SandboxReport | null;
  errors: string[];
}

/** Applies ops to a copy of `doc` and rebuilds it in the sandbox. Errors are phrased for the model. */
export async function evaluateOps(doc: OpencadDocument, ops: unknown, sandbox: Sandbox): Promise<Evaluation> {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, doc, report: null, errors: ["`ops` must be a non-empty array"] };
  let next = doc;
  for (const [i, op] of ops.entries()) {
    try {
      next = applyOp(next, op);
    } catch (e) {
      return { ok: false, doc, report: null, errors: [`op ${i}: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  const report = await sandbox(next);
  const errors = [
    ...Object.entries(report.paramErrors).map(([k, v]) => `param ${k}: ${v}`),
    ...report.features
      .filter((f) => f.status === "error")
      .map((f) => `feature ${f.id}: ${f.message ?? "failed"}${f.hint ? ` (hint: ${f.hint})` : ""}`),
  ];
  return { ok: errors.length === 0, doc: next, report, errors };
}

export function describeReport(r: SandboxReport): string {
  const bodies = r.bodies.map(
    (b) => `${b.id}: volume ${b.volume.toFixed(1)} mm³, bbox ${b.bbox.min.map((v) => v.toFixed(1)).join(",")} → ${b.bbox.max.map((v) => v.toFixed(1)).join(",")}`,
  );
  const warnings = r.features.filter((f) => f.status === "warning").map((f) => `${f.id}: ${f.message}`);
  const sketches = (r.sketches ?? []).map((s) => `${s.id}: ${s.diagnostics.ok ? (s.diagnostics.dof ? `${s.diagnostics.dof} DOF left` : "fully constrained") : "over-constrained"}`);
  return [
    `bodies: ${bodies.join("; ") || "none"}`,
    ...(sketches.length ? [`sketches: ${sketches.join("; ")}`] : []),
    ...(warnings.length ? [`warnings: ${warnings.join("; ")}`] : []),
  ].join("\n");
}

export interface Proposal {
  ok: boolean;
  /** Successfully applied ops, in order; accepting them is one undo step. */
  ops: DocOp[];
  doc: OpencadDocument;
  report: SandboxReport | null;
  errors: string[];
  summary: string;
  iterations: number;
}

export interface CopilotOptions {
  apiKey: string;
  prompt: string;
  doc: OpencadDocument;
  /** Last rebuild of `doc`, so the model sees body sizes and errors. */
  report?: SandboxReport;
  sandbox: Sandbox;
  model?: string;
  maxIterations?: number;
  signal?: AbortSignal;
  /** For tests: a client with the same `beta.messages.create` surface. */
  client?: Pick<Anthropic, "beta">;
  onProgress?: (message: string) => void;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

const APPLY_OPS: Anthropic.Beta.BetaTool = {
  name: "apply_ops",
  description:
    "Apply Operations-API ops to the sandbox copy of the document and rebuild it. Returns the rebuild result or the errors to fix. Ops from successful calls accumulate.",
  input_schema: {
    type: "object",
    properties: {
      ops: {
        type: "array",
        minItems: 1,
        description: "Ops as described in the system prompt's JSON Schema.",
        items: {
          type: "object",
          properties: { type: { type: "string", enum: ["add_features", "edit_feature", "delete_feature", "set_param", "set_rollback", "replace"] } },
          required: ["type"],
        },
      },
    },
    required: ["ops"],
  },
};

/**
 * BYOK agent loop (§6.3): propose → sandbox rebuild → feed errors back → repeat. Calls go straight from
 * the browser to Anthropic with the user's key; nothing passes through an opencad server.
 */
export async function proposeWithClaude(opts: CopilotOptions): Promise<Proposal> {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: true });
  const maxIterations = opts.maxIterations ?? 5;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content: [
        `Current document:\n${JSON.stringify(opts.doc)}`,
        opts.report ? `Last rebuild:\n${describeReport(opts.report)}` : "",
        `Request: ${opts.prompt}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  let doc = opts.doc;
  let report = opts.report ?? null;
  const ops: DocOp[] = [];
  let errors: string[] = [];
  let summary = "";

  for (let iteration = 1; iteration <= maxIterations + 1; iteration++) {
    const response = await client.beta.messages.create(
      {
        model: opts.model ?? DEFAULT_MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: SYSTEM_PROMPT,
        tools: [APPLY_OPS],
        tool_choice: { type: "auto" },
        messages,
      },
      { signal: opts.signal },
    );
    if (response.stop_reason === "refusal") {
      return { ok: false, ops, doc, report, errors: ["the model declined this request"], summary: "", iterations: iteration };
    }
    // Append the full content (thinking blocks included) so the conversation stays valid.
    messages.push({ role: "assistant", content: response.content });
    summary = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (calls.length === 0 || iteration > maxIterations) {
      return { ok: errors.length === 0 && ops.length > 0, ops, doc, report, errors, summary, iterations: iteration };
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const input = call.input as { ops?: unknown };
      opts.onProgress?.(`Checking proposal ${iteration}…`);
      const ev = call.name === "apply_ops" ? await evaluateOps(doc, input.ops, opts.sandbox) : { ok: false, doc, report: null, errors: [`unknown tool ${call.name}`] };
      errors = ev.errors;
      if (ev.ok) {
        doc = ev.doc;
        report = ev.report;
        ops.push(...(input.ops as DocOp[]));
        results.push({ type: "tool_result", tool_use_id: call.id, content: `Rebuild OK.\n${describeReport(ev.report!)}` });
      } else {
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: `Not applied. Fix these and call apply_ops again:\n${ev.errors.join("\n")}` });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return { ok: false, ops, doc, report, errors: [...errors, "iteration limit reached"], summary, iterations: maxIterations };
}
