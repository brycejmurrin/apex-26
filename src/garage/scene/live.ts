/**
 * GarageLive: the garage's LIVE atlas. The timing screen's track map, the
 * telemetry traces, the next-race sign and its flag, the sponsor banners, the
 * contact shadow and the lamp pools — everything that follows the game rather
 * than the team, repainted per circuit or career round.
 *
 * Ported verbatim from f1-game js/garage/scene-live.js:1-215 (GarageLive).
 * Differences: paintLive reads the sponsor tables from an injected
 * GarageLiveryTex slice (f1-game read the LiveryTex global, scene-live.js:110-111),
 * and build() takes the fixture table as before.
 */
import { css, HALF_W, rgb, scale, type TexAcc } from "./prims";
import { SCREEN } from "./equipment";
import type { CanvasRect, GarageCanvas, GarageCtx, GarageLivery, GarageLiveryTex, GarageTeam } from "./types";

// ── the LIVE atlas ─────────────────────────────────────────────────────────
// A SECOND, smaller atlas for everything that follows the game rather than
// the team: the timing screen's track map, the next-race sign, the sponsor
// banners, and two soft gradients (the car's contact shadow, the lamp pools).
// Separate from the 1024 dress on purpose — that one repaints on a team or
// paint change and is full; this one is 512 and can be repainted per circuit
// or per career round for a quarter of the upload. scene-live.js:7-23
export const LIVE = 512;
export const L_MAP: CanvasRect    = { x: 0,   y: 0,   w: 256, h: 200 };
export const L_TRACE: CanvasRect  = { x: 256, y: 0,   w: 256, h: 128 };
export const L_SHADOW: CanvasRect = { x: 256, y: 128, w: 128, h: 128 };
export const L_POOL: CanvasRect   = { x: 384, y: 128, w: 128, h: 128 };
export const L_BANNER: readonly CanvasRect[] = [{ x: 0, y: 256, w: 512, h: 64 }, { x: 0, y: 320, w: 512, h: 64 }];
export const L_FLAG: CanvasRect   = { x: 0,   y: 384, w: 128, h: 64 };
export const L_RACE: CanvasRect   = { x: 128, y: 384, w: 384, h: 64 };
// Flags as stripes: [orientation, colours...]; "h" stacks top to bottom, "v"
// runs left to right. Enough to read as the country at 0.4 m on a wall.
export const FLAGS: Readonly<Record<string, readonly string[]>> = {
  Argentina: ["h", "#74acdf", "#fff", "#74acdf"], Australia: ["h", "#00247d", "#00247d"],
  Austria: ["h", "#ed2939", "#fff", "#ed2939"], Azerbaijan: ["h", "#00b5e2", "#ef3340", "#509e2f"],
  Bahrain: ["v", "#fff", "#ce1126", "#ce1126", "#ce1126"], Belgium: ["v", "#000", "#fae042", "#ed2939"],
  Brazil: ["h", "#009c3b", "#ffdf00", "#009c3b"], Canada: ["v", "#ff0000", "#fff", "#ff0000"],
  China: ["h", "#de2910", "#de2910"], France: ["v", "#0055a4", "#fff", "#ef4135"],
  Germany: ["h", "#000", "#dd0000", "#ffce00"], Hungary: ["h", "#ce2939", "#fff", "#477050"],
  Italy: ["v", "#009246", "#fff", "#ce2b37"], Japan: ["h", "#fff", "#bc002d", "#fff"],
  Malaysia: ["h", "#cc0001", "#fff", "#cc0001", "#fff"], Mexico: ["v", "#006847", "#fff", "#ce1126"],
  Monaco: ["h", "#ce1126", "#fff"], Netherlands: ["h", "#ae1c28", "#fff", "#21468b"],
  Portugal: ["v", "#006600", "#ff0000", "#ff0000"], Qatar: ["v", "#fff", "#8a1538", "#8a1538", "#8a1538"],
  Russia: ["h", "#fff", "#0039a6", "#d52b1e"], "Saudi Arabia": ["h", "#006c35", "#006c35"],
  Singapore: ["h", "#ef3340", "#fff"], "South Africa": ["h", "#de3831", "#fff", "#007a4d", "#fff", "#002395"],
  Spain: ["h", "#aa151b", "#f1bf00", "#f1bf00", "#aa151b"], Turkey: ["h", "#e30a17", "#e30a17"],
  UAE: ["h", "#00732f", "#fff", "#000"], UK: ["h", "#012169", "#fff", "#c8102e", "#fff", "#012169"],
  USA: ["h", "#b22234", "#fff", "#b22234", "#fff", "#b22234", "#fff", "#b22234"],
};

