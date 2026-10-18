// @vitest-environment happy-dom
/**
 * WATCH & DRIVE (src/data/real-race/): the script builder, its caches and the tab.
 *
 * Ports the assertions of f1-game tests/unit/real-race-script.test.mjs, the
 * data-tab parts of real-race.test.mjs (:831-926) and
 * real-race-tab-gap-refresh.test.mjs. real-replay-captions.test.mjs tests
 * js/race/real-replay.js (the race lane's), not this file, so nothing of it
 * lands here. The fixture is f1-game's tests/fixtures/openf1-baku-2026-race.json
 * (the 2026 Azerbaijan GP as OpenF1 published it, trimmed to the fields read).
 *
 * Where /home/f1-game is present, build() and the pure readers are compared
 * with f1-game's own js/data/real-race-tab.js evaluated in node:vm: the script
 * must be identical.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { placeLabel, type Session } from "../../../src/data/api";
import { clear, el } from "../../../src/data/dom";
import { findTeam } from "../../../src/data/hub";
import { DEFAULT_CALENDAR, circuitTracks, registerRealRacePort, realRacePort, type LaunchOptions, type RealRacePort, type Seat } from "../../../src/data/real-race/bridge";
import { CACHE_KEY, CACHE_MAX, TRACE_MAX, createRealRaceCache, type RealRaceApi, type TraceIdbFactory } from "../../../src/data/real-race/cache";
import {
  SCRIPT_V, TRACE_V, build, cautionsFor, fmtLap, gridFor, lapBoard, packTrace, pitDuel, rainByLap, raceBook, todFor, trackIdFor, traceDetails, weatherFor,
  type CumTable, type RaceScript, type RawRace, type TrackInfo, type Traces,
} from "../../../src/data/real-race/script";
import { create, mount, type RealRaceTabDeps } from "../../../src/data/real-race/tab";
import { F1_ROOT, hasF1, plain } from "./f1-vm";
import { MemoryStorage, fixture } from "./fixtures";

type Fixture = RawRace & { meeting_name: string };
const FIXTURE = fixture("openf1-baku-2026-race.json") as Fixture;

function rawBaku(): Fixture {
  const raw = plain(FIXTURE);
  raw.session!.meeting_name = FIXTURE.meeting_name;
  return raw;
}
/** A hand-built partial script (the f1-game tests' literals). */
const S = (v: unknown): RaceScript => v as RaceScript;

const TRACKS: TrackInfo[] = [
  { id: "monza", name: "MONZA", country: "Italy" }, { id: "imola", name: "IMOLA", country: "Italy", classic: true },
  { id: "baku", name: "BAKU", country: "Azerbaijan" }, { id: "cota", name: "COTA", country: "USA" },
  { id: "miami", name: "MIAMI", country: "USA" }, { id: "singapore", name: "SINGAPORE", country: "Singapore" },
  { id: "bahrain", name: "BAHRAIN", country: "Bahrain" }, { id: "sepang", name: "SEPANG", country: "Malaysia", classic: true },
];

const flush = async (n = 1): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function positionRows(script: RaceScript, num = script.drivers[0]!.num): { date: number; x: number; y: number }[] {
  const d = script.drivers.find((driver) => driver.num === num)!;
  const end = Math.max(...d.lapStart.map((start, i) => start != null && (d.laps[i] ?? 0) > 0 ? start + d.laps[i]! : 0));
  return Array.from({ length: 102 }, (_, i) => ({ date: script.t0! + end * 1000 * i / 101, x: i * 10, y: i * 10 }));
}

// RealRace.cumTable / paceTable (f1-game js/race/real-race.js:47-111), copied
// here as the test's stand-in for the race lane's port. TODO(lane-race): use
// the ported module once src/race/ has it.
function cumTableRef(script: RaceScript): CumTable {
  const REL_MIN = 0.90, REL_MAX = 1.12;
  const laps = script.laps | 0, drivers = script.drivers || [];
  const pitLap = new Map<number, Set<number>>();
  for (const d of drivers) { const set = new Set<number>(); for (const p of d.pits || []) { set.add(p); set.add(p + 1); } pitLap.set(d.num, set); }
  const clean = (d: RaceScript["drivers"][number], lap: number): number | null => { const t = d.laps && d.laps[lap - 1]; return t != null && t > 0 && !pitLap.get(d.num)!.has(lap) ? t : null; };
  const ref: (number | null)[] = new Array<number | null>(laps + 1).fill(null);
  for (let lap = 1; lap <= laps; lap++) {
    const ts: number[] = [];
    for (const d of drivers) { const t = clean(d, lap); if (t != null) ts.push(t); }
    if (!ts.length) continue;
    ts.sort((a, b) => a - b);
    ref[lap] = ts.length % 2 ? ts[(ts.length - 1) >> 1]! : (ts[ts.length / 2 - 1]! + ts[ts.length / 2]!) / 2;
  }
  void REL_MIN; void REL_MAX;   // the rel table is not part of cumTable
  const out: Record<number, number[]> = {};
  for (const d of drivers) {
    const l = d.laps || [];
    let last = -1;
    for (let i = 0; i < l.length; i++) if ((l[i] ?? 0) > 0) last = i;
    const end = Math.max(last + 1, Math.min(l.length, d.dnf ? d.lapsDone | 0 : l.length));
    const row = [0];
    let t = 0, fill = 0;
    for (let i = 0; i < l.length; i++) if ((l[i] ?? 0) > 0) { fill = l[i]!; break; }
    for (let i = 0; i < end; i++) {
      const li = l[i] ?? null, ri = ref[i + 1] ?? null;
      const v = li != null && li > 0 ? li : (ri != null && ri > 0 ? ri : fill);
      if (!(v > 0)) break;
      if (li != null && li > 0) fill = li;
      t += v; row.push(t);
    }
    out[d.num] = row;
  }
  return out;
}

// ── f1-game in a VM ─────────────────────────────────────────────────────────

interface F1Data {
  build(raw: unknown, findTeam: (n: unknown) => unknown, tracks: unknown): unknown;
  trackIdFor(s: unknown, t: unknown): unknown; todFor(s: unknown): unknown; weatherFor(w: unknown): unknown;
  rainByLap(l: unknown, w: unknown, n: number): unknown; cautionsFor(rc: unknown, secs?: unknown): unknown; gridFor(p: unknown): unknown;
  lapBoard(s: unknown, lap: number): unknown; raceBook(s: unknown): unknown; fmtLap(t: unknown): string;
  pitDuel(s: unknown, a: unknown, b: unknown, c: unknown, d: unknown): unknown; packTrace(r: unknown, t0: number): unknown;
  SCRIPT_V: number; TRACE_V: number; TRACE_MAX: number; CACHE_MAX: number;
}
interface F1Realm { D: F1Data; cumTable(s: unknown): CumTable; findTeam(n: unknown): unknown; REAL_2026: unknown }

/** f1-game's teams.js + real-race-tab.js + real-race.js in one realm (RealRace is the lapBoard global there). */
function f1Realm(extra: Record<string, unknown> = {}): F1Realm {
  const ctx = createContext({ ...extra });
  const files = ["js/core/mat4.js", "js/data/teams.js", "js/data/real-race-tab.js", "js/race/real-race.js"];
  for (const f of files) runInContext(readFileSync(path.join(F1_ROOT, f), "utf8"), ctx, { filename: f });
  const src = readFileSync(path.join(F1_ROOT, "js/career/season-cal.js"), "utf8");
  const m = /const REAL_2026 = Object\.freeze\(\[[\s\S]*?\]\.map\([^\n]*\)\);/.exec(src);
  const REAL_2026 = m ? runInContext(m[0] + "; REAL_2026", createContext({})) : null;
  // js/data/hub.js's team matcher, reduced to what the fixture's names need (real-race-script.test.mjs:57-64).
  const findTeamF1 = runInContext(`(function () {
    const KEYS = [["racing bulls", "RB"], ["red bull", "RBR"], ["mercedes", "MER"], ["ferrari", "FER"], ["mclaren", "MCL"], ["alpine", "ALP"],
      ["haas", "HAA"], ["williams", "WIL"], ["audi", "AUD"], ["aston", "AMR"], ["cadillac", "CAD"]];
    return function (name) { const n = String(name || "").toLowerCase(); const k = KEYS.find((p) => n.indexOf(p[0]) !== -1);
      return k ? Teams.LIST.find((t) => t.short === k[1]) || null : null; };
  })()`, ctx) as (n: unknown) => unknown;
  const R = runInContext("RealRace", ctx) as { cumTable(s: unknown): CumTable };
  return { D: runInContext("DataRealRace", ctx) as F1Data, cumTable: (s) => R.cumTable(s), findTeam: findTeamF1, REAL_2026 };
}

const noFetchedAt = <T extends { fetchedAt?: unknown }>(s: T): Omit<T, "fetchedAt"> => { const c = { ...plain(s) }; delete c.fetchedAt; return c; };

