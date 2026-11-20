import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Assets, BufferImageSource, Container, type Sprite, Texture } from "pixi.js";
import type { GameAsset } from "@/drizzle/schema";
import { applyEffects, expireGroundEffects } from "@/libs/combat/process";
import type { GroundEffect, ReturnedBattle } from "@/libs/combat/types";
import { getBattleGrid } from "@/libs/combat/util";
import type { GameRenderer } from "@/libs/rendering/runtime";
import {
  createCombatEffects,
  MAX_TILE_DELAY_MS,
  tileVariation,
} from "@/libs/rendering/scenes/combatEffects";
import {
  makeBattleUser,
  makeCompleteBattle,
  makeDamageEffect,
  makeEffect,
} from "../../setup/combat";

let sequence = 0;
const scopes: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(Assets, "load").mockImplementation(
    async () =>
      new Texture({
        source: new BufferImageSource({
          resource: new Uint8Array(4 * 16 * 4),
          width: 4,
          height: 16,
        }),
      }),
  );
  vi.spyOn(Assets, "unload").mockResolvedValue(undefined);
});
afterEach(async () => {
  for (const cleanup of scopes.splice(0)) cleanup();
  await Promise.resolve();
  vi.restoreAllMocks();
});
const setup = (hexWidth = 40) => {
  const owned = new Set<() => void>();
  const game = {
    own: (cleanup: () => void) => {
      owned.add(cleanup);
    },
    disown: (cleanup: () => void) => {
      owned.delete(cleanup);
    },
    invalidate: () => {},
    isDisposed: () => false,
    signal: new AbortController().signal,
  } as unknown as GameRenderer;
  scopes.push(() => {
    for (const cleanup of owned) cleanup();
  });
  const battle = makeCompleteBattle({
    width: 12,
    height: 10,
  }) as unknown as ReturnedBattle;
  const grid = getBattleGrid(hexWidth, battle, { x: -hexWidth / 2, y: -hexWidth / 2 });
  const play = vi.fn();
  const effects = createCombatEffects(game, grid, play);
  const stage = new Container();
  stage.addChild(effects.ground, effects.container);
  scopes.push(() =>
    stage.destroy({ children: true, texture: false, textureSource: false }),
  );
  const prefix = `effect-${sequence++}`;
  const assets = [
    {
      id: "animation",
      image: `https://example.com/${prefix}.png`,
      frames: 4,
      speed: 10,
    },
    { id: "appear", url: "appear.wav" },
    { id: "disappear", url: "disappear.wav" },
  ] as unknown as GameAsset[];
  const effect = {
    id: "effect",
    type: "visual",
    longitude: 3,
    latitude: 1,
    power: 100,
    staticAnimation: "animation",
    appearSfx: "appear",
    disappearSfx: "disappear",
  } as GroundEffect;
  battle.groundEffects = [effect];
  const snapshot = { battle, assets, sound: true, volume: 0.4 };
  return { effects, snapshot, effect, play, owned, grid, stage };
};

