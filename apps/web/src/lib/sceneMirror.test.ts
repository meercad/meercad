import type { SceneTextSpec, Viewport } from "@meercad/viewport";
import { describe, expect, it } from "vitest";
import { dropMirrors, firmFill, IN_SCENE, lookOf, mirror, rgba, shadowColor } from "./sceneMirror";

describe("colours", () => {
  it("reads rgb() and rgba()", () => {
    expect(rgba("rgb(1, 2, 3)")).toEqual([1, 2, 3, 1]);
    expect(rgba("rgba(1, 2, 3, 0.5)")).toEqual([1, 2, 3, 0.5]);
    expect(rgba("rgb(1 2 3 / 0.25)")).toEqual([1, 2, 3, 0.25]);
    expect(rgba("#fff")).toBeNull();
    expect(rgba("rgb(1, x, 3)")).toBeNull();
    expect(rgba("rgb(1, 2)")).toBeNull();
  });

  it("takes a halo's colour from the text shadow", () => {
    expect(shadowColor("rgb(255, 255, 255) 0px 0px 2px, rgb(255, 255, 255) 0px 0px 3px")).toBe(
      "rgb(255, 255, 255)",
    );
    expect(shadowColor("#fff 0 0 2px")).toBe("#fff");
    expect(shadowColor("none")).toBeUndefined();
    expect(shadowColor("")).toBeUndefined();
  });

  it("makes a see-through chip firm (no blur behind it in the picture)", () => {
    expect(firmFill("rgba(255, 255, 255, 0.6)")).toBe("rgba(255, 255, 255, 0.97)");
    expect(firmFill("rgb(255, 255, 255)")).toBe("rgb(255, 255, 255)");
    expect(firmFill("white")).toBe("white");
  });
});

describe("lookOf", () => {
  const element = (style: string, text = "70 mm") => {
    const e = document.createElement("button");
    e.textContent = text;
    e.setAttribute("style", style);
    document.body.append(e);

    return e;
  };

  it("copies plain text with its halo", () => {
    const look = lookOf(
      element(
        "font: 600 12.5px monospace; color: rgb(10, 20, 30); background: transparent; border: none; text-shadow: rgb(255, 255, 255) 0 0 2px",
      ),
    )!;
    expect(look.text).toBe("70 mm");
    expect(look.color).toBe("rgb(10, 20, 30)");
    expect(look.font).toContain("12.5px");
    expect(look.halo).toBe("rgb(255, 255, 255)");
    expect(look.chip).toBeUndefined();
  });

  it("copies a chip with its fill, border and corners", () => {
    const look = lookOf(
      element(
        "background-color: rgba(255, 255, 255, 0.5); border: 1px dashed rgb(1, 2, 3); border-radius: 999px",
      ),
    )!;
    expect(look.chip).toEqual({
      fill: "rgba(255, 255, 255, 0.97)",
      border: "rgb(1, 2, 3)",
      radius: 999,
      dashed: true,
    });

    const bordered = lookOf(element("background: transparent; border: 1px solid rgb(1, 2, 3)"))!;
    expect(bordered.chip!.fill).toBe("rgba(0, 0, 0, 0)");
    expect(bordered.chip!.radius).toBe(0);

    const filled = lookOf(element("background-color: rgb(9, 9, 9); border: none"))!;
    expect(filled.chip!.border).toBe("rgba(0, 0, 0, 0)");
  });

  it("has nothing to copy without text", () => {
    expect(lookOf(element("", "  "))).toBeNull();
  });
});

