import { describe, expect, it } from "bun:test";
import { ID_ANIMATION_SMOKE } from "@/drizzle/constants";
import {
  applyEffects,
  applySingleEffect,
  expireGroundEffects,
} from "@/libs/combat/process";
import type { GroundEffect, UserEffect } from "@/libs/combat/types";
import {
  makeBattleUser,
  makeCombatAction,
  makeCompleteBattle,
  makeDamageEffect,
  makeEffect,
} from "../../setup/combat";

describe("applySingleEffect lifecycle visuals", () => {
  it.each([
    [0, 0],
    [0, 2],
    [2, 0],
  ])(
    "plays the disappear animation for an expired effect at [%i, %i]",
    (longitude, latitude) => {
      const caster = makeBattleUser("caster", { longitude, latitude });
      const battle = makeCompleteBattle({ usersState: [caster], round: 3 });
      const effect = makeEffect(
        "increasestat",
        {
          rounds: 0,
          generalTypes: ["Strength"],
          power: 10,
          animationScale: 2.5,
          disappearAnimation: "smoke",
        },
        {
          creatorId: "caster",
          targetId: "caster",
          isNew: false,
          castThisRound: false,
          createdRound: 1,
          targetType: "user",
        },
      );
      const newGroundEffects: GroundEffect[] = [];
      applySingleEffect(
        {
          consequences: new Map(),
          newUsersState: structuredClone(battle.usersState),
          newUsersEffects: [],
          newGroundEffects,
          actionEffects: [],
          appliedEffects: new Set(),
          battle,
          actorId: "caster",
        },
        effect,
      );
      expect(newGroundEffects).toHaveLength(1);
      expect(newGroundEffects[0]).toMatchObject({
        type: "visual",
        appearAnimation: "smoke",
        animationScale: 2.5,
        longitude,
        latitude,
      });
    },
  );
});

