/* net-snapshot.test.ts — the wire format and the interpolation buffer.
 *
 * Port of f1-game tests/unit/net-snapshot.test.mjs:1-496 (every test, same
 * names, same order):
 *   - snapshot codec:              :41-136
 *   - interpolation buffer:        :142-299
 *   - lap and s cross together:    :301-362
 *   - brake-aware extrapolation:   :364-440
 *   - adaptive delay follows lag:  :442-472
 *   - aged multi-entry packet:     :474-496
 *
 * These are the two places multiplayer fails SILENTLY. A codec that loses a
 * bit produces a car slightly in the wrong place, not an exception. An
 * interpolator that mishandles the lap wrap sends a rival sprinting backwards
 * down the circuit once per lap. f1-game's `assert.equal` (strict, Object.is)
 * maps to `toBe`; tolerance checks keep f1-game's bounds exactly.
 */
import { expect, test } from "vitest";
import {
  AGED_BYTES,
  CAR_BYTES,
  MAX_AHEAD_MS,
  TYPE_AGED,
  TYPE_SNAPSHOT,
  createInterp,
  decodeSnapshot,
  encodeAged,
  encodeSnapshot,
  type AgedEntry,
  type InterpState,
  type SnapshotEntry,
} from "../../src/net/snapshot";

const TAU = Math.PI * 2;

type TestCar = {
  s: number;
  x: number;
  head: number;
  speed: number;
  gear: number;
  lap: number;
  deploying: boolean;
  offroad: boolean;
  onKerb: boolean;
  braking: boolean;
};

const car = (o: Partial<TestCar>): TestCar =>
  Object.assign(
    {
      s: 0, x: 0, head: 0, speed: 0, gear: 1, lap: 0,
      deploying: false, offroad: false, onKerb: false, braking: false,
    },
    o,
  );

/** Narrow a nullable result, failing the test when it is missing. */
function must<T>(v: T | null | undefined): T {
  expect(v).not.toBeNull();
  expect(v).not.toBeUndefined();
  return v as T;
}

// ---------------------------------------------------------------------------
// Snapshot codec
// ---------------------------------------------------------------------------

test("a car round-trips within the stated quantisation", () => {
  const src = car({ s: 4213.37, x: -3.62, head: 2.1, speed: 82.4, gear: 7, lap: 12, deploying: true, onKerb: true });
  const bytes = encodeSnapshot(99, [{ id: 5, car: src }]);
  const out = must(decodeSnapshot(bytes));

  expect(out.tick).toBe(99);
  expect(out.cars.length).toBe(1);
  const c = must(out.cars[0]);
  expect(c.id).toBe(5);
  // 1 cm of position, 1 cm/s of speed, ~0.006 deg of heading.
  expect(Math.abs(c.s - src.s) <= 0.01, `s off by ${Math.abs(c.s - src.s)}`).toBe(true);
  expect(Math.abs(c.x - src.x) <= 0.01).toBe(true);
  expect(Math.abs(c.speed - src.speed) <= 0.01).toBe(true);
  expect(Math.abs(c.head - src.head) <= 0.0002).toBe(true);
  expect(c.gear).toBe(7);
  expect(c.lap).toBe(12);
  expect(c.deploying).toBe(true);
  expect(c.onKerb).toBe(true);
  expect(c.offroad).toBe(false);
  expect(c.braking).toBe(false);
});

test("the packet is 13 bytes per car", () => {
  // Not a micro-optimisation: it is what makes a 20 Hz full-grid broadcast
  // cost ~5 KB/s. If this grows, check it was on purpose.
  const one = encodeSnapshot(1, [{ id: 0, car: car({}) }]);
  const two = encodeSnapshot(1, [{ id: 0, car: car({}) }, { id: 1, car: car({}) }]);
  expect(two.length - one.length).toBe(CAR_BYTES);
  expect(CAR_BYTES).toBe(13);
  expect(two.length).toBe(6 + 2 * 13);
});

