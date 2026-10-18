/**
 * src/perf/: the frame-time governor and the performance instruments, ported
 * from f1-game js/perf/ (see ./README-port.md for the file map, the injected
 * seams and what was dropped as GLX/WGX-specific).
 *
 * Shared instances (f1-game's globals PerfGov / PerfSpans / LoopHealth /
 * RenderRate / RaceEntryProfile) for the shell frame loop and the render lane;
 * every module also exports a `create*` factory for tests and second instances.
 */
import "../styles";
import "./perf.css";
import { perfGov } from "./governor";
import { createLoopHealth } from "./loop-health";
import { createRaceEntryProfile } from "./race-entry-profile";
import { createRenderRate } from "./render-rate";

export { perfGov, createPerfGov, createScaleGfx, renderScaleReport } from "./governor";
export type { PerfGov, PerfGfx, PerfBackendState, FrameStats, ScaleGfxOptions } from "./governor";
export { perfSpans, createPerfSpans } from "./spans";
export type { PerfSpans, SpanStats } from "./spans";
export { createLoopHealth } from "./loop-health";
export type { LoopHealth, LoopHealthState } from "./loop-health";
export { createRenderRate } from "./render-rate";
export type { RenderRate, RenderRateMode } from "./render-rate";
export { drift as thermalDrift } from "./thermal-drift";
export { createRaceEntryProfile } from "./race-entry-profile";
export type { RaceEntryProfile } from "./race-entry-profile";
export { createGfxQuality, mount as mountGfxQuality, PRESETS as GFX_PRESETS } from "./quality-preset";
export type { GfxQuality, GfxQualityDeps } from "./quality-preset";
export { createGameMetrics, mount as mountMetrics } from "./metrics-overlay";
export type { GameMetrics, GameMetricsDeps, MetricsSources, MetricsLog } from "./metrics-overlay";
export { createGfxDebug, mount as mountGfxDebug } from "./gfx-debug-overlay";
export type { GfxDebug, GfxDebugDeps } from "./gfx-debug-overlay";
export { createThreeInspector } from "./three-inspector";
export type { ThreeInspector, InspectorHost } from "./three-inspector";
export { mount as mountPhoneRecorder, create as createRecorder } from "./phone-recorder";
export type { PhoneRecorderDeps, PhoneRecorderPanel, Recorder } from "./phone-recorder";
export { createSoakRun } from "./soak-run";
export type { SoakHost, SoakRun } from "./soak-run";
export { setPerfLog, localRawStore, memoryRawStore } from "./env";
export type { RawStore, PerfLog } from "./env";
export type { SettingRowApi } from "./setting-row";

/** The frame loop's fault policy + heartbeat (f1-game global LoopHealth). */
export const loopHealth = createLoopHealth();
/** The render-rate gate (f1-game global RenderRate); the shell calls init({ isMobile }). */
export const renderRate = createRenderRate();
/** The race-entry stopwatch (f1-game global RaceEntryProfile). */
export const raceEntryProfile = createRaceEntryProfile({ softwareRaster: () => perfGov.softwareRaster() });
