// A small analytic track shared by the module-fixture generator
// (tools/oracle/modules.mjs, run under Node's type stripping) and the Vitest
// tests that replay its fixtures. Self-contained and erasable-syntax only, so
// both sides run the exact same float operations. It is NOT a real circuit:
// it exists so the wall/contact modules see varied geometry, a pit wall and
// gantry posts.

export interface FakeSample {
  p: [number, number, number];
  t: [number, number, number];
  r: [number, number, number];
  hw: number;
}

export interface FakePost {
  s: number;
  side: number;
  lat: number;
  halfS: number;
  halfX: number;
}

export interface FakePit {
  painted: boolean;
  v: Float32Array;
  w: Float32Array;
  side: number;
  sOut: number;
  exitRoadM: number;
  bands: { verge: number };
  off: { fastIn: number };
}

export interface FakeTrack {
  total: number;
  n: number;
  hw: Float32Array;
  pit: FakePit | null;
  posts: FakePost[];
  street: boolean;
}

const R = 160;
export const FAKE_TOTAL = 2 * Math.PI * R;

export function makeFakeTrack(withPit: boolean, street: boolean): FakeTrack {
  const n = 256;
  const hw = new Float32Array(n);
  for (let i = 0; i < n; i++) hw[i] = 6 + Math.sin(i / 9);
  let pit: FakePit | null = null;
  if (withPit) {
    const v = new Float32Array(n),
      w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // a pit wall over nodes 40..80, an exit-road blend over 80..100
      v[i] = i >= 40 && i < 80 ? 1 : i >= 80 && i < 100 ? (100 - i) / 20 : 0;
      w[i] = i >= 30 && i < 100 ? 1 : 0;
    }
    pit = { painted: false, v, w, side: 1, sOut: (80 / n) * FAKE_TOTAL, exitRoadM: 60, bands: { verge: 0.5 }, off: { fastIn: 4 } };
  }
  const posts: FakePost[] = [
    { s: 600, side: -1, lat: 9, halfS: 1.2, halfX: 0.5 },
    { s: 900, side: 1, lat: 10, halfS: 1.2, halfX: 0.5 },
  ];
  return { total: FAKE_TOTAL, n, hw, pit, posts, street };
}

export function fakeWrapS(s: number): number {
  const L = FAKE_TOTAL;
  s %= L;
  return s < 0 ? s + L : s;
}

export function fakeSample(s: number, out: FakeSample): FakeSample {
  const th = s / R;
  const c = Math.cos(th),
    sn = Math.sin(th);
  out.p[0] = R * sn;
  out.p[1] = 0.8 * Math.sin(s / 70);
  out.p[2] = R * c;
  out.t[0] = c;
  out.t[1] = 0.01 * Math.cos(s / 70);
  out.t[2] = -sn;
  out.r[0] = -sn * 0.999;
  out.r[1] = 0;
  out.r[2] = -c * 0.999;
  out.hw = 6 + Math.sin(s / 90);
  return out;
}

export function fakeWallAt(s: number, side: number): number {
  return side >= 0 ? 9 + 2 * Math.sin(s / 40) : 8 + 1.5 * Math.cos(s / 55);
}

export function fakePostLimits(
  track: FakeTrack,
  s: number,
  x: number,
  out: { r: number; l: number; minOut: number; side: number },
): { r: number; l: number; minOut: number; side: number } {
  out.r = Infinity;
  out.l = Infinity;
  out.minOut = 0;
  out.side = 0;
  const P = track.posts;
  const L = track.total;
  for (let i = 0; i < P.length; i++) {
    const p = P[i] as FakePost;
    let d = s - p.s;
    d -= L * Math.round(d / L);
    if (d > p.halfS || d < -p.halfS) continue;
    if (x * p.side < p.lat) {
      const lim = p.lat - p.halfX - 0.3;
      if (p.side > 0) {
        if (lim < out.r) out.r = lim;
      } else if (lim < out.l) out.l = lim;
    } else {
      const lim = p.lat + p.halfX + 0.3;
      if (lim > out.minOut) {
        out.minOut = lim;
        out.side = p.side;
      }
    }
  }
  return out;
}

/** f1-game game.js:516 worldFromTrack over the fake sample. */
export function fakeWorldFromTrack(s: number, x: number, out: FakeSample, wf: { x: number; z: number }): { x: number; z: number } {
  fakeSample(s, out);
  let rx = out.r[0],
    rz = out.r[2];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  wf.x = out.p[0] + rx * x;
  wf.z = out.p[2] + rz * x;
  return wf;
}

export function newSample(): FakeSample {
  return { p: [0, 0, 0], t: [0, 0, 0], r: [0, 0, 0], hw: 0 };
}
