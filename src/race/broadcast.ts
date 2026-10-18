/**
 * BROADCAST, the pure half: the timing tower at race time T from a real-race
 * script, the gap/interval spelling, and the director's choices — the next
 * event worth a cut, the closest battles, the picture-in-picture car, and the
 * shot for a cut. The live director (DOM tower, camera cuts) is the camera
 * lane's: it takes these as `deps.broadcast`.
 *
 * Ported from f1-game js/race/broadcast.js:1-240 (main @ 2026-10-18). Pooled
 * scratch arrays are kept: `towerAt` and `battles` return module-owned arrays
 * that the next call reuses (f1-game static audit #7), so copy what you keep.
 */

// ── The director's rules (:5-24) ───────────────────────────────────────────
export const SHOT_MIN_S = 5;
export const SHOT_MAX_S = 14;
export const EVENT_LEAD_S = 6;
export const EVENT_HOLD_S = 2;
export const BATTLE_S = 1.0;
export const MANUAL_S = 20;
export const TOWER_TICK_S = 0.25;
export const DELTA_S = 6;
/** The TV shots the director rotates through (CamModes ids). */
export const SHOTS: readonly string[] = ["side", "heli", "tcam", "chase", "cinematic", "low"];
export const EVENT_SHOTS: Readonly<Record<string, readonly string[]>> = { pass: ["side", "heli", "chase"], pit: ["heli", "side"], out: ["heli", "side"], fastest: ["tcam", "chase", "side"] };
export const EVENT_RANK: Readonly<Record<string, number>> = { out: 4, pass: 3, fastest: 2, pit: 1 };
export const PIP_DROP_S = 2;
export const PIP_LABEL: Readonly<Record<string, string>> = {
  battle: "ONBOARD · ", pass: "OVERTAKE · ", pit: "PIT · ", out: "OUT · ", fastest: "FASTEST LAP · ",
  behind: "BEHIND · ", ahead: "AHEAD · ", leader: "LEADER · ",
};

// ── The real-race script the tower reads (js/race/real-replay.js) ──────────
export interface ScriptDriver {
  readonly num: number;
  readonly code?: string | null;
  readonly grid?: number | null;
  readonly dns?: boolean;
  readonly dnf?: boolean;
  readonly outT?: number | null;
  /** lapStart[k]: seconds from lights out of the k-th line crossing. */
  readonly lapStart?: readonly (number | null | undefined)[];
  /** laps[k]: the k-th lap's time. */
  readonly laps?: readonly (number | null | undefined)[];
  readonly stints?: readonly { readonly from: number; readonly c: string }[];
  readonly pitT?: readonly (number | null | undefined)[];
  readonly pitDur?: readonly (number | null | undefined)[];
}

export interface RaceScript {
  readonly drivers?: readonly ScriptDriver[];
  readonly fastest?: { readonly t?: number | null; readonly num?: number } | null;
}

/** One tower row (:37-45). */
export interface TowerRow {
  pos: number;
  num: number;
  code: string | null | undefined;
  lap: number;
  gap: number | null;
  interval: number | null;
  down: number;
  tyre: string | null;
  pit: boolean;
  out: boolean;
  fastest: boolean;
  grid: number | null;
}

interface Slot { d: ScriptDriver | null; k: number; at: number | null; _pit?: boolean; _tyre?: string | null }

const _lead: Slot[] = [], _stopped: Slot[] = [], _rows: TowerRow[] = [];
const _doneScratch: Slot = { d: null, k: 0, at: null };
let _towerScript: RaceScript | null = null, _towerSample = 0, _towerN = 0;
function _slot(arr: Slot[], i: number): Slot {
  let s = arr[i];
  if (!s) { s = { d: null, k: 0, at: null }; arr[i] = s; }
  return s;
}
function _row(i: number): TowerRow {
  let r = _rows[i];
  if (!r) {
    r = { pos: 0, num: 0, code: null, lap: 0, gap: null, interval: null, down: 0, tyre: null, pit: false, out: false, fastest: false, grid: null };
    _rows[i] = r;
  }
  return r;
}
function _mix(h: number, n: number): number { h ^= (n | 0); return Math.imul(h, 16777619) >>> 0; }

