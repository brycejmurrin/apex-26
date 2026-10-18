// @vitest-environment happy-dom
/* The SETUP sheet editor: visit restore, the symptom coach and the aero bench.
 * Assertions ported from f1-game tests/unit/garage-followups.test.mjs:9-66
 * (tuneFixture and its three tests). */
import { describe, expect, it } from "vitest";
import { create, type ExperimentsHost, type ExperimentsTeam } from "../../../src/garage/setup-experiments";
import { createSetupPresets } from "../../../src/garage/setup-presets";
import { createSetupTrials } from "../../../src/garage/setup-trials";
import { createSetupTune } from "../../../src/garage/setup-tune";
import { mapStore, revStore } from "./f1-garage-vm";

function tuneFixture() {
  const store = mapStore(), S = createSetupTune(store);
  const container = document.createElement("div"); container.id = "fixture"; document.body.replaceChildren(container);
  const G: ExperimentsHost = { $: (id) => document.getElementById(id), getTeamParts: () => ({}), store, soundOn: false };
  let ticks = 0;
  const experiments = create(G, () => {}, {
    tune: S, presets: null, trials: null, tracks: [], uiTick: () => { ticks++; },
    parts: { aeroLoad: (_p, _t, tune) => Math.min(1, Math.max(0, 1 + 0.06 * (tune?.rake || 0))) },
  });
  const team: ExperimentsTeam = { id: "haas", short: "HAA" };
  const build = (): void => { container.replaceChildren(); experiments.build(container, team); };
  const button = (text: string): HTMLButtonElement => Array.from(container.querySelectorAll("button")).find((b) => b.textContent === text)!;
  const input = (k: string): HTMLInputElement => Array.from(container.querySelectorAll("input")).find((n) => n.dataset["csTune"] === k)!;
  const slide = (k: string, v: number): void => { const n = input(k); n.value = String(v); n.dispatchEvent(new Event("input")); };
  return { G, S, team, build, button, input, slide, container, experiments, ticks: () => ticks };
}