test("reverse speed survives the wire", () => {
  // speed is SIGNED on purpose: a stopped car may crawl backwards off a wall.
  const bytes = encodeSnapshot(1, [{ id: 0, car: car({ speed: -2.5 }) }]);
  const c = must(must(decodeSnapshot(bytes)).cars[0]);
  expect(Math.abs(c.speed + 2.5) <= 0.01).toBe(true);
});

test("a full 22-car grid still fits comfortably", () => {
  const entries: SnapshotEntry[] = [];
  for (let i = 0; i < 22; i++) entries.push({ id: i, car: car({ s: i * 100, speed: 80 }) });
  const bytes = encodeSnapshot(1234, entries);
  expect(bytes.length).toBe(6 + 22 * 13);
  const out = must(decodeSnapshot(bytes));
  expect(out.cars.length).toBe(22);
  expect(must(out.cars[21]).id).toBe(21);
  // 20 Hz of this is ~5.3 KB/s.
  expect(bytes.length * 20 < 7000).toBe(true);
});

test("negative wire ids are omitted so the count byte matches", () => {
  const bytes = encodeSnapshot(1, [
    { id: -1, car: car({}) },
    { id: 3, car: car({ s: 10 }) },
    { id: -2, car: car({}) },
  ]);
  const out = must(decodeSnapshot(bytes));
  expect(out.cars.length).toBe(1);
  expect(must(out.cars[0]).id).toBe(3);
  expect(bytes[5]).toBe(1);
});

test("non-integer and out-of-range ids never fold onto wire id 0", () => {
  // `null >= 0` and `false >= 0` are true in JS; then `id & 0xff` maps them
  // (and 256) onto 0, colliding remotes on the host relay / interp map.
  // The ids are deliberately ill-typed, as an untrusted caller could send them.
  const entries: unknown[] = [
    { id: null, car: car({ s: 100 }) },
    { id: false, car: car({ s: 101 }) },
    { id: "3", car: car({ s: 102 }) },
    { id: 1.5, car: car({ s: 103 }) },
    { id: 256, car: car({ s: 104 }) },
    { id: 0, car: car({ s: 200 }) },
    { id: 7, car: car({ s: 300 }) },
  ];
  const bytes = encodeSnapshot(1, entries as SnapshotEntry[]);
  const out = must(decodeSnapshot(bytes));
  expect(out.cars.length).toBe(2);
  expect(out.cars.map((c) => [c.id, Math.round(c.s)])).toStrictEqual([[0, 200], [7, 300]]);
  expect(bytes[5]).toBe(2);

  const agedEntries: unknown[] = [
    { id: null, at: 10, car: car({ s: 1 }) },
    { id: 2, at: 20, car: car({ s: 2 }) },
  ];
  const aged = encodeAged(agedEntries as AgedEntry[]);
  const agedOut = must(decodeSnapshot(aged));
  expect(agedOut.cars.length).toBe(1);
  expect(must(agedOut.cars[0]).id).toBe(2);
});

test("a truncated packet decodes to nothing rather than a garbage car", () => {
  const bytes = encodeSnapshot(1, [{ id: 0, car: car({ s: 500 }) }]);
  expect(decodeSnapshot(bytes.slice(0, bytes.length - 4))).toBe(null);
  expect(decodeSnapshot(new Uint8Array(2))).toBe(null);
  expect(decodeSnapshot(null)).toBe(null);
});

// ---------------------------------------------------------------------------
// Interpolation buffer
// ---------------------------------------------------------------------------

const TOTAL = 5000; // a 5 km circuit

test("a car is drawn between the two packets bracketing the delayed present", () => {
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 100 });
  buf.push(1000, car({ s: 100, x: 0, speed: 50 }));
  buf.push(1100, car({ s: 150, x: 2, speed: 50 }));
  const mid = must(buf.sample(1150)); // target 1050, halfway
  expect(Math.abs(mid.s - 125) < 0.001, `expected s=125, got ${mid.s}`).toBe(true);
  expect(Math.abs(mid.x - 1) < 0.001).toBe(true);
  expect(mid.extrapolated).toBe(false);
});

