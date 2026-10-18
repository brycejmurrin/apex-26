/**
 * WATCH & DRIVE: the pure race-script builder and its readers.
 *
 * Ported verbatim from f1-game js/data/real-race-tab.js (the DataRealRace IIFE):
 *   constants            :5-36     (SCRIPT_V :12, TRACE_* :23-29, DISTANCES :30, num/lapNo/arr :32-37)
 *   localDay             :41-48
 *   trackIdFor           :50-76    (SeasonCal.REAL_2026 is the injected `calendar`)
 *   todFor               :78-90
 *   weatherFor           :92-99
 *   cautionsFor          :101-133
 *   gridFor              :135-147
 *   build                :149-256
 *   incidentFor          :259-270
 *   incidentsFor         :271-283
 *   passesFor            :285-320
 *   lapBoard             :324-354  (RealRace.cumTable is the injected `cumTable`)
 *   timingConfidence     :355-363
 *   compoundAt           :364-368
 *   pitDuel              :370-392
 *   traceDetails         :394-404
 *   raceBook             :406-431
 *   fmtLap, fmtGap       :433-438
 *   rainByLap            :440-463
 *   packTrace            :572-585
 *   traceEnd             :586-590
 *   traceCoverage        :591-597
 *   traceFits            :598-601
 *   usableTrace          :602-618
 *
 * `RaceScript` is the compact script js/race/real-race.js replays (the race
 * lane's RealRace: stage/arm/fieldAt/situation/cumTable/paceTable/planFor read
 * it), SCRIPT_V = 6. Float math keeps f1-game's operation order.
 */
import type { Key } from "../api";

// ── Constants (real-race-tab.js:5-37) ───────────────────────────────────────

export const OPENF1 = "https://api.openf1.org/v1";
export const SCRIPT_V = 6;   // 2: stint ages, rain by lap, the complete flag; 3: the passes; 4: real timestamps (t0, lap starts, pass/stop/flag times), where a car went out, the fastest lap, the team radio; 5: per-driver timing coverage; 6: flag ending notices separate from release
// The real positions (OpenF1 /location, ~3.7 Hz per car, 2-5 MB a car for a race) — fetched once
// per car, kept at TRACE_HZ in IndexedDB (a 22-car race is ~1.5 MB there), never in localStorage.
export const TRACE_V = 2;
export const TRACE_HZ = 2;
export const TRACE_PAD_S = 90;   // seconds of positions before lights out (the grid) and after the last lap
export const DISTANCES: readonly number[] = [1, 0.5, 0.2, 0.1];   // FULL, half, a fifth, a tenth of the real distance

/** Number or null — f1-game's local `num` (:32), not api.ts's parseFloat one: "" and "12abc" are null here. */
export const num = (v: unknown): number | null =>
  (typeof v === "number" && isFinite(v) ? v : (v != null && v !== "" && isFinite(Number(v)) ? Number(v) : null));
// A lap index sizes per-driver arrays: one fractional or huge upstream row threw
// (`Invalid array length`) or allocated millions of slots per driver (1e9 OOMed).
const MAX_GP_LAPS = 100;   // a modern GP runs 44-78 laps (Monaco 78); headroom, not a real race
export const lapNo = (v: unknown): number | null => { const n = num(v); return Number.isInteger(n) && n !== null && n >= 1 && n <= MAX_GP_LAPS ? n : null; };
function arr<T>(v: readonly T[] | null | undefined): readonly T[] { return Array.isArray(v) ? v : []; }

// ── Raw OpenF1 rows (the fields the builder reads) ──────────────────────────

/** An upstream number: OpenF1 sends numbers, but a row may carry a string or null. */
export type NumLike = number | string | null | undefined;
export type StrLike = string | null | undefined;

/** One /sessions row (meeting_name is filled from /meetings by fetchRaw). */
export interface OpenF1Session {
  session_key?: NumLike; meeting_key?: NumLike; year?: NumLike;
  meeting_name?: StrLike; name?: StrLike; session_name?: StrLike; session_type?: StrLike;
  circuit_short_name?: StrLike; circuit?: StrLike; country_name?: StrLike; country?: StrLike;
  date_start?: StrLike; dateStart?: StrLike; gmt_offset?: StrLike;
}
export interface OpenF1Driver { driver_number?: NumLike; name_acronym?: StrLike; full_name?: StrLike; broadcast_name?: StrLike; team_name?: StrLike }
export interface OpenF1Lap { driver_number?: NumLike; lap_number?: NumLike; lap_duration?: NumLike; date_start?: StrLike }
export interface OpenF1Stint { driver_number?: NumLike; compound?: StrLike; lap_start?: NumLike; lap_end?: NumLike; tyre_age_at_start?: NumLike }
export interface OpenF1Pit { driver_number?: NumLike; lap_number?: NumLike; date?: StrLike; lane_duration?: NumLike; pit_duration?: NumLike }
export interface OpenF1RaceControl { date?: StrLike; lap_number?: NumLike; message?: StrLike; flag?: StrLike; category?: StrLike }
export interface OpenF1Weather { date?: StrLike; rainfall?: NumLike }
export interface OpenF1Result { driver_number?: NumLike; position?: NumLike; number_of_laps?: NumLike; dnf?: boolean | null; dns?: boolean | null; dsq?: boolean | null }
export interface OpenF1Position { driver_number?: NumLike; position?: NumLike; date?: StrLike }
export interface OpenF1Overtake { overtaking_driver_number?: NumLike; overtaken_driver_number?: NumLike; position?: NumLike; date?: StrLike }
export interface OpenF1TeamRadio { driver_number?: NumLike; date?: StrLike; recording_url?: StrLike }

type Rows<T> = readonly (T | null)[] | null | undefined;

