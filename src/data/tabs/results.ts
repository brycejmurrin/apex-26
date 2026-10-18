/**
 * The Data Hub's RESULTS tab: classification for ANY session of any 2023+
 * weekend (practice, qualifying, sprint, race), not just the latest Grand
 * Prix. Ported from f1-game js/data/results.js:1-529 (helpers :151-223,
 * create :225-525). F1API is reached through `deps.api`. Additions over
 * f1-game: `mount()` (the MountedTab seam), and the pure helpers are exported
 * for unit tests.
 */
import type { Duration, SessionDriver, SessionResultRow, Session } from "../api";
import { fmtLap as domFmtLap, fmtRaceClock } from "../dom";
import type { HubDeps, MountedTab } from "../hub-deps";
import { mountTab } from "./mount";

type Meta = Pick<Session, "name" | "type"> | null | undefined;

// Practice, race and sprint report one scalar; qualifying reports the
// [Q1,Q2,Q3] triple. The SHAPE of `duration` is what picks the columns —
// session_name is free text ("Sprint Qualifying", "Practice 2") and the
// OpenF1 session_type collapses Sprint into "Race", so neither is enough
// on its own.
export function kindOf(meta: Meta): "qualifying" | "practice" | "race" {
  const t = (String((meta && meta.name) || "") + " " +
             String((meta && meta.type) || "")).toLowerCase();
  if (t.indexOf("qual") !== -1) return "qualifying";
  if (t.indexOf("practice") !== -1) return "practice";
  return "race";                       // Race and Sprint both classify on points
}

// A sprint weekend's shootout runs SQ1/SQ2/SQ3, and calling those Q1-Q3 on
// screen is simply the wrong name for the session the player picked.
export function qLabel(meta: Meta, i: number): string {
  const t = String((meta && meta.name) || "").toLowerCase();
  return (t.indexOf("sprint") !== -1 ? "SQ" : "Q") + (i + 1);
}

// Lap time: 1:21.163, or 58.402 under the minute; null when there is none
// (a blank cell — the callers add their own "—" where a dash is wanted).
const fmtLap = (s: unknown): string | null => domFmtLap(s, null);

// Race distance: 2:04:44.859 (an hour is not guaranteed — a red-flagged
// sprint can come in under one).
// fmtRaceClock rounds BEFORE it splits: this split first and printed
// 3599.9996 as "59:60.000".
export function fmtClock(s: unknown): string | null {
  if (typeof s !== "number" || !isFinite(s) || s <= 0) return null;
  return fmtRaceClock(s);
}

export function fmtGap(v: unknown): string | null {
  if (typeof v === "string") return v;          // "+1 LAP" and friends arrive pre-formatted
  if (typeof v !== "number" || !isFinite(v)) return null;
  if (v <= 0) return "—";                       // the leader's own gap
  return "+" + v.toFixed(3);
}

function statusOf(r: SessionResultRow): "DSQ" | "DNS" | "DNF" | null {
  if (r.dsq) return "DSQ";
  if (r.dns) return "DNS";
  if (r.dnf) return "DNF";
  return null;
}

type Shaped = { duration: Duration; gap: Duration };

// Qualifying's arrays are [Q1,Q2,Q3]; anything else reads the scalar.
export function qSlot(r: Shaped, i: number): number | null {
  const v = Array.isArray(r.duration) ? r.duration[i] : null;
  return (typeof v === "number" && isFinite(v) && v > 0) ? v : null;
}
function qGap(r: Shaped, i: number): number | null {
  const v = Array.isArray(r.gap) ? r.gap[i] : null;
  return (typeof v === "number" && isFinite(v)) ? v : null;
}

// The last round this driver set a time in: 2 = reached Q3, 1 = knocked out
// in Q2, 0 = knocked out in Q1, -1 = never set a time.
export function deepest(r: Shaped): number {
  for (let i = 2; i >= 0; i--) if (qSlot(r, i) !== null) return i;
  return -1;
}

