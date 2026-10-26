import { describe, expect, it } from "vitest";
import { proposeWithClaude, type Sandbox } from "@opencad/ai";
import { KernelSession } from "@opencad/kernel";
import { emptyDocument } from "@opencad/schema";
import { getOcct } from "./helpers.js";

const sandbox: Sandbox = async (doc) => {
  const s = new KernelSession(await getOcct());
  try {
    return s.rebuild(doc, { mesh: false }).report;
  } finally {
    s.dispose();
  }
};

/** 40×20×10 box with r=2 on the 4 top edges: the naive edge-length formula over-subtracts at the corners. */
function expectTopFilletedBox(volume: number) {
  const naive = 8000 - 120 * 4 * (1 - Math.PI / 4);
  expect(volume).toBeGreaterThan(naive);
  expect(volume).toBeLessThan(naive + 4 * 8 * (1 - Math.PI / 4));
}

const boxOps = (filletEdges: unknown) => [
  { type: "set_param", name: "w", expr: "40 mm" },
  { type: "set_param", name: "d", expr: "20 mm" },
  { type: "set_param", name: "h", expr: "10 mm" },
  {
    type: "add_features",
    features: [
      { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: [{ id: "r1", type: "rectangle", corner: [0, 0], size: ["w", "d"] }] },
      { id: "ex1", op: "extrude", profile: { ref: "sk1.r1.region" }, distance: "h", mode: "new_body" },
      { id: "fi1", op: "fillet", edges: filletEdges, radius: "2 mm" },
    ],
  },
];

/** Fake client replaying scripted assistant turns and recording what it was sent. */
function scripted(turns: unknown[][]) {
  const sent: { messages: { role: string; content: unknown }[] }[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: { messages: { role: string; content: unknown }[] }) => {
          sent.push(structuredClone(params));
          const content = turns.shift() ?? [{ type: "text", text: "done" }];
          return { stop_reason: content.some((c) => (c as { type: string }).type === "tool_use") ? "tool_use" : "end_turn", content };
        },
      },
    },
  };
  return { client: client as never, sent };
}

describe("AI copilot loop (scripted model, real kernel)", () => {
  it("feeds kernel errors back and returns the corrected proposal", async () => {
    const { client, sent } = scripted([
      [{ type: "tool_use", id: "t1", name: "apply_ops", input: { ops: boxOps({ edge: ["ex1.top_cap", "ex1.side[*]"] }) } }],
      [{ type: "tool_use", id: "t2", name: "apply_ops", input: { ops: boxOps({ select: "edges", of: "ex1", where: { face: "end_cap" } }) } }],
      [{ type: "text", text: "Added a 40×20×10 box with 2 mm fillets on the top edges." }],
    ]);
    const p = await proposeWithClaude({ apiKey: "test", client, prompt: "Box 40×20×10, 2 mm fillet on the top edges", doc: emptyDocument(), sandbox });
    expect(p.ok).toBe(true);
    expect(p.iterations).toBe(3);
    expect(p.summary).toMatch(/40×20×10/);
    expect(p.ops).toHaveLength(4);
    expectTopFilletedBox(p.report!.bodies[0]!.volume);
    // The second request carried the kernel's error as an is_error tool result.
    const feedback = JSON.stringify(sent[1]!.messages.at(-1));
    expect(feedback).toContain("is_error");
    expect(feedback).toContain("no edge between");
  });

  it("rejects schema-invalid ops before they reach the kernel", async () => {
    const { client, sent } = scripted([[{ type: "tool_use", id: "t1", name: "apply_ops", input: { ops: [{ type: "add_features", features: [{ id: "x", op: "loft" }] }] } }]]);
    const p = await proposeWithClaude({ apiKey: "test", client, prompt: "loft", doc: emptyDocument(), sandbox, maxIterations: 1 });
    expect(p.ok).toBe(false);
    expect(JSON.stringify(sent[1]!.messages.at(-1))).toContain("invalid op");
  });
});

// Phase 0 criterion 5 against the real API. Costs money: opt in with OPENCAD_LIVE_AI=1 and ANTHROPIC_API_KEY.
const live = process.env["OPENCAD_LIVE_AI"] === "1" && !!process.env["ANTHROPIC_API_KEY"];
describe.runIf(live)("AI copilot (live)", () => {
  it("5: 'Box 40×20×10, 2 mm Fillet an den oberen Kanten' yields a valid log that rebuilds", async () => {
    const p = await proposeWithClaude({
      apiKey: process.env["ANTHROPIC_API_KEY"]!,
      prompt: "Box 40×20×10, 2 mm Fillet an den oberen Kanten",
      doc: emptyDocument(),
      sandbox,
    });
    expect(p.errors).toEqual([]);
    expect(p.ok).toBe(true);
    const b = p.report!.bodies[0]!;
    const dims = b.bbox.max.map((v, i) => v - b.bbox.min[i]!).sort((x, y) => x - y);
    expect(dims[0]).toBeCloseTo(10, 3);
    expect(dims[1]).toBeCloseTo(20, 3);
    expect(dims[2]).toBeCloseTo(40, 3);
    expectTopFilletedBox(b.volume);
  }, 300_000);
});