test("s interpolation takes the short way round the start/finish line", () => {
  // THE bug this file exists for. Without wrap handling, a car crossing the
  // line appears to drive the entire lap backwards, once per lap.
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0 });
  buf.push(0, car({ s: TOTAL - 50, speed: 100 }));
  buf.push(100, car({ s: 50, speed: 100 })); // wrapped past the line
  const mid = must(buf.sample(50));
  // Halfway between 4950 and 50 the short way is exactly the line itself.
  expect(mid.s > TOTAL - 5 || mid.s < 5, `should be near the line, got ${mid.s}`).toBe(true);
});

test("heading interpolation takes the short way round too", () => {
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0 });
  buf.push(0, car({ head: 0.1 }));
  buf.push(100, car({ head: TAU - 0.1 })); // just the other side of 0
  const mid = must(buf.sample(50));
  const nearZero = Math.min(mid.head, TAU - mid.head);
  expect(nearZero < 0.02, `should pass through 0, got ${mid.head}`).toBe(true);
});

test("a late packet extrapolates ALONG THE ROAD, and gives up after a bound", () => {
  // Extrapolating in (s, x) cannot put a car through a barrier: it follows
  // the centreline by construction. But a guess still goes stale.
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0, maxExtrapMs: 250 });
  buf.push(0, car({ s: 1000, x: 1.5, speed: 100 }));

  const at100 = must(buf.sample(100));
  expect(at100.extrapolated).toBe(true);
  expect(Math.abs(at100.s - 1010) < 0.001, `100 m/s for 0.1 s = +10 m, got ${at100.s}`).toBe(true);
  expect(at100.x, "lateral offset must NOT be extrapolated").toBe(1.5);

  // Capped: 2 s of silence must not fling the car 200 m up the road.
  const at2s = must(buf.sample(2000));
  expect(Math.abs(at2s.s - 1025) < 0.001, `should cap at 250 ms (+25 m), got ${at2s.s}`).toBe(true);
});

test("extrapolation wraps at the line rather than running past the track length", () => {
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0 });
  buf.push(0, car({ s: TOTAL - 10, speed: 100 }));
  const out = must(buf.sample(200)); // +20 m, past the line
  expect(out.s >= 0 && out.s < TOTAL, `s must stay on the track, got ${out.s}`).toBe(true);
  expect(Math.abs(out.s - 10) < 0.001, `expected to wrap to ~10, got ${out.s}`).toBe(true);
});

test("out-of-order and duplicate packets are handled, not trusted", () => {
  // The state channel is unordered and lossy BY DESIGN.
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0 });
  buf.push(200, car({ s: 300 }));
  buf.push(0, car({ s: 100 })); // arrives late, belongs first
  buf.push(100, car({ s: 200 })); // slots into the middle
  expect(buf.size()).toBe(3);
  expect(must(buf.oldest()).s).toBe(100);
  expect(must(buf.newest()).s).toBe(300);
  expect(Math.abs(must(buf.sample(100)).s - 200) < 0.001, "must have re-sorted by tick").toBe(true);

  expect(buf.push(100, car({ s: 999 })), "duplicate tick should be refused").toBe(false);
  expect(buf.size()).toBe(3);
});

test("interpolation unwraps uint32 wire ticks across the long-session rollover", () => {
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0 });
  const before = 0xffffffff - 40;
  expect(buf.push(before, car({ s: 100, speed: 50 }))).toBe(true);
  // The wire carries this as 24 after performance.now() wraps. Keep it after
  // `before`, rather than inserting it at the front of the ring.
  expect(buf.push(24, car({ s: 110, speed: 50 }))).toBe(true);
  const state = buf.sample(0x100000000 + 24);
  expect(state, "post-wrap target should resolve a sample").toBeTruthy();
  expect(must(state).s).toBe(110);
  expect(buf.push(24, car({ s: 999 })), "same raw tick remains a duplicate").toBe(false);
});

