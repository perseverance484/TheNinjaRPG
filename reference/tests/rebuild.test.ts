import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { frames, CHECKPOINTS } from "../scripts/load";
import { parseLine } from "../src/parse";
import { entries } from "../scripts/load";

const golden = JSON.parse(readFileSync(new URL("../golden/states.json", import.meta.url), "utf8"));

describe("rebuildReplay on battle cYlLV24zfgzJ2mqCxlKn7", () => {
  const F = frames();
  it("has 59 actions plus the start frame", () => expect(F.length).toBe(60));
  for (const [k, [a, d]] of Object.entries(CHECKPOINTS))
    it(`matches hand-checked HP after action ${k}`, () => expect(F[+k].fighters.map((f) => Math.round(f.hp))).toEqual([a, d]));
  it("matches the golden state for every frame", () => expect(JSON.parse(JSON.stringify(F))).toEqual(golden.frames));
  it("understands every effect line in the log", () => {
    const unknown = entries.flatMap((e) => e.appliedEffects.map((x) => x.txt)).filter((t) => parseLine(t).k === "none" && !/0\.00 (CP|SP)|heals 0 (SP|CP)/.test(t));
    expect(unknown).toEqual([]);
  });
  it("shows Cleanse removing dauntless's debuffs at action 18", () => {
    const rows = F[18].modifiers[F[18].fighters[1].userId].rows;
    expect(rows.filter((r) => r.state === "removed").map((r) => r.tag)).toEqual(["Decrease Damage Given", "Recoil", "Drain", "Wound", "Afterburn", "Stun"]);
  });
  it("counts both Chakra Overflow lines (+70%)", () => {
    const rows = F[37].modifiers[F[37].fighters[1].userId].rows;
    expect(rows.find((r) => r.tag === "Increase Damage Given" && r.state === "queued")?.value).toBe(70);
  });
});
