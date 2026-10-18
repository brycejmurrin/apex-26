// @vitest-environment happy-dom
/**
 * TELEMETRY tab (src/data/tabs/telemetry/). Assertions ported from f1-game
 * tests/unit/telemetry-trace.test.mjs, telemetry-view-resize.test.mjs and
 * lap-format-rollover.test.mjs:28-44, plus bit-exact comparison of the model
 * against f1-game's own js/data/telemetry-model.js (node:vm) on the recorded
 * Baku 2026 race lap 28 (session 11377, driver 1). No live network.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createF1Api, type CarSample, type F1Api, type Lap, type LocationSample, type PitStop, type Session, type SessionDriver, type Stint } from "../../../src/data/api";
import { setDataLog } from "../../../src/data/log";
import * as Controller from "../../../src/data/tabs/telemetry/controller";
import * as M from "../../../src/data/tabs/telemetry/model";
import { create as createPlayer } from "../../../src/data/tabs/telemetry/player";
import type { TelView } from "../../../src/data/tabs/telemetry/model";
import { el } from "../../../src/data/dom";
import { f1Global, hasF1 } from "./f1-vm";
import { fixtureFetch, MemoryStorage } from "./fixtures";
import { stubDeps } from "./hub-stub";

const ROUTES: [string, string][] = [
  ["/drivers?session_key=11377", "openf1-11377-drivers.json"],
  ["/laps?session_key=11377&driver_number=1", "openf1-11377-laps-1.json"],
  ["/car_data?session_key=11377&driver_number=1", "openf1-11377-car_data-1-lap28.json"],
  ["/location?session_key=11377&driver_number=1", "openf1-11377-location-1-lap28.json"],
  ["/stints?session_key=11377&driver_number=1", "openf1-11377-stints-1.json"],
  ["/pit?session_key=11377", "openf1-11377-pit.json"],
];
const META: Session = {
  sessionKey: 11377, meetingKey: 1295, year: 2026, name: "Race", type: "Race",
  circuit: "Baku", country: "Azerbaijan", dateStart: "2026-09-26T11:00:00+00:00",
};

setDataLog({ info: () => {}, warn: () => {} });

/* ---------- the recorded lap ---------- */

