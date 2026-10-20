/**
 * Reversible garage setup experiments and the active-aero bench.
 * Runtime-only API: create captures the existing game facade; build runs after
 * SetupTune/Parts are available. No physics model or stored key is added.
 *
 * Port of f1-game js/garage/setup-experiments.js:1-170, verbatim: create :6-16,
 * build :19-164 (sliders :49-63, presets :65-71, coach :87-134, trials :135-138,
 * bench :140-161).
 *
 * f1-game reads the globals SetupTune, SetupPresets, SetupTrials, Parts,
 * Tracks, PhysicsConsts and GameAudio; here the ones owned by other lanes are
 * injected through `ExperimentsDeps` (the garage's own default to the page
 * instances).
 */
import { PhysicsConsts } from "../physics/consts";
import { LIST as TRACK_LIST } from "../track/core/tracks";
import { SetupPresets, type SetupPresetsApi } from "./setup-presets";
import { SetupTrials, type SetupTrialsApi, type TrialLaunchOptions, type TrialLaunchResult, type TrialPauseHost } from "./setup-trials";
import { SetupTune, type SetupTuneApi, type Tune } from "./setup-tune";
import type { GarageStoreLike } from "./store";
import { Parts, type PartSetup } from "../car/parts";

/** A fitted parts build: one option id per category (src/car/parts.ts). */
export type PartSetupLike = PartSetup;

/** The team the sheet is built for (Teams.LIST row: `id`, `short`). */
export interface ExperimentsTeam {
  id: string;
  short: string;
}

/** The one Parts call this module makes (src/car/parts.ts aeroLoad); injectable for tests. */
export type PartsAeroLoad = Pick<typeof Parts, "aeroLoad">;

/** The game facade build() reads (f1-game's G), and SetupTrials.mountPause's. */
export interface ExperimentsHost extends TrialPauseHost {
  $: (id: string) => HTMLElement | null;
  getTeamParts: (teamId: string) => PartSetupLike;
  store: GarageStoreLike;
  trackIdx?: number | undefined;
  track?: { def?: { id?: string | null | undefined } | null | undefined } | null | undefined;
  soundOn?: boolean | undefined;
  setupTrialRestart?: ((o: TrialLaunchOptions) => Promise<TrialLaunchResult | null | undefined> | TrialLaunchResult | null | undefined) | undefined;
  setupTrialCancel?: (() => void) | undefined;
  xVmaxGain?: ((c: { aeroLoad: number; aeroX: number }) => number) | undefined;
  xDfLoss?: ((c: { aeroLoad: number; aeroX: number }) => number) | undefined;
}

export interface ExperimentsDeps {
  /** Defaults to src/car/parts.ts Parts. */
  parts?: PartsAeroLoad;
  tune?: SetupTuneApi;
  presets?: SetupPresetsApi | null;
  trials?: SetupTrialsApi | null;
  /** Circuits by `trackIdx` (Tracks.LIST). */
  tracks?: readonly { readonly id: string }[];
  /** GameAudio.uiTick. TODO(lane-audio): wire to src/audio's uiTick in the shell. */
  uiTick?: () => void;
}

export interface SetupExperimentsUi {
  capture(team: ExperimentsTeam | null | undefined): void;
  visit(team: ExperimentsTeam | null | undefined): void;
  close(): void;
  build(container: HTMLElement, team: ExperimentsTeam): void;
}

interface Experiment {
  before: Tune;
  after: Tune;
  symptom: string;
}

interface Symptom {
  id: string;
  label: string;
  trade: string;
}

