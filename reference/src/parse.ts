import type { ModifierTag } from "./types";

export type Parsed =
  | { k: "eff"; who: string; tag: ModifierTag; val: number | null; unit: "%" | " / rd" | " AP" | ""; el: string; rounds: number; startsNow: boolean; openEnded: boolean }
  | { k: "ground"; who: string; kind: string; rounds: number }
  | { k: "hp"; who: string; d: number; t: "damage" | "recoil" | "reflect" | "afterburn" | "wound" | "drain" | "lifesteal" | "absorb" | "heal" }
  | { k: "shield"; who: string; op: "add" | "set" | "zero"; v: number; soak: number }
  | { k: "barrier"; d: number; left: number }
  | { k: "remove"; who: string; by: "Clear" | "Cleanse" }
  | { k: "none" };

const N = "(.+?)";
const eff = (who: string, tag: ModifierTag, rounds: number, val: number | null = null, unit: "%" | " / rd" | " AP" | "" = "", el = "", startsNow = false, openEnded = false): Parsed =>
  ({ k: "eff", who, tag, val, unit, el, rounds, startsNow, openEnded });

/** Turns one applied-effect line into a state change. `who` is the display name used in the log. */
export function parseLine(raw: string): Parsed {
  const s = raw.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(new RegExp(`^${N} damage (given|taken) \\[(.+?)\\] is (increased|decreased) by up to ([\\d.]+)% for the next (\\d+) rounds$`)))) {
    const tag = `${m[4] === "increased" ? "Increase" : "Decrease"} Damage ${m[2] === "given" ? "Given" : "Taken"}` as ModifierTag;
    return eff(m[1], tag, +m[6], +m[5], "%", m[3] === "all damage" ? "" : m[3].replace(/ damage$/, ""));
  }
  if ((m = s.match(new RegExp(`^${N} will absorb up to ([\\d.]+)% damage and convert it to Health for the next (\\d+) rounds$`)))) return eff(m[1], "Absorb", +m[3], +m[2], "%");
  if ((m = s.match(new RegExp(`^${N} will steal ([\\d.]+)% damage as health for the next (\\d+) rounds$`)))) return eff(m[1], "Lifesteal", +m[3], +m[2], "%");
  if ((m = s.match(new RegExp(`^${N} will (recoil|reflect) ([\\d.]+)% damage for (?:the next )?(\\d+) rounds(, starting this round)?$`)))) return eff(m[1], m[2] === "recoil" ? "Recoil" : "Reflect", +m[4], +m[3], "%", "", !!m[5]);
  if ((m = s.match(new RegExp(`^${N} will take ([\\d.]+)% of damage received as afterburn for the next (\\d+) rounds$`)))) return eff(m[1], "Afterburn", +m[3], +m[2], "%");
  if ((m = s.match(new RegExp(`^${N} will be drained ([\\d.]+) of (.+?) for \\d+ rounds for the next (\\d+) rounds$`)))) return eff(m[1], "Drain", +m[4], +m[2], " / rd");
  if ((m = s.match(new RegExp(`^${N} will take ([\\d.]+) wound damage for the next (\\d+) rounds$`)))) return eff(m[1], "Wound", +m[3], +m[2], " / rd");
  if ((m = s.match(new RegExp(`^${N} is stunned \\[(-?\\d+) AP\\] for the next (\\d+) rounds$`)))) return eff(m[1], "Stun", +m[3], Math.abs(+m[2]), " AP");
  if ((m = s.match(new RegExp(`^${N} cannot be (buffed|debuffed|cleared) for the next (\\d+) rounds$`)))) return eff(m[1], ({ buffed: "Buff Prevent", debuffed: "Debuff Prevent", cleared: "Clear Prevent" } as const)[m[2] as "buffed"], +m[3]);
  // The log gives no duration for this one. Treated as 2 rounds and shown without a counter.
  if ((m = s.match(new RegExp(`^${N} cannot be moved any further$`)))) return eff(m[1], "Move Prevent", 2, null, "", "", false, true);
  if ((m = s.match(new RegExp(`^${N} gains temporary access to additional actions for the next (\\d+) rounds$`)))) return eff(m[1], "Inject Jutsus", +m[2]);
  if ((m = s.match(new RegExp(`^${N} will siphon ([\\d.]+)% of damage taken into shields for the next (\\d+) rounds$`)))) return eff(m[1], "Siphon", +m[3], +m[2], "%");
  if ((m = s.match(new RegExp(`^${N} has immunity to (.+?) for the next (\\d+) rounds$`)))) return eff(m[1], "Immunity", +m[3]);
  if ((m = s.match(new RegExp(`^${N} marked the ground with (\\w+) for the next (\\d+) rounds$`)))) return { k: "ground", who: m[1], kind: m[2], rounds: +m[3] };
  if ((m = s.match(new RegExp(`^${N} takes ([\\d.]+) damage$`)))) return { k: "hp", who: m[1], d: -m[2], t: "damage" };
  if ((m = s.match(new RegExp(`^${N} takes ([\\d.]+) (recoil|reflect|afterburn|wound) damage$`)))) return { k: "hp", who: m[1], d: -m[2], t: m[3] as "recoil" };
  if ((m = s.match(new RegExp(`^${N} loses ([\\d.]+) HP to drain$`)))) return { k: "hp", who: m[1], d: -m[2], t: "drain" };
  if ((m = s.match(new RegExp(`^${N} steals ([\\d.]+) damage as health$`)))) return { k: "hp", who: m[1], d: +m[2], t: "lifesteal" };
  if ((m = s.match(new RegExp(`^${N} absorbs ([\\d.]+) damage and converts it to health$`)))) return { k: "hp", who: m[1], d: +m[2], t: "absorb" };
  if ((m = s.match(new RegExp(`^${N} heals ([\\d.]+) HP$`)))) return { k: "hp", who: m[1], d: +m[2], t: "heal" };
  if ((m = s.match(new RegExp(`^${N} siphons ([\\d.]+) damage as a shield for (\\d+) rounds$`)))) return { k: "shield", who: m[1], op: "add", v: +m[2], soak: 0 };
  if ((m = s.match(new RegExp(`^${N}'s shield absorbs ([\\d.]+) damage\\. ([\\d.]+) remaining\\.$`)))) return { k: "shield", who: m[1], op: "set", v: +m[3], soak: +m[2] };
  if ((m = s.match(new RegExp(`^${N}'s shield absorbs ([\\d.]+) damage and is destroyed$`)))) return { k: "shield", who: m[1], op: "zero", v: 0, soak: +m[2] };
  if ((m = s.match(new RegExp(`^${N}'s shield was destroyed$`)))) return { k: "shield", who: m[1], op: "zero", v: 0, soak: 0 };
  if ((m = s.match(/^Barrier takes ([\d.]+) damage and has ([\d.]+) health left\.$/))) return { k: "barrier", d: +m[1], left: +m[2] };
  if ((m = s.match(new RegExp(`^${N} was cleared of all (positive|negative) status effects\\.$`)))) return { k: "remove", who: m[1], by: m[2] === "positive" ? "Clear" : "Cleanse" };
  return { k: "none" };
}
