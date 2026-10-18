/**
 * The typed debug API, `window.__apex` (PLAN T1.11). f1-game exposes the same
 * hooks as `window.__apex` for its Playwright specs (setInput / step / state
 * readers in js/game.js); here it is one typed object over the `App`.
 *
 * - `info()`       backend, track, sim clock and step count;
 * - `physState()`  a plain copy of the player's `CarState` plus lap timing;
 * - `setInput(p)`  drive with a fixed `PlayerInput` (missing fields neutral),
 *                  `null` hands control back to the keyboard and pad;
 * - `step(n)`      advance the sim `n` fixed steps synchronously.
 *
 * Nothing here exposes the arc: `setInput` takes `PlayerInput` only.
 */
import type { CarState, PlayerInput } from "../contracts/sim";
import type { App } from "../app/app";

export interface ApexInfo {
  readonly backend: string;
  readonly reason: string;
  readonly track: string;
  readonly trackLength: number;
  readonly simT: number;
  readonly steps: number;
  readonly paused: boolean;
  readonly overridden: boolean;
}

export interface ApexPhysState extends Readonly<CarState> {
  readonly lapLast: number;
  readonly lapBest: number;
}

export interface ApexDebug {
  info(): ApexInfo;
  physState(): ApexPhysState;
  setInput(input: Partial<PlayerInput> | null): void;
  step(n?: number): ApexPhysState;
}

declare global {
  interface Window {
    __apex?: ApexDebug;
  }
}

export const NEUTRAL_INPUT: PlayerInput = Object.freeze({
  steer: 0, throttle: false, brake: false, throttleLevel: 0, brakeLevel: 0,
  shiftUp: false, shiftDown: false, aero: false, aeroToggle: false, overtake: false, boost: false,
});

/** Fill a partial input: a pedal flag without a level is full travel, a level without a flag sets it. */
export function completeInput(p: Partial<PlayerInput>): PlayerInput {
  const throttleLevel = p.throttleLevel ?? (p.throttle ? 1 : 0);
  const brakeLevel = p.brakeLevel ?? (p.brake ? 1 : 0);
  return {
    ...NEUTRAL_INPUT,
    ...p,
    throttleLevel, brakeLevel,
    throttle: p.throttle ?? throttleLevel > 0,
    brake: p.brake ?? brakeLevel > 0,
    steer: Math.max(-1, Math.min(1, p.steer ?? 0)),
  };
}

export function createDebugApi(app: App, backend: { name: string; reason: string }, trackId: string): ApexDebug {
  const physState = (): ApexPhysState => ({ ...app.player, lapLast: app.timer.last, lapBest: app.timer.best });
  return {
    info: () => ({
      backend: backend.name,
      reason: backend.reason,
      track: trackId,
      trackLength: app.track.length,
      simT: app.simT,
      steps: app.stepCount,
      paused: app.paused,
      overridden: app.input.overridden,
    }),
    physState,
    setInput: (input) => app.input.setOverride(input ? completeInput(input) : null),
    step: (n = 1) => {
      const k = Math.max(0, Math.min(36_000, Math.floor(n)));
      for (let i = 0; i < k; i++) app.stepOnce();
      return physState();
    },
  };
}