/** The sponsor tables paintLive reads (LiveryTex.SPONSORS / SPONSOR_PACKS). */
export type LiveSponsors = Pick<GarageLiveryTex, "SPONSORS" | "SPONSOR_PACKS">;

/** scene-live.js:42-149 */
export function paintLive(cv: GarageCanvas, team: GarageTeam, liv: GarageLivery | null | undefined,
  ctx: GarageCtx | null | undefined, tex: LiveSponsors = {}): GarageCanvas {
  const ctx2 = cv.getContext("2d")!;
  ctx2.clearRect(0, 0, LIVE, LIVE);
  const c1 = rgb(liv && liv.c1, [0.30, 0.32, 0.36]);
  const c2 = rgb(liv && (liv.accent || liv.stripe || liv.c2), [0.6, 0.62, 0.66]);
  const track = ctx && ctx.track;
  // TIMING SCREEN: the circuit the next race runs at, drawn from its own
  // control points, with the round and the last result under it.
  {
    const R = L_MAP;
    ctx2.fillStyle = "#070a0e"; ctx2.fillRect(R.x, R.y, R.w, R.h);
    ctx2.fillStyle = css(scale(c1, 0.75)); ctx2.fillRect(R.x, R.y, R.w, 30);
    ctx2.fillStyle = "#f2f3f5"; ctx2.font = "700 18px system-ui, sans-serif";
    ctx2.textAlign = "left"; ctx2.textBaseline = "middle";
    ctx2.fillText(track ? String(track.name || track.id).toUpperCase() : "NO CIRCUIT", R.x + 10, R.y + 15, R.w - 20);
    // A raw Tracks.LIST entry that has not hydrated (LAZY_CIRCUIT meta stub) THROWS on
    // `.points` ("has no path"): skip the map only, so the flag, banners and career footer
    // below still paint; GarageScene.ctxKey repaints once the circuit is resident.
    let P: readonly (readonly number[])[] | null | undefined = null;
    try { P = track && track.points; } catch { P = null; }
    if (P && P.length > 3) {
      const at = (q: readonly number[] | undefined, k: number): number => q![k]!;
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (let i = 0; i < P.length; i++) { x0 = Math.min(x0, at(P[i], 0)); x1 = Math.max(x1, at(P[i], 0)); z0 = Math.min(z0, at(P[i], 2)); z1 = Math.max(z2z(P[i]!), z1); }
      const pad = 22, top = R.y + 40, bh = R.h - 40 - 46, bw = R.w - pad * 2;
      const sc = Math.min(bw / Math.max(1e-3, x1 - x0), bh / Math.max(1e-3, z1 - z0));
      const ox = R.x + pad + (bw - (x1 - x0) * sc) / 2, oz = top + (bh - (z1 - z0) * sc) / 2;
      // North up: -z is away from the driver at s = 0, so z runs DOWN the screen.
      ctx2.strokeStyle = "#232a33"; ctx2.lineWidth = 9; ctx2.lineJoin = "round";
      ctx2.beginPath();
      for (let i = 0; i <= P.length; i++) { const q = P[i % P.length]!, px = ox + (at(q, 0) - x0) * sc, pz = oz + (z2z(q) - z0) * sc; if (i) ctx2.lineTo(px, pz); else ctx2.moveTo(px, pz); }
      ctx2.stroke();
      ctx2.strokeStyle = css(c2); ctx2.lineWidth = 3.5; ctx2.stroke();
      ctx2.fillStyle = "#f2f3f5"; ctx2.beginPath();
      ctx2.arc(ox + (at(P[0], 0) - x0) * sc, oz + (z2z(P[0]!) - z0) * sc, 4.5, 0, Math.PI * 2); ctx2.fill();
    }
    // Footer: the round and what happened last time out.
    ctx2.fillStyle = "#11151b"; ctx2.fillRect(R.x, R.y + R.h - 40, R.w, 40);
    ctx2.font = "700 15px system-ui, sans-serif"; ctx2.fillStyle = "#9aa4b2";
    const last = ctx && ctx.last;
    const foot = ctx && ctx.career
      ? (last ? (last.dnf ? `LAST: DNF · ${String(last.dnf).toUpperCase()}` : `LAST: P${last.p} · ${(last.pts as number) | 0} PTS`) : "SEASON OPENER")
      : (track ? `${String(track.country || "").toUpperCase()}${ctx && ctx.night ? " · NIGHT" : ""}` : "SELECT A CIRCUIT");
    ctx2.fillText(foot, R.x + 10, R.y + R.h - 20, R.w - 20);
    ctx2.textAlign = "right"; ctx2.fillStyle = css(c2);
    ctx2.fillText(ctx && ctx.weather && ctx.weather !== "dry" ? String(ctx.weather).toUpperCase() : "", R.x + R.w - 10, R.y + R.h - 20);
    ctx2.textAlign = "left";
  }
  // Soft gradients: the contact shadow under the car and the lamp pools.
  for (const [R, inner, outer] of [[L_SHADOW, "rgba(0,0,0,0.78)", "rgba(0,0,0,0)"],
                                   [L_POOL, "rgba(255,238,205,0.34)", "rgba(255,238,205,0)"]] as const) {
    const gr = ctx2.createRadialGradient(R.x + R.w / 2, R.y + R.h / 2, 4, R.x + R.w / 2, R.y + R.h / 2, R.w / 2);
    gr.addColorStop(0, inner); gr.addColorStop(1, outer);
    ctx2.fillStyle = gr; ctx2.fillRect(R.x, R.y, R.w, R.h);
  }
  // SPONSOR BANNERS: the career's backer leads, the team's own partners fill.
  const names: string[] = [];
  if (ctx && ctx.sponsor && ctx.sponsor.label) names.push(String(ctx.sponsor.label).toUpperCase());
  const pack = liv && liv.sponsors && tex.SPONSOR_PACKS && tex.SPONSOR_PACKS[liv.sponsors];
  const teamNames = pack || (tex.SPONSORS && tex.SPONSORS[team.id as string]) || ["APEX 26", "PIT LANE", "PADDOCK", "GRID"];
  for (let i = 0; i < teamNames.length && names.length < 4; i++) if (names.indexOf(teamNames[i]!) < 0) names.push(teamNames[i]!);
  for (let b = 0; b < 2; b++) {
    const R = L_BANNER[b]!;
    ctx2.fillStyle = b ? "#eef0f3" : css(scale(c1, 0.55)); ctx2.fillRect(R.x, R.y, R.w, R.h);
    ctx2.fillStyle = b ? css(scale(c1, 0.75)) : "#f2f3f5";
    ctx2.font = "800 34px system-ui, sans-serif"; ctx2.textBaseline = "middle";
    ctx2.textAlign = "center";
    ctx2.fillText(`${names[b * 2] || ""}      ${names[b * 2 + 1] || ""}`, R.x + R.w / 2, R.y + R.h / 2, R.w - 24);
    ctx2.fillStyle = css(c2); ctx2.fillRect(R.x, R.y + R.h - 5, R.w, 5);
  }
  // NEXT RACE sign: the flag and the name.
  {
    const R = L_FLAG, f = FLAGS[(track && track.country) as string] || ["h", "#555", "#888"];
    const n = f.length - 1;
    for (let i = 0; i < n; i++) {
      ctx2.fillStyle = f[i + 1]!;
      if (f[0] === "h") ctx2.fillRect(R.x, R.y + (R.h * i) / n, R.w, R.h / n + 1);
      else ctx2.fillRect(R.x + (R.w * i) / n, R.y, R.w / n + 1, R.h);
    }
    if (track && track.country === "Japan") { ctx2.fillStyle = "#bc002d"; ctx2.beginPath(); ctx2.arc(R.x + R.w / 2, R.y + R.h / 2, 18, 0, Math.PI * 2); ctx2.fill(); }
    if (track && track.country === "Canada") { ctx2.fillStyle = "#ff0000"; ctx2.fillRect(R.x + R.w / 2 - 12, R.y + 14, 24, 36); }
    if (track && (track.country === "UK")) { ctx2.fillStyle = "#c8102e"; ctx2.fillRect(R.x + R.w / 2 - 8, R.y, 16, R.h); }
    const T = L_RACE;
    ctx2.fillStyle = "#0a0c10"; ctx2.fillRect(T.x, T.y, T.w, T.h);
    ctx2.fillStyle = css(c2); ctx2.fillRect(T.x, T.y, 6, T.h);
    ctx2.fillStyle = "#9aa4b2"; ctx2.font = "700 18px system-ui, sans-serif"; ctx2.textAlign = "left";
    ctx2.fillText(ctx && ctx.career ? `NEXT · ROUND ${((ctx.round as number) | 0) + 1}` : "NEXT RACE", T.x + 18, T.y + 18);
    ctx2.fillStyle = "#f2f3f5"; ctx2.font = "800 28px system-ui, sans-serif";
    ctx2.fillText(track ? `${String(track.name || track.id).toUpperCase()} GP` : "—", T.x + 18, T.y + 44, T.w - 30);
  }
  return cv;
}
/** A control point's z. scene-live.js:150 */
export const z2z = (q: readonly number[]): number => q[2]!;

