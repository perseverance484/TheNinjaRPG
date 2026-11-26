import type { FighterFrame } from "../types";
import { sideColor } from "../tokens";
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
export function HpBars({ fighters }: { fighters: FighterFrame[] }) {
  return (
    <div className="br-bars">
      {fighters.map((f) => {
        const p = (f.hp / f.maxHp) * 100, s = Math.min(100 - p, (f.shield / f.maxHp) * 100);
        return (
          <div className="br-fb" key={f.userId}>
            <div className="br-nm"><span className="br-dot" style={{ background: sideColor(f.side) }} />{f.name}</div>
            <div className="br-hpbar"><i style={{ width: `${p}%`, background: sideColor(f.side) }} /><i className="br-sh" style={{ left: `${p}%`, width: `${s}%` }} /></div>
            <div className="br-hpn"><span><b>{fmt(f.hp)}</b> / {fmt(f.maxHp)}</span><span>{f.shield > 0 ? `shield ${fmt(f.shield)}` : ""}</span></div>
          </div>
        );
      })}
    </div>
  );
}
