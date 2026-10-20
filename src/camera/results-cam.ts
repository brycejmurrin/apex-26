/* Apex 26 — RESULTS CAM (createResultsCam(host)): chequered-flag finish cut,
 * slow orbit behind the results sheet, and a short highlights montage from the
 * solo ReplayBuf tags. Solo presentation only — never touches netplay authority
 * or career settlement. Off on mobile / PerfGov.tier() >= 2. Cap orbit/highlight
 * redraws at 30 fps. Curvature only via host.camVantage (broadcast-only).
 *
 * Ported verbatim from f1-game js/camera/results-cam.js:1-281 (ResultsCam). The
 * IIFE becomes module functions + `createResultsCam(host, eligible, deps)`.
 * Ambient globals are injected:
 *   G               → host (ResultsHost), read live
 *   PerfGov.tier    → deps.perfTier TODO(lane-render): js/render perf governor   results-cam.js:19
 *   Tracks.sample   → deps.sample  (default src/track/core/spline.ts sample)     :154
 *   Tracks.banking  → deps.banking (default src/track/core/mesh.ts banking)      :142, :155
 *   document        → deps.doc (the results-sheet HIGHLIGHTS button)             :87-95, :245-267
 * THE ARC RULE: this reads the world and writes only host.dbgCam. */
import type { Sample, Track } from "../track/core/types";
import { sample as trackSample } from "../track/core/spline";
import { banking as trackBanking } from "../track/core/mesh";
import type { CamPose, DbgCam } from "./director";
import type { CamVantage, VantageExtra } from "./modes";
import type { ReplayTag, ReplayWindow } from "./replay-buf";

export const CHEQ_S = 2.2;
export const ORBIT_PERIOD_S = 28;
export const ORBIT_RADIUS = 18;
export const ORBIT_HEIGHT = 6;
export const HIGHLIGHT_CLIP_S = 4;
export const HIGHLIGHT_MAX_S = 45;
export const FRAME_DT = 1 / 30;

/** A car as the results cam reads it (results-cam.js:24-30, :126-160). */
export interface ResultsCar {
  s?: number;
  x?: number;
  px?: number | null;
  py?: number;
  pz?: number;
  head?: number;
  speed?: number;
  finPos?: number;
  retired?: boolean;
}

/** The G members read and written (results-cam.js:77-273). TODO(lane-shell): the app binds it. */
export interface ResultsHost<C extends ResultsCar = ResultsCar> {
  gfx?: { isMobile?: boolean } | null;
  netPlay?: { active?(): boolean } | null;
  dbgCam: object | null;
  cars?: ReadonlyArray<C | null | undefined> | null;
  player?: C | null;
  track?: Track | null;
  camVantage?: CamVantage | null;
  camPoseOf?(car: C): CamPose | null | undefined;
}

/** The ReplayBuf surface the montage drives (src/camera/replay-buf.ts). */
export interface ResultsReplay {
  window(): Pick<ReplayWindow, "t0" | "t1" | "frames">;
  tags?(): ReadonlyArray<Partial<ReplayTag>>;
  beginScrub(showControls: boolean): boolean;
  apply(t: number): unknown;
  endScrub(): unknown;
}

export type SampleFn = (track: Track, s: number, out: Sample) => unknown;
export type BankFn = (track: Track, s: number, x: number, out?: { dy: number; roll: number } | null, smooth?: boolean) => { dy: number } | null;

export interface ResultsDeps {
  /** PerfGov.tier (results-cam.js:19). TODO(lane-render). */
  readonly perfTier?: (() => number) | null;
  /** Tracks.sample; undefined = src/track/core, null = no road (orbit at car.py). */
  readonly sample?: SampleFn | null;
  /** Tracks.banking; undefined = src/track/core, null = unbanked. */
  readonly banking?: BankFn | null;
  readonly doc?: Document | null;
}

export interface ResultsPose { eye: number[]; target: number[]; fov: number }
export interface ReelClip {
  kind: string;
  t0: number;
  t1: number;
  car: number;
  events?: Array<{ kind: string; t: number | undefined; car: number }>;
}

export function enabled<C extends ResultsCar>(G: ResultsHost<C>, perfTier?: (() => number) | null): boolean {
  const g = G.gfx;
  if (g && g.isMobile) return false;
  if (perfTier && perfTier() >= 2) return false;
  return true;
}

