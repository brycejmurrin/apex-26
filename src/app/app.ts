/**
 * The app shell for the Phase 1 slice: the Monza time trial (PLAN T1.12).
 *
 * f1-game's equivalent is the `tick`/`tickBody`/`render` trio in
 * js/game.js:8311-8458. Here each subsystem is its own module and this file
 * only wires them:
 * - track: the track lane's `loadPhysicsTrack` (built Monza, `PhysicsTrack`);
 * - physics: the physics lane's `createPlayerStep` with f1-game's shipped
 *   tunables (`SHIPPED_TUNE`) and the solo seams (no pits, green flag, calm, dry);
 * - render: the render lane's `TrackRenderer` (track meshes, sky, sun, post);
 * - car model: a placeholder body until the car lane's model lands (T1.8);
 * - shell: the fixed-step loop, input, chase camera and HUD.
 */
import { BoxGeometry, Group, Mesh, MeshStandardNodeMaterial } from "three/webgpu";
import type { CarHandle, MeshData, TrackMeshKey } from "../contracts/render";
import type { PlayerInput } from "../contracts/sim";
import type { TrackSample } from "../contracts/track";
import { ChaseCam } from "../camera/chase";
import { Hud, type HudState } from "../hud/hud";
import { dashKph } from "../hud/readouts";
import { Input } from "../input/input";
import { PhysicsConsts } from "../physics/consts";
import type { PhysicsTrack } from "../physics/track";
import * as Tyre from "../physics/tyre-model";
import type { TrackRenderer } from "../render/renderer";
import { FIXED_DT, FixedStepLoop, lerp, lerpAngle, type FrameResult } from "../sim/loop";
import { CALM, createPlayerStep, defaultDriveTune, DRY, GREEN_FLAG, NO_ASSISTS, NO_PITS, type DriveTune, type PlayerCar, type PlayerStep, type PlayerWorld } from "../sim/player-step";
import { newLapTiming } from "../sim/player-step-lap";
import type { Track, TrackGeometry } from "../track/core/types";
import { gridCar, makePlayerCar } from "./player-car";

/**
 * f1-game's shipped driving feel: the values its physics goldens record in the
 * pinned world (tests/goldens/physics-tape-*.json.gz `initial.world`), which
 * differ from `DriveTune.create`'s constructor defaults.
 */
export function shippedTune(): DriveTune {
  return { ...defaultDriveTune(), WHEELBASE: 4.2, STEER_EXPO: 2.111111111111111, STEER_MAX_SLIP: 0.35, STEER_SPEED_REF: 55, PACE: 0.8396192830323017 };
}

export interface AppOptions {
  readonly renderer: TrackRenderer;
  /** The built track and its physics query (`loadPhysicsTrack`). */
  readonly track: { readonly track: Track; readonly query: PhysicsTrack };
  /** Where the HUD mounts; omit for a headless app. */
  readonly hudParent?: HTMLElement;
}

const TRACK_KEYS: readonly TrackMeshKey[] = ["floor", "road", "terrain", "props", "glass", "water", "gate", "startline"];

export class App {
  readonly track: PhysicsTrack;
  readonly trackId: string;
  readonly player: PlayerCar;
  readonly world: PlayerWorld;
  readonly physics: PlayerStep;
  readonly input = new Input();
  readonly loop: FixedStepLoop;
  readonly hud: Hud | null;
  /** Simulated seconds since the session started. */
  simT = 0;
  /** Physics steps taken since boot. */
  stepCount = 0;
  /** The last input the sim consumed, for the debug API. */
  lastInput: PlayerInput | null = null;
  lastFrame: FrameResult = { dt: 0, steps: 0, dropped: 0, alpha: 0 };
  paused = false;

