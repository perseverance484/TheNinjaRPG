import { createRoot } from "react-dom/client";
import { BattleReplay, type BattleEntry, type FighterStart } from "../src";
import entries from "../fixtures/battle_cYlLV24zfgzJ2mqCxlKn7.entries.json";
import fighters from "../fixtures/fighters.json";
import moveIds from "../fixtures/move_action_ids.json";

// In the game this comes from the jutsu data (any action whose tags include a move); here it is listed for the fixture.
const MOVES = new Set<string>(moveIds.ids);
const isMoveAction = (id: string) => MOVES.has(id);

createRoot(document.getElementById("root")!).render(
  <BattleReplay entries={entries as BattleEntry[]} fighters={fighters as FighterStart[]} isMoveAction={isMoveAction} />
);