interface Lap28 { lap: Lap; car: CarSample[]; loc: LocationSample[]; stints: Stint[]; pits: PitStop[]; drivers: SessionDriver[] }
async function loadLap28(): Promise<Lap28> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  try {
    const api = createF1Api({ fetch: fixtureFetch(ROUTES), storage: new MemoryStorage() });
    const p = (async () => {
      const lap = await api.fastestLap(11377, 1);
      if (!lap || !lap.dateStart) throw new Error("no fastest lap in fixture");
      const car = await api.carData(11377, 1, lap.dateStart, null);
      const loc = await api.locationData(11377, 1, lap.dateStart, null);
      const stints = await api.stints(11377, 1);
      const pits = await api.pits(11377, 1);
      const drivers = (await api.sessionDrivers(11377)) ?? [];
      return { lap, car, loc, stints, pits, drivers };
    })();
    await vi.runAllTimersAsync();
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

let L: Lap28;
beforeAll(async () => { L = await loadLap28(); });

/* ---------- f1-game's model, evaluated in a VM ---------- */

type Fn = (...a: unknown[]) => unknown;
interface F1Model {
  cumDist: Fn; distAtT: Fn; timeAtDist: Fn; locAt: Fn; dropStrays: Fn; locBounds: Fn; gapLimitMs: Fn; isGap: Fn;
  brakingDuel: Fn; chanNorm: Fn; sampleAt: Fn; chartX: Fn; summaryTime: Fn; signed: Fn; sessionShort: Fn;
  CHANNELS: unknown[]; create(d: unknown): { driverColor: Fn; laneColors: Fn };
}
const ref = (): F1Model => f1Global(["js/data/tab-utils.js", "js/data/telemetry-model.js"], "DataTelemetryModel") as F1Model;

/** Deep equality with Object.is on every number (bit-exact, NaN and -0 aware). */
function same(a: unknown, b: unknown, path = "$"): void {
  if (typeof a === "number" || typeof b === "number") {
    if (!Object.is(a, b)) throw new Error(`${path}: ${String(a)} !== ${String(b)}`);
    return;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { expect(a, path).toBe(b); return; }
  const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
  expect(Object.keys(ra).sort(), path).toEqual(Object.keys(rb).sort());
  for (const k of Object.keys(ra)) same(ra[k], rb[k], path + "." + k);
}

const cloneCar = (car: CarSample[]): CarSample[] => car.map((c) => ({ ...c }));
const cloneLoc = (loc: LocationSample[]): LocationSample[] => loc.map((p) => ({ ...p }));

describe("telemetry model on the recorded lap", () => {
  it("fastest lap is lap 28 and the fixture covers it", () => {
    expect(L.lap.lapNumber).toBe(28);
    expect(L.car.length).toBeGreaterThan(300);
    expect(L.loc.length).toBeGreaterThan(300);
    const cum = M.cumDist(L.car);
    const total = cum.d[cum.d.length - 1] as number;
    // Baku is 6.003 km; the integrated speed trace lands within 3% of it.
    expect(Math.abs(total - 6003) / 6003).toBeLessThan(0.03);
    expect(M.distAtT(cum, 0)).toBe(0);
    expect(M.timeAtDist(cum, total)).toBe(cum.t[cum.t.length - 1]);
  });

  it("drsOpen reads OpenF1's open codes only", () => {
    for (const v of [10, 12, 14]) expect(M.drsOpen(v)).toBe(true);
    for (const v of [0, 1, 8, 9, 11, 13, null, undefined, "12"]) expect(M.drsOpen(v)).toBe(false);
    // the fixture lap carries no DRS (2026 rules): the channel is null throughout
    const drs = M.CHANNELS.find((c) => c.id === "drs") as M.Channel;
    expect(L.car.every((c) => M.chanNorm(drs, c, { speedMax: 1, rpmMax: 1 }) === null)).toBe(true);
  });

  it("lane roles name the trace and marker lanes", () => {
    expect([0, 1, 2, 3].map(M.laneRole)).toEqual(["PRIMARY TRACE", "COMPARISON TRACE", "SPEED MARKER", "SPEED MARKER"]);
  });

  it("summaryTime rounds before it splits; signed takes the sign from the rounded value", () => {
    expect(M.summaryTime(119.996)).toBe("2:00.00");
    expect(M.summaryTime(59.999)).toBe("1:00.00");
    expect(M.summaryTime(75.5)).toBe("1:15.50");
    expect(M.summaryTime(9.044)).toBe("0:09.04");
    expect(M.summaryTime(-1)).toBe("—");
    expect(M.summaryTime(L.lap.lapDuration)).toBe("1:47.76");
    expect(M.signed(-0.0003, 2)).toBe("+0.00");
    expect(M.signed(0.004, 2)).toBe("+0.00");
    expect(M.signed(-0.006, 2)).toBe("-0.01");
    expect(M.signed(0.12, 2)).toBe("+0.12");
    expect(M.signed(-1.234, 2)).toBe("-1.23");
    expect(M.summaryValue(301.6, " km/h")).toBe("302 km/h");
    expect(M.summaryValue(null, "%")).toBe("—");
    expect(M.sessionShort(META)).toBe("R");
    expect(M.sessionShort({ name: "Sprint Qualifying", type: "Qualifying" })).toBe("SQ");
    expect(M.sessionShort({ name: "Practice 2", type: "Practice" })).toBe("P2");
  });

  it("braking duel on the recorded lap finds Baku's T1 stop against a slower copy", () => {
    const a = { car: L.car, cum: M.cumDist(L.car) };
    const slowCar = L.car.map((c) => ({ ...c, speed: c.speed === null ? null : c.speed * 0.98 }));
    const b = { car: slowCar, cum: M.cumDist(slowCar) };
    // T1 is a 90-degree left at the end of the start/finish straight, ~600-800 m in.
    const r = M.brakingDuel(a, b, 300, 1100);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.lanes[0].brake).not.toBeNull();
    expect(r.lanes[0].throttle).not.toBeNull();
    expect((r.lanes[0].minSpeed as { value: number }).value).toBeLessThan(150);
    expect(r.change).toBeGreaterThan(0);   // the slower copy loses time through the zone
  });
});

describe.skipIf(!hasF1)("telemetry model is bit-exact with f1-game", () => {
  it("cumDist / distAtT / timeAtDist", () => {
    const R = ref();
    const mine = M.cumDist(L.car), theirs = R.cumDist(cloneCar(L.car)) as M.Cum;
    same(mine, theirs);
    const tMax = mine.t[mine.t.length - 1] as number, dMax = mine.d[mine.d.length - 1] as number;
    for (let i = -2; i <= 800; i++) {
      const t = i * tMax / 797, d = i * dMax / 797;
      same(M.distAtT(mine, t), R.distAtT(theirs, t), `distAtT(${t})`);
      same(M.timeAtDist(mine, d), R.timeAtDist(theirs, d), `timeAtDist(${d})`);
    }
    // an unknown-speed interval
    const holed = cloneCar(L.car); (holed[150] as CarSample).speed = null;
    same(M.cumDist(holed), R.cumDist(cloneCar(holed)));
  });

  it("locAt (own path and borrowed path), dateAtT through it", () => {
    const R = ref();
    const tMax = (L.car[L.car.length - 1] as CarSample).t;
    const mineLane = { car: L.car, loc: L.loc }, theirLane = { car: cloneCar(L.car), loc: cloneLoc(L.loc) };
    const view = { primary: mineLane, tMax }, tview = { primary: theirLane, tMax };
    const borrowed = { car: L.car.filter((_, i) => i % 2 === 0), loc: [] };
    const tborrowed = { car: cloneCar(borrowed.car), loc: [] };
    for (let i = -1; i <= 1000; i++) {
      const t = i * (tMax + 0.5) / 1000;
      same(M.locAt(view, mineLane, t), R.locAt(tview, theirLane, t), `locAt(${t})`);
      same(M.locAt(view, borrowed, t), R.locAt(tview, tborrowed, t), `borrowed locAt(${t})`);
    }
  });

  it("dropStrays / locBounds / gapLimitMs / isGap", () => {
    const R = ref();
    const withStray = cloneLoc(L.loc).concat([{ x: -90000, y: 120000, date: (L.loc[L.loc.length - 1] as LocationSample).date + 270 }]);
    for (const loc of [L.loc, withStray, L.loc.slice(0, 20)]) {
      const mine = M.dropStrays(loc.slice()), theirs = R.dropStrays(cloneLoc(loc)) as LocationSample[];
      same(mine, theirs);
      same(M.locBounds(mine), R.locBounds(theirs));
      const lim = M.gapLimitMs(loc);
      same(lim, R.gapLimitMs(cloneLoc(loc)));
      for (let i = 1; i < loc.length; i++) same(M.isGap(loc, i, lim), R.isGap(cloneLoc(loc), i, lim));
    }
    expect(M.dropStrays(withStray).length).toBe(L.loc.length);
  });

  it("brakingDuel over many zones", () => {
    const R = ref();
    const slow = L.car.map((c) => ({ ...c, speed: c.speed === null ? null : c.speed * 0.97, t: c.t * 1.03 }));
    const a = { car: L.car, cum: M.cumDist(L.car) }, b = { car: slow, cum: M.cumDist(slow) };
    const ta = { car: cloneCar(L.car) }, tb = { car: cloneCar(slow) };
    for (const [from, to] of [[0, 300], [300, 1100], [1000, 1400], [2000, 2600], [3500, 4300], [5000, 5800], [0, 9000], [-1, 10], [50, 50], [NaN, 5]] as const) {
      same(M.brakingDuel(a, b, from, to), R.brakingDuel(ta, tb, from, to), `duel ${from}-${to}`);
    }
  });

  it("channels, sampleAt, labels and lane colours", () => {
    const R = ref();
    const view = { tMax: 107.4, speedMax: 340, rpmMax: 12500 };
    M.CHANNELS.forEach((ch, k) => {
      for (const c of L.car) same(M.chanNorm(ch, c, view), R.chanNorm(R.CHANNELS[k], { ...c }, view), ch.id);
    });
    for (let i = -3; i < 1200; i++) {
      const t = i * 0.0911;
      same(M.sampleAt(L.car, t), R.sampleAt(cloneCar(L.car), t), `sampleAt(${t})`);
      same(M.chartX(view, t, 330), R.chartX(view, t, 330));
    }
    for (const t of [0, 9.044, 59.999, 75.5, 107.761, 119.996, -1, NaN]) same(M.summaryTime(t), R.summaryTime(t));
    for (const v of [-0.0003, 0.004, -0.006, 1.2345, -12.5]) same(M.signed(v, 2), R.signed(v, 2));
    for (const s of [META, { name: "Sprint", type: "Race" }, { name: "Practice 3", type: "Practice" }, { name: "Qualifying", type: "Qualifying" }, null]) {
      same(M.sessionShort(s), R.sessionShort(s));
    }
    const findTeam = () => null;
    // two lanes per driver: repeats of a colour get lightened
    const entries = L.drivers.concat(L.drivers.slice(0, 3)).map((d) => ({ d }));
    same(M.create({ findTeam }).laneColors(entries), R.create({ findTeam }).laneColors(entries.map((e) => ({ d: { ...e.d } }))));
  });
});

/* ---------- synthetic laps (telemetry-trace.test.mjs) ---------- */

function brakeLane(speed: number) {
  const car = Array.from({ length: 41 }, (_, i) => ({ t: i / 4, speed, brake: i < 10 ? 0 : i < 22 ? 50 : 0, throttle: i < 10 ? 100 : i < 28 ? 20 : 100 }) as { t: number; speed: number; brake: number | null; throttle: number });
  return { car, cum: M.cumDist(car) };
}

describe("braking duel (telemetry-trace.test.mjs:30-48)", () => {
  it("aligns distance and refuses clamped or missing feed intervals", () => {
    const a = brakeLane(36), b = brakeLane(45), r = M.brakingDuel(a, b, 0, 90);
    expect(r.available).toBe(true);
    if (!r.available) return;
    expect(r.lanes[0].brake).toBeTruthy(); expect(r.lanes[0].throttle).toBeTruthy();
    expect((r.lanes[0].brake as M.DuelPoint).distance).toBeLessThan((r.lanes[1].brake as M.DuelPoint).distance);
    expect(Math.abs(r.change + 1.8)).toBeLessThan(1e-9);
    expect(M.brakingDuel(a, b, 0, 110).available).toBe(false);
    const missing = brakeLane(36); (missing.car[12] as { brake: number | null }).brake = null;
    expect(M.brakingDuel(missing, b, 0, 90).available).toBe(false);
    const gap = brakeLane(36); gap.car.splice(10, 10); gap.cum = M.cumDist(gap.car);
    const gr = M.brakingDuel(gap, b, 0, 90);
    expect(gr.available ? "" : gr.reason).toMatch(/gap/);
    const flat = brakeLane(36); flat.car.forEach((c) => { c.brake = 0; c.throttle = 100; });
    const absent = M.brakingDuel(flat, b, 0, 90);
    expect(absent.available).toBe(true);
    if (absent.available) { expect(absent.lanes[0].brake).toBeNull(); expect(absent.lanes[0].throttle).toBeNull(); }
    (flat.car[12] as { brake: number | null }).brake = 50;
    const noisy = M.brakingDuel(flat, b, 0, 90);
    expect(noisy.available && noisy.lanes[0].brake, "one noisy feed sample must not become two grid hits").toBeNull();
  });
});

// A closed, oval-ish lap in track-local units at ~3.7 Hz, like the real feed.
function ovalLap(n = 400, dtMs = 270): LocationSample[] {
  const out: LocationSample[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI;
    out.push({ x: 3000 + 1800 * Math.cos(a), y: 4000 + 1500 * Math.sin(a), date: 1e12 + i * dtMs });
  }
  return out;
}
const bounds = (l: LocationSample[]) => Controller._locBounds(Controller._dropStrays(l));

describe("GPS trace sanity (telemetry-trace.test.mjs:50-125)", () => {
  it("a stray sample does not move the fitted bounds", () => {
    const clean = bounds(ovalLap());
    for (const stray of [{ x: 0, y: 0 }, { x: -9000, y: 12000 }, { x: 3000, y: -20000 }]) {
      const withStray = bounds(ovalLap().concat([{ ...stray, date: 1e12 + 401 * 270 }]));
      expect(Math.abs(withStray.spanx - clean.spanx)).toBeLessThan(1);
      expect(Math.abs(withStray.spany - clean.spany)).toBeLessThan(1);
    }
  });
  it("the lap's own extremities survive — only outliers go", () => {
    const l = ovalLap();
    const kept = Controller._dropStrays(l);
    expect(kept.length).toBe(l.length);
    const b = Controller._locBounds(kept);
    expect(Math.abs(b.spanx - 3600) < 1 && Math.abs(b.spany - 3000) < 1).toBe(true);
  });
  it("a real excursion is kept rather than truncated", () => {
    const l = ovalLap();
    for (let i = 0; i < 100; i++) (l[i] as LocationSample).y += 4000;
    expect(Controller._dropStrays(l).length).toBe(l.length);
  });
  it("too few samples to judge a distribution are passed through", () => {
    expect(Controller._dropStrays(ovalLap(10)).length).toBe(10);
    expect(Controller._dropStrays([])).toEqual([]);
    expect(Controller._dropStrays(null)).toEqual([]);
  });
  it("coverage gaps are detected, ordinary cadence is not", () => {
    const l = ovalLap();
    const limit = Controller._gapLimitMs(l);
    expect(limit).toBeGreaterThanOrEqual(1500);
    for (let i = 1; i < l.length; i++) expect(Controller._isGap(l, i, limit)).toBe(false);
    const holed = ovalLap();
    for (let i = 200; i < holed.length; i++) (holed[i] as LocationSample).date += 5000;
    expect(Controller._isGap(holed, 200, Controller._gapLimitMs(holed))).toBe(true);
    expect(Controller._isGap(holed, 201, Controller._gapLimitMs(holed))).toBe(false);
  });
  it("locBounds never returns a degenerate transform", () => {
    for (const l of [[], [{ x: 5, y: 5, date: 1 }]]) {
      const b = Controller._locBounds(l);
      expect(isFinite(b.minx) && isFinite(b.miny)).toBe(true);
      expect(b.spanx > 0 && b.spany > 0).toBe(true);
    }
  });
});

// A driver: a circular lap of `dur` seconds, GPS at ~3.7 Hz, car data at 10 Hz,
// constant speed.
function driver(dur = 80, r = 1600, speedKmh = 200): { loc: LocationSample[]; car: CarSample[] } {
  const t0 = 1e12;
  const loc: LocationSample[] = [], car: CarSample[] = [];
  for (let i = 0; i * 0.27 <= dur; i++) {
    const t = i * 0.27, a = (t / dur) * 2 * Math.PI;
    loc.push({ x: 3000 + r * Math.cos(a), y: 4000 + r * Math.sin(a), date: t0 + t * 1000 });
  }
  for (let i = 0; i * 0.1 <= dur; i++) {
    const t = i * 0.1;
    car.push({ t, date: t0 + t * 1000, speed: speedKmh, throttle: null, brake: null, gear: null, rpm: null, drs: null });
  }
  return { loc, car };
}
const angleOf = (p: M.XY | null) => Math.atan2((p as M.XY).y - 4000, (p as M.XY).x - 3000);
function sweep(view: M.LocView, tel: M.LocLane, tEnd: number, steps = 600) {
  let prev = angleOf(Controller._locAt(view, tel, 0)), total = 0, maxStep = 0;
  for (let i = 1; i <= steps; i++) {
    const p = Controller._locAt(view, tel, (i / steps) * tEnd);
    let d = angleOf(p) - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d; maxStep = Math.max(maxStep, Math.abs(d));
    prev = angleOf(p);
  }
  return { total, maxStep };
}

describe("the moving dot (telemetry-trace.test.mjs:152-232)", () => {
  it("completes exactly one forward lap over the lap's duration", () => {
    const p = driver(80);
    const s = sweep({ primary: p, tMax: 80 }, p, 80);
    expect(Math.abs(s.total - 2 * Math.PI)).toBeLessThan(0.05);
    expect(s.maxStep).toBeLessThan(0.1);
  });
  it("tracks the lap clock in real time, not just at the ends", () => {
    const p = driver(80);
    for (const f of [0.25, 0.5, 0.75]) {
      const a = angleOf(Controller._locAt({ primary: p, tMax: 80 }, p, 80 * f));
      const err = Math.abs(((a + 2 * Math.PI) % (2 * Math.PI)) - f * 2 * Math.PI);
      expect(err).toBeLessThan(0.06);
    }
  });
  it("comparison mode: each dot runs on its OWN lap length", () => {
    const slow = driver(80), fast = driver(76);
    const view = { primary: slow, tMax: 80 };
    const sSlow = sweep(view, slow, 80), sFast = sweep(view, fast, 80);
    expect(Math.abs(sSlow.total - 2 * Math.PI)).toBeLessThan(0.05);
    expect(Math.abs(sFast.total - 2 * Math.PI)).toBeLessThan(0.05);
    expect(sweep(view, fast, 40).total).toBeGreaterThan(sweep(view, slow, 40).total);
    expect(sFast.maxStep < 0.1 && sSlow.maxStep < 0.1).toBe(true);
  });
  it("a driver with no GPS of their own rides the path on THEIR lap, not the other's", () => {
    const slow = driver(80), fast = { loc: [], car: driver(60).car };
    const s = sweep({ primary: slow, tMax: 80 }, fast, 60);
    expect(Math.abs(s.total - 2 * Math.PI)).toBeLessThan(0.12);
  });
  it("integrated distance retains unknown intervals and legitimate stops", () => {
    for (const speed of [null, undefined, NaN, Infinity]) {
      const cum = M.cumDist([{ t: 0, speed: 180 }, { t: 1, speed: 180 }, { t: 2, speed }, { t: 3, speed: 180 }]);
      expect(M.distAtT(cum, 1)).toBe(50);
      expect(M.distAtT(cum, 1.5)).toBeNaN();
      expect(M.distAtT(cum, 3)).toBeNaN();
      expect(M.timeAtDist(cum, 25)).toBe(0.5);
      expect(M.timeAtDist(cum, 75)).toBeNaN();
      expect(M.timeAtDist(cum, NaN)).toBeNaN();
    }
    const stopped = M.cumDist([{ t: 0, speed: 180 }, { t: 1, speed: 0 }, { t: 2, speed: 180 }]);
    expect(M.distAtT(stopped, 1)).toBe(0);
    expect(M.distAtT(stopped, 2)).toBe(50);
  });
});

describe("gauges (telemetry-trace.test.mjs:234-277)", () => {
  it("compare gaps stay at the reference finish while a slower lap keeps playing", () => {
    const player = createPlayer({ el, cssColor: () => "" }, { paintFrame() {} });
    const cell = () => el("div");
    const sample = (t: number): CarSample => ({ t, date: t * 1000, speed: 180, gear: 6, throttle: 100, brake: 0, rpm: 10000, drs: null });
    const lane = (finish: number) => ({ d: { num: 1, code: "X", name: null, team: null, color: null }, lap: null, car: [sample(0), sample(finish)], cum: { t: [0, finish], d: [0, 1000] } });
    const primary = lane(80), compare = lane(82), third = lane(84);
    const view = {
      cursorT: 80, primary, compare, laps: [primary, compare, third], rpmMax: 12000,
      g: {
        speed: [cell(), cell()], gear: [cell(), cell()], thr: [cell(), cell()],
        brk: [cell(), cell()], rpm: [cell(), cell()], drs: [cell(), cell()],
        delta: cell(), board: [{ spd: cell(), dl: cell(), ref: true },
          { spd: cell(), dl: cell(), ref: false }, { spd: cell(), dl: cell(), ref: false }],
      },
    } as unknown as TelView;
    const g = view.g as M.Gauges, board = g.board as NonNullable<M.Gauges["board"]>;
    for (const t of [79, 80, 81, 82, 83]) {
      view.cursorT = t;
      player.paintFrame(view);
      const expected = t < 80 ? "+1.98s" : "+2.00s";
      expect(g.delta?.textContent, `compare gauge at ${t}s`).toBe(expected);
      expect(board[1]?.dl.textContent, `compare board at ${t}s`).toBe(expected.slice(0, -1));
      expect(board[2]?.dl.textContent, `third lane at ${t}s`).toBe(t < 80 ? "+3.95" : "+4.00");
    }
    expect(g.speed[0]?.textContent).toBe("180");
    expect(g.gear[0]?.textContent).toBe("G6");
    const missing = Array.from({ length: 81 }, (_, t) => ({ ...sample(t), speed: t >= 20 && t < 40 ? null : 180 }));
    primary.cum = M.cumDist(primary.car);
    compare.car = missing; compare.cum = M.cumDist(missing);
    third.car = missing; third.cum = M.cumDist(missing);
    view.cursorT = 55;
    player.paintFrame(view);
    expect(g.delta?.textContent, "unknown travel must not fabricate a gap").toBe("—");
    expect(board[1]?.dl.textContent).toBe("—");
    expect(board[2]?.dl.textContent).toBe("—");
  });
});

/* ---------- controller -> view -> player -> renderer wiring ---------- */

interface Harness { frames: Map<number, FrameRequestCallback>; observers: { cb: ResizeObserverCallback; disconnected: boolean }[]; drawCalls: string[] }
function installBrowserStubs(opts: { dpr: number; zoom: number }): Harness {
  const h: Harness = { frames: new Map(), observers: [], drawCalls: [] };
  let nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { const id = ++nextId; h.frames.set(id, fn); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { h.frames.delete(id); });
  vi.stubGlobal("ResizeObserver", class {
    cb: ResizeObserverCallback; disconnected = false;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; h.observers.push(this); }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void { this.disconnected = true; }
  });
  vi.stubGlobal("devicePixelRatio", opts.dpr);
  // A canvas 2D context whose path calls must all receive finite coordinates.
  const drawing = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => target[key] ?? ((...args: unknown[]) => {
      h.drawCalls.push(String(key));
      if (["moveTo", "lineTo", "arc"].includes(String(key))) {
        expect(args.filter((v) => typeof v === "number").every(Number.isFinite), `${String(key)} received an unknown coordinate`).toBe(true);
      }
    }),
    set: (target, key, v) => { target[key] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => drawing) as unknown as HTMLCanvasElement["getContext"]);
  Object.defineProperty(HTMLCanvasElement.prototype, "currentCSSZoom", { configurable: true, get: () => opts.zoom });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 330, bottom: 100, width: 330, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  return h;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLCanvasElement.prototype as { currentCSSZoom?: number }).currentCSSZoom;
  document.body.replaceChildren();
});

