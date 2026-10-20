/**
 * The settings-row seam the perf controls mount through. f1-game builds its
 * GRAPHICS and METRICS rows with js/ui/setting-row.js (`SettingRow.build /
 * wire / paint`: LABEL ‹ VALUE › over a <select>) and falls back to a one-button
 * cycle where SettingRow is absent (js/perf/quality-preset.js:141-157,
 * js/perf/metrics-overlay.js:935-953). apex-26 has no SettingRow yet, so the
 * perf mounts take it as an optional dependency and use that same fallback.
 * TODO(lane-shell): pass the shell's settings-row module once it exists.
 */

/** `[value, label]` pairs, as f1-game's SettingRow takes them. */
export type RowValues = ReadonlyArray<readonly [string, string]>;

export interface SettingRowApi {
  build(id: string, label: string, values: RowValues): { row: HTMLElement };
  wire(row: HTMLElement, opts: { values: RowValues; read: () => string; write: (v: string) => void }): void;
  paint(row: HTMLElement, value: string, values?: RowValues): void;
}
