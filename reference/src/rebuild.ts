import { parseLine } from "./parse";
import type { BattleEntry, FighterStart, ModifierRow, ModifierTag, Polarity, ReplayFrame, RebuildOptions, FighterFrame, Popup } from "./types";

/** Tags that help their holder. Everything else is a debuff, whoever cast it. */
export const BUFF_TAGS = new Set<ModifierTag>(["Increase Damage Given", "Decrease Damage Taken", "Shield", "Absorb", "Lifesteal", "Reflect", "Inject Jutsus", "Siphon", "Debuff Prevent", "Clear Prevent", "Immunity"]);
/** What Clear removes (engine clear tag's removal list, limited to tags that appear in the log). */
export const CLEAR_REMOVES = new Set<ModifierTag>(["Increase Damage Given", "Decrease Damage Taken", "Absorb", "Lifesteal", "Reflect", "Siphon", "Debuff Prevent", "Immunity"]);
/** What Cleanse removes (engine cleanse tag's removal list, limited the same way). */
export const CLEANSE_REMOVES = new Set<ModifierTag>(["Decrease Damage Given", "Increase Damage Taken", "Recoil", "Afterburn", "Drain", "Wound", "Stun", "Buff Prevent", "Move Prevent"]);
/** Fixed row order inside each group. */
export const ROW_ORDER: ModifierTag[] = ["Increase Damage Given", "Decrease Damage Given", "Decrease Damage Taken", "Increase Damage Taken", "Shield", "Absorb", "Lifesteal", "Reflect", "Recoil", "Drain", "Wound", "Afterburn", "Stun", "Buff Prevent", "Debuff Prevent", "Clear Prevent", "Move Prevent", "Inject Jutsus", "Siphon", "Immunity"];

interface Effect {
  who: string; tag: ModifierTag; val: number | null; unit: ModifierRow["unit"]; el: string;
  castRound: number; castIndex: number; rounds: number; startsNow: boolean; openEnded: boolean;
  removedAt: number | null; removedBy: "Clear" | "Cleanse" | null;
}

/** Last round an effect counts in. "For the next N rounds" counts from the next round; "starting this round" counts from now. */
const lastRound = (e: Effect) => (e.startsNow ? e.castRound + e.rounds - 1 : e.castRound + e.rounds);

export function actionName(entry: BattleEntry): string {
  if (entry.actionId === "wait") return "Wait";
  const i = entry.description.indexOf(":");
  return i > 0 ? entry.description.slice(0, i).trim() : entry.actionId;
}
export function targetTile(entry: BattleEntry): string | null {
  const m = entry.description.match(/on <b>([A-Z]\d+)<\/b>/);
  return m ? m[1] : null;
}

export function rowsFor(userId: string, index: number, round: number, effects: Effect[], shield: number) {
  type G = ModifierRow;
  const groups = new Map<string, G>();
  for (const e of effects) {
    if (e.who !== userId || e.castIndex > index) continue;
    if (e.removedAt !== null && e.removedAt < index) continue;
    if (round > lastRound(e)) continue;
    const state = e.removedAt === index ? "removed" : !e.startsNow && round === e.castRound ? "queued" : "active";
    const key = `${e.tag}|${e.el}|${state}`;
    const pol: Polarity = BUFF_TAGS.has(e.tag) ? "buff" : "debuff";
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { tag: e.tag, element: e.el, state, polarity: pol, value: e.val === null ? null : 0, unit: e.unit, roundsLeft: null, removedBy: e.removedBy, count: 0 }));
    if (e.val !== null) g.value = +(((g.value ?? 0) + e.val).toFixed(2));
    g.count++;
    if (state === "active" && !e.openEnded) g.roundsLeft = Math.max(g.roundsLeft ?? 0, lastRound(e) - round + 1);
  }
  const rows = [...groups.values()];
  if (shield > 0) rows.push({ tag: "Shield", element: "", state: "active", polarity: "buff", value: +shield.toFixed(2), unit: " HP", roundsLeft: null, removedBy: null, count: 1 });
  const so = { active: 0, removed: 1, queued: 2 } as const;
  rows.sort((a, b) =>
    (a.polarity === b.polarity ? 0 : a.polarity === "buff" ? -1 : 1) ||
    ROW_ORDER.indexOf(a.tag) - ROW_ORDER.indexOf(b.tag) ||
    (a.element ? 1 : 0) - (b.element ? 1 : 0) ||
    so[a.state] - so[b.state]);
  let given = 0, taken = 0;
  for (const r of rows) {
    if (r.state !== "active" || r.element || r.value === null) continue;
    if (r.tag === "Increase Damage Given") given += r.value;
    if (r.tag === "Decrease Damage Given") given -= r.value;
    if (r.tag === "Increase Damage Taken") taken += r.value;
    if (r.tag === "Decrease Damage Taken") taken -= r.value;
  }
  return { rows, net: { given: +given.toFixed(1), taken: +taken.toFixed(1) } };
}

/**
 * Pure: rebuilds the full state after every action from the log plus each fighter's start.
 * frames[0] is the battle start; frames[n] is the state after the n-th action.
 */