// WHICH ROUNDS ACTUALLY RAN, read from the data — never a count. A 2026
// qualifying keeps 16 through Q1 and 10 through Q2, the 2025 one kept 15 and
// 10, and a session abandoned under red flags may never reach Q3 at all. Any
// hardcoded cutoff is a lie waiting for the next regulation change.
export function roundsRan(rows: readonly Shaped[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (rows.some(function (r) { return qSlot(r, i) !== null; })) out.push(i);
  }
  return out;
}

export const FETCH_FAIL_MSG = "Couldn't load this session's classification. " +
  "Pick it again in a moment — the free F1 API rate-limits hard.";

/**
 * What renderBody records on the tab node for the hub (results.js:255-260):
 * every TabOutcome field, always set.
 */
export interface ResultsOutcome {
  status: "loading" | "ready" | "empty" | "failed";
  error: unknown;
  at: number;
  dataAt: number | null;
  offlineCopy: boolean;
  hasData: boolean;
}
export type ResultsNode = HTMLElement & { tabOutcome?: ResultsOutcome };

export type ResultsDeps = Pick<HubDeps, "api" | "el" | "clear" | "emptyMsg" | "spinner" | "sel" | "ensureSession"
  | "buildPicker" | "invalidateOther" | "teamChip" | "fmtDateTime" | "NO_RESULT_MSG" | "onOutcome">;

type Round = "all" | number;
type ByNum = Partial<Record<string, SessionDriver>>;
type Col = [string, string | null];

