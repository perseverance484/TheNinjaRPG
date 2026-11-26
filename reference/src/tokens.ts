/** Design tokens. Values are the reference; the spec doc explains each. Reference frame: 400 px wide content, scales with container. */
export const tokens = {
  color: {
    stage: "#14161d", stage2: "#1d2029", stageInk: "#eceef3", stageMute: "#9aa0b0", stageLine: "#333847",
    hpTrack: "#2c303c", shieldA: "#cfd6e6", shieldB: "#9fa8bd",
    red: "#e5484d", blue: "#3e8cf0", gold: "#e7c35a",
    buffDark: "#6ee296", debuffDark: "#c88cff", buffLight: "#178a4c", debuffLight: "#8a3fd1",
    popDamage: "#ff6b70", popHeal: "#7fe3a4", popShield: "#cfd6e6",
    lineRed: "#ff8a8f", lineGreen: "#7fe3a4", lineBlue: "#9ec3ff",
    tileFill: "rgba(255,255,255,.035)", tileStroke: "rgba(255,255,255,.13)", axis: "#7d8395",
  },
  font: { heading: '"Zen Kaku Gothic New", Inter, sans-serif', body: "Inter, system-ui, sans-serif" },
  board: { hexRadius: 20, cols: 13, rows: 9, tokenRadius: 14, tokenStroke: 2 },
  timing: {
    actionMs: 1700, newRoundMs: 2600, speeds: [0.5, 1, 2, 4],
    moveMs: 550, moveEase: "cubic-bezier(.3,.7,.2,1)",
    hpMs: 500, hpEase: "ease",
    popupMs: 1500, popupRisePx: 26, popupStaggerPx: 15,
    ringMs: 1000, shotDashMs: 1000, roundBannerMs: 900,
  },
} as const;
export const sideColor = (side: "red" | "blue") => (side === "red" ? tokens.color.red : tokens.color.blue);
/** Readable names for ground-effect kinds as they appear in "marked the ground with X" log lines. */
export const GROUND_LABELS: Record<string, string> = { decreasedamagetaken: "Decrease Damage Taken", decreasedamagegiven: "Decrease Damage Given" };
export const groundLabel = (kind: string) => GROUND_LABELS[kind] ?? kind;