describe.skipIf(!hasF1)("real race script: identical to f1-game's real-race-tab.js", () => {
  const F = hasF1 ? f1Realm() : (null as unknown as F1Realm);
  const mine = (raw: RawRace): RaceScript => build(raw, findTeam, TRACKS);
  const theirs = (raw: RawRace): RaceScript => F.D.build(plain(raw), F.findTeam, plain(TRACKS)) as RaceScript;

  it("the constants match", () => {
    expect([SCRIPT_V, TRACE_V, TRACE_MAX, CACHE_MAX]).toEqual([F.D.SCRIPT_V, F.D.TRACE_V, F.D.TRACE_MAX, F.D.CACHE_MAX]);
  });

  it("the 2026 Baku race builds into the same script, field for field", () => {
    const a = mine(rawBaku()), b = theirs(rawBaku());
    expect(a.drivers.length).toBe(22);
    expect(noFetchedAt(a)).toStrictEqual(noFetchedAt(b));
    // The unknown-to-JSON fields too (undefined-valued keys would vanish in plain()).
    expect(Object.keys(a).sort()).toEqual(Object.keys(plain(b)).sort());
    for (let i = 0; i < a.drivers.length; i++) expect(Object.keys(a.drivers[i]!).sort()).toEqual(Object.keys(plain(b.drivers[i]!)).sort());
  });

  it("variants build identically: a race still running, lane_duration, untimed laps, a DNS, no calendar match", () => {
    const variants: [string, (raw: Fixture) => void][] = [
      ["running", (raw) => { raw.result = []; raw.laps = raw.laps!.filter((l) => (l!.lap_number as number) <= 20); }],
      ["lane_duration", (raw) => { raw.pits = [{ driver_number: 63, lap_number: 31, lane_duration: 22.2, pit_duration: 99 }, { driver_number: 63, lap_number: 36, pit_duration: 23.4 }]; }],
      ["untimed L1", (raw) => { raw.laps!.find((l) => l!.lap_number === 1)!.lap_duration = null; }],
      ["winner only", (raw) => { raw.laps = raw.laps!.filter((l) => l!.driver_number === 63); }],
      ["DNS", (raw) => { const n = raw.drivers![1]!.driver_number; const r = raw.result!.find((x) => x!.driver_number === n)!; r.dns = true; r.number_of_laps = 0; raw.laps = raw.laps!.filter((l) => l!.driver_number !== n); }],
      ["moved venue", (raw) => { Object.assign(raw.session!, { country_name: "Bahrain", circuit_short_name: "Kuala Lumpur", date_start: "2026-10-04T07:00:00+00:00", gmt_offset: "08:00:00" }); }],
      ["no session", (raw) => { delete raw.session; raw.teamRadio = null; }],
      ["string numbers", (raw) => { for (const l of raw.laps!) { l!.lap_number = String(l!.lap_number); l!.driver_number = String(l!.driver_number); } }],
    ];
    for (const [name, edit] of variants) {
      const raw = rawBaku(); edit(raw);
      expect(noFetchedAt(mine(raw)), name).toStrictEqual(noFetchedAt(theirs(raw)));
    }
  });

  it("the lap board and race book read the same off every lap", () => {
    const a = mine(rawBaku()), b = theirs(rawBaku());
    // The test's cumTable stand-in is f1-game's own.
    expect(plain(cumTableRef(a))).toStrictEqual(plain(F.cumTable(b)));
    for (let lap = 1; lap <= a.laps; lap++) expect(plain(lapBoard(a, lap, F.cumTable)), "lap " + lap).toStrictEqual(plain(F.D.lapBoard(b, lap)));
    expect(plain(raceBook(a, F.cumTable))).toStrictEqual(plain(F.D.raceBook(b)));
  });

  it("pitDuel, packTrace, fmtLap, the readers and the calendar agree", () => {
    const a = mine(rawBaku()), b = theirs(rawBaku());
    const stops = a.drivers.flatMap((d) => d.pits.map((p) => [d.num, p] as const));
    for (const [an, as] of stops.slice(0, 12)) for (const [bn, bs] of stops) {
      expect(plain(pitDuel(a, an, as, bn, bs))).toStrictEqual(plain(F.D.pitDuel(b, an, as, bn, bs)));
    }
    const rows = [{ date: 102000, x: 30, y: 40 }, { date: NaN, x: 1, y: 2 }, { date: 100000, x: 10, y: 20 }, { date: 101000, x: null, y: 30 },
      { date: 101000, x: 20, y: 30 }, { date: 100400, x: 999, y: 999 }, { date: 103400, x: 5, y: 5 }];
    expect(Array.from(packTrace(rows, 100000))).toEqual(Array.from(F.D.packTrace(rows, 100000) as Float32Array));
    for (const t of [null, 0, -1, 58.4019, 59.9996, 112.263, 119.9996, 3599.9999]) expect(fmtLap(t)).toBe(F.D.fmtLap(t));
    const sessions = [
      { country_name: "Italy", circuit_short_name: "Monza" }, { country_name: "Italy", circuit_short_name: "Nowhere" },
      { country_name: "United States", circuit_short_name: "Austin" }, { country_name: "Bahrain", circuit_short_name: "Kuala Lumpur" },
      { country_name: "Nowhere", circuit_short_name: "toString" }, { date_start: "2026-10-11T12:00:00+00:00", gmt_offset: "08:00:00" },
      { date_start: "2026-03-01T15:00:00+00:00", gmt_offset: "-03:30:00" }, { date_start: "nope" },
    ];
    for (const s of sessions) { expect(trackIdFor(s, TRACKS)).toBe(F.D.trackIdFor(s, TRACKS)); expect(todFor(s)).toBe(F.D.todFor(s)); }
    expect(plain(cautionsFor(FIXTURE.raceControl))).toStrictEqual(plain(F.D.cautionsFor(FIXTURE.raceControl)));
    expect(plain(gridFor(FIXTURE.positions))).toStrictEqual(plain(F.D.gridFor(FIXTURE.positions)));
    expect(weatherFor(FIXTURE.weather)).toBe(F.D.weatherFor(FIXTURE.weather));
    // DEFAULT_CALENDAR is season-cal.js's REAL_2026, verbatim.
    expect(plain(DEFAULT_CALENDAR)).toStrictEqual(plain(F.REAL_2026));
    // With the calendar loaded in both realms, the moved GP lands on the same circuit.
    const G = f1Realm({ SeasonCal: { REAL_2026: F.REAL_2026 } });
    const moved = { country_name: "Bahrain", circuit_short_name: "Kuala Lumpur", date_start: "2026-10-04T07:00:00+00:00", gmt_offset: "08:00:00" };
    expect(trackIdFor(moved, TRACKS, DEFAULT_CALENDAR)).toBe(G.D.trackIdFor(moved, TRACKS));
  });
});

// ── real-race-script.test.mjs, the pure parts ──────────────────────────────