/** Seconds from lights out of driver d's k-th crossing (k >= 1), or null (:49-54). */
export function crossAt(d: ScriptDriver, k: number): number | null {
  const ls = d.lapStart || [], laps = d.laps || [];
  if (ls[k] != null) return ls[k] as number;
  if (ls[k - 1] != null && (laps[k - 1] as number) > 0) return (ls[k - 1] as number) + (laps[k - 1] as number);
  return null;
}
/** Laps d had completed by T into `slot` (:56-62). */
export function doneByInto<S extends { k: number; at: number | null }>(d: ScriptDriver, T: number, slot: S): S {
  let k = 0, at: number | null = null;
  const n = (d.laps || []).length;
  for (let j = 1; j <= n; j++) { const c = crossAt(d, j); if (c == null || c > T) break; k = j; at = c; }
  slot.k = k; slot.at = at;
  return slot;
}
/** The compound letter d ran on `lap` (:63-67). */
export function compoundAt(d: ScriptDriver, lap: number): string | null {
  let c: string | null = null;
  for (const st of d.stints || []) if (st.from <= lap) c = st.c;
  return c ? String(c)[0] as string : null;
}
/** In the pit window around a stop (:68-72). */
export function inPit(d: ScriptDriver, T: number): boolean {
  const t = d.pitT || [], dur = d.pitDur || [];
  for (let i = 0; i < t.length; i++) if (t[i] != null && T >= (t[i] as number) - 12 && T <= (t[i] as number) + ((dur[i] as number) > 0 ? dur[i] as number : 22) + 6) return true;
  return false;
}

const goneOf = (d: ScriptDriver, T: number, out?: ((num: number) => boolean) | null): boolean =>
  out ? out(d.num) : !!(d.dnf && d.outT != null && T >= d.outT);

/** A key that changes only when what the tower shows would (:75-96). */
export function towerSample(script: RaceScript, T: number, out?: ((num: number) => boolean) | null): number {
  let h = 2166136261 >>> 0;
  const drivers = script.drivers || [];
  for (let i = 0; i < drivers.length; i++) {
    const d = drivers[i] as ScriptDriver;
    if (d.dns) continue;
    doneByInto(d, T, _doneScratch);
    const gone = goneOf(d, T, out);
    const pit = inPit(d, T);
    const tyre = compoundAt(d, Math.max(1, _doneScratch.k + 1));
    h = _mix(h, d.num);
    h = _mix(h, _doneScratch.k);
    h = _mix(h, _doneScratch.at == null ? -1 : (_doneScratch.at * 1000) | 0);
    h = _mix(h, gone ? 1 : 0);
    h = _mix(h, pit ? 1 : 0);
    h = _mix(h, tyre ? tyre.charCodeAt(0) : 0);
  }
  const fast = script.fastest && script.fastest.t != null && T >= script.fastest.t ? script.fastest.num : 0;
  return _mix(h, fast || 0);
}

