/**
 * The Data Hub's STANDINGS tab: drivers' and constructors' tables. Ported from
 * f1-game js/data/standings.js:1-141 (create :4-138). F1API's driverStandings /
 * constructorStandings / season are reached through `deps.api`. Addition over
 * f1-game: `mount()` (the MountedTab seam).
 */
import type { ConstructorStanding, DriverStanding } from "../api";
import type { HubDeps, MountedTab } from "../hub-deps";
import { log } from "../log";

export type StandingsDeps = Pick<HubDeps, "api" | "el" | "emptyMsg" | "teamChip" | "findTeam" | "cssColor">;

/** One season's two tables; `year` is set only when this is a fallback season (standings.js:115-116). */
export interface StandingsTables { drivers: DriverStanding[]; cons: ConstructorStanding[]; year: number | undefined }

export function create({ api, el, emptyMsg, teamChip, findTeam, cssColor }: StandingsDeps): { loadStandings(): Promise<HTMLElement> } {
  // A row's team colour goes out as --row-team so the stylesheet owns HOW it
  // is used (edge bar; the leader row mixes it down to 16%) and a row with no
  // matching team falls back to `transparent` without a JS branch.
  function rowTeam(row: HTMLElement, teamName: string | null): void {
    const t = findTeam(teamName);
    if (!t || !t.color) return;
    const lum = 0.2126 * t.color[0] + 0.7152 * t.color[1] + 0.0722 * t.color[2];
    row.style.setProperty("--row-team", cssColor(lum < 0.10 && t.color2 ? t.color2 : t.color));
  }

  // `name` can be null independently of `code` (api.js maps both from
  // possibly-absent fields), so guard the .slice fallback — a nameless,
  // codeless entry must not throw and blank the whole STANDINGS tab.
  const abbr = (d: DriverStanding): string => d.code || (d.name ? d.name.slice(0, 3).toUpperCase() : "—");

  function posText(pos: number | null): number | string { return pos != null ? pos : "—"; }

  // `tag` labels a table that is not this year's ("LAST SEASON · 2025 FINAL").
  function driverRows(drivers: DriverStanding[], tag: string): HTMLElement {
    const sec = el("div", "dh-standings-col");
    sec.appendChild(el("h3", "dh-section", tag ? "DRIVERS — " + tag : "DRIVERS"));
    const first = drivers[0];
    if (!first) {
      sec.appendChild(emptyMsg("No driver standings yet — season hasn't started."));
      return sec;
    }
    const leaderPts = first.pos === 1 ? first.points : null;
    for (const s of drivers) {
      const row = el("div", "dh-row");
      rowTeam(row, s.team);
      if (s.pos === 1) row.classList.add("dh-row-lead");
      row.appendChild(el("span", "dh-pos", posText(s.pos)));
      row.appendChild(teamChip(s.code, s.team));
      row.appendChild(el("span", "dh-name", s.name || "—"));
      if (s.wins > 0) row.appendChild(el("span", "dh-wins", `${s.wins}W`));
      row.appendChild(el("span", "dh-pts", s.points));
      if (leaderPts !== null && s.pos !== 1 && leaderPts > s.points) {   // tied on points: no gap, not "−0"
        row.appendChild(el("span", "dh-gap", `−${leaderPts - s.points}`));
      }
      sec.appendChild(row);
    }
    return sec;
  }

  function h2hBar(d1: DriverStanding, d2: DriverStanding): HTMLElement {
    const h2h = el("div", "dh-h2h-bar");
    const denom = (d1.points + d2.points) || 1;

    const p1Fill = el("div", "dh-h2h-fill");
    p1Fill.style.width = `${(d1.points / denom) * 100}%`;
    p1Fill.title = `${d1.code || d1.name}: ${d1.points} pts`;

    const p2Fill = el("div", "dh-h2h-fill dh-h2h-alt");
    p2Fill.style.width = `${(d2.points / denom) * 100}%`;
    p2Fill.title = `${d2.code || d2.name}: ${d2.points} pts`;

    h2h.appendChild(p1Fill);
    h2h.appendChild(p2Fill);

    const labels = el("div", "dh-h2h-labels");
    labels.appendChild(el("span", null, abbr(d1)));
    labels.appendChild(el("span", null, abbr(d2)));

    const h2hWrap = el("div", "dh-h2h-wrap");
    h2hWrap.appendChild(h2h);
    h2hWrap.appendChild(labels);
    return h2hWrap;
  }

  function constructorRows(cons: ConstructorStanding[], drivers: DriverStanding[], tag: string): HTMLElement {
    const sec = el("div", "dh-standings-col");
    sec.appendChild(el("h3", "dh-section", tag ? "CONSTRUCTORS — " + tag : "CONSTRUCTORS"));
    const first = cons[0];
    if (!first) {
      sec.appendChild(emptyMsg("No constructor standings yet."));
      return sec;
    }
    // Keyed by String(team) as f1-game's plain object was: a null team groups under "null".
    const teamDrivers = new Map<string, DriverStanding[]>();
    for (const d of drivers) {
      const k = String(d.team);
      let list = teamDrivers.get(k);
      if (!list) teamDrivers.set(k, list = []);
      list.push(d);
    }

    const leaderPts = first.pos === 1 ? first.points : null;
    for (const s of cons) {
      const row = el("div", "dh-row dh-row-cons");
      rowTeam(row, s.name);
      if (s.pos === 1) row.classList.add("dh-row-lead");

      const mainInfo = el("div", "dh-cons-main");
      mainInfo.appendChild(el("span", "dh-pos", posText(s.pos)));
      const ct = findTeam(s.name);
      mainInfo.appendChild(teamChip(ct ? ct.short : (s.name ? s.name.slice(0, 3).toUpperCase() : "?"), s.name));
      mainInfo.appendChild(el("span", "dh-name", s.name || "—"));
      if (s.wins > 0) mainInfo.appendChild(el("span", "dh-wins", `${s.wins}W`));
      mainInfo.appendChild(el("span", "dh-pts", s.points));
      if (leaderPts !== null && s.pos !== 1 && leaderPts > s.points) {   // tied on points: no gap, not "−0"
        mainInfo.appendChild(el("span", "dh-gap", `−${leaderPts - s.points}`));
      }
      row.appendChild(mainInfo);

      const myDrivers = teamDrivers.get(String(s.name)) || [];
      if (myDrivers.length >= 2 && s.points > 0) {
        myDrivers.sort((a, b) => b.points - a.points);
        const [d1, d2] = myDrivers;
        if (d1 && d2) row.appendChild(h2hBar(d1, d2));
      }

      sec.appendChild(row);
    }
    return sec;
  }

  const both = (year?: number): Promise<StandingsTables> => Promise.all([api.driverStandings(year), api.constructorStandings(year)])
    .then((res) => ({ drivers: res[0] || [], cons: res[1] || [], year }));
  const any = (t: StandingsTables): boolean => t.drivers.length > 0 || t.cons.length > 0;

  // FROM JANUARY TO THE OPENER the current year has no table (api.ts reads
  // the year off the clock), and the tab read "season hasn't started" for
  // ten weeks. Then the FINAL table of last season is the useful answer —
  // labelled as such on both headings, never passed off as this year's. A
  // failed fallback fetch leaves the empty current table as it was.
  function loadStandings(): Promise<HTMLElement> {
    return both().then((cur) => {
      const y = +api.season();
      if (any(cur) || !(y > 1950)) return cur;
      return both(y - 1).then((prev) => (any(prev) ? prev : cur), () => cur);
    }).then((t) => {
      const tag = t.year != null ? "LAST SEASON · " + t.year + " FINAL" : "";
      const wrap = el("div", "dh-tabbody dh-standings");
      wrap.appendChild(driverRows(t.drivers, tag));
      wrap.appendChild(constructorRows(t.cons, t.drivers, tag));
      return wrap;
    });
  }
  return { loadStandings };
}