// Two of the six engineer screens carry LIVE traces: a scrolling pair of
// channels that move with time, so the bank reads as monitors rather than a
// poster of monitors. Painted into L_TRACE and laid over the dress quad.
// scene-live.js:151-183
export function paintTrace(cv: GarageCanvas, liv: GarageLivery | null | undefined, now: number): void {
  const c = cv.getContext("2d")!;
  const R = L_TRACE;
  const t = now / 1000;
  const c2 = rgb(liv && (liv.accent || liv.stripe || liv.c2), [0.6, 0.62, 0.66]);
  c.fillStyle = "#05070a"; c.fillRect(R.x, R.y, R.w, R.h);
  for (let k = 0; k < 2; k++) {
    const x0 = R.x + k * (R.w / 2) + 3;
    const w = R.w / 2 - 6;
    const y0 = R.y + 3;
    const h = R.h - 6;
    c.fillStyle = "#0b1016"; c.fillRect(x0, y0, w, h);
    c.strokeStyle = "rgba(120,150,175,0.22)"; c.lineWidth = 1;
    for (let g = 1; g < 4; g++) { c.beginPath(); c.moveTo(x0 + 4, y0 + h * g / 4); c.lineTo(x0 + w - 4, y0 + h * g / 4); c.stroke(); }
    c.strokeStyle = k ? css(c2) : "#e2a33c"; c.lineWidth = 2; c.beginPath();
    for (let i = 0; i <= 28; i++) {
      const u = i / 28, px = x0 + 6 + (w - 12) * u;
      const py = y0 + h * 0.55 - Math.sin(u * 9 + t * (k ? 1.7 : 2.3)) * h * 0.22
        - Math.sin(u * 23 - t * 3.1) * h * 0.08 - (i % 4 === 0 ? 2 : 0);
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    }
    c.stroke();
    c.fillStyle = "#9aa4b2"; c.font = "700 11px system-ui, sans-serif"; c.textAlign = "left"; c.textBaseline = "top";
    c.fillText(k ? "BRAKE TEMP" : "ERS SOC", x0 + 6, y0 + 4);
    c.textAlign = "right"; c.fillStyle = k ? css(c2) : "#e2a33c";
    c.fillText(k ? `${410 + Math.round(Math.sin(t * 0.7) * 35)}°C` : `${Math.round(62 + Math.sin(t * 0.4) * 30)}%`, x0 + w - 6, y0 + 4);
  }
}

