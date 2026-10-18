/**
 * Typed stand-ins for the f1-game `G` façade and session that the netplay unit
 * tests drive `createNetPlay` with.
 *
 * Ports of the harnesses in f1-game tests/unit/net-authority.test.mjs
 * (`fakeSession` :93-145, `stubG` :169-202, `started` :205-212, `stateSession`
 * / `poseG` :1167-1182), netplay-resilience.test.mjs (`stubG` :27-42,
 * `fakeSession` :44-72), net-grid-separation.test.mjs (`gridG` :38-56,
 * `fakeSession` :60-75) and net-start-arming.test.mjs (`stubG` :34-45).
 *
 * f1-game's stubs were plain objects with most car fields left `undefined`;
 * `NetCar` is fully typed, so `stubCar` fills every field with the value the
 * f1-game code treats the same as `undefined` (false, null, 0, Infinity for
 * `best`, NaN for `gridPos` so `separateGrid` finds no slot to swap, exactly as
 * `undefined + i` did). `wireId` is the car's index, as `c.idx` was.
 */
import { expect } from "vitest";
import type { NetCar, NetPlayCtx, NetStart, NetTrack, PeerQuali, PeerQualiLive } from "../../../src/contracts/net";
import type { SimTrackDef } from "../../../src/contracts/sim";
import type { TrackSample } from "../../../src/contracts/track";
import { createNetPlay, type NetPlay, type NetRole, type StartOptions, type StartResult } from "../../../src/net/netplay";
import type { EventHandler, NetSession, SessionCloseReason, SessionStats, StateHandler } from "../../../src/net/session";
import { decodeSnapshot, encodeSnapshot, type DecodedSnapshot, type WireCarSource } from "../../../src/net/snapshot";
import type { WireData } from "../../../src/net/transport";

/** One NetCar with every field at its "unset" value; `i` names it D<i> / drv<i>. */
export function stubCar(i: number, local: boolean, over: Partial<NetCar> = {}): NetCar {
  const car: NetCar = {
    // CarState
    human: local,
    local,
    isPlayer: local,
    s: i * 10,
    x: 0,
    prog: 0,
    lap: 0,
    px: 0,
    pz: 0,
    head: 0,
    speed: 0,
    vLat: 0,
    yawRateCur: 0,
    steerSm: undefined,
    kerbGripSm: 1,
    gear: 1,
    rpm: 0,
    shiftT: 0,
    energy: 1,
    boostOn: false,
    deploying: false,
    xOn: false,
    aeroX: 0,
    onKerb: undefined,
    inPitLane: undefined,
    offroad: false,
    slipFront: undefined,
    slipRear: undefined,
    steerAngle: undefined,
    lateralAccel: undefined,
    lapTime: 0,
    best: Infinity,
    tyreWear: 0,
    retired: false,
    finished: false,
    // NetCarFields
    team: { id: "", tier: 0 }, // f1-game stubs had no team; "" matches no profile
    seat: 0,
    tier: 0,
    gridPos: NaN,
    driverId: "drv" + i,
    code: "D" + i,
    mods: null,
    braking: false,
    xVis: 0,
    yawVis: 0,
    rPrevPx: 0,
    rPrevPz: 0,
    rPrevS: 0,
    rPrevX: 0,
    rPrevHead: 0,
    rPrevYawVis: 0,
    _prevS: 0,
    finishT: null,
    lastLap: 0,
    dnf: null,
    dnfAt: null,
    dnfWhy: null,
    incidentInvalidLap: false,
    _secT0: null,
    netInput: null,
    tyre: null,
    tread: 0,
    pitState: "none",
    pitArmed: false,
    _nOk: false,
    _nProg: 0,
    _nX: 0,
    _nSpd: 0,
    _nHuman: false,
    _nFallback: false,
    _nOwnerLap: 0,
    _nOwnerS: 0,
    _nFin: null,
    _nFinLap: null,
    _nMid: false,
    _nRiseT: null,
  };
  return Object.assign(car, over);
}

/** A track whose tangent is always +Z (f1-game's `Tracks.sample` stub). */
export interface StubTrack extends NetTrack {
  length: number;
}