/** Pure: finish-line side vantage extras for camVantage("side", …). */
export function chequeredExtra(player: ResultsCar | null | undefined): VantageExtra {
  return {
    carPos: player && player.px != null ? [player.px, player.pz as number] : null,
    carHead: player ? player.head : undefined,
    noLook: true, frameSubject: true, snap: true,
  };
}

/** Pure: orbit eye/target around a world point (winner). */
export function orbitPose(cx: number, cy: number, cz: number, yaw: number): ResultsPose {
  const eye = [
    cx + Math.sin(yaw) * ORBIT_RADIUS,
    cy + ORBIT_HEIGHT,
    cz + Math.cos(yaw) * ORBIT_RADIUS,
  ];
  const target = [cx, cy + 1.2, cz];
  return { eye, target, fov: 55 };
}

/** Pure: pick highlight windows from ReplayBuf-shaped tags inside [t0,t1]. */
export function highlightsReel(tags: ReadonlyArray<Partial<ReplayTag> | null | undefined> | null | undefined, t0: number, t1: number, maxS: number): ReelClip[] {
  if (!(t1 > t0) || !(maxS > 0)) return [];
  const list = (tags || []).filter((g): g is Partial<ReplayTag> & { t: number } => !!g && Number.isFinite(g.t) && (g.t as number) >= t0 && (g.t as number) <= t1)
    .slice().sort((a, b) => a.t - b.t);
  const merged: Array<ReelClip & { _tagT?: number }> = [];
  for (const g of list) {
    const dur = Math.min(HIGHLIGHT_CLIP_S, t1 - t0);
    const start = Math.min(Math.max(t0, g.t - dur * 0.55), t1 - dur);
    const clip: ReelClip & { _tagT?: number } = { kind: g.kind || "tag", t0: start, t1: start + dur, car: (g.car as number) | 0 };
    // Repeated tags on one subject should not rewind the same incident.
    // Other subjects keep their own shots, even when the time windows overlap.
    let prev: (ReelClip & { _tagT?: number }) | null = null;
    for (let i = merged.length - 1; i >= 0; i--) {
      const p = merged[i] as ReelClip & { _tagT?: number };
      if (p.car === clip.car && Math.min(p.t1, clip.t1) - Math.max(p.t0, clip.t0) >= Math.min(p.t1 - p.t0, dur) * 0.5) { prev = p; break; }
    }
    if (prev) {
      if (!prev.events) prev.events = [{ kind: prev.kind, t: prev._tagT, car: prev.car }];
      prev.events.push({ kind: clip.kind, t: g.t, car: clip.car });
      prev.t0 = Math.min(prev.t0, clip.t0); prev.t1 = Math.max(prev.t1, clip.t1);
    } else { clip._tagT = g.t; merged.push(clip); }
  }
  const out: ReelClip[] = [];
  let budget = maxS;
  for (let i = merged.length - 1; i >= 0 && budget > 0; i--) {
    const clip = merged[i] as ReelClip, dur = Math.min(clip.t1 - clip.t0, budget);
    const kept: ReelClip = { kind: clip.kind, t0: clip.t1 - dur, t1: clip.t1, car: clip.car };
    if (clip.events) kept.events = clip.events;
    out.push(kept); budget -= dur;
  }
  return out.reverse().sort((a, b) => a.t0 - b.t0);
}

export type ResultsPhase = "idle" | "chequered" | "orbit" | "highlights" | "done";

export type ResultsCam = ReturnType<typeof createResultsCam>;

