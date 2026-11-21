import { describe, expect, it } from "bun:test";
import { syncResourceSiloNotification } from "@/deltas/profile";
import {
  getNoJutsuEquippedNotifications,
  getResourceSiloNotifications,
  getUserFactionNotifications,
  NO_JUTSU_EQUIPPED_NOTIFICATION,
  RESOURCE_SILO_NOTIFICATION,
} from "@/libs/userNotifications";
import type { UserWithRelations } from "@/server/api/routers/profile";
import { getResourceSiloBoundaries } from "@/utils/time";

const notify = (overrides: Record<string, unknown>) =>
  getUserFactionNotifications({
    userId: "ninja",
    villageId: "home",
    isAi: false,
    village: { type: "VILLAGE", kageId: "kage" },
    shrineBattles: [],
    activeWars: [],
    activeRaids: [],
    ...overrides,
  } as unknown as UserWithRelations);

const names = (overrides: Record<string, unknown>) =>
  notify(overrides).map((entry) => entry.name);

const war = (overrides: Record<string, unknown>) => ({
  id: "war",
  type: "SECTOR_WAR",
  sector: 7,
  attackerVillageId: "foe",
  defenderVillageId: "home",
  attackerVillage: { name: "Foe" },
  defenderVillage: { name: "Home" },
  ...overrides,
});

describe("getUserFactionNotifications", () => {
  it("lists each shrine sector once, ignores sector 0 and pluralizes by sector count", () => {
    expect(
      notify({
        shrineBattles: [
          { sector: 4, defenderEntityId: "home", attackerEntityId: "foe" },
          { sector: 4, defenderEntityId: "home", attackerEntityId: "foe" },
          { sector: 0, defenderEntityId: "home", attackerEntityId: "foe" },
          { sector: 9, defenderEntityId: "foe", attackerEntityId: "home" },
          { sector: 8, defenderEntityId: "foe", attackerEntityId: "home" },
        ],
      }),
    ).toEqual([
      {
        href: "/travel",
        name: "Shrine under attack (Sector 4)",
        color: "red",
        alwaysShow: true,
      },
      {
        href: "/travel",
        name: "We are attacking Shrines (Sectors 9, 8)",
        color: "blue",
        alwaysShow: true,
      },
    ]);
    expect(
      names({
        shrineBattles: [
          { sector: 4, defenderEntityId: "home", attackerEntityId: "foe" },
          { sector: 5, defenderEntityId: "home", attackerEntityId: "foe" },
          { sector: 9, defenderEntityId: "foe", attackerEntityId: "home" },
        ],
      }),
    ).toEqual([
      "Shrines under attack (Sectors 4, 5)",
      "We are attacking Shrine (Sector 9)",
    ]);
  });

  it("groups war sectors by the side the village fights on, including allied support", () => {
    const allies = [{ villageId: "home", supportVillageId: "friend" }];
    expect(
      names({
        activeWars: [
          war({ sector: 7 }),
          war({ sector: 7 }),
          war({ sector: 0 }),
          war({
            sector: 3,
            attackerVillageId: "friend",
            defenderVillageId: "foe",
            warAllies: allies,
          }),
          war({
            sector: 2,
            attackerVillageId: "home",
            defenderVillageId: "foe",
          }),
        ],
      }),
    ).toEqual([
      "Sector under attack (Sector 7)",
      "We are attacking Sectors (Sectors 3, 2)",
    ]);
    expect(
      names({
        activeWars: [
          war({ sector: 7 }),
          war({ sector: 8 }),
          war({ sector: 2, attackerVillageId: "home", defenderVillageId: "foe" }),
        ],
      }),
    ).toEqual([
      "Sectors under attack (Sectors 7, 8)",
      "We are attacking Sector (Sector 2)",
    ]);
  });

  it("labels village wars and raids for direct parties and supporters alike", () => {
    const type = "VILLAGE_WAR";
    const allies = [{ villageId: "home", supportVillageId: "friend" }];
    expect(
      notify({
        activeWars: [
          war({ type, sector: 0, attackerVillageId: "home", defenderVillageId: "foe" }),
          war({ type: "WAR_RAID", sector: 0 }),
          war({
            type,
            sector: 0,
            attackerVillageId: "friend",
            defenderVillageId: "foe",
            attackerVillage: { name: "Friend" },
            defenderVillage: { name: "Foe" },
            warAllies: allies,
          }),
          war({
            type,
            sector: 0,
            attackerVillageId: "foe",
            defenderVillageId: "friend",
            attackerVillage: null,
            defenderVillage: { name: "Friend" },
            warAllies: allies,
          }),
          war({
            type,
            sector: 0,
            attackerVillageId: "other",
            defenderVillageId: "foe",
          }),
        ],
      }),
    ).toEqual(
      [
        "At war: attacking Home",
        "At war: defending vs Foe",
        "Supporting Friend attacking Foe",
        "Supporting Friend defending vs another village",
      ].map((name) => ({ href: "/townhall", name, color: "red", alwaysShow: true })),
    );
  });

  it("keeps raid sector 0, which faction raids use, and pluralizes each raid type", () => {
    expect(
      names({
        activeRaids: [
          { raidType: "open", sector: 0 },
          { raidType: "open", sector: 0 },
          { raidType: "exclusive", sector: 6 },
          { raidType: "exclusive", sector: 7 },
        ],
      }),
    ).toEqual(["Raid (Sector 0)", "Village Raids active (Sectors 6, 7)"]);
    expect(
      names({
        activeRaids: [
          { raidType: "open", sector: 1 },
          { raidType: "open", sector: 2 },
          { raidType: "exclusive", sector: 6 },
        ],
      }),
    ).toEqual(["Raids (Sectors 1, 2)", "Village Raid active (Sector 6)"]);
  });

  it("marks raids as informational opportunities rather than critical threats", () => {
    expect(
      notify({
        activeRaids: [
          { raidType: "open", sector: 1 },
          { raidType: "exclusive", sector: 6 },
        ],
      }).map((entry) => entry.color),
    ).toEqual(["blue", "blue"]);
  });

  it("orders shrine, war, village war and raid notices", () => {
    expect(
      names({
        shrineBattles: [
          { sector: 4, defenderEntityId: "home", attackerEntityId: "foe" },
        ],
        activeWars: [war({ sector: 7 }), war({ type: "VILLAGE_WAR", sector: 0 })],
        activeRaids: [{ raidType: "open", sector: 1 }],
      }),
    ).toEqual([
      "Shrine under attack (Sector 4)",
      "Sector under attack (Sector 7)",
      "At war: defending vs Foe",
      "Raid (Sector 1)",
    ]);
  });

  it("returns nothing for a missing user", () => {
    expect(getUserFactionNotifications(undefined)).toEqual([]);
  });
});