/** The groups the live atlas lands on. */
export type LiveSide = "mid" | "floor" | "nx" | "px" | "door";
export type LiveGroups = Record<LiveSide, TexAcc>;

// The quads the live atlas lands on. `floor` is its own group: the shadow and
// pools draw with no glow (they are not signage), everything else at the
// dress's 0.62. scene-live.js:184-221
export function build(FIXTURES: readonly (readonly unknown[])[]): LiveGroups {
  // A fixture row: x at 0, z at 2, aim x/z at 6/8, `wide` at 13 (scene.ts FIXTURES).
  const g = {} as LiveGroups;
  for (const k of ["mid", "floor", "nx", "px", "door"] as const) g[k] = { pos: [], nrm: [], uv: [], idx: [] };
  // scene-live.js:188 also computes zd = Z_DOOR - 0.03, which nothing reads.
  const xw = HALF_W - 0.03;
  // The screen face, on the housing's -Z side (see equipment.ts build).
  const sx = SCREEN[0], sy = SCREEN[1], sz = SCREEN[2] - 0.051;
  dquadR(g.mid, [[sx + 0.88, sy - 0.68, sz], [sx - 0.88, sy - 0.68, sz], [sx - 0.88, sy + 0.68, sz], [sx + 0.88, sy + 0.68, sz]], [0, 0, -1], L_MAP);
  // Contact shadow: the car's footprint, y 0.006 above the wheel boxes (0.003).
  dquadR(g.floor, [[-1.7, 0.006, -3.4], [1.7, 0.006, -3.4], [1.7, 0.006, 3.8], [-1.7, 0.006, 3.8]], [0, 1, 0], L_SHADOW);
  // Lamp pools under the two keys and four fills.
  for (let i = 0; i < 6; i++) {
    const F = FIXTURES[i] as readonly number[], r = F[13] ? 2.2 : 1.6, x = F[0]! + F[6]! * 1.2, z = F[2]! + F[8]! * 1.2;
    dquadR(g.floor, [[x - r, 0.005, z - r], [x + r, 0.005, z - r], [x + r, 0.005, z + r], [x - r, 0.005, z + r]], [0, 1, 0], L_POOL);
  }
  // Two live trace tiles over the dress screen bank (D_SCREEN spans z 2.15..
  // -0.95, y 1.10..2.65 on -X; each tile is a third by a half of it), 5 mm
  // proud of THAT quad — which stands 0.19 m off the wall on the monitor bank
  // block. The first cut put these 5 mm off the WALL, inside the bank, where
  // the depth test deleted them: the traces animated into a block for a week
  // and the screens showed only the dress paint.
  const xt = -xw + 0.195;
  dquadR(g.nx, [[xt, 1.10, 2.15], [xt, 1.10, 0.08], [xt, 1.875, 0.08], [xt, 1.875, 2.15]], [1, 0, 0], L_TRACE);
  // Banners on the side walls, in the y 1.72-2.12 band both walls have free
  // forward of the data boards.
  dquadR(g.nx, [[-xw, 1.72, 4.6], [-xw, 1.72, 2.4], [-xw, 2.12, 2.4], [-xw, 2.12, 4.6]], [1, 0, 0], L_BANNER[0]!);
  dquadR(g.px, [[xw, 1.72, 2.4], [xw, 1.72, 4.6], [xw, 2.12, 4.6], [xw, 2.12, 2.4]], [-1, 0, 0], L_BANNER[1]!);
  // Next-race sign ON THE SHUTTER (z 6.24, where the door wordmark lives),
  // under that wordmark's y 2.60 and above the shutter's 1.98 bottom rail.
  // It was on the door wall at x 4.2..5.2, which the REAR preset frames only
  // as its extreme top-left corner — measured, the flag was half off the edge.
  dquadR(g.door, [[3.42, 2.26, 6.24], [2.94, 2.26, 6.24], [2.94, 2.50, 6.24], [3.42, 2.50, 6.24]], [0, 0, -1], L_FLAG);
  dquadR(g.door, [[3.98, 2.04, 6.24], [2.94, 2.04, 6.24], [2.94, 2.21, 6.24], [3.98, 2.21, 6.24]], [0, 0, -1], L_RACE);
  return g;
}

/** One atlas quad, corners [BL, BR, TR, TL]; V flipped for FLIP_Y uploads. scene-live.js:222-232 */
export function dquadR(out: TexAcc, c: readonly (readonly [number, number, number])[], n: readonly [number, number, number], region: CanvasRect): void {
  const u = { uL: region.x / LIVE, uR: (region.x + region.w) / LIVE, vT: 1 - region.y / LIVE, vB: 1 - (region.y + region.h) / LIVE };
  const i = out.pos.length / 3;
  const uvs = [[u.uL, u.vB], [u.uR, u.vB], [u.uR, u.vT], [u.uL, u.vT]] as const;
  for (let k = 0; k < 4; k++) {
    out.pos.push(c[k]![0], c[k]![1], c[k]![2]);
    out.nrm.push(n[0], n[1], n[2]);
    out.uv.push(uvs[k]![0], uvs[k]![1]);
  }
  out.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
}
