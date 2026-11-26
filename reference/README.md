# TNR battle replay: reference implementation

This package is the reference for building battle replays in The Ninja RPG so they look and behave exactly like the demo. It has three parts.

1. **Reference component** (`src/`): React + TypeScript. `rebuildReplay()` is a pure function that turns a battle's log entries plus each fighter's start HP into one state per action. `<BattleReplay>` renders those states. Drawing the board is a swappable prop, so the game can plug in its own board and art.
2. **Design spec**: a separate doc with every colour, size, row order and timing. All values also live in `src/tokens.ts` and `src/replay.css`.
3. **Golden data** (`golden/`): the expected state after each of the 59 actions of battle `cYlLV24zfgzJ2mqCxlKn7`, plus reference PNGs of five key frames. A port is correct when it produces the same states.

## Run it

```
npm install
npm run dev        # harness: the Tamaki fight in the browser
npm test           # 12 checks: 60 states, 7 HP checkpoints, equals golden, Clear/Cleanse cases
npm run golden     # rebuild golden/states.json and golden/checkpoints.json
npm run frames     # rebuild golden/frames/*.png (needs Inter + Zen Kaku Gothic New .ttf in FONT_DIR)
npm run typecheck
```

## What the game needs to supply

| Input | Where it comes from | Notes |
|---|---|---|
| `entries: BattleEntry[]` | `combat.getBattleEntries` as it is today | Any order; sorted by `battleVersion`. |
| `fighters: FighterStart[]` | **New**: stored once when the battle starts | `startHp`, `maxHp`, `startTile`, `side`, and the name exactly as it appears in log lines. This is the one data change. |
| `isMoveAction(actionId)` | The game's jutsu data | True for `move`, `replacementTechnique` and any jutsu that moves the caster. The log alone does not say which jutsu move. |
| `renderBoard` (optional) | The game's own battle board | Receives `{ frame, animate }`. Without it the plain hex board is used. |

## Files

- `src/types.ts`: input and output types. `ReplayFrame` is the whole contract.
- `src/parse.ts`: one regex per log line type.
- `src/rebuild.ts`: state rebuild, Clear/Cleanse lists, row grouping and order, NET.
- `src/tokens.ts`, `src/replay.css`: design tokens and styles (prefix `br-`).
- `src/components/`: `HexBoard`, `HpBars`, `ModifierPanel`.
- `src/BattleReplay.tsx`: controls, playback timing, caption, legend, banner.
- `harness/`: tiny Vite page rendering the fixture.
- `fixtures/`: the battle's 59 entries (flavour text trimmed, everything else as the API returned it), fighter starts, move action ids.
- `golden/states.json`: 60 frames (start + 59 actions). `golden/checkpoints.json`: hand-checked HP after actions 14, 18, 32, 40, 51, 57, 59.
- `golden/frames/`: start, #14 first damage, #18 Cleanse, #36 Clear, #59 final, as PNG and SVG.
- `tests/rebuild.test.ts`, `scripts/`.

## How to port

If the game uses a different framework, keep `rebuildReplay` as is (it has no UI dependencies) and port only the components. Then run your rebuild against `fixtures/` and compare with `golden/states.json` field by field. Compare your rendered frames with `golden/frames/`.

## Not verified

- **Board orientation.** Flat-top hexes, letters as columns A–M, numbers as rows 1–9, odd columns shifted down. Not checked against the game's real board; `renderBoard` exists so the game's own board can replace it.
- **Barrier footprint.** Adamantine Fortress is drawn on the cast tile plus the tile that was hit. The real shape may be larger.
- **Start tiles.** I3 and D3 were inferred from the first moves; the new battle-start data should store them.
- **Move Prevent** has no duration in the log, so it is shown for 2 rounds.
- **Reference PNGs** are rendered from SVG (real `HexBoard` markup plus panels drawn with the same tokens) with resvg, not screenshots of the component in a browser. Text widths can differ by a few pixels.
- **Shield quirk** at action 33: the log says dauntless's shield was destroyed, but it was ANBU Member's leftover shield soaking reflect. The rebuild handles it and adds a note.
- Whether the game's frontend is React was not checked.
