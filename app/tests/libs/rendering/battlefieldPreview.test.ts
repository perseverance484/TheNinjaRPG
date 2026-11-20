import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import type { GameAsset } from "@/drizzle/schema";
import {
  type BattlefieldScene,
  battlefieldSceneOf,
} from "@/libs/contentReview/battlefield";
import { createBattlefieldPreview } from "@/libs/rendering/scenes/battlefieldPreview";
import type { CombatSceneSnapshot } from "@/libs/rendering/scenes/combat";
import * as combat from "@/libs/rendering/scenes/combat";
import * as audio from "@/utils/audio";

let frames: CombatSceneSnapshot[];
let sounds: string[];
let renderTimes: number[];
const previews: NonNullable<Awaited<ReturnType<typeof createBattlefieldPreview>>>[] =
  [];
beforeEach(() => {
  frames = [];
  sounds = [];
  renderTimes = [];
  vi.spyOn(audio, "preloadAudioBuffers").mockResolvedValue(undefined);
  vi.spyOn(combat, "createCombatScene").mockImplementation(async (options) => {
    const seen = new Set<string>();
    const renderAt = async (timeMs?: number) => {
      if (timeMs !== undefined) renderTimes.push(timeMs);
      const snapshot = options.getSnapshot();
      frames.push(structuredClone(snapshot));
      for (const effect of [
        ...snapshot.battle.groundEffects,
        ...snapshot.battle.usersEffects,
      ]) {
        if (seen.has(effect.id)) continue;
        seen.add(effect.id);
        if (snapshot.sound && effect.appearSfx) options.play(effect.appearSfx, 1);
      }
    };
    return {
      canvas: document.createElement("canvas"),
      grid: {},
      dispose: () => {},
      refresh: () => {
        void renderAt();
      },
      renderAt,
    } as unknown as Awaited<ReturnType<typeof combat.createCombatScene>>;
  });
});
afterEach(() => {
  for (const preview of previews.splice(0)) preview.dispose();
  vi.restoreAllMocks();
});
const preview = async (scene: BattlefieldScene | null, assets: GameAsset[] = []) => {
  if (!scene) throw new Error("Scene did not normalize");
  const result = await createBattlefieldPreview({
    scene,
    assets,
    viewport: "desktop",
    background: "ground",
    onSound: (url) => {
      sounds.push(url);
    },
  });
  if (!result) throw new Error("Preview did not initialize");
  previews.push(result);
  return result;
};
const pattern = {
  origin: "TARGET",
  selection: "ALL",
  coordinates: [{ longitude: -2, latitude: 0 }],
  randomCount: 1,
};

