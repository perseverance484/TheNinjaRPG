import { writeFileSync } from "node:fs";
import { frames, CHECKPOINTS } from "./load";
const F = frames();
const here = new URL("..", import.meta.url).pathname;
let ok = true;
for (const [k, [a, d]] of Object.entries(CHECKPOINTS)) {
  const fr = F[+k]; const got = fr.fighters.map((f) => Math.round(f.hp));
  const pass = got[0] === a && got[1] === d; ok &&= pass;
  console.log(`#${k} ${fr.action?.name}: ${got.join(" / ")} ${pass ? "OK" : `EXPECTED ${a} / ${d}`}`);
}
if (!ok) { console.error("Checkpoint mismatch: golden not written"); process.exit(1); }
writeFileSync(here + "golden/states.json", JSON.stringify({ battleId: "cYlLV24zfgzJ2mqCxlKn7", frameCount: F.length, note: "frames[0] = battle start; frames[n] = state after action n", frames: F }, null, 1));
writeFileSync(here + "golden/checkpoints.json", JSON.stringify({ order: ["ANBU Member", "dauntless"], hpAfterAction: CHECKPOINTS }, null, 1));
console.log(`wrote ${F.length} frames`);