test("decoded rollover ticks use the arrival clock epoch for adaptive delay", () => {
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0, adaptive: true });
  const arrival = 0x100000000 + 120;
  expect(buf.push(0xffffffff - 20, car({ s: 100, speed: 50 }), arrival - 100)).toBe(true);
  expect(buf.push(80, car({ s: 120, speed: 50 }), arrival)).toBe(true);
  const state = buf.sample(arrival);
  expect(
    !!state && state.s >= 120,
    "arrival-domain target should not fall behind the wrapped packet",
  ).toBe(true);
});

test("predict() leads sample() by exactly the interpolation delay", () => {
  // Contact must NOT be resolved against the drawn pose: sample() is
  // deliberately delayMs in the past; predict() is the same read without it.
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 100 });
  buf.push(1000, car({ s: 100, speed: 50 }));
  buf.push(1200, car({ s: 110, speed: 50 }));
  // At now=1200: sample targets 1100 (mid-way, s=105); predict targets 1200.
  expect(Math.abs(must(buf.sample(1200)).s - 105) < 0.001).toBe(true);
  expect(Math.abs(must(buf.predict(1200)).s - 110) < 0.001).toBe(true);
  expect(must(buf.predict(1200)).s > must(buf.sample(1200)).s, "predict must LEAD sample").toBe(true);
});

test("a far-future tick is refused: it cannot pin newest or freeze the adaptive delay", () => {
  // Bug hunt 2026-09-27: one packet stamped hours ahead stuck as the newest
  // sample forever and pinned lastTick, freezing the rival on extrapolation.
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 100, adaptive: true });
  buf.push(1000, car({ s: 100, speed: 50 }), 1030);
  expect(
    buf.push(1000 + 3600e3, car({ s: 999, speed: 50 }), 1040),
    "a tick an hour ahead of arrival must be refused",
  ).toBe(false);
  expect(buf.push(1000 + MAX_AHEAD_MS + 50, car({ s: 998 }), 1045), "just past the cap is refused too").toBe(false);
  expect(must(buf.newest()).s, "the refused tick never became the newest sample").toBe(100);
  // Honest packets with jittery arrival still drive the adaptive delay.
  const d0 = buf.timing().delayMs;
  for (let i = 1; i <= 20; i++) {
    expect(buf.push(1000 + i * 50, car({ s: 100 + i }), 1030 + i * 50 + (i % 2) * 40)).toBe(true);
  }
  expect(buf.timing().delayMs > d0, "the delay still adapts after the bad packet").toBe(true);
  expect(must(buf.newest()).s).toBe(120);
  // A modest lead (clock-offset error) is still accepted, and no arrival = no check.
  expect(buf.push(3000, car({ s: 130 }), 1500)).toBe(true);
  expect(buf.push(1e9, car({ s: 131 })), "without an arrival time there is nothing to compare").toBe(true);
});

test("an empty buffer reports nothing rather than inventing a car", () => {
  const buf = createInterp<TestCar>({ total: TOTAL });
  expect(buf.sample(0)).toBe(null);
  expect(buf.newest()).toBe(null);
});

test("the buffer is bounded, so a long session cannot grow it without limit", () => {
  const buf = createInterp<TestCar>({ total: TOTAL, keep: 8 });
  for (let i = 0; i < 200; i++) buf.push(i * 50, car({ s: i }));
  expect(buf.size()).toBe(8);
  expect(must(buf.newest()).s, "the newest must always be kept").toBe(199);
});