export function stubTrack(length = 5000, def: SimTrackDef | null = null): StubTrack {
  const sample = (_s: number, out: TrackSample): TrackSample => {
    out.t[0] = 0;
    out.t[2] = 1;
    return out;
  };
  // f1-game's stubs mostly had no `def`; netplay reads `G.track.def &&` before
  // any use, so an absent def is a state the port must still handle.
  // TODO(coordinator): NetTrack.def is required by type; make it optional if
  // the real track may lack one.
  return (def ? { length, sample, def } : { length, sample }) as StubTrack;
}

/** NetPlayCtx with every member writable, plus the hooks the tests record into. */
export interface StubCtx extends NetPlayCtx {
  cars: NetCar[];
  player: NetCar | null;
  track: StubTrack | null;
  lapsTarget: number;
  raceT: number;
  COUNTDOWN_S: number;
  gridPreOrdered: boolean;
  netNow: number | null;
  netStart: NetStart | null;
  caughtCautions: unknown[];
  caughtQuali: PeerQuali[];
  caughtQLive: PeerQualiLive[];
  announcements: string[];
  swaps: Array<[number, number]>;
  retired: string[];
  worldFromTrack(s: number, x: number): Readonly<{ x: number; z: number }>;
  retireCar?(c: NetCar, why: string): void;
}

export interface StubOptions {
  /** Index of the local car; < 0 for none (a spectator). */
  readonly local?: number;
  readonly lapsTarget?: number;
  readonly raceT?: number;
  readonly trackDef?: SimTrackDef | null;
  readonly gridPreOrdered?: boolean;
}

/** f1-game `stubG(n)`: `n` cars, car `local` is ours and human. */
export function stubCtx(n = 2, opts: StubOptions = {}): StubCtx {
  const local = opts.local ?? 0;
  const cars: NetCar[] = [];
  for (let i = 0; i < n; i++) cars.push(stubCar(i, i === local));
  const G: StubCtx = {
    cars,
    player: local >= 0 ? (cars[local] ?? null) : null,
    track: stubTrack(5000, opts.trackDef ?? null),
    lapsTarget: opts.lapsTarget ?? 0,
    raceT: opts.raceT ?? 0,
    COUNTDOWN_S: 3,
    gridPreOrdered: opts.gridPreOrdered ?? false,
    netNow: null,
    netStart: null,
    caughtCautions: [],
    caughtQuali: [],
    caughtQLive: [],
    announcements: [],
    swaps: [],
    retired: [],
    wireId: (c) => G.cars.indexOf(c),
    setCarRole(c, human, isLocal) {
      c.human = human;
      c.local = isLocal;
    },
    worldFromTrack: (s, x) => ({ x, z: s }),
    swapGridSlots(a, b) {
      G.swaps.push([G.cars.indexOf(a), G.cars.indexOf(b)]);
      const t = a.gridPos;
      a.gridPos = b.gridPos;
      b.gridPos = t;
    },
    announce(text) {
      G.announcements.push(text);
    },
    applyCaution(d) {
      G.caughtCautions.push(d);
    },
    onPeerQuali(q) {
      G.caughtQuali.push(q);
    },
    onPeerQualiLive(q) {
      G.caughtQLive.push(q);
    },
  };
  return G;
}

/** f1-game net-authority `poseG(n)`: a stub with laps and a race clock. */
export function poseCtx(n: number, opts: StubOptions = {}): StubCtx {
  return stubCtx(n, { lapsTarget: 5, raceT: 10, ...opts });
}

/** `G.cars[i]`, asserted present (noUncheckedIndexedAccess). */
export function carAt(G: { cars: readonly NetCar[] }, i: number): NetCar {
  const c = G.cars[i];
  if (!c) throw new Error("no car " + i);
  return c;
}

export function must<T>(v: T | null | undefined, what = "value"): T {
  if (v == null) throw new Error("missing " + what);
  return v;
}

export interface SentEvent {
  readonly t: string;
  readonly d: unknown;
}