const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const macrotask = () => new Promise<void>((r) => setTimeout(r, 0));
function datahub(): HTMLElement {
  const hub = document.createElement("div"); hub.id = "datahub"; document.body.appendChild(hub);
  return hub;
}
const ptr = (type: string, pointerId: number, clientX = 0) => new PointerEvent(type, { pointerId, clientX, bubbles: true });

function syntheticApi(sampleCount: number): F1Api {
  const drivers: SessionDriver[] = [
    { num: 1, name: "Primary Driver", code: "PRI", team: null, color: "ff0000" },
    { num: 2, name: "Missing Driver", code: "MIS", team: null, color: "00ff00" },
    { num: 3, name: "Comparison Driver", code: "CMP", team: null, color: "0000ff" },
  ];
  const trace = driver(80);
  trace.car = Array.from({ length: sampleCount }, (_, i) => ({ ...(trace.car[Math.round(i * (trace.car.length - 1) / (sampleCount - 1))] as CarSample) }));
  trace.car.push({ ...(trace.car[trace.car.length - 1] as CarSample), t: 81.2, date: 1e12 + 81200 });
  trace.loc.push({ x: 1e6, y: 1e6, date: 1e12 + 81200 });
  if (sampleCount === 801) trace.car.forEach((s) => { if (s.t >= 20 && s.t < 40) s.speed = null; });
  trace.car.forEach((s) => Object.assign(s, { gear: 7, throttle: 80, brake: 0, rpm: 10000, drs: 12 }));
  const base = createF1Api({ fetch: fixtureFetch([]), storage: new MemoryStorage() });
  return {
    ...base,
    sessionDrivers: () => Promise.resolve(drivers),
    fastestLap: () => Promise.resolve({ dateStart: new Date(1e12).toISOString(), lapDuration: 80, lapNumber: 3, s1: 25, s2: 25, s3: 30, i1Speed: null, i2Speed: null, stSpeed: null, isPitOut: false }),
    carData: (_s, num) => Promise.resolve(num === 2 ? [] : trace.car),
    locationData: (_s, num) => Promise.resolve(num === 2 ? [] : trace.loc),
    stints: () => Promise.resolve([]),
    pits: () => Promise.resolve([]),
  };
}
const SYN_META: Session = { sessionKey: 7, meetingKey: 1, year: 2026, name: "Race", type: "Race", circuit: null, country: null, dateStart: null };

