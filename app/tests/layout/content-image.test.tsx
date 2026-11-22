import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import ContentImage from "@/layout/ContentImage";
import * as NextImage from "@/layout/Image";

beforeEach(() => {
  vi.spyOn(NextImage, "default").mockImplementation((({
    src,
    alt,
    className,
  }: {
    src: string;
    alt: string;
    className?: string;
  }) => <img src={src} alt={alt} className={className} />) as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const art = (view: ReturnType<typeof render>) =>
  view.container.querySelector<HTMLImageElement>('img[src="/art.webp"]');

it("keeps item art inside its frame's border when the caller sets a size", () => {
  const view = render(
    <span className="relative h-11 w-11">
      <ContentImage
        image="/art.webp"
        alt="Sword"
        rarity="LEGENDARY"
        className="h-11 w-11"
      />
    </span>,
  );
  const classes = art(view)?.className.split(" ") ?? [];
  // The bordered box takes the caller's size; the art fills the space inside the border.
  expect(art(view)?.parentElement?.className).toContain("h-11");
  expect(classes).toContain("h-full");
  expect(classes).toContain("w-full");
  expect(classes).not.toContain("h-11");
  expect(classes).not.toContain("w-11");
});

it("keeps the caller's other classes on the art, such as its rounding", () => {
  const view = render(
    <ContentImage
      image="/art.webp"
      alt="Sword"
      hideBorder
      className="h-12 w-12 rounded-lg"
    />,
  );
  expect(art(view)?.className.split(" ")).toContain("rounded-lg");
});

it("crops grid sheets cell by cell, row by row", () => {
  const draws: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: () => {},
    drawImage: (_image: unknown, ...rect: number[]) => draws.push(rect.slice(0, 4)),
  } as never);
  const sheets: { onload: (() => void) | null; width: number; height: number }[] = [];
  const original = globalThis.Image;
  globalThis.Image = class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    width = 3 * 100;
    height = 2 * 100;
    src = "";
    constructor() {
      sheets.push(this);
    }
  } as unknown as typeof Image;
  const frames: FrameRequestCallback[] = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((step) => {
    frames.push(step);
    return frames.length;
  });
  try {
    render(
      <ContentImage
        image="/grid.webp"
        alt="Grid"
        className="h-12 w-12"
        frames={5}
        speed={10}
      />,
    );
    sheets[0]!.onload?.();
    expect(draws.at(-1)).toEqual([0, 0, 100, 100]);
    frames.shift()!(0);
    frames.shift()!(35);
    // Frame 3 starts the second row.
    expect(draws.at(-1)).toEqual([0, 100, 100, 100]);
    frames.shift()!(45);
    expect(draws.at(-1)).toEqual([100, 100, 100, 100]);
  } finally {
    globalThis.Image = original;
  }
});