/**
 * A session NetPlay can bind to, with hand-fed inbound channels. close()
 * mirrors the real NetSession: it fires onClose("local") synchronously.
 */
export class FakeSession implements NetSession {
  readonly sent: SentEvent[] = [];
  readonly states: Array<DecodedSnapshot | null> = [];
  closed = 0;
  private handlers = new Map<string, EventHandler[]>();
  private closeHandlers: Array<(reason: SessionCloseReason) => void> = [];
  private stateFn: StateHandler | null = null;

  clearHandlers(): this {
    this.handlers.clear();
    this.closeHandlers.length = 0;
    this.stateFn = null;
    return this;
  }
  onState(fn: StateHandler): this {
    this.stateFn = fn;
    return this;
  }
  onClose(fn: (reason: SessionCloseReason) => void): this {
    this.closeHandlers.push(fn);
    return this;
  }
  onEvent(type: string, fn: EventHandler): this {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
    return this;
  }
  sendEvent(type: string, data?: unknown): boolean {
    this.sent.push({ t: type, d: data });
    return true;
  }
  sendState(bytes: WireData): boolean {
    this.states.push(decodeSnapshot(bytes));
    return true;
  }
  pump(_now: number): boolean {
    return true;
  }
  alive(): boolean {
    return true;
  }
  lagMs(): number {
    return 0;
  }
  rtt(): number {
    return 0;
  }
  offset(): number {
    return 0;
  }
  synced(): boolean {
    return true;
  }
  peerToLocal(t: number): number {
    return t;
  }
  localToPeer(t: number): number {
    return t;
  }
  setTimeoutMs(ms: number): number {
    return ms;
  }
  lastHeard(): number | null {
    return null;
  }
  stats(): SessionStats {
    return {} as SessionStats;
  }
  close(): void {
    this.closed++;
    const fns = this.closeHandlers.slice();
    this.handlers.clear();
    this.closeHandlers.length = 0;
    for (const fn of fns) fn("local");
  }
  /** The transport dropped: fire onClose(why) without the local close. */
  disconnect(why: SessionCloseReason = "transport"): void {
    for (const fn of [...this.closeHandlers]) fn(why);
  }
  handlerCount(): number {
    let n = this.closeHandlers.length;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }
  /** Deliver an inbound event AS IF the peer on this connection had sent it. */
  deliver(type: string, data: unknown): void {
    for (const fn of this.handlers.get(type) ?? []) fn(data, type);
  }
  /** Deliver raw state bytes, stamped `at` by the transport. */
  feedBytes(bytes: WireData, at?: number): void {
    if (this.stateFn) this.stateFn(bytes, at as number);
  }
  /** One car's snapshot at `tick`, arriving at `at`. */
  feed(tick: number, id: number, car: WireCarSource, at?: number): void {
    this.feedBytes(encodeSnapshot(tick, [{ id, car }]), at);
  }
  /** The `d` of the first sent event of `type`. */
  firstSent(type: string): Record<string, unknown> {
    const e = this.sent.find((m) => m.t === type);
    expect(e, "a sent " + type).toBeTruthy();
    return (e as SentEvent).d as Record<string, unknown>;
  }
}

export interface Started {
  readonly G: StubCtx;
  readonly net: NetPlay;
  readonly s: FakeSession;
}

/** f1-game net-authority `started(role)`: a started NetPlay plus its peer's session. */
export function started(role: NetRole, n = 2): Started {
  const G = stubCtx(n);
  const net = createNetPlay(G);
  const s = new FakeSession();
  const r: StartResult = net.start({ role, session: s });
  expect(r.ok, `start() must succeed for a ${role}: ${r.ok ? "" : r.error}`).toBe(true);
  return { G, net, s };
}

export function startOk(net: NetPlay, opts: StartOptions): void {
  const r = net.start(opts);
  expect(r.ok, `start() must succeed: ${r.ok ? "" : r.error}`).toBe(true);
}

/** f1-game `lapPose(s)` / `pose(s)`. */
export const lapPose = (s: number): WireCarSource => ({ s, x: 0, head: 0, speed: 60, gear: 5, lap: 1 });