describe("telemetry clipping, lane colours and playback teardown (telemetry-trace.test.mjs:279-419)", () => {
  for (const sampleCount of [8, 9, 801]) it(`${sampleCount} lap samples`, async () => {
    const h = installBrowserStubs({ dpr: 2, zoom: 2 });
    const deps = stubDeps([], {
      api: syntheticApi(sampleCount),
      sel: { year: 2026, meetingKey: 1, sessionKey: 7, meta: SYN_META, selAt: 0, pinned: true },
      findTeam: () => null,
    });
    const tab = Controller.create(deps);
    const body = await tab.loadTelemetry();
    datahub().appendChild(body);
    await tick();
    const chips = body.querySelectorAll<HTMLButtonElement>(".dh-dchip");
    expect(chips.length).toBe(3);
    chips.forEach((chip) => chip.click());
    (body.querySelector(".dh-livebtn") as HTMLButtonElement).click();
    await tick();
    await macrotask();

    const popup = document.querySelector<HTMLDialogElement>(".dh-tpopup");
    expect(popup && popup.open).toBe(true);
    const chart = (popup as HTMLDialogElement).querySelector(".dh-canvas") as HTMLCanvasElement;
    expect(chart.width, "DPR and CSS zoom are capped at a ratio of three").toBe(990);
    const summary = (popup as HTMLDialogElement).querySelector("#dh-telem-summary") as HTMLElement;
    expect(summary.textContent).toMatch(/PRI \(primary trace\), CMP \(comparison trace\)/);
    expect(summary.textContent).toMatch(/speed 200 km\/h, gear G7/);
    const legend = (popup as HTMLDialogElement).querySelector(".dh-legend")!.querySelectorAll<HTMLElement>(".dh-codechip");
    // stubDeps' cssColor writes rgb(); the lane colours come from OpenF1's hex
    expect(legend[0]?.style.background).toMatch(/rgb\(255,\s*0,\s*0\)/);
    expect(legend[1]?.style.background, "a missing middle lane must not shift the following lane's color").toMatch(/rgb\(0,\s*0,\s*255\)/);
    expect(h.drawCalls).toContain("lineTo");

    chart.dispatchEvent(ptr("pointerdown", 99, 330));
    chart.dispatchEvent(ptr("pointerup", 99));
    expect(summary.textContent, "next-lap samples must not extend even a sparse lap").toMatch(/Time 1:20.00/);
    const play = (popup as HTMLDialogElement).querySelector(".dh-tplay") as HTMLButtonElement;
    play.click();
    expect(h.frames.size).toBe(1);
    const step = (ts: number) => {
      const [id, fn] = h.frames.entries().next().value as [number, FrameRequestCallback];
      h.frames.delete(id); fn(ts);
    };
    step(100); step(1100);
    expect((popup as HTMLDialogElement).querySelector(".dh-gspeed .dh-gval")?.textContent).toBe("200");
    chart.dispatchEvent(ptr("pointerdown", 1, 160));
    expect(h.frames.size, "scrubbing cancels playback").toBe(0);
    chart.dispatchEvent(ptr("pointercancel", 1));
    const firstTime = summary.textContent;
    chart.dispatchEvent(ptr("pointerdown", 2, 240));
    chart.dispatchEvent(ptr("pointerup", 2));
    expect(summary.textContent, "a canceled pointer must release ownership for the next scrub").not.toBe(firstTime);
    play.click();
    expect(h.frames.size).toBe(1);
    tab.closeTelemPopup();
    expect(h.frames.size, "closing the popup cancels its active animation").toBe(0);
    expect(h.observers.every((o) => o.disconnected)).toBe(true);
    expect(document.querySelector(".dh-tpopup")).toBeNull();
    expect(document.activeElement, "close restores focus to the selected driver").toBe(chips[0]);
  });
});