it("keeps TARGET artwork on the authored footprint when the display victim moves", async () => {
  await preview(
    battlefieldSceneOf("JUTSU", "cast", {
      target: "OTHER_USER",
      method: "COORDINATES",
      coordinateTargeting: pattern,
      effects: [
        { type: "damage", appearAnimation: "hit", target: "INHERIT" },
        {
          type: "visual",
          target: "COORDINATES",
          staticAssetPath: "field",
          coordinateTargeting: pattern,
        },
      ],
    }),
  );
  expect(frames.at(-1)?.battle.usersState[1]?.longitude).toBe(7);
  expect(frames.at(-1)?.battle.groundEffects[0]?.longitude).toBe(7);
});
it("skips a caster-tile flight while retaining its ground effect", async () => {
  const result = await preview(
    battlefieldSceneOf("JUTSU", "cast", {
      target: "GROUND",
      method: "COORDINATES",
      coordinateTargeting: {
        ...pattern,
        origin: "CASTER",
        coordinates: [{ longitude: 0, latitude: 0 }],
      },
      effects: [{ type: "damage", target: "INHERIT", projectileAnimation: "bolt" }],
    }),
  );
  expect(result.timeline.arrivalMs).toBe(0);
  const effects = frames.at(-1)!.battle.groundEffects;
  expect(effects).toHaveLength(1);
  expect(effects[0]?.longitude).toBe(2);
  expect(effects[0]?.projectileOnly).not.toBe(true);
});
it("plays tile variation across an area from the caster's tile and waits for it", async () => {
  const area = (fields: Record<string, unknown>) =>
    battlefieldSceneOf("JUTSU", "area", {
      target: "GROUND",
      method: "AOE_CIRCLE_SPAWN",
      range: 2,
      effects: [
        { type: "damage", target: "INHERIT", appearAnimation: "hit", ...fields },
      ],
    });
  const assets = [
    { id: "hit", image: "https://example.com/hit.png", frames: 4, speed: 50 },
    { id: "other", image: "https://example.com/other.png", frames: 8, speed: 50 },
  ] as GameAsset[];
  const plain = await preview(area({}), assets);
  const varied = await preview(
    area({ animationRipple: 100, animationMirror: true, animationAlternate: "other" }),
    assets,
  );
  const placed = frames.at(-1)!.battle.groundEffects;
  expect(placed.length).toBeGreaterThan(1);
  for (const effect of placed)
    expect(effect).toMatchObject({
      animationRipple: 100,
      animationMirror: true,
      animationAlternate: "other",
      castFrom: expect.any(Object),
    });
  // The longer alternate and the farthest tile's ripple both hold the cycle open.
  expect(varied.timeline.removalMs).toBeGreaterThan(plain.timeline.removalMs + 200);
});
it("captures a rippled tile while its clip plays, and no exit it lacks", async () => {
  const result = await preview(
    battlefieldSceneOf("JUTSU", "late", {
      target: "GROUND",
      method: "COORDINATES",
      coordinateTargeting: {
        ...pattern,
        origin: "CASTER",
        coordinates: [{ longitude: 1, latitude: 0 }],
      },
      effects: [
        {
          type: "damage",
          target: "INHERIT",
          appearAnimation: "hit",
          animationRipple: 300,
        },
      ],
    }),
    [
      { id: "hit", image: "https://example.com/hit.png", frames: 4, speed: 10 },
    ] as GameAsset[],
  );
  renderTimes = [];
  const sheet = await result.captureFrames();
  expect(sheet.map((frame) => frame.label)).toEqual([
    "appearing",
    "appearing",
    "active",
  ]);
  // Both appearing samples land while the tile's clip plays, 300 to 340 ms.
  expect(renderTimes.filter((time) => time >= 300 && time < 340)).toHaveLength(2);
});
it("captures a delayed exit while it plays", async () => {
  const result = await preview(
    battlefieldSceneOf("JUTSU", "late exit", {
      target: "GROUND",
      method: "COORDINATES",
      coordinateTargeting: {
        ...pattern,
        origin: "CASTER",
        coordinates: [{ longitude: 1, latitude: 0 }],
      },
      effects: [
        {
          type: "damage",
          target: "INHERIT",
          disappearAnimation: "out",
          animationRipple: 300,
        },
      ],
    }),
    [
      { id: "out", image: "https://example.com/out.png", frames: 4, speed: 10 },
    ] as GameAsset[],
  );
  renderTimes = [];
  const sheet = await result.captureFrames();
  expect(sheet.map((frame) => frame.label)).toEqual(["active", "disappearing"]);
  const removal = result.timeline.removalMs;
  expect(
    renderTimes.filter((time) => time >= removal + 300 && time < removal + 340),
  ).toHaveLength(1);
});
it("waits for a delayed ground loop before its active capture and removal", async () => {
  const result = await preview(
    battlefieldSceneOf("JUTSU", "far loop", {
      target: "GROUND",
      method: "COORDINATES",
      coordinateTargeting: {
        ...pattern,
        origin: "CASTER",
        coordinates: [{ longitude: 7, latitude: 0 }],
      },
      effects: [
        {
          type: "damage",
          target: "INHERIT",
          staticAnimation: "loop",
          animationRipple: 300,
        },
      ],
    }),
    [
      { id: "loop", image: "https://example.com/loop.png", frames: 4, speed: 10 },
    ] as GameAsset[],
  );
  renderTimes = [];
  const sheet = await result.captureFrames();
  expect(sheet.map((frame) => frame.label)).toEqual(["active"]);
  // Seven hexes at 300 ms each hits the 2 s cap on added delay.
  const active = renderTimes.at(-1)!;
  expect(active).toBeGreaterThanOrEqual(2000);
  expect(active).toBeLessThan(result.timeline.removalMs);
});
it("keeps the ripple when a projectile tag places no tile", async () => {
  const result = await preview(
    battlefieldSceneOf("JUTSU", "lost flight", {
      target: "GROUND",
      effects: [
        {
          type: "visual",
          target: "COORDINATES",
          projectileAnimation: "hit",
          coordinateTargeting: {
            ...pattern,
            origin: "CASTER",
            coordinates: [{ longitude: 99, latitude: 0 }],
          },
        },
        {
          type: "damage",
          target: "COORDINATES",
          appearAnimation: "hit",
          animationRipple: 300,
          coordinateTargeting: {
            ...pattern,
            origin: "CASTER",
            coordinates: [{ longitude: 1, latitude: 0 }],
          },
        },
      ],
    }),
    [
      { id: "hit", image: "https://example.com/hit.png", frames: 4, speed: 10 },
    ] as GameAsset[],
  );
  renderTimes = [];
  await result.captureFrames();
  expect(renderTimes.filter((time) => time >= 300 && time < 340)).toHaveLength(2);
});
it("varies a ground exit per tile but not a fighter's", async () => {
  const result = await preview(
    battlefieldSceneOf("JUTSU", "exits", {
      target: "GROUND",
      method: "AOE_CIRCLE_SPAWN",
      range: 1,
      effects: [
        {
          type: "damage",
          target: "INHERIT",
          disappearAnimation: "out",
          animationStagger: 1000,
        },
        {
          type: "visual",
          target: "SELF",
          disappearAnimation: "out",
          animationStagger: 1000,
        },
      ],
    }),
    [
      { id: "out", image: "https://example.com/out.png", frames: 4, speed: 10 },
    ] as GameAsset[],
  );
  await result.renderAt(result.timeline.removalMs + 1);
  const exits = frames
    .flatMap((frame) => frame.battle.groundEffects)
    .filter((effect) => effect.id.includes("-end-"));
  const ground = exits.filter((effect) => effect.id.includes("-end-0-"));
  const fighter = exits.filter((effect) => effect.id.includes("-end-1-"));
  expect(ground.length).toBeGreaterThan(0);
  expect(fighter.length).toBeGreaterThan(0);
  for (const effect of ground) expect(effect.animationStagger).toBe(1000);
  for (const effect of fighter) {
    expect(effect.animationStagger).toBe(0);
    expect(effect.castFrom).toBeUndefined();
  }
});
it("marks each replay as a new cycle, so the renderer starts its effects over", async () => {
  const result = await preview(
    battlefieldSceneOf("JUTSU", "again", {
      effects: [{ type: "damage", appearAnimation: "hit" }],
    }),
  );
  const before = frames.at(-1)!.cycle!;
  await result.renderAt(500);
  await result.renderAt(10);
  expect(frames.at(-1)!.cycle).toBeGreaterThan(before);
});
it("starts a requested audible replay only after the paused preview plays", async () => {
  const result = await preview(
    battlefieldSceneOf("JUTSU", "cast", {
      effects: [{ type: "damage", appearSfx: "cue" }],
    }),
  );
  result.setSound(true);
  await Promise.resolve();
  expect(sounds).toEqual([]);
  result.play();
  await Promise.resolve();
  expect(sounds).toEqual(["cue"]);
});
it("resumes without replay when sound is enabled with restart false", async () => {
  const result = await preview(
    battlefieldSceneOf("JUTSU", "cast", {
      effects: [{ type: "damage", appearSfx: "cue" }],
    }),
  );
  await result.renderAt(450);
  const cycle = result.getPlaybackState().cycle;
  result.setSound(true, { restart: false });
  result.play();
  expect(result.getPlaybackState()).toMatchObject({ elapsedMs: 450, cycle });
  expect(sounds).toEqual([]);
});
it.each(["", "appearAnimation", "animationAlternate"])(
  "checks the native decal texture and any dual-use clip (%s)",
  async (clipField) => {
    const dualUse = !!clipField;
    const original = globalThis.Image;
    const urls: string[] = [];
    globalThis.Image = class {
      onload?: () => void;
      onerror?: () => void;
      set src(url: string) {
        urls.push(url);
        queueMicrotask(() =>
          url.includes("width=50") ? this.onload?.() : this.onerror?.(),
        );
      }
    } as unknown as typeof Image;
    try {
      const result = await preview(
        battlefieldSceneOf("JUTSU", "cast", {
          target: "GROUND",
          effects: [
            {
              type: "visual",
              staticAssetPath: "floor",
              groundStyle: "DECAL",
              ...(clipField ? { [clipField]: "floor" } : {}),
            },
          ],
        }),
        [
          {
            id: "floor",
            name: "Floor",
            image: "https://uploadthing.b-cdn.net/floor.png",
            frames: 1,
            speed: 1,
          } as GameAsset,
        ],
      );
      expect(await result.whenLoaded()).toEqual(["Floor (floor)"]);
      expect(urls).toContain("https://uploadthing.b-cdn.net/floor.png");
      expect(urls).toHaveLength(dualUse ? 2 : 1);
      if (dualUse)
        expect(urls).toContain("https://uploadthing.b-cdn.net/floor.png?width=50");
    } finally {
      globalThis.Image = original;
    }
  },
);