describe("Pixi combat effects", () => {
  it.each([24, 48])(
    "fits ground and character animations to their hex at %s world units",
    async (hexWidth) => {
      const scene = setup(hexWidth);
      scene.effect.appearAnimation = "animation";
      const target = makeBattleUser("target", { longitude: 4, latitude: 3 });
      const attached = makeEffect(
        "visual",
        { appearAnimation: "animation", staticAnimation: "animation" },
        {
          id: "attached",
          creatorId: target.userId,
          targetId: target.userId,
          targetType: "user",
        },
      );
      scene.snapshot.battle = makeCompleteBattle({
        width: 12,
        height: 10,
        usersState: [target],
        groundEffects: [scene.effect],
        usersEffects: [attached],
      }) as unknown as ReturnedBattle;
      await scene.effects.sync(scene.snapshot);
      for (const zoom of [1, 2]) {
        scene.stage.scale.set(zoom, -zoom);
        scene.stage.position.set(73, 41);
        for (const now of [0, 10, 30]) {
          scene.effects.animate(now, false, false, null);
          for (const [id, position] of [
            [scene.effect.id, scene.effect],
            [attached.id, target],
          ] as const) {
            const tile = scene.grid.getHex({
              col: position.longitude,
              row: position.latitude,
            })!;
            const center = tile.corners.reduce(
              (sum, point) => ({ x: sum.x + point.x / 6, y: sum.y + point.y / 6 }),
              { x: 0, y: 0 },
            );
            const root = scene.effects.container.getChildByLabel(id)!;
            expect(root.children).toHaveLength(2);
            for (const clip of root.children as Sprite[]) {
              const bounds = clip.getBounds();
              expect(bounds.width).toBeCloseTo(tile.height * zoom);
              expect(bounds.height).toBeCloseTo(tile.height * zoom);
              expect((bounds.minX + bounds.maxX) / 2).toBeCloseTo(73 + center.x * zoom);
              expect((bounds.minY + bounds.maxY) / 2).toBeCloseTo(41 - center.y * zoom);
            }
          }
        }
      }
    },
  );
  it.each([24, 48])(
    "scales only selected ground and fighter effects at %s world units",
    async (hexWidth) => {
      const scene = setup(hexWidth);
      scene.effect.animationScale = 2.5;
      scene.effect.appearAnimation = "animation";
      const target = makeBattleUser("target", { longitude: 4, latitude: 3 });
      const attached = makeEffect(
        "visual",
        {
          appearAnimation: "animation",
          staticAnimation: "animation",
          animationScale: 2.5,
        },
        {
          id: "attached",
          creatorId: target.userId,
          targetId: target.userId,
          targetType: "user",
        },
      );
      const legacy = { ...scene.effect, id: "legacy", longitude: 5 };
      delete (legacy as Partial<GroundEffect>).animationScale;
      scene.snapshot.battle = makeCompleteBattle({
        usersState: [target],
        groundEffects: [scene.effect, legacy],
        usersEffects: [attached],
      }) as unknown as ReturnedBattle;
      await scene.effects.sync(scene.snapshot);
      for (const zoom of [1, 2]) {
        scene.stage.scale.set(zoom, -zoom);
        scene.effects.animate(0, true, false, null);
        for (const [id, scale, position] of [
          [scene.effect.id, 2.5, scene.effect],
          [legacy.id, 1, legacy],
          [attached.id, 2.5, target],
        ] as const) {
          const tile = scene.grid.getHex({
            col: position.longitude,
            row: position.latitude,
          })!;
          const root = scene.effects.container.getChildByLabel(id)!;
          for (const clip of root.children as Sprite[]) {
            expect(clip.getBounds().width).toBeCloseTo(tile.height * scale * zoom);
            expect(clip.getBounds().height).toBeCloseTo(tile.height * scale * zoom);
            expect(clip.position.x).toBeCloseTo(tile.width / 2);
            expect(clip.position.y).toBeCloseTo(tile.height / 2);
          }
        }
      }
    },
  );
  it("keeps static barrier artwork below overlays with shared position, visibility and lifetime", async () => {
    const scene = setup();
    Object.assign(scene.effect, {
      type: "barrier",
      animationScale: 2.5,
      staticAssetPath: "obstacle",
      staticAnimation: "",
      appearAnimation: "animation",
      curHealth: 25,
      maxHealth: 50,
    });
    scene.snapshot.assets.push({
      id: "obstacle",
      image: "https://example.com/barrier.png",
    } as GameAsset);
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    const art = scene.effects.ground.children[0]!,
      overlay = scene.effects.container.children[0]!;
    expect(art.children[0]?.label).toBe("static");
    expect(overlay.children).not.toContain(art);
    expect(overlay.children).toHaveLength(2);
    expect([art.x, art.y]).toEqual([overlay.x, overlay.y]);
    scene.effects.animate(40, false, false, null);
    expect(overlay.children).toHaveLength(1);
    const bounds = art.getBounds();
    expect(bounds.width).toBeCloseTo(scene.grid.getHex({ col: 3, row: 1 })!.width);
    expect(
      scene.effects.hit(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.id,
    ).toBe(scene.effect.id);
    scene.effect.latitude = 2;
    await scene.effects.sync(scene.snapshot);
    expect([art.x, art.y]).toEqual([overlay.x, overlay.y]);
    scene.effect.power = 0;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(50, false, false, null);
    expect(art.visible).toBe(false);
    expect(overlay.visible).toBe(false);
    expect(
      scene.effects.hit(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
    ).toBeNull();
    scene.effect.power = 100;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(60, false, false, null);
    expect(art.visible).toBe(true);
    expect(overlay.visible).toBe(true);
    scene.snapshot.battle.groundEffects = [];
    await scene.effects.sync(scene.snapshot);
    expect(art.destroyed).toBe(true);
    expect(overlay.destroyed).toBe(true);
    expect(scene.effects.ground.children).toHaveLength(0);
  });

  it("picks an animated overlay above later static artwork", async () => {
    const scene = setup();
    scene.snapshot.assets.push({
      id: "obstacle",
      image: "https://example.com/overlay-barrier.png",
    } as GameAsset);
    scene.snapshot.battle.groundEffects.push({
      ...scene.effect,
      id: "later-static",
      staticAnimation: "",
      staticAssetPath: "obstacle",
    });
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    const bounds = scene.effects.ground.children[0]!.getBounds();
    expect(
      scene.effects.hit(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.id,
    ).toBe(scene.effect.id);
  });

  it("retains depleted effects without replaying sounds or recreating loops", async () => {
    const scene = setup();
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    const root = scene.effects.container.children[0];
    if (!root) throw new Error("Effect was not created");
    expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);
    scene.effect.power = 0;
    await scene.effects.sync(scene.snapshot);
    for (let frame = 0; frame < 60; frame++)
      scene.effects.animate(frame, false, false, null);
    expect(scene.effects.container.children).toEqual([root]);
    expect(root?.visible).toBe(false);
    expect(scene.play.mock.calls).toEqual([
      ["appear.wav", 0.4],
      ["disappear.wav", 0.4],
    ]);
    scene.effect.power = 100;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(60, false, false, null);
    expect(root?.visible).toBe(true);
  });
  it("retires expired effects and their resource scopes", async () => {
    const scene = setup();
    await scene.effects.sync(scene.snapshot);
    expect(scene.owned.size).toBeGreaterThan(1);
    scene.snapshot.battle.groundEffects = [];
    await scene.effects.sync(scene.snapshot);
    expect(scene.effects.container.children).toHaveLength(0);
    // Only the scene-level sound queue cleanup remains registered.
    expect(scene.owned.size).toBe(1);
  });
  it("releases completed one-shot views while keeping the static loop alive", async () => {
    const scene = setup();
    scene.effect.appearAnimation = "animation";
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    const root = scene.effects.container.children[0];
    expect(root?.children).toHaveLength(2);
    scene.effects.animate(40, false, false, null);
    expect(root?.children).toHaveLength(1);
  });
  it("queues appearance and disappearance behind movement exactly once", async () => {
    const scene = setup();
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, true, null);
    scene.effect.power = 0;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(1, false, true, null);
    expect(scene.play).not.toHaveBeenCalled();
    scene.effects.animate(2, false, false, null);
    scene.effects.animate(51, false, false, null);
    expect(scene.play).not.toHaveBeenCalled();
    scene.effects.animate(52, false, false, null);
    expect(scene.play.mock.calls).toEqual([
      ["appear.wav", 0.4],
      ["disappear.wav", 0.4],
    ]);
    scene.effects.animate(100, false, false, null);
    expect(scene.play).toHaveBeenCalledTimes(2);
  });
  it.each(["initial", "muted"])(
    "does not replay a suppressed %s disappearance",
    async (reason) => {
      const scene = setup();
      scene.effect.power = 0;
      scene.snapshot.sound = reason !== "muted";
      await scene.effects.sync(scene.snapshot, reason === "initial");
      scene.effects.animate(0, false, false, null);
      scene.snapshot.sound = true;
      await scene.effects.sync(scene.snapshot);
      scene.effects.animate(100, false, false, null);
      expect(scene.play).not.toHaveBeenCalled();
    },
  );
});

describe("authoritative combat effect transitions", () => {
  it("plays one disappearance when actual combat damage depletes a retained shield", async () => {
    const scene = setup();
    const shield = makeEffect(
      "shield",
      {
        power: 1,
        health: 1,
        rounds: 5,
        staticAnimation: "animation",
        disappearSfx: "disappear",
      },
      {
        id: "shield",
        creatorId: "defender",
        targetId: "defender",
        targetType: "user",
        isNew: false,
        createdRound: 0,
      },
    );
    const battle = makeCompleteBattle({
      round: 2,
      usersState: [
        makeBattleUser("attacker", { longitude: 3, latitude: 1 }),
        makeBattleUser("defender", { longitude: 4, latitude: 1 }),
      ],
      usersEffects: [
        shield,
        makeDamageEffect({
          power: 100,
          calculation: "static",
          creatorId: "attacker",
          targetId: "defender",
          targetType: "user",
          isNew: true,
          createdRound: 2,
          rounds: 0,
        }),
      ],
    });
    scene.snapshot.battle = battle as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot, true);
    scene.effects.animate(0, false, false, null);
    const root = scene.effects.container.children[0];
    if (!root) throw new Error("Shield was not rendered");
    const { newBattle } = applyEffects(battle, "attacker");
    expect(
      newBattle.usersEffects.find((effect) => effect.id === shield.id),
    ).toMatchObject({ power: 0, rounds: 5, disappearSfx: "disappear" });
    scene.snapshot.battle = newBattle as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    for (let frame = 1; frame <= 60; frame++)
      scene.effects.animate(frame, false, false, null);
    expect(scene.effects.container.children).toEqual([root]);
    expect(root?.visible).toBe(false);
    expect(scene.play.mock.calls).toEqual([["disappear.wav", 0.4]]);
  });
  it("renders the disappearance visual created by authoritative ground-effect expiry once", async () => {
    const scene = setup();
    const battle = makeCompleteBattle({
      round: 2,
      groundEffects: [
        makeEffect(
          "shield",
          {
            power: 1,
            health: 1,
            rounds: 1,
            animationScale: 2.5,
            disappearAnimation: "animation",
            disappearSfx: "disappear",
          },
          { longitude: 3, latitude: 1, targetType: "barrier", isNew: false },
        ),
      ],
    });
    battle.groundEffects[0]!.rounds = 0;
    expireGroundEffects(battle, []);
    scene.snapshot.battle = battle as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    expect(scene.effects.container.children).toHaveLength(1);
    expect(scene.effects.container.children[0]?.visible).toBe(true);
    const end = scene.snapshot.battle.groundEffects[0]!;
    const tile = scene.grid.getHex({ col: end.longitude, row: end.latitude })!;
    const clip = scene.effects.container.children[0]!.children[0] as Sprite;
    expect(clip.width).toBeCloseTo(tile.height * 2.5);
    expect(clip.height).toBeCloseTo(tile.height * 2.5);
    for (let frame = 1; frame <= 60; frame++)
      scene.effects.animate(frame, false, false, null);
    expect(scene.play.mock.calls).toEqual([["disappear.wav", 0.4]]);
  });
});

