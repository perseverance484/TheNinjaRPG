import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
  Assets,
  BufferImageSource,
  Container,
  type Mesh,
  type Sprite,
  Texture,
} from "pixi.js";
import type { GameAsset } from "@/drizzle/schema";
import { insertAction } from "@/libs/combat/actions";
import { maskBattle } from "@/libs/combat/masking";
import {
  buildPlaybackFrames,
  createCombatPlaybackRecorder,
} from "@/libs/combat/playback";
import { applyEffects, expireGroundEffects } from "@/libs/combat/process";
import type { GroundEffect, ReturnedBattle } from "@/libs/combat/types";
import { getBattleGrid } from "@/libs/combat/util";
import { groundDecalBoundaries } from "@/libs/rendering/primitives/groundDecal";
import type { GameRenderer } from "@/libs/rendering/runtime";
import {
  createCombatEffects,
  MAX_TILE_DELAY_MS,
  tileVariation,
} from "@/libs/rendering/scenes/combatEffects";
import { createCombatPlayback } from "@/libs/rendering/scenes/combatPlayback";
import {
  CloneTag,
  DamageTag,
  PoisonTag,
  SkillTreeValidator,
  VisualTag,
} from "@/validators/combat";
import {
  makeBasicAttack,
  makeBattleUser,
  makeCombatAction,
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

const setupProjectileReplay = (strike = false) => {
  const scene = setup();
  Object.assign(scene.effect, {
    creatorId: "caster",
    longitude: 4,
    latitude: 0,
    projectileAnimation: "animation",
    appearAnimation: "animation",
    staticAnimation: "",
  });
  const caster = makeBattleUser("caster", {
    curHealth: 100,
    longitude: 0,
    latitude: 0,
  });
  const previous = {
    ...scene.snapshot.battle,
    version: 1,
    usersState: [caster],
    groundEffects: [],
  };
  const changes = {
    userId: "caster",
    curHealth: 60,
    ...(strike
      ? {
          spriteAction: {
            id: "strike",
            animation: "slash" as const,
            longitude: 0,
            latitude: 0,
          },
        }
      : {}),
  };
  const next: ReturnedBattle = {
    ...previous,
    version: 2,
    usersState: [{ ...caster, ...changes }],
    groundEffects: [scene.effect],
    playback: [
      {
        version: 2,
        actorId: "caster",
        userIds: ["caster"],
        users: [changes],
        addedEffectIds: [scene.effect.id],
        removedEffectIds: [],
        hits: [{ userId: "caster", amount: -40 }],
      },
    ],
  };
  const playback = createCombatPlayback(previous);
  playback.receive(next);
  const tick = (now: number, instant = false) =>
    playback.tick({
      now,
      instant,
      moving: false,
      cue: () => 1,
      projectilesArrived: scene.effects.projectilesArrived,
    });
  return { ...scene, playback, tick, next };
};

describe("Pixi combat effects", () => {
  it("raises protective clips without moving their ground artwork or changing their scale", async () => {
    const scene = setup();
    Object.assign(scene.effect, {
      appearAnimation: "animation",
      animationOffsetY: 0.5,
    });
    await scene.effects.sync(scene.snapshot);
    const tile = scene.grid.getHex({ col: 3, row: 1 })!;
    scene.effects.animate(0, false, false, null);
    for (const sprite of scene.effects.container.children[0]!.children as Sprite[]) {
      expect(sprite.y).toBeCloseTo(tile.height);
      expect(sprite.height).toBeCloseTo(tile.height);
    }
  });
  it("fades only a field perimeter, including newly exposed edges after expiry", () => {
    const { grid } = setup();
    const first = grid.getHex({ col: 3, row: 1 })!;
    const next = grid.getHex({ col: 4, row: 1 })!;
    const tiles = [
      { id: "first", material: "shadow", tile: first },
      { id: "next", material: "shadow", tile: next },
    ];
    const joined = groundDecalBoundaries(tiles);
    expect(joined.get("first")?.filter(Boolean)).toHaveLength(5);
    expect(joined.get("next")?.filter(Boolean)).toHaveLength(5);
    expect(
      groundDecalBoundaries(tiles.slice(0, 1)).get("first")?.filter(Boolean),
    ).toHaveLength(6);
    expect(
      groundDecalBoundaries([tiles[0]!, { ...tiles[1]!, material: "fire" }])
        .get("first")
        ?.filter(Boolean),
    ).toHaveLength(6);
    expect(
      groundDecalBoundaries([tiles[0]!, { ...tiles[0]!, id: "duplicate" }])
        .get("first")
        ?.filter(Boolean),
    ).toHaveLength(6);
  });
  it.each(["depleted", "projectile", "expired"] as const)(
    "feathers the exposed edge of a %s neighbor",
    async (state) => {
      const scene = setup();
      Object.assign(scene.effect, {
        staticAssetPath: "animation",
        staticAnimation: "",
        groundStyle: "DECAL",
        groundFeather: 0.1,
      });
      const neighbor = { ...scene.effect, id: "neighbor", longitude: 4 };
      scene.snapshot.battle.groundEffects.push(neighbor);
      await scene.effects.sync(scene.snapshot);
      const mesh = scene.effects.ground
        .getChildByLabel("effect")!
        .getChildByLabel("ground-surface") as Mesh;
      const outerEdges = () =>
        Object.entries(mesh.shader!.resources.style.uniforms).filter(
          ([key, value]) => key.startsWith("uEdge") && (value as number[])[3] === 1,
        ).length;
      expect(outerEdges()).toBe(5);
      if (state === "depleted") neighbor.power = 0;
      else if (state === "projectile") neighbor.projectileOnly = true;
      else scene.snapshot.battle.groundEffects = [scene.effect];
      await scene.effects.sync(scene.snapshot);
      expect(outerEdges()).toBe(6);
    },
  );
  it("attaches the latest perimeter when a neighbor expires during texture loading", async () => {
    const scene = setup();
    Object.assign(scene.effect, {
      staticAssetPath: "animation",
      staticAnimation: "",
      groundStyle: "DECAL",
      groundFeather: 0.1,
    });
    scene.snapshot.battle.groundEffects.push({
      ...scene.effect,
      id: "neighbor",
      longitude: 4,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(Assets, "load").mockImplementation(async () => {
      await gate;
      return new Texture({
        source: new BufferImageSource({
          resource: new Uint8Array(16 * 16 * 4),
          width: 16,
          height: 16,
        }),
      });
    });
    const pending = scene.effects.sync(scene.snapshot);
    scene.snapshot.battle.groundEffects = [scene.effect];
    await scene.effects.sync(scene.snapshot);
    release();
    await pending;
    const mesh = scene.effects.ground
      .getChildByLabel("effect")!
      .getChildByLabel("ground-surface") as Mesh;
    expect(
      Object.entries(mesh.shader!.resources.style.uniforms).filter(
        ([key, value]) => key.startsWith("uEdge") && (value as number[])[3] === 1,
      ),
    ).toHaveLength(6);
  });
  it("emits one projectile and primary cue for a persistent cast on an occupied tile", async () => {
    const scene = setup();
    scene.snapshot.battle.groundEffects = [
      makeEffect(
        "stun",
        {
          rounds: 3,
          appearSfx: "appear",
          appearSfxPrimary: true,
          projectileAnimation: "animation",
        },
        {
          id: "cast",
          creatorId: "caster",
          actionId: "action",
          longitude: 4,
          latitude: 1,
          isNew: true,
          createdRound: 2,
          targetType: "user",
        },
      ),
    ];
    const battle = applyEffects(
      makeCompleteBattle({
        round: 2,
        groundEffects: scene.snapshot.battle.groundEffects,
        usersState: [
          makeBattleUser("caster", { longitude: 2, latitude: 1 }),
          makeBattleUser("target", { longitude: 4, latitude: 1 }),
        ],
      }),
      "caster",
    ).newBattle;
    const onsets = battle.groundEffects.filter(
      (effect) => effect.type === "visual" && effect.appearSfx === "appear",
    );
    expect(onsets).toHaveLength(1);
    expect(onsets[0]?.projectileAnimation).toBe("animation");
    expect(
      battle.groundEffects.some(
        (effect) => effect.id === "cast" && effect.type === "stun",
      ),
    ).toBe(true);
    await scene.effects.sync({ ...scene.snapshot, battle });
    scene.effects.animate(0, false, false, null);
    expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);
  });
  it("shares a cast's sound across tiles without silencing later casts or another caster", async () => {
    const scene = setup();
    Object.assign(scene.effect, {
      creatorId: "caster",
      actionId: "wall",
      createdRound: 1,
    });
    scene.snapshot.battle.groundEffects.push({
      ...scene.effect,
      id: "second-tile",
      longitude: 4,
    });
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);

    scene.snapshot.battle.groundEffects.push(
      { ...scene.effect, id: "next-cast", longitude: 5 },
      { ...scene.effect, id: "other-caster", creatorId: "other", longitude: 6 },
    );
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(20, false, false, null);
    expect(scene.play).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])(
    "uses a marked primary cue regardless of tile order (%s)",
    async (reverse) => {
      const scene = setup();
      scene.snapshot.assets.push({ id: "accent", url: "accent.wav" } as GameAsset);
      Object.assign(scene.effect, {
        creatorId: "caster",
        actionId: "composite",
        createdRound: 1,
      });
      const primary = {
        ...scene.effect,
        id: "primary",
        longitude: 4,
        appearSfxPrimary: true,
      };
      scene.effect.appearSfx = "accent";
      scene.snapshot.battle.groundEffects = reverse
        ? [primary, scene.effect]
        : [scene.effect, primary];
      await scene.effects.sync(scene.snapshot);
      scene.effects.animate(0, false, false, null);
      expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);

      scene.snapshot.battle.groundEffects.push({
        ...primary,
        id: "later",
        createdRound: 2,
      });
      await scene.effects.sync(scene.snapshot);
      scene.effects.animate(20, false, false, null);
      expect(scene.play).toHaveBeenCalledTimes(2);
    },
  );
  it("retains distinct layered cues on casts without a primary", async () => {
    const scene = setup();
    scene.snapshot.assets.push({ id: "accent", url: "accent.wav" } as GameAsset);
    scene.snapshot.battle.groundEffects.push({
      ...scene.effect,
      id: "accent",
      longitude: 4,
      appearSfx: "accent",
    });
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    expect(scene.play.mock.calls).toEqual([
      ["appear.wav", 0.4],
      ["accent.wav", 0.4],
    ]);
  });
  it("preserves unmarked transient visuals' existing sound deduplication", async () => {
    const scene = setup();
    Object.assign(scene.effect, {
      creatorId: "caster",
      actionId: "visual",
      createdRound: 2,
      soundOrigin: { actionId: "first", createdRound: 1, phase: "disappear" },
    });
    scene.snapshot.battle.groundEffects.push({
      ...scene.effect,
      id: "second",
      longitude: 4,
      soundOrigin: { actionId: "second", createdRound: 1, phase: "disappear" },
    });
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);
  });
  it.each([
    { phase: "appear", tag: "poison" },
    { phase: "appear", tag: "visual" },
    { phase: "disappear", tag: "poison" },
  ] as const)(
    "preserves private primary $phase cues for $tag tags and deduplicates target copies",
    async ({ phase, tag }) => {
      const battle = makeCompleteBattle({
        width: 5,
        height: 5,
        createdAt: new Date("2020-01-01"),
        usersState: [
          makeBattleUser("caster", {
            direction: "left",
            longitude: 0,
            latitude: 0,
            enemySkillIds: ["private-skill", "private-bloodright"],
          }),
          makeBattleUser("victim", { direction: "right", longitude: 2, latitude: 0 }),
          makeBattleUser("other", { direction: "right", longitude: 3, latitude: 0 }),
        ],
      });
      const schema = tag === "visual" ? VisualTag : PoisonTag;
      battle.extraState.enemySkills = {
        "private-skill": [
          schema.parse({
            power: 20,
            rounds: 3,
            [`${phase}Sfx`]: "a",
            [`${phase}SfxPrimary`]: true,
          }),
        ],
        "private-bloodright": [
          schema.parse({
            power: 10,
            rounds: 2,
            [`${phase}Sfx`]: "b",
            [`${phase}SfxPrimary`]: true,
          }),
        ],
      };
      for (const effects of Object.values(battle.extraState.enemySkills))
        expect(SkillTreeValidator.shape.effects.safeParse(effects).success).toBe(true);
      expect(
        insertAction({
          battle,
          grid: getBattleGrid(20, battle),
          action: makeBasicAttack({ range: 5, methodSize: { x: 1, y: 0 } }),
          actorId: "caster",
          longitude: 2,
          latitude: 0,
        }),
      ).toBe(true);
      expect(
        (tag === "visual" ? battle.groundEffects : battle.usersEffects).filter(
          (effect) => effect.fromType === "skill",
        ),
      ).toHaveLength(4);
      let { newBattle } = applyEffects(battle, "caster");
      if (phase === "disappear") {
        for (const effect of newBattle.usersEffects) effect.rounds = 0;
        newBattle = applyEffects(newBattle, "caster").newBattle;
      }
      const before = structuredClone(newBattle);
      for (const viewer of ["caster", "victim", "spectator"]) {
        const scene = setup();
        const masked = maskBattle(newBattle, viewer);
        await scene.effects.sync({
          ...scene.snapshot,
          battle: masked,
          assets: [
            { id: "a", url: "a.wav" },
            { id: "b", url: "b.wav" },
          ] as GameAsset[],
        });
        scene.effects.animate(0, false, false, null);
        expect(scene.play.mock.calls).toEqual([
          ["a.wav", 0.4],
          ["b.wav", 0.4],
        ]);
        if (viewer !== "caster") {
          expect(JSON.stringify(masked)).not.toContain("private-skill");
          expect(JSON.stringify(masked)).not.toContain("private-bloodright");
          if (tag === "visual")
            expect(
              new Set(
                masked.groundEffects
                  .filter((effect) => effect.fromType === "skill")
                  .map((effect) => effect.actionId),
              ).size,
            ).toBe(2);
          for (const effect of masked.usersEffects.filter(
            (entry) => entry.fromType === "skill",
          )) {
            const onset = masked.groundEffects.find(
              (entry) => entry.soundOrigin?.actionId === effect.actionId,
            );
            expect(onset?.soundOrigin?.actionId).toBe(effect.actionId);
          }
        }
      }
      expect(newBattle).toEqual(before);
    },
  );
  it("keeps primary appearance and disappearance independent during movement", async () => {
    const scene = setup();
    scene.snapshot.assets.push({ id: "accent", url: "accent.wav" } as GameAsset);
    Object.assign(scene.effect, {
      creatorId: "caster",
      actionId: "composite",
      createdRound: 1,
      appearSfxPrimary: true,
      disappearSfxPrimary: true,
    });
    const accent = {
      ...scene.effect,
      id: "accent",
      longitude: 4,
      appearSfx: "accent",
      disappearSfx: "accent",
      appearSfxPrimary: false,
      disappearSfxPrimary: false,
    };
    scene.snapshot.battle.groundEffects.push(accent);
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, true, null);
    scene.effect.power = accent.power = 0;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(20, false, true, null);
    expect(scene.play).not.toHaveBeenCalled();
    scene.effects.animate(30, false, false, null);
    scene.effects.animate(81, false, false, null);
    expect(scene.play.mock.calls).toEqual([
      ["appear.wav", 0.4],
      ["disappear.wav", 0.4],
    ]);
  });
  it("preserves a composite's selected removal cue through authoritative expiry", async () => {
    const scene = setup();
    scene.snapshot.assets.push({ id: "accent", url: "accent.wav" } as GameAsset);
    const effect = makeEffect(
      "shield",
      {
        power: 1,
        health: 1,
        rounds: 1,
        disappearAnimation: "animation",
        disappearSfx: "disappear",
        disappearSfxPrimary: true,
      },
      {
        longitude: 3,
        latitude: 1,
        isNew: false,
        creatorId: "caster",
        actionId: "composite",
        createdRound: 1,
      },
    );
    effect.rounds = 0;
    const battle = makeCompleteBattle({
      round: 2,
      groundEffects: [
        {
          ...effect,
          id: "accent",
          longitude: 4,
          disappearSfx: "accent",
          disappearSfxPrimary: false,
        },
        effect,
      ],
    });
    expireGroundEffects(battle, []);
    scene.snapshot.battle = battle as unknown as ReturnedBattle;
    expect(battle.groundEffects[1]).toMatchObject({
      appearSfxPrimary: true,
      soundOrigin: { actionId: "composite", createdRound: 1, phase: "disappear" },
    });
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    expect(scene.play.mock.calls).toEqual([["disappear.wav", 0.4]]);
  });
  it.each([false, true])(
    "waits for a delayed projectile's visible flight before landing health, log and sound (strike: %s)",
    async (strike) => {
      const scene = setupProjectileReplay(strike);
      const texture = new Texture({
        source: new BufferImageSource({
          resource: new Uint8Array(4 * 16 * 4),
          width: 4,
          height: 16,
        }),
      });
      let resolveTexture!: (texture: Texture) => void;
      const loading = new Promise<Texture>((resolve) => {
        resolveTexture = resolve;
      });
      vi.spyOn(Assets, "load").mockImplementationOnce(() => loading);
      scene.tick(0);
      const travelling = scene.tick(1);
      const pending = scene.effects.sync({ ...scene.snapshot, battle: travelling });
      scene.effects.animate(1, false, false, null);
      expect(scene.tick(650)).toBe(travelling);
      expect(scene.effects.container.children[0]?.children).toHaveLength(0);
      expect(scene.playback.logVersion()).toBe(1);
      expect(scene.playback.takeHits()).toBeUndefined();
      expect(scene.play).not.toHaveBeenCalled();

      resolveTexture(texture);
      await pending;
      // Loading alone does not start a flight: its first rendered frame does.
      expect(scene.tick(800)).toBe(travelling);
      scene.effects.animate(800, false, false, null);
      const projectile = scene.effects.container.children[0]!.children[0] as Sprite;
      const origin = projectile.x;
      expect(projectile.visible).toBe(true);
      expect(scene.tick(1000)).toBe(travelling);
      scene.effects.animate(1000, false, false, null);
      expect(projectile.visible).toBe(true);
      expect(projectile.x).not.toBe(origin);
      expect(scene.tick(1339)).toBe(travelling);
      expect(scene.tick(1340)).toBe(scene.next);
      expect(scene.next.usersState[0]?.curHealth).toBe(60);
      expect(scene.playback.takeHits()).toEqual([{ userId: "caster", amount: -40 }]);
      expect(scene.playback.takeHits()).toBeUndefined();
      await scene.effects.sync({ ...scene.snapshot, battle: scene.next });
      scene.effects.animate(1340, false, false, null);
      expect(projectile.destroyed).toBe(true);
      expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);
    },
  );
  it("lands a failed projectile load without waiting for the replay timeout", async () => {
    const scene = setupProjectileReplay();
    vi.spyOn(Assets, "load").mockRejectedValueOnce(new Error("Unavailable artwork"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const travelling = scene.tick(0);
    await scene.effects.sync({ ...scene.snapshot, battle: travelling });
    expect(warn).toHaveBeenCalled();
    expect(scene.tick(1)).toBe(scene.next);
    expect(scene.playback.takeHits()).toEqual([{ userId: "caster", amount: -40 }]);
  });
  it("bounds a stalled projectile load and discards artwork arriving after timeout", async () => {
    const scene = setupProjectileReplay();
    let resolveTexture!: (texture: Texture) => void;
    const loading = new Promise<Texture>((resolve) => {
      resolveTexture = resolve;
    });
    vi.spyOn(Assets, "load").mockImplementationOnce(() => loading);
    const travelling = scene.tick(0);
    const pending = scene.effects.sync({ ...scene.snapshot, battle: travelling });
    expect(scene.tick(3999)).toBe(travelling);
    expect(scene.tick(4000)).toBe(scene.next);
    expect(scene.playback.isPlaying()).toBe(false);
    expect(scene.playback.takeHits()).toEqual([{ userId: "caster", amount: -40 }]);
    // Removing the expired flight must also cancel its pending sprite creation.
    const root = scene.effects.container.children[0]!;
    const impact = scene.effects.sync({ ...scene.snapshot, battle: scene.next });
    resolveTexture(
      new Texture({
        source: new BufferImageSource({
          resource: new Uint8Array(4 * 16 * 4),
          width: 4,
          height: 16,
        }),
      }),
    );
    await Promise.all([pending, impact]);
    scene.effects.animate(4100, false, false, null);
    expect(root.destroyed).toBe(true);
    expect(scene.effects.projectilesArrived(4100)).toBe(false);
    expect(scene.playback.presented()).toBe(scene.next);
  });
  it("moves a cast from its creator to its target, then replaces travel with impact once", async () => {
    const scene = setup();
    scene.snapshot.battle.usersState = [
      makeBattleUser("caster", { longitude: 2, latitude: 1 }),
    ];
    Object.assign(scene.effect, {
      creatorId: "caster",
      projectileAnimation: "animation",
      projectileScale: 2,
      projectileOnly: true,
      staticAnimation: "",
      appearSfx: "",
    });
    await scene.effects.sync(scene.snapshot);
    const root = scene.effects.container.children[0]!;
    const projectile = root.children[0] as Sprite;
    scene.effects.animate(0, false, false, null);
    expect(scene.play).not.toHaveBeenCalled();
    const tile = scene.grid.getHex({ col: 3, row: 1 })!;
    expect(projectile.width).toBeCloseTo(tile.height * 0.65 * 2);
    const start = projectile.x;
    scene.effects.animate(100, false, false, null);
    expect(projectile.x).not.toBe(start);
    scene.effects.animate(650, false, false, null);
    expect(projectile.visible).toBe(false);
    Object.assign(scene.effect, {
      projectileOnly: false,
      appearAnimation: "animation",
      appearSfx: "appear",
    });
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(650, false, false, null);
    expect(root.destroyed).toBe(true);
    expect(scene.effects.container.children[0]?.children).toHaveLength(1);
    const impact = scene.effects.container.children[0]?.children[0] as Sprite;
    expect(impact.width).toBeCloseTo(tile.height);
    expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(660, false, false, null);
    expect(scene.play).toHaveBeenCalledTimes(1);
  });
  it("keeps a surface loop flattened through texture-frame changes", async () => {
    const scene = setup();
    scene.effect.groundStyle = "SURFACE";
    await scene.effects.sync(scene.snapshot);
    const sprite = scene.effects.ground.children[0]!.children[0] as Sprite;
    const tile = scene.grid.getHex({ col: 3, row: 1 })!;
    for (const now of [0, 10, 30, 80]) {
      scene.effects.animate(now, false, false, null);
      expect(sprite.height).toBeCloseTo(tile.height * 0.55);
    }
  });
  it("does not launch projectiles when hydrating an already-landed effect", async () => {
    const scene = setup();
    Object.assign(scene.effect, {
      projectileAnimation: "animation",
      staticAnimation: "",
    });
    await scene.effects.sync(scene.snapshot, true);
    scene.effects.animate(0, true, false, null);
    expect(scene.effects.container.children[0]?.children).toHaveLength(0);
    expect(scene.play).not.toHaveBeenCalled();
  });
  it("keeps an upright eruption above a separately softened ground decal", async () => {
    const scene = setup();
    Object.assign(scene.effect, {
      groundStyle: "DECAL",
      groundOpacity: 0.7,
      groundFeather: 0.1,
      staticAssetPath: "animation",
      staticAnimation: "",
      appearAnimation: "animation",
    });
    await scene.effects.sync(scene.snapshot);
    const root = scene.effects.container.children[0]!;
    const sprite = root.children[0] as Sprite;
    const tile = scene.grid.getHex({ col: 3, row: 1 })!;
    scene.effects.animate(0, false, false, null);
    expect(sprite.height).toBeCloseTo(tile.height);
    expect(sprite.alpha).toBe(1);
    expect(
      scene.effects.ground.children[0]!.getChildByLabel("ground-surface"),
    ).toBeDefined();
  });
  it("owns a feathered ground decal below actors and releases it on expiry", async () => {
    const scene = setup();
    Object.assign(scene.effect, {
      groundStyle: "SURFACE",
      groundOpacity: 0.6,
      groundFeather: 0.12,
      staticAssetPath: "animation",
      staticAnimation: "",
    });
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(0, false, false, null);
    const surface = scene.effects.ground.children[0]!;
    expect(surface.getChildByLabel("ground-surface")).toBeDefined();
    const root = scene.effects.container.children[0]!;
    expect([surface.x, surface.y]).toEqual([root.x, root.y]);
    scene.snapshot.battle.groundEffects = [];
    await scene.effects.sync(scene.snapshot);
    expect(surface.destroyed).toBe(true);
  });
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
  it.each(
    [false, true].flatMap((cloneActor) =>
      [false, true].flatMap((privateSource) =>
        (["boundary", "application"] as const).map((expiry) => ({
          cloneActor,
          privateSource,
          expiry,
        })),
      ),
    ),
  )(
    "groups each clone cast phase (clone actor: $cloneActor, private: $privateSource, expiry: $expiry)",
    async ({ cloneActor, privateSource, expiry }) => {
      const scene = setup();
      const battle = makeCompleteBattle({
        width: 12,
        height: 10,
        version: 1,
        round: 1,
        createdAt: new Date(0),
        usersState: [
          makeBattleUser("caster", {
            longitude: 0,
            latitude: 0,
            controllerId: cloneActor ? "owner" : "caster",
            isSummon: cloneActor,
            isOriginal: !cloneActor,
          }),
          makeBattleUser("owner", { longitude: 5, latitude: 0 }),
        ],
      });
      const action = makeCombatAction({
        target: "EMPTY_GROUND",
        range: 3,
        level: 1,
        effects: [0, 1].map(() =>
          CloneTag.parse({
            rounds: 3,
            power: 50,
            projectileAnimation: "animation",
            appearSfx: "appear",
            appearSfxPrimary: true,
            disappearSfx: "disappear",
            disappearSfxPrimary: true,
          }),
        ),
      });
      const previous = maskBattle(structuredClone(battle), "observer");
      const recorder = createCombatPlaybackRecorder(battle);
      expect(
        insertAction({
          battle,
          grid: getBattleGrid(20, battle),
          action,
          actorId: "caster",
          longitude: 2,
          latitude: 0,
        }),
      ).toBe(true);
      if (privateSource)
        for (const effect of battle.groundEffects) effect.fromType = "armor";
      let resolved = applyEffects(battle, "caster", action).newBattle;
      const cloneEffects = resolved.groundEffects.filter((e) => e.type === "clone");
      const cloneIds = cloneEffects.map((e) => e.creatorId);
      expect(cloneIds).toHaveLength(2);
      expect(new Set(cloneIds).size).toBe(2);
      expect(cloneIds).not.toContain("caster");
      expect(
        resolved.usersState.filter((u) => cloneIds.includes(u.userId)),
      ).toHaveLength(2);
      recorder.record(resolved, 2, "caster", []);
      resolved.version = 2;
      const arrival = maskBattle(structuredClone(resolved), "observer");
      arrival.playback = recorder.steps;
      const [arrivalFrame] = buildPlaybackFrames(previous, arrival);
      expect(arrivalFrame?.actorId).toBe("caster");
      expect(arrivalFrame?.travel?.groundEffects).toHaveLength(2);
      expect(arrivalFrame?.travel?.groundEffects.map((e) => e.creatorId)).toEqual([
        "caster",
        "caster",
      ]);
      await scene.effects.sync({ ...scene.snapshot, battle: arrivalFrame!.travel! });
      scene.effects.animate(0, false, false, null);
      expect(scene.play).not.toHaveBeenCalled();
      await scene.effects.sync({ ...scene.snapshot, battle: arrivalFrame!.battle });
      scene.effects.animate(1000, false, false, null);
      expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);

      resolved = applyEffects(resolved, "caster").newBattle;
      expect(resolved.groundEffects.filter((e) => e.type === "clone")).toHaveLength(2);
      expect(resolved.usersState.map((u) => u.userId)).toEqual([
        "caster",
        "owner",
        ...cloneIds,
      ]);
      await scene.effects.sync({
        ...scene.snapshot,
        battle: maskBattle(resolved, "observer"),
      });
      scene.effects.animate(2000, false, false, null);
      expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);
      const expiryRecorder = createCombatPlaybackRecorder(resolved);
      resolved.round = 4;
      for (const effect of resolved.groundEffects)
        if (effect.type === "clone") effect.rounds = 0;
      if (expiry === "boundary") {
        expect(expireGroundEffects(resolved, [])).toHaveLength(2);
      } else {
        const result = applyEffects(resolved, "owner");
        resolved = result.newBattle;
        expect(
          result.actionEffects.filter((e) => e.txt.includes("disappears")),
        ).toHaveLength(2);
      }
      expect(resolved.usersState.map((u) => u.userId)).toEqual(["caster", "owner"]);
      const exits = resolved.groundEffects.filter(
        (e) => e.soundOrigin?.phase === "disappear",
      );
      expect(exits).toHaveLength(2);
      expect(cloneEffects.map((e) => e.creatorId)).toEqual(cloneIds);
      expect(exits.every((e) => !!e.soundOrigin?.privateSource)).toBe(privateSource);
      expiryRecorder.record(resolved, 3, "owner", []);
      resolved.version = 3;
      const next = maskBattle(resolved, "observer");
      next.playback = expiryRecorder.steps;
      const maskedExits = next.groundEffects.filter(
        (e) => e.soundOrigin?.phase === "disappear",
      );
      expect(new Set(maskedExits.map((e) => e.soundOrigin?.actionId)).size).toBe(1);
      if (privateSource)
        expect(maskedExits[0]?.soundOrigin?.actionId).not.toBe(action.id);
      const [frame] = buildPlaybackFrames(arrival, next);
      expect(frame?.actorId).toBe("owner");
      expect(frame?.travel).toBeUndefined();
      await scene.effects.sync({ ...scene.snapshot, battle: frame!.battle });
      scene.effects.animate(3000, false, false, null);
      expect(scene.play.mock.calls).toEqual([
        ["appear.wav", 0.4],
        ["disappear.wav", 0.4],
      ]);
      expect(exits.map((e) => e.creatorId)).toEqual(["caster", "caster"]);
      await scene.effects.sync({ ...scene.snapshot, battle: next });
      scene.effects.animate(4000, false, false, null);
      expect(scene.play).toHaveBeenCalledTimes(2);
    },
  );
  it.each(
    (["OTHER_USER", "SELF"] as const).flatMap((target) =>
      (["surviving", "damage first", "visual first"] as const).map((outcome) => ({
        target,
        outcome,
      })),
    ),
  )(
    "keeps one visual's arrival through a $target cast and replay ($outcome)",
    async ({ target, outcome }) => {
      const scene = setup();
      const battle = makeCompleteBattle({
        width: 12,
        height: 10,
        version: 1,
        createdAt: new Date("2020-01-01"),
        usersState: [
          makeBattleUser("caster", {
            direction: "left",
            longitude: 0,
            latitude: 0,
            curHealth: 1,
          }),
          makeBattleUser("victim", {
            direction: "right",
            longitude: 2,
            latitude: 0,
            curHealth: 1,
          }),
        ],
      });
      const tag = VisualTag.parse({
        rounds: 0,
        projectileAnimation: "animation",
        projectileScale: 1.25,
        appearAnimation: "animation",
        animationScale: 1.5,
        animationOffsetY: 0.25,
        staticAnimation: "animation",
        disappearAnimation: "animation",
        appearSfx: "appear",
        appearSfxPrimary: true,
        disappearSfx: "disappear",
        disappearSfxPrimary: true,
      });
      const damage = DamageTag.parse({
        rounds: 0,
        calculation: "static",
        power: 99999,
      });
      const tags =
        outcome === "surviving"
          ? [tag]
          : outcome === "damage first"
            ? [damage, tag]
            : [tag, damage];
      const action = makeCombatAction({ target, range: 3, effects: tags });
      const previous = maskBattle(structuredClone(battle), "caster");
      const recorder = createCombatPlaybackRecorder(battle);
      expect(
        insertAction({
          battle,
          grid: getBattleGrid(20, battle),
          action,
          actorId: "caster",
          longitude: target === "SELF" ? 0 : 2,
          latitude: 0,
        }),
      ).toBe(true);
      const { newBattle } = applyEffects(battle, "caster", action);
      recorder.record(newBattle, 2, "caster", []);
      newBattle.version = 2;
      const next = maskBattle(newBattle, "caster");
      next.playback = recorder.steps;
      expect(
        next.usersState.find(
          (user) => user.userId === (target === "SELF" ? "caster" : "victim"),
        )?.curHealth,
      ).toBe(outcome === "surviving" ? 1 : 0);
      expect(next.groundEffects).toHaveLength(1);
      expect(next.groundEffects[0]).toMatchObject({
        appearAnimation: tag.appearAnimation,
        appearSfx: tag.appearSfx,
        appearSfxPrimary: tag.appearSfxPrimary,
        projectileAnimation: tag.projectileAnimation,
        projectileScale: tag.projectileScale,
        animationScale: tag.animationScale,
        animationOffsetY: tag.animationOffsetY,
        longitude: target === "SELF" ? 0 : 2,
        latitude: 0,
      });
      expect(next.usersEffects).toHaveLength(1);
      expect(next.usersEffects[0]).toMatchObject({
        type: "visual",
        staticAnimation: tag.staticAnimation,
        disappearAnimation: tag.disappearAnimation,
        disappearSfx: tag.disappearSfx,
        appearAnimation: "",
        appearSfx: "",
        targetId: target === "SELF" ? "caster" : "victim",
      });
      expect(next.usersEffects[0]?.projectileAnimation).toBeUndefined();
      const frame = buildPlaybackFrames(previous, next)[0]!;
      if (target === "SELF") {
        expect(frame.travel).toBeUndefined();
      } else {
        expect(frame.travel?.groundEffects).toHaveLength(1);
        expect(frame.travel?.groundEffects[0]).toMatchObject({
          longitude: 2,
          latitude: 0,
          projectileOnly: true,
        });
        await scene.effects.sync({ ...scene.snapshot, battle: frame.travel! });
        scene.effects.animate(0, false, false, null);
        const sprites = scene.effects.container.children.flatMap(
          (root) => root.children,
        );
        expect(sprites).toHaveLength(1);
        expect(sprites[0]?.visible).toBe(true);
        expect(scene.play).not.toHaveBeenCalled();
      }
      await scene.effects.sync({ ...scene.snapshot, battle: frame.battle });
      scene.effects.animate(1000, false, false, null);
      const visibleSprites = () =>
        scene.effects.container.children
          .filter((root) => root.visible)
          .flatMap((root) => root.children)
          .filter((sprite) => sprite.visible);
      expect(visibleSprites()).toHaveLength(outcome === "surviving" ? 2 : 1);
      expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);
      scene.effects.animate(2000, false, false, null);
      expect(scene.effects.clipFrameRate() > 0).toBe(outcome === "surviving");
      expect(visibleSprites()).toHaveLength(outcome === "surviving" ? 1 : 0);
      expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);

      const hydrated = setup();
      await hydrated.effects.sync({ ...hydrated.snapshot, battle: next }, true);
      hydrated.effects.animate(0, false, false, null);
      expect(hydrated.play).not.toHaveBeenCalled();
      expect(hydrated.effects.clipFrameRate() > 0).toBe(outcome === "surviving");

      expireGroundEffects(newBattle, []);
      const settled = applyEffects(newBattle, "caster").newBattle;
      expect(settled.groundEffects).toHaveLength(0);
      await scene.effects.sync({
        ...scene.snapshot,
        battle: maskBattle(settled, "caster"),
      });
      scene.effects.animate(3000, false, false, null);
      expect(visibleSprites()).toHaveLength(outcome === "surviving" ? 1 : 0);
      expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);
    },
  );
  it("carries a projectile-only cast and its real creator through authoritative effect processing", () => {
    const battle = makeCompleteBattle({
      usersState: [
        makeBattleUser("attacker", { longitude: 2, latitude: 1 }),
        makeBattleUser("defender", { longitude: 4, latitude: 1 }),
      ],
      usersEffects: [
        makeDamageEffect({
          creatorId: "attacker",
          targetId: "defender",
          targetType: "user",
          rounds: 0,
          projectileAnimation: "bolt",
          projectileScale: 2,
          appearAnimation: "",
          appearSfx: "",
          power: 1,
          calculation: "static",
        }),
      ],
    });
    const { newBattle } = applyEffects(battle, "attacker");
    expect(newBattle.groundEffects).toContainEqual(
      expect.objectContaining({
        type: "visual",
        creatorId: "attacker",
        projectileAnimation: "bolt",
        projectileScale: 2,
        longitude: 4,
        latitude: 1,
      }),
    );
  });
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
            animationOffsetY: 0.5,
            projectileAnimation: "bolt",
            projectileScale: 2,
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
    expect(end.projectileAnimation).toBeUndefined();
    expect(end.projectileScale).toBeUndefined();
    expect(end.animationOffsetY).toBe(0.5);
    const tile = scene.grid.getHex({ col: end.longitude, row: end.latitude })!;
    const clip = scene.effects.container.children[0]!.children[0] as Sprite;
    expect(clip.width).toBeCloseTo(tile.height * 2.5);
    expect(clip.height).toBeCloseTo(tile.height * 2.5);
    expect(clip.y).toBeCloseTo(tile.height);
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

  it("finishes a departing SURFACE clip on the ground layer and hides its decal", async () => {
    const scene = setup();
    const tile = tiles.find((t) => vary(t).delayMs >= 200)!;
    const { delayMs } = vary(tile);
    scene.snapshot.assets.push({
      id: "floor",
      image: "https://example.com/floor.png",
      frames: 1,
      speed: 1,
    } as GameAsset);
    await show(scene, [
      groundEffect("surface", tile, {
        animationStagger: 600,
        staticAnimation: "",
        staticAssetPath: "floor",
        groundStyle: "SURFACE",
      }),
    ]);
    scene.effects.animate(0, false, false, null);
    const surface = scene.effects.ground.getChildByLabel("surface")!;
    const clip = surface.children.find((child) => child.zIndex === 1) as Sprite;
    const decal = surface.children.find((child) => child !== clip)!;
    expect(clip).toBeDefined();
    expect(decal).toBeDefined();
    expect(decal.visible).toBe(true);
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
    }) as unknown as ReturnedBattle;
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(delayMs, false, false, null);
    expect(surface.visible).toBe(true);
    expect(clip.visible).toBe(true);
    expect(decal.visible).toBe(false);
    expect(scene.effects.isPlaying()).toBe(true);
    scene.effects.animate(delayMs + 40, false, false, null);
    expect(surface.destroyed).toBe(true);
    expect(scene.effects.isPlaying()).toBe(false);
  });

  it("lands a cast with a projectile without stagger or ripple on its impact", async () => {
    const scene = setup();
    const tile = tiles.find((t) => vary(t).delayMs >= 200)!;
    await show(scene, [
      groundEffect("flown", tile, {
        animationStagger: 600,
        animationRipple: 300,
        castFrom: { longitude: 0, latitude: 0 },
        projectileAnimation: "animation",
        staticAnimation: "",
      }),
    ]);
    scene.effects.animate(0, false, false, null);
    expect(clipsOf(scene, "flown")[0]!.visible).toBe(true);
  });

  it("lands every effect of a cast with a projectile without stagger or ripple", async () => {
    const scene = setup();
    const tile = tiles.find((t) => vary(t).delayMs >= 200)!;
    const fields = { animationStagger: 600, staticAnimation: "" };
    await show(scene, [
      groundEffect("launch", plainTile, {
        projectileAnimation: "animation",
        staticAnimation: "",
      }),
      groundEffect("impact", tile, fields),
      groundEffect("later", tile, { ...fields, createdRound: 2 }),
    ]);
    scene.effects.animate(0, false, false, null);
    expect(clipsOf(scene, "impact")[0]!.visible).toBe(true);
    // Another cast keeps its own stagger.
    expect(clipsOf(scene, "later")[0]!.visible).toBe(false);
  });

  it("keeps the stagger of a disappear visual from a cast with a projectile", async () => {
    const scene = setup();
    const tile = tiles.find((t) => vary(t).delayMs >= 200)!;
    await show(scene, [
      groundEffect("lasting", plainTile, { projectileAnimation: "animation" }),
      groundEffect("ending", tile, {
        type: "visual",
        actionId: "visual",
        animationStagger: 600,
        staticAnimation: "",
        soundOrigin: { actionId: "jutsu", createdRound: 1, phase: "disappear" },
      }),
    ]);
    scene.effects.animate(0, false, false, null);
    expect(clipsOf(scene, "ending")[0]!.visible).toBe(false);
  });

  it("plays an announced arrival once when its fighter is downed and returns", async () => {
    const scene = setup();
    const target = { ...makeBattleUser("target", plainTile), curHealth: 0 };
    const debuff = makeEffect(
      "recoil",
      {
        appearAnimation: "animation",
        appearSfx: "appear",
        staticAnimation: "animation",
      },
      {
        id: "debuff",
        creatorId: "caster",
        targetId: target.userId,
        targetType: "user",
      },
    );
    const announcement = groundEffect("announcement", plainTile, {
      type: "visual",
      actionId: "visual",
      rounds: 0,
      appearSfx: "appear",
      staticAnimation: "",
      arrivalFor: "debuff",
    });
    await show(scene, [announcement], { usersState: [target], usersEffects: [debuff] });
    for (let frame = 0; frame <= 60; frame += 10)
      scene.effects.animate(frame, false, false, null);
    const battle = scene.snapshot.battle;
    battle.groundEffects = [];
    await scene.effects.sync(scene.snapshot);
    scene.effects.animate(70, false, false, null);
    battle.usersState[0]!.curHealth = 100;
    await scene.effects.sync(scene.snapshot);
    for (let frame = 80; frame <= 140; frame += 10)
      scene.effects.animate(frame, false, false, null);
    expect(clipsOf(scene, "debuff").filter((clip) => clip.zIndex === 1)).toHaveLength(
      0,
    );
    expect(scene.play.mock.calls).toEqual([["appear.wav", 0.4]]);
  });

  it("starts a replayed preview cycle without the earlier cycle's clip", async () => {
    const scene = setup();
    const visibleArrivals = () =>
      scene.effects.container.children
        .filter((root) => root.visible)
        .flatMap((root) => (root.children as Sprite[]).filter((clip) => clip.visible));
    await show(scene, [groundEffect("first", plainTile, { staticAnimation: "" })], {});
    await scene.effects.sync({ ...scene.snapshot, cycle: 1 });
    scene.effects.animate(0, false, false, null);
    scene.effects.animate(10, false, false, null);
    scene.snapshot.battle = makeCompleteBattle({
      ...board,
      groundEffects: [groundEffect("second", plainTile, { staticAnimation: "" })],
    }) as unknown as ReturnedBattle;
    await scene.effects.sync({ ...scene.snapshot, cycle: 2 });
    scene.effects.animate(20, false, false, null);
    expect(visibleArrivals()).toHaveLength(1);
    expect(scene.effects.container.getChildByLabel("first")).toBeNull();
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
