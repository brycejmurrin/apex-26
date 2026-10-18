/**
 * F1 API: Jolpica + OpenF1 endpoint mapping and session cache policy. Ported
 * from f1-game js/data/api.js:1-542; the network lifecycle is the transport's
 * (./transport.ts).
 *
 * Endpoints and fields checked against the providers' docs on 2026-10-18:
 * - OpenF1 https://openf1.org/docs/ (base https://api.openf1.org/v1): /pit's
 *   `pit_duration` is deprecated for `lane_duration` and goes at the end of
 *   2026, so `lane_duration` is read first; /meetings carries `is_cancelled`;
 *   date filters are `date>=…` / `date<=…` query terms.
 * - Jolpica https://github.com/jolpica/jolpica-f1 (Ergast-compatible, base
 *   https://api.jolpi.ca/ergast/f1): `/{season}.json`,
 *   `/{season}/driverstandings.json`, `/{season}/constructorstandings.json`.
 */
import { createTransport, isRecord, type Transport, type TransportDeps } from "./transport";

export const JOLPICA = "https://api.jolpi.ca/ergast/f1";
export const OPENF1 = "https://api.openf1.org/v1";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
export const TTL_SCHEDULE = 24 * HOUR;
export const TTL_STANDINGS = HOUR;
export const TTL_LATEST = 10 * MINUTE;
export const TTL_HISTORIC = 7 * 24 * HOUR;
const SESSION_FROZEN_MS = 6 * HOUR;

export interface SessionTime { date: string; time: string }
export type ScheduleSessionKey = "fp1" | "fp2" | "fp3" | "sq" | "s" | "q" | "r";

export interface ScheduleRace {
  round: number | null;
  name: string | null;
  circuit: string | null;
  locality: string | null;
  country: string | null;
  date: string | null;
  time: string | null;
  hasSprint: boolean;
  sessions: Partial<Record<ScheduleSessionKey, SessionTime>>;
}

export interface DriverStanding {
  pos: number | null; points: number; wins: number;
  name: string | null; code: string | null; number: number | null; team: string | null;
}
export interface ConstructorStanding { pos: number | null; points: number; wins: number; name: string | null }

/** OpenF1 session/meeting keys are numbers on the wire; f1-game passes them through as-is. */
export type Key = number | string;

export interface Session {
  sessionKey: Key | null; meetingKey: Key | null; year: number | null;
  name: string | null; type: string | null; circuit: string | null;
  country: string | null; dateStart: string | null;
}
export interface Meeting {
  meetingKey: Key | null; name: string | null; country: string | null;
  circuit: string | null; dateStart: string | null; cancelled: boolean;
}
export interface Weather {
  airT: number | null; trackT: number | null; humidity: number | null;
  rainfall: number | null; windSpeed: number | null;
}
export interface PositionValue { num: number | null; pos: number | null }
/** A gap in seconds, or a lapped label such as "+1 LAP" (api.js:282-292). */
export type Gap = number | string | null;
export interface Delta<V> { values: V; cursor: string | null }
export interface SessionDriver {
  num: number | null; code: string | null; name: string | null;
  team: string | null; color: string | null;
}
/** Number for practice/sprint/race, [Q1,Q2,Q3] for qualifying, a label for lapped finishers. */
export type Duration = number | string | (number | null)[] | null;
export interface SessionResultRow {
  pos: number | null; num: number | null; laps: number | null; points: number | null;
  dnf: boolean; dns: boolean; dsq: boolean; duration: Duration; gap: Duration;
}
export interface Lap {
  lapNumber: number | null; lapDuration: number | null;
  s1: number | null; s2: number | null; s3: number | null;
  i1Speed: number | null; i2Speed: number | null; stSpeed: number | null;
  isPitOut: boolean; dateStart: string | null;
}
export interface CarSample {
  speed: number | null; throttle: number | null; brake: number | null;
  gear: number | null; rpm: number | null; drs: number | null;
  /** Epoch ms. */ date: number;
  /** Seconds since the first sample. */ t: number;
}
export interface LocationSample { x: number; y: number; /** Epoch ms. */ date: number }
export interface Stint {
  num: number | null; compound: string | null; lapStart: number | null;
  lapEnd: number | null; age: number | null; stint: number | null;
}
export interface PitStop { num: number | null; lap: number | null; duration: number | null }

