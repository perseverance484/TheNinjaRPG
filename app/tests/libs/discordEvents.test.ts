import { describe, expect, it } from "bun:test";
import {
  MAP_WAR_TORN_BATTLEGROUND_SECTOR,
  TERRITORY_WAR_INTERVAL_HOURS,
} from "@/drizzle/constants";
import { buildDiscordEvents, discordEventKey } from "@/libs/discordEvents";
import { getResourceSiloWindow } from "@/utils/time";

const now = new Date("2026-10-29T12:00:00Z");
const earlier = new Date(now.getTime() - 60_000);
const input = () => ({
  raids: [],
  wars: [],
  territories: [],
  silo: null,
  enabledAt: { raids: earlier, wars: earlier, territory: earlier, silos: earlier },
  observed: new Set<string>(),
  now,
});
const raid = () => ({
  id: "raid",
  name: "Boss",
  createdAt: now,
  raidStartedAt: null,
  startsAt: null,
  endsAt: null,
  hidden: false,
  raidBossCurrentHealth: 100,
  raidEndsAt: new Date(now.getTime() + 60_000),
  isExclusive: 0,
});
const war = () => ({
  id: "war",
  startedAt: earlier,
  endedAt: null as Date | null,
  type: "VILLAGE_WAR" as const,
  status: "ACTIVE" as const,
  sector: 42,
  combatStartedAt: null,
  attackerVillage: { name: "Akikaze" },
  defenderVillage: { name: "Hyorin" },
});
const territory = () => ({
  id: "territory",
  predecessorId: "previous",
  sector: 42,
  guardianId: "guardian",
  startsAt: earlier,
  endsAt: new Date(now.getTime() + 60_000),
  resolvedAt: null as Date | null,
  version: 0,
  winners: [] as string[],
});