describe("SetupExperiments (f1-game js/garage/setup-experiments.js)", () => {
  it("visit restore survives tune rebuilds, restores all fields and remains team scoped", () => {
    const f = tuneFixture(), { S, team } = f;
    S.set(team.id, { arbF: 9, arbR: 8, rideF: 30, rideR: 70, brakeBias: 59 });
    const initial = S.get(team.id); f.build();
    expect(f.button("RESTORE PREVIOUS SETUP").disabled).toBe(true);
    f.slide("arbF", 4);
    f.build(); expect(f.button("RESTORE PREVIOUS SETUP").disabled).toBe(false);
    f.button("RESTORE PREVIOUS SETUP").click(); expect(S.get(team.id)).toEqual(initial);
    S.set("ferrari", { arbF: 2 }); expect(S.get("ferrari").arbF).toBe(2);
    f.button("RESET TO WORKS").click(); expect(S.get(team.id)).not.toEqual(initial);
    f.button("RESTORE PREVIOUS SETUP").click(); expect(S.get(team.id)).toEqual(initial);
    team.id = "ferrari"; f.build(); const ferrariBefore = S.get(team.id);
    f.slide("rideR", 75); f.button("RESTORE PREVIOUS SETUP").click();
    expect(S.get(team.id)).toEqual(ferrariBefore); expect(S.get("haas")).toEqual(initial);
    S.set(team.id, { rideR: 71 }); f.experiments.visit(team); f.build();
    f.slide("rideR", 60); f.button("RESTORE PREVIOUS SETUP").click();
    expect(S.get(team.id).rideR).toBe(71);
  });

  it("coach applies a bounded atomic pair, undoes exact snapshot, and invalidates on manual edit", () => {
    const f = tuneFixture(), { S, team } = f; f.build(); const before = S.get(team.id);
    f.button("Poor exit traction").click(); f.button("APPLY EXPERIMENT").click();
    expect(S.get(team.id).arbF).toBe(before.arbF - 1); expect(S.get(team.id).arbR).toBe(before.arbR - 1);
    expect(S.balance(team.id)).toBe(0); expect(S.mods(team.id).accel).toBeGreaterThan(1); expect(S.mods(team.id).cornering).toBeLessThan(1);
    f.build(); f.button("UNDO EXPERIMENT").click(); expect(S.get(team.id)).toEqual(before);
    f.button("Unstable braking entry").click(); f.button("APPLY EXPERIMENT").click();
    expect(S.get(team.id).brakeBias).toBe(before.brakeBias + 0.5);
    f.slide("rideF", 31); expect(f.button("UNDO EXPERIMENT").disabled).toBe(true);
  });

  it("aero bench reports saturation and no Corner Mode standing gain", () => {
    const f = tuneFixture(); f.S.set(f.team.id, { rideR: 80 }); f.build();
    const text = (): string => Array.from(f.container.querySelectorAll("p")).map((n) => n.textContent).join(" ");
    expect(text()).toMatch(/effective Straight Mode load change \+0\.0 pts/);
    expect(text()).toMatch(/Capped — extra rake adds no further trade/);
    expect(text()).toMatch(/rake adds no standing downforce or grip/);
    f.G.xVmaxGain = () => 0.1; f.G.xDfLoss = () => 0.2;
    f.button("STRAIGHT MODE").click(); expect(text()).toMatch(/speed ceiling trade \+10\.0% · downforce loss 20\.0%/);
  });

  it("RESET TO WORKS ticks only with sound on, and the tab badge reads WORKS / TUNED", () => {
    const f = tuneFixture();
    const tab = document.createElement("button"); tab.id = "cs-tab-tune"; const cur = document.createElement("span"); cur.className = "cs-tab-cur"; tab.appendChild(cur); document.body.appendChild(tab);
    f.build(); expect(cur.textContent).toBe("WORKS");
    f.slide("arbF", 9); expect(cur.textContent).toBe("TUNED"); expect(tab.classList.contains("upgraded")).toBe(true);
    f.button("RESET TO WORKS").click(); expect(f.ticks()).toBe(0); expect(cur.textContent).toBe("WORKS");
    f.G.soundOn = true; f.button("RESET TO WORKS").click(); expect(f.ticks()).toBe(1);
  });

  it("mounts the presets library and the comparison when they and a restart hook are given", () => {
    const { store } = revStore(), S = createSetupTune(store);
    const container = document.createElement("div"); document.body.replaceChildren(container);
    const G: ExperimentsHost = { $: (id) => document.getElementById(id), getTeamParts: () => ({ aero: "low" }), store, trackIdx: 0,
      setupTrialRestart: async () => ({ ok: true, context: {} }) };
    const ui = create(G, () => {}, { tune: S, presets: createSetupPresets(S), trials: createSetupTrials(S), tracks: [{ id: "bahrain" }],
      parts: { aeroLoad: () => 0.5 } });
    ui.build(container, { id: "haas", short: "HAA" });
    expect(container.querySelector('[aria-label="Named mechanical setups"]')).not.toBeNull();
    const save = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "SAVE CURRENT SETUP")!;
    (container.querySelector('input[aria-label="Setup name"]') as HTMLInputElement).value = "Track day";
    save.click();
    const lib = store.get("setupPresets.haas", null) as { items: { trackId: string; context: { track: string; parts: Record<string, string> } }[] };
    expect(lib.items[0]!.trackId).toBe("bahrain");
    expect(lib.items[0]!.context.track).toBe("bahrain");
    expect(lib.items[0]!.context.parts).toEqual({ aero: "low" });
    expect(container.textContent).toContain("MEASURE A SETUP · UNSCORED LAUNCH");
    ui.close();
    expect(container.textContent).not.toContain("MEASURE A SETUP");
  });
});