export function create(G: ExperimentsHost, refreshStats: (team: ExperimentsTeam) => void, deps: ExperimentsDeps): SetupExperimentsUi {
  const { $, getTeamParts } = G;
  const parts = deps.parts ?? Parts;
  const tune = deps.tune ?? SetupTune;
  const presets = deps.presets === undefined ? SetupPresets : deps.presets;
  const trials = deps.trials === undefined ? SetupTrials : deps.trials;
  const tracks = deps.tracks ?? TRACK_LIST;
  if (trials) trials.mountPause(G);
  let trialUi: { dispose(): void } | null = null;
  let csVisitTunes = new Map<string, Tune>();
  let csTuneExperiments = new Map<string, Experiment>();
  function capture(team: ExperimentsTeam | null | undefined): void {
    if (team && !csVisitTunes.has(team.id)) csVisitTunes.set(team.id, tune.get(team.id));
  }
  function visit(team: ExperimentsTeam | null | undefined): void { csVisitTunes = new Map(); csTuneExperiments = new Map(); capture(team); }
  function close(): void { csTuneExperiments.clear(); if (trialUi) { trialUi.dispose(); trialUi = null; } }
  // RESET TO WORKS. Every slider writes the store on input; the stat bars and
  // the player's mods follow through recomputePlayerMods on the next race.
  function build(container: HTMLElement, team: ExperimentsTeam): void {
    if (trialUi) { trialUi.dispose(); trialUi = null; }
    const wrap = document.createElement("div");
    // Not cs-liv-editor: that class widens the car reserve and translucents the
    // sheet for the PAINT editor. SETUP only needs the compact-density help hide.
    wrap.className = "cs-tune-editor";
    const heading = document.createElement("h3"); heading.className = "sel-label";
    heading.textContent = "SETUP SHEET — " + team.short; wrap.appendChild(heading);
    const cur = tune.get(team.id);
    if (!csVisitTunes.has(team.id)) csVisitTunes.set(team.id, Object.assign({}, cur));
    const previous = csVisitTunes.get(team.id) as Tune;
    const sameTune = (a: Readonly<Tune>, b: Readonly<Tune>): boolean => tune.FIELDS.every((k) => a[k] === b[k]);
    let restore: HTMLButtonElement | undefined, coachRefresh: (() => void) | undefined, benchRefresh: ((baseLoad: number, effective: number) => void) | undefined;
    const rows = {} as Record<string, { b: HTMLElement; inp: HTMLInputElement }>;
    const rakeOut = document.createElement("p"); rakeOut.id = "cs-rake-readout"; rakeOut.className = "adv-help"; rakeOut.setAttribute("data-help", "keep");   // a live readout: HELP TEXT: HIDE keeps it
    const refresh = (): void => {
      const t = tune.get(team.id);
      for (const k of tune.FIELDS) { const r = rows[k] as { b: HTMLElement; inp: HTMLInputElement }; r.b.textContent = t[k] + tune.RANGE[k].unit; r.inp.value = String(t[k]); }
      const baseLoad = parts.aeroLoad(getTeamParts(team.id), team);
      const effective = parts.aeroLoad(getTeamParts(team.id), team, tune.aero(team.id));
      rakeOut.textContent = "RAKE " + (t.rideR - t.rideF) + " mm · effective Straight Mode load change "
        + (effective - baseLoad >= 0 ? "+" : "") + ((effective - baseLoad) * 100).toFixed(1) + " pts"
        + " · brake bias " + t.brakeBias.toFixed(1) + " % front";
      if (restore) restore.disabled = sameTune(t, previous);
      if (coachRefresh) coachRefresh();
      if (benchRefresh) benchRefresh(baseLoad, effective);
      refreshStats(team);
      const tab = $("cs-tab-tune");
      if (tab) { tab.classList.toggle("upgraded", !tune.isDefault(team.id)); const c = tab.querySelector(".cs-tab-cur"); if (c) c.textContent = tune.isDefault(team.id) ? "WORKS" : "TUNED"; }
    };
    for (const k of tune.FIELDS) {
      const r = tune.RANGE[k];
      const lab = document.createElement("label"); lab.className = "tune-row";
      const span = document.createElement("span"); span.className = "tune-label";
      span.textContent = r.label + " ";
      const b = document.createElement("b"); span.appendChild(b);
      const inp = document.createElement("input");
      inp.type = "range"; inp.min = String(r.min); inp.max = String(r.max); inp.step = String(r.step); inp.value = String(cur[k]);
      inp.dataset["csTune"] = k;
      inp.setAttribute("aria-label", r.label);
      inp.oninput = () => { csTuneExperiments.delete(team.id); tune.set(team.id, { [k]: parseFloat(inp.value) }); refresh(); };
      lab.appendChild(span); lab.appendChild(inp);
      wrap.appendChild(lab);
      rows[k] = { b, inp };
    }
    wrap.appendChild(rakeOut);
    const trackId = (): string | null => (G.trackIdx !== undefined && tracks[G.trackIdx]?.id) || null;
    if (presets) presets.mount(wrap, {
      teamId: team.id, store: G.store,
      trackId: trackId() || G.track?.def?.id || null,
      context: () => ({ v: 1, physics: String(PhysicsConsts.REVISION || ""),
        track: trackId(), parts: getTeamParts(team.id) }),
      refresh,
    });
    const note = document.createElement("p"); note.className = "adv-help";
    note.textContent = "Bars: stiffer overall sharpens turn-in and costs traction; a stiffer front shifts load transfer forward and reduces front grip in sustained turns; a stiffer rear helps rotation. "
      + "Rake sizes the ACTIVE AERO trade, not the car's standing downforce: more rake means more top speed to gain and more grip to lose when the flaps open, and with them shut the car drives exactly the same (measured: identical grip across the whole rake range in Corner Mode). A max-wing car is already at full load. "
      + "Brake bias splits the friction budget between the axles under braking — forward understeers on entry, rearward rotates. "
      + "The works sheet is exactly the car it always was.";
    wrap.appendChild(note);
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "cs-liv-ed-cancel";
    reset.textContent = "RESET TO WORKS";
    reset.onclick = () => { csTuneExperiments.delete(team.id); tune.reset(team.id); if (G.soundOn && deps.uiTick) deps.uiTick(); refresh(); };
    wrap.appendChild(reset);
    const restoreBtn = document.createElement("button"); restore = restoreBtn; restoreBtn.type = "button"; restoreBtn.className = "cs-liv-ed-cancel";
    restoreBtn.textContent = "RESTORE PREVIOUS SETUP";
    restoreBtn.onclick = () => { csTuneExperiments.delete(team.id); tune.set(team.id, previous); refresh(); };
    wrap.appendChild(restoreBtn);

    const coach = document.createElement("div"); coach.className = "chip-row";
    coach.setAttribute("role", "group"); coach.setAttribute("aria-label", "Setup symptoms");
    const advice = document.createElement("p"); advice.className = "adv-help"; advice.setAttribute("data-help", "keep");
    advice.setAttribute("role", "status");
    const apply = document.createElement("button"), undo = document.createElement("button");
    apply.type = undo.type = "button"; apply.className = undo.className = "cs-liv-ed-cancel";
    apply.textContent = "APPLY EXPERIMENT"; undo.textContent = "UNDO EXPERIMENT";
    let symptom: Symptom | null = null;
    const symptoms: Symptom[] = [
      { id: "wide", label: "Pushes wide mid-corner", trade: "Soften the front bar one step to shift load transfer away from the front. Tradeoff: softer turn-in and relatively more rear load transfer." },
      { id: "traction", label: "Poor exit traction", trade: "Soften both bars one step together, keeping axle balance. Tradeoff: less sharp turn-in." },
      { id: "entry", label: "Unstable braking entry", trade: "Move brake bias 0.5% forward to leave more rear lateral budget under braking. Tradeoff: more entry understeer and front demand." },
    ];
    const activeExperiment = csTuneExperiments.get(team.id);
    if (activeExperiment) symptom = symptoms.find((item) => item.id === activeExperiment.symptom) || null;
    const chips: HTMLButtonElement[] = [];
    coachRefresh = () => {
      const saved = csTuneExperiments.get(team.id), t = tune.get(team.id);
      if (saved && !sameTune(t, saved.after)) csTuneExperiments.delete(team.id);
      const experiment = csTuneExperiments.get(team.id);
      const pending = !!experiment;
      const patch = symptom && tune.experiment(symptom.id, t);
      apply.disabled = !patch || pending; undo.disabled = !pending;
      for (let i = 0; i < chips.length; i++) { const chip = chips[i] as HTMLButtonElement; chip.disabled = pending; chip.setAttribute("aria-pressed", String(symptom === symptoms[i])); }
      advice.textContent = "Model-based starting points; test the feel on track. " + (symptom
        ? symptom.trade + " " + (experiment ? tune.FIELDS.filter((k) => experiment.before[k] !== experiment.after[k]).map((k) => tune.RANGE[k].label + ": " + experiment.before[k] + " → " + experiment.after[k]).join(" · ")
          : patch ? (Object.keys(patch) as (keyof Tune)[]).map((k) => tune.RANGE[k].label + ": " + t[k] + " → " + patch[k]).join(" · ")
          : "Already at a range limit; this experiment is unavailable.")
        : "Choose a symptom to preview one change.") + (pending ? " Experiment applied. Undo restores the setup before it; a manual edit starts a new experiment." : "");
    };
    for (const item of symptoms) {
      const b = document.createElement("button"); b.type = "button"; b.className = "sel-chip"; b.textContent = item.label;
      b.onclick = () => { symptom = item; if (coachRefresh) coachRefresh(); }; coach.appendChild(b); chips.push(b);
    }
    apply.onclick = () => {
      if (!symptom || csTuneExperiments.has(team.id)) return;
      const before = tune.get(team.id), patch = tune.experiment(symptom.id, before);
      if (!patch) return;
      const after = tune.set(team.id, patch);
      csTuneExperiments.set(team.id, { before, after, symptom: symptom.id }); refresh();
    };
    undo.onclick = () => {
      const saved = csTuneExperiments.get(team.id);
      if (!saved) return;
      if (sameTune(tune.get(team.id), saved.after)) tune.set(team.id, saved.before);
      csTuneExperiments.delete(team.id); refresh();
    };
    wrap.append(coach, advice, apply, undo);
    const restart = G.setupTrialRestart;
    if (trials && restart) trialUi = trials.mount(wrap, {
      teamId: team.id, store: G.store, baseline: previous, candidateNow: () => tune.get(team.id),
      launch: options => restart(options), cancelRuntime: () => { if (G.setupTrialCancel) G.setupTrialCancel(); }, refresh,
    });

    const bench = document.createElement("p"); bench.className = "adv-help"; bench.setAttribute("data-help", "keep");
    const mode = document.createElement("div"); mode.className = "chip-row";
    mode.setAttribute("role", "group"); mode.setAttribute("aria-label", "Active aero bench mode");
    let straight = false;
    const modes: HTMLButtonElement[] = [];
    benchRefresh = (baseLoad, effective) => {
      for (let i = 0; i < modes.length; i++) (modes[i] as HTMLButtonElement).setAttribute("aria-pressed", String(!!i === straight));
      bench.textContent = "Wing load " + (baseLoad * 100).toFixed(1) + " · effective with rake " + (effective * 100).toFixed(1)
        + " · change from works " + ((effective - baseLoad) * 100).toFixed(1) + " pts. "
        + (effective === 1 && tune.rake(team.id) > 0 ? "Capped — extra rake adds no further trade. " : "")
        + (straight ? "Straight Mode: more effective load sizes a larger speed/grip trade when the flaps open. " : "Corner Mode: flaps shut; rake adds no standing downforce or grip. ");
      if (straight && typeof G.xVmaxGain === "function" && typeof G.xDfLoss === "function") {
        const c = { aeroLoad: effective, aeroX: 1 };
        bench.textContent += "Full-open speed ceiling trade +" + (G.xVmaxGain(c) * 100).toFixed(1)
          + "% · downforce loss " + (G.xDfLoss(c) * 100).toFixed(1) + "% (current conditions).";
      }
    };
    for (const [i, label] of ["CORNER MODE", "STRAIGHT MODE"].entries()) {
      const b = document.createElement("button"); b.type = "button"; b.className = "sel-chip"; b.textContent = label;
      b.onclick = () => { straight = !!i; refresh(); }; mode.appendChild(b); modes.push(b);
    }
    wrap.append(mode, bench);
    container.appendChild(wrap);
    refresh();
  }

  return { capture, visit, close, build };
}

export const SetupExperiments = Object.freeze({ create });
