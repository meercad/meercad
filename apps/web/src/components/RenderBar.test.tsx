/** The rendered view's bar: picture sizes, saving a picture, the turntable and leaving the view. */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewport } from "@meercad/viewport";

const download = vi.fn();
const toast = vi.fn();
const showMenu = vi.fn();

vi.mock("./io", () => ({ baseName: () => "Bracket", download: (...args: unknown[]) => download(...args) }));
vi.mock("../store", () => ({ toast: (...args: unknown[]) => toast(...args) }));
vi.mock("./Menu", () => ({ showMenu: (...args: unknown[]) => showMenu(...args) }));

const { imageSizes, RenderBar, saveRender } = await import("./RenderBar");

/** A view that renders into a canvas of the asked size; `blob` is what the canvas encodes to. */
function fakeViewport(blob: Blob | null = new Blob([new Uint8Array([1, 2, 3])])) {
  const viewport = {
    turntable: false,
    setTurntable: vi.fn((on: boolean) => void (viewport.turntable = on)),
    renderImage: vi.fn((width: number, height: number, _options: { transparent: boolean }) => ({
      width,
      height,
      toBlob: (done: (blob: Blob | null) => void) => done(blob),
    })),
    renderer: { domElement: { clientWidth: 800, clientHeight: 600 } },
  };

  return viewport;
}

const asViewport = (viewport: ReturnType<typeof fakeViewport>) => viewport as unknown as Viewport;

beforeEach(() => {
  download.mockReset();
  toast.mockReset();
});

afterEach(cleanup);

describe("picture sizes", () => {
  it("offers the screen size doubled, Full HD, 4K and a square", () => {
    expect(imageSizes({ width: 800.4, height: 600 }).map(({ width, height }) => [width, height])).toEqual([
      [1601, 1200],
      [1920, 1080],
      [3840, 2160],
      [2048, 2048],
    ]);
    expect(imageSizes({ width: 800, height: 600 })[0]!.label).toBe("As on screen, sharp (1600 × 1200)");
  });
});

describe("saving a picture", () => {
  it("renders at the asked size and saves a PNG named after the design and the size", async () => {
    const viewport = fakeViewport();

    await saveRender(asViewport(viewport), 1920, 1080, true);

    expect(viewport.renderImage).toHaveBeenCalledWith(1920, 1080, { transparent: true });
    expect(download).toHaveBeenCalledWith("Bracket 1920x1080.png", new Uint8Array([1, 2, 3]));
    expect(toast).not.toHaveBeenCalled();
  });

  it("says so when the picture cannot be encoded", async () => {
    await saveRender(asViewport(fakeViewport(null)), 100, 100, false);

    expect(download).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "Could not save the picture: the picture could not be encoded",
      "error",
    );
  });
});

describe("the bar", () => {
  it("turns the turntable on and off, and stops it when the view is left", () => {
    const viewport = fakeViewport();
    const onExit = vi.fn();
    const { unmount } = render(<RenderBar vp={asViewport(viewport)} onExit={onExit} />);
    const turntable = screen.getByRole("button", { name: /Turntable/ });

    fireEvent.click(turntable);
    expect(viewport.setTurntable).toHaveBeenLastCalledWith(true);
    expect(turntable.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(turntable);
    expect(viewport.setTurntable).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByTitle("Back to the working view"));
    expect(onExit).toHaveBeenCalled();

    viewport.setTurntable.mockClear();
    unmount();
    expect(viewport.setTurntable).toHaveBeenCalledWith(false);
  });

  it("remembers that pictures are to be saved without a background", () => {
    render(<RenderBar vp={asViewport(fakeViewport())} onExit={() => undefined} />);

    const transparent = screen.getByRole("button", { name: /Transparent/ });

    expect(transparent.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(transparent);
    expect(transparent.getAttribute("aria-pressed")).toBe("true");
  });

  it("offers the picture sizes in a menu below the button and saves the chosen one", async () => {
    const viewport = fakeViewport();

    render(<RenderBar vp={asViewport(viewport)} onExit={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Transparent/ }));
    fireEvent.click(screen.getByRole("button", { name: /Save image/ }));

    const items = showMenu.mock.lastCall![2] as { label: string; onClick: () => void }[];

    expect(items.map((item) => item.label)).toEqual([
      "As on screen, sharp (1600 × 1200)",
      "Full HD (1920 × 1080)",
      "4K (3840 × 2160)",
      "Square (2048 × 2048)",
    ]);

    items[1]!.onClick();
    await vi.waitFor(() => expect(download).toHaveBeenCalled());

    expect(viewport.renderImage).toHaveBeenCalledWith(1920, 1080, { transparent: true });
    expect(download.mock.lastCall![0]).toBe("Bracket 1920x1080.png");
  });
});