describe("the script builder", () => {
  it("the 2026 Baku race builds into a 22-driver, 51-lap script with the pre-start grid", () => {
    const s = plain(build(rawBaku(), findTeam, TRACKS));
    expect(s.v).toBe(SCRIPT_V);
    expect(s.laps).toBe(51);
    expect(s.sessionKey).toBe(11377);
    expect(s.name).toBe("Azerbaijan Grand Prix");
    expect(s.trackId).toBe("baku");
    expect(s.tod, "11:00 UTC + 04:00 is mid-afternoon").toBe("day");
    expect(s.weather).toBe("dry");
    expect(s.drivers.length).toBe(22);
    // Grid order first — the snapshot taken on the grid, not the finishing order.
    expect(s.drivers.slice(0, 3).map((d) => d.code)).toEqual(["RUS", "LEC", "PIA"]);
    expect(s.drivers[21]!.code).toBe("STR");
    expect(s.drivers[0]!.grid).toBe(1);
    expect(s.drivers[21]!.grid).toBe(22);
    const rus = s.drivers.find((d) => d.code === "RUS")!;
    expect(rus.num).toBe(63);
    expect(rus.teamId).toBe("mercedes");
    expect(rus.pos).toBe(1);
    expect(rus.dnf).toBe(false);
    expect(rus.laps.length).toBe(51);
    expect(rus.laps[0]).toBe(112.263);
    expect(rus.stints, "the mediums were two laps old from qualifying").toEqual([{ c: "MEDIUM", from: 1, to: 31, age: 2 }, { c: "SOFT", from: 32, to: 36, age: 0 }, { c: "SOFT", from: 37, to: 51, age: 0 }]);
    expect(s.complete, "a classified race with every lap in").toBe(true);
    expect(s.rain!.length, "rain flag per real lap").toBe(52);
    expect(s.rain!.every((r) => r === false), "Baku 2026 was dry throughout").toBe(true);
    expect(rus.pits).toEqual([31, 36]);
    // Every real team lands on a roster team — the 2026 grid is the game's grid.
    expect(s.drivers.every((d) => d.teamId)).toBe(true);
    expect(new Set(s.drivers.map((d) => d.teamId)).size).toBe(11);
  });

  it("retirements carry the lap they stopped on; a missing lap time ends the row", () => {
    const s = plain(build(rawBaku(), findTeam, TRACKS));
    const str = s.drivers.find((d) => d.code === "STR")!;
    expect(str.dnf).toBe(true);
    expect(str.lapsDone).toBe(7);
    expect(str.pos).toBe(null);
    expect(str.laps[7], "lap 8 (the retirement lap) has no duration").toBe(null);
    expect(s.drivers.filter((d) => d.dnf).length).toBe(7);
  });

  it("the race-control feed becomes safety-car windows on the leader's lap", () => {
    expect(plain(cautionsFor(FIXTURE.raceControl))).toEqual([
      { level: 3, from: 31, to: 35, cause: "SAFETY CAR" },
      { level: 3, from: 36, to: 38, cause: "SAFETY CAR" },
    ]);
    // A VSC pairs DEPLOYED with ENDING; a red flag is a one-lap marker; an unclosed window ends where it opened.
    expect(plain(cautionsFor([
      { lap_number: 3, category: "SafetyCar", message: "VIRTUAL SAFETY CAR DEPLOYED" },
      { lap_number: 4, category: "SafetyCar", message: "VIRTUAL SAFETY CAR ENDING" },
      { lap_number: 10, category: "Flag", flag: "RED", message: "RED FLAG" },
      { lap_number: 20, category: "SafetyCar", message: "SAFETY CAR DEPLOYED" },
      { lap_number: 21, category: "Other", message: "LAPPED CARS MAY NOW OVERTAKE THE SAFETY CAR: 77" },
    ]))).toEqual([
      { level: 2, from: 3, to: 4, cause: "VSC" },
      { level: 4, from: 10, to: 10, cause: "RED FLAG" },
      { level: 3, from: 20, to: 20, cause: "SAFETY CAR" },
    ]);
  });

  it("SC ending notice keeps its inclusive lap but releases only at TRACK CLEAR", () => {
    const rows = [
      { lap_number: 31, date: "2026-01-01T11:58:05Z", message: "SAFETY CAR DEPLOYED" },
      { lap_number: 35, date: "2026-01-01T12:09:15Z", message: "SAFETY CAR IN THIS LAP" },
      { lap_number: 36, date: "2026-01-01T12:11:14Z", message: "TRACK CLEAR" },
    ];
    const secs = (d: string | null | undefined): number => Date.parse(d || "") / 1000;
    const [w] = cautionsFor(rows, secs);
    expect(w!.to).toBe(35);
    expect(w!.tEnding).toBe(secs(rows[1]!.date));
    expect(w!.tTo! - w!.tEnding!).toBe(119);
    expect(cautionsFor(rows.slice(0, 2), secs)[0]!.tTo, "notice alone has no exact release").toBe(null);
    expect(cautionsFor([rows[0]!, rows[2]!])[0]!.to, "release without notice retains the last caution lap").toBe(36);
  });

  it("the circuit resolves by name before country, and the weather and hour read off the session", () => {
    expect(trackIdFor({ country_name: "Italy", circuit_short_name: "Monza" }, TRACKS)).toBe("monza");
    expect(trackIdFor({ country_name: "Italy", circuit_short_name: "Imola" }, TRACKS)).toBe("imola");
    expect(trackIdFor({ country_name: "Italy", circuit_short_name: "Nowhere" }, TRACKS), "the country's current circuit, not the classic").toBe("monza");
    expect(trackIdFor({ country_name: "United States", circuit_short_name: "Austin" }, TRACKS)).toBe("cota");
    expect(trackIdFor({ country_name: "Azerbaijan", circuit_short_name: "Baku" }, TRACKS)).toBe("baku");
    expect(trackIdFor({ country_name: "Nowhere", circuit_short_name: "X" }, TRACKS)).toBe(null);
    // The 2026 Bahrain GP ran at Sepang: OpenF1 names it "Kuala Lumpur" in country "Bahrain". The date window
    // (SeasonCal.REAL_2026) gives the circuit; the country fallback alone would grid it on Sakhir.
    const moved = { country_name: "Bahrain", circuit_short_name: "Kuala Lumpur", date_start: "2026-10-04T07:00:00+00:00", gmt_offset: "08:00:00" };
    expect(trackIdFor(moved, TRACKS, DEFAULT_CALENDAR), "by date window").toBe("sepang");
    expect(trackIdFor(moved, TRACKS), "no calendar loaded: the venue alias still says Sepang").toBe("sepang");
    expect(trackIdFor({ country_name: "Bahrain", circuit_short_name: "Sakhir", date_start: "2026-02-20T09:00:00+00:00" }, TRACKS), "an ordinary Sakhir session stays on Sakhir").toBe("bahrain");
    expect(trackIdFor({ country_name: "Italy", circuit_short_name: "Monza", date_start: "2026-10-03T09:00:00+00:00" }, TRACKS, DEFAULT_CALENDAR), "an exact circuit name beats the date window").toBe("monza");
    expect(todFor({ date_start: "2026-10-11T12:00:00+00:00", gmt_offset: "08:00:00" }), "Singapore at 20:00 local").toBe("night");
    expect(todFor({ date_start: "2026-03-01T15:00:00+00:00", gmt_offset: "03:00:00" }), "Bahrain at 18:00 local").toBe("dusk");
    expect(todFor({ date_start: "nope" })).toBe("default");
    expect(weatherFor([{ rainfall: 0 }, { rainfall: 0 }])).toBe("dry");
    expect(weatherFor([{ rainfall: 1 }, { rainfall: 0 }, { rainfall: 0 }])).toBe("wet");
    expect(weatherFor([{ rainfall: 1 }, { rainfall: 1 }, { rainfall: 0 }])).toBe("rain");
    expect(plain(gridFor([{ driver_number: 1, position: 5, date: "b" }, { driver_number: 1, position: 2, date: "a" }, { driver_number: 4, position: 1, date: "c" }]))).toEqual({ 1: 2, 4: 1 });
  });

  it("the game's circuits feed the resolver: Baku and the classics are there", () => {
    const list = circuitTracks();
    expect(list.find((t) => t.id === "baku")).toMatchObject({ id: "baku", country: "Azerbaijan" });
    expect(list.some((t) => t.classic)).toBe(true);
    expect(build(rawBaku(), findTeam, list).trackId).toBe("baku");
  });

  // A car a lap down finishes one lap short: its crossing row ends at its own last lap. It is RUNNING, not out
  // (R2-04); only a retirement stops. fmtLap rounds before it splits (R2-05).
  it("a lapped finisher stays on the final lap board as '+N LAP'; a retirement stays OUT; fmtLap never prints :60", () => {
    const lap = (n: number, t: number): number[] => Array.from({ length: n }, () => t);
    const script = S({ laps: 5, drivers: [
      { num: 1, code: "WIN", laps: lap(5, 90), pits: [], stints: [], dnf: false },
      { num: 2, code: "SEC", laps: lap(5, 91), pits: [], stints: [], dnf: false },
      { num: 3, code: "LAP", laps: lap(4, 100), pits: [], stints: [], dnf: false },
      { num: 4, code: "DNF", laps: lap(2, 95), lapsDone: 2, pits: [], stints: [], dnf: true }] });
    const before = lapBoard(script, 4, cumTableRef);
    expect(before.map((r) => r.code)).toEqual(["WIN", "SEC", "LAP", "DNF"]);
    const lapRow4 = before.find((r) => r.code === "LAP")!;
    expect(!lapRow4.out && lapRow4.down, "still on the lead lap at lap 4").toBe(0);
    const board = lapBoard(script, 5, cumTableRef);
    const lapped = board.find((r) => r.code === "LAP")!;
    expect(lapped.out, "a finisher a lap down is not OUT").toBe(false);
    expect(!lapped.out && lapped.down).toBe(1);
    expect(lapped.gap, "and its gap is not a time").toBe(null);
    expect(board.map((r) => r.code), "classified order: lead lap, lapped, then the retirement").toEqual(["WIN", "SEC", "LAP", "DNF"]);
    expect(board.find((r) => r.code === "DNF")!.out).toBe(true);
    expect(raceBook(script, cumTableRef)[4]!.leader).toBe("WIN");
    expect(lapBoard(script, 5), "no director: no board").toEqual([]);
    expect(fmtLap(119.9996)).toBe("2:00.000");
    expect(fmtLap(59.9996)).toBe("1:00.000");
    expect(fmtLap(112.263)).toBe("1:52.263");
  });

  it("rain by lap aligns the weather samples to the leader's lap windows; an unfinished race is not complete", () => {
    const laps = [
      { driver_number: 1, lap_number: 1, date_start: "2026-01-01T10:00:00Z" }, { driver_number: 1, lap_number: 2, date_start: "2026-01-01T10:02:00Z" },
      { driver_number: 1, lap_number: 3, date_start: "2026-01-01T10:04:00Z" }, { driver_number: 2, lap_number: 3, date_start: "2026-01-01T10:04:30Z" },
    ];
    const wx = [{ date: "2026-01-01T09:50:00Z", rainfall: 1 }, { date: "2026-01-01T10:02:30Z", rainfall: 1 }, { date: "2026-01-01T10:05:00Z", rainfall: 0 }, { date: "bad", rainfall: 1 }];
    expect(rainByLap(laps, wx, 4), "only lap 2's window saw rain (the pre-race sample is before lap 1)").toEqual([false, false, true, false, false]);
    expect(rainByLap([{ driver_number: 1, lap_number: 1 }], wx, 4), "no lap timestamps: no alignment").toBe(null);
    // A race still running: laps partial, no classification -> plays as far as it goes, never cached.
    const raw = rawBaku();
    raw.result = [];
    raw.laps = raw.laps!.filter((l) => (l!.lap_number as number) <= 20);
    const s = build(raw, findTeam, TRACKS);
    expect(s.laps).toBe(20);
    expect(s.complete).toBe(false);
    const storage = new MemoryStorage();
    const cache = createRealRaceCache({ api: stubApi(), storage, indexedDB: null });
    storage.setItem(CACHE_KEY + "11377", JSON.stringify(s));
    expect(cache.cached(11377), "an incomplete script is never served from the cache").toBe(null);
  });

  it("the passes, the lap board and the race book read straight off the real timing", () => {
    const s = build(rawBaku(), findTeam, TRACKS);
    expect(s.passes.length, "OpenF1's 160 overtakes dated onto laps, minus the 32 on either side of a car retiring that lap").toBe(128);
    expect(s.passes.some((p) => p.lap === 36 && (p.over === 4 || p.over === 10)), "the field streaming past Norris and Gasly as they stopped is not passing them").toBe(false);
    const l1 = s.passes.filter((p) => p.lap === 1);
    expect(l1.length, "eighteen passes on the opening lap").toBe(18);
    expect([l1[0]!.lap, l1[0]!.by, l1[0]!.over, l1[0]!.pos]).toEqual([1, 81, 16, 2]);
    expect(l1[0]!.t! > 10 && l1[0]!.t! < 20 && l1[0]!.frac! > 0.1 && l1[0]!.frac! < 0.15, "Piastri took P2 thirteen seconds after the lights, an eighth of the way round").toBe(true);
    expect(s.passes.filter((p) => p.lap === 36).length, "the restart lap after the second safety car, without the two stopped cars").toBe(26);
    const board = lapBoard(s, 51, cumTableRef);
    expect([board[0]!.code, board[0]!.pos, board[0]!.gap]).toEqual(["RUS", 1, 0]);
    expect(board[1]!.code).toBe("VER");
    const sum = (num: number): number => s.drivers.find((d) => d.num === num)!.laps.reduce<number>((a, b) => a + (b as number), 0);
    expect(Math.abs(board[1]!.gap! - (sum(3) - sum(63))) < 1e-6, "the gap is the difference of the crossing times").toBe(true);
    expect(board.filter((r) => r.out).length).toBe(7);
    expect(board[board.length - 1]!.code).toBe("STR");
    expect(lapBoard(s, 31, cumTableRef).find((r) => r.code === "RUS")!.pitIn, "Russell's in-lap").toBe(true);
    expect(lapBoard(s, 32, cumTableRef).find((r) => r.code === "RUS")!.pitOut, "his out-lap").toBe(true);
    const book = raceBook(s, cumTableRef);
    expect(book.length).toBe(51);
    expect(book[30]!.flag).toBe("SAFETY CAR"); expect(book[29]!.flag).toBe("");
    expect(book[7]!.out).toEqual(["STR"]);
    expect(book[0]!.leader).toBe("RUS");
    expect(book[0]!.fastest && book[0]!.fastest.t > 100).toBe(true);
    expect(book.every((b) => b.rain === false)).toBe(true);
    expect(fmtLap(112.263)).toBe("1:52.263");
    expect(fmtLap(null)).toBe("—");
  });

  it("race scripts read lane_duration after OpenF1 removes pit_duration", () => {
    const raw = rawBaku();
    raw.pits = [{ driver_number: 63, lap_number: 31, lane_duration: 22.2, pit_duration: 99 }, { driver_number: 63, lap_number: 36, pit_duration: 23.4 }];
    expect(build(raw, findTeam, TRACKS).drivers.find((d) => d.num === 63)!.pitDur).toEqual([22.2, 23.4]);
  });

  it("complete timing covers every classified distance, including retired and explicitly untimed laps", () => {
    const raw = plain(FIXTURE);
    expect(build(raw, findTeam, TRACKS).complete).toBe(true);
    const winner = raw.result!.find((r) => r!.position === 1)!.driver_number;
    raw.laps = raw.laps!.filter((l) => l!.driver_number === winner);
    expect(build(raw, findTeam, TRACKS).complete, "the winner alone cannot poison the cache").toBe(false);
    const valid = plain(FIXTURE);
    valid.laps!.find((l) => l!.lap_number === 1)!.lap_duration = null;
    expect(build(valid, findTeam, TRACKS).complete, "a published untimed lap is still coverage").toBe(true);
    const placeholder = plain(valid);
    placeholder.laps!.find((l) => l!.driver_number === winner && l!.lap_number === 2)!.lap_duration = null;
    expect(build(placeholder, findTeam, TRACKS).complete, "mid-race placeholders must refetch").toBe(false);
    const dns = valid.drivers![1]!.driver_number;
    const result = valid.result!.find((r) => r!.driver_number === dns)!;
    result.dns = true; result.number_of_laps = 0;
    valid.laps = valid.laps!.filter((l) => l!.driver_number !== dns);
    expect(build(valid, findTeam, TRACKS).complete, "DNS needs no lap timing").toBe(true);
  });

  it("WATCH packing sorts valid positions and keeps the first valid duplicate timestamp", () => {
    const packed = packTrace([{ date: 102000, x: 30, y: 40 }, { date: NaN, x: 1, y: 2 },
      { date: 100000, x: 10, y: 20 }, { date: 101000, x: null, y: 30 },
      { date: 101000, x: 20, y: 30 }, { date: 101000, x: 999, y: 999 }], 100000);
    expect(Array.from(packed)).toEqual([0, 1, 2, 1, 2, 3, 2, 3, 4]);
  });

  it("the pit-stop duel compares observed crossings and refuses what it cannot see", () => {
    const s = build(rawBaku(), findTeam, TRACKS);
    expect(pitDuel(s, "", "", "", "")).toMatchObject({ available: false, reason: "Choose two drivers and one stop each." });
    const duel = pitDuel(s, 63, 31, 63, 36);
    expect(duel.available, "one driver against himself is not a duel").toBe(false);
  });
});

