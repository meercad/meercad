/** Control schemes: key matching and the scheme tables. */
import { describe, expect, it } from "vitest";
import {
  actionIn,
  CONTROL_SCHEMES,
  eventKey,
  KEY_SCHEMES,
  keymapFor,
  matches,
  MODEL_CONTEXT,
  MOUSE_SCHEMES,
  mouseFor,
  SKETCH_CONTEXT,
  type KeyScheme,
  type MouseScheme,
} from "./controls";

const key = (
  code: string,
  key: string,
  mods: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {},
) => ({
  code,
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("eventKey", () => {
  it("names letters, digits and numpad keys by position and the rest by name", () => {
    expect(eventKey(key("KeyZ", "y"))).toBe("Z");
    expect(eventKey(key("Digit1", "!"))).toBe("1");
    expect(eventKey(key("Numpad7", "Home"))).toBe("Num7");
    expect(eventKey(key("NumpadAdd", "+"))).toBe("+");
    expect(eventKey(key("Space", " "))).toBe("Space");
    expect(eventKey(key("Slash", "/"))).toBe("/");
    expect(eventKey(key("Semicolon", "ö"))).toBe("Ö");
    expect(eventKey(key("Escape", "Escape"))).toBe("Escape");
  });
});

describe("matches and actionIn", () => {
  it("needs the key and exactly the modifiers bound", () => {
    expect(matches(key("KeyE", "e"), "E")).toBe(true);
    expect(matches(key("KeyE", "E", { shiftKey: true }), "E")).toBe(false);
    expect(matches(key("KeyE", "E", { shiftKey: true }), "Shift+E")).toBe(true);
    expect(matches(key("Digit1", "1", { metaKey: true }), "Mod+1")).toBe(true);
    expect(matches(key("Digit1", "1", { ctrlKey: true }), "Mod+1")).toBe(true);
    expect(matches(key("KeyH", "h", { altKey: true }), "Alt+H")).toBe(true);
    expect(matches(key("KeyH", "h", { altKey: true }), "H")).toBe(false);
    expect(matches(key("Equal", "=", { metaKey: true }), "Mod+=")).toBe(true);
    expect(matches(key("BracketRight", "+"), "+")).toBe(true);
  });

  it("finds the first action an event triggers", () => {
    const map = keymapFor("meercad");

    expect(actionIn(map, key("KeyE", "e"), MODEL_CONTEXT)).toBe("extrude");
    expect(actionIn(map, key("KeyL", "l"), SKETCH_CONTEXT)).toBe("sketch.line");
    expect(actionIn(map, key("F13", "F13"), MODEL_CONTEXT)).toBeUndefined();
  });
});

describe("schemes", () => {
  it("falls back to the meerCAD scheme for an unknown id", () => {
    expect(keymapFor("nope" as KeyScheme)).toBe(KEY_SCHEMES[0]!.map);
    expect(mouseFor("nope" as MouseScheme)).toBe(MOUSE_SCHEMES[0]);
    expect(mouseFor("trackpad").rightClick).toBe("menu");
    expect(CONTROL_SCHEMES.map((scheme) => scheme.id)).toEqual(KEY_SCHEMES.map((scheme) => scheme.id));
  });

  it("gives every binding one meaning within the model and within a sketch, in every scheme", () => {
    for (const scheme of KEY_SCHEMES) {
      for (const context of [MODEL_CONTEXT, SKETCH_CONTEXT]) {
        const seen = new Map<string, string>();

        for (const action of context) {
          for (const binding of scheme.map[action]) {
            expect(
              seen.get(binding),
              `${scheme.id}: ${binding} → ${seen.get(binding)} and ${action}`,
            ).toBeUndefined();
            seen.set(binding, action);
          }
        }
      }
    }
  });
});