describe("arrival ownership", () => {
  const cast = (type: "increasestat" | "damage", rounds: number) => {
    const defender = makeBattleUser("defender", { longitude: 3, latitude: 1 });
    return makeCompleteBattle({
      round: 2,
      usersState: [makeBattleUser("caster", { longitude: 0, latitude: 0 }), defender],
      groundEffects: [
        makeEffect(
          type,
          {
            power: 10,
            rounds,
            generalTypes: ["Strength"],
            appearAnimation: "animation",
            appearSfx: "appear",
          },
          {
            id: "cast",
            creatorId: "caster",
            targetType: "user",
            longitude: 3,
            latitude: 1,
            isNew: true,
            castThisRound: true,
          },
        ),
      ],
    });
  };
  const playArrival = async (battle: ReturnType<typeof cast>) => {
    const scene = setup();
    await scene.effects.sync(
      { ...scene.snapshot, battle: { ...scene.snapshot.battle, groundEffects: [] } },
      true,
    );
    const { newBattle } = applyEffects(battle, "caster");
    scene.snapshot.battle = newBattle as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    const arrivals = scene.effects.container.children.flatMap((root) =>
      (root.children as Sprite[]).filter((clip) => clip.zIndex === 1),
    );
    for (let frame = 1; frame <= 60; frame++)
      scene.effects.animate(frame, false, false, null);
    return { arrivals, sounds: scene.play.mock.calls };
  };
  it.each([
    ["a lasting", "increasestat", 3],
    ["an instant", "damage", 0],
  ] as const)(
    "plays %s ground effect's arrival on an occupied tile once",
    async (_, type, rounds) => {
      const { arrivals, sounds } = await playArrival(cast(type, rounds));
      expect(arrivals).toHaveLength(1);
      expect(sounds).toEqual([["appear.wav", 0.4]]);
    },
  );
  it("plays a lasting character effect's arrival once on a fighter who survives", async () => {
    const battle = makeCompleteBattle({
      round: 2,
      usersState: [
        makeBattleUser("caster", { longitude: 0, latitude: 0 }),
        makeBattleUser("defender", { longitude: 3, latitude: 1 }),
      ],
      usersEffects: [
        makeEffect(
          "decreasestat",
          {
            power: 10,
            rounds: 2,
            generalTypes: ["Strength"],
            appearAnimation: "animation",
            appearSfx: "appear",
          },
          {
            id: "debuff",
            creatorId: "caster",
            targetId: "defender",
            targetType: "user",
            isNew: true,
            castThisRound: true,
            createdRound: 2,
          },
        ),
      ],
    });
    const { arrivals, sounds } = await playArrival(battle);
    expect(arrivals).toHaveLength(1);
    expect(sounds).toEqual([["appear.wav", 0.4]]);
  });
});