describe("resize (telemetry-view-resize.test.mjs)", () => {
  it("a DPR change under unchanged boxes refits the map canvas as well as the chart", async () => {
    const h = installBrowserStubs({ dpr: 1, zoom: 2 });
    const deps = stubDeps([], {
      api: syntheticApi(801),
      sel: { year: 2026, meetingKey: 1, sessionKey: 7, meta: SYN_META, selAt: 0, pinned: true },
    });
    const tab = Controller.create(deps);
    const body = await tab.loadTelemetry();
    datahub().appendChild(body);
    await tick();
    body.querySelectorAll<HTMLButtonElement>(".dh-dchip").forEach((c) => c.click());
    (body.querySelector(".dh-livebtn") as HTMLButtonElement).click();
    await tick();
    await macrotask();
    const popup = document.querySelector(".dh-tpopup") as HTMLDialogElement;
    const chart = popup.querySelector(".dh-canvas") as HTMLCanvasElement, map = popup.querySelector(".dh-canvas.dh-map") as HTMLCanvasElement;
    expect(chart).not.toBe(map);
    const ratio0 = 2;   // zoom 2 x DPR 1
    expect(map.width % ratio0).toBe(0);
    const mw = map.width / ratio0, cw = chart.width / ratio0;
    // Keep both boxes exactly as built so only the ratio differs.
    const mainArea = popup.querySelector(".dh-telem-main") as HTMLElement, sideArea = popup.querySelector(".dh-telem-side") as HTMLElement;
    Object.defineProperty(mainArea, "clientWidth", { configurable: true, get: () => cw + 32 });
    Object.defineProperty(sideArea, "clientWidth", { configurable: true, get: () => mw + 24 });
    expect(h.observers.length).toBeGreaterThanOrEqual(1);
    vi.stubGlobal("devicePixelRatio", 1.5);   // zoom 2 x 1.5 = ratio 3
    h.observers[0]!.cb([], {} as ResizeObserver);
    for (const [id, fn] of h.frames) { h.frames.delete(id); fn(0); }
    expect(chart.width, "the chart refits to the new ratio").toBe(cw * 3);
    expect(map.width, "and so does the map canvas").toBe(mw * 3);
    tab.closeTelemPopup(true);
  });
});