test("discrete fields step instead of blending", () => {
  // Half a gear is not a thing. lap is deliberately NOT asserted here: it is
  // the high half of (lap, s); the tests below own it.
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0 });
  buf.push(0, car({ gear: 3, onKerb: false }));
  buf.push(100, car({ gear: 4, onKerb: true }));
  const early = must(buf.sample(20));
  const late = must(buf.sample(80));
  expect(early.gear).toBe(3);
  expect(early.onKerb).toBe(false);
  expect(late.gear).toBe(4);
  expect(late.onKerb).toBe(true);
});

// ---- lap and s cross the line TOGETHER ------------------------------------
// netplay reconstructs race position as prog = lap*total + s, so a pair that
// disagrees puts the rival a whole lap out.
const progOf = (st: { lap?: number | undefined; s: number }): number => (st.lap as number) * TOTAL + st.s;

test("prog is monotonic across the start/finish line (blend, both halves)", () => {
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0 });
  buf.push(0, car({ s: TOTAL - 50, lap: 3, speed: 100 }));
  buf.push(100, car({ s: 50, lap: 4, speed: 100 })); // crossed at u = 0.5
  let prev = progOf(must(buf.sample(0)));
  // Walk the whole interval, including u < 0.5 and u > 0.5.
  for (let t = 5; t <= 100; t += 5) {
    const st = must(buf.sample(t));
    const prog = progOf(st);
    expect(prog >= prev - 1e-6, `prog went backwards at t=${t}: ${prev} -> ${prog}`).toBe(true);
    expect(prog - prev < TOTAL / 2, `prog jumped a lap at t=${t}: ${prev} -> ${prog}`).toBe(true);
    expect(st.s >= 0 && st.s < TOTAL, `s out of range at t=${t}: ${st.s}`).toBe(true);
    prev = prog;
  }
  // And it lands exactly on the newer packet's own progress.
  expect(Math.abs(progOf(must(buf.sample(100))) - (4 * TOTAL + 50)) < 1e-6).toBe(true);
});

test("a car reversing back over the line loses a lap rather than gaining one", () => {
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0 });
  buf.push(0, car({ s: 50, lap: 4, speed: -100 }));
  buf.push(100, car({ s: TOTAL - 50, lap: 3, speed: -100 }));
  // At exactly halfway the car sits ON the line (s = 0), which belongs to the
  // higher lap, so step just past it to see the crossing itself.
  expect(must(buf.sample(50)).lap, "s = 0 is still the lap it completed").toBe(4);
  const past = must(buf.sample(60));
  expect(past.lap, "lap must step DOWN with the backward crossing").toBe(3);
  expect(past.s > TOTAL - 20, `should be just before the line, got ${past.s}`).toBe(true);
  expect(progOf(past) < progOf(must(buf.sample(50))), "prog must fall while reversing").toBe(true);
});

test("extrapolating across the line carries the lap with it", () => {
  // advance() wrapped s and never touched lap, so a packet gap over the line
  // showed the rival a full lap behind for up to maxExtrapMs.
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 0, maxExtrapMs: 250 });
  buf.push(0, car({ s: TOTAL - 10, lap: 2, speed: 100 }));
  const before = must(buf.sample(50)); // 5 m on: still 5 m short of the line
  expect(before.lap).toBe(2);
  const after = must(buf.sample(200)); // 20 m on: 10 m past the line
  expect(after.lap, "lap must step with the wrap").toBe(3);
  expect(after.s >= 0 && after.s < TOTAL).toBe(true);
  expect(progOf(after) > progOf(before), "extrapolated prog must keep rising").toBe(true);
});

test("a state with no lap field is left alone by both movers", () => {
  // A caller that never sends lap must not suddenly grow a NaN one.
  const buf = createInterp<InterpState>({ total: TOTAL, delayMs: 0 });
  buf.push(0, { s: TOTAL - 50, x: 0, head: 0, speed: 100 });
  buf.push(100, { s: 50, x: 0, head: 0, speed: 100 });
  expect(must(buf.sample(50)).lap).toBe(undefined);
  expect(must(buf.sample(500)).lap).toBe(undefined); // extrapolated
});

