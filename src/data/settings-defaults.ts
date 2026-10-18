/* SettingsDefaults: the shipped default for any player preference, as data.
   Ported verbatim from f1-game js/data/settings-defaults.js:1-89; the full
   rationale is its header (opt-in by key; the steering block is deliberately
   absent because it is the driving model). */

export type SettingValue = string | number | boolean;

// @gen-settings-defaults start
const DEF: Readonly<Record<string, SettingValue>> = Object.freeze({
  // DRIVING (js/game.js, js/race/*)
  "difficulty": "hard",
  "tyreWear": "real",
  "raceGrid": "random",
  "drivingCoach": false,
  "caution": false,
  "unlimitedBudget": true,
  // AUDIO (js/audio/panel.js)
  "volMusic": 0.6,
  "volSfx": 0.2,
  "spotter": false,
  // DISPLAY / METRICS (raw lane — bare strings, not JSON)
  "debris": "0",
  "metricsPos": "left",
  // CAMERA
  "camMode": 19,
  "cockpitHalo": "fairing",
  "cockpitBody": "sculpted",
  "cockpitInterior": "team",
  // APPEARANCE
  "menuAccent": "ember",
  "textSize": "large",
  "uiContrast": "high",
  "homeScene": "photo",
  "backgroundMotion": "ambient",
  "homeCamera": "side",
});
// @gen-settings-defaults end

export const SettingsDefaults = Object.freeze({
  has: (k: string): boolean => Object.prototype.hasOwnProperty.call(DEF, k),
  get: (k: string): SettingValue | undefined => (Object.prototype.hasOwnProperty.call(DEF, k) ? DEF[k] : undefined),
  keys: (): string[] => Object.keys(DEF),
});