describe("Discord event messages", () => {
  it("reports raid start, boss defeat and timeout", () => {
    expect(buildDiscordEvents({ ...input(), raids: [raid()] })).toHaveLength(1);
    expect(
      buildDiscordEvents({
        ...input(),
        raids: [{ ...raid(), raidBossCurrentHealth: 0 }],
      })[1]?.message,
    ).toContain("boss was defeated");
    expect(
      buildDiscordEvents({ ...input(), raids: [{ ...raid(), raidEndsAt: earlier }] })[1]
        ?.message,
    ).toContain("Time expired");
  });
  it("omits hidden, unconfigured and dormant exclusive raids", () => {
    const raids = [
      { ...raid(), hidden: true },
      { ...raid(), raidBossCurrentHealth: null },
      { ...raid(), isExclusive: 1, raidEndsAt: null },
    ];
    expect(buildDiscordEvents({ ...input(), raids })).toEqual([]);
  });
  it("uses raid-specific lifecycle even if generic quest dates are stale", () => {
    const raids = [{ ...raid(), startsAt: "2026-10-30", endsAt: "2026-10-01" }];
    expect(buildDiscordEvents({ ...input(), raids })).toHaveLength(1);
  });
  it("gives reused raid activations distinct bounded receipt keys", () => {
    const first = buildDiscordEvents({ ...input(), raids: [raid()] })[0]!;
    const second = buildDiscordEvents({
      ...input(),
      raids: [{ ...raid(), raidEndsAt: new Date(now.getTime() + 86_400_000) }],
    })[0]!;
    expect(first.id).not.toBe(second.id);
    expect(discordEventKey("raids", "x".repeat(1000)).length).toBeLessThan(150);
  });
  it("does not replay old completed raids but completes an observed activation", () => {
    const old = { ...raid(), createdAt: new Date(0), raidBossCurrentHealth: 0 };
    expect(buildDiscordEvents({ ...input(), raids: [old] })).toEqual([]);
    const id = buildDiscordEvents({
      ...input(),
      raids: [{ ...old, raidBossCurrentHealth: 100 }],
    })[0]!.id;
    expect(
      buildDiscordEvents({ ...input(), raids: [old], observed: new Set([id]) }),
    ).toHaveLength(2);
  });
  it.each(["VILLAGE_WAR", "SECTOR_WAR", "WAR_RAID"] as const)(
    "names participants and winners for %s",
    (type) => {
      const result = buildDiscordEvents({
        ...input(),
        wars: [{ ...war(), type, endedAt: now, status: "DEFENDER_VICTORY" }],
      });
      expect(result[0]?.message).toContain("Akikaze");
      expect(result[0]?.message).toContain("Hyorin");
      expect(result[1]?.message).toContain("Winner: **Hyorin**");
      expect(result[0]?.message).toContain(
        "https://www.theninja-rpg.com/townhall#Wars",
      );
      expect(result[1]?.message).toContain(
        "https://www.theninja-rpg.com/townhall#Wars",
      );
    },
  );
  it("reports draws and objective-war combat opening times", () => {
    const result = buildDiscordEvents({
      ...input(),
      wars: [
        {
          ...war(),
          combatStartedAt: new Date(now.getTime() + 3_600_000),
          endedAt: now,
          status: "DRAW",
        },
      ],
    });
    expect(result[0]?.message).toContain("Combat opens <t:");
    expect(result[1]?.message).toContain("draw");
  });
  it("includes tied territory winners or an empty-result explanation", () => {
    for (const winners of [[], ["Akikaze", "Faction"]]) {
      const result = buildDiscordEvents({
        ...input(),
        territories: [{ ...territory(), resolvedAt: now, winners }],
      });
      expect(result[1]?.message).toContain(
        winners.length ? "Winners: **Akikaze, Faction**" : "No winner",
      );
    }
  });
  it("warns only inside the upcoming territory window, using actual resolution", () => {
    const nextIn = (minutes: number) =>
      new Date(
        now.getTime() - TERRITORY_WAR_INTERVAL_HOURS * 3_600_000 + minutes * 60_000,
      );
    for (const [minutes, expected] of [
      [31, false],
      [30, true],
      [1, true],
      [0, false],
      [-1, false],
    ] as const) {
      const result = buildDiscordEvents({
        ...input(),
        territories: [
          { ...territory(), startsAt: new Date(0), resolvedAt: nextIn(minutes) },
        ],
      });
      expect(result.some((event) => event.id.endsWith(":warning"))).toBe(expected);
    }
  });
  it("announces each open silo window once, with its sector and close time", () => {
    // Friday 2026-10-30 12:30 UTC falls in the 12:00-13:00 window.
    const window = getResourceSiloWindow(new Date("2026-10-30T12:30:00Z"));
    const result = buildDiscordEvents({ ...input(), silo: window });
    expect(result).toHaveLength(1);
    expect(result[0]?.category).toBe("silos");
    expect(result[0]?.id).toBe(`${discordEventKey("silos", window.id)}:open`);
    expect(result[0]?.message).toContain(`sector ${MAP_WAR_TORN_BATTLEGROUND_SECTOR}`);
    expect(result[0]?.message).toContain(
      `<t:${Math.floor(window.end.getTime() / 1000)}:R>`,
    );
    const later = getResourceSiloWindow(new Date("2026-10-30T15:30:00Z"));
    expect(buildDiscordEvents({ ...input(), silo: later })[0]?.id).not.toBe(
      result[0]?.id,
    );
  });
  it("stays quiet while the silo is closed, unconfigured or its alerts are off", () => {
    // Friday 13:30 UTC is between windows; Wednesday 12:30 UTC is a weekday.
    for (const time of ["2026-10-30T13:30:00Z", "2026-10-28T12:30:00Z"]) {
      const silo = getResourceSiloWindow(new Date(time));
      expect(silo.active).toBe(false);
      expect(buildDiscordEvents({ ...input(), silo })).toEqual([]);
    }
    const open = getResourceSiloWindow(new Date("2026-10-30T12:30:00Z"));
    expect(buildDiscordEvents({ ...input(), silo: null })).toEqual([]);
    expect(
      buildDiscordEvents({ ...input(), silo: open, enabledAt: { raids: earlier } }),
    ).toEqual([]);
  });
  it("neutralizes name formatting and suppresses disabled categories", () => {
    const result = buildDiscordEvents({
      ...input(),
      raids: [{ ...raid(), name: "@everyone <@&123> **Boss**\nhello" }],
    });
    expect(result[0]?.message).not.toContain("@everyone");
    expect(result[0]?.message).not.toContain("<@&");
    expect(buildDiscordEvents({ ...input(), raids: [raid()], enabledAt: {} })).toEqual(
      [],
    );
  });
});
