/**
 * Audio seam: what the game hands the audio lane.
 *
 * Derived from how f1-game js/game.js drives `GameAudio` (the ~22 call sites
 * listed per member below). The continuous parameters arrive once per frame
 * as one typed `AudioFrame` (game.js:4585-4610 sets them on the LAST physics
 * step of a frame only); discrete cues arrive through `event(kind, ...)`.
 *
 * The audio lane reads car state; it never writes it.
 */

/**
 * One rival row for the positional field (engine.js:2460-2474, produced by
 * js/audio/rivals.js `collect(player)`). Track-frame numbers: the audio
 * module does no track maths.
 */
export interface AudioRivalRow {
  /** Metres to the RIGHT of the player (negative = left). */
  readonly lat: number;
  /** Metres AHEAD of the player (negative = behind). */
  readonly arc: number;
  /** World position, for camera-relative pan on an external camera. */
  readonly wx?: number;
  readonly wz?: number;
  /** 0..1 engine speed. */
  readonly rev: number;
  /** m/s of line-of-sight closing, positive = coming at you. */
  readonly approach: number;
  /** Their power unit (team.engine, an ENGINE_VOICES key). */
  readonly voice?: string;
  /** Which rival voice plays them, bound to the car. */
  readonly slot?: number;
  /** A net-replicated row (10 Hz snapshots, smoothed). */
  readonly net?: boolean;
  /** Stable per-car key. */
  readonly key?: number;
}

/** The listener for camera-relative pans (f1-game GameCams.getListenerBasis). */
export interface AudioListenerBasis {
  readonly x: number;
  readonly z: number;
  readonly rightX: number;
  readonly rightZ: number;
  readonly fwdX: number;
  readonly fwdZ: number;
  /** True on an external (TV / orbit) camera. */
  readonly external: boolean;
}

/** Per-frame car-sfx levels, all 0..1 (engine.js:2210-2214, js/audio/car-sfx.js). */
export interface AudioCarSfx {
  readonly scrub: number;
  readonly lock: number;
  readonly surface: number;
  readonly pitLim: number;
  readonly wet?: boolean;
}

/**
 * The player car's continuous audio state for one frame.
 * game.js:4585-4610 (`_engArg` + the `setEngine` / `setSkid` / `brakeCue` /
 * `setRivals` calls) and game.js:4446 (`setGridIdle` on the countdown).
 */
export interface AudioFrame {
  /** "race" drives the full engine; "grid" idles it on the lamps (game.js:4446). */
  readonly phase: "race" | "grid";
  /** Engine rpm (game.js:4585 `player.rpm`). */
  readonly rpm: number;
  /** Current gear, 1..8. */
  readonly gear: number;
  /** Ground speed / vTop(), 0..1 (game.js:4594). Speeds compare through vTop. */
  readonly speed01: number;
  /** Throttle demand 0..1 (`player.throttleDemand`). */
  readonly throttle: number;
  /** Brake demand 0..1 (`player.brakeDemand`). */
  readonly brake: number;
  /** Smoothed longitudinal accel, m/s² absolute (`player.axEstSm`). */
  readonly ax: number;
  /** The same on the standard (un-PACEd) scale, `aStd(ax)`. */
  readonly axStd: number;
  /** Traction factor 1 = full grip (`player.slipFactor`). */
  readonly slip: number;
  /** Combined tyre slide intensity 0..1 for the squeal (`player.skidIntensity`). */
  readonly skid: number;
  readonly offroad: boolean;
  readonly onKerb: boolean;
  /** Wet road (game.js `isWetRoad()`). */
  readonly wet: boolean;
  /** Slipstream tow 0..1 (`player.towing`). */
  readonly tow: number;
  /** ERS deploying (`player.deploying`). */
  readonly deploying: boolean;
  /** Battery 0..1 (`player.energy`). */
  readonly energy: number;
  /** Fitted ERS part deploy bias 0..1 (`player.ersDeploy`). */
  readonly ersDeploy: number;
  /** Regen strength 0..1 (`player.ersRegen`). */
  readonly regen: number;
  /** Boost toggle held on (`player.boostOn`). */
  readonly boostOn?: boolean;
  /** Overtake mode live (`player.otOn`). */
  readonly otOn?: boolean;
  /** The field around the player, nearest first. */
  readonly rivals?: readonly AudioRivalRow[];
  /** Per-frame car-sfx levels. */
  readonly carSfx?: AudioCarSfx;
  /** Braking-cue urgency 0..1, only when that assist is on (game.js:4606). */
  readonly brakeCue?: number;
  /** Camera listener for external pans. */
  readonly listener?: AudioListenerBasis | null;
}

/** The circuit's acoustics, from its track def (engine.js:2341 `setVenue(def)`). */
export interface AudioVenue {
  readonly street?: boolean;
  readonly theme?: string;
}

/**
 * Discrete cues and their arguments. Each key is a `GameAudio` method f1-game
 * calls with exactly these arguments.
 */
export interface AudioEventArgs {
  /** game.js:5066-5067, 5479. */
  shift: [up: boolean];
  /** game.js:4407, lamp index 0..4. */
  lightOn: [index: number];
  /** game.js:4439. */
  lightsOut: [];
  /** game.js:6221. */
  lap: [];
  /** game.js:2888. */
  finish: [];
  /** game.js:763, 772, 5522. */
  penalty: [];
  /** game.js:5517, 5526, 6427, 6475. */
  offtrack: [];
  /** game.js:5554 (legacy kerb one-shot; muted while the kerb loop owns it). */
  rumble: [];
  /** game.js:4670: impact 0..1, wall scrape, side -1 left .. +1 right. */
  collision: [impact: number, scrape?: boolean, side?: number];
  /** game.js:4659: positional contact between other cars. */
  fieldContact: [kind: "bump" | "scrape" | "squeal", impact: number, wx: number, wz: number, carKey: number];
  /** game.js:4983. */
  deployBoost: [];
  /** game.js:4986. */
  overtakeReady: [];
  /** game.js:5032. */
  xMode: [on: boolean];
  /** Weather arc thunder, near 0..1. */
  thunder: [near?: number];
  /** Pit stop wheel guns. */
  pitGun: [tighten?: boolean];
  /** game.js:8450 and menus. */
  uiTick: [];
  uiSelect: [];
  uiReject: [];
}
export type AudioEventKind = keyof AudioEventArgs;

/** The audio lane's public surface. */
export interface AudioSeam {
  /** Create / resume the context; call from a user gesture (game.js:8711, 8864). */
  init(): void;
  /** Continuous state, once per frame. */
  update(frame: AudioFrame): void;
  /** A discrete cue. */
  event<K extends AudioEventKind>(kind: K, ...args: AudioEventArgs[K]): void;
  /** Race start: voice, venue, engine (game.js:2660). */
  startEngine(): void;
  /** Results, pause, menu (game.js:2882, 4287, 9071). */
  stopEngine(): void;
  /** team.engine of the player car (game.js:2660). */
  setVoice(engine: string | undefined): void;
  setVenue(venue: AudioVenue | null | undefined): void;
  /** Camera id, for the onboard / chase / TV mix (mode-switch.js:97). */
  setCameraMix(id: string): void;
  startRain(gain?: number): void;
  stopRain(): void;
  /** Race loop for a track index, or -1 for the menu loop (game.js:2660, 4288). */
  startMusic(trackIdx: number): void;
  stopMusic(): void;
}