/** The bodies build() reads (real-race-tab.js:150): each an OpenF1 body, `session` one /sessions row. */
export interface RawRace {
  session?: OpenF1Session | null;
  drivers?: Rows<OpenF1Driver>;
  laps?: Rows<OpenF1Lap>;
  stints?: Rows<OpenF1Stint>;
  pits?: Rows<OpenF1Pit>;
  overtakes?: Rows<OpenF1Overtake>;
  raceControl?: Rows<OpenF1RaceControl>;
  weather?: Rows<OpenF1Weather>;
  result?: Rows<OpenF1Result>;
  positions?: Rows<OpenF1Position>;
  teamRadio?: Rows<OpenF1TeamRadio>;
}

// ── The script (what js/race/real-race.js consumes) ─────────────────────────

/** One stint: OpenF1 compound upper-cased (`c`), real laps [from, to], set age at fitting. */
export interface ScriptStint { c: string; from: number; to: number; age: number }

export interface ScriptDriver {
  num: number;
  /** Three-letter code (RealRace.mapField seats by it). */
  code: string;
  name: string;
  /** OpenF1 team name. */
  team: string;
  /** The roster team (findTeam), or null. */
  teamId: string | null;
  /** Pre-start position snapshot, or null. */
  grid: number | null;
  /** Classified position, null when not classified. */
  pos: number | null;
  lapsDone: number;
  dnf: boolean;
  /** Lap durations in seconds by real lap - 1; null untimed. */
  laps: (number | null)[];
  stints: ScriptStint[];
  /** In-laps, ascending. */
  pits: number[];
  /** Seconds from lights out at each lap's start, by real lap - 1 (v4). */
  lapStart: (number | null)[];
  /** Seconds from lights out of each stop, aligned with `pits` (present when any stop). */
  pitT?: (number | null)[];
  /** Pit-lane durations, aligned with `pits`. */
  pitDur?: (number | null)[];
  /** Present once the driver has a classification row. */
  dsq?: boolean;
  dns?: boolean;
  /** A retirement: where ("TURN 1") and when (seconds from lights out). */
  outWhere?: string | null;
  outT?: number | null;
}

/** A caution window on the leader's lap: 2 VSC, 3 SC, 4 red. The t* fields are seconds from lights out (v4/v6). */
export interface Caution {
  level: number; from: number; to: number; cause: string;
  tFrom?: number | null; tTo?: number | null;
  /** v6: when "IN THIS LAP"/"ENDING" was posted (release is tTo, at TRACK CLEAR). */
  tEnding?: number | null;
}
export interface Pass { lap: number; by: number; over: number; pos: number | null; t?: number | null; frac?: number }
export interface Fastest { num: number; lap: number; dur: number; t: number | null }
export interface RadioClip { t: number; num: number; lap: number; url: string }
export interface Incident { lap: number; t: number | null; text: string }
export type TimeOfDay = "default" | "dawn" | "day" | "dusk" | "night";
export type WeatherChip = "dry" | "wet" | "rain";

/** The compact race script (SCRIPT_V = 6) js/race/real-race.js replays. */
export interface RaceScript {
  v: number;
  source: "openf1";
  fetchedAt: string;
  sessionKey: number | null;
  meetingKey: number | null;
  year: number | null;
  name: string;
  session: string;
  circuit: string;
  country: string;
  /** Game circuit id (TrackInfo.id), or null when the circuit is not in the game. */
  trackId: string | null;
  dateStart: string;
  tod: TimeOfDay;
  weather: WeatherChip;
  /** Rain by real lap (index = lap, 0 unused), or null without lap timestamps. */
  rain: boolean[] | null;
  laps: number;
  /** Grid order. */
  drivers: ScriptDriver[];
  cautions: Caution[];
  passes: Pass[];
  complete: boolean;
  /** Lights out, epoch ms. */
  t0: number | null;
  fastest: Fastest | null;
  radio: RadioClip[];
  incidents: Incident[];
  /** Set by the tab's scriptFor, never stored. */
  provenance?: "cached" | "fetched";
}

/** A game circuit as the builder reads it (f1-game Tracks.LIST entries). */
export interface TrackInfo { id: string; name: string; country: string; classic?: boolean }
/** One SeasonCal.REAL_2026 window (f1-game js/career/season-cal.js:650-659). */
export interface CalendarWindow { id: string; from: string; to: string; sprint?: boolean }
export type FindTeam = (apiName: string | null | undefined) => { id: string } | null | undefined;

/** RealRace.cumTable's output: per driver number, cumulative seconds by laps completed (0 at the start). */
export type CumTable = Readonly<Record<number, readonly number[]>>;
export type CumTableFn = (script: RaceScript) => CumTable | null | undefined;

// ── The script builder (pure) ───────────────────────────────────────────────

/** The session's LOCAL calendar day (date_start + gmt_offset) as YYYY-MM-DD, or null. */
function localDay(session: OpenF1Session): string | null {
  const t = Date.parse(session.date_start || session.dateStart || "");
  if (!isFinite(t)) return null;
  const off = String(session.gmt_offset || "00:00:00").split(":");
  const sign = off[0]!.trim().startsWith("-") ? -1 : 1;
  return new Date(t + sign * (Math.abs(Number(off[0])) + (Number(off[1]) || 0) / 60) * 3600000).toISOString().slice(0, 10);
}

/** Game circuit for an OpenF1 session: the circuit's own name first, then the
 *  2026 calendar by DATE (SeasonCal.REAL_2026 windows — a GP that moved venue,
 *  like the Bahrain GP run at Sepang, is named for its GP country but sits on
 *  the circuit the calendar gives it), then the venue aliases below (the Tracks
 *  handoff), then the country's current-season circuit, else any of that
 *  country, else null. F1API.placeLabel owns the display country.
 *  `calendar` stands in for f1-game's global SeasonCal.REAL_2026 (null: not loaded). */
