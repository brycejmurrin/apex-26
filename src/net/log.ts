/**
 * The `net` log namespace, a stand-in for f1-game's global `Log` (js/core/log.js:2)
 * restricted to what js/net/ calls: `Log.info/warn/debug("net", …)` and
 * `Log.enabled("net", Log.DEBUG)` (transport.js:667).
 *
 * Quiet by default (warn and up) so unit tests stay clean; `setNetLogLevel`
 * raises it. TODO(lane-shell): replace with the shared logger once src/debug/ has one.
 */
export type NetLogLevel = "silent" | "error" | "warn" | "info" | "debug";

const RANK: Readonly<Record<NetLogLevel, number>> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
let level: NetLogLevel = "warn";

export function setNetLogLevel(next: NetLogLevel): void {
  level = next;
}

export function netLogEnabled(at: NetLogLevel): boolean {
  return RANK[at] <= RANK[level];
}

function emit(at: Exclude<NetLogLevel, "silent">, args: readonly unknown[]): void {
  if (!netLogEnabled(at)) return;
  const fn = at === "debug" ? console.debug : at === "info" ? console.info : at === "warn" ? console.warn : console.error;
  fn("[net]", ...args);
}

export const netLog = {
  error: (...args: unknown[]): void => emit("error", args),
  warn: (...args: unknown[]): void => emit("warn", args),
  info: (...args: unknown[]): void => emit("info", args),
  debug: (...args: unknown[]): void => emit("debug", args),
};
