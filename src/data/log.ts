/**
 * Data-lane log sink. f1-game calls its global `Log.info/warn("data", …)`
 * (js/core/log.js:2); apex-26 has no global logger yet, so the data modules
 * write through this replaceable sink. TODO(lane-shell): point it at the
 * shared logger once src/debug/ has one.
 */
export interface DataLog {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
}

const consoleLog: DataLog = {
  info: () => { /* f1-game's default console level is warn: info stays quiet */ },
  warn: (msg, ...rest) => console.warn("[data] " + msg, ...rest),
};

let sink: DataLog = consoleLog;

export const log: DataLog = {
  info: (msg, ...rest) => sink.info(msg, ...rest),
  warn: (msg, ...rest) => sink.warn(msg, ...rest),
};

/** Replace the sink (tests, the debug overlay). Returns the previous one. */
export function setDataLog(next: DataLog): DataLog {
  const prev = sink;
  sink = next;
  return prev;
}