export function createResultsCam<C extends ResultsCar>(G: ResultsHost<C>, eligible?: (() => boolean) | null, deps: ResultsDeps = {}) {
  const doc: Document | null = deps.doc !== undefined ? deps.doc : (typeof document !== "undefined" ? document : null);
  const perfTier = deps.perfTier ?? null;
  const sampleFn: SampleFn | null = deps.sample !== undefined ? deps.sample : trackSample;
  const bankFn: BankFn | null = deps.banking !== undefined ? deps.banking : trackBanking;
  let phase: ResultsPhase = "idle";   // idle | chequered | orbit | highlights | done
  let age = 0, orbitYaw = 0, frameAcc = 0;
  let reel: ReelClip[] = [], reelIdx = 0, clipAge = 0;
  let replayApi: ResultsReplay | null = null;
  const anchor: Sample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };
  const bankScratch = { dy: 0, roll: 0 };
  const allowed = (): boolean => enabled(G, perfTier) && (!eligible || eligible()) &&
    !(G.netPlay && G.netPlay.active && G.netPlay.active());
  function highlightsPresentation(playing: boolean): void {
    if (!doc) return;
    const results = doc.getElementById("results"), button = doc.getElementById("res-highlights");
    if (results) {
      if (playing) results.dataset["resultsPlayback"] = "playing";
      else delete results.dataset["resultsPlayback"];
    }
    if (button) button.textContent = playing ? "BACK TO RESULTS" : "HIGHLIGHTS";
  }
  function endHighlights(): void {
    if (phase === "highlights" && replayApi) replayApi.endScrub();
    highlightsPresentation(false);
  }

  function attachReplay(api: ResultsReplay | null | undefined): void { replayApi = api || null; }

  function live(): boolean {
    return phase === "chequered" || phase === "orbit" || phase === "highlights";
  }
  function status(): { phase: ResultsPhase; age: number; live: boolean; clips: number; clip: number } {
    return { phase, age, live: live(), clips: reel.length, clip: reelIdx };
  }
  function reset(): void {
    endHighlights();
    phase = "idle"; age = 0; orbitYaw = 0; frameAcc = 0;
    reel = []; reelIdx = 0; clipAge = 0;
    if (G.dbgCam && (G.dbgCam as DbgCam)._resultsCam) G.dbgCam = null;
    if (doc) {
      const b = doc.getElementById("res-highlights");
      if (b) b.hidden = true;
    }
  }
  function publish(pose: ResultsPose | null): void {
    if (!pose || !pose.eye) return;
    const cam: DbgCam = {
      eye: pose.eye.slice(), target: pose.target.slice(),
      fov: pose.fov || 55, far: 6000, _resultsCam: true,
    };
    G.dbgCam = cam;
  }
  function subject(): C | null {
    const cars = G.cars || [];
    let best: C | null | undefined = G.player;
    for (const c of cars) {
      if (!c || c.retired) continue;
      if (!best || ((c.finPos as number) > 0 && (!best.finPos || (c.finPos as number) < best.finPos))) best = c;
    }
    return best || cars[0] || null;
  }
  function cheqPose(p: C | null = subject()): ResultsPose | null {
    if (!p || !G.camVantage) return null;
    const pose = G.camPoseOf ? G.camPoseOf(p) : null;
    const extra = chequeredExtra(p);
    if (pose) { extra.carPos = pose.carPos ?? null; extra.carHead = pose.carHead; }
    const s = pose ? pose.s : (p.s || 0), x = pose ? pose.x : (p.x || 0);
    // Match the side rig's smooth bank lift, including replayed highlight poses.
    const bank = G.track && bankFn ? bankFn(G.track, s, x, bankScratch, true) : null;
    extra.bankDy = bank ? bank.dy : 0;
    const v = G.camVantage("side", s, x, p.speed || 0, 0, extra);
    if (!v || !v.eye) return null;
    return { eye: v.eye as number[], target: (v.tgt || v.target || [p.px, p.py || 1, p.pz]) as number[], fov: v.fov || 58 };
  }
  function doOrbit(p: C | null = subject()): ResultsPose | null {
    if (!p) return null;
    const pose = G.camPoseOf ? G.camPoseOf(p) : null;
    let y = p.py || 0;
    if (G.track && sampleFn) {
      const s = pose ? pose.s : (p.s as number), x = pose ? pose.x : (p.x as number);
      sampleFn(G.track, s, anchor);
      const bank = bankFn ? bankFn(G.track, s, x) : null;
      y = anchor.p[1] + (bank ? bank.dy : 0);
    }
    const pos = pose && pose.carPos;
    return orbitPose(pos ? pos[0] as number : (p.px || 0), y, pos ? pos[1] as number : (p.pz || 0), orbitYaw);
  }
  function onFlag(): boolean {
    reset();
    if (!allowed()) return false;
    phase = "chequered"; age = 0;
    const pose = cheqPose();
    if (pose) publish(pose);
    ensureHighlightsButton();
    return true;
  }
  function startOrbit(): boolean {
    if (!live() || !allowed()) return false;
    endHighlights();
    phase = "orbit"; age = 0; orbitYaw = 0;
    const pose = doOrbit();
    if (pose) publish(pose);
    return true;
  }
  function startHighlights(): boolean {
    if (!live() || !allowed() || phase === "highlights") return false;
    const buf = replayApi;
    if (!buf || !buf.window) return false;
    const w = buf.window();
    const tags = (buf.tags && buf.tags()) || [];
    reel = highlightsReel(tags, w.t0, w.t1, HIGHLIGHT_MAX_S);
    if (!reel.length && w.frames > 2 && w.t1 > w.t0) {
      const dur = Math.min(HIGHLIGHT_CLIP_S, w.t1 - w.t0);
      reel = [{ kind: "window", t0: w.t1 - dur, t1: w.t1, car: -1 }];   // no tagged car: film the winner
    }
    if (!reel.length || !buf.beginScrub(false)) return false;
    phase = "highlights"; reelIdx = 0; clipAge = 0; age = 0;
    highlightsPresentation(true);
    applyHighlightFrame();
    return true;
  }
  function applyHighlightFrame(): void {
    const buf = replayApi;
    const clip = reel[reelIdx];
    if (!buf || !clip) return;
    const t = clip.t0 + Math.min(clip.t1 - clip.t0, clipAge);
    buf.apply(t);
    // A retirement remains the subject of its clip; winner selection is
    // only for the flag/orbit and tags whose car is no longer available.
    const p = (G.cars || [])[clip.car] || subject();
    const pose = cheqPose(p) || doOrbit(p);
    if (pose) publish(pose);
  }
  function tick(dt: number): boolean {
    if (!live()) return false;
    if (!allowed()) { reset(); return false; }
    frameAcc += dt;
    if (frameAcc < FRAME_DT) return true;   // still live, but skip work
    const step = frameAcc; frameAcc = 0;
    age += step;
    if (phase === "chequered") {
      const pose = cheqPose();
      if (pose) publish(pose);
      if (age >= CHEQ_S) startOrbit();
      return true;
    }
    if (phase === "orbit") {
      orbitYaw += (Math.PI * 2 / ORBIT_PERIOD_S) * step;
      const pose = doOrbit();
      if (pose) publish(pose);
      return true;
    }
    if (phase === "highlights") {
      clipAge += step;
      const clip = reel[reelIdx];
      if (!clip || clipAge >= (clip.t1 - clip.t0)) {
        reelIdx++; clipAge = 0;
        if (reelIdx >= reel.length) return startOrbit();
      }
      applyHighlightFrame();
      return true;
    }
    return false;
  }
  /** True when ReplayBuf has a scrubbable window startHighlights can acquire. */
  function footageReady(): boolean {
    const buf = replayApi;
    if (!buf || !buf.window) return false;
    const w = buf.window();
    return !!(w && w.frames > 2 && w.t1 > w.t0);
  }
  function ensureHighlightsButton(): void {
    if (!doc) return;
    const show = live() && allowed() && footageReady();
    const existing = doc.getElementById("res-highlights") as HTMLButtonElement | null;
    if (existing) {
      existing.hidden = !show;
      existing.disabled = !show;
      existing.title = show ? "" : "No recorded footage for highlights";
      highlightsPresentation(phase === "highlights");
      return;
    }
    const menu = doc.getElementById("res-menu");
    if (!menu || !menu.parentNode) return;
    const b = doc.createElement("button");
    b.id = "res-highlights";
    b.hidden = !show;
    b.disabled = !show;
    b.title = show ? "" : "No recorded footage for highlights";
    b.type = "button";
    b.textContent = "HIGHLIGHTS";
    b.onclick = () => { if (phase === "highlights") startOrbit(); else startHighlights(); };
    menu.parentNode.insertBefore(b, menu);
  }

  return {
    onFlag, startOrbit, startHighlights, tick, live, status, reset,
    ensureHighlightsButton, attachReplay, enabled: () => enabled(G, perfTier),
  };
}