export function create({ api, el, clear, emptyMsg, spinner, sel, ensureSession, buildPicker,
                         invalidateOther, teamChip, fmtDateTime, NO_RESULT_MSG, onOutcome }: ResultsDeps): { loadResults(): Promise<ResultsNode> } {
  let bodyGen = 0;
  let round: Round = "all";        // "all" | 0 | 1 | 2 — which qualifying round is shown

  function loadResults(): Promise<ResultsNode> {
    return ensureSession(false).then(function () {
      const wrap: ResultsNode = el("div", "dh-tabbody");
      const body = el("div", "dh-res-body");
      wrap.appendChild(buildPicker(function (meta) {
        renderBody(meta, body, wrap);
        invalidateOther("results");
      }));
      wrap.appendChild(body);
      if (sel.sessionKey === null) {
        body.appendChild(emptyMsg(NO_RESULT_MSG));
        return wrap;
      }
      renderBody(sel.meta, body, wrap);
      return wrap;
    });
  }

  // Async and re-entrant: every pick in the picker lands here, so an
  // in-flight fetch for the session the player just moved off must not
  // paint over the newer one.
  function renderBody(meta: Session | null, body: HTMLElement, wrap: ResultsNode): void {
    const myGen = ++bodyGen;
    const mark = api.staleMark();
    function publish(status: ResultsOutcome["status"], error?: unknown): void {
      const dataAt = (status === "ready" || status === "empty") ? api.staleSince(mark) : null;
      wrap.tabOutcome = { status, error: error || null, at: Date.now(), dataAt, offlineCopy: dataAt != null,
        hasData: status === "ready" };
      if (onOutcome) onOutcome(wrap);
    }
    round = "all";           // a new session starts on its own overall order
    clear(body);
    if (!meta || meta.sessionKey == null) {
      body.appendChild(emptyMsg(NO_RESULT_MSG));
      publish("empty");
      return;
    }
    body.appendChild(header(meta));
    const slot = el("div");
    slot.appendChild(spinner());
    body.appendChild(slot);
    publish("loading");

    const key = meta.sessionKey;
    // The driver list is a nicety (names, teams, colours) — a session whose
    // /drivers has not been published still classifies by car number.
    Promise.all([
      api.sessionResult(key),
      api.sessionDrivers(key).then(null, function () { return null; }),
    ]).then(function (both) {
      if (myGen !== bodyGen) return;
      paint(meta, both[0] || [], both[1] || [], slot);
      publish(both[0] && both[0].length ? "ready" : "empty");
    }, function (err: unknown) {
      // NOT the empty-tab copy. "Nothing published yet" and "OpenF1 rate-limited
      // that request" look identical to a player, and only one of them is worth
      // pressing the tab again for — api.ts resolves the unpublished case with
      // an empty list, so a REJECTION here always means the fetch itself failed.
      if (myGen !== bodyGen) return;
      clear(slot);
      slot.appendChild(emptyMsg(FETCH_FAIL_MSG));
      publish("failed", err);
    });
  }

  // Repainting a round is a re-SORT of data already in hand, so the pills
  // call straight back here rather than through renderBody — switching
  // between Q1 and Q3 must never cost another OpenF1 request.
  function paint(meta: Session, rows: SessionResultRow[], drivers: SessionDriver[], slot: HTMLElement): void {
    clear(slot);
    if (!rows.length) { slot.appendChild(emptyMsg(NO_RESULT_MSG)); return; }
    const byNum: ByNum = {};
    drivers.forEach(function (d) { if (d && d.num !== null) byNum[d.num] = d; });

    if (kindOf(meta) === "qualifying") {
      const ran = roundsRan(rows);
      if (ran.length > 1) {
        slot.appendChild(rounds(meta, ran, function (r) {
          round = r;
          paint(meta, rows, drivers, slot);
        }));
      }
      if (round !== "all" && ran.indexOf(round) === -1) round = "all";
      slot.appendChild(round === "all" ? qualiTable(meta, rows, byNum)
                                       : roundTable(meta, rows, byNum, round));
      return;
    }
    round = "all";
    slot.appendChild(flatTable(meta, rows, byNum));
  }

  function header(meta: Session): HTMLElement {
    const head = el("div");
    head.id = "dh-lr-head";
    head.appendChild(el("div", "dh-lr-name", meta.name || meta.type || "Session"));
    const parts: string[] = [];
    const place = api.placeLabel(meta.circuit, meta.country);
    if (place) parts.push(place);
    if (meta.dateStart) parts.push(fmtDateTime(meta.dateStart));
    head.appendChild(el("div", "dh-lr-meta", parts.join(" · ")));
    return head;
  }

  function rounds(meta: Session, ran: number[], onPick: (r: Round) => void): HTMLElement {
    const box = el("div", "dh-rounds");
    const opts: [Round, string][] = ([["all", "OVERALL"]] as [Round, string][]).concat(ran.map(function (i): [Round, string] {
      return [i, qLabel(meta, i)];
    }));
    opts.forEach(function (o) {
      const b = el("button", "dh-pill" + (o[0] === round ? " active" : ""), o[1]);
      b.type = "button";
      b.setAttribute("aria-pressed", o[0] === round ? "true" : "false");
      b.addEventListener("click", function () { if (o[0] !== round) onPick(o[0]); });
      box.appendChild(b);
    });
    return box;
  }

  function tableHead(cols: Col[]): HTMLElement {
    const thead = el("thead");
    const hr = el("tr");
    cols.forEach(function (h) { hr.appendChild(el("th", h[1], h[0])); });
    thead.appendChild(hr);
    return thead;
  }

  // Every table renders as one bare <div> wrapper around its <table> — the
  // wrapper is what the caller (paint) clears and swaps on a re-sort.
  function tableWrap(t: HTMLElement): HTMLElement {
    const wrap = el("div");
    wrap.appendChild(t);
    return wrap;
  }

  // A full-width band between two groups of rows: "eliminated in Q1".
  function cutRow(span: number, text: string): HTMLElement {
    const tr = el("tr", "dh-cut");
    const td = el("td", null, text);
    td.colSpan = span;
    tr.appendChild(td);
    return tr;
  }

  function driverOf(r: SessionResultRow, byNum: ByNum): Partial<SessionDriver> {
    return byNum[String(r.num)] || {};
  }

  function driverTag(r: SessionResultRow, byNum: ByNum): string {
    const d = driverOf(r, byNum);
    return d.code || (r.num !== null ? "#" + r.num : "—");
  }

  function driverCells(tr: HTMLElement, r: SessionResultRow, byNum: ByNum): void {
    const d = driverOf(r, byNum);
    const who = d.name || (r.num !== null ? "Car " + r.num : "—");
    const tdDrv = el("td", "dh-td-driver");
    tdDrv.appendChild(teamChip(d.code || (r.num !== null ? "#" + r.num : "—"), d.team));
    tdDrv.appendChild(el("span", "dh-name", who));
    // Qualifying is three time columns wide, so the fixed table layout can
    // ellipsize a long name — the same `title` fallback the schedule rows use.
    tdDrv.title = who;
    tr.appendChild(tdDrv);
    const tdTeam = el("td", "dh-td-team", d.team || "—");
    tdTeam.title = d.team || "";
    tr.appendChild(tdTeam);
  }

  function podium(tr: HTMLElement, pos: number | null): void {
    if (pos === 1) tr.classList.add("dh-lr-p1");
    else if (pos === 2) tr.classList.add("dh-lr-p2");
    else if (pos === 3) tr.classList.add("dh-lr-p3");
  }

  // A null position is "not classified" (retired, withdrawn). Those sort
  // to the bottom in the order OpenF1 sent them, which is furthest-first.
  function byPos(rows: SessionResultRow[]): SessionResultRow[] {
    return rows.slice().sort(function (a, b) {
      if (a.pos === b.pos) return 0;
      if (a.pos === null) return 1;
      if (b.pos === null) return -1;
      return a.pos - b.pos;
    });
  }

  function flatTable(meta: Session, rows: SessionResultRow[], byNum: ByNum): HTMLElement {
    const kind = kindOf(meta);
    const cols: Col[] = [["POS", null], ["DRIVER", null], ["TEAM", "dh-th-team"],
                         ["LAPS", "dh-th-grid"]];
    cols.push(kind === "practice" ? ["BEST", null] : ["TIME", null]);
    cols.push(["GAP", null]);
    if (kind === "race") cols.push(["PTS", null]);

    const t = el("table", "dh-table");
    t.appendChild(tableHead(cols));
    const tbody = el("tbody");
    byPos(rows).forEach(function (r) {
      const tr = el("tr");
      podium(tr, r.pos);
      tr.appendChild(el("td", "dh-td-pos", r.pos !== null ? r.pos : "—"));
      driverCells(tr, r, byNum);
      tr.appendChild(el("td", "dh-td-grid", r.laps !== null ? r.laps : "—"));
      const status = statusOf(r);
      const time = kind === "practice" ? fmtLap(r.duration) : fmtClock(r.duration);
      // A retirement has no duration: the status takes the TIME cell so
      // the row still says WHY, and the gap column stays empty. The status
      // wins even when the provider kept a duration (a DSQ keeps the time
      // the car completed), or the row reads as an ordinary finish.
      tr.appendChild(el("td", "dh-td-time", status || time || "—"));
      // A lapped finisher has no duration but a "+1 LAP" label: the label
      // is the whole gap, so it must not wait on the time.
      const gap = typeof r.gap === "string" && r.gap && !status ? r.gap : (time && fmtGap(r.gap)) || "—";
      tr.appendChild(el("td", "dh-td-time", gap));
      if (kind === "race") tr.appendChild(el("td", "dh-td-pts", r.points !== null ? r.points : ""));
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    return tableWrap(t);
  }

  // OVERALL: the classification, with a band wherever the field thinned.
  function qualiTable(meta: Session, rows: SessionResultRow[], byNum: ByNum): HTMLElement {
    const t = el("table", "dh-table");
    t.appendChild(tableHead([["POS", null], ["DRIVER", null], ["TEAM", "dh-th-team"],
                        [qLabel(meta, 0), null], [qLabel(meta, 1), null], [qLabel(meta, 2), null]]));
    const tbody = el("tbody");
    let prev: number | null = null;
    byPos(rows).forEach(function (r) {
      const dp = deepest(r);
      // The classification already groups the field by how far it got, so a
      // DROP in that depth is exactly where a round's cut fell — no count,
      // no assumption about how many cars each round keeps.
      if (prev !== null && dp < prev) {
        // dp is the last round the group below BELONGS to, and a driver whose
        // deepest round is Q2 was eliminated IN Q2 — not in the Q3 they never
        // reached. Off by one here reads plausibly and is wrong on every row.
        // The provider records no "advanced" flag: a car that went through
        // but set no time in the next round reads exactly like the first car
        // knocked out there. So the lead of the group below is named rather
        // than asserted eliminated, and the band never claims more than the
        // times prove.
        tbody.appendChild(cutRow(6, dp < 0 ? "NO TIME SET"
          : "ELIMINATED IN " + qLabel(meta, dp) + " · P" + r.pos + " MAY HAVE ADVANCED WITHOUT A TIME"));
      }
      prev = dp;
      const tr = el("tr");
      podium(tr, r.pos);
      tr.appendChild(el("td", "dh-td-pos", r.pos !== null ? r.pos : "—"));
      driverCells(tr, r, byNum);
      for (let i = 0; i < 3; i++) {
        tr.appendChild(el("td", "dh-td-time", fmtLap(qSlot(r, i)) || "—"));
      }
      tbody.appendChild(tr);
    });
    t.appendChild(tbody);
    return tableWrap(t);
  }

  // ONE ROUND, on its own terms. This is the view the overall table cannot
  // give: Q1's order is not the classification's order — at Zandvoort 2026
  // the pole-sitter was only third fastest in Q1 — and the gap column is the
  // gap to THAT round's leader, which is what OpenF1's per-round array holds.
  function roundTable(meta: Session, rows: SessionResultRow[], byNum: ByNum, i: number): HTMLElement {
    // Every row here has a round-i time (the filter), so the `as number`s only restate that.
    const ran = rows.filter(function (r) { return qSlot(r, i) !== null; })
                    .sort(function (a, b) { return (qSlot(a, i) as number) - (qSlot(b, i) as number); });
    if (!ran.length) return emptyMsg(NO_RESULT_MSG);

    // The last driver, IN THIS ROUND'S ORDER, who went on to set a time in
    // the next one. Everyone below the band went out here.
    let lastThrough = -1;
    if (i < 2) {
      ran.forEach(function (r, n) { if (qSlot(r, i + 1) !== null) lastThrough = n; });
    }

    const t = el("table", "dh-table");
    t.appendChild(tableHead([["POS", null], ["DRIVER", null], ["TEAM", "dh-th-team"],
                        [qLabel(meta, i), null], ["GAP", null]]));
    const tbody = el("tbody");
    ran.forEach(function (r, n) {
      const tr = el("tr");
      podium(tr, n + 1);
      tr.appendChild(el("td", "dh-td-pos", n + 1));
      driverCells(tr, r, byNum);
      tr.appendChild(el("td", "dh-td-time", fmtLap(qSlot(r, i))));
      tr.appendChild(el("td", "dh-td-time", fmtGap(qGap(r, i)) || "—"));
      tbody.appendChild(tr);
      if (n === lastThrough) {
        const nx = ran[n + 1];
        tbody.appendChild(cutRow(5, "ELIMINATED IN " + qLabel(meta, i) +
          (nx ? " · " + (driverTag(nx, byNum)) + " MAY HAVE ADVANCED WITHOUT A TIME" : "")));
      }
    });
    t.appendChild(tbody);
    return tableWrap(t);
  }

  return { loadResults };
}

/** Mount RESULTS into `host`: spinner, load, then the node (or an error block). */
export function mount(host: HTMLElement, deps: ResultsDeps): MountedTab {
  const tab = create(deps);
  return mountTab("results", host, deps, () => tab.loadResults(), () => {});
}
