/**
 * The app shell: one renderer, one track, one player car, the fixed-step loop,
 * input and the chase camera. f1-game's equivalent is the `tick`/`tickBody`/
 * `render` trio in js/game.js:8311-8458; here each subsystem is its own module
 * and this file only wires them.
 *
 * Phase 1 placeholders, replaced as the lanes merge (PLAN T1.12):
 * - track: `FlatLoop` until the track lane's Monza `TrackQuery` lands;
 * - car body: `stepPlaceholder` until the physics lane's player step lands;
 * - scene: plain three meshes until the render and car lanes land.
 */
import * as THREE from "three/webgpu";
import type { CarState, PlayerInput } from "../contracts/sim";
import type { TrackQuery, TrackSample } from "../contracts/track";
import { ChaseCam } from "../camera/chase";
import { Input } from "../input/input";
import { FIXED_DT, FixedStepLoop, lerp, lerpAngle, type FrameResult } from "../sim/loop";
import { Hud, type HudState } from "../hud/hud";
import { dashKph } from "../hud/readouts";
import { FlatLoop } from "./flat-loop";
import { LapTimer } from "./lap-timer";
import { makePlaceholderCar, placeCar, stepPlaceholder } from "./placeholder-body";

export interface AppOptions {
  readonly renderer: THREE.WebGPURenderer;
  readonly canvas: HTMLCanvasElement;
  /** Where the HUD mounts; omit for a headless app. */
  readonly hudParent?: HTMLElement;
}

/** Interpolation snapshot of the player before the last step (game.js:8432-8436 `rPrev*`). */
interface PrevPose { px: number; pz: number; head: number; s: number; x: number }

export class App {
  readonly track: TrackQuery;
  readonly player: CarState;
  readonly input = new Input();
  readonly timer = new LapTimer();
  readonly hud: Hud | null;
  readonly loop: FixedStepLoop;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 4000);
  /** Simulated seconds since the session started. */
  simT = 0;
  /** Physics steps taken since boot. */
  stepCount = 0;
  /** The last input the sim consumed, for the debug API. */
  lastInput: PlayerInput | null = null;
  lastFrame: FrameResult = { dt: 0, steps: 0, dropped: 0, alpha: 0 };
  paused = false;

  private readonly chase: ChaseCam;
  private readonly prev: PrevPose = { px: 0, pz: 0, head: 0, s: 0, x: 0 };
  private readonly carMesh: THREE.Object3D;
  private readonly renderer: THREE.WebGPURenderer;

  constructor(opts: AppOptions) {
    this.renderer = opts.renderer;
    this.track = new FlatLoop();
    this.player = makePlaceholderCar();
    placeCar(this.player, this.track, -20);
    this.chase = new ChaseCam(this.track);
    this.loop = new FixedStepLoop({
      beforeStep: () => this.snapshot(),
      step: (dt) => this.step(dt),
    });
    this.snapshot();
    this.carMesh = buildScene(this.scene, this.track);
    this.hud = opts.hudParent ? new Hud(opts.hudParent) : null;
  }

  /** Advance the sim one fixed step (also the debug API's `step`). */
  step(dt = FIXED_DT): void {
    const inp = this.input.sample(dt);
    this.lastInput = inp;
    const crossed = stepPlaceholder(this.player, inp, this.track, dt);
    this.timer.step(dt, crossed);
    this.player.lap = this.timer.lap;
    this.player.lapTime = this.timer.lapTime;
    this.simT += dt;
    this.stepCount++;
  }

  private snapshot(): void {
    const c = this.player, p = this.prev;
    p.px = c.px; p.pz = c.pz; p.head = c.head; p.s = c.s; p.x = c.x;
  }

  /** One display frame at rAF timestamp `now` (ms). */
  frame(now: number): void {
    this.input.poll();
    if (this.input.consume("pause")) this.paused = !this.paused;
    if (this.paused) this.input.clearEdges();
    const f = this.loop.frame(now, !this.paused);
    this.lastFrame = f;
    this.render(f.alpha, Math.min(f.dt, 1 / 20));
    this.hud?.update(this.hudState(), now);
  }

  hudState(): HudState {
    const c = this.player, t = this.timer;
    return { kph: Math.max(0, dashKph(c.speed)), gear: c.gear, lap: t.lap, laps: 0, lapTime: t.lapTime, last: t.last, best: t.best };
  }

  private render(alpha: number, dt: number): void {
    const c = this.player, p = this.prev, L = this.track.length;
    const px = lerp(p.px, c.px, alpha), pz = lerp(p.pz, c.pz, alpha);
    const head = lerpAngle(p.head, c.head, alpha);
    let ds = c.s - p.s;
    if (ds < -L / 2) ds += L; else if (ds > L / 2) ds -= L;
    const s = this.track.wrapS(p.s + ds * alpha), x = lerp(p.x, c.x, alpha);
    this.carMesh.position.set(px, 0, pz);
    this.carMesh.rotation.set(0, head, 0);
    const pose = this.chase.solve({ s, x, speed: c.speed, px, pz, head, yawRate: c.yawRateCur, pitch: 0, deploy: c.deploying, dt });
    const cam = this.camera;
    cam.position.set(pose.eye[0], pose.eye[1], pose.eye[2]);
    cam.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    const fovDeg = pose.fovY * 180 / Math.PI;
    if (cam.fov !== fovDeg) { cam.fov = fovDeg; cam.updateProjectionMatrix(); }
    this.renderer.render(this.scene, cam);
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }
}

/** Ground, road ribbon and a placeholder car box. Returns the car object. */
function buildScene(scene: THREE.Scene, track: TrackQuery): THREE.Object3D {
  scene.background = new THREE.Color(0x8fb4d9);
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x4a5a3a, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(200, 400, 100);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshStandardNodeMaterial({ color: 0x3f6b35, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  // 5 cm over the ground: software GL (swiftshader) loses a 2 cm gap to depth precision.
  scene.add(ribbon(track, 0, 0x2b2d31, 0.05));
  // Start/finish line.
  const sc: TrackSample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };
  track.sample(0, sc);
  const line = new THREE.Mesh(
    new THREE.BoxGeometry(sc.hw * 2, 0.02, 1.2),
    new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.8 }),
  );
  line.rotation.y = Math.atan2(sc.t[0], sc.t[2]);
  line.position.set(sc.p[0], 0.06, sc.p[2]);
  scene.add(line);

  const car = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.8, 4.8),
    new THREE.MeshStandardNodeMaterial({ color: 0xe10600, roughness: 0.4, metalness: 0.1 }),
  );
  body.position.y = 0.45;
  car.add(body);
  scene.add(car);
  return car;
}

/** A flat triangle strip along the track, `hw + extra` either side. */
function ribbon(track: TrackQuery, extra: number, color: number, y: number): THREE.Mesh {
  const n = Math.max(64, Math.ceil(track.length / 4));
  const pos = new Float32Array((n + 1) * 2 * 3);
  const idx: number[] = [];
  const sc: TrackSample = { p: [0, 0, 0], t: [0, 0, 1], r: [1, 0, 0], hw: 7 };
  for (let i = 0; i <= n; i++) {
    track.sample((i / n) * track.length, sc);
    const w = sc.hw + extra;
    pos.set([sc.p[0] - sc.r[0] * w, sc.p[1] + y, sc.p[2] - sc.r[2] * w, sc.p[0] + sc.r[0] * w, sc.p[1] + y, sc.p[2] + sc.r[2] * w], i * 6);
    if (i < n) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }   // up-facing: r x t = +Y
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9 }));
}
