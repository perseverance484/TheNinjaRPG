/** One entry exactly as `combat.getBattleEntries` returns it (newest first from the API; order does not matter here). */
export interface BattleEntry {
  id: string;
  battleId: string;
  battleVersion: number;
  battleRound: number;
  actionId: string;
  userId: string;
  description: string;
  createdAt?: string;
  appliedEffects: { txt: string; color?: string; types?: string[] }[];
}

/** The one thing the log does not hold: each fighter's state when the battle starts. */
export interface FighterStart {
  userId: string;
  /** Name exactly as it appears in the log lines (e.g. "ANBU Member"). */
  name: string;
  startHp: number;
  maxHp: number;
  /** Starting tile, e.g. "I3". Not in the log today; see README. */
  startTile: string;
  side: "red" | "blue";
}

export type Polarity = "buff" | "debuff";
export type RowState = "active" | "queued" | "removed";

export type ModifierTag =
  | "Increase Damage Given" | "Decrease Damage Given" | "Decrease Damage Taken" | "Increase Damage Taken"
  | "Shield" | "Absorb" | "Lifesteal" | "Reflect" | "Recoil" | "Drain" | "Wound" | "Afterburn" | "Stun"
  | "Buff Prevent" | "Debuff Prevent" | "Clear Prevent" | "Move Prevent" | "Inject Jutsus" | "Siphon" | "Immunity";

export interface ModifierRow {
  tag: ModifierTag;
  /** Element list for element-only rows, e.g. "Earth, Ice, None, Water, Wind"; "" for all damage. */
  element: string;
  state: RowState;
  polarity: Polarity;
  /** Summed value of every effect in this row, or null for value-less tags (prevents, Inject Jutsus). */
  value: number | null;
  unit: "%" | " / rd" | " AP" | " HP" | "";
  /** Rounds left including the current one (active rows only). */
  roundsLeft: number | null;
  /** "Clear" or "Cleanse" when state === "removed". */
  removedBy: "Clear" | "Cleanse" | null;
  /** How many log effects were summed into this row. */
  count: number;
}

export interface FighterFrame {
  userId: string;
  name: string;
  side: "red" | "blue";
  hp: number;
  maxHp: number;
  shield: number;
  tile: string;
  defeated: boolean;
}

export interface GroundZone { tile: string; ownerId: string; kind: string; roundsLeft: number }
export interface Barrier { tile: string; ownerId: string; hp: number | null; hitTile: string | null }
export type PopupKind = "damage" | "recoil" | "reflect" | "afterburn" | "wound" | "drain" | "lifesteal" | "absorb" | "heal" | "shield" | "barrier";
export interface Popup { targetId: string | null; tile: string | null; amount: number; kind: PopupKind }

export interface ReplayFrame {
  /** 0 = battle start, n = after the n-th action. */
  index: number;
  round: number;
  action: null | {
    battleVersion: number;
    actionId: string;
    actorId: string;
    name: string;
    targetTile: string | null;
    isMove: boolean;
    lines: { txt: string; color?: string }[];
  };
  fighters: FighterFrame[];
  modifiers: Record<string, { rows: ModifierRow[]; net: { given: number; taken: number } }>;
  zones: GroundZone[];
  barriers: Barrier[];
  popups: Popup[];
  notes: string[];
}

export interface RebuildOptions {
  /** True when the action moves its caster to the target tile. Basic moves are known; jutsu with a move tag come from the game's jutsu data. */
  isMoveAction: (actionId: string) => boolean;
}
