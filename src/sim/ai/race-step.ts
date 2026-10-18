/**
 * The race step: one fixed physics tick of the whole field.
 *
 * Port of the race section of f1-game js/game.js `update()` (:4459-4537):
 * the clock, the field ranking, the leading human, the per-tick traffic
 * snapshot and arc buckets, `updateCar` for every car in `cars` order (human
 * or AI, src/sim/player-step.ts), and `resolveCollisions` over the ranked
 * field plus any car parked on the road, with `collideFx` (:4672) reduced to
 * the car state it writes. Statements are verbatim in order.
 *
 * Not here (other lanes' seams): reliability retirements, the safety-car and
 * blue-flag watchers, race control's batched line step and finish delay, the
 * pit lane's step hooks, the incident and debris side-worlds, presentation.
 */
import type { AssistInput, PlayerInput } from "../../contracts";
import * as Collide from "../../physics/collide";
import { PhysicsConsts } from "../../physics/consts";
import { NO_INCIDENTS } from "../../physics/fx";
import { clamp } from "../../physics/math";
import { createCarStep, type AiField, type PlayerCar, type PlayerWorld } from "../player-step";

/** A world with a field: `ai` is required. */
export interface RaceWorld extends PlayerWorld {
  readonly ai: AiField;
  /** The local player (f1-game `player`), even when retired; null in an AI-only race. */
  readonly player: PlayerCar | null;
}

export interface RaceStep {
  /** One tick: `inputOf` gives each human car its controls (AI cars are never asked). */
  step(dt: number, inputOf: (c: PlayerCar) => PlayerInput | null, assistsOf?: (c: PlayerCar) => AssistInput | undefined): void;
  readonly ranked: readonly PlayerCar[];
}

/** race-control.js:143-149 finishOrder: more laps first, then the clock (finishT + penalty). */
function finishOrder(a: PlayerCar, b: PlayerCar): number {
  const clock = (c: PlayerCar): number => {
    const t = c && c.finishT;
    return Number.isFinite(t) ? (t as number) + (c.penalty || 0) : Infinity;
  };
  return (b.lap || 0) - (a.lap || 0) || clock(a) - clock(b);
}

export function createRaceStep(world: RaceWorld): RaceStep {
  const cs = createCarStep(world);
  const ai = world.ai;
  const track = world.track;
  const fx = world.fx ?? {};
  const incidents = fx.incidents ?? NO_INCIDENTS;
  const ranked: PlayerCar[] = [];
  const parked = ai.parked;
  const finRanked: PlayerCar[] = [];
  const byProgDesc = (a: PlayerCar, b: PlayerCar): number => b.prog - a.prog;
  const scratch = { p: [0, 0, 0] as [number, number, number], t: [0, 0, 0] as [number, number, number], r: [0, 0, 0] as [number, number, number], hw: 0 };

  // collideFx (game.js:4672-4708), the car state only: audio, shake, hit-stop and
  // haptics are presentation, Damage.contact is display.
  function collideFx(a: PlayerCar, b: PlayerCar, impact: number): void {
    if (!a.isPlayer && !b.isPlayer) return;
    const pc = a.isPlayer ? a : b;
    if (pc.collideT > 0) return;
    impact = clamp(impact, 0.12, 1);
    if (world.soundOn && fx.audio) {
      const other = a.isPlayer ? b : a;
      const lat = (other.x != null ? other.x : 0) - (pc.x != null ? pc.x : 0);
      const side = Math.abs(lat) > 0.08 ? Math.max(-1, Math.min(1, lat / 3.5)) : 0;
      fx.audio.collision(impact, false, side);
    }
    if (fx.shake) fx.shake(impact * 0.45, 0);
    pc.collideT = 0.35;
    const hc = pc as PlayerCar & { hits?: number; hitSev?: number; fxSparkI?: number };
    hc.hits = ((hc.hits as number) | 0) + 1;
    hc.hitSev = Math.max(hc.hitSev || 0, impact);
    hc.fxSparkI = Math.max(hc.fxSparkI || 0, impact);
    if (fx.haptics) {
      fx.haptics.vibrate(18 + impact * 50);
      fx.haptics.rumble(0.4 + impact * 0.6, 120, "handles");
    }
  }
  const collide = Collide.create(
    {
      wrapS: cs.wrapS,
      get track() {
        return track;
      },
      get player() {
        return world.player;
      },
      netPlay: world.netPlay,
      get raceT() {
        return world.raceT;
      },
      get PACE() {
        return world.tune.PACE;
      },
      worldFromTrack: (s: number, x: number) => cs.worldFromTrack(s, x, scratch),
    },
    (a, b, impact) => collideFx(a as PlayerCar, b as PlayerCar, impact),
    () => false,
    { incidents, debris: fx.debris ?? null },
  );

  function rankFinishers(): void {
    finRanked.length = 0;
    for (let i = 0; i < ranked.length; i++) if ((ranked[i] as PlayerCar).finished) finRanked.push(ranked[i] as PlayerCar);
    finRanked.sort(finishOrder);
    for (let i = 0, k = 0; i < ranked.length; i++) if ((ranked[i] as PlayerCar).finished) (finRanked[k++] as PlayerCar).rank = i + 1;
  }

  function step(dt: number, inputOf: (c: PlayerCar) => PlayerInput | null, assistsOf?: (c: PlayerCar) => AssistInput | undefined): void {
    if (world.state !== "race") return;
    const cars = ai.cars;
    world.raceT += dt;
    ranked.length = 0;
    for (const c of cars) if (!c.retired) ranked.push(c);
    ranked.sort(byProgDesc);
    let nFin = 0;
    for (let i = 0; i < ranked.length; i++) {
      (ranked[i] as PlayerCar).rank = i + 1;
      if ((ranked[i] as PlayerCar).finished) nFin++;
    }
    if (nFin > 1) rankFinishers();
    ai.leadHuman = null;
    for (const c of cars) if (c.human && !c.retired && !c.finished && (!ai.leadHuman || c.prog > ai.leadHuman.prog)) ai.leadHuman = c;
    for (let i = 0; i < cars.length; i++) {
      const s = cars[i] as PlayerCar;
      s._snapProg = s.prog;
      s._snapX = s.x;
      s._snapSpeed = s.speed;
    }
    if (ranked.length) Collide.fillArcBuckets(ranked, track.length, PhysicsConsts.TOW_RANGE, (c) => c._snapProg as number);
    parked.length = 0;
    for (const c of cars) if (c.retired && c.parkedOnRoad) parked.push(c);
    for (const c of cars) cs.updateCar(c, dt, ranked, c.human ? inputOf(c) : null, c.human && assistsOf ? assistsOf(c) : undefined);
    collide.resolveCollisions(parked.length ? ranked.concat(parked) : ranked, dt);
  }

  return { step, ranked };
}