/** The tower rows at race time T, timing order; a pooled array (:98-159). */
export function towerAt(script: RaceScript, T: number, out?: ((num: number) => boolean) | null): TowerRow[] {
  let nLead = 0, nStop = 0, h = 2166136261 >>> 0;
  const drivers = script.drivers || [];
  for (let i = 0; i < drivers.length; i++) {
    const d = drivers[i] as ScriptDriver;
    if (d.dns) continue;
    const gone = goneOf(d, T, out);
    const dest = gone ? _stopped : _lead;
    const si = gone ? nStop++ : nLead++;
    const s = _slot(dest, si);
    s.d = d;
    doneByInto(d, T, s);
    const pit = inPit(d, T);
    const tyre = compoundAt(d, Math.max(1, s.k + 1));
    s._pit = pit; s._tyre = tyre;
    h = _mix(h, d.num);
    h = _mix(h, s.k);
    h = _mix(h, s.at == null ? -1 : (s.at * 1000) | 0);
    h = _mix(h, gone ? 1 : 0);
    h = _mix(h, pit ? 1 : 0);
    h = _mix(h, tyre ? tyre.charCodeAt(0) : 0);
  }
  const fast = script.fastest && script.fastest.t != null && T >= script.fastest.t ? script.fastest.num ?? null : null;
  h = _mix(h, fast || 0);
  _lead.length = nLead;
  _stopped.length = nStop;
  if (script === _towerScript && h === _towerSample && _towerN > 0) {
    _rows.length = _towerN;
    return _rows;
  }
  _lead.sort((a, b) => (b.k - a.k) || (a.k ? (a.at as number) - (b.at as number) : ((a.d as ScriptDriver).grid || 99) - ((b.d as ScriptDriver).grid || 99)));
  _stopped.sort((a, b) => (b.k - a.k) || ((b.at || 0) - (a.at || 0)));
  const L = _lead[0] as Slot;
  let n = 0;
  for (let i = 0; i < nLead; i++) {
    const r = _lead[i] as Slot, rd = r.d as ScriptDriver;
    let gap: number | null = null, interval: number | null = null, down = 0;
    if (i && r.k && L.k) {
      for (let j = r.k + 1; j <= L.k; j++) { const c = crossAt(L.d as ScriptDriver, j); if (c != null && c <= (r.at as number)) down++; }
      if (!down) { const lc = crossAt(L.d as ScriptDriver, r.k); if (lc != null) gap = (r.at as number) - lc; }
      const A = _lead[i - 1] as Slot;
      if (!down && A.k >= r.k) { const ac = crossAt(A.d as ScriptDriver, r.k); if (ac != null) interval = (r.at as number) - ac; }
    }
    const row = _row(n++);
    row.pos = i + 1; row.num = rd.num; row.code = rd.code; row.lap = r.k;
    row.gap = gap; row.interval = interval; row.down = down;
    row.tyre = r._tyre ?? null; row.pit = !!r._pit; row.out = false; row.fastest = fast === rd.num;
    row.grid = rd.grid || null;
  }
  for (let i = 0; i < nStop; i++) {
    const r = _stopped[i] as Slot, rd = r.d as ScriptDriver;
    const row = _row(n++);
    row.pos = nLead + i + 1; row.num = rd.num; row.code = rd.code; row.lap = r.k;
    row.gap = null; row.interval = null; row.down = 0;
    row.tyre = null; row.pit = false; row.out = true; row.fastest = fast === rd.num;
    row.grid = rd.grid || null;
  }
  _rows.length = n;
  _towerScript = script; _towerSample = h; _towerN = n;
  return _rows;
}

/** The tower's gap text (:161-171). `fmtGapSec` is HudReadouts.fmtGapSec when the HUD is loaded. */
export function fmtGap(r: Pick<TowerRow, "out" | "pit" | "pos" | "down" | "gap" | "interval">, mode?: "gap" | "interval", fmtGapSec?: (v: number) => string): string {
  if (r.out) return "OUT";
  if (r.pit) return "PIT";
  if (r.pos === 1) return mode === "interval" ? "INTERVAL" : "LEADER";
  if (r.down) return "+" + r.down + " LAP" + (r.down > 1 ? "S" : "");
  const v = mode === "interval" ? r.interval : r.gap;
  if (v == null) return "";
  return "+" + (fmtGapSec ? fmtGapSec(v) : v.toFixed(v < 9.95 ? 2 : 1));
}

/** A highlight in the race script. */
export interface RaceEvent {
  readonly t: number;
  readonly kind: string;
  readonly num?: number | null;
}