// ---------------------------------------------------------------------------
// Brake-aware extrapolation: F_BRAKE was decoded and thrown away
// ---------------------------------------------------------------------------
// The deceleration rate is OBSERVED from the last two packets rather than
// taken from a constant (f1-game net-snapshot.test.mjs:367-379).
const TOT = 5000;

test("a car that is not braking extrapolates exactly as it always did", () => {
  // The flag gates everything, so an unbraked field is bit-identical to before.
  const buf = createInterp<TestCar>({ total: TOT, delayMs: 0 });
  buf.push(1000, car({ s: 100, speed: 50, braking: false }));
  buf.push(1100, car({ s: 105, speed: 40, braking: false })); // a real dip, flag off
  const o = must(buf.sample(1200));
  expect(o.extrapolated).toBe(true);
  expect(o.s, "no flag, no deceleration: flat speed as before").toBe(105 + 40 * 0.1);
  expect(o.speed).toBe(40);
});

test("a braking car is predicted short of where flat speed would put it", () => {
  const buf = createInterp<TestCar>({ total: TOT, delayMs: 0 });
  buf.push(1000, car({ s: 100, speed: 50, braking: true }));
  buf.push(1100, car({ s: 104.5, speed: 48, braking: true })); // 20 m/s^2 observed
  const flat = 104.5 + 48 * 0.1;
  const o = must(buf.sample(1200));
  expect(o.s < flat, `braking must fall short of the flat ${flat}, got ${o.s}`).toBe(true);
  // 20 m/s^2 over 100 ms: 48*0.1 - 0.5*20*0.01 = 4.8 - 0.1 = 4.7
  expect(Math.abs(o.s - (104.5 + 4.7)) < 1e-9, `expected 109.2, got ${o.s}`).toBe(true);
  // ...and the speed agrees with the pose, because they are one claim.
  expect(Math.abs(o.speed - 46) < 1e-9, `speed should be 46, got ${o.speed}`).toBe(true);
});

test("the prediction never runs past a stop, or past the slow-down cap", () => {
  // A jittery pair of packets can imply an absurd rate. Two clamps bound it.
  const buf = createInterp<TestCar>({ total: TOT, delayMs: 0, maxExtrapMs: 1000 });
  buf.push(1000, car({ s: 100, speed: 30, braking: true }));
  buf.push(1010, car({ s: 100.2, speed: 20, braking: true })); // 1000 m/s^2: nonsense
  const o = must(buf.sample(1500));
  expect(o.speed >= 0, "never negative").toBe(true);
  expect(o.speed >= 20 * (1 - 0.35) - 1e-9, `capped at a third off, got ${o.speed}`).toBe(true);
  expect(o.s > 100.2, "still moves forward").toBe(true);
  expect(o.s < 100.2 + 20 * 0.5, "but less far than flat speed would take it").toBe(true);
});

test("one sample cannot imply a rate, and falls back to flat speed", () => {
  // With nothing to difference against, the braking flag must change nothing.
  const buf = createInterp<TestCar>({ total: TOT, delayMs: 0 });
  buf.push(1000, car({ s: 100, speed: 50, braking: true }));
  const o = must(buf.sample(1100));
  expect(o.s).toBe(100 + 50 * 0.1);
  expect(o.speed).toBe(50);
});

test("a car that is speeding up while flagged braking is not accelerated further", () => {
  // Only a positive observed deceleration counts.
  const buf = createInterp<TestCar>({ total: TOT, delayMs: 0 });
  buf.push(1000, car({ s: 100, speed: 40, braking: true }));
  buf.push(1100, car({ s: 104, speed: 45, braking: true }));
  const o = must(buf.sample(1200));
  expect(o.s, "no negative deceleration").toBe(104 + 45 * 0.1);
  expect(o.speed).toBe(45);
});