export function rebuildReplay(entries: BattleEntry[], fighters: FighterStart[], opts: RebuildOptions): ReplayFrame[] {
  const sorted = [...entries].sort((a, b) => a.battleVersion - b.battleVersion);
  const byName = new Map(fighters.map((f) => [f.name, f.userId]));
  const idOf = (name: string) => {
    const id = byName.get(name);
    if (!id) throw new Error(`Log names an unknown fighter: ${name}`);
    return id;
  };
  const other = (id: string) => fighters.find((f) => f.userId !== id)!.userId;
  const effects: Effect[] = [];
  const grounds: { tile: string; ownerId: string; kind: string; castRound: number; rounds: number; castIndex: number }[] = [];
  const barriers: { tile: string; ownerId: string; hp: number | null; hitTile: string | null; castIndex: number }[] = [];
  let cur: FighterFrame[] = fighters.map((f) => ({ userId: f.userId, name: f.name, side: f.side, hp: f.startHp, maxHp: f.maxHp, shield: 0, tile: f.startTile, defeated: f.startHp <= 0 }));
  const frames: ReplayFrame[] = [];
  const snapshot = (index: number, round: number, F: FighterFrame[], action: ReplayFrame["action"], popups: Popup[], notes: string[]): ReplayFrame => ({
    index, round, action,
    fighters: F.map((f) => ({ ...f, hp: +f.hp.toFixed(2), shield: +f.shield.toFixed(2) })),
    modifiers: Object.fromEntries(F.map((f) => [f.userId, rowsFor(f.userId, index, round, effects, f.shield)])),
    zones: grounds.filter((g) => g.castIndex <= index && round <= g.castRound + g.rounds).map((g) => ({ tile: g.tile, ownerId: g.ownerId, kind: g.kind, roundsLeft: g.castRound + g.rounds - round + 1 })),
    barriers: barriers.map((b) => ({ tile: b.tile, ownerId: b.ownerId, hp: b.hp, hitTile: b.hitTile })),
    popups, notes,
  });
  frames.push(snapshot(0, sorted[0]?.battleRound ?? 1, cur, null, [], []));

  sorted.forEach((entry, ix) => {
    const index = ix + 1, round = entry.battleRound;
    const F = cur.map((f) => ({ ...f }));
    const get = (id: string) => F.find((f) => f.userId === id)!;
    const tile = targetTile(entry);
    const name = actionName(entry);
    const isMove = !!tile && opts.isMoveAction(entry.actionId);
    if (isMove) get(entry.userId).tile = tile!;
    // Barriers announce themselves only through their jutsu; the game knows which jutsu place one.
    if (/Adamantine Fortress/.test(name) && tile) barriers.push({ tile, ownerId: entry.userId, hp: null, hitTile: null, castIndex: index });
    const popups: Popup[] = [], notes: string[] = [];
    for (const { txt } of entry.appliedEffects) {
      const p = parseLine(txt);
      if (p.k === "eff") effects.push({ who: idOf(p.who), tag: p.tag, val: p.val, unit: p.unit, el: p.el, castRound: round, castIndex: index, rounds: p.rounds, startsNow: p.startsNow, openEnded: p.openEnded, removedAt: null, removedBy: null });
      else if (p.k === "ground") grounds.push({ tile: tile ?? get(idOf(p.who)).tile, ownerId: idOf(p.who), kind: p.kind, castRound: round, rounds: p.rounds, castIndex: index });
      else if (p.k === "hp") {
        if (p.d === 0) continue;
        const f = get(idOf(p.who));
        f.hp = Math.min(f.maxHp, Math.max(0, f.hp + p.d));
        f.defeated = f.hp <= 0;
        popups.push({ targetId: f.userId, tile: null, amount: p.d, kind: p.t });
      } else if (p.k === "shield") {
        let id = idOf(p.who);
        if (p.op === "add") get(id).shield += p.v;
        else if (p.op === "set") get(id).shield = p.v;
        else {
          // Engine quirk: a defender's leftover shield soaking reflect is logged under the attacker's name.
          if (p.soak && get(id).shield === 0 && get(other(id)).shield > 0) {
            notes.push(`${get(other(id)).name}'s own shield soaks the last ${Math.round(p.soak)} of the reflect (the log names the other fighter here)`);
            id = other(id);
          }
          get(id).shield = 0;
        }
        if (p.soak) popups.push({ targetId: id, tile: null, amount: -p.soak, kind: "shield" });
      } else if (p.k === "barrier") {
        const b = barriers[barriers.length - 1];
        if (b) { b.hp = p.left; b.hitTile = tile; }
        popups.push({ targetId: null, tile, amount: -p.d, kind: "barrier" });
      } else if (p.k === "remove") {
        const id = idOf(p.who);
        const set = p.by === "Clear" ? CLEAR_REMOVES : CLEANSE_REMOVES;
        for (const e of effects) if (e.who === id && e.removedAt === null && set.has(e.tag) && round >= e.castRound && round <= lastRound(e)) { e.removedAt = index; e.removedBy = p.by; }
        if (p.by === "Clear") get(id).shield = 0;
      }
    }
    cur = F;
    frames.push(snapshot(index, round, F, {
      battleVersion: entry.battleVersion, actionId: entry.actionId, actorId: entry.userId, name, targetTile: tile, isMove,
      lines: entry.appliedEffects.filter((e) => !/loses 0\.00 (CP|SP)|heals 0 (SP|CP)/.test(e.txt)).map((e) => ({ txt: e.txt.trim(), color: e.color })),
    }, popups, notes));
  });
  return frames;
}