describe("mirror", () => {
  function fakeViewport(screen: [number, number] | null = [100, 50]) {
    const shown = new Map<string, SceneTextSpec>();
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 600 }) as DOMRect;

    const viewport = {
      canvas,
      worldToScreen: () => screen,
      texts: {
        set: (id: string, spec: SceneTextSpec | null) => (spec ? shown.set(id, spec) : shown.delete(id)),
        ids: () => [...shown.keys()],
      },
    } as unknown as Viewport;

    return { viewport, shown };
  }

  const chip = (inner = "<button>12 mm</button>") => {
    const e = document.createElement("div");
    e.innerHTML = inner;
    document.body.append(e);

    const button = e.querySelector("button");

    if (button) {
      button.getBoundingClientRect = () => ({ left: 130, top: 60, width: 40, height: 20 }) as DOMRect;
    }

    return e;
  };

  it("lays a value into its plane and hides its element", () => {
    const { viewport, shown } = fakeViewport();
    const e = chip();
    const corners = [
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
      [0, 0, 0],
    ] as const;
    mirror(viewport, "v:a", e, { corners, size: [40, 18] });
    expect(shown.get("v:a")).toMatchObject({ size: [40, 18], corners });
    expect(shown.get("v:a")!.look.text).toBe("12 mm");
    expect(e.classList.contains(IN_SCENE)).toBe(true);
  });

  it("hides a value lying on a face behind parts when asked", () => {
    const { viewport, shown } = fakeViewport();
    const corners = [
      [0, 1, 0],
      [1, 1, 0],
      [1, 0, 0],
      [0, 0, 0],
    ] as const;
    mirror(viewport, "v:z", chip(), { corners, size: [40, 18], hides: true });
    expect(shown.get("v:z")!.hides).toBe(true);
  });

  it("faces the screen where its element is, anchored to a point", () => {
    const { viewport, shown } = fakeViewport();
    mirror(viewport, "v:b", chip(), { at: [1, 2, 3] });
    // The button's centre (150, 70) on the page is (140, 50) on the canvas: 40 right of the point.
    expect(shown.get("v:b")).toMatchObject({ at: [1, 2, 3], size: [40, 20], offset: [40, 0] });
  });

  it("shows the element itself while it is typed into, unseen or behind the camera", () => {
    const { viewport, shown } = fakeViewport();
    const typing = chip("<input />");
    mirror(viewport, "v:c", typing, { at: [0, 0, 0] });
    expect(shown.has("v:c")).toBe(false);
    expect(typing.classList.contains(IN_SCENE)).toBe(false);

    const linked = chip('<button>4 mm</button><button class="unlink">x</button>');
    mirror(viewport, "v:d", linked, { at: [0, 0, 0] });
    expect(shown.has("v:d")).toBe(false);

    const gone = chip();
    gone.style.display = "none";
    mirror(viewport, "v:e", gone, { at: [0, 0, 0] });
    expect(shown.has("v:e")).toBe(false);

    const behind = fakeViewport(null);
    mirror(behind.viewport, "v:f", chip(), { at: [0, 0, 0] });
    expect(behind.shown.has("v:f")).toBe(false);

    const empty = chip();
    empty.querySelector("button")!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect;
    mirror(viewport, "v:g", empty, { at: [0, 0, 0] });
    expect(shown.has("v:g")).toBe(false);
  });

  it("copies a label without a button as it is", () => {
    const { viewport, shown } = fakeViewport();
    const label = document.createElement("div");
    label.textContent = "21°";
    document.body.append(label);
    label.getBoundingClientRect = () => ({ left: 100, top: 60, width: 30, height: 18 }) as DOMRect;
    mirror(viewport, "v:h", label, { at: [0, 0, 0] });
    expect(shown.get("v:h")!.look.text).toBe("21°");
  });

  it("drops the copies no longer shown, under its prefix only", () => {
    const { viewport, shown } = fakeViewport();
    mirror(viewport, "v:a", chip(), { at: [0, 0, 0] });
    mirror(viewport, "v:b", chip(), { at: [0, 0, 0] });
    mirror(viewport, "w:a", chip(), { at: [0, 0, 0] });
    dropMirrors(viewport, "v:", new Set(["v:b"]));
    expect([...shown.keys()].sort()).toEqual(["v:b", "w:a"]);
  });
});
