/**
 * Spec renders of key frames, as PNG, from the golden states.
 * The board is the real HexBoard component (react-dom/server markup). Stage, caption and the
 * Active Modifiers panels are drawn here as SVG with the same tokens as replay.css (dark theme).
 * These are NOT browser screenshots; no browser was available where this was made.
 * Fonts: pass a folder of Inter + Zen Kaku Gothic New .ttf files as FONT_DIR (default /tmp/fonts).
 */
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Resvg } from "@resvg/resvg-js";
import { frames } from "./load";
import { HexBoard } from "../src/components/HexBoard";
import { rowValue } from "../src/components/ModifierPanel";
import { tokens, sideColor, groundLabel } from "../src/tokens";
import type { ModifierRow, ReplayFrame } from "../src/types";

const here = new URL("..", import.meta.url).pathname;
const FONT_DIR = process.env.FONT_DIR ?? "/tmp/fonts";
const C = tokens.color;
const DARK = { ink: "#eceef3", mute: "#9aa0b0", line: "#262935", card: "#171922", page: "#0f1015", buff: C.buffDark, debuff: C.debuffDark };
const W = 720, PAD = 12, IN = W - PAD * 2;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const lineColor = (t: string) =>
  /takes|loses|recoil|afterburn|wound|drained/.test(t) && !/will (take|recoil)/.test(t) ? C.lineRed : /steals|absorbs .* converts|heals|siphons/.test(t) ? C.lineGreen : C.lineBlue;