/** The next event worth a cut within `lead` s of T, highest rank wins (:175-187). */
export function nextEvent(list: readonly RaceEvent[], T: number, shown: ReadonlySet<number>, lead: number, ok?: ((num: number) => boolean) | null): { i: number; h: RaceEvent } | null {
  let best: { i: number; h: RaceEvent } | null = null;
  for (let i = 0; i < list.length; i++) {
    const h = list[i] as RaceEvent;
    if (h.t < T) continue;
    if (h.t > T + lead) break;
    if (shown.has(i) || h.num == null || !EVENT_RANK[h.kind] || (ok && !ok(h.num))) continue;
    if (!best || (EVENT_RANK[h.kind] as number) > (EVENT_RANK[best.h.kind] as number)) best = { i, h };
  }
  return best;
}

/** A car as the director sees it: [{key, prog, speed}] by progress, leader first. */
export interface DirectorCar<K> {
  readonly key: K;
  readonly prog: number;
  readonly speed?: number;
}

/** One battle: `key` chases `ahead` by `gapS`; lower `score` is better. */
export interface Fight<K> { key: K | null; ahead: K | null; gapS: number; score: number }

const _fights: Fight<unknown>[] = [];
/**
 * The closest battles, best first; a pooled array (:194-212). `vScale` is
 * vTop()/VMAX when the speeds are the sim's (PACE-scaled); omit for real m/s.
 */
export function battles<K>(cars: readonly DirectorCar<K>[], vScale?: number): Fight<K>[] {
  let n = 0;
  const floor = 20 * ((vScale as number) > 0 ? vScale as number : 1);
  for (let i = 1; i < cars.length; i++) {
    const a = cars[i - 1] as DirectorCar<K>, b = cars[i] as DirectorCar<K>;
    const v = Math.max(b.speed || 0, floor);
    const g = (a.prog - b.prog) / v;
    if (g < 0 || g >= BATTLE_S) continue;
    let f = _fights[n];
    if (!f) { f = { key: null, ahead: null, gapS: 0, score: 0 }; _fights[n] = f; }
    f.key = b.key; f.ahead = a.key; f.gapS = g; f.score = g + i * 0.08;
    n++;
  }
  _fights.length = n;
  _fights.sort((x, y) => x.score - y.score);
  return _fights as Fight<K>[];
}

export interface PipChoice<K> { key: K; cam: "tcam" | "chase"; kind: string }

/** The picture-in-picture car; never the followed one (:220-234). */
export function pipPick<K>(fights: readonly Fight<K>[], followKey: K, evKey?: K | null, evKind?: string | null,
  running?: readonly { readonly key: K }[] | null): PipChoice<K> | null {
  let behind: K | null = null, ahead: K | null = null;
  for (const f of fights) {
    if (f.ahead === followKey && behind == null) behind = f.key;
    if (f.key === followKey && ahead == null) ahead = f.ahead;
  }
  const partner = behind != null ? behind : ahead;
  if (partner != null && partner !== followKey) return { key: partner, cam: "tcam", kind: "battle" };
  if (evKey != null && evKey !== followKey) return { key: evKey, cam: "chase", kind: evKind || "pass" };
  if (running && running.length > 1) {
    const i = running.findIndex((r) => r.key === followKey);
    if (i < 0) return { key: (running[0] as { key: K }).key, cam: "chase", kind: "leader" };
    if (running[i + 1]) return { key: (running[i + 1] as { key: K }).key, cam: "tcam", kind: "behind" };
    if (running[i - 1]) return { key: (running[i - 1] as { key: K }).key, cam: "chase", kind: "ahead" };
  }
  return null;
}

/** The shot for a cut: from the kind's list, never the shot on air (:236-240). */
export function shotFor(kind: string | null | undefined, onAir: string | null | undefined, n: number): string | null | undefined {
  const pool = (EVENT_SHOTS[kind as string] || SHOTS).filter((s) => s !== onAir);
  return pool.length ? pool[(n | 0) % pool.length] : onAir;
}