// ── The caches ──────────────────────────────────────────────────────────────

function stubApi(over: Partial<RealRaceApi> = {}): RealRaceApi {
  return {
    request: () => Promise.reject(new Error("no network in this test")),
    meetings: () => Promise.resolve([]),
    locationData: () => Promise.reject(new Error("no positions in this test")),
    ...over,
  } as RealRaceApi;
}

/** A fake IndexedDB (f1-game real-race.test.mjs:858-877 traceIdb): one store, async requests, counted opens/closes/puts; values cloned like the real thing. */
function traceIdb(seed: [string, unknown][] = []) {
  const rows = new Map<string, unknown>(seed), stats = { opens: 0, closes: 0, puts: [] as string[] };
  const dbs: { onversionchange?: () => void; closed?: boolean }[] = [];
  const later = (fn: () => void): void => { setTimeout(fn, 0); };
  const req = (fn: () => unknown): Record<string, unknown> => { const r: Record<string, unknown> = {}; later(() => { r["result"] = fn(); (r["onsuccess"] as (() => void) | undefined)?.(); }); return r; };
  const idb = { stats, rows, dbs, open() {
    stats.opens++;
    const db: Record<string, unknown> & { closed?: boolean } = { objectStoreNames: { contains: () => true }, close() { stats.closes++; db.closed = true; }, transaction() {
      let pending = 0;
      const t: Record<string, unknown> = {};
      const done = (): void => { if (--pending === 0) later(() => (t["oncomplete"] as (() => void) | undefined)?.()); };
      const op = (fn: () => unknown): Record<string, unknown> => { pending++; const r = req(fn); later(() => later(done)); return r; };
      t["abort"] = () => (t["onabort"] as (() => void) | undefined)?.();
      t["objectStore"] = () => ({ get: (k: string) => op(() => structuredClone(rows.get(k))), put: (v: unknown, k: string) => op(() => { stats.puts.push(k); rows.set(k, structuredClone(v)); return k; }),
        delete: (k: string) => op(() => { rows.delete(k); }), getAllKeys: () => op(() => [...rows.keys()]) });
      return t;
    } };
    dbs.push(db as { onversionchange?: () => void });
    const r: Record<string, unknown> = { result: db }; later(() => (r["onsuccess"] as (() => void) | undefined)?.()); return r;
  } };
  return idb as typeof idb & TraceIdbFactory;
}

describe("the script cache (localStorage)", () => {
  it("round-trips and rejects a stale shape", () => {
    const storage = new MemoryStorage();
    const cache = createRealRaceCache({ api: stubApi(), storage, indexedDB: null });
    expect(cache.cached(11377)).toBe(null);
    const s = build(rawBaku(), findTeam, TRACKS);
    storage.setItem(CACHE_KEY + "11377", JSON.stringify(s));
    expect(cache.cached(11377)!.laps).toBe(51);
    storage.setItem(CACHE_KEY + "11377", JSON.stringify({ v: 1, laps: 51, drivers: [], complete: true }));
    expect(cache.cached(11377), "an older script version is refetched").toBe(null);
    storage.setItem(CACHE_KEY + "11377", "{not json");
    expect(cache.cached(11377)).toBe(null);
    expect(CACHE_KEY.startsWith("a26."), "apex-26's own namespace (f1-game owns apex26.*)").toBe(true);
  });

  // One script per watched session (~45 KB) with no eviction filled the 5 MB origin
  // quota after ~115 sessions and starved every save: the cache keeps the newest
  // CACHE_MAX, most recently used first, and prunes any written before the index.
  it("keeps only the newest CACHE_MAX sessions, LRU by use", () => {
    const storage = new MemoryStorage();
    const cache = createRealRaceCache({ api: stubApi(), storage, indexedDB: null });
    const base = plain(build(rawBaku(), findTeam, TRACKS));
    for (let i = 0; i < 5; i++) storage.setItem(CACHE_KEY + "legacy" + i, JSON.stringify(base));   // written before the index existed
    storage.setItem("a26.settings", "{}");
    const scripts = (): string[] => [...storage.map.keys()].filter((k) => k.startsWith(CACHE_KEY));
    for (let i = 0; i < 200; i++) {
      cache.remember({ ...base, sessionKey: 1000 + i });
      expect(scripts().length <= CACHE_MAX, "at most CACHE_MAX scripts after write " + i).toBe(true);
    }
    expect(scripts().length).toBe(CACHE_MAX);
    expect(scripts().some((k) => k.includes("legacy")), "pre-index scripts are pruned").toBe(false);
    expect(storage.map.has(CACHE_KEY + "1199") && !storage.map.has(CACHE_KEY + "1191")).toBe(true);
    // a cache hit is a use: the oldest kept session survives the next write, the next-oldest goes
    expect(cache.cached(1192)!.laps).toBe(51);
    cache.remember({ ...base, sessionKey: 2000 });
    expect(storage.map.has(CACHE_KEY + "1192"), "the session just read is kept").toBe(true);
    expect(storage.map.has(CACHE_KEY + "1193"), "the least recently used one is evicted").toBe(false);
    expect(storage.getItem("a26.settings"), "other keys are untouched").toBe("{}");
  });

  it("forgetRaw drops the cached bodies of an unfinished race and leaves other sessions' alone", () => {
    const storage = new MemoryStorage();
    const cache = createRealRaceCache({ api: stubApi(), storage, indexedDB: null });   // no api.forget: the transport's keys directly
    storage.setItem("a26.api.https://api.openf1.org/v1/session_result?session_key=11377", "{}");
    storage.setItem("a26.api.https://api.openf1.org/v1/laps?session_key=11377", "{}");
    storage.setItem("a26.api.https://api.openf1.org/v1/weather?session_key=11373", "{}");
    cache.forgetRaw(11377);
    expect([...storage.map.keys()]).toEqual(["a26.api.https://api.openf1.org/v1/weather?session_key=11373"]);
    const forgot: string[] = [];
    createRealRaceCache({ api: stubApi({ forget: (u) => { forgot.push(u); } }), storage, indexedDB: null }).forgetRaw(7);
    expect(forgot.length, "api.forget clears memory and storage for every raw path").toBe(11);
  });

  it("fetchRaw asks the eleven bodies of the session, the laps uncached, and names the weekend from its meeting", async () => {
    const raw = rawBaku();
    const requested: { url: string; opts: unknown }[] = [];
    const api = stubApi({
      request: <T,>(url: string, _ttl: number, opts?: { cache?: boolean }): Promise<T> => { requested.push({ url, opts }); return Promise.resolve((url.includes("/sessions?") ? [{ ...raw.session, meeting_name: undefined }] : url.includes("/laps?") ? raw.laps : []) as T); },
      meetings: () => Promise.resolve([{ meetingKey: 1295, name: "Azerbaijan Grand Prix", country: null, circuit: null, dateStart: null, cancelled: false }]),
    });
    const got = await createRealRaceCache({ api, storage: null, indexedDB: null }).fetchRaw(11377);
    expect(requested.length).toBe(11);
    expect(requested.every((r) => r.url.includes("session_key=11377"))).toBe(true);
    expect(requested.find((r) => r.url.includes("/laps?"))!.opts, "the 480 KB laps body is fetched uncached").toEqual({ cache: false });
    expect(got.session!.meeting_name).toBe("Azerbaijan Grand Prix");
    await createRealRaceCache({ api, storage: null, indexedDB: null }).fetchRaw(11377, true);
    expect(requested.slice(11).every((r) => (r.opts as { cache?: boolean }).cache === false), "a refresh bypasses every cached body").toBe(true);
  });
});