type Rec = Record<string, unknown>;
const EMPTY: Rec = Object.freeze({}) as Rec;

export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseFloat(v as string);
  return isFinite(n) ? n : null;
}
export function str(v: unknown): string | null { return (typeof v === "string" && v.length) ? v : null; }
function arr(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function rec(v: unknown): Rec { return isRecord(v) ? v : EMPTY; }

function jRaces(json: unknown): unknown[] {
  return arr(rec(rec(rec(json).MRData).RaceTable).Races);
}
function jStandingsList(json: unknown): Rec | null {
  const lists = rec(rec(rec(json).MRData).StandingsTable).StandingsLists;
  return (Array.isArray(lists) && isRecord(lists[0])) ? lists[0] : null;
}

function scheduleSessions(r: Rec): ScheduleRace["sessions"] {
  const out: ScheduleRace["sessions"] = {};
  const fields: [ScheduleSessionKey, string][] = [
    ["fp1", "FirstPractice"], ["fp2", "SecondPractice"], ["fp3", "ThirdPractice"],
    ["sq", r.SprintQualifying ? "SprintQualifying" : "SprintShootout"],
    ["s", "Sprint"], ["q", "Qualifying"],
  ];
  for (const [key, field] of fields) {
    const raw = rec(r[field]);
    const date = str(raw.date), time = str(raw.time);
    if (date && time) out[key] = { date, time };
  }
  const raceDate = str(r.date), raceTime = str(r.time);
  if (raceDate && raceTime) out.r = { date: raceDate, time: raceTime };
  return out;
}

// Both /position and /intervals stream one row per sample, not per driver:
// fold a list down to each driver_number's most recent row (api.js:233-247).
function latestByDriver(list: unknown[]): Map<string, Rec> {
  const latest = new Map<string, Rec>();
  for (const item of list) {
    if (!isRecord(item) || item.driver_number == null) continue;
    const k = String(item.driver_number);
    const prev = latest.get(k);
    if (!prev || String(item.date || "") >= String(prev.date || "")) latest.set(k, item);
  }
  return latest;
}
function byPos(x: PositionValue, y: PositionValue): number {
  return (x.pos === null ? 99 : x.pos) - (y.pos === null ? 99 : y.pos);
}
// f1-game iterates a plain object keyed by driver number, so integer keys come
// out in ascending order before the sort; keep that order.
function numericKeyOrder(m: Map<string, Rec>): [string, Rec][] {
  return [...m.entries()].sort((a, b) => {
    const ai = /^(0|[1-9]\d*)$/.test(a[0]), bi = /^(0|[1-9]\d*)$/.test(b[0]);
    if (ai && bi) return +a[0] - +b[0];
    return ai ? -1 : bi ? 1 : 0;
  });
}

export function positionValues(list: unknown[]): PositionValue[] {
  const out: PositionValue[] = [];
  for (const [, row] of numericKeyOrder(latestByDriver(list))) {
    out.push({ num: num(row.driver_number), pos: num(row.position) });
  }
  return out.sort(byPos);
}

// gap_to_leader IS NOT ALWAYS A NUMBER: OpenF1 sends "+1 LAP" for a lapped
// driver, and parseFloat reads that as 1 (api.js:282-292). Pass the label through.
export function gapValue(raw: unknown): Gap {
  return (typeof raw === "string" && /lap/i.test(raw)) ? raw.trim() : num(raw);
}

export function intervalValues(list: unknown[]): Record<string, Gap> {
  const out: Record<string, Gap> = {};
  for (const [k, row] of numericKeyOrder(latestByDriver(list))) out[k] = gapValue(row.gap_to_leader);
  return out;
}

function cursorOf(list: unknown[]): string | null {
  let cursor: string | null = null;
  for (const item of list) {
    const d = rec(item).date;
    if (typeof d === "string" && (!cursor || d > cursor)) cursor = d;
  }
  return cursor;
}

// `duration` and `gap_to_leader` change SHAPE with the session type (api.js:336-347).
function durVal(v: unknown): Duration {
  if (Array.isArray(v)) {
    return v.map((x: unknown) => (typeof x === "number" && isFinite(x)) ? x : null);
  }
  if (typeof v === "number" && isFinite(v)) return v;
  return str(v);
}

// Stable sort: the first valid row at a timestamp wins (api.js:470-476).
function orderedSamples<T extends { date: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.date - b.date).filter((row, i, all) => {
    return i === 0 || row.date !== (all[i - 1] as T).date;
  });
}