test("the adaptive delay follows one-way LATENCY, so a slow link interpolates instead of extrapolating every frame", () => {
  // Bug hunt 2026-09-28: the delay tracked jitter only, capped at 180 ms, so
  // on a link slower than the delay every frame was past the newest packet.
  const buf = createInterp<TestCar>({ total: TOTAL, delayMs: 100, adaptive: true });
  const LAG = 160; // one-way, on the synced clock
  let extrapolatedLate = 0;
  let framesLate = 0;
  for (let i = 0; i < 400; i++) {
    const t = 1000 + i * 50;
    const arrival = t + LAG;
    buf.push(t, car({ s: (i * 2) % TOTAL, speed: 40 }), arrival);
    // Frames between this packet and the next, as the game draws them.
    for (let f = 1; f <= 3; f++) {
      const out = must(buf.sample(arrival + f * 16));
      if (i >= 200) {
        framesLate++;
        if (out.extrapolated) extrapolatedLate++;
      }
    }
  }
  const timing = buf.timing();
  expect(timing.delayMs > LAG, "the delay settles above the observed lag: " + JSON.stringify(timing)).toBe(true);
  expect(timing.delayMs <= 400, "...and under the cap").toBe(true);
  expect(
    extrapolatedLate,
    "once settled, no frame extrapolates on a steady link (" + extrapolatedLate + "/" + framesLate + ")",
  ).toBe(0);
  // A stall is not a latency: one packet a second late does not drag the delay to a second.
  buf.push(1000 + 400 * 50, car({ s: 0, speed: 40 }), 1000 + 400 * 50 + 1000);
  expect(buf.timing().lagMs <= 400).toBe(true);
  // And the base delay is the floor: a fast link is not slowed down.
  const fast = createInterp<TestCar>({ total: TOTAL, delayMs: 100, adaptive: true });
  for (let i = 0; i < 100; i++) fast.push(1000 + i * 50, car({ s: i }), 1000 + i * 50 + 20);
  expect(
    Math.abs(fast.timing().delayMs - 100) < 5,
    "a 20 ms link keeps the base delay: " + fast.timing().delayMs,
  ).toBe(true);
});

// L8-e: the host relay carries every other player's car in ONE aged packet;
// each entry keeps the moment its pose was true (header tick - age).
test("an aged multi-entry packet round-trips every car and its own stamp", () => {
  const agedCar = (s: number, lap: number) => ({ s, x: 1.25, head: 1, speed: 70, gear: 6, lap, braking: true });
  const bytes = encodeAged([
    { id: 4, car: agedCar(100, 2), at: 10_000 },
    { id: 9, car: agedCar(250.5, 3), at: 9_960.4 },
    { id: -1, car: agedCar(1, 1), at: 10_000 }, // no wire id: skipped
    { id: 7, car: agedCar(5, 1), at: NaN }, // never posed: skipped
  ]);
  expect(bytes.length).toBe(6 + 2 * AGED_BYTES);
  const pkt = must(decodeSnapshot(bytes));
  expect(pkt.type).toBe(TYPE_AGED);
  expect(pkt.tick, "the header is the newest pose").toBe(10_000);
  expect(pkt.cars.map((c) => [c.id, c.s, c.lap, c.age])).toStrictEqual([[4, 100, 2, 0], [9, 250.5, 3, 40]]);
  expect(must(pkt.cars[1]).braking).toBe(true);
  // A plain snapshot still decodes, every entry age 0.
  const plain = must(decodeSnapshot(encodeSnapshot(500, [{ id: 1, car: agedCar(3, 1) }])));
  expect(plain.type).toBe(TYPE_SNAPSHOT);
  expect(must(plain.cars[0]).age).toBe(0);
  // Truncation is refused for the aged layout too.
  expect(decodeSnapshot(bytes.slice(0, bytes.length - 1))).toBe(null);
});