describe("getNoJutsuEquippedNotifications", () => {
  const player = {
    isAi: false,
    tutorialOn: false,
    tutorialStep: 0,
    loadout: { jutsuIds: [] as string[] },
  };

  it("warns a player whose active loadout is empty", () => {
    expect(getNoJutsuEquippedNotifications(player)).toEqual([
      NO_JUTSU_EQUIPPED_NOTIFICATION,
    ]);
    expect(NO_JUTSU_EQUIPPED_NOTIFICATION).toMatchObject({
      href: "/jutsus",
      color: "red",
    });
  });

  it("stays quiet with jutsu equipped, for AI, without a loadout, or during the tutorial", () => {
    expect(
      getNoJutsuEquippedNotifications({ ...player, loadout: { jutsuIds: ["j1"] } }),
    ).toEqual([]);
    expect(getNoJutsuEquippedNotifications({ ...player, isAi: true })).toEqual([]);
    expect(getNoJutsuEquippedNotifications({ ...player, loadout: null })).toEqual([]);
    expect(getNoJutsuEquippedNotifications({ ...player, tutorialOn: true })).toEqual(
      [],
    );
    expect(getNoJutsuEquippedNotifications(undefined)).toEqual([]);
  });
});

describe("getResourceSiloNotifications", () => {
  // Friday 2026-11-13: windows open 12:00-13:00 and 15:00-16:00 UTC.
  const open = new Date("2026-11-13T12:30:00Z");
  const player = { isAi: false, tutorialOn: false, resourceSiloProgress: null };

  it("shows the notice only while a window is open", () => {
    expect(getResourceSiloNotifications(player, true, open)).toEqual([
      RESOURCE_SILO_NOTIFICATION,
    ]);
    expect(RESOURCE_SILO_NOTIFICATION.name).toBe("Resource Silo open (Sector 335)");
    for (const closed of ["2026-11-13T13:00:00Z", "2026-11-11T12:30:00Z"])
      expect(getResourceSiloNotifications(player, true, new Date(closed))).toEqual([]);
  });

  it("hides the notice once this window is claimed, but not for an earlier claim", () => {
    const progress = (windowId: string) => ({ windowId, points: 60, claimed: true });
    expect(
      getResourceSiloNotifications(
        { ...player, resourceSiloProgress: progress("2026-11-13T12:00:00.000Z") },
        true,
        open,
      ),
    ).toEqual([]);
    expect(
      getResourceSiloNotifications(
        { ...player, resourceSiloProgress: progress("2026-11-13T09:00:00.000Z") },
        true,
        open,
      ),
    ).toEqual([RESOURCE_SILO_NOTIFICATION]);
  });

  it("stays hidden while no silo reward is set up to claim", () => {
    expect(getResourceSiloNotifications(player, false, open)).toEqual([]);
    expect(syncResourceSiloNotification([], player, false, open)).toBeUndefined();
  });

  it("skips AI, tutorial players and missing users", () => {
    expect(getResourceSiloNotifications({ ...player, isAi: true }, true, open)).toEqual(
      [],
    );
    expect(
      getResourceSiloNotifications({ ...player, tutorialOn: true }, true, open),
    ).toEqual([]);
    expect(getResourceSiloNotifications(undefined, true, open)).toEqual([]);
  });

  it("lists every opening and closing through the following week", () => {
    const boundaries = getResourceSiloBoundaries(new Date("2026-11-11T12:00:00Z"));
    // Friday to Sunday UTC: 3 days of 8 windows, each with an opening and a closing.
    expect(boundaries).toHaveLength(48);
    expect(boundaries[0]?.toISOString()).toBe("2026-11-13T00:00:00.000Z");
    expect(boundaries[1]?.toISOString()).toBe("2026-11-13T01:00:00.000Z");
    expect(boundaries.at(-1)?.toISOString()).toBe("2026-11-15T22:00:00.000Z");
  });

  it("toggles only the silo notice at a window edge", () => {
    const other = { href: "/news", name: "2 news", color: "hidden" as const };
    const added = syncResourceSiloNotification([other], player, true, open);
    expect(added).toEqual([other, RESOURCE_SILO_NOTIFICATION]);
    expect(syncResourceSiloNotification(added, player, true, open)).toBeUndefined();
    expect(
      syncResourceSiloNotification(
        added,
        player,
        true,
        new Date("2026-11-13T13:00:00Z"),
      ),
    ).toEqual([other]);
    expect(syncResourceSiloNotification(undefined, player, true, open)).toBeUndefined();
  });
});