describe("the real positions (IndexedDB a26.replay)", () => {
  it("real position retries retain successful cars, report partial failures, and never mix race sessions", async () => {
    const requested: [unknown, unknown][] = [], progress: [number, number][] = [];
    let rejectSecond = true;
    const t0 = Date.parse("2026-09-20T11:00:00Z");
    const cache = createRealRaceCache({ api: stubApi({ locationData: async (session, num) => {
      requested.push([session, num]);
      if (num === 2 && rejectSecond) throw new Error("network interrupted");
      return Array.from({ length: 102 }, (_, i) => ({ date: t0 + i * 1000, x: 100 + i, y: 200 + i }));
    } }), storage: null, indexedDB: null });
    const script = S({ sessionKey: 7, t0, drivers: [{ num: 1, lapStart: [0], laps: [30] }, { num: 2, lapStart: [0], laps: [30] }] });
    const partial = await cache.fetchTraces(script, (done, total) => progress.push([done, total]));
    expect(partial.failed).toEqual([2]);
    expect(partial.cars[1]!.length).toBe(306); expect(partial.cars[2]!.length).toBe(0);
    expect(progress, "progress reports stable totals despite a failed car request").toEqual([[1, 2], [2, 2]]);
    rejectSecond = false;
    const ready = await cache.fetchTraces(script, null, partial);
    expect(requested, "retry downloads only the failed driver").toEqual([[7, 1], [7, 2], [7, 2]]);
    expect(ready.cars[1], "the successful car's positions are retained").toBe(partial.cars[1]);
    expect(ready.cars[2]!.length).toBe(306); expect(ready.failed).toEqual([]);
    await cache.fetchTraces(S({ ...script, sessionKey: 8 }), null, ready);
    expect(requested.slice(-2), "another race gets its own positions").toEqual([[8, 1], [8, 2]]);
    rejectSecond = true;
    await expect(cache.fetchTraces(S({ ...script, drivers: [script.drivers[1]] })), "a completely failed load cannot masquerade as cached positions").rejects.toThrow(/positions did not load/);
  });

  it("position caches refresh when race coverage grows, and never persist unfinished timing", async () => {
    const idb = traceIdb(), records = idb.rows, requested: { num: unknown; end: string | null | undefined; options: unknown }[] = [];
    const t0 = Date.parse("2026-10-04T12:00:00Z");
    const script = (laps: number, complete: boolean): RaceScript => S({ sessionKey: 123, t0, complete,
      drivers: [{ num: 1, lapStart: Array.from({ length: laps }, (_, i) => i * 60), laps: Array<number>(laps).fill(60) }] });
    const cache = createRealRaceCache({ storage: null, indexedDB: idb, api: stubApi({ locationData: async (_key, num, _start, end, options) => {
      requested.push({ num, end, options });
      return Array.from({ length: 102 }, (_, i) => ({ date: t0 + (Date.parse(end!) - t0) * i / 101, x: 100 + i, y: 200 + i }));
    } }) });
    const early = await cache.fetchTraces(script(1, false));
    expect(early.cars[1]![303]).toBe(150);
    expect(records.size, "an unfinished race remains usable but is not persisted").toBe(0);
    // A legacy IndexedDB record is what existing players already have installed.
    records.set("123", { v: TRACE_V, sessionKey: 123, t0, cars: early.cars });
    const fullScript = script(10, true), full = await cache.fetchTraces(fullScript, null, early);
    expect(requested.length, "neither the legacy DB record nor incomplete in-memory retry wins").toBe(2);
    expect(full.cars[1]![303], "the complete race has its complete request window").toBe(690);
    expect(requested.every((r) => (r.options as { cache?: boolean }).cache === false), "raw HTTP cache cannot reintroduce truncated positions").toBe(true);
    await cache.fetchTraces(fullScript);
    expect(requested.length, "a completed matching cache avoids another download").toBe(2);
    await cache.fetchTraces(script(11, true));
    expect(requested.length, "a longer window invalidates even a formerly complete record").toBe(3);
    await cache.fetchTraces(S({ ...script(11, true), t0: t0 + 1000 }));
    expect(requested.length, "a corrected lights-out timestamp invalidates the old trace clock").toBe(4);
    const withDriver = S({ ...script(11, true), t0: t0 + 1000 });
    withDriver.drivers.push({ ...withDriver.drivers[0]!, num: 2 });
    await cache.fetchTraces(withDriver);
    expect(requested.slice(-2).map((r) => r.num), "a newly published driver invalidates the old roster").toEqual([1, 2]);
  });

  it("fetchTraces never caches a set with a failed request (a hub closed mid-load, a dropped connection)", async () => {
    const idb = traceIdb();
    let locate: RealRaceApi["locationData"] = () => Promise.reject(new Error("cancelled"));
    const cache = createRealRaceCache({ storage: null, indexedDB: idb, api: stubApi({ locationData: (...a) => locate(...a) }) });
    const base = build(rawBaku(), findTeam, TRACKS);
    const s = { ...base, t0: Date.UTC(2026, 8, 20, 11), drivers: base.drivers.slice(0, 3).map((d) => ({ ...d, lapStart: [0], laps: [90] })) };
    await expect(cache.fetchTraces(s), "every request failed: an error, not an empty replay").rejects.toThrow(/did not load/);
    const dense = Array.from({ length: 181 }, (_, i) => ({ date: s.t0 + i * 500, x: i * 10, y: i * 5 }));
    let n = 0;
    locate = () => (n++ === 0 ? Promise.reject(new Error("cancelled")) : Promise.resolve(dense));
    const part = await cache.fetchTraces(s);
    expect(Object.keys(part.cars).length, "a partial set is still handed back for this session").toBe(3);
    expect(idb.stats.puts, "…but never cached").toEqual([]);
    expect(part.complete).toBe(false);
    expect(part.failed!.length, "only the rejected driver's timing is unavailable").toBe(1);
    locate = () => Promise.resolve(dense);
    const full = await cache.fetchTraces(s, null, part);
    expect(full.complete).toBe(true);
    expect(full.cars[s.drivers[1]!.num], "retry retains successful peers").toBe(part.cars[s.drivers[1]!.num]);
    expect(idb.stats.puts.filter((k) => k !== "__lru").length, "a complete set is cached").toBe(1);
  });

  // ~1.5 MB per watched race with no eviction, and every get/put opened its own
  // IDBDatabase that nothing closed. One memoised connection (closed on
  // versionchange, reopened after), and only the newest TRACE_MAX races kept.
  it("race traces share one IndexedDB connection and keep only the newest TRACE_MAX races", async () => {
    const idb = traceIdb([["legacy", { v: 1, sessionKey: "legacy", cars: {} }]]);   // a race stored before the order existed
    const cache = createRealRaceCache({ api: stubApi(), storage: null, indexedDB: idb });
    const N = TRACE_MAX + 3;
    for (let i = 0; i < N; i++) {
      expect(await cache.tracePut({ v: TRACE_V, sessionKey: 500 + i, t0: 1, hz: 2, complete: true, cars: { 1: Float32Array.from(Array.from({ length: 306 }, (_, n) => n)) }, failed: [] })).toBe(true);
      expect(await cache.traceGet(500 + i), "the race just stored reads back").toBeTruthy();
    }
    const races = [...idb.rows.keys()].filter((k) => k !== "__lru");
    expect(races.length, "at most TRACE_MAX races are kept").toBe(TRACE_MAX);
    expect(!idb.rows.has("legacy") && !idb.rows.has("500") && idb.rows.has(String(500 + N - 1)), "the oldest go first").toBe(true);
    expect(idb.stats.opens, N * 2 + " reads and writes share one connection").toBe(1);
    expect(idb.stats.closes).toBe(0);
    idb.dbs[0]!.onversionchange!();   // another tab upgrades the DB: let go, and reopen on the next use
    expect(idb.stats.closes).toBe(1);
    expect(await cache.traceGet(500 + N - 1)).toBeTruthy();
    expect(idb.stats.opens).toBe(2);
  });

  it("reading an old trace cache refreshes recency before capacity eviction", async () => {
    const idb = traceIdb(), records = idb.rows, requested: unknown[] = [];
    const t0 = 100000;
    const script = (sessionKey: number): RaceScript => S({ sessionKey, t0, complete: true, drivers: [{ num: 1, laps: [120], lapStart: [0] }] });
    const cache = createRealRaceCache({ storage: null, indexedDB: idb, api: stubApi({ locationData: async (key) => { requested.push(key); return positionRows(script(key as number)); } }) });
    for (let k = 1; k <= 8; k++) await cache.fetchTraces(script(k));
    const old = records.get("1"); await cache.fetchTraces(script(1));
    await cache.fetchTraces(script(9));
    expect(records.get("1"), "reading recency does not rewrite the large body").toBe(old);
    expect(records.has("2"), "the unread oldest race is evicted").toBe(false);
    expect(requested).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("empty and two-point location responses cannot become a complete replay cache", async () => {
    const t0 = Date.parse("2026-09-20T11:00:00Z");
    const script = S({ sessionKey: 7, t0, complete: true, drivers: [{ num: 1, laps: [60], lapStart: [0] }, { num: 2, dns: true, laps: [], lapStart: [] }] });
    let rows: { date: number; x: number; y: number }[] = [];
    const requests: unknown[] = [];
    const cache = createRealRaceCache({ storage: null, indexedDB: null, api: stubApi({ locationData: async (_, num) => { requests.push(num); return rows; } }) });
    await expect(cache.fetchTraces(script)).rejects.toThrow(/positions did not load/);
    rows = [{ date: t0, x: 0, y: 0 }, { date: t0 + 1000, x: 100, y: 100 }];
    await expect(cache.fetchTraces(script)).rejects.toThrow(/positions did not load/);
    rows = Array.from({ length: 102 }, (_, i) => ({ date: t0 + i * 1000, x: i * 10, y: i * 10 }));
    expect((await cache.fetchTraces(script)).complete).toBe(true);
    expect(requests, "DNS is exempt and unavailable responses retry").toEqual([1, 1, 1]);
  });

  it("a dense winner cannot permanently cache a full-distance peer's sparse positions", async () => {
    const t0 = 100000, requests: unknown[] = []; let sparse = true;
    const script = S({ sessionKey: 8, t0, complete: true, drivers: [1, 2].map((num) => ({ num, lapStart: [0], laps: [600] })) });
    const cache = createRealRaceCache({ storage: null, indexedDB: null, api: stubApi({ locationData: async (_, num) => {
      requests.push(num); return Array.from({ length: num === 2 && sparse ? 2 : 102 }, (_, i) => ({ date: t0 + i * 600000 / 101, x: i * 10, y: i * 10 }));
    } }) });
    const partial = await cache.fetchTraces(script);
    expect(partial.complete).toBe(false); expect(partial.failed).toEqual([2]);
    sparse = false; const full = await cache.fetchTraces(script, null, partial);
    expect(full.complete).toBe(true); expect(requests).toEqual([1, 2, 2]);
  });

  it("dense truncated WATCH windows remain retryable, including matching memory records", async () => {
    const t0 = 100000, script = S({ sessionKey: 91, t0, complete: true,
      drivers: [{ num: 1, lapStart: [0], laps: [600] }, { num: 2, lapStart: [0], laps: [30], retired: true }] });
    let from = 0, until = 600, calls = 0;
    const cache = createRealRaceCache({ storage: null, indexedDB: null, api: stubApi({ locationData: async (_, num) => {
      calls++;
      const end = num === 2 ? 30 : until, start = num === 2 ? 0 : from;
      return Array.from({ length: 102 }, (_, i) => ({ date: t0 + (start + (end - start) * i / 101) * 1000, x: 100 + i, y: 200 + i }));
    } }) });
    const full = await cache.fetchTraces(script);
    expect(full.complete, "a genuine early retirement only needs its own distance").toBe(true);
    for (const [start, end] of [[0, 101], [100, 600], [100, 201]] as const) {
      from = start; until = end;
      const partial = await cache.fetchTraces(script);
      expect(partial.complete).toBe(false);
      expect(partial.failed).toEqual([1]);
      from = 0; until = 600;
      const before = calls;
      const repaired = await cache.fetchTraces(script, null, partial);
      expect(repaired.complete).toBe(true);
      expect(calls - before, "only the truncated car is refetched").toBe(1);
    }
    const corrupt: Traces = { ...full, cars: { ...full.cars, 1: full.cars[1]!.slice(0, 306) } };
    // Preserve enough samples to defeat a count-only check, but corrupt its clock.
    for (let i = 0; i < corrupt.cars[1]!.length; i += 3) corrupt.cars[1]![i]! /= 6;
    const before = calls;
    expect((await cache.fetchTraces(script, null, corrupt)).complete).toBe(true);
    expect(calls > before, "matching coverage metadata cannot bless truncated old memory").toBe(true);
  });

  it("a matching complete IndexedDB record still needs actual per-driver temporal coverage", async () => {
    const idb = traceIdb(), records = idb.rows;
    const script = S({ sessionKey: 93, t0: 100000, complete: true, drivers: [{ num: 1, lapStart: [0], laps: [600] }] });
    let requests = 0;
    const cache = createRealRaceCache({ storage: null, indexedDB: idb, api: stubApi({ locationData: async () => { requests++; return positionRows(script); } }) });
    await cache.fetchTraces(script);
    const saved = records.get("93") as Traces;
    for (let i = 0; i < saved.cars[1]!.length; i += 3) saved.cars[1]![i]! /= 6;
    await cache.fetchTraces(script);
    expect(requests, "a legacy count-only complete record is repaired by a real download").toBe(2);
    await cache.fetchTraces(script);
    expect(requests, "the repaired record is reusable").toBe(2);
  });
});

// ── real-race-tab-gap-refresh.test.mjs ──────────────────────────────────────

function gapScript(): RaceScript {
  const t0 = 1_000_000;
  return S({
    v: SCRIPT_V, sessionKey: 2465, t0, complete: true, laps: 1, name: "Gap Grand Prix", session: "Race",
    weather: "dry", circuit: "Monza", country: "Italy", trackId: "monza", year: 2026,
    cautions: [{ level: 4, from: 1, to: 1, cause: "RED FLAG", tFrom: 50, tTo: 550 }],
    drivers: [
      { num: 1, code: "STL", name: "Stale", team: "A", grid: 1, pos: 1, stints: [], pits: [], lapStart: [0], laps: [600] },
      { num: 2, code: "PIT", name: "Pit", team: "B", grid: 2, pos: 2, stints: [], pits: [1], pitT: [50], pitDur: [500], lapStart: [0], laps: [600] },
      { num: 3, code: "RED", name: "Red", team: "C", grid: 3, pos: 3, stints: [], pits: [], lapStart: [0], laps: [600] },
    ],
  });
}
/** 0..50 and 550..600: 102 samples, one interior hole. Dense is one sample per second. */
function gapRows(num: unknown, repair: boolean): { date: number; x: number; y: number }[] {
  const hole = num !== 1 || !repair;
  const ts = hole ? [...Array(51).keys(), ...Array.from({ length: 51 }, (_, i) => 550 + i)] : Array.from({ length: 601 }, (_, i) => i);
  return ts.map((t) => ({ date: 1_000_000 + t * 1000, x: 100 + t, y: 200 + t }));
}

describe("WATCH recording gaps (#2465)", () => {
  it("explicit refresh replaces a stale interior gap and keeps pit and red-flag gaps", async () => {
    const idb = traceIdb(), records = idb.rows, requests: { num: unknown; options: unknown }[] = [];
    let repair = false, rejectStale = false;
    const script = gapScript();
    const cache = createRealRaceCache({ storage: null, indexedDB: idb, api: stubApi({ locationData: async (_key, num, _s, _e, options) => {
      requests.push({ num, options });
      if (rejectStale && num === 1) throw new Error("offline");
      return gapRows(num, repair);
    } }) });
    const first = await cache.fetchTraces(script);
    expect(first.complete, "an interior hole is still a usable recording, including a pit stop and a red flag").toBe(true);
    const gapsOf = (tr: Traces, num: number): unknown => plain(traceDetails(script, tr).find((d) => d.num === num)!.gaps);
    expect(gapsOf(first, 1), "the stale hole is disclosed").toEqual([[50, 550]]);
    expect(gapsOf(first, 2), "the pit-stop hole is kept").toEqual([[50, 550]]);
    expect(gapsOf(first, 3), "the red-flag hole is kept").toEqual([[50, 550]]);
    expect(first.failed).toEqual([]);
    const cachedTr = await cache.fetchTraces(script, null, first);
    expect(requests.length, "a later open reuses the persisted recording").toBe(3);
    expect(gapsOf(cachedTr, 1)).toEqual([[50, 550]]);
    repair = true;
    const fixed = await cache.fetchTraces(script, null, first, { refresh: true });
    expect(requests.length, "refresh asks the API again for every car").toBe(6);
    expect(requests.slice(3).every((r) => (r.options as { cache?: boolean }).cache === false), "refresh bypasses the raw API cache").toBe(true);
    expect(gapsOf(fixed, 1), "the repaired feed replaces the stale hole").toEqual([]);
    expect(gapsOf(fixed, 2), "refresh does not invent positions across a pit stop").toEqual([[50, 550]]);
    expect(gapsOf(fixed, 3), "refresh does not invent positions across a red flag").toEqual([[50, 550]]);
    expect(fixed.complete).toBe(true);
    expect(gapsOf(records.get("2465") as Traces, 1), "the repaired recording replaces the persisted one").toEqual([]);
    await cache.fetchTraces(script);
    expect(requests.length, "the next open reuses the repaired recording").toBe(6);
    rejectStale = true;
    await expect(cache.fetchTraces(script, null, fixed, { refresh: true })).rejects.toThrow(/refresh did not load every car/);
    expect(gapsOf(records.get("2465") as Traces, 1), "a failed refresh leaves the playable recording in place").toEqual([]);
  });

  it("the positions control offers refresh while WATCH stays available", async () => {
    const idb = traceIdb();
    let requests = 0;
    const script = gapScript();
    const storage = new MemoryStorage();
    const api = tabApi({ locationData: async (_k, num) => { requests++; return gapRows(num, requests > 3); } });
    const cache = createRealRaceCache({ api, storage, indexedDB: idb });
    await cache.fetchTraces(script);
    cache.remember(script);
    const tab = create(tabDeps({ api, storage, indexedDB: idb, cache, tracks: [{ id: "monza", name: "MONZA", country: "Italy" }],
      port: { replay() { return null; }, launch: () => null, mapField: allSeats },
      sel: sel(sess(script.sessionKey!, "Race", "Race")) }));
    const tree = await tab.loadRealRace();
    document.body.replaceChildren(tree);   // the hub shows the node: a detached slot reads as a replaced view
    await flush(20);
    const buttons = [...tree.querySelectorAll("button")];
    const refresh = buttons.find((n) => n.textContent === "REFRESH POSITIONS · ABOUT 60 MB");
    expect(refresh, "a saved recording with an interior gap offers an explicit refresh").toBeTruthy();
    expect(refresh!.hidden).toBe(false);
    expect(refresh!.getAttribute("aria-label")).toMatch(/60 megabytes/);
    const watchBtn = buttons.find((n) => String(n.textContent).startsWith("WATCH FROM"));
    expect(watchBtn).toBeTruthy();
    expect(watchBtn!.disabled, "a pit or red-flag gap does not disable WATCH").toBe(false);
    const before = requests;
    refresh!.click();
    await tab.positionsSettled();
    expect(requests, "the refresh control downloads the field again").toBe(before + 3);
    expect(tab.traces()!.complete).toBe(true);
  });
});

// ── The tab (real-race-script.test.mjs harnesses, on happy-dom) ─────────────

type TabApi = RealRaceTabDeps["api"];
function tabApi(over: Partial<TabApi> = {}): TabApi {
  return {
    request: () => Promise.reject(new Error("no network in this test")),
    meetings: () => Promise.resolve([]),
    sessionsForMeeting: () => Promise.resolve([]),
    locationData: () => Promise.reject(new Error("no positions in this test")),
    cancelAll: () => 0,
    placeLabel,
    ...over,
  } as TabApi;
}
function sess(sessionKey: number, name: string, type: string, meetingKey = 1295): Session {
  return { sessionKey, meetingKey, year: 2026, name, type, circuit: null, country: null, dateStart: null };
}
function sel(meta: Session | null): RealRaceTabDeps["sel"] {
  return { year: 2026, meetingKey: meta ? meta.meetingKey : null, sessionKey: meta ? meta.sessionKey : null, meta, selAt: 0, pinned: false };
}
const allSeats = (script: RaceScript): Seat[] => script.drivers.map((d, i) => ({ driverId: "t:" + i, num: d.num, teamId: "t", di: i }));
function tabDeps(over: Partial<RealRaceTabDeps> & { api: TabApi }): RealRaceTabDeps {
  return {
    el, clear,
    emptyMsg: (t) => el("div", "dh-empty", t),
    spinner: () => el("div", "dh-loading"),
    sel: sel(null),
    ensureSession: () => Promise.resolve(null),
    buildPicker: () => el("div", "dh-picker"),
    teamChip: (code) => el("span", "dh-codechip", code),
    fmtDateTime: (iso) => iso ?? "",
    findTeam,
    storage: new MemoryStorage(),
    indexedDB: null,
    tracks: TRACKS,
    port: null,
    ...over,
  };
}
const status = (tree: HTMLElement): HTMLElement => tree.querySelector<HTMLElement>("[role=status]")!;
const tdRows = (table: Element): HTMLTableRowElement[] => [...table.querySelectorAll("tr")].filter((r) => r.querySelector(":scope > td"));

describe("the WATCH & DRIVE tab", () => {
  it("the entry list, DRIVE AS, the race lap by lap, and JUMP IN at any lap in any seat", async () => {
    const launches: { script: RaceScript; opts: LaunchOptions }[] = [];
    const storage = new MemoryStorage();
    const raw = rawBaku();
    const bodyFor = (url: string): unknown => {
      if (url.includes("/sessions?")) return [raw.session];
      if (url.includes("/drivers?")) return raw.drivers;
      if (url.includes("/laps?")) return raw.laps;
      if (url.includes("/stints?")) return raw.stints;
      if (url.includes("/pit?")) return raw.pits;
      if (url.includes("/overtakes?")) return raw.overtakes;
      if (url.includes("/race_control?")) return raw.raceControl;
      if (url.includes("/weather?")) return raw.weather;
      if (url.includes("/session_result?")) return raw.result;
      if (url.includes("/position?")) return raw.positions;
      return [];
    };
    const requested: { url: string; opts: unknown }[] = [];
    const api = tabApi({
      request: <T,>(url: string, _ttl: number, opts?: { cache?: boolean }): Promise<T> => { requested.push({ url, opts }); return Promise.resolve(bodyFor(url) as T); },
      meetings: () => Promise.resolve([{ meetingKey: 1295, name: "Azerbaijan Grand Prix", country: null, circuit: null, dateStart: null, cancelled: false }]),
      sessionsForMeeting: () => Promise.resolve([sess(11373, "Qualifying", "Qualifying"), sess(11377, "Race", "Race")]),
    });
    const port: RealRacePort = { replay: () => null, launch: (script, opts) => { launches.push({ script, opts }); return { trackId: script.trackId, laps: opts.laps, seat: opts.seat!, startLap: opts.startLap }; },
      // Two seats for the test: Russell and Leclerc; every other driver has no roster seat.
      mapField: (script) => script.drivers.filter((d) => d.num === 63 || d.num === 16).map((d) => ({ driverId: d.teamId + ":0", num: d.num, teamId: d.teamId!, di: 0 })),
      cumTable: cumTableRef };
    let closed = 0;
    const tab = create(tabDeps({ api, storage, port, sel: sel(sess(11373, "Qualifying", "Qualifying")), close: () => { closed++; } }));
    const tree = await tab.loadRealRace();
    await flush(5);
    const laps = requested.find((r) => r.url.includes("/laps?"));
    expect(laps && (laps.opts as { cache?: boolean }).cache, "the 480 KB laps body is fetched uncached").toBe(false);
    expect(requested.some((r) => r.url.includes("/overtakes?")), "the passes are fetched").toBe(true);
    expect(requested.every((r) => r.url.includes("session_key=11377")), "the RACE session, not the qualifying the picker held").toBe(true);
    const tables = [...tree.querySelectorAll("table")];
    // Select by table meaning rather than its position among optional analysis cards.
    const entry = tables.find((t) => [...t.querySelectorAll("th")].some((th) => th.textContent === "GRID"))!;
    expect(entry, "the entry-list table").toBeTruthy();
    const rows = tdRows(entry);
    expect(rows.length).toBe(22);
    expect(rows[0]!.children[0]!.textContent).toBe("P1");
    expect(rows[0]!.children[4]!.textContent).toBe("P1");
    expect(rows[21]!.children[4]!.textContent).toBe("DNF L7");
    const pills = [...tree.querySelectorAll("button")].filter((b) => /LAPS/.test(b.textContent || ""));
    expect(pills.map((p) => p.textContent)).toEqual(["51 LAPS (FULL)", "26 LAPS", "10 LAPS", "5 LAPS"]);
    const buttons = [...entry.querySelectorAll("button")].filter((b) => b.textContent === "JUMP IN");
    expect(buttons.length, "only the drivers with a roster seat can be raced").toBe(2);
    const noSeat = [...entry.querySelectorAll("button")].filter((b) => b.disabled);
    expect(noSeat.length).toBe(20);
    expect(noSeat[0]!.textContent).toBe("no seat in this roster");
    expect(buttons[1]!.getAttribute("aria-label")).toBe("JUMP IN — race as Charles LECLERC");
    // DRIVE AS: the seated drivers, grid order.
    const picker = tree.querySelector("select[aria-label=DRIVER]")!;
    expect([...picker.children].map((o) => o.textContent)).toEqual(["P1 · RUS · George RUSSELL", "P2 · LEC · Charles LECLERC"]);
    const camera = tree.querySelector<HTMLSelectElement>("select[aria-label='WATCH CAMERA']")!;
    expect(camera, "WATCH camera has an accessible label").toBeTruthy();
    expect([...camera.options].map((o) => o.value)).toEqual(["auto", "side", "heli", "tcam", "chase"]);
    expect([...camera.options].find((o) => o.selected)!.value, "the TV director is the opening WATCH shot (js/race/broadcast.js)").toBe("auto");
    // LAP BY LAP: 51 rows naming the leader, what happened, the fastest, with a JUMP IN (START on lap 1).
    const lapTable = tables.find((t) => [...t.querySelectorAll("th")].some((th) => th.textContent === "WHAT HAPPENED"))!;
    expect(lapTable, "the lap-story table").toBeTruthy();
    const lapRows = tdRows(lapTable);
    expect(lapRows.length).toBe(51);
    expect(lapRows[0]!.children[0]!.textContent).toBe("L1");
    expect(lapRows[0]!.children[1]!.textContent).toBe("RUS");
    expect(lapRows[0]!.children[2]!.textContent).toMatch(/PIA passed LEC for P2/);
    expect(lapRows[0]!.children[3]!.textContent).toMatch(/^[A-Z]{3} 1:\d\d\.\d{3}$/);
    expect(lapRows[0]!.querySelector("button")!.textContent).toBe("START");
    for (const [index, action] of [[0, "START"], [1, "JUMP IN"]] as const) {
      expect(lapRows[index]!.querySelector("button")!.getAttribute("aria-label")).toBe(action + " at lap " + (index + 1));
    }
    expect(lapRows[7]!.children[2]!.textContent, "lap 8").toMatch(/STR OUT/);
    expect(lapRows[30]!.children[2]!.textContent, "lap 31").toMatch(/^SAFETY CAR/);
    expect(lapRows[30]!.children[2]!.textContent, "the stops under the safety car").toMatch(/pit: /);
    expect(lapRows[35]!.children[2]!.textContent, "lap 36").toMatch(/NOR OUT.*GAS OUT|GAS OUT.*NOR OUT/);
    // Opening a lap builds its classification on demand: gaps, intervals, lap times, sets, the cars out.
    const nested = (): HTMLTableElement[] => [...lapTable.querySelectorAll("table")];
    expect(nested().length).toBe(0);
    const row31 = lapRows[30]!;
    const key = (target: Element, k: string): boolean => {
      const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    for (const target of row31.querySelectorAll("button")) {
      for (const k of ["Enter", " "]) {
        expect(key(target, k), "nested launch buttons retain native " + k + " activation").toBe(false);
        expect(row31.getAttribute("aria-expanded"), "button keys never toggle the lap classification").toBe("false");
      }
    }
    row31.click();
    const board = nested()[0];
    expect(board, "the lap-31 board").toBeTruthy();
    expect(row31.getAttribute("aria-expanded")).toBe("true");
    for (const [k, expanded] of [[" ", "false"], ["Enter", "true"]] as const) {
      expect(key(row31, k), "the lap row itself still owns its activation keys").toBe(true);
      expect(row31.getAttribute("aria-expanded")).toBe(expanded);
    }
    const watchButton = [...row31.querySelectorAll("button")].find((b) => b.textContent === "WATCH")!;
    for (const k of ["Enter", " "]) expect(key(watchButton, k), "descendant keyboard defaults must remain available").toBe(false);
    expect(row31.getAttribute("aria-expanded")).toBe("true");
    const boardRows = tdRows(board!);
    expect(boardRows.length).toBe(22);
    expect(boardRows[0]!.children[0]!.textContent).toBe("P1"); expect(boardRows[0]!.children[1]!.textContent).toBe("RUS"); expect(boardRows[0]!.children[2]!.textContent).toBe("");
    expect(boardRows[1]!.children[2]!.textContent, "P2 carries a gap").toMatch(/^\+\d+\.\d{3}$/);
    expect(boardRows[0]!.children[5]!.textContent).toBe("M");
    expect(boardRows[0]!.children[6]!.textContent, "Russell's in-lap").toBe("IN");
    expect(boardRows[21]!.children[0]!.textContent).toBe("OUT");
    expect(boardRows[21]!.children[1]!.textContent).toBe("STR");
    expect(boardRows[21]!.children[2]!.textContent).toBe("L7");
    // JUMP IN on lap 31 as the DRIVE AS pick (Leclerc); the row click does not fire from the button.
    tab.setSeat("LEC");
    row31.querySelector("button")!.click();
    expect(row31.getAttribute("aria-expanded"), "the button's click stops at the button").toBe("true");
    expect(closed, "the hub closes before the race starts").toBe(1);
    expect(launches.length).toBe(1);
    expect(launches[0]!.opts.seat).toBe("LEC");
    expect(launches[0]!.opts.laps).toBe(51);
    expect(launches[0]!.opts.startLap).toBe(31);
    expect(launches[0]!.opts.intro).toBe(true);
    expect(launches[0]!.script.trackId).toBe("baku");
    expect(storage.map.has(CACHE_KEY + "11377"), "the compact script is remembered").toBe(true);
    // An entry-list JUMP IN starts from the grid in that driver's seat; a condensed distance changes only the lap count.
    tab.setDistance(0.2);
    tab.setStartLap(1);
    buttons[0]!.click();
    expect(launches[1]!.opts.laps).toBe(10);
    expect(launches[1]!.opts.startLap).toBe(1);
    expect(launches[1]!.opts.seat).toBe("RUS");
  });

  function pendingWatchHarness() {
    const requests: ((rows: { date: number; x: number; y: number }[]) => void)[] = [], launches: { script: RaceScript; opts: LaunchOptions }[] = [];
    let opened = true;
    // cancelAll: cancel() drops a download's queued requests (a no-op here, so
    // the stale completions below still arrive and must be discarded).
    const api = tabApi({ locationData: () => new Promise((resolve) => requests.push(resolve)) });
    const port: RealRacePort = { launch: (script, opts) => { launches.push({ script, opts }); return true; }, mapField: allSeats };
    const tab = create(tabDeps({ api, port, ensureSession: () => new Promise(() => {}), isOpen: () => opened, close: () => { opened = false; tab.cancel(); } }));
    const script = (sessionKey: number): RaceScript => S({ sessionKey, laps: 2, t0: Date.parse("2026-01-01T00:00:00Z"),
      drivers: [{ num: 1, lapStart: [null, 0, 60], laps: [null, 60, 60] }] });
    return { tab, requests, launches, script, reopen: () => { opened = true; } };
  }

  it("pending WATCH snapshots its seat, camera, session and lap before positions arrive", async () => {
    const h = pendingWatchHarness(), script = h.script(10);
    h.tab.setSeat("AAA"); h.tab.setWatchCamera("heli");
    expect(h.tab.watch(script, null, 2, true)).toBe(true);
    await flush();
    expect(h.requests.length).toBe(1);
    h.tab.setSeat("BBB"); h.tab.setWatchCamera("chase"); h.tab.setStartLap(1);
    h.requests[0]!(positionRows(script));
    await flush();
    expect(h.launches.length).toBe(1);
    const launch = h.launches[0]!;
    expect(launch.script.sessionKey).toBe(10);
    expect(launch.opts).toMatchObject({ seat: "AAA", camera: "heli", startLap: 2, reel: true, watch: true, intro: true });
  });

  it("cancel/reopen and session replacement discard stale WATCH completions", async () => {
    const h = pendingWatchHarness();
    h.tab.watch(h.script(10), null, 1, false);
    await flush();
    h.tab.cancel(); h.reopen();
    h.tab.watch(h.script(11), null, 2, false);
    await flush();
    expect(h.requests.length).toBe(2);
    h.requests[0]!(positionRows(h.script(10))); await flush();
    expect(h.launches.length).toBe(0);
    expect(h.tab.traces(), "stale positions must not replace current state").toBe(null);
    h.requests[1]!(positionRows(h.script(11))); await flush();
    expect(h.launches.length).toBe(1);
    expect(h.launches[0]!.script.sessionKey).toBe(11);
    const second = pendingWatchHarness();
    second.tab.watch(second.script(20), null, 1, false);
    await flush();
    void second.tab.loadRealRace(); // a newly selected session invalidates in-flight work
    second.requests[0]!([]); await flush();
    expect(second.launches.length).toBe(0);
  });

  it("WATCH downloads cannot launch a replaced view and keep the seat selected when requested", async () => {
    for (const detached of [true, false]) {
      let resolveLocation: ((rows: { date: number; x: number; y: number }[]) => void) | null = null, open = true, closed = 0;
      const launches: LaunchOptions[] = [];
      const tab = create(tabDeps({ api: tabApi({ locationData: () => new Promise((resolve) => { resolveLocation = resolve; }) }),
        port: { launch: (_s, options) => { launches.push(options); return true; }, mapField: allSeats },
        isOpen: () => open, close: () => { closed++; open = false; } }));
      const slot = el("div"); document.body.appendChild(slot);
      const script = S({ sessionKey: 1, t0: 100000, laps: 1, drivers: [{ num: 1, lapStart: [0], laps: [30] }] });
      tab.setSeat("AAA"); tab.watch(script, slot, 1, false);
      await flush();
      expect(typeof resolveLocation).toBe("function");
      tab.setSeat("BBB");
      if (detached) slot.remove();
      resolveLocation!(Array.from({ length: 102 }, (_, i) => ({ date: 100000 + i * 1000, x: i * 10, y: i * 10 })));
      await flush(3);
      expect(closed).toBe(detached ? 0 : 1);
      expect(launches.length).toBe(detached ? 0 : 1);
      if (!detached) expect(launches[0]!.seat).toBe("AAA");
      slot.remove();
    }
  });

  async function launchRecoveryHarness(failPositions = false) {
    const storage = new MemoryStorage(), launches: { script: RaceScript; opts: LaunchOptions; opened: boolean }[] = [], order: string[] = [];
    let opened = true, result: unknown = false, requests = 0;
    const built = build(rawBaku(), findTeam, TRACKS);
    built.drivers = built.drivers.slice(0, 1);
    const script = built;
    const api = tabApi({ locationData: () => {
      requests++;
      if (failPositions) return Promise.reject(new Error("offline"));
      return Promise.resolve(positionRows(script));
    } });
    createRealRaceCache({ api, storage, indexedDB: null }).remember(script);
    const port: RealRacePort = { replay: () => null, mapField: allSeats, launch: (s, opts) => {
      order.push("launch"); launches.push({ script: s, opts, opened });
      if (result instanceof Error) throw result;
      return result as boolean | null;
    } };
    const tab = create(tabDeps({ api, storage, port, sel: sel(sess(script.sessionKey!, "Race", "Race")),
      isOpen: () => opened, close: () => { order.push("close"); opened = false; tab.cancel(); } }));
    const tree = await tab.loadRealRace(); document.body.replaceChildren(tree); await flush(3);
    const st = status(tree);
    expect(st, "the real replay status is rendered").toBeTruthy();
    return { tab, script, launches, order, status: st, tree,
      opened: () => opened, requests: () => requests, result: (v: unknown) => { result = v; } };
  }

  for (const cachedPositions of [false, true]) for (const throws of [false, true]) {
    it(`WATCH launch failures keep ${cachedPositions ? "cached" : "downloaded"} positions retryable in the open Hub (${throws ? "throw" : "refusal"})`, async () => {
      const h = await launchRecoveryHarness();
      if (cachedPositions) { h.tab.loadTraces(h.script, null, null); await flush(); }
      h.result(throws ? new Error("launch fixture failure") : null);
      expect(() => h.tab.watch(h.script, null, 1, true)).not.toThrow();
      await flush();
      expect(h.launches.length).toBe(1);
      expect(h.opened(), "a failed launch must not dismiss the Hub").toBe(true);
      expect(h.order).toEqual(["launch"]);
      expect(h.status.textContent).toMatch(/could not start.*try again/i);
      expect([...h.tree.querySelectorAll("button")].find((b) => b.textContent === "HIGHLIGHTS")!.disabled).toBe(false);
      const positions = h.tab.traces();
      expect(positions, "usable downloaded positions survive the failed launch").toBeTruthy();
      h.result({ watch: true });
      expect(h.tab.watch(h.script, null, 1, true)).toBe(true);
      expect(h.requests(), "retry launches with the loaded positions without another download").toBe(1);
      expect(h.launches[1]!.opts.traces).toBe(positions);
      expect(h.launches.every((l) => l.opened), "the launch is accepted before closing the Hub").toBe(true);
      expect(h.order).toEqual(["launch", "launch", "close"]);
      expect(h.opened()).toBe(false);
    });
  }

  for (const throws of [false, true]) {
    it(`JUMP IN launch ${throws ? "exception" : "refusal"} keeps its entry point open for retry`, async () => {
      const h = await launchRecoveryHarness();
      h.result(throws ? new Error("jump in fixture failure") : null);
      expect(h.tab.jumpIn(h.script, h.script.drivers[0]!.code)).toBe(false);
      expect(h.opened()).toBe(true);
      expect(h.status.textContent).toMatch(/could not start.*try again/i);
      h.result({ seat: h.script.drivers[0]!.code });
      expect(h.tab.jumpIn(h.script, h.script.drivers[0]!.code)).toBe(true);
      expect(h.order).toEqual(["launch", "launch", "close"]);
      expect(h.requests(), "driving does not require a positions download").toBe(0);
    });
  }

  it("positions accessible action follows LOAD and failed RETRY", async () => {
    const h = await launchRecoveryHarness(true);
    const button = [...h.tree.querySelectorAll("button")].find((b) => b.textContent === "LOAD POSITIONS")!;
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-label")).toMatch(/^LOAD POSITIONS/);
    button.click();
    await flush();
    expect(button.textContent).toBe("RETRY POSITIONS");
    expect(button.getAttribute("aria-label")).toMatch(/^RETRY POSITIONS/);
  });

  it("WATCH and JUMP IN reject stale in-memory coverage; reopening drops unfinished positions", async () => {
    const calls: unknown[] = [], launches: LaunchOptions[] = [];
    const t0 = Date.parse("2026-10-04T12:00:00Z");
    const api = tabApi({ locationData: async (_key, _num, _start, end) => {
      calls.push(end); return Array.from({ length: 102 }, (_, i) => ({ date: t0 + (Date.parse(end!) - t0) * i / 101, x: 100 + i, y: 200 + i }));
    } });
    const earlyScript = S({ sessionKey: 42, t0, complete: false, laps: 1, drivers: [{ num: 1, lapStart: [0], laps: [60] }] });
    const fullScript = S({ ...earlyScript, complete: true, laps: 10, drivers: [{ num: 1, lapStart: [0], laps: [600] }] });
    const early = await createRealRaceCache({ api, storage: null, indexedDB: null }).fetchTraces(earlyScript);
    const tab = create(tabDeps({ api, port: { launch: (_s, options) => { launches.push(options); return true; }, mapField: allSeats },
      isOpen: () => true, close: () => tab.cancel() }));
    tab.setTraces(early); tab.jumpIn(fullScript, "AAA");
    expect(launches.at(-1)!.traces, "JUMP IN never seeds cars from the earlier race window").toBe(null);
    tab.watch(fullScript, null, 1, false); await flush();
    expect(calls.length, "WATCH refetches instead of immediately launching stale memory").toBe(2);
    expect(launches.at(-1)!.traces!.cars[1]![303]).toBe(690);
    tab.watch(fullScript, null, 1, false); await flush();
    expect(calls.length, "matching completed memory still reuses positions").toBe(2);
    tab.setTraces(early); tab.jumpIn(earlyScript, "AAA");
    expect(launches.at(-1)!.traces, "JUMP IN captures usable incomplete positions before closing their view").toBe(early);
    expect(tab.traces(), "close/picker lifecycle cannot retain unfinished positions forever").toBe(null);
  });

  it("leaving the tab mid-download drops the queued position requests; a pick here re-renders the sibling tabs", async () => {
    // cancel() left ~20 /location requests in the transport's FIFO, so every
    // other tab queued behind a download nobody would watch; and the picker
    // changed the shared `sel` without telling LIVE / TELEMETRY / RESULTS.
    let cancels = 0;
    const invalidated: string[] = [];
    let onPick: ((meta: Session | null) => void) | null = null;
    const tab = create(tabDeps({ api: tabApi({ locationData: () => new Promise(() => {}), cancelAll: () => { cancels++; return 0; } }),
      buildPicker: (fn) => { onPick = fn; return el("div"); }, invalidateOther: (except) => invalidated.push(except), isOpen: () => true }));
    tab.cancel();
    expect(cancels, "nothing in flight: other tabs' requests are left alone").toBe(0);
    const base = build(rawBaku(), findTeam, TRACKS);
    const s = { ...base, t0: Date.UTC(2026, 8, 20, 11), drivers: base.drivers.slice(0, 3).map((d) => ({ ...d, lapStart: [0], laps: [90] })) };
    expect(tab.loadTraces(s, null, null), "the download started").toBe(true);
    tab.cancel();
    expect(cancels, "a download in flight is cancelled with the tab").toBe(1);
    await tab.loadRealRace();
    onPick!({ ...sess(0, "Race", "Race"), sessionKey: null });
    expect(invalidated, "a WATCH & DRIVE pick invalidates the other session tabs").toEqual(["race"]);
  });

  it("without a director the tab still reads the race, every seat is open, and JUMP IN reports it cannot start", async () => {
    const prev = registerRealRacePort(null);
    try {
      expect(realRacePort()).toBe(null);
      const storage = new MemoryStorage();
      const script = build(rawBaku(), findTeam, TRACKS);
      createRealRaceCache({ api: tabApi(), storage, indexedDB: null }).remember(script);
      const deps = tabDeps({ api: tabApi(), storage, sel: sel(sess(11377, "Race", "Race")) });
      delete deps.port;   // undefined: the registered port (none)
      const host = el("div");
      const mounted = mount(host, deps);
      await mounted.refresh(); await flush(3);
      expect(host.textContent).toMatch(/Real positions need a script with timestamps/);
      const entryButtons = [...host.querySelectorAll("button")].filter((b) => b.textContent === "JUMP IN");
      expect(entryButtons.length, "no mapField: every driver is offered").toBeGreaterThanOrEqual(22);
      // Registering a director later is picked up live.
      const launches: LaunchOptions[] = [];
      registerRealRacePort({ launch: (_s, o) => { launches.push(o); return true; }, mapField: allSeats });
      entryButtons[0]!.click();
      expect(launches.length).toBe(1);
      mounted.unmount();
      expect(host.childNodes.length).toBe(0);
    } finally { registerRealRacePort(prev); }
  });
});