export function trackIdFor(session: OpenF1Session, tracks: readonly TrackInfo[] | null | undefined, calendar?: readonly CalendarWindow[] | null): string | null {
  const list = arr(tracks);
  const country = String(session.country_name || session.country || "").toLowerCase();
  const circuit = String(session.circuit_short_name || session.circuit || "").toLowerCase();
  const norm = (s: unknown): string => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!list.length) return null;
  // Circuit first: a country with two circuits (Italy: Monza + Imola; USA: Miami/Austin/Vegas) tells them apart by name.
  const byCircuit = list.find((t) => circuit && (norm(t.id) === norm(circuit) || norm(t.name) === norm(circuit)));
  if (byCircuit) return byCircuit.id;
  const day = localDay(session);
  const win = day && calendar
    ? calendar.find((r) => day >= r.from && day <= r.to && list.some((t) => t.id === r.id)) : null;
  if (win) return win.id;
  const alias: Readonly<Record<string, string>> = { "kuala lumpur": "sepang", "monte carlo": "monaco", "sakhir": "bahrain", "melbourne": "albert_park", "spielberg": "redbull", "austin": "cota",
                  "mexico city": "mexico", "yas marina": "abudhabi", "lusail": "qatar", "las vegas": "vegas", "spa-francorchamps": "spa",
                  "marina bay": "singapore", "budapest": "hungaroring", "montreal": "montreal", "imola": "imola", "barcelona": "catalunya" };
  const aliased = Object.prototype.hasOwnProperty.call(alias, circuit) ? alias[circuit] : undefined;
  if (aliased && list.some((t) => t.id === aliased)) return aliased;
  const same = list.filter((t) => String(t.country || "").toLowerCase() === country || (country === "united states" && t.country === "USA") || (country === "united kingdom" && t.country === "UK") || (country === "united arab emirates" && t.country === "UAE"));
  const current = same.find((t) => !t.classic);
  return (current || same[0])?.id || null;
}

/** Time of day from the session's local start hour (date_start + gmt_offset). */
export function todFor(session: OpenF1Session): TimeOfDay {
  const iso = session.date_start || session.dateStart;
  const t = Date.parse(iso || "");
  if (!isFinite(t)) return "default";
  const off = String(session.gmt_offset || "00:00:00").split(":");
  const sign = off[0]!.trim().startsWith("-") ? -1 : 1;
  const h = (new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60 + sign * (Math.abs(Number(off[0])) + (Number(off[1]) || 0) / 60) + 24) % 24;
  if (h < 7) return "dawn";
  if (h < 17) return "day";
  if (h < 19.5) return "dusk";
  return "night";
}

/** The race's weather chip from the session's rainfall samples. */
export function weatherFor(weatherRows: Rows<OpenF1Weather>): WeatherChip {
  const rows = arr(weatherRows);
  if (!rows.length) return "dry";
  const wet = rows.filter((w) => { const r = w && num(w.rainfall); return r != null && r > 0; }).length;
  if (!wet) return "dry";
  return wet / rows.length > 0.5 ? "rain" : "wet";
}

type Secs = (iso: StrLike) => number | null;