describe("mount on the recorded Baku race", () => {
  it("loads lap 28 for driver 1, plays, and unmount tears the popup down", async () => {
    const h = installBrowserStubs({ dpr: 1, zoom: 1 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
    try {
      const deps = stubDeps(ROUTES, { sel: { year: 2026, meetingKey: 1295, sessionKey: 11377, meta: META, selAt: 0, pinned: true } });
      const host = datahub();
      const mounted = Controller.mount(host, deps);
      expect(host.querySelector(".dh-loading")).not.toBeNull();
      await vi.runAllTimersAsync();
      const chips = host.querySelectorAll<HTMLButtonElement>(".dh-dchip");
      expect(chips.length).toBe(22);
      expect(host.querySelector(".dh-live-sub")?.textContent).toBe("Baku · Azerbaijan");
      const nor = [...chips].find((c) => c.getAttribute("aria-label") === "Select Lando NORRIS") as HTMLButtonElement;
      expect(nor.textContent).toBe("NOR · NORRIS");
      nor.click();
      expect(nor.getAttribute("aria-pressed")).toBe("true");
      const load = host.querySelector(".dh-telem-detail .dh-livebtn") as HTMLButtonElement;
      expect(load.textContent).toBe("LOAD FASTEST LAP");
      load.click();
      await vi.runAllTimersAsync();

      const popup = document.querySelector(".dh-tpopup") as HTMLDialogElement;
      expect(popup.open).toBe(true);
      expect(popup.querySelector(".dh-tpopup-sub")?.textContent).toBe("Race · Baku");
      const head = popup.querySelector(".dh-thead") as HTMLElement;
      expect(head.querySelector(".dh-tlap")?.textContent).toBe("L28 · 1:47.761");
      expect(head.textContent).toContain("S1 38.317 · S2 43.867 · S3 25.577");
      expect(head.textContent).toContain("PRIMARY TRACE");
      const summary = popup.querySelector("#dh-telem-summary") as HTMLElement;
      expect(summary.textContent).toMatch(/^Selected drivers: NOR \(primary trace\)\. Time 0:00\.00\. NOR primary trace: speed \d+ km\/h/);
      expect(popup.querySelector(".dh-map")).not.toBeNull();
      expect([...popup.querySelectorAll(".dh-section")].map((s) => s.textContent)).toEqual(expect.arrayContaining(["TYRE STINTS", "PIT STOPS"]));
      // one channel toggle per channel, no compare grouping for one lane
      expect(popup.querySelectorAll(".dh-legend .dh-legend-item").length).toBe(M.CHANNELS.length);

      (popup.querySelector(".dh-tplay") as HTMLButtonElement).click();
      expect(h.frames.size).toBe(1);
      mounted.unmount();
      expect(h.frames.size, "unmount cancels playback").toBe(0);
      expect(document.querySelector(".dh-tpopup")).toBeNull();
      expect(host.childNodes.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
