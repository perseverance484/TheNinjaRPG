import { readFileSync } from "node:fs";
import { rebuildReplay } from "../src/rebuild";
import type { BattleEntry, FighterStart } from "../src/types";
const here = new URL("..", import.meta.url).pathname;
export const entries: BattleEntry[] = JSON.parse(readFileSync(here + "fixtures/battle_cYlLV24zfgzJ2mqCxlKn7.entries.json", "utf8"));
export const fighters: FighterStart[] = JSON.parse(readFileSync(here + "fixtures/fighters.json", "utf8"));
const moves = new Set<string>(JSON.parse(readFileSync(here + "fixtures/move_action_ids.json", "utf8")).ids);
export const frames = () => rebuildReplay(entries, fighters, { isMoveAction: (id) => moves.has(id) });
/** Hand-checked HP (rounded) after these actions: [ANBU Member, dauntless]. */
export const CHECKPOINTS: Record<number, [number, number]> = { 14: [4413, 5050], 18: [4521, 4531], 32: [3097, 4463], 40: [2181, 2778], 51: [1020, 2005], 57: [145, 1961], 59: [0, 1961] };