/** Mount STANDINGS into `host`: spinner, load, then the node (or an error block). */
export function mount(host: HTMLElement, deps: StandingsDeps & Pick<HubDeps, "clear" | "spinner">): MountedTab {
  const tab = create(deps);
  return mountTab("standings", host, deps, () => tab.loadStandings(), () => {});
}

// MOUNT SEAM (apex-26): hub.js's loadTab (hub.js:404-445) owns spinner, swap
// and error block; a standalone mount needs the same three steps. A refresh or
// unmount bumps `gen` so a load still in flight never paints over a newer one.
function mountTab(name: string, host: HTMLElement, deps: Pick<HubDeps, "el" | "clear" | "spinner">,
                  load: () => Promise<HTMLElement>, onUnmount: () => void): MountedTab {
  let gen = 0;
  function refresh(): Promise<void> {
    const myGen = ++gen;
    deps.clear(host);
    host.appendChild(deps.spinner());
    return load().then((node) => {
      if (myGen !== gen) return;
      deps.clear(host);
      host.appendChild(node);
    }, (err: unknown) => {
      if (myGen !== gen) return;
      log.warn("tab " + name + " fail", err);
      deps.clear(host);
      host.appendChild(errorNode(deps.el, () => { void refresh(); }));
    });
  }
  void refresh();
  return {
    refresh,
    unmount() {
      gen++;
      onUnmount();
      deps.clear(host);
    },
  };
}

// The UPSTREAM case of hub.js's errorBlock (hub.js:462-503), same classes.
function errorNode(el: HubDeps["el"], retryFn: () => void): HTMLElement {
  const w = el("div", "dh-error");
  w.setAttribute("role", "status");
  w.dataset.reason = "upstream";
  const titleEl = el("div", "dh-error-msg", "SERVICE UNAVAILABLE");
  titleEl.dataset.role = "title";
  w.appendChild(titleEl);
  w.appendChild(el("div", "dh-error-msg", "Couldn't reach the F1 data service. It may be busy or blocked — try again in a moment."));
  const retry = el("button", "dh-retry", "RETRY");
  retry.type = "button";
  retry.addEventListener("click", retryFn);
  w.appendChild(retry);
  return w;
}
