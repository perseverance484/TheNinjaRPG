import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BattleEntry, FighterStart, ReplayFrame } from "./types";
import { rebuildReplay } from "./rebuild";
import { tokens, sideColor, groundLabel } from "./tokens";
import { HexBoard, type BoardRenderProps } from "./components/HexBoard";
import { HpBars } from "./components/HpBars";
import { ModifierPanel } from "./components/ModifierPanel";
import "./replay.css";

export interface BattleReplayProps {
  entries: BattleEntry[];
  fighters: FighterStart[];
  /** True for actions that move the caster (move, replacementTechnique, jutsu with a move tag). */
  isMoveAction: (actionId: string) => boolean;
  /** Swap in the game's own board and art. Receives the current frame. */
  renderBoard?: (p: BoardRenderProps) => ReactNode;
  initialIndex?: number;
  initialSpeed?: number;
  onIndexChange?: (index: number) => void;
}

const lineClass = (t: string) =>
  /takes|loses|recoil|afterburn|wound|drained/.test(t) && !/will (take|recoil)/.test(t) ? "r" : /steals|absorbs .* converts|heals|siphons/.test(t) ? "g" : "b";

function Caption({ frame, total }: { frame: ReplayFrame; total: number }) {
  const a = frame.action;
  if (!a) {
    const [p1, p2] = frame.fighters;
    return <div className="br-cap"><div className="br-t">Battle start</div>
      <div className="br-m">{p1.name} on {p1.tile}, {p2.name} on {p2.tile}.</div></div>;
  }
  const actor = frame.fighters.find((f) => f.userId === a.actorId)!;
  return (
    <div className="br-cap" aria-live="polite">
      <div className="br-m">Action {frame.index} of {total} · Round {frame.round}</div>
      <div className="br-t"><span style={{ color: sideColor(actor.side) }}>{actor.name}</span> · {a.name}{a.targetTile ? (a.isMove ? ` → ${a.targetTile}` : ` on ${a.targetTile}`) : ""}</div>
      <ul>
        {a.lines.map((l, k) => <li key={k} className={lineClass(l.txt)}>{l.txt}</li>)}
        {a.lines.length === 0 && <li className="n">{a.isMove ? `Moves to ${a.targetTile}` : "No effect lines"}</li>}
        {frame.notes.map((n, k) => <li key={"n" + k} className="n">{n}</li>)}
      </ul>
    </div>
  );
}

const Icon = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" aria-hidden><path d={d} /></svg>;

export function BattleReplay({ entries, fighters, isMoveAction, renderBoard, initialIndex = 0, initialSpeed = 1, onIndexChange }: BattleReplayProps) {
  const frames = useMemo(() => rebuildReplay(entries, fighters, { isMoveAction }), [entries, fighters, isMoveAction]);
  const total = frames.length - 1;
  const [index, setIndex] = useState(initialIndex);
  const [animate, setAnimate] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(initialSpeed);
  const [banner, setBanner] = useState<string | null>(null);
  const timer = useRef<number>();
  const frame = frames[index];

  const go = useCallback((n: number, anim: boolean) => {
    const i = Math.max(0, Math.min(total, n));
    setAnimate(anim); setIndex(i); onIndexChange?.(i);
  }, [total, onIndexChange]);

  useEffect(() => {
    if (!playing) return;
    if (index >= total) { setPlaying(false); return; }
    const newRound = frames[index + 1].round !== frames[index].round;
    timer.current = window.setTimeout(() => {
      if (newRound) { setBanner(`Round ${frames[index + 1].round}`); window.setTimeout(() => setBanner(null), tokens.timing.roundBannerMs); }
      go(index + 1, true);
    }, (newRound ? tokens.timing.newRoundMs : tokens.timing.actionMs) / speed);
    return () => window.clearTimeout(timer.current);
  }, [playing, index, speed, total, frames, go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") { setPlaying(false); go(index + 1, true); }
      else if (e.key === "ArrowLeft") { setPlaying(false); go(index - 1, true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, go]);

  const winner = index === total ? frame.fighters.find((f) => !f.defeated && frame.fighters.some((o) => o.defeated)) : null;
  const step = (n: number) => { setPlaying(false); go(n, true); };

  return (
    <div className="br-root">
      <section className="br-stage" aria-label="Replay">
        <HpBars fighters={frame.fighters} />
        <div className="br-fig">
          {(renderBoard ?? ((p) => <HexBoard {...p} />))({ frame, animate })}
          <div className={`br-banner${banner || winner ? " on" : ""}`}><span>{winner ? `${winner.name} wins on ${Math.round(winner.hp).toLocaleString("en-US")} HP` : banner}</span></div>
        </div>
        <div className="br-legend">
          {frame.zones.map((z, k) => <span key={"z" + k}>{z.tile} · {groundLabel(z.kind)} ground ({frame.fighters.find((f) => f.userId === z.ownerId)!.name}) · {z.roundsLeft} rd</span>)}
          {frame.barriers.map((b, k) => <span key={"b" + k}>{b.tile} · barrier ({frame.fighters.find((f) => f.userId === b.ownerId)!.name}){b.hp !== null ? ` · hit on ${b.hitTile}, ${Math.round(b.hp)} HP left` : ""}</span>)}
        </div>
        <Caption frame={frame} total={total} />
        <input className="br-scrub" type="range" min={0} max={total} value={index} aria-label="Scrub to action"
          onChange={(e) => { setPlaying(false); go(+e.target.value, false); }} />
        <div className="br-ctl">
          <button aria-label="Back to start" onClick={() => { setPlaying(false); go(0, false); }}><Icon d="M6 5h2v14H6zM20 5v14L9 12z" /></button>
          <button aria-label="Previous action" onClick={() => step(index - 1)}><Icon d="M18 5v14L7 12z" /></button>
          <button className="br-play" aria-label={playing ? "Pause" : "Play"} onClick={() => { if (index >= total) go(0, false); setPlaying(!playing); }}>
            <Icon d={playing ? "M6 5h4v14H6zM14 5h4v14h-4z" : "M7 5v14l12-7z"} /></button>
          <button aria-label="Next action" onClick={() => step(index + 1)}><Icon d="M6 5v14l11-7z" /></button>
          <button aria-label="Jump to end" onClick={() => step(total)}><Icon d="M4 5v14l11-7zM16 5h2v14h-2z" /></button>
          <div className="br-spd" role="group" aria-label="Speed">
            {tokens.timing.speeds.map((s) => <button key={s} aria-pressed={s === speed} onClick={() => setSpeed(s)}>{s}×</button>)}
          </div>
          <span className="br-cnt">{index} / {total} · R{frame.round}</span>
        </div>
      </section>
      <h2 className="br-h2">Active Modifiers</h2>
      <div className="br-mods">
        {frame.fighters.map((f) => <ModifierPanel key={f.userId} fighter={f} {...frame.modifiers[f.userId]} />)}
      </div>
    </div>
  );
}
