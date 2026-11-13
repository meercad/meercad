/**
 * The lithophane's photo (LithophaneFields.tsx): a chosen picture comes in, named after its file
 * unless the part has a name; one that cannot be read says why; the preview opens the file chooser
 * again; nothing chosen changes nothing.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as textures from "../lib/textureImage";
import { useApp } from "../store";
import { LithophaneFields } from "./LithophaneFields";

const image = { width: 4, height: 2, pixels: "AAAA" };
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});
const pick = (input: HTMLInputElement, files: File[]) => act(async () => void fireEvent.change(input, { target: { files } }));

describe("the lithophane's photo", () => {
  it("takes a picture named after its file, says why one cannot be read, and ignores nothing chosen", async () => {
    vi.spyOn(textures, "heightImageFromFile").mockResolvedValueOnce(image as never).mockRejectedValueOnce(new Error("not a picture"));
    const set = vi.fn();
    const { container } = render(<LithophaneFields f={{ id: "li1", op: "lithophane", image: { width: 0, height: 0, pixels: "" } } as never} set={set} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    await pick(input, [new File(["x"], "Grandma.jpg")]);
    expect(set).toHaveBeenLastCalledWith({ image, name: "Grandma" });
    await pick(input, [new File(["x"], "notes.txt")]);
    expect(toasts()).toMatch(/Could not read the picture: not a picture/);
    await pick(input, []);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("keeps the part's name, and the preview opens the chooser again", async () => {
    vi.spyOn(textures, "heightImageUrl").mockReturnValue("data:image/png;base64,");
    vi.spyOn(textures, "heightImageFromFile").mockResolvedValue(image as never);
    const set = vi.fn();
    const { container } = render(<LithophaneFields f={{ id: "li1", op: "lithophane", name: "Lamp", image, width: 80 } as never} set={set} />);
    const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
    const opened = vi.fn();
    input.click = opened;
    await act(async () => void fireEvent.click(container.querySelector(".litho-preview")!));
    expect(opened).toHaveBeenCalled();
    expect(container.textContent).toContain("4 × 2 px · 80 × 40 mm");
    await pick(input, [new File(["x"], "Other.png")]);
    expect(set).toHaveBeenLastCalledWith({ image });
  });
});
