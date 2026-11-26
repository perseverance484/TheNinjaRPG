import type { FighterFrame, ModifierRow, Polarity } from "../types";
import { sideColor } from "../tokens";

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
export function rowValue(r: ModifierRow): string {
  if (r.value === null) return "";
  const v = Math.abs(+r.value.toFixed(1));
  if (r.tag === "Stun") return `−${v} AP`;
  if (r.unit === " HP") return fmt(v);
  return `${v}${r.unit}`;
}

/** Filled circle = buff, filled diamond = debuff; hollow = lands next round. */
export function Badge({ polarity, hollow }: { polarity: Polarity; hollow: boolean }) {
  const c = polarity === "buff" ? "var(--br-buff)" : "var(--br-debuff)";
  const style = hollow ? { fill: "none", stroke: c, strokeWidth: 2 } : { fill: c };
  return (
    <svg viewBox="0 0 20 20" width={20} height={20} aria-hidden>
      {polarity === "buff" ? <circle cx={10} cy={10} r={8} style={style} /> : <rect x={4} y={4} width={12} height={12} transform="rotate(45 10 10)" style={style} />}
    </svg>
  );
}

function NetChip({ value, label, goodIfUp }: { value: number; label: "GIVEN" | "TAKEN"; goodIfUp: boolean }) {
  const cls = value === 0 ? "zero" : value > 0 === goodIfUp ? "good" : "bad";
  const w = Math.min(50, Math.abs(value) / 2);
  return (
    <div className={`br-chip ${cls}`}>
      <div className="br-chip-x">
        {value !== 0 && <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden><path d={value > 0 ? "M6 1 11 11H1z" : "M6 11 1 1h10z"} fill="currentColor" /></svg>}
        <b>{value > 0 ? "+" : value < 0 ? "−" : ""}{Math.abs(value)}%</b><em>{label}</em>
      </div>
      <div className="br-chip-tr"><i style={value >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} /></div>
    </div>
  );
}

function Group({ rows, polarity }: { rows: ModifierRow[]; polarity: Polarity }) {
  const rs = rows.filter((r) => r.polarity === polarity);
  const lastRemoved = rs.map((r) => r.state).lastIndexOf("removed");
  return (
    <>
      <div className={`br-grp ${polarity}`}>{polarity === "buff" ? "buffs" : "debuffs"}</div>
      {rs.length === 0 && <div className="br-none">none</div>}
      {rs.map((r, k) => (
        <div key={`${r.tag}|${r.element}|${r.state}`}>
          <div className={`br-row ${polarity} ${r.state}`}>
            <Badge polarity={polarity} hollow={r.state === "queued"} />
            <div className="br-lb">{r.tag}
              {r.element && <small>({r.element.replace(/, /g, " · ")})</small>}
              {r.state === "queued" && <small>next round</small>}
              {r.state === "active" && r.roundsLeft !== null && <small>{r.roundsLeft} rd left</small>}
            </div>
            <div className="br-v">{rowValue(r)}</div>
          </div>
          {k === lastRemoved && <div className="br-why">removed by {r.removedBy}</div>}
        </div>
      ))}
    </>
  );
}

export function ModifierPanel({ fighter, rows, net }: { fighter: FighterFrame; rows: ModifierRow[]; net: { given: number; taken: number } }) {
  return (
    <div className="br-pan">
      <h3><span className="br-dot" style={{ background: sideColor(fighter.side) }} />{fighter.name}</h3>
      <Group rows={rows} polarity="buff" />
      <Group rows={rows} polarity="debuff" />
      <div className="br-net">
        <div className="br-net-lbl">NET</div>
        <div className="br-chips"><NetChip value={net.given} label="GIVEN" goodIfUp /><NetChip value={net.taken} label="TAKEN" goodIfUp={false} /></div>
      </div>
    </div>
  );
}