function wrap(s: string, px: number, size: number): string[] {
  const max = Math.floor(px / (size * 0.53)); const out: string[] = []; let cur = "";
  for (const w of s.split(" ")) { if ((cur + " " + w).trim().length > max) { out.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
  if (cur) out.push(cur); return out;
}
const T = (x: number, y: number, s: string, size: number, fill: string, extra = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(s)}</text>`;

function board(frame: ReplayFrame, y: number): { svg: string; h: number } {
  let m = renderToStaticMarkup(createElement(HexBoard, { frame, animate: true }));
  // CSS transforms in style= are not SVG; turn the token positions into transform attributes.
  m = m.replace(/style="transform:translate\(([\d.]+)px, ?([\d.]+)px\);opacity:([\d.]+)"/g, 'transform="translate($1 $2)" opacity="$3"');
  const vb = /viewBox="([^"]+)"/.exec(m)![1].split(" ").map(Number);
  const h = (IN * vb[3]) / vb[2];
  m = m.replace("<svg", `<svg x="${PAD}" y="${y}" width="${IN}" height="${h}"`);
  return { svg: m, h };
}

function hpBars(frame: ReplayFrame, y: number) {
  const cw = (IN - 10) / 2; let s = "";
  frame.fighters.forEach((f, i) => {
    const x = PAD + i * (cw + 10), p = f.hp / f.maxHp, sh = Math.min(1 - p, f.shield / f.maxHp), bw = cw - 20;
    s += `<rect x="${x}" y="${y}" width="${cw}" height="74" rx="10" fill="${C.stage2}"/>`;
    s += `<circle cx="${x + 15}" cy="${y + 18}" r="5" fill="${sideColor(f.side)}"/>` + T(x + 26, y + 23, f.name, 14, C.stageInk, 'font-weight="600"');
    s += `<rect x="${x + 10}" y="${y + 34}" width="${bw}" height="12" rx="6" fill="${C.hpTrack}"/>`;
    if (p > 0) s += `<rect x="${x + 10}" y="${y + 34}" width="${bw * p}" height="12" rx="6" fill="${sideColor(f.side)}"/>`;
    if (sh > 0) s += `<rect x="${x + 10 + bw * p}" y="${y + 34}" width="${bw * sh}" height="12" rx="6" fill="url(#shield)" opacity=".9"/>`;
    s += `<text x="${x + 10}" y="${y + 64}" font-size="13" fill="${C.stageMute}"><tspan fill="${C.stageInk}" font-weight="600">${fmt(f.hp)}</tspan> / ${fmt(f.maxHp)}</text>`;
    if (f.shield > 0) s += T(x + cw - 10, y + 64, `shield ${fmt(f.shield)}`, 13, C.stageMute, 'text-anchor="end"');
  });
  return { svg: s, h: 74 };
}

function caption(frame: ReplayFrame, total: number, y: number) {
  const a = frame.action; let s = "", yy = y + 22;
  if (!a) {
    const [p1, p2] = frame.fighters;
    s += T(PAD + 12, yy, "Battle start", 15.5, C.stageInk, 'font-weight="600"'); yy += 20;
    s += T(PAD + 12, yy, `${p1.name} on ${p1.tile}, ${p2.name} on ${p2.tile}.`, 13, C.stageMute); yy += 10;
  } else {
    const actor = frame.fighters.find((f) => f.userId === a.actorId)!;
    s += T(PAD + 12, yy, `Action ${frame.index} of ${total} · Round ${frame.round}`, 13, C.stageMute); yy += 22;
    const tail = a.targetTile ? (a.isMove ? ` → ${a.targetTile}` : ` on ${a.targetTile}`) : "";
    s += `<text x="${PAD + 12}" y="${yy}" font-size="15.5" font-weight="600" fill="${C.stageInk}"><tspan fill="${sideColor(actor.side)}">${esc(actor.name)}</tspan>${esc(` · ${a.name}${tail}`)}</text>`; yy += 8;
    const items: [string, string, boolean][] = a.lines.map((l) => [l.txt, lineColor(l.txt), false]);
    if (!a.lines.length) items.push([a.isMove ? `Moves to ${a.targetTile}` : "No effect lines", C.stageMute, true]);
    frame.notes.forEach((n) => items.push([n, C.stageMute, true]));
    for (const [txt, col, it] of items) for (const ln of wrap(txt, IN - 24, 13.5)) { yy += 20; s += T(PAD + 12, yy, ln, 13.5, col, it ? 'font-style="italic"' : ""); }
    yy += 10;
  }
  const h = Math.max(96, yy - y);
  return { svg: `<rect x="${PAD}" y="${y}" width="${IN}" height="${h}" rx="10" fill="${C.stage2}"/>` + s, h };
}

function legend(frame: ReplayFrame, y: number) {
  const chips = [
    ...frame.zones.map((z) => `${z.tile} · ${groundLabel(z.kind)} ground (${frame.fighters.find((f) => f.userId === z.ownerId)!.name}) · ${z.roundsLeft} rd`),
    ...frame.barriers.map((b) => `${b.tile} · barrier (${frame.fighters.find((f) => f.userId === b.ownerId)!.name})${b.hp !== null ? ` · hit on ${b.hitTile}, ${Math.round(b.hp)} HP left` : ""}`),
  ];
  if (!chips.length) return { svg: "", h: 0 };
  let x = PAD, yy = y + 8, s = "";
  for (const c of chips) { const w = c.length * 12.5 * 0.53 + 18; if (x + w > PAD + IN) { x = PAD; yy += 28; }
    s += `<rect x="${x}" y="${yy}" width="${w}" height="22" rx="11" fill="${C.stage2}"/>` + T(x + 9, yy + 15.5, c, 12.5, C.stageMute); x += w + 6; }
  return { svg: s, h: yy + 22 - y };
}

function badge(x: number, cy: number, pol: "buff" | "debuff", hollow: boolean) {
  const c = pol === "buff" ? DARK.buff : DARK.debuff, st = hollow ? `fill="none" stroke="${c}" stroke-width="2"` : `fill="${c}"`;
  return pol === "buff" ? `<circle cx="${x + 10}" cy="${cy}" r="8" ${st}/>` : `<rect x="${x + 4}" y="${cy - 6}" width="12" height="12" transform="rotate(45 ${x + 10} ${cy})" ${st}/>`;
}
function panel(frame: ReplayFrame, fi: number, x: number, y: number, w: number, minH = 0) {
  const f = frame.fighters[fi], { rows, net } = frame.modifiers[f.userId];
  let s = "", yy = y + 12;
  s += `<circle cx="${x + 17}" cy="${yy + 10}" r="5" fill="${sideColor(f.side)}"/>` + T(x + 29, yy + 15, f.name, 15, DARK.ink, 'font-weight="700"'); yy += 30;
  for (const pol of ["buff", "debuff"] as const) {
    const rs = rows.filter((r: ModifierRow) => r.polarity === pol), last = rs.map((r) => r.state).lastIndexOf("removed");
    yy += 8; s += T(x + 12, yy + 10, pol === "buff" ? "BUFFS" : "DEBUFFS", 10.5, pol === "buff" ? DARK.buff : DARK.debuff, 'font-weight="700" letter-spacing=".4"'); yy += 16;
    if (!rs.length) { s += T(x + 12, yy + 14, "none", 13, DARK.mute); yy += 20; }
    rs.forEach((r, k) => {
      const subs = [r.element ? `(${r.element.replace(/, /g, " · ")})` : "", r.state === "queued" ? "next round" : r.state === "active" && r.roundsLeft !== null ? `${r.roundsLeft} rd left` : ""].filter(Boolean);
      const rh = 24 + subs.length * 15.6, op = r.state === "removed" ? 0.5 : r.state === "queued" ? 0.6 : 1, col = pol === "buff" ? DARK.buff : DARK.debuff;
      const v = rowValue(r);
      let g = badge(x + 12, yy + rh / 2, pol, r.state === "queued");
      g += T(x + 40, yy + 18, r.tag, 14, DARK.ink, r.state === "removed" ? 'text-decoration="line-through"' : "");
      subs.forEach((t, q) => (g += T(x + 40, yy + 18 + 15.6 * (q + 1), t, 12, DARK.mute)));
      if (v) g += T(x + w - 12, yy + rh / 2 + 5, v, 14, col, `font-weight="600" text-anchor="end"${r.state === "removed" ? ' text-decoration="line-through"' : ""}`);
      if (r.state === "removed") { // resvg ignores text-decoration, so draw the strike
        const tw = r.tag.length * 14 * 0.5; g += `<line x1="${x + 40}" y1="${yy + 13}" x2="${x + 40 + tw}" y2="${yy + 13}" stroke="${DARK.ink}" stroke-width="1.2"/>`;
        if (v) { const vw = v.length * 14 * 0.58; g += `<line x1="${x + w - 12 - vw}" y1="${yy + rh / 2}" x2="${x + w - 12}" y2="${yy + rh / 2}" stroke="${col}" stroke-width="1.2"/>`; }
      }
      s += `<g opacity="${op}">${g}</g>`; yy += rh;
      if (k === last) { s += T(x + 40, yy + 12, `removed by ${r.removedBy}`, 12, DARK.mute); yy += 16; }
    });
  }
  const netY = Math.max(yy + 10, y + minH - 96);
  s += `<line x1="${x + 12}" y1="${netY}" x2="${x + w - 12}" y2="${netY}" stroke="${DARK.line}"/>`;
  s += T(x + 12, netY + 22, "NET", 11, C.gold, 'font-weight="700" letter-spacing=".9"');
  const cw = (w - 24 - 8) / 2;
  [["GIVEN", net.given, true], ["TAKEN", net.taken, false]].forEach(([lbl, v, up], i) => {
    const val = v as number, col = val === 0 ? DARK.mute : (val > 0) === up ? DARK.buff : DARK.debuff, cx = x + 12 + i * (cw + 8), cy = netY + 32;
    s += `<rect x="${cx + 1}" y="${cy + 1}" width="${cw - 2}" height="50" rx="10" fill="none" stroke="${col}" stroke-width="2"/>`;
    let tx = cx + 10;
    if (val !== 0) { s += `<path transform="translate(${tx} ${cy + 15})" d="${val > 0 ? "M6 1 11 11H1z" : "M6 11 1 1h10z"}" fill="${col}"/>`; tx += 17; }
    s += T(tx, cy + 29, `${val > 0 ? "+" : val < 0 ? "−" : ""}${Math.abs(val)}%`, 20, col, 'font-weight="700"');
    s += T(cx + cw - 10, cy + 29, lbl as string, 11, DARK.mute, 'text-anchor="end"');
    const tl = cx + 10, tw = cw - 20, mid = tl + tw / 2, bw = (Math.min(50, Math.abs(val) / 2) / 100) * tw;
    s += `<rect x="${tl}" y="${cy + 41}" width="${tw}" height="3" rx="1.5" fill="${DARK.line}"/>`;
    if (val !== 0) s += `<rect x="${val > 0 ? mid : mid - bw}" y="${cy + 41}" width="${bw}" height="3" rx="1.5" fill="${col}"/>`;
    s += `<rect x="${mid - 0.5}" y="${cy + 39}" width="1" height="7" fill="${DARK.mute}"/>`;
  });
  const h = netY + 32 + 52 + 12 - y;
  return { svg: s, h };
}

function frameSvg(frame: ReplayFrame, total: number): string {
  let y = PAD, body = "";
  const hb = hpBars(frame, y); body += hb.svg; y += hb.h + 10;
  const bd = board(frame, y); body += bd.svg;
  const isEnd = frame.index === total, winner = isEnd ? frame.fighters.find((f) => !f.defeated && frame.fighters.some((o) => o.defeated)) : null;
  if (winner) { const t = `${winner.name} wins on ${fmt(winner.hp)} HP`, bw = t.length * 22 * 0.55 + 36, cy = y + bd.h / 2;
    body += `<rect x="${W / 2 - bw / 2}" y="${cy - 24}" width="${bw}" height="48" rx="12" fill="rgba(20,22,29,.88)" stroke="#3a3f4e"/>` + T(W / 2, cy + 8, t, 22, C.stageInk, `font-family="Zen Kaku Gothic New" font-weight="700" text-anchor="middle"`); }
  y += bd.h;
  const lg = legend(frame, y); body += lg.svg; y += lg.h;
  y += 10; const cp = caption(frame, total, y); body += cp.svg; y += cp.h + PAD;
  const stageH = y;
  let out = `<rect x="0" y="0" width="${W}" height="${stageH}" rx="16" fill="${C.stage}"/>` + body;
  y += 26; out += T(0, y + 18, "Active Modifiers", 20, DARK.ink, 'font-family="Zen Kaku Gothic New" font-weight="700"'); y += 30;
  const pw = (W - 12) / 2, a = panel(frame, 0, 0, y, pw), b = panel(frame, 1, pw + 12, y, pw), ph = Math.max(a.h, b.h);
  const A = panel(frame, 0, 0, y, pw, ph), B = panel(frame, 1, pw + 12, y, pw, ph);
  for (const [px, p] of [[0, A], [pw + 12, B]] as const) out += `<rect x="${px + 0.5}" y="${y + 0.5}" width="${pw - 1}" height="${ph - 1}" rx="14" fill="${DARK.card}" stroke="${DARK.line}"/>` + p.svg;
  y += ph;
  const M = 20, TH = y + M * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W + M * 2}" height="${TH}" viewBox="${-M} ${-M} ${W + M * 2} ${TH}" font-family="Inter">
<defs><pattern id="shield" width="8.49" height="8.49" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4.24" height="8.49" fill="${C.shieldA}"/><rect x="4.24" width="4.25" height="8.49" fill="${C.shieldB}"/></pattern>
<style>.br-pop{font-weight:700;font-size:15px;paint-order:stroke;stroke:#14161d;stroke-width:4px}.br-shot{stroke-dasharray:5 5}</style></defs>
<rect x="${-M}" y="${-M}" width="${W + M * 2}" height="${TH}" fill="${DARK.page}"/>${out}</svg>`;
}

const all = frames(), total = all.length - 1;
const SHOTS: [number, string][] = [[0, "start"], [14, "first_damage"], [18, "cleanse"], [36, "clear"], [total, "final"]];
const outDir = here + "golden/frames/"; mkdirSync(outDir, { recursive: true });
const fontFiles = readdirSync(FONT_DIR).filter((f) => /\.(ttf|otf)$/i.test(f)).map((f) => `${FONT_DIR}/${f}`);
for (const [i, name] of SHOTS) {
  const svg = frameSvg(all[i], total);
  const file = `frame_${String(i).padStart(2, "0")}_${name}`;
  writeFileSync(outDir + file + ".svg", svg);
  const png = new Resvg(svg, { fitTo: { mode: "zoom", value: 2 }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Inter" } }).render().asPng();
  writeFileSync(outDir + file + ".png", png);
  console.log(file, png.length);
}
