/**
 * WALL CLAMP: per-side barrier / pit-wall / gantry limits, human slide-along +
 * scrub, the lane-side pit clamp, and the conditional road→world writeback
 * when x was pinned. The driving-boundary hard constraint that runs every tick.
 *
 * Port of f1-game js/physics/wall-clamp.js (`WallClamp`, :13-261), verbatim in
 * operation order. No create(G): every per-tick local arrives in a ctx bag.
 * Audio, haptics, debris and incident hooks are optional (fx.ts).
 */
import type { TrackSample } from "../contracts";
import { wallHitLoss, wallAiScrub, wallSteerScrub } from "./ai-contact";
import type { PhysCar } from "./car";
import type { AudioFx, DebrisFx, HapticsFx, IncidentFx } from "./fx";
import { clamp } from "./math";
import type { PhysicsTrack, PostLimits, WallLimits } from "./track";
import { apply as wallEndFace } from "./wall-end-face";

const _lim: WallLimits = { r: 0, l: 0, laneMin: 0, side: 0 };

export interface WallClampCtx {
  readonly track: PhysicsTrack;
  readonly dt: number;
  /** Driver steer input; its sign is the turn direction. */
  readonly steer: number;
  /** Scratch for the gantry-post limits. */
  readonly postLim: PostLimits;
  /** Scratch sample; left holding the sample at the car's (final) s for a human. */
  readonly smp: TrackSample;
  readonly wrapS: (s: number) => number;
  /** f1-game game.js:516: samples into `out` and returns a POOLED {x, z}. */
  readonly worldFromTrack: (s: number, x: number, out: TrackSample) => Readonly<{ x: number; z: number }>;
  readonly soundOn: boolean;
  readonly incidentSim?: Pick<IncidentFx, "notifyWall"> | null;
  /** Street incidence camera shake (the sim owns shake). Optional. */
  readonly addShake?: ((delta: number) => void) | null;
  readonly debris?: DebrisFx | null;
  readonly audio?: AudioFx | null;
  readonly haptics?: HapticsFx | null;
  /** Team ids in f1-game `Teams.LIST` order, for the AI contact audio key. */
  readonly teamIds?: readonly string[];
}

function fieldKey(c: PhysCar, teamIds: readonly string[]): number {
  let key = c._wireId;
  if (key == null) {
    const id = c.team && c.team.id;
    const ti = teamIds.findIndex((t) => t === id);
    key = (ti < 0 ? teamIds.length : ti) * 4 + ((c.seat as number) | 0);
  }
  return (key | 0) + 10000;
}

/**
 * Hard lateral clamp + incidence scrub + pit/gantry limits + human writeback.
 * Mutates `c` (x, speed, head, vLat, wallT, wasOnWall, wallHits, collideT,
 * px/pz when pinned) and the ctx.postLim / ctx.smp scratch. wall-clamp.js:30-256.
 */
