import { describe, expect, it } from "bun:test";
import {
  assetAnimationClip,
  sampleAnimationClip,
  sheetLayout,
  walkDuration,
  walkProgress,
} from "@/libs/rendering/animation";

describe("shared animation clips", () => {
  it("preserves vertical game-asset frame order and authored timing", () => {
    const clip = assetAnimationClip({ image: "effect.png", frames: 8, speed: 60 });
    expect(clip).toMatchObject({ images: ["effect.png"], columns: 1, rows: 8 });
    expect(sampleAnimationClip(clip, 0)).toEqual({ index: 0, finished: false });
    expect(sampleAnimationClip(clip, 119)).toEqual({ index: 1, finished: false });
    expect(sampleAnimationClip(clip, 479)).toEqual({ index: 7, finished: false });
    expect(sampleAnimationClip(clip, 480)).toEqual({ index: 7, finished: true });
  });
  it("catches up after a long frame and wraps looping clips without accumulating drift", () => {
    const clip = assetAnimationClip(
      { image: "effect.png", frames: 8, speed: 60 },
      true,
    );
    expect(sampleAnimationClip(clip, 10_000)).toEqual({ index: 6, finished: false });
    expect(sampleAnimationClip(clip, -10)).toEqual({ index: 0, finished: false });
  });
  it("freezes decorative frames for reduced motion while retaining effect lifetime", () => {
    const clip = assetAnimationClip({ image: "effect.png", frames: 8, speed: 60 });
    expect(sampleAnimationClip(clip, 200, true)).toEqual({ index: 0, finished: false });
    expect(sampleAnimationClip(clip, 480, true)).toEqual({ index: 0, finished: true });
  });
});

describe("effect sheet layout", () => {
  it("reads a sheet one frame wide as a vertical strip", () => {
    expect(sheetLayout(128, 128 * 32, 32)).toEqual({ columns: 1, rows: 32 });
    expect(sheetLayout(50, 50 * 8, 8)).toEqual({ columns: 1, rows: 8 });
    expect(sheetLayout(64, 64, 1)).toEqual({ columns: 1, rows: 1 });
  });
  it("reads a wider sheet of square cells as a grid, row by row", () => {
    expect(sheetLayout(7 * 384, 7 * 384, 45)).toEqual({ columns: 7, rows: 7 });
    expect(sheetLayout(7 * 384, 6 * 384, 41)).toEqual({ columns: 7, rows: 6 });
    expect(sheetLayout(3 * 100, 100, 3)).toEqual({ columns: 3, rows: 1 });
    // a 50 px rendition of the 7 x 6 grid rounds its height to 43 px
    expect(sheetLayout(50, 43, 41)).toEqual({ columns: 7, rows: 6 });
    // 96 frames of 32 px in 64 columns and two rows: 63 columns is also within tolerance
    expect(sheetLayout(2048, 64, 96)).toEqual({ columns: 64, rows: 2 });
  });
  it("reads sheets that match no grid as vertical strips", () => {
    expect(sheetLayout(100, 700, 8)).toEqual({ columns: 1, rows: 8 });
    // a strip of four frames, each four times as wide as tall, is not read as two columns
    expect(sheetLayout(4, 4, 4)).toEqual({ columns: 1, rows: 4 });
    expect(sheetLayout(0, 0, 8)).toEqual({ columns: 1, rows: 8 });
  });
});

describe("battlefield walking", () => {
  const samples = (duration: number, count = 200) =>
    Array.from({ length: count + 1 }, (_, index) =>
      walkProgress(index / count, duration),
    );

  it.each([1, 3, 8])(
    "covers exactly the whole %s-hex path without ever reversing",
    (tiles) => {
      const points = samples(walkDuration(tiles));
      expect(points[0]).toBe(0);
      expect(points.at(-1)).toBeCloseTo(1);
      for (let index = 1; index < points.length; index++)
        expect(points[index]!).toBeGreaterThanOrEqual(points[index - 1]!);
    },
  );

  it("accelerates, cruises and brakes across a long path instead of each hex", () => {
    const points = samples(walkDuration(5));
    const speed = (index: number) => points[index + 1]! - points[index]!;
    expect(speed(1)).toBeLessThan(speed(100));
    expect(speed(198)).toBeLessThan(speed(100));
    expect(speed(60)).toBeCloseTo(speed(140));
  });

  it("stays continuous where the ramps meet the cruise", () => {
    const points = samples(walkDuration(3), 1000);
    for (let index = 1; index < points.length; index++)
      expect(points[index]! - points[index - 1]!).toBeLessThan(0.004);
  });

  it("keeps moving through extra hexes rather than repeating a full stop", () => {
    expect(walkDuration(4) - walkDuration(3)).toBeLessThan(walkDuration(1));
  });
});
