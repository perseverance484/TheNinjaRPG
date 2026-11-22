import { describe, expect, it, vi } from "bun:test";
import { BufferImageSource, Texture } from "pixi.js";
import { assetAnimationClip } from "@/libs/rendering/animation";
import { createClipTextures } from "@/libs/rendering/primitives/animation";
import type { GameRenderer } from "@/libs/rendering/runtime";

/** A renderer whose sheets measure `native` at width 0 and keep their aspect in renditions. */
const stub = (native: { width: number; height: number }) => {
  const texture = vi.fn(async (_url: string, rendition: number) => {
    const width = rendition > 0 ? rendition : native.width;
    const height = Math.round((native.height * width) / native.width);
    return new Texture({
      source: new BufferImageSource({
        resource: new Uint8Array(4 * width * height),
        width,
        height,
      }),
    });
  });
  const game = {
    assets: { texture },
    own: () => {},
    isDisposed: () => false,
    signal: new AbortController().signal,
  } as unknown as GameRenderer;
  return { game, texture };
};

describe("effect clip textures", () => {
  it("cuts a native strip into frames down the sheet", async () => {
    const { game, texture } = stub({ width: 128, height: 128 * 8 });
    const clip = assetAnimationClip({ image: "strip.webp", frames: 8, speed: 30 });
    const { views } = await createClipTextures(game, clip, { size: 40 });
    expect(texture.mock.calls.map((call) => call[1])).toEqual([0]);
    expect(views).toHaveLength(8);
    expect([views[3]!.frame.x, views[3]!.frame.y, views[3]!.frame.width]).toEqual([
      0, 384, 128,
    ]);
  });
  it("reads a grid row by row", async () => {
    const { game, texture } = stub({ width: 7 * 64, height: 6 * 64 });
    const clip = assetAnimationClip({ image: "grid.webp", frames: 41, speed: 30 });
    const { views } = await createClipTextures(game, clip, { size: 400 });
    expect(texture.mock.calls.map((call) => call[1])).toEqual([0]);
    expect(views).toHaveLength(41);
    const frame = (i: number) => {
      const f = views[i]!.frame;
      return [f.x, f.y, f.width, f.height];
    };
    expect(frame(0)).toEqual([0, 0, 64, 64]);
    expect(frame(8)).toEqual([64, 64, 64, 64]);
    expect(frame(40)).toEqual([5 * 64, 5 * 64, 64, 64]);
  });
});