describe("lifecycle visuals and area variation", () => {
  const variation = {
    animationScale: 2,
    animationMirror: true,
    animationStagger: 400,
    animationRipple: 80,
    animationAlternate: "alternate",
  };
  const castFrom = { longitude: 0, latitude: 0 };
  const resolveOnCharacter = (isNew: boolean, rounds: number) => {
    const caster = makeBattleUser("caster", { longitude: 2, latitude: 1 });
    const battle = makeCompleteBattle({ usersState: [caster], round: 3 });
    const effect = makeEffect(
      "increasestat",
      {
        rounds,
        generalTypes: ["Strength"],
        power: 10,
        appearAnimation: "appear",
        disappearAnimation: "disappear",
        ...variation,
      },
      {
        creatorId: "caster",
        targetId: "caster",
        castFrom,
        isNew,
        castThisRound: isNew,
        createdRound: isNew ? 3 : 1,
        targetType: "user",
      },
    );
    const newGroundEffects: GroundEffect[] = [];
    applySingleEffect(
      {
        consequences: new Map(),
        newUsersState: structuredClone(battle.usersState),
        newUsersEffects: [],
        newGroundEffects,
        actionEffects: [],
        appliedEffects: new Set(),
        battle,
        actorId: "caster",
      },
      effect,
    );
    return newGroundEffects;
  };
  const unvaried = {
    animationScale: 2,
    animationMirror: false,
    animationStagger: 0,
    animationRipple: 0,
    animationAlternate: "",
  };
  it("keeps a character effect's appear and disappear visuals unvaried, sized like the effect", () => {
    for (const [visual, animation] of [
      [resolveOnCharacter(true, 0)[0], "appear"],
      [resolveOnCharacter(false, 0)[0], "disappear"],
    ] as const) {
      expect(visual).toMatchObject({
        type: "visual",
        appearAnimation: animation,
        ...unvaried,
      });
      expect(visual).not.toHaveProperty("castFrom");
    }
  });
  it.each([
    ["survives", 100_000, true],
    ["falls to the same action", 1, false],
  ])(
    "announces a lasting debuff's arrival with a visual linked to it when its target %s",
    (_, curHealth, survives) => {
      const defender = makeBattleUser("defender", { longitude: 3, latitude: 1 });
      defender.curHealth = curHealth;
      const battle = makeCompleteBattle({
        round: 2,
        usersState: [makeBattleUser("caster", { longitude: 2, latitude: 1 }), defender],
        usersEffects: [
          makeEffect(
            "damage",
            { power: 100, calculation: "static", rounds: 0 },
            {
              id: "hit",
              creatorId: "caster",
              targetId: "defender",
              targetType: "user",
              isNew: true,
              createdRound: 2,
              timeTracker: {},
              fromType: "jutsu",
            },
          ),
          makeEffect(
            "decreasestat",
            {
              power: 10,
              rounds: 2,
              generalTypes: ["Strength"],
              appearAnimation: "appear",
              appearSfx: "hit",
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
      const { newBattle } = applyEffects(battle, "caster");
      expect(
        newBattle.usersState.find((u) => u.userId === "defender")!.curHealth > 0,
      ).toBe(survives);
      const arrivals = newBattle.groundEffects.filter(
        (e) => e.type === "visual" && e.appearAnimation === "appear",
      );
      expect(arrivals).toHaveLength(1);
      expect(arrivals[0]).toMatchObject({
        appearSfx: "hit",
        longitude: 3,
        latitude: 1,
        arrivalFor: "debuff",
      });
    },
  );
  it("links a lasting character effect's appear visual to the effect", () => {
    const visuals = resolveOnCharacter(true, 2);
    expect(visuals).toHaveLength(1);
    expect(visuals[0]?.arrivalFor).toEqual(expect.any(String));
  });
  it("links a lasting ground effect's appear visual to the effect, which keeps its variation", () => {
    const battle = makeCompleteBattle({
      round: 2,
      usersState: [makeBattleUser("caster", { longitude: 0, latitude: 0 })],
      groundEffects: [
        makeEffect(
          "shield",
          { power: 1, health: 1, rounds: 2, appearAnimation: "appear", ...variation },
          { longitude: 3, latitude: 1, targetType: "barrier", isNew: true, castFrom },
        ),
      ],
    });
    const shield = battle.groundEffects[0]!;
    const { newBattle } = applyEffects(battle, "caster");
    expect(newBattle.groundEffects).toHaveLength(2);
    expect(newBattle.groundEffects.find((e) => e.type === "visual")).toMatchObject({
      appearAnimation: "appear",
      ...variation,
      castFrom,
      arrivalFor: shield.id,
    });
    expect(newBattle.groundEffects.find((e) => e.type === "shield")).toMatchObject({
      appearAnimation: "appear",
      ...variation,
      castFrom,
    });
  });
  it("gives an instant ground effect's appear visual its variation, alternate clip and caster tile", () => {
    const battle = makeCompleteBattle({
      round: 2,
      usersState: [makeBattleUser("caster", { longitude: 0, latitude: 0 })],
      groundEffects: [
        makeEffect(
          "damage",
          { power: 1, rounds: 0, appearAnimation: "appear", ...variation },
          { longitude: 3, latitude: 1, targetType: "barrier", isNew: true, castFrom },
        ),
      ],
    });
    const { newBattle } = applyEffects(battle, "caster");
    expect(newBattle.groundEffects.find((e) => e.type === "visual")).toMatchObject({
      appearAnimation: "appear",
      ...variation,
      castFrom,
    });
  });
  it("shows a ground hit on an occupied tile once, through the ground's varied visual", () => {
    const defender = makeBattleUser("defender", { longitude: 3, latitude: 1 });
    const battle = makeCompleteBattle({
      round: 2,
      usersState: [makeBattleUser("caster", { longitude: 0, latitude: 0 }), defender],
      groundEffects: [
        makeEffect(
          "damage",
          {
            power: 10,
            rounds: 0,
            appearAnimation: "appear",
            appearSfx: "hit",
            ...variation,
          },
          {
            creatorId: "caster",
            targetType: "user",
            longitude: 3,
            latitude: 1,
            isNew: true,
            castThisRound: true,
            castFrom,
          },
        ),
      ],
    });
    const { newBattle } = applyEffects(battle, "caster");
    const visuals = newBattle.groundEffects.filter((e) => e.type === "visual");
    expect(visuals).toHaveLength(1);
    expect(visuals[0]).toMatchObject({
      appearAnimation: "appear",
      appearSfx: "hit",
      ...variation,
    });
  });
  it("leaves a lasting ground effect's disappear clip to its tile, not to each fighter it touches", () => {
    let battle = makeCompleteBattle({
      round: 2,
      usersState: [
        makeBattleUser("caster", { longitude: 0, latitude: 0 }),
        makeBattleUser("defender", { longitude: 3, latitude: 1 }),
      ],
      groundEffects: [
        makeEffect(
          "increasestat",
          {
            power: 10,
            rounds: 3,
            generalTypes: ["Strength"],
            disappearAnimation: "disappear",
            ...variation,
          },
          {
            creatorId: "caster",
            targetType: "user",
            longitude: 3,
            latitude: 1,
            isNew: true,
            castThisRound: true,
            castFrom,
          },
        ),
      ],
    });
    for (let pass = 0; pass < 2; pass++) {
      battle = applyEffects(battle, "caster").newBattle;
      expect(
        battle.groundEffects.filter((e) => e.appearAnimation === "disappear"),
      ).toHaveLength(0);
    }
  });
  it("gives an expiring ground effect's disappear visual its variation, never the appear alternate", () => {
    const battle = makeCompleteBattle({
      round: 2,
      groundEffects: [
        makeEffect(
          "shield",
          {
            power: 1,
            health: 1,
            rounds: 1,
            disappearAnimation: "disappear",
            ...variation,
          },
          { longitude: 3, latitude: 1, targetType: "barrier", isNew: false, castFrom },
        ),
      ],
    });
    battle.groundEffects[0]!.rounds = 0;
    expireGroundEffects(battle, []);
    expect(battle.groundEffects).toHaveLength(1);
    expect(battle.groundEffects[0]).toMatchObject({
      type: "visual",
      appearAnimation: "disappear",
      ...variation,
      animationAlternate: "",
      castFrom,
    });
  });
});

describe("defeated stand-in smoke", () => {
  const ROUND = 3;
  const fight = (
    attacker: Record<string, unknown>,
    defender: Record<string, unknown>,
  ) => {
    const hit = makeDamageEffect({
      creatorId: "attacker",
      targetId: "defender",
      isNew: true,
      castThisRound: true,
      createdRound: ROUND,
      rounds: 0,
      targetType: "user",
    } as Partial<UserEffect>);
    const reflect = makeEffect(
      "reflect",
      { power: 50, calculation: "percentage", rounds: 3 },
      {
        creatorId: "defender",
        targetId: "defender",
        targetType: "user",
        createdRound: ROUND - 1,
        isNew: false,
      },
    );
    const battle = makeCompleteBattle({
      round: ROUND,
      usersState: [
        makeBattleUser("attacker", { longitude: 1, latitude: 1, ...attacker }),
        makeBattleUser("defender", { longitude: 3, latitude: 2, ...defender }),
      ],
      usersEffects: [hit, reflect],
    });
    return applyEffects(battle, "attacker", makeCombatAction())
      .newBattle.groundEffects.filter(
        (effect) => effect.appearAnimation === ID_ANIMATION_SMOKE,
      )
      .map((effect) => [effect.longitude, effect.latitude]);
  };

  it("marks a defeated target stand-in", () => {
    expect(fight({}, { isOriginal: false, curHealth: 1 })).toEqual([[3, 2]]);
  });

  it("marks an attacking stand-in defeated by returned damage", () => {
    expect(fight({ isOriginal: false, curHealth: 1 }, {})).toEqual([[1, 1]]);
  });

  it("marks both stand-ins when they fall together", () => {
    expect(
      fight({ isOriginal: false, curHealth: 1 }, { isOriginal: false, curHealth: 1 }),
    ).toEqual([
      [3, 2],
      [1, 1],
    ]);
  });

  it("leaves no smoke for originals", () => {
    expect(
      fight({ isOriginal: true, curHealth: 1 }, { isOriginal: true, curHealth: 1 }),
    ).toEqual([]);
  });
});