  private readonly chase: ChaseCam;
  private readonly carHandle: CarHandle;
  private readonly renderer: TrackRenderer;
  private readonly smp: TrackSample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };

  constructor(opts: AppOptions) {
    this.renderer = opts.renderer;
    this.track = opts.track.query;
    this.trackId = opts.track.track.def.id;
    const tune = shippedTune();
    const def = opts.track.track.def;
    const vTop = (): number => PhysicsConsts.VMAX * Math.max(tune.PACE, 0.05);
    const tyres = Tyre.create({
      raceTyreWear: "off",   // time trial: game.js:1752 tyres.setLevel(isTimeTrial() ? "off" : …)
      track: { length: this.track.length, def: def.tyreSeverity === undefined ? null : { tyreSeverity: def.tyreSeverity } },
      weatherArc: null,
      raceWeather: "dry",
      lapsTarget: 0,
      session: "tt",
      LAT_MAX: PhysicsConsts.LAT_MAX,
      aTop: () => PhysicsConsts.ACCEL * Math.max(tune.PACE, 0.05),   // game.js:378
      vTop,
    });
    this.world = {
      track: this.track,
      def,
      tune,
      raceT: 0,
      state: "race",
      session: "tt",
      lapsTarget: 0,
      dirtyAir: "classic",
      aeroMode: "manual",
      gearsManual: false,
      autoThrottle: false,
      liveInput: true,
      soundOn: false,
      weather: DRY,
      wind: CALM,
      pits: NO_PITS,
      raceCtl: GREEN_FLAG,
      tyres,
      aeroZoneAt: () => false,
      timing: newLapTiming(),
      netPlay: { owns: () => false },
    };
    this.physics = createPlayerStep(this.world);
    this.player = makePlayerCar();
    gridCar(this.player, this.track, 0);
    this.chase = new ChaseCam(this.track, vTop());
    this.loop = new FixedStepLoop({
      beforeStep: () => this.snapshot(),
      step: (dt) => this.step(dt),
    });
    uploadTrack(this.renderer, opts.track.track.geo);
    this.carHandle = this.renderer.addCar(placeholderCarModel());
    this.hud = opts.hudParent ? new Hud(opts.hudParent) : null;
  }

  /** One fixed step outside the frame loop (debug API): snapshot, then step. */
  stepOnce(): void {
    this.snapshot();
    this.step(FIXED_DT);
  }

  /** Advance the sim one fixed step. */
  step(dt = FIXED_DT): void {
    const inp = this.input.sample(dt);
    this.lastInput = inp;
    // A scripted input (__apex.setInput) is not the live devices (player-step.ts PlayerWorld.liveInput).
    (this.world as { liveInput: boolean }).liveInput = !this.input.overridden;
    this.physics.step(this.player, dt, inp, NO_ASSISTS);
    this.simT += dt;
    this.stepCount++;
  }

  /** game.js:8432-8436: the pose before the step, for render interpolation. */
  private snapshot(): void {
    const c = this.player;
    c.rPrevS = c.s; c.rPrevX = c.x; c.rPrevPx = c.px; c.rPrevPz = c.pz; c.rPrevHead = c.head;
  }

  /** One display frame at rAF timestamp `now` (ms). */
  frame(now: number): void {
    this.input.poll();
    if (this.input.consume("pause")) this.paused = !this.paused;
    if (this.input.consume("recover")) this.physics.rescuePlayer(this.player);
    if (this.paused) this.input.clearEdges();
    const f = this.loop.frame(now, !this.paused);
    this.lastFrame = f;
    this.render(f.alpha, Math.min(f.dt, 1 / 20));
    this.hud?.update(this.hudState(), now);
  }

  hudState(): HudState {
    const c = this.player;
    return {
      kph: Math.max(0, dashKph(c.speed, this.physics.pace.vStd)),
      gear: c.gear, lap: c.lap, laps: 0, lapTime: c.lapTime,
      last: c.lastLap ?? Number.NaN, best: c.best,
    };
  }

  private render(alpha: number, dt: number): void {
    const c = this.player, L = this.track.length;
    const pS = c.rPrevS ?? c.s, pX = c.rPrevX ?? c.x;
    const px = lerp(c.rPrevPx ?? c.px, c.px, alpha), pz = lerp(c.rPrevPz ?? c.pz, c.pz, alpha);
    const head = lerpAngle(c.rPrevHead ?? c.head, c.head, alpha);
    let ds = c.s - pS;
    if (ds < -L / 2) ds += L; else if (ds > L / 2) ds -= L;
    const s = this.track.wrapS(pS + ds * alpha), x = lerp(pX, c.x, alpha);
    const y = this.track.sample(s, this.smp).p[1];
    this.carHandle.setPose(px, y, pz, head, 0, 0);
    const pose = this.chase.solve({ s, x, speed: c.speed, px, pz, head, yawRate: c.yawRateCur, pitch: 0, deploy: c.deploying, dt });
    this.renderer.setCamera(pose);
    this.renderer.renderFrame();
  }

  resize(w: number, h: number, dpr: number): void {
    this.renderer.resize(w, h, dpr);
  }
}

/** Upload every track mesh slot (f1-game tracks.js:304-418 `createMesh` per slot). */
function uploadTrack(r: TrackRenderer, geo: TrackGeometry | undefined): void {
  if (!geo) return;
  for (const key of TRACK_KEYS) {
    const g = geo[key];
    if (!g || !g.pos.length) continue;
    const data: MeshData = {
      pos: Float32Array.from(g.pos),
      nrm: Float32Array.from(g.nrm),
      col: Float32Array.from(g.col),
      idx: Uint32Array.from(g.idx),
      ...(g.mat ? { mat: Float32Array.from(g.mat) } : {}),
      ...(g.trk ? { trk: Float32Array.from(g.trk) } : {}),
    };
    r.uploadTrackMesh(key, data);
  }
}

/** A box the size of the car's collider (4.8 x 2.0 m, vantage.js:85) until the car lane lands. */
function placeholderCarModel(): Group {
  const car = new Group();
  const body = new Mesh(
    new BoxGeometry(1.9, 0.8, 4.8),
    new MeshStandardNodeMaterial({ color: 0xe10600, roughness: 0.4, metalness: 0.1 }),
  );
  body.position.y = 0.45;
  body.castShadow = true;
  car.add(body);
  return car;
}