/** Safety-car / VSC / red windows from the race-control feed, on the leader's lap. */
export function cautionsFor(raceControl: Rows<OpenF1RaceControl>, secs?: Secs | null): Caution[] {
  const out: Caution[] = [];
  let open: Caution | null = null, ending = false;
  const at = (m: OpenF1RaceControl | null): number | null => (secs ? secs(m && m.date) : null);
  for (const m of arr(raceControl)) {
    const msg = String(m && m.message || "").toUpperCase();
    const lap = num(m && m.lap_number);
    if (lap == null) continue;
    const vsc = msg.indexOf("VIRTUAL SAFETY CAR") >= 0;
    const sc = !vsc && msg.indexOf("SAFETY CAR") >= 0;
    if (msg.indexOf("RED FLAG") >= 0 && (m!.flag === "RED" || msg.indexOf("RED FLAG") === 0)) {
      if (open) { if (!ending) open.to = lap; if (secs) open.tTo = at(m); out.push(open); open = null; }
      const red: Caution = { level: 4, from: lap, to: lap, cause: "RED FLAG" };
      if (secs) { red.tFrom = at(m); red.tTo = null; }
      out.push(red);
      continue;
    }
    if ((vsc || sc) && msg.indexOf("DEPLOYED") >= 0) {
      if (open) { if (!ending) open.to = lap; if (secs) open.tTo = at(m); out.push(open); }
      ending = false;
      open = { level: vsc ? 2 : 3, from: lap, to: lap, cause: vsc ? "VSC" : "SAFETY CAR" };
      if (secs) { open.tFrom = at(m); open.tTo = null; }
    } else if (open && (vsc || sc) && (msg.indexOf("IN THIS LAP") >= 0 || msg.indexOf("ENDING") >= 0)) {
      ending = true; open.to = Math.max(open.from, lap); if (secs) open.tEnding = at(m);
    } else if (open && msg.indexOf("TRACK CLEAR") >= 0) {
      if (!ending) open.to = Math.max(open.from, lap);
      if (secs) open.tTo = at(m); out.push(open); open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

/** The grid: each driver's FIRST position snapshot of the race session (taken on the grid, before the start). */
export function gridFor(positions: Rows<OpenF1Position>): Record<number, number> {
  const first: Record<string, { date: string; pos: number }> = {};
  for (const p of arr(positions)) {
    const n = num(p && p.driver_number), pos = num(p && p.position);
    if (n == null || pos == null) continue;
    const d = String(p!.date || "");
    const prev = first[n];
    if (!(n in first) || d < prev!.date) first[n] = { date: d, pos };
  }
  const out: Record<string, number> = {};
  for (const n in first) out[n] = first[n]!.pos;
  return out;
}

/**
 * raw = { session, drivers, laps, stints, pits, raceControl, weather, result, positions }
 * (each an OpenF1 body, `session` one /sessions row). `findTeam(name)` maps
 * an OpenF1 team name to a roster team (js/data/hub.js). `tracks` is Tracks.LIST.
 * `calendar` is SeasonCal.REAL_2026 (apex-26: injected; null = not loaded).
 */
export function build(raw: RawRace, findTeam: FindTeam | null | undefined, tracks: readonly TrackInfo[] | null | undefined, calendar?: readonly CalendarWindow[] | null): RaceScript {
  const s: OpenF1Session = raw.session || {};
  const laps = arr(raw.laps);
  let totalLaps = 0;
  for (const l of laps) { const n = lapNo(l && l.lap_number); if (n !== null && n > totalLaps) totalLaps = n; }
  for (const r of arr(raw.result)) { const n = lapNo(r && r.number_of_laps); if (n !== null && n > totalLaps) totalLaps = n; }
  const grid = gridFor(raw.positions);
  const byNum: Record<number, ScriptDriver> = {};
  const driverOf = (v: unknown): ScriptDriver | undefined => { const n = num(v); return n == null ? undefined : byNum[n]; };
  for (const d of arr(raw.drivers)) {
    const n = num(d && d.driver_number);
    if (n == null || byNum[n]) continue;
    const team = findTeam ? findTeam(d!.team_name) : null;
    byNum[n] = { num: n, code: String(d!.name_acronym || "").toUpperCase().slice(0, 3), name: String(d!.full_name || d!.broadcast_name || ""),
                 team: String(d!.team_name || ""), teamId: team ? team.id : null, grid: grid[n] || null,
                 pos: null, lapsDone: 0, dnf: false, laps: new Array<number | null>(totalLaps).fill(null), stints: [], pits: [],
                 lapStart: [] };
  }
  for (const l of laps) {
    const d = driverOf(l && l.driver_number);
    const n = lapNo(l && l.lap_number);
    if (!d || !(n !== null && n >= 1) || n > totalLaps) continue;
    d.laps[n - 1] = num(l!.lap_duration);
  }
  for (const st of arr(raw.stints)) {
    const d = driverOf(st && st.driver_number);
    if (!d) continue;
    d.stints.push({ c: String(st!.compound || "").toUpperCase(), from: num(st!.lap_start) || 1, to: num(st!.lap_end) || totalLaps, age: num(st!.tyre_age_at_start) || 0 });
  }
  // Lights out: the earliest first-lap start in the field (a driver's lap 1 begins as the lights go out).
  let t0 = NaN;
  for (const l of laps) { if (num(l && l.lap_number) === 1) { const t = Date.parse(l!.date_start || ""); if (isFinite(t) && !(t >= t0)) t0 = t; } }
  if (!isFinite(t0)) t0 = Date.parse(s.date_start || "") || 0;
  const secs: Secs = (iso) => { const t = Date.parse(iso || ""); return isFinite(t) ? Math.round((t - t0) / 1000 * 1000) / 1000 : null; };
  for (const d of Object.values(byNum)) d.lapStart = new Array<number | null>(totalLaps).fill(null);
  for (const l of laps) {
    const d = driverOf(l && l.driver_number);
    const n = lapNo(l && l.lap_number);
    if (d && n !== null && n >= 1 && n <= totalLaps) d.lapStart[n - 1] = secs(l!.date_start);
  }
  for (const p of arr(raw.pits)) {
    const d = driverOf(p && p.driver_number);
    const lap = num(p && p.lap_number);
    if (d && lap != null) { d.pits.push(lap); (d.pitT = d.pitT || []).push(secs(p!.date)); (d.pitDur = d.pitDur || []).push(num(p!.lane_duration ?? p!.pit_duration)); }
  }
  for (const r of arr(raw.result)) {
    const d = driverOf(r && r.driver_number);
    if (!d) continue;
    d.pos = num(r!.position);
    d.lapsDone = lapNo(r!.number_of_laps) || 0;
    d.dnf = !!(r!.dnf || r!.dns || r!.dsq) || d.pos == null;
    d.dsq = !!r!.dsq; d.dns = !!r!.dns;
  }
  const drivers = Object.values(byNum);
  for (const d of drivers) {
    d.stints.sort((a, b) => a.from - b.from);
    if (d.pitT) {
      const pits = d.pits, pitT = d.pitT, pitDur = d.pitDur || [];
      const idx = pits.map((_, i) => i).sort((a, b) => pits[a]! - pits[b]!);
      d.pits = idx.map((i) => pits[i]!); d.pitT = idx.map((i) => pitT[i]!); d.pitDur = idx.map((i) => pitDur[i]!);
    }
    else d.pits.sort((a, b) => a - b);
    if (!d.lapsDone) d.lapsDone = d.laps.filter((t) => t != null && t > 0).length;
    // Where and when the car went out: the incident row naming it on the lap it stopped, else the end of its last timed lap.
    if (d.dnf && !d.dns && !d.dsq) {
      const inc = incidentFor(raw.raceControl, d, (d.lapsDone | 0) + 1);
      d.outWhere = inc ? inc.where : null;
      // WHEN: the start of the lap it did not finish (the stewards' note is dated when it was posted, laps later).
      const here = d.lapStart[d.lapsDone], prevStart = d.lapStart[d.lapsDone - 1], prevLap = d.laps[d.lapsDone - 1];
      d.outT = here != null ? here : (prevStart != null && prevLap != null && prevLap > 0 ? prevStart + prevLap : null);
    }
  }
  // The race's fastest lap.
  let fastest: Fastest | null = null as Fastest | null;
  for (const d of drivers) d.laps.forEach((t, i) => { if (t != null && t > 0 && (!fastest || t < fastest.dur)) { const ls = d.lapStart[i]; fastest = { num: d.num, lap: i + 1, dur: t, t: ls != null ? ls + t : null }; } });
  // Grid order first (a driver with no snapshot goes to the back, by number), so the table reads like the grid.
  drivers.sort((a, b) => (a.grid || 99) - (b.grid || 99) || a.num - b.num);
  // COMPLETE means a classification with a winner and every driver's laps in:
  // a race still running (or one OpenF1 has not finished publishing) builds,
  // and can be played, but is never cached — the next open fetches it again.
  const complete = totalLaps > 0 && drivers.some((d) => d.pos === 1 && d.lapsDone === totalLaps && d.laps.some((t) => t != null && t > 0)) && drivers.every((d) => {
    const result = arr(raw.result).find((r) => r && num(r.driver_number) === d.num);
    if (!result) return false;
    if (d.dns) return d.lapsDone === 0;
    // Only an explicitly published untimed opening lap is exempt, not a missing
    // feed row. Retirees need only their classified distance, including zero.
    const done = num(result.number_of_laps);
    if (done === null || !Number.isInteger(done) || done < 0 || done > totalLaps) return false;
    for (let n = 1; n <= done; n++) {
      if (!laps.some((l) => {
        if (!(l && num(l.driver_number) === d.num && lapNo(l.lap_number) === n)) return false;
        const dur = num(l.lap_duration);
        return (dur != null && dur > 0) || (n === 1 && l.lap_duration === null);
      })) return false;
    }
    return true;
  });
  return {
    v: SCRIPT_V, source: "openf1", fetchedAt: new Date().toISOString(),
    sessionKey: num(s.session_key), meetingKey: num(s.meeting_key), year: num(s.year),
    name: String(s.meeting_name || s.name || ((s.country_name || "") + " Grand Prix")).trim(),
    session: String(s.session_name || "Race"),
    circuit: String(s.circuit_short_name || ""), country: String(s.country_name || ""),
    trackId: trackIdFor(s, tracks, calendar), dateStart: String(s.date_start || ""),
    tod: todFor(s), weather: weatherFor(raw.weather), rain: rainByLap(laps, raw.weather, totalLaps),
    laps: totalLaps, drivers, cautions: cautionsFor(raw.raceControl, secs), passes: passesFor(raw.overtakes, laps, totalLaps, drivers, secs), complete,
    t0: t0 || null, fastest,
    radio: arr(raw.teamRadio).map((r) => ({ t: secs(r && r.date), num: num(r && r.driver_number), url: String(r && r.recording_url || "") }))
      .filter((r): r is { t: number; num: number; url: string } => r.t != null && r.t >= -60 && r.num != null && /^https:\/\//.test(r.url))   // t >= -60: the pre-race chatter is not the race
      .map((r) => { const d = byNum[r.num]; let lap = 0; if (d) d.lapStart.forEach((ls, i) => { if (ls != null && ls <= r.t) lap = i + 1; }); return { t: r.t, num: r.num, lap, url: r.url }; }),
    incidents: incidentsFor(raw.raceControl, secs),
  };
}

/** The race-control row that names a driver's retirement on the lap it happened (or the next): {where: "TURN 1", t}. */
export function incidentFor(raceControl: Rows<OpenF1RaceControl>, d: Pick<ScriptDriver, "code" | "num">, lap: number): { where: string | null; t: string | null } | null {
  for (const m of arr(raceControl)) {
    const msg = String(m && m.message || "").toUpperCase();
    const ml = num(m && m.lap_number);
    if (ml == null || ml < lap || ml > lap + 4 || msg.indexOf("INCIDENT") < 0) continue;   // the stewards note it a few laps on
    if (msg.indexOf("(" + d.code + ")") < 0 && !new RegExp("CARS? [^A-Z]*\\b" + d.num + "\\b").test(msg)) continue;
    const turn = /TURN (\d+)/.exec(msg);
    return { where: turn ? "TURN " + turn[1] : null, t: m!.date || null };
  }
  return null;
}
/** Race control's story beyond the flags: incidents, penalties, lapped cars released, marshals — [{lap, t, text}]. */
export function incidentsFor(raceControl: Rows<OpenF1RaceControl>, secs?: Secs | null): Incident[] {
  const out: Incident[] = [];
  for (const m of arr(raceControl)) {
    const msg = String(m && m.message || "");
    const lap = num(m && m.lap_number);
    if (lap == null || !/INCIDENT|LAPPED CARS|MARSHALS|DELETED|PENALTY|OVERTAKE (ENABLED|DISABLED)/i.test(msg)) continue;
    const t = secs ? secs(m!.date) : null;
    if (t != null && t < -60) continue;   // the pre-race notes (practice-start infringements) are not the race
    out.push({ lap, t, text: msg.replace(/\s+/g, " ").trim().slice(0, 140) });
  }
  return out;
}

/** Every pass, on the lap the overtaking car was on: [{lap, by, over, pos}] —
 *  OpenF1's /overtakes rows dated against that driver's lap start times. */
export function passesFor(overtakes: Rows<OpenF1Overtake>, laps: Rows<OpenF1Lap>, totalLaps: number,
                          drivers: readonly (Pick<ScriptDriver, "num" | "dnf" | "lapsDone" | "laps"> & { dns?: boolean; dsq?: boolean } | null)[] | null | undefined,
                          secs?: Secs | null): Pass[] {
  // A car that stopped on lap L is "passed" by the whole field as it drops
  // down the order (the feed logged 24 passes on Norris and Gasly the lap
  // they retired at Baku 2026): a pass on either side of a retiring car is
  // the retirement, not an overtake.
  const ends: Record<number, number> = {};   // num -> the lap the car's race ended on (dnf only)
  for (const d of arr(drivers)) if (d && d.dnf && !d.dns && !d.dsq && d.num != null) ends[d.num] = (d.lapsDone | 0) + 1;
  const starts: Record<number, number[]> = {};   // num -> [lap start ms by lap]
  for (const l of arr(laps)) {
    const n = num(l && l.driver_number), k = lapNo(l && l.lap_number), t = Date.parse(l && l.date_start || "");   // a 1e9 index would make lapOf walk 1e9 slots
    if (n == null || !(k !== null && k >= 1) || !isFinite(t)) continue;
    (starts[n] = starts[n] || [])[k] = t;
  }
  const lapOf = (n: number, t: number): number => {
    const row = starts[n];
    let lap = 0;
    if (row) for (let k = 1; k < row.length; k++) { const v = row[k]; if (v != null && v <= t && k > lap) lap = k; }
    return lap;
  };
  const out: Pass[] = [];
  for (const o of arr(overtakes)) {
    const by = num(o && o.overtaking_driver_number), over = num(o && o.overtaken_driver_number), pos = num(o && o.position);
    const t = Date.parse(o && o.date || "");
    if (by == null || over == null || !isFinite(t)) continue;
    const lap = lapOf(by, t) || lapOf(over, t) || 1;
    if (lap > totalLaps) continue;
    const endBy = ends[by], endOver = ends[over];
    if ((endBy !== undefined && endBy <= lap) || (endOver !== undefined && endOver <= lap)) continue;
    const p: Pass = { lap, by, over, pos };
    if (secs) { p.t = secs(o!.date); const st = starts[by] && starts[by][lap]; const dur = (drivers || []).find((d) => d && d.num === by); const ld = dur && dur.laps ? dur.laps[lap - 1] : null; if (st != null && ld != null && ld > 0) p.frac = Math.max(0, Math.min(0.999, (t - st) / 1000 / ld)); }
    out.push(p);
  }
  out.sort((a, b) => (a.t != null && b.t != null ? a.t - b.t : a.lap - b.lap));
  return out;
}

// ── The race book (pure): the order at every lap, and what each lap held ──

/** A car on the lap board: running (`out: false`) or already stopped (`out: true`). */
export interface RunningRow {
  num: number; code: string; down: number; t: number | null; cum: number;
  pitIn: boolean; pitOut: boolean; tyre: string | null; out: false;
  approximate: boolean; pos: number; gapApproximate: boolean; intervalApproximate: boolean;
  gap: number | null; interval: number | null;
}
export interface StoppedRow {
  num: number; code: string; t: null; cum: null; done: number;
  pitIn: false; pitOut: false; tyre: string | null; out: true;
  pos: number; gap: null; interval: null;
}
export type BoardRow = RunningRow | StoppedRow;

/** The classification at the end of real lap L, from the crossing times:
 *  [{num, t (lap time), cum, gap, interval, down, pitIn, pitOut, out}] fastest
 *  crossing first, then the cars that had stopped by then (last lap first).
 *  `cumTable` is RealRace.cumTable (the race lane's; f1-game read the global). */
export function lapBoard(script: RaceScript, lap: number, cumTable?: CumTableFn | null): BoardRow[] {
  const cum = cumTable ? cumTable(script) : null;
  if (!cum) return [];
  type Running = Omit<RunningRow, "approximate" | "pos" | "gapApproximate" | "intervalApproximate" | "gap" | "interval"> & Partial<RunningRow>;
  type Stopped = Omit<StoppedRow, "pos" | "gap" | "interval"> & Partial<StoppedRow>;
  const running: Running[] = [], stopped: Stopped[] = [];
  const confidence = timingConfidence(script, cum);
  for (const d of script.drivers || []) {
    const row = cum[d.num]!;
    const pits = d.pits || [];
    // A classified finisher a lap or more down never reaches the later laps' crossings: its row ends at its own last
    // lap. It is still RUNNING, `down` laps behind, not out (only a retirement stops).
    const done = row.length - 1, down = !d.dnf && !d.dns && done >= 1 && done < lap ? lap - done : 0;
    const lt = d.laps[lap - 1];
    if (row.length > lap || down) running.push({ num: d.num, code: d.code, down, t: lt != null && lt > 0 ? lt : null, cum: row[Math.min(lap, done)]!, pitIn: pits.indexOf(lap) >= 0, pitOut: pits.indexOf(lap - 1) >= 0, tyre: compoundAt(d, lap), out: false });
    else stopped.push({ num: d.num, code: d.code, t: null, cum: null, done: row.length - 1, pitIn: false, pitOut: false, tyre: compoundAt(d, row.length - 1), out: true });
  }
  for (const r of running) r.approximate = !!(confidence[r.num] && confidence[r.num]![Math.min(lap, cum[r.num]!.length - 1)]);
  running.sort((a, b) => a.down - b.down || a.cum - b.cum);
  stopped.sort((a, b) => b.done - a.done);
  const lead = running.length ? running[0]!.cum : 0;
  running.forEach((r, i) => {
    r.pos = i + 1;
    r.gapApproximate = r.approximate || !!(running[0] && running[0].approximate);
    r.intervalApproximate = r.approximate || !!(i && running[i - 1]!.approximate);
    r.gap = r.down ? null : +(r.cum - lead).toFixed(3);   // a lap down is not a time gap: the board says "+N LAP"
    r.interval = r.down ? null : i ? +(r.cum - running[i - 1]!.cum).toFixed(3) : 0;
  });
  stopped.forEach((r, i) => { r.pos = running.length + i + 1; r.gap = null; r.interval = null; });
  return (running as RunningRow[] as BoardRow[]).concat(stopped as StoppedRow[]);
}
// Display-only provenance; the cumulative times and simulator remain unchanged.
export function timingConfidence(script: Pick<RaceScript, "drivers">, cum: CumTable): Record<number, boolean[]> {
  const out: Record<number, boolean[]> = {};
  for (const d of script.drivers || []) {
    const row = cum[d.num] || []; let filled = false;
    out[d.num] = row.map((_, i) => { const v = (d.laps || [])[i - 1]; if (i && !(v != null && v > 0)) filled = true; return filled; });
  }
  return out;
}
function compoundAt(d: Pick<ScriptDriver, "stints">, lap: number): string | null {
  let c: string | null = null;
  for (const st of d.stints || []) if (st.from <= lap) c = st.c;
  return c ? c[0] ?? null : null;
}

export type PitDuel =
  | { available: false; reason: string; startLap: number }
  | { available: true; before: number; after: number; startLap: number; gapBefore: number; gapAfter: number; change: number;
      compounds: string[]; caution: boolean; rain: boolean | null };

/** Observed crossings only: never use cumTable's median-filled laps here. */
export function pitDuel(script: RaceScript, aNum: number | string | undefined, aStop: number | string | undefined, bNum: number | string | undefined, bStop: number | string | undefined): PitDuel {
  const a = script.drivers.find((d) => d.num === Number(aNum)), b = script.drivers.find((d) => d.num === Number(bNum));
  const before = Math.min(Number(aStop), Number(bStop)) - 1, after = Math.max(Number(aStop), Number(bStop)) + 1;
  const unavailable = (reason: string): PitDuel => ({ available: false, reason, startLap: Math.max(1, before) });
  if (!a || !b || a === b || !(a.pits || []).includes(Number(aStop)) || !(b.pits || []).includes(Number(bStop))) return unavailable("Choose two drivers and one stop each.");
  if (before < 1 || after > script.laps || a.dnf || b.dnf || a.dns || b.dns || a.lapsDone < after || b.lapsDone < after) return unavailable("Unavailable for retirement, lap-down or incomplete timing.");
  const crossing = (d: ScriptDriver, lap: number): number | null => {
    const start = (d.lapStart || [])[lap - 1], duration = (d.laps || [])[lap - 1];
    return typeof start === "number" && isFinite(start) && typeof duration === "number" && isFinite(duration) && duration > 0 ? start + duration : null;
  };
  // Every selected lap must be present; a missing intermediate sample can hide a lap-down interval.
  for (let lap = before; lap <= after; lap++) {
    const x = crossing(a, lap), y = crossing(b, lap);
    if (x === null || y === null) return unavailable("Unavailable: missing real lap crossings.");
    if (Math.abs(x - y) >= Math.min(a.laps[lap - 1]!, b.laps[lap - 1]!)) return unavailable("Unavailable: possible lap-down mismatch.");
  }
  const gapBefore = crossing(a, before)! - crossing(b, before)!, gapAfter = crossing(a, after)! - crossing(b, after)!;
  return { available: true, before, after, startLap: before, gapBefore, gapAfter, change: gapAfter - gapBefore,
    compounds: [a, b].map((d) => (compoundAt(d, before) || "—") + " → " + (compoundAt(d, after) || "—")),
    caution: (script.cautions || []).some((c) => c.from <= after && (c.to || c.from) >= before),
    rain: script.rain ? script.rain.slice(before, after + 1).some(Boolean) : null };
}

/** One race's real positions: per car a Float32Array [t, x, y, …] (t seconds from t0, x/y metres). */
export interface Traces {
  v: number;
  sessionKey: Key | null;
  t0: number;
  hz: number;
  /** traceCoverage(script) at download; legacy records lack it and are refetched. */
  coverage?: string;
  complete?: boolean;
  cars: Record<string, Float32Array>;
  /** Driver numbers whose request failed or came back unusable (retryable). */
  failed?: number[];
}

export interface TraceDetail {
  num: number; code: string; dns: boolean; retired: boolean; count: number;
  start: number | null; end: number | null; gaps: [number, number][]; retry: boolean;
}

/** Download facts, separate from sporting retirement and cache identity. */
export function traceDetails(script: RaceScript, traces: Traces | null | undefined): TraceDetail[] {
  return script.drivers.map((d) => {
    const raw = traces && traces.cars && traces.cars[d.num], count = raw ? Math.floor(raw.length / 3) : 0;
    const gaps: [number, number][] = [];
    for (let i = 3; i < count * 3; i += 3) if (raw![i]! - raw![i - 3]! > 3) gaps.push([raw![i - 3]!, raw![i]!]);
    return { num: d.num, code: d.code, dns: !!d.dns, retired: !!d.dnf && !d.dns, count,
      start: count ? raw![0]! : null, end: count ? raw![(count - 1) * 3]! : null, gaps,
      retry: !!(traces && (traces.failed || []).includes(d.num)) };
  });
}

export interface BookLap {
  lap: number; leader: string; flag: "" | "RED FLAG" | "SAFETY CAR" | "VSC"; rain: boolean;
  passes: { by: string; over: string; pos: number | null }[];
  pits: string[]; out: string[]; fastest: { code: string; t: number } | null;
}

/** One entry per real lap: who led, the passes, the stops, who went out, the
 *  flag flying, the rain, the lap's fastest. The picker and the lap list read it. */
export function raceBook(script: RaceScript, cumTable?: CumTableFn | null): BookLap[] {
  const laps = script.laps | 0;
  const byNum: Record<number, ScriptDriver> = {};
  for (const d of script.drivers || []) byNum[d.num] = d;
  const code = (n: number): string => { const d = byNum[n]; return d ? d.code : String(n); };
  const book: BookLap[] = [];
  for (let lap = 1; lap <= laps; lap++) {
    const board = lapBoard(script, lap, cumTable);
    const lead = board.find((r) => !r.out);
    const flags = (script.cautions || []).filter((w) => lap >= w.from && lap <= (w.to != null ? w.to : w.from));
    const flag = flags.some((w) => w.level >= 4) ? "RED FLAG" : flags.some((w) => w.level === 3) ? "SAFETY CAR" : flags.some((w) => w.level === 2) ? "VSC" : "";
    let fastest: BoardRow | null = null as BoardRow | null;
    for (const r of board) if (r.t != null && (!fastest || r.t < fastest.t!)) fastest = r;
    book.push({
      lap, leader: lead ? lead.code : "", flag,
      rain: !!(Array.isArray(script.rain) && script.rain[lap]),
      passes: (script.passes || []).filter((p) => p.lap === lap).map((p) => ({ by: code(p.by), over: code(p.over), pos: p.pos })),
      pits: board.filter((r) => r.pitIn).map((r) => r.code),
      out: (script.drivers || []).filter((d) => d.dnf && !d.dns && !d.dsq && (d.lapsDone | 0) + 1 === lap && (d.lapsDone | 0) < laps).map((d) => d.code),
      fastest: fastest ? { code: fastest.code, t: fastest.t! } : null,
    });
  }
  return book;
}

/** A lap time as m:ss.sss ("—" when not a positive number). This file's own format, not dom.ts fmtLap. */
export function fmtLap(t: number | null | undefined): string {
  if (!(t != null && t > 0)) return "—";
  const ms = Math.round(t * 1000), m = Math.floor(ms / 60000), sec = (ms - m * 60000) / 1000;   // round first: never "1:60.000"
  return m + ":" + (sec < 10 ? "0" : "") + sec.toFixed(3);
}
export function fmtGap(v: number | null | undefined): string { return v == null ? "—" : v === 0 ? "" : "+" + v.toFixed(3); }

/** Rain lap by lap (index = real lap, true when any weather sample inside that
 *  lap's window — the leader's lap start to the next — reports rainfall), or
 *  null when the lap rows carry no timestamps to align the samples to. */
export function rainByLap(laps: Rows<OpenF1Lap>, weatherRows: Rows<OpenF1Weather>, totalLaps: number): boolean[] | null {
  const starts = new Array<number>(totalLaps + 2).fill(Infinity);
  let any = false;
  for (const l of arr(laps)) {
    const n = num(l && l.lap_number), t = Date.parse(l && l.date_start || "");
    if (n !== null && n >= 1 && n <= totalLaps && isFinite(t) && t < starts[n]!) { starts[n] = t; any = true; }
  }
  if (!any) return null;
  for (let n = 2; n <= totalLaps; n++) if (!isFinite(starts[n]!)) starts[n] = starts[n - 1]!;   // a lap nobody timed inherits the previous start
  const out = new Array<boolean>(totalLaps + 1).fill(false);
  for (const w of arr(weatherRows)) {
    const rf = w && num(w.rainfall);
    if (!(rf != null && rf > 0)) continue;
    const t = Date.parse(w!.date || "");
    if (!isFinite(t)) continue;
    for (let n = 1; n <= totalLaps; n++) {
      const end = n < totalLaps && isFinite(starts[n + 1]!) ? starts[n + 1]! : Infinity;
      if (t >= starts[n]! && t < end) { out[n] = true; break; }
    }
  }
  return out;
}

// ── The real positions (pure parts) ─────────────────────────────────────────

/** One /location row as packTrace reads it (api.ts LocationSample, date epoch ms). */
export interface TraceRow { date?: number | null; x?: number | null; y?: number | null }

/** One car's /location rows → Float32Array [t, x, y, …] at TRACE_HZ (t seconds from t0, x/y metres). */
export function packTrace(rows: readonly (TraceRow | null)[] | null | undefined, t0: number): Float32Array {
  const out: number[] = [];
  let last = -Infinity;
  const gap = 1000 / TRACE_HZ - 50;
  const valid = arr(rows).filter((r): r is TraceRow & { date: number; x: number; y: number } => !!r && r.date != null && isFinite(Number(r.date)) &&
    typeof r.x === "number" && typeof r.y === "number" && isFinite(r.x) && isFinite(r.y));
  for (const r of valid.sort((a, b) => a.date - b.date)) {
    const t = r && r.date != null ? Number(r.date) : NaN;
    if (!isFinite(t) || t - last < gap || !(isFinite(r.x) && isFinite(r.y))) continue;
    last = t;
    out.push((t - t0) / 1000, r.x / 10, r.y / 10);
  }
  return Float32Array.from(out);
}
export function traceEnd(script: Pick<RaceScript, "drivers">): number {
  let end = 0;
  for (const d of script.drivers) arr(d.lapStart).forEach((ls, i) => { const lt = d.laps[i]; if (ls != null && lt != null && lt > 0) end = Math.max(end, ls + lt); });
  return end;
}
// Session identity alone is not coverage: timing can grow after a successful
// download. Include its clock, window, roster and completion state; legacy
// entries without this stamp must be fetched again rather than trusted.
export function traceCoverage(script: Pick<RaceScript, "drivers" | "t0" | "complete">): string {
  return JSON.stringify([script.t0, traceEnd(script), script.complete === true,
    script.drivers.map((d) => [d.num, !!d.dns, d.lapsDone || 0] as [number, boolean, number]).sort((a, b) => a[0] - b[0])]);
}
export function traceFits(traces: Traces | null | undefined, script: RaceScript): boolean {
  return !!(traces && traces.v === TRACE_V && traces.sessionKey === script.sessionKey &&
    traces.coverage === traceCoverage(script) && (!traces.complete || script.drivers.every((d) => d.dns || usableTrace(traces.cars && traces.cars[d.num], d))));
}
export function usableTrace(car: Float32Array | null | undefined, driver: Pick<ScriptDriver, "lapStart" | "laps">): boolean {
  let start = Infinity, end = 0;
  arr(driver.lapStart).forEach((ls, i) => {
    if (ls != null && Number.isFinite(ls)) {
      start = Math.min(start, ls);
      const lt = driver.laps[i];
      if (lt != null && lt > 0) end = Math.max(end, ls + lt);
    }
  });
  const minimum = Math.max(2, Math.min(102, Math.floor(end * TRACE_HZ / 2))) * 3;
  if (!car || car.length < minimum || car.length % 3 || !isFinite(start)) return false;
  for (let i = 0; i < car.length; i += 3) {
    if (!Number.isFinite(car[i]) || !Number.isFinite(car[i + 1]) || !Number.isFinite(car[i + 2]) || (i && car[i]! <= car[i - 3]!)) return false;
  }
  // Allow positioning dropouts around the line, but a dense minute of a long
  // race is not full coverage. Retirements use their own last timed lap.
  return car[0]! <= start + 5 && car[car.length - 3]! >= end - 5;
}