export function apply(c: PhysCar, ctx: WallClampCtx): void {
  const track = ctx.track;
  const dt = ctx.dt;
  const steer = ctx.steer;
  const postLim = ctx.postLim;
  const smp = ctx.smp;
  const wrapS = ctx.wrapS;
  const worldFromTrack = ctx.worldFromTrack;
  const soundOn = ctx.soundOn;
  const incidentSim = ctx.incidentSim ?? null;
  const addShake = ctx.addShake ?? null;
  const debris = ctx.debris ?? null;
  const audio = ctx.audio ?? null;
  const haptics = ctx.haptics ?? null;
  const teamIds = ctx.teamIds ?? [];

  const lim = track.wallLimits(c.s, c.x, _lim, postLim);
  const wallR = lim.r,
    wallL = lim.l,
    laneMin = lim.laneMin,
    pitSd = lim.side;
  let xPinned = false;
  if ((c.x > wallR || c.x < -wallL) && wallEndFace(c, track, lim, dt)) xPinned = true;
  else if (c.x > wallR || c.x < -wallL) {
    const into = c.x > wallR ? 1 : -1;
    if (!c.wasOnWall && debris && debris.active()) {
      const xOver = into > 0 ? c.x - wallR : -wallL - c.x;
      debris.wallImpact(c, into, xOver);
      const _wallSev = xOver * 60 + Math.abs(c.speed || 0) * 0.15;
      debris.promoteBarrier(c, into, _wallSev);
      if (incidentSim) incidentSim.notifyWall(c, into, _wallSev);
    }
    c.x = into > 0 ? wallR : -wallL;
    xPinned = true;
    if (c.human) {
      track.sample(c.s, smp);
      const dW = 3,
        wSd = into > 0 ? 1 : -1;
      const wSlope = clamp(
        ((track.wallAt(wrapS(c.s + dW), wSd) - track.wallAt(wrapS(c.s - dW), wSd)) * wSd) / (2 * dW),
        -2,
        2,
      );
      const wtx = smp.t[0] + smp.r[0] * wSlope,
        wtz = smp.t[2] + smp.r[2] * wSlope;
      const tHead = Math.atan2(wtx, wtz);
      let rel = c.head - tHead;
      while (rel > Math.PI) rel -= 2 * Math.PI;
      while (rel < -Math.PI) rel += 2 * Math.PI;
      const noseIn = into > 0 ? rel < 0 : rel > 0;
      const incidence = Math.min(1, Math.abs(Math.sin(rel)));
      if (c.vLat) c.vLat = 0;
      if (noseIn) {
        if (!c.wasOnWall) c.speed *= 1 - incidence * wallHitLoss(!!track.street);
        const wallAlign = (1 - Math.exp(-(4 + incidence * 8) * dt)) * clamp(Math.abs(c.speed) / 8, 0, 1);
        c.head -= rel * wallAlign;
        if (c.isPlayer && !c.wasOnWall && incidence > 0.12) c.wallHits = ((c.wallHits as number) | 0) + 1;
      }
      const WALL_SFX_REARM = 0.35;
      const WALL_SCRAPE_SPEED = 2;
      if (c.isPlayer && c.collideT <= 0 && soundOn) {
        const firstStrike = !c.wasOnWall && noseIn && incidence > 0.12;
        const grindScrape = c.wasOnWall && Math.abs(c.speed) >= WALL_SCRAPE_SPEED;
        if (firstStrike || grindScrape) {
          const fxInc = firstStrike ? incidence : Math.max(incidence, 0.2);
          if (audio) audio.collision(fxInc, !firstStrike || incidence < 0.45, into);
          c.collideT = WALL_SFX_REARM;
          if (firstStrike && track.street) {
            if (addShake) addShake(0.1 + incidence * 0.3);
            if (haptics) {
              haptics.vibrate(15 + incidence * 35);
              haptics.rumble(0.35 + incidence * 0.5, 100, "handles");
            }
          }
        }
      } else if (!c.isPlayer && soundOn && audio && audio.fieldContact) {
        const firstStrike = !c.wasOnWall && noseIn && incidence > 0.12;
        const grindScrape = c.wasOnWall && noseIn && incidence > 0.08;
        if (firstStrike || grindScrape) {
          const fxInc = firstStrike ? incidence : Math.max(incidence, 0.2);
          const kind = firstStrike && incidence >= 0.45 ? "bump" : "scrape";
          let wx: number | null | undefined = c.px,
            wz: number | null | undefined = c.pz;
          if ((wx == null || wz == null) && worldFromTrack) {
            const w = worldFromTrack(c.s, c.x, smp);
            if (w) {
              wx = w.x;
              wz = w.z;
            }
          }
          audio.fieldContact(kind, fxInc, wx as number, wz as number, fieldKey(c, teamIds));
        }
      }
      const pushIn = Math.max(0, into * steer);
      if (pushIn > 0.02) {
        const scrub = pushIn * wallSteerScrub(!!track.street) * dt;
        if (c.speed > 0) c.speed = Math.max(0, c.speed - scrub);
        else if (c.speed < 0) c.speed = Math.min(0, c.speed + scrub);
        c.wallT = 0.35;
      }
    } else {
      c.speed = Math.max(0, c.speed - wallAiScrub(!!track.street) * dt);
      if (soundOn && audio && audio.fieldContact) {
        const spd = Math.abs(c.speed) || 0;
        const slipInc = spd > 1e-3 ? Math.min(1, Math.abs(c.vLat || 0) / spd) : 0;
        const pushIn = Math.max(0, into * (steer || 0));
        let incidence = Math.max(slipInc, pushIn > 0.02 ? Math.min(1, pushIn) : 0);
        if (!c.wasOnWall) incidence = Math.max(incidence, Math.min(0.55, spd / 80));
        const firstStrike = !c.wasOnWall && incidence > 0.12;
        const grindScrape = c.wasOnWall && incidence > 0.08;
        if (firstStrike || grindScrape) {
          const fxInc = firstStrike ? incidence : Math.max(incidence, 0.2);
          const kind = firstStrike && incidence >= 0.45 ? "bump" : "scrape";
          let wx: number | null | undefined = c.px,
            wz: number | null | undefined = c.pz;
          if ((wx == null || wz == null) && worldFromTrack) {
            const w = worldFromTrack(c.s, c.x, smp);
            if (w) {
              wx = w.x;
              wz = w.z;
            }
          }
          audio.fieldContact(kind, fxInc, wx as number, wz as number, fieldKey(c, teamIds));
        }
      }
    }
    c.wasOnWall = true;
  } else {
    c.wasOnWall = false;
    if (c.human) c.wallT = Math.max(0, (c.wallT || 0) - dt);
  }
  if (laneMin > 0 && c.x * pitSd < laneMin) {
    c.x = laneMin * pitSd;
    xPinned = true;
    if (c.vLat) c.vLat = 0;
    if (c.human) track.sample(c.s, smp);
  }
  if (c.human && c.px != null) {
    if (xPinned) {
      const w = worldFromTrack(c.s, c.x, smp);
      c.px = w.x;
      c.pz = w.z;
    } else {
      track.sample(c.s, smp);
    }
  }
}
