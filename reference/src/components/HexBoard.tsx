import type { ReplayFrame } from "../types";
import { tokens, sideColor } from "../tokens";

const R = tokens.board.hexRadius, H = Math.sqrt(3) * R;
/** Flat-top hexes, odd columns shifted down half a hex. Letters are columns (A..M), numbers are rows (1..9). */
export function tileCenter(tile: string): [number, number] {
  const c = tile.charCodeAt(0) - 65, r = +tile.slice(1) - 1;
  return [R + c * 1.5 * R, H / 2 + r * H + (c % 2 ? H / 2 : 0)];
}
export function hexPoints(x: number, y: number): string {
  return [0, 60, 120, 180, 240, 300].map((a) => { const q = (a * Math.PI) / 180; return `${(x + R * Math.cos(q)).toFixed(1)},${(y + R * Math.sin(q)).toFixed(1)}`; }).join(" ");
}
const W = R + (tokens.board.cols - 1) * 1.5 * R + R, HH = tokens.board.rows * H + H / 2;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export interface BoardRenderProps { frame: ReplayFrame; animate: boolean }

/** Default board. The game swaps this for its own board via BattleReplay's renderBoard prop. */
export function HexBoard({ frame, animate }: BoardRenderProps) {
  const color = (id: string) => sideColor(frame.fighters.find((f) => f.userId === id)!.side);
  const cols = Array.from({ length: tokens.board.cols }, (_, c) => String.fromCharCode(65 + c));
  const a = frame.action;
  const actor = a ? frame.fighters.find((f) => f.userId === a.actorId)! : null;
  const stack: Record<string, number> = {};
  return (
    <svg className="br-board" viewBox={`-18 -18 ${W + 22} ${HH + 22}`} role="img" aria-label="Battle board">
      <defs>
        <pattern id="br-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="rgba(207,214,230,.18)" /><line x1="0" y1="0" x2="0" y2="5" stroke="rgba(207,214,230,.55)" strokeWidth="2" />
        </pattern>
      </defs>
      {cols.map((L, c) => <text key={L} x={R + c * 1.5 * R} y={-6} fill={tokens.color.axis} fontSize={10} textAnchor="middle">{L}</text>)}
      {Array.from({ length: tokens.board.rows }, (_, r) => <text key={r} x={-9} y={H / 2 + r * H + 4} fill={tokens.color.axis} fontSize={10} textAnchor="middle">{r + 1}</text>)}
      {cols.flatMap((L) => Array.from({ length: tokens.board.rows }, (_, r) => { const [x, y] = tileCenter(L + (r + 1)); return <polygon key={L + r} points={hexPoints(x, y)} fill={tokens.color.tileFill} stroke={tokens.color.tileStroke} />; }))}
      {frame.zones.map((z, k) => { const [x, y] = tileCenter(z.tile); const col = color(z.ownerId); return (
        <g key={"z" + k}><polygon points={hexPoints(x, y)} fill={col} fillOpacity={0.28} stroke={col} strokeDasharray="3 3" />
          <text x={x} y={y - 8} fontSize={8} fill="#e8eaf0" textAnchor="middle">ground</text></g>); })}
      {frame.barriers.flatMap((b, k) => { const out = [b.tile, ...(b.hitTile && b.hitTile !== b.tile ? [b.hitTile] : [])]; return out.map((t, q) => { const [x, y] = tileCenter(t); return (
        <g key={`b${k}${q}`}><polygon points={hexPoints(x, y)} fill="url(#br-hatch)" stroke={tokens.color.shieldA} strokeWidth={1.5} />
          {t === b.hitTile && b.hp !== null && <text x={x} y={y + 4} fontSize={9} fontWeight={700} fill="#fff" textAnchor="middle">{fmt(b.hp)}</text>}</g>); }); })}
      {animate && a && a.targetTile && actor && (actor.tile === a.targetTile
        ? <circle key={"ring" + frame.index} className="br-ring" cx={tileCenter(a.targetTile)[0]} cy={tileCenter(a.targetTile)[1]} r={20} fill="none" stroke={color(actor.userId)} strokeWidth={3} />
        : !a.isMove && <g key={"shot" + frame.index}>
            <line className="br-shot" x1={tileCenter(actor.tile)[0]} y1={tileCenter(actor.tile)[1]} x2={tileCenter(a.targetTile)[0]} y2={tileCenter(a.targetTile)[1]} stroke={color(actor.userId)} strokeWidth={2.5} />
            <polygon points={hexPoints(...tileCenter(a.targetTile))} fill="none" stroke={color(actor.userId)} strokeWidth={2} /></g>)}
      {frame.fighters.map((f) => { const [x, y] = tileCenter(f.tile); return (
        <g key={f.userId} className="br-token" style={{ transform: `translate(${x}px,${y}px)`, opacity: f.defeated ? 0.35 : 1 }}>
          <circle r={tokens.board.tokenRadius} fill={sideColor(f.side)} stroke="#fff" strokeWidth={tokens.board.tokenStroke} />
          <text y={5} textAnchor="middle" fill="#fff" fontWeight={700} fontSize={14}>{f.name.charAt(0).toUpperCase()}</text></g>); })}
      {animate && frame.popups.map((p, k) => {
        const key = p.targetId ?? "tile";
        const [x, y] = p.tile ? tileCenter(p.tile) : tileCenter(frame.fighters.find((f) => f.userId === p.targetId)!.tile);
        const off = (stack[key] = (stack[key] ?? -1) + 1) * tokens.timing.popupStaggerPx;
        const col = p.kind === "shield" || p.kind === "barrier" ? tokens.color.popShield : p.amount > 0 ? tokens.color.popHeal : tokens.color.popDamage;
        const label = (p.amount > 0 ? "+" : "−") + fmt(Math.abs(p.amount)) + (p.kind === "damage" || p.kind === "barrier" ? "" : " " + p.kind);
        return <text key={`p${frame.index}-${k}`} className="br-pop" x={x} y={y - 20 - off} fill={col} textAnchor="middle" style={{ animationDelay: `${off / 60}s` }}>{label}</text>;
      })}
    </svg>
  );
}