// OpenF1 meeting.country_name follows the GP title, not always the venue
// (2026 Bahrain Grand Prix: circuit_short_name "Kuala Lumpur") (api.js:504-517).
const VENUE_COUNTRY: Readonly<Record<string, string>> = Object.freeze({
  "kuala lumpur": "Malaysia",
  "sepang": "Malaysia",
});
export function placeLabel(circuit: unknown, country: unknown, sep?: string): string {
  const venue = str(circuit) || "";
  const nation = str(country) || "";
  const mapped = VENUE_COUNTRY[venue.toLowerCase()];
  const shown = mapped && nation && mapped.toLowerCase() !== nation.toLowerCase() ? mapped : nation;
  return [venue, shown].filter(Boolean).join(sep || ", ");
}

export interface F1Api {
  readonly transport: Transport;
  request: Transport["request"];
  cancelAll: Transport["cancelAll"];
  cacheEntryT: Transport["cacheEntryT"];
  staleMark: Transport["staleMark"];
  staleSince: Transport["staleSince"];
  forget: Transport["forget"];
  season(): string;
  schedule(year?: number | string): Promise<ScheduleRace[]>;
  driverStandings(year?: number | string | null): Promise<DriverStanding[]>;
  constructorStandings(year?: number | string | null): Promise<ConstructorStanding[]>;
  latestSession(ttl?: number | null): Promise<Session | null>;
  meetings(year?: number | string | null): Promise<Meeting[]>;
  sessionsForMeeting(meetingKey: Key): Promise<Session[]>;
  weather(sessionKey: Key, ttl?: number | null): Promise<Weather | null>;
  positions(sessionKey: Key, ttl?: number | null): Promise<PositionValue[] | null>;
  livePositions(sessionKey: Key, sinceISO?: string | null): Promise<Delta<PositionValue[]>>;
  intervals(sessionKey: Key, ttl?: number | null): Promise<Record<string, Gap> | null>;
  liveIntervals(sessionKey: Key, sinceISO?: string | null): Promise<Delta<Record<string, Gap>>>;
  sessionDrivers(sessionKey: Key, ttl?: number | null): Promise<SessionDriver[] | null>;
  sessionResult(sessionKey: Key, ttl?: number | null): Promise<SessionResultRow[]>;
  sessionLaps(sessionKey: Key, driverNumber: Key): Promise<Lap[]>;
  fastestLap(sessionKey: Key, driverNumber: Key): Promise<Lap | null>;
  carData(sessionKey: Key, driverNumber: Key, startISO?: string | null, endISO?: string | null): Promise<CarSample[]>;
  locationData(sessionKey: Key, driverNumber: Key, startISO?: string | null, endISO?: string | null, options?: { cache?: boolean }): Promise<LocationSample[]>;
  stints(sessionKey: Key, driverNumber?: Key | null): Promise<Stint[]>;
  pits(sessionKey: Key, driverNumber?: Key | null): Promise<PitStop[]>;
  placeLabel: typeof placeLabel;
  /** The TTL the client applies to a session's endpoints (exposed for tests and tabs). */
  sessionTtl(sessionKey: Key): number;
}

