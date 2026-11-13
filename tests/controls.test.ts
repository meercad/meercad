/** Control schemes: within one place (the model, a sketch) every key means one thing. */
import { describe, expect, it } from "vitest";
import {
  actionIn,
  KEY_SCHEMES,
  keymapFor,
  matches,
  MODEL_CONTEXT,
  MOUSE_SCHEMES,
  SKETCH_CONTEXT,
  CONTROL_SCHEMES,
} from "../apps/web/src/lib/controls";

const key = (code: string, key: string, mods: { shift?: boolean; mod?: boolean; alt?: boolean } = {}) => ({
  code,
  key,
  metaKey: !!mods.mod,
  ctrlKey: false,
  shiftKey: !!mods.shift,
  altKey: !!mods.alt,
});

describe("control schemes", () => {
  for (const s of KEY_SCHEMES) {
    for (const [where, ctx] of [
      ["model", MODEL_CONTEXT],
      ["sketch", SKETCH_CONTEXT],
    ] as const) {
      it(`${s.label}: no key does two things in the ${where}`, () => {
        const seen = new Map<string, string>();
        const clash: string[] = [];

        for (const a of ctx) {
          for (const b of s.map[a]) {
            const before = seen.get(b);
            if (before) clash.push(`${b}: ${before} / ${a}`);

            seen.set(b, a);
          }
        }

        expect(clash).toEqual([]);
      });
    }
  }

  it("every whole scheme has its keys and its mouse", () => {
    for (const c of CONTROL_SCHEMES) {
      expect(KEY_SCHEMES.some((k) => k.id === c.keys)).toBe(true);
      expect(MOUSE_SCHEMES.some((m) => m.id === c.mouse)).toBe(true);
    }
  });

  it("matches modifiers exactly", () => {
    expect(matches(key("KeyE", "e"), "E")).toBe(true);
    expect(matches(key("KeyE", "E", { shift: true }), "E")).toBe(false);
    expect(matches(key("KeyE", "E", { shift: true }), "Shift+E")).toBe(true);
    expect(matches(key("Equal", "=", { mod: true }), "Mod+=")).toBe(true);
    expect(matches(key("Numpad1", "1"), "Num1")).toBe(true);
    expect(matches(key("Digit1", "1"), "Num1")).toBe(false);
  });

  it("Plasticity: F searches, X deletes, right drag pans and a right click confirms", () => {
    const map = keymapFor("plasticity");
    expect(actionIn(map, key("KeyF", "f"), MODEL_CONTEXT)).toBe("palette");
    expect(actionIn(map, key("KeyX", "x"), MODEL_CONTEXT)).toBe("delete");
    expect(actionIn(map, key("KeyX", "x"), SKETCH_CONTEXT)).toBe("delete");
    expect(actionIn(map, key("KeyG", "g"), MODEL_CONTEXT)).toBe("transform");
    expect(actionIn(map, key("KeyA", "A", { shift: true }), SKETCH_CONTEXT)).toBe("sketch.line");
    expect(actionIn(map, key("Enter", "Enter"), SKETCH_CONTEXT)).toBe("confirm");

    const mouse = MOUSE_SCHEMES.find((m) => m.id === "plasticity")!;
    expect(mouse.nav.pan).toContainEqual({ button: "right" });
    expect(mouse.nav.orbit).toContainEqual({ button: "middle" });
    expect(mouse.rightClick).toBe("confirm");
  });

  it("every scheme has command search, confirm and cancel", () => {
    for (const s of KEY_SCHEMES) {
      expect(s.map.palette.length, s.id).toBeGreaterThan(0);
      expect(s.map.confirm, s.id).toContain("Enter");
      expect(s.map.cancel, s.id).toContain("Escape");
    }
  });
});
