/**
 * The Data Hub's public entry point: every tab wired into the hub shell.
 * f1-game built this inline in js/data/hub.js:526-667. The shell lane mounts
 * it (menu entry, the #datahub dialog); src/main.ts is not this lane's.
 *
 * WATCH & DRIVE (the real-race bridge) needs the race lane's RealRacePort:
 * see ./real-race/bridge.ts `registerRealRacePort`.
 */
import { createDataHub, type DataHub, type DataHubOptions, type HubTabs } from "./hub";
import * as Export from "./tabs/export";
import * as Live from "./tabs/live";
import * as Results from "./tabs/results";
import * as Schedule from "./tabs/schedule";
import * as Standings from "./tabs/standings";
import * as Telemetry from "./tabs/telemetry/controller";
import * as RealRace from "./real-race/tab";

export const TABS: HubTabs = {
  schedule: (d) => Schedule.create(d),
  standings: (d) => Standings.create(d),
  results: (d) => Results.create(d),
  live: (d) => Live.create(d),
  telemetry: (d) => Telemetry.create(d),
  race: (d) => RealRace.create(d),
  export: (d) => Export.create(d),
};

/** Build the hub into `rootEl` (a hidden <dialog>); call `.open(tab?)` from the menu. */
export function mountDataHub(rootEl: HTMLElement, opts: Omit<DataHubOptions, "tabs"> = {}): DataHub {
  const hub = createDataHub({ ...opts, tabs: TABS });
  hub.init(rootEl);
  return hub;
}

export type { DataHub, DataHubOptions, TabId } from "./hub";
export type { HubDeps, MountedTab } from "./hub-deps";
export { registerRealRacePort, type RealRacePort } from "./real-race/bridge";
export { f1Api, createF1Api, type F1Api } from "./api";
export { Schedule, Standings, Results, Live, Telemetry, RealRace, Export };