describe("announced arrivals", () => {
  const tile = { longitude: 3, latitude: 1 };
  const lasting = (fields: Partial<GroundEffect> = {}) =>
    ({
      id: "owner",
      type: "recoil",
      creatorId: "caster",
      actionId: "jutsu",
      createdRound: 1,
      power: 100,
      rounds: 3,
      appearAnimation: "animation",
      appearSfx: "appear",
      staticAnimation: "animation",
      ...tile,
      ...fields,
    }) as GroundEffect;
  const announcement = {
    id: "announcement",
    type: "visual",
    creatorId: "caster",
    actionId: "visual",
    createdRound: 1,
    rounds: 0,
    appearAnimation: "animation",
    appearSfx: "appear",
    arrivalFor: "owner",
    ...tile,
  } as GroundEffect;
  const play = async (groundEffects: GroundEffect[]) => {
    const scene = setup();
    await scene.effects.sync(
      {
        ...scene.snapshot,
        battle: makeCompleteBattle({
          width: 12,
          height: 10,
        }) as unknown as ReturnedBattle,
      },
      true,
    );
    scene.snapshot.battle = makeCompleteBattle({
      width: 12,
      height: 10,
      groundEffects,
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    const visibleArrivals = scene.effects.container.children
      .filter((root) => root.visible)
      .flatMap((root) =>
        (root.children as Sprite[]).filter((clip) => clip.zIndex === 1 && clip.visible),
      );
    for (let frame = 1; frame <= 60; frame++)
      scene.effects.animate(frame, false, false, null);
    return { scene, visibleArrivals, sounds: scene.play.mock.calls };
  };
  it("plays an announced effect's arrival once, through its visual", async () => {
    const { visibleArrivals, sounds } = await play([lasting(), announcement]);
    expect(visibleArrivals).toHaveLength(1);
    expect(sounds).toEqual([["appear.wav", 0.4]]);
  });
  it("still shows the arrival when its effect was removed in the same action", async () => {
    const { visibleArrivals, sounds } = await play([announcement]);
    expect(visibleArrivals).toHaveLength(1);
    expect(sounds).toEqual([["appear.wav", 0.4]]);
  });
  it("shows the arrival of an announced effect that has no power left", async () => {
    const { visibleArrivals, sounds } = await play([
      lasting({ power: 0 }),
      announcement,
    ]);
    expect(visibleArrivals).toHaveLength(1);
    expect(sounds).toEqual([["appear.wav", 0.4]]);
  });
  it("lets an effect nothing announced play its own arrival", async () => {
    const { visibleArrivals, sounds } = await play([lasting()]);
    expect(visibleArrivals).toHaveLength(1);
    expect(sounds).toEqual([["appear.wav", 0.4]]);
  });
  it("leaves the pointer to a live effect over one that is departing", async () => {
    const scene = setup();
    const departing = lasting({ id: "departing", staticAnimation: "" });
    const live = lasting({ id: "live", appearAnimation: "", appearSfx: "" });
    scene.snapshot.battle = makeCompleteBattle({
      width: 12,
      height: 10,
      groundEffects: [live, departing],
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    scene.snapshot.battle = makeCompleteBattle({
      width: 12,
      height: 10,
      groundEffects: [live],
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(1, false, false, null);
    const root = scene.effects.container.getChildByLabel("departing")!;
    expect(root.visible).toBe(true);
    const center = root.getBounds();
    expect(
      scene.effects.hit(center.x + center.width / 2, center.y + center.height / 2)?.id,
    ).toBe("live");
  });
});

describe("area tile variation", () => {
  const board = { width: 12, height: 10 };
  const tiles = Array.from({ length: board.width * board.height }, (_, index) => ({
    longitude: index % board.width,
    latitude: Math.floor(index / board.width),
  }));
  const varied = {
    appearAnimation: "animation",
    animationMirror: true,
    animationStagger: 600,
    animationAlternate: "alternate",
  };
  const vary = (tile: (typeof tiles)[number]) =>
    tileVariation(varied, tile.longitude, tile.latitude);
  const mirroredTile = tiles.find((t) => vary(t).mirrored)!;
  const plainTile = tiles.find((t) => !vary(t).mirrored && vary(t).delayMs < 600)!;
  const alternateTile = tiles.find((t) => vary(t).appearAnimation === "alternate")!;
  const groundEffect = (
    id: string,
    tile: { longitude: number; latitude: number },
    fields: Partial<GroundEffect> = {},
  ) =>
    ({
      id,
      type: "recoil",
      creatorId: "caster",
      actionId: "jutsu",
      createdRound: 1,
      power: 100,
      appearAnimation: "animation",
      staticAnimation: "animation",
      ...tile,
      ...fields,
    }) as GroundEffect;
  const clipsOf = (scene: ReturnType<typeof setup>, id: string) =>
    scene.effects.container.getChildByLabel(id)!.children as Sprite[];
  const show = async (
    scene: ReturnType<typeof setup>,
    groundEffects: GroundEffect[],
    extra: Partial<Parameters<typeof makeCompleteBattle>[0]> = {},
  ) => {
    scene.snapshot.assets.push({
      id: "alternate",
      image: "https://example.com/alternate.png",
      frames: 2,
      speed: 10,
    } as GameAsset);
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
      groundEffects,
      ...extra,
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
  };

  it("varies tiles by a stable hash: about half mirrored and half alternate, delays spread", () => {
    const picks = tiles.map(vary);
    expect(tiles.map(vary)).toEqual(picks);
    const share = (test: (pick: (typeof picks)[number]) => boolean) =>
      picks.filter(test).length / picks.length;
    for (const value of [
      share((p) => p.mirrored),
      share((p) => p.appearAnimation === "alternate"),
    ]) {
      expect(value).toBeGreaterThan(0.35);
      expect(value).toBeLessThan(0.65);
    }
    expect(Math.max(...picks.map((p) => p.delayMs))).toBeLessThanOrEqual(600);
    expect(new Set(picks.map((p) => Math.floor(p.delayMs / 100))).size).toBeGreaterThan(
      4,
    );
    // No stripe or checkerboard: mirroring agrees with each simple pattern only by chance.
    for (const pattern of [
      (t: (typeof tiles)[number]) => t.longitude % 2 === 1,
      (t: (typeof tiles)[number]) => t.latitude % 2 === 1,
      (t: (typeof tiles)[number]) => (t.longitude + t.latitude) % 2 === 1,
    ]) {
      const agree = tiles.filter((t, i) => pattern(t) === picks[i]!.mirrored).length;
      expect(agree / tiles.length).toBeGreaterThan(0.25);
      expect(agree / tiles.length).toBeLessThan(0.75);
    }
  });

  it("ignores an alternate without an appear clip in saved data", () => {
    for (const tile of tiles)
      expect(
        tileVariation(
          { appearAnimation: "", animationAlternate: "alternate" },
          tile.longitude,
          tile.latitude,
        ).appearAnimation,
      ).toBe("");
  });

  it("changes nothing for effects without variation settings", () => {
    for (const tile of tiles)
      expect(
        tileVariation({ appearAnimation: "animation" }, tile.longitude, tile.latitude),
      ).toEqual({
        mirrored: false,
        delayMs: 0,
        appearAnimation: "animation",
      });
  });

  it("mirrors both clips on the picked tiles while keeping their fit", async () => {
    const scene = setup();
    const effects = [
      groundEffect("mirrored", mirroredTile, { animationMirror: true }),
      groundEffect("plain", plainTile, { animationMirror: true }),
    ];
    await show(scene, effects);
    scene.effects.animate(0, false, false, null);
    for (const [effect, sign] of [
      [effects[0]!, -1],
      [effects[1]!, 1],
    ] as const) {
      const tile = scene.grid.getHex({ col: effect.longitude, row: effect.latitude })!;
      const clips = clipsOf(scene, effect.id);
      expect(clips).toHaveLength(2);
      for (const clip of clips) {
        expect(Math.sign(clip.scale.x)).toBe(sign);
        expect(clip.scale.y).toBeLessThan(0);
        expect(clip.getBounds().width).toBeCloseTo(tile.height);
        expect(clip.getBounds().height).toBeCloseTo(tile.height);
        expect(clip.position.x).toBeCloseTo(tile.width / 2);
      }
    }
  });

  it("holds a staggered tile's clips back and counts them as still arriving", async () => {
    const scene = setup();
    const tile = tiles.find((t) => vary(t).delayMs >= 200)!;
    const { delayMs } = vary(tile);
    await show(scene, [
      groundEffect("late", tile, { animationStagger: 600, staticAnimation: "" }),
    ]);
    scene.effects.animate(0, false, false, null);
    const [clip] = clipsOf(scene, "late");
    expect(clip!.visible).toBe(false);
    expect(scene.effects.isPlaying()).toBe(true);
    scene.effects.animate(delayMs - 1, false, false, null);
    expect(clip!.visible).toBe(false);
    scene.effects.animate(delayMs, false, false, null);
    expect(clip!.visible).toBe(true);
    // The four 10 ms frames run from the tile's own start.
    scene.effects.animate(delayMs + 39, false, false, null);
    expect(clipsOf(scene, "late")).toHaveLength(1);
    scene.effects.animate(delayMs + 40, false, false, null);
    expect(clipsOf(scene, "late")).toHaveLength(0);
  });

  it("ripples each tile's start outward from the caster's tile", async () => {
    const scene = setup();
    const castFrom = { longitude: 2, latitude: 2 };
    const ring = [
      { longitude: 2, latitude: 2 },
      { longitude: 3, latitude: 2 },
      { longitude: 5, latitude: 2 },
    ];
    await show(
      scene,
      ring.map((tile, index) =>
        groundEffect(`r${index}`, tile, {
          animationRipple: 100,
          staticAnimation: "",
          castFrom,
        }),
      ),
    );
    const origin = scene.grid.getHex({ col: 2, row: 2 })!;
    const hexes = ring.map((t) =>
      scene.grid.distance(
        origin,
        scene.grid.getHex({ col: t.longitude, row: t.latitude })!,
      ),
    );
    expect(hexes).toEqual([0, 1, 3]);
    expect(
      tileVariation({ appearAnimation: "a", animationRipple: 100 }, 5, 2, 3).delayMs,
    ).toBe(300);
    scene.effects.animate(0, false, false, null);
    const visible = (index: number) => clipsOf(scene, `r${index}`)[0]!.visible;
    expect([visible(0), visible(1), visible(2)]).toEqual([true, false, false]);
    scene.effects.animate(99, false, false, null);
    expect([visible(1), visible(2)]).toEqual([false, false]);
    scene.effects.animate(100, false, false, null);
    expect([visible(1), visible(2)]).toEqual([true, false]);
    scene.effects.animate(299, false, false, null);
    expect(visible(2)).toBe(false);
    scene.effects.animate(300, false, false, null);
    expect(visible(2)).toBe(true);
  });

  it("caps a tile's total delay", () => {
    const far = tileVariation(
      { appearAnimation: "a", animationStagger: 1000, animationRipple: 300 },
      11,
      9,
      15,
    );
    expect(far.delayMs).toBe(MAX_TILE_DELAY_MS);
  });

  it("does not ripple an effect without a recorded caster tile", async () => {
    const scene = setup();
    await show(scene, [
      groundEffect(
        "free",
        { longitude: 6, latitude: 6 },
        { animationRipple: 300, staticAnimation: "" },
      ),
    ]);
    scene.effects.animate(0, false, false, null);
    expect(clipsOf(scene, "free")[0]!.visible).toBe(true);
  });

  it("shows effects already on the board at once when a battle loads", async () => {
    const scene = setup();
    const tile = tiles.find((t) => vary(t).delayMs >= 200)!;
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
      groundEffects: [groundEffect("loaded", tile, { animationStagger: 600 })],
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot, true);
    scene.effects.animate(0, false, false, null);
    const clips = clipsOf(scene, "loaded");
    expect(clips).toHaveLength(1);
    expect(clips[0]!.visible).toBe(true);
  });

  it("finishes a waiting tile's clip after its effect leaves the battle, and drops its loop", async () => {
    const scene = setup();
    const tile = tiles.find((t) => vary(t).delayMs >= 200)!;
    const { delayMs } = vary(tile);
    const late = groundEffect("late", tile, { animationStagger: 600 });
    await show(scene, [late]);
    scene.effects.animate(0, false, false, null);
    expect(clipsOf(scene, "late")).toHaveLength(2);
    // The next action removes the effect before this tile's clip has begun.
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    const root = scene.effects.container.getChildByLabel("late")!;
    expect(clipsOf(scene, "late")).toHaveLength(1);
    scene.effects.animate(delayMs, false, false, null);
    expect(root.visible).toBe(true);
    expect(clipsOf(scene, "late")[0]!.visible).toBe(true);
    expect(scene.effects.isPlaying()).toBe(true);
    scene.effects.animate(delayMs + 39, false, false, null);
    expect(clipsOf(scene, "late")).toHaveLength(1);
    // Once the clip has played, the departed effect is cleaned up.
    scene.effects.animate(delayMs + 40, false, false, null);
    expect(scene.effects.container.getChildByLabel("late")).toBeNull();
    expect(root.destroyed).toBe(true);
    expect(scene.effects.isPlaying()).toBe(false);
  });

  it("plays a one-shot clip whose effect leaves the battle while its texture loads", async () => {
    const scene = setup();
    const texture = await Assets.load("loaded");
    let release = () => {};
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(Assets, "load").mockImplementation(async () => {
      await loading;
      return texture;
    });
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
      groundEffects: [groundEffect("racing", plainTile)],
    }) as unknown as ReturnedBattle;
    const arriving = scene.effects.sync(scene.snapshot);
    // The next action removes the effect before its textures arrive.
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    release();
    await arriving;
    scene.effects.animate(0, false, false, null);
    const clips = clipsOf(scene, "racing");
    expect(clips).toHaveLength(1);
    expect(clips[0]!.visible).toBe(true);
    expect(scene.effects.isPlaying()).toBe(true);
    scene.effects.animate(40, false, false, null);
    expect(scene.effects.container.getChildByLabel("racing")).toBeNull();
  });

  it("drops an effect that leaves while loading once it has no one-shot clip", async () => {
    const scene = setup();
    const texture = await Assets.load("loaded");
    let release = () => {};
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(Assets, "load").mockImplementation(async () => {
      await loading;
      return texture;
    });
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
      groundEffects: [groundEffect("looping", plainTile, { appearAnimation: "" })],
    }) as unknown as ReturnedBattle;
    const arriving = scene.effects.sync(scene.snapshot);
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    release();
    await arriving;
    expect(scene.effects.container.getChildByLabel("looping")).toBeNull();
  });

  it("keeps a hidden character effect's loop for when its fighter returns", async () => {
    const scene = setup();
    const target = makeBattleUser("target", plainTile);
    const attached = makeEffect(
      "visual",
      { staticAnimation: "animation" },
      {
        id: "attached",
        creatorId: "caster",
        targetId: target.userId,
        targetType: "user",
      },
    );
    await show(scene, [], { usersState: [target], usersEffects: [attached] });
    scene.effects.animate(0, false, false, null);
    expect(clipsOf(scene, "attached")).toHaveLength(1);
    const battle = scene.snapshot.battle;
    battle.usersState[0]!.curHealth = 0;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(10, false, false, null);
    expect(scene.effects.container.getChildByLabel("attached")!.visible).toBe(false);
    battle.usersState[0]!.curHealth = 100;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(20, false, false, null);
    expect(clipsOf(scene, "attached")).toHaveLength(1);
    expect(scene.effects.container.getChildByLabel("attached")!.visible).toBe(true);
  });

  it("starts over when an id returns while its earlier clips are still finishing", async () => {
    const scene = setup();
    const effect = groundEffect("returning", plainTile);
    await show(scene, [effect]);
    scene.effects.animate(0, false, false, null);
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    expect(clipsOf(scene, "returning")).toHaveLength(1);
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
      groundEffects: [effect],
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(10, false, false, null);
    const clips = clipsOf(scene, "returning");
    expect(clips).toHaveLength(2);
    expect(clips.every((clip) => clip.visible)).toBe(true);
  });

  it("starts over when an id returns on a downed fighter while its clips finish", async () => {
    const scene = setup();
    const target = makeBattleUser("target", plainTile);
    const attached = makeEffect(
      "visual",
      { appearAnimation: "animation", staticAnimation: "animation" },
      {
        id: "attached",
        creatorId: "caster",
        targetId: target.userId,
        targetType: "user",
      },
    );
    await show(scene, [], { usersState: [target], usersEffects: [attached] });
    scene.effects.animate(0, false, false, null);
    const battle = scene.snapshot.battle;
    battle.usersEffects = [];
    await scene.effects.sync(scene.snapshot);
    expect(clipsOf(scene, "attached")).toHaveLength(1);
    battle.usersEffects = [attached];
    battle.usersState[0]!.curHealth = 0;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(60_000, false, false, null);
    battle.usersState[0]!.curHealth = 100;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(60_010, false, false, null);
    expect(clipsOf(scene, "attached")).toHaveLength(2);
  });

  it("starts staggered tiles together under reduced motion", async () => {
    const scene = setup();
    const tile = tiles.find((t) => vary(t).delayMs >= 200)!;
    await show(scene, [
      groundEffect("late", tile, { animationStagger: 600, staticAnimation: "" }),
    ]);
    scene.effects.animate(0, true, false, null);
    expect(clipsOf(scene, "late")[0]!.visible).toBe(true);
  });

  it("plays the alternate appear clip on the picked tiles only", async () => {
    const scene = setup();
    const other = tiles.find((t) => vary(t).appearAnimation === "animation")!;
    await show(scene, [
      groundEffect("alternate", alternateTile, {
        animationAlternate: "alternate",
        staticAnimation: "",
      }),
      groundEffect("base", other, {
        animationAlternate: "alternate",
        staticAnimation: "",
      }),
    ]);
    scene.effects.animate(0, false, false, null);
    // Two 10 ms frames for the alternate, four for the base clip.
    scene.effects.animate(20, false, false, null);
    expect(clipsOf(scene, "alternate")).toHaveLength(0);
    expect(clipsOf(scene, "base")).toHaveLength(1);
  });

  it("never varies effects on a character", async () => {
    const scene = setup();
    const target = makeBattleUser("target", mirroredTile);
    const attached = makeEffect(
      "visual",
      { staticAnimation: "animation", ...varied },
      {
        id: "attached",
        creatorId: "caster",
        targetId: target.userId,
        targetType: "user",
      },
    );
    await show(scene, [], { usersState: [target], usersEffects: [attached] });
    scene.effects.animate(0, false, false, null);
    const clips = clipsOf(scene, "attached");
    expect(clips).toHaveLength(2);
    for (const clip of clips) {
      expect(clip.scale.x).toBeGreaterThan(0);
      expect(clip.visible).toBe(true);
    }
  });

  it("re-picks the orientation when a ground effect moves to another tile", async () => {
    const scene = setup();
    const effect = groundEffect("moving", mirroredTile, { animationMirror: true });
    await show(scene, [effect]);
    for (const clip of clipsOf(scene, "moving")) expect(clip.scale.x).toBeLessThan(0);
    Object.assign(effect, plainTile);
    await scene.effects.sync(scene.snapshot);
    for (const clip of clipsOf(scene, "moving"))
      expect(clip.scale.x).toBeGreaterThan(0);
  });
});