export function createF1Api(deps: TransportDeps & { transport?: Transport } = {}): F1Api {
  // THE SEASON IS READ FROM THE CLOCK, per call, so a tab left open across New
  // Year rolls over (api.js:8-19).
  const season = (): string => String(new Date().getFullYear());
  let latestSessionKey: Key | null = null;
  const sessionDates = new Map<string, string>();   // sessionKey -> date_start ISO
  const meetingDates = new Map<string, string>();   // meetingKey -> date_start ISO
  const transport = deps.transport ?? createTransport(OPENF1, TTL_HISTORIC, deps);
  const { request } = transport;
  const enc = (v: Key | string): string => encodeURIComponent(v);

  function schedule(year?: number | string): Promise<ScheduleRace[]> {
    const y = year == null || year === "" ? season() : String(year);
    return request(JOLPICA + "/" + y + ".json", TTL_SCHEDULE).then((json) => {
      return jRaces(json).map((item) => {
        const r = rec(item);
        const c = rec(r.Circuit);
        const loc = rec(c.Location);
        return {
          round: num(r.round),
          name: str(r.raceName),
          circuit: str(c.circuitName),
          locality: str(loc.locality),
          country: str(loc.country),
          date: str(r.date),
          time: str(r.time),
          hasSprint: !!(r.Sprint || r.SprintQualifying || r.SprintShootout),
          sessions: scheduleSessions(r),
        };
      });
    });
  }

  // A finished season never changes: TTL_HISTORIC (api.js:89-95).
  function standingsUrl(year: number | string | null | undefined, what: string): { url: string; ttl: number } {
    const y = year != null ? String(Number(year) | 0) : season();
    return { url: JOLPICA + "/" + y + "/" + what + ".json", ttl: y < season() ? TTL_HISTORIC : TTL_STANDINGS };
  }

  function driverStandings(year?: number | string | null): Promise<DriverStanding[]> {
    const q = standingsUrl(year, "driverstandings");
    return request(q.url, q.ttl).then((json) => {
      const sl = jStandingsList(json);
      return arr(sl?.DriverStandings).map((item) => {
        const s = rec(item);
        const d = rec(s.Driver);
        const cons = rec(Array.isArray(s.Constructors) ? s.Constructors[0] : null);
        const name = ((str(d.givenName) || "") + " " + (str(d.familyName) || "")).trim();
        return {
          pos: num(s.position),
          points: num(s.points) || 0,
          wins: num(s.wins) || 0,
          name: name || null,
          code: str(d.code),
          number: num(d.permanentNumber),
          team: str(cons.name),
        };
      });
    });
  }

  function constructorStandings(year?: number | string | null): Promise<ConstructorStanding[]> {
    const q = standingsUrl(year, "constructorstandings");
    return request(q.url, q.ttl).then((json) => {
      const sl = jStandingsList(json);
      return arr(sl?.ConstructorStandings).map((item) => {
        const s = rec(item);
        const cons = rec(s.Constructor);
        return {
          pos: num(s.position),
          points: num(s.points) || 0,
          wins: num(s.wins) || 0,
          name: str(cons.name),
        };
      });
    });
  }

  function sessionTtl(sessionKey: Key): number {
    // The known-latest session is always treated as live.
    if (sessionKey === latestSessionKey) return TTL_LATEST;
    // A seen session that started comfortably in the past is frozen. The TTL
    // is capped at the time since the freeze instant, so an entry written
    // before the freeze reads stale and is refetched once (api.js:126-145).
    const ds = sessionDates.get(String(sessionKey));
    if (ds) {
      const sinceFrozen = Date.now() - (Date.parse(ds) + SESSION_FROZEN_MS);
      if (isFinite(sinceFrozen) && sinceFrozen > 0) return Math.max(TTL_LATEST, Math.min(TTL_HISTORIC, sinceFrozen));
    }
    return TTL_LATEST;
  }

  function meetingTtl(meetingKey: Key): number {
    const ds = meetingDates.get(String(meetingKey));
    if (!ds) return TTL_LATEST;
    const age = Date.now() - Date.parse(ds);
    if (!isFinite(age) || age < 0) return TTL_LATEST;
    return age <= 7 * 24 * HOUR ? TTL_LATEST : TTL_HISTORIC;
  }

  function key(v: unknown): Key | null {
    return typeof v === "number" || typeof v === "string" ? v : null;
  }

  function mapSession(item: unknown): Session {
    const s = rec(item);
    const out: Session = {
      sessionKey: key(s.session_key),
      meetingKey: key(s.meeting_key),
      year: num(s.year),
      name: str(s.session_name),
      type: str(s.session_type),
      circuit: str(s.circuit_short_name),
      country: str(s.country_name),
      dateStart: str(s.date_start),
    };
    if (out.sessionKey !== null && out.dateStart) sessionDates.set(String(out.sessionKey), out.dateStart);
    return out;
  }

  function latestSession(ttl?: number | null): Promise<Session | null> {
    return request(OPENF1 + "/sessions?session_key=latest", ttl == null ? TTL_LATEST : ttl).then((list) => {
      const a = arr(list);
      if (!a.length) return null;
      const s = mapSession(a[a.length - 1]);
      if (s.sessionKey !== null) latestSessionKey = s.sessionKey;
      return s;
    });
  }

  // Grand Prix weekends for a season (for the session picker).
  function meetings(year?: number | string | null): Promise<Meeting[]> {
    const y = (year == null || year === "") ? season() : year;
    return request(OPENF1 + "/meetings?year=" + enc(y), TTL_SCHEDULE).then((list) => {
      return arr(list).map((item) => {
        const m = rec(item);
        const out: Meeting = {
          meetingKey: key(m.meeting_key),
          name: str(m.meeting_name),
          country: str(m.country_name),
          circuit: str(m.circuit_short_name),
          dateStart: str(m.date_start),
          // OpenF1 keeps CANCELLED rounds in the list (2026's Bahrain and Saudi Arabia).
          cancelled: m.is_cancelled === true,
        };
        if (out.meetingKey !== null && out.dateStart) meetingDates.set(String(out.meetingKey), out.dateStart);
        return out;
      }).filter((m) => m.meetingKey !== null && !m.cancelled);
    });
  }

  function sessionsForMeeting(meetingKey: Key): Promise<Session[]> {
    return request(OPENF1 + "/sessions?meeting_key=" + enc(meetingKey), meetingTtl(meetingKey)).then((list) => {
      return arr(list).map(mapSession).filter((s) => s.sessionKey !== null);
    });
  }

  function ttlFor(sessionKey: Key, ttl: number | null | undefined): number {
    return ttl != null ? ttl : sessionTtl(sessionKey);
  }

  function weather(sessionKey: Key, ttl?: number | null): Promise<Weather | null> {
    const url = OPENF1 + "/weather?session_key=" + enc(sessionKey);
    return request(url, ttlFor(sessionKey, ttl)).then((list) => {
      const a = arr(list);
      if (!a.length) return null;
      const w = rec(a[a.length - 1]);
      return {
        airT: num(w.air_temperature),
        trackT: num(w.track_temperature),
        humidity: num(w.humidity),
        rainfall: num(w.rainfall),
        windSpeed: num(w.wind_speed),
      };
    });
  }

  function positions(sessionKey: Key, ttl?: number | null): Promise<PositionValue[] | null> {
    const url = OPENF1 + "/position?session_key=" + enc(sessionKey);
    return request(url, ttlFor(sessionKey, ttl)).then((list) => {
      const out = positionValues(arr(list));
      return out.length ? out : null;
    });
  }

  function deltaUrl(path: string, sessionKey: Key, sinceISO?: string | null): string {
    let url = OPENF1 + path + "?session_key=" + enc(sessionKey);
    if (sinceISO) url += "&date%3E=" + enc(sinceISO);
    return url;
  }

  function livePositions(sessionKey: Key, sinceISO?: string | null): Promise<Delta<PositionValue[]>> {
    return request(deltaUrl("/position", sessionKey, sinceISO), 0, { cache: false }).then((list) => {
      const a = arr(list);
      return { values: positionValues(a), cursor: cursorOf(a) };
    });
  }

  function intervals(sessionKey: Key, ttl?: number | null): Promise<Record<string, Gap> | null> {
    const url = OPENF1 + "/intervals?session_key=" + enc(sessionKey);
    return request(url, ttlFor(sessionKey, ttl)).then((list) => {
      const a = arr(list);
      return a.length ? intervalValues(a) : null;
    });
  }

  function liveIntervals(sessionKey: Key, sinceISO?: string | null): Promise<Delta<Record<string, Gap>>> {
    return request(deltaUrl("/intervals", sessionKey, sinceISO), 0, { cache: false }).then((list) => {
      const a = arr(list);
      return { values: intervalValues(a), cursor: cursorOf(a) };
    });
  }

  function sessionDrivers(sessionKey: Key, ttl?: number | null): Promise<SessionDriver[] | null> {
    const url = OPENF1 + "/drivers?session_key=" + enc(sessionKey);
    return request(url, ttlFor(sessionKey, ttl)).then((list) => {
      const a = arr(list);
      if (!a.length) return null;
      return a.map((item) => {
        const d = rec(item);
        return {
          num: num(d.driver_number),
          code: str(d.name_acronym),
          name: str(d.full_name) || str(d.broadcast_name),
          team: str(d.team_name),
          color: str(d.team_colour),
        };
      });
    });
  }

  // Classification for ANY session (api.js:349-374). OpenF1's /session_result
  // has no `points` field in its docs today; it stays read for older payloads.
  function sessionResult(sessionKey: Key, ttl?: number | null): Promise<SessionResultRow[]> {
    const url = OPENF1 + "/session_result?session_key=" + enc(sessionKey);
    return request(url, ttlFor(sessionKey, ttl)).then((list) => {
      return arr(list).map((item) => {
        const r = rec(item);
        return {
          pos: num(r.position),
          num: num(r.driver_number),
          laps: num(r.number_of_laps),
          points: num(r.points),
          dnf: !!r.dnf,
          dns: !!r.dns,
          dsq: !!r.dsq,
          duration: durVal(r.duration),
          gap: durVal(r.gap_to_leader),
        };
      });
    });
  }

  function sessionLaps(sessionKey: Key, driverNumber: Key): Promise<Lap[]> {
    const url = OPENF1 + "/laps?session_key=" + enc(sessionKey) + "&driver_number=" + enc(driverNumber);
    return request(url, sessionTtl(sessionKey)).then((list) => {
      return arr(list).map((item) => {
        const l = rec(item);
        return {
          lapNumber: num(l.lap_number),
          lapDuration: num(l.lap_duration),
          s1: num(l.duration_sector_1), s2: num(l.duration_sector_2), s3: num(l.duration_sector_3),
          i1Speed: num(l.i1_speed), i2Speed: num(l.i2_speed), stSpeed: num(l.st_speed),
          isPitOut: !!l.is_pit_out_lap,
          dateStart: str(l.date_start),
        };
      });
    });
  }

  // fastest valid (non pit-out, has a start time) lap for a driver, or null
  function fastestLap(sessionKey: Key, driverNumber: Key): Promise<Lap | null> {
    return sessionLaps(sessionKey, driverNumber).then((laps) => {
      let best: Lap | null = null;
      for (const l of laps) {
        if (l.lapDuration === null || !l.dateStart || l.isPitOut) continue;
        if (!best || l.lapDuration < (best.lapDuration as number)) best = l;
      }
      return best;
    });
  }

  function windowed(path: string, sessionKey: Key, driverNumber: Key, startISO?: string | null, endISO?: string | null, options?: { cache?: boolean }): Promise<unknown> {
    let url = OPENF1 + path + "?session_key=" + enc(sessionKey) + "&driver_number=" + enc(driverNumber);
    if (startISO) url += "&date>=" + enc(startISO);
    if (endISO) url += "&date<=" + enc(endISO);
    return request(url, sessionTtl(sessionKey), options);
  }

  // car telemetry samples within a time window: speed/throttle/brake/gear/rpm/drs
  function carData(sessionKey: Key, driverNumber: Key, startISO?: string | null, endISO?: string | null): Promise<CarSample[]> {
    return windowed("/car_data", sessionKey, driverNumber, startISO, endISO).then((list) => {
      // An unparseable date must not become t:0 (api.js:430-433).
      const out: CarSample[] = [];
      for (const item of arr(list)) {
        const c = rec(item);
        const cMs = Date.parse(c.date as string);
        if (!isFinite(cMs)) continue;
        out.push({
          speed: num(c.speed), throttle: num(c.throttle), brake: num(c.brake),
          gear: num(c.n_gear), rpm: num(c.rpm), drs: num(c.drs),
          date: cMs, t: 0,
        });
      }
      const ordered = orderedSamples(out);
      const t0 = ordered.length ? (ordered[0] as CarSample).date : 0;
      for (const row of ordered) row.t = (row.date - t0) / 1000;
      return ordered;
    });
  }

  // x/y track positions within a window (arbitrary track-local units)
  function locationData(sessionKey: Key, driverNumber: Key, startISO?: string | null, endISO?: string | null, options?: { cache?: boolean }): Promise<LocationSample[]> {
    return windowed("/location", sessionKey, driverNumber, startISO, endISO, options).then((list) => {
      const rows: LocationSample[] = [];
      for (const item of arr(list)) {
        const p = rec(item);
        const x = num(p.x), y = num(p.y), date = Date.parse(p.date as string);
        // DROPOUT ROWS: the feed emits x:0, y:0 when positioning is lost, and
        // one origin row rescales a whole track map (api.js:451-466).
        if (x !== null && y !== null && !(x === 0 && y === 0) && isFinite(date)) rows.push({ x, y, date });
      }
      return orderedSamples(rows);
    });
  }

  function stints(sessionKey: Key, driverNumber?: Key | null): Promise<Stint[]> {
    let url = OPENF1 + "/stints?session_key=" + enc(sessionKey);
    if (driverNumber != null) url += "&driver_number=" + enc(driverNumber);
    return request(url, sessionTtl(sessionKey)).then((list) => {
      return arr(list).map((item) => {
        const s = rec(item);
        return {
          num: num(s.driver_number), compound: str(s.compound),
          lapStart: num(s.lap_start), lapEnd: num(s.lap_end),
          age: num(s.tyre_age_at_start), stint: num(s.stint_number),
        };
      });
    });
  }

  function pits(sessionKey: Key, driverNumber?: Key | null): Promise<PitStop[]> {
    let url = OPENF1 + "/pit?session_key=" + enc(sessionKey);
    if (driverNumber != null) url += "&driver_number=" + enc(driverNumber);
    return request(url, sessionTtl(sessionKey)).then((list) => {
      return arr(list).map((item) => {
        const p = rec(item);
        return { num: num(p.driver_number), lap: num(p.lap_number), duration: num(p.lane_duration ?? p.pit_duration) };
      });
    });
  }

  return {
    transport,
    request: transport.request,
    cancelAll: transport.cancelAll,
    cacheEntryT: transport.cacheEntryT,
    staleMark: transport.staleMark,
    staleSince: transport.staleSince,
    forget: transport.forget,
    season,
    schedule,
    driverStandings,
    constructorStandings,
    latestSession,
    meetings,
    sessionsForMeeting,
    weather,
    positions,
    livePositions,
    intervals,
    liveIntervals,
    sessionDrivers,
    sessionResult,
    sessionLaps,
    fastestLap,
    carData,
    locationData,
    stints,
    pits,
    placeLabel,
    sessionTtl,
  };
}

let shared: F1Api | null = null;
/** The page-wide client (one rate-limit budget per origin, like f1-game's F1API singleton). */
export function f1Api(): F1Api {
  if (!shared) shared = createF1Api();
  return shared;
}
