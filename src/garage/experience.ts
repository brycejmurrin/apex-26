/**
 * GarageExperience: reversible garage / home cameras, the ambient clock, and
 * honest part comparisons.
 *
 * Port of f1-game js/garage/experience.js:1-181, verbatim: clock :5-13,
 * HOME_SHOTS :15-23, homeShot :25-28, homeSession :30-53, canOrbit :55-57,
 * freePane :59-70, fitHome :72-99, statsOf :101-107, compare :109-119,
 * partSummary :121-140, careerKey :142-145, buildFacility :147-166,
 * paintCareer :168-178, the export object :180.
 *
 * f1-game reads the globals Career (statsOf), Parts (compare) and GaragePrims
 * (buildFacility). Parts and the prims are imported (src/car/parts.ts,
 * ./scene/prims.ts); Career is injected: `createGarageExperience({ career })`.
 * `GarageExperience` is the instance with no career (f1-game's
 * `typeof Career === "undefined"`). The instance satisfies the scene's
 * GarageExperienceApi seam (./scene/types.ts), so createGarageScene builds one
 * over its own `career` dep by default.
 */
import { Parts, type PartOption, type PartSetup, type PartsTeam, type PartsTune } from "../car/parts";
import { block, DARK, rgb, STEEL, Z_BACK, type V3 } from "./scene/prims";
import type { GarageCanvas, GarageCareer, GarageCtx, GarageExperienceApi, GarageLivery, GarageTeam, Groups } from "./scene/types";

// ── the ambient clock ───────────────────────────────────────────────────────

/** experience.js:5-13. A clock that only runs while `moving`; a gap is capped at 100 ms. */
export interface AmbientClock {
  step(wall: number, moving: boolean): number;
  reset(wall: number): void;
  readonly value: number;
}
export function clock(now = 0): AmbientClock {
  let at = now, last = now;
  return { step(wall, moving) {
    const gap = Math.max(0, Math.min(100, wall - last));
    last = wall;
    if (moving) at += gap;
    return at;
  }, reset(wall) { at = last = wall; }, get value() { return at; } };
}

// ── home shots ──────────────────────────────────────────────────────────────

/** An orbit framing: azimuth, elevation, distance, and the optional lens. */
export interface HomePose {
  readonly az: number;
  readonly el: number;
  readonly dist: number;
  readonly fov?: number;
  readonly maxDist?: number;
}
export type HomeShotName = "hero" | "front" | "side" | "rear";

// Composed home shots use the existing orbit rig and its panel lens shift.
// Garage inspection presets remain unchanged; these views give a menu visit
// its own framing without changing any saved driving or photo preference.
export const HOME_SHOTS: Readonly<Record<HomeShotName, HomePose>> = Object.freeze({
  hero: Object.freeze({ az: Math.PI * 0.78, el: 0.30, dist: 8.35 }),
  front: Object.freeze({ az: Math.PI * 0.16, el: 0.24, dist: 6.4, fov: 54, maxDist: 6.4 }),
  side: Object.freeze({ az: Math.PI * 0.50, el: 0.15, dist: 10.2 }),
  rear: Object.freeze({ az: Math.PI * 0.92, el: 0.28, dist: 8.2 }),
});

/** experience.js:25-28 */
export function homeShot(mode: string, requested: unknown): { name: HomeShotName; pose: HomePose } {
  const name = (Object.prototype.hasOwnProperty.call(HOME_SHOTS, requested as PropertyKey) ? requested : mode === "studio" ? "side" : "hero") as HomeShotName;
  return { name, pose: HOME_SHOTS[name] };
}

/** The camera a home session borrows (setup-camera.js captureCamera / restoreCamera / setHomeView). */
export interface HomeCamera<S> {
  capture(): S;
  restore(saved: S): void;
  view(name: HomeShotName, pose: HomePose): void;
}
/** A home session's options (js/ui/experience.js): the shot, ambient motion, the panel the car avoids. */
export interface HomeOpts {
  readonly shot?: string | undefined;
  readonly motion?: string | undefined;
  readonly panel?: HTMLElement | null | undefined;
}
export type HomeMode = "garage" | "night" | "studio";
export interface HomeState { mode: HomeMode; motion: "ambient" | "still"; shot: HomeShotName }
export interface HomeSession {
  begin(mode: string, opts?: HomeOpts): boolean;
  end(): boolean;
  readonly active: boolean;
  readonly mode: HomeMode | null;
  readonly panel: HTMLElement | null | undefined;
  readonly lens: HomePose | null;
  readonly moving: boolean;
  state(): HomeState | null;
}

/** experience.js:30-53 */
export function homeSession<S>(camera: HomeCamera<S>, reduced: () => boolean): HomeSession {
  let home: { saved: S; mode: HomeMode; opts: HomeOpts; shot?: HomeShotName } | null = null;
  return {
    begin(mode, opts = {}) {
      if (!["garage", "night", "studio"].includes(mode)) return false;
      if (!home) home = { saved: camera.capture(), mode: mode as HomeMode, opts };
      home.mode = mode as HomeMode; home.opts = opts;
      const shot = homeShot(mode, opts.shot);
      home.shot = shot.name;
      camera.view(shot.name, shot.pose);
      return true;
    },
    end() {
      if (!home) return false;
      const saved = home.saved; home = null; camera.restore(saved); return true;
    },
    get active() { return !!home; },
    get mode() { return home && home.mode; },
    get panel() { return home && home.opts.panel; },
    get lens() { return home ? HOME_SHOTS[home.shot as HomeShotName] : null; },
    get moving() { return !!home && home.opts.motion === "ambient" && !reduced(); },
    state() { return home ? { mode: home.mode, motion: this.moving ? "ambient" : "still", shot: home.shot as HomeShotName } : null; },
  };
}

/** experience.js:55-57 */
export function canOrbit(garage: unknown, home: unknown, photo: unknown, blocked: unknown): boolean {
  return !blocked && (!!garage || (!!home && !!photo));
}

/** A DOMRect-shaped box (the panel's and the canvas's client rects). */
export interface RectLike {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}
/** A free pane of the canvas, as 0..1 fractions. */
export interface Pane { left: number; right: number; top: number; bottom: number }

/** experience.js:59-70 */
export function freePane(panel: RectLike, canvas: RectLike): Pane {
  const w = canvas.width, h = canvas.height;
  const unit = (v: number): number => Math.max(0, Math.min(1, v));
  if (w - panel.width >= h - panel.height) {
    return panel.left + panel.right < canvas.left + canvas.right
      ? { left: unit((panel.right - canvas.left) / w), right: 1, top: 0, bottom: 1 }
      : { left: 0, right: unit((panel.left - canvas.left) / w), top: 0, bottom: 1 };
  }
  return panel.top + panel.bottom < canvas.top + canvas.bottom
    ? { left: 0, right: 1, top: unit((panel.bottom - canvas.top) / h), bottom: 1 }
    : { left: 0, right: 1, top: 0, bottom: unit((panel.top - canvas.top) / h) };
}

/** The orbit rig fitHome frames: angles, the look-at, the lens and the distance range. */
export interface HomeRig {
  readonly az: number;
  readonly el: number;
  readonly center: ArrayLike<number>;
  readonly aspect: number;
  readonly fov: number;
  readonly minDist: number;
  readonly maxDist: number;
}
export interface HomeFit { dist: number; shiftX: number; shiftY: number; width: number; height: number }

/** experience.js:72-99. Bisects the orbit distance until the hull fits the pane. */
export function fitHome(hull: ArrayLike<number> | null | undefined, rig: HomeRig, pane: Pane): HomeFit | null {
  if (!hull || hull.length < 3) return null;
  const ca = Math.cos(rig.az), sa = Math.sin(rig.az), ce = Math.cos(rig.el), se = Math.sin(rig.el);
  const tan = Math.tan(rig.fov * Math.PI / 360), cx = rig.center[0]!, cy = rig.center[1]!, cz = rig.center[2]!;
  const width = Math.max(0.05, (pane.right - pane.left) * 2 * 0.84);
  const height = Math.max(0.05, (pane.bottom - pane.top) * 2 * 0.76);
  let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  function project(dist: number): boolean {
    x0 = y0 = Infinity; x1 = y1 = -Infinity;
    for (let i = 0; i < hull!.length; i += 3) {
      const x = hull![i]! - cx, y = hull![i + 1]! - cy, z = hull![i + 2]! - cz;
      const depth = dist - (x * sa * ce + y * se + z * ca * ce);
      if (depth <= 0.1) return false;
      const nx = (x * ca - z * sa) / (depth * tan * rig.aspect);
      const ny = (-x * sa * se + y * ce - z * ca * se) / (depth * tan);
      x0 = Math.min(x0, nx); x1 = Math.max(x1, nx); y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
    }
    return x1 - x0 <= width && y1 - y0 <= height;
  }
  let lo = rig.minDist, hi = rig.maxDist;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (project(mid)) hi = mid; else lo = mid;
  }
  project(hi);
  return { dist: hi, shiftX: (x0 + x1) / 2 - (pane.left + pane.right - 1),
    shiftY: (y0 + y1) / 2 - (1 - pane.top - pane.bottom), width: x1 - x0, height: y1 - y0 };
}

// ── part comparison ─────────────────────────────────────────────────────────

/** A team as compare / partSummary read it: the scene's GarageTeam plus Parts' supplier fields. */
export type ExperienceTeam = GarageTeam & { readonly engine?: string | null | undefined; readonly factory?: PartSetup | null | undefined };
/** A CATALOG category as compare reads it. */
export interface CompareCat { readonly id: string; readonly label: string }
export interface StatDelta { key: string; label: string; value: number }
export interface Comparison { deltas: StatDelta[]; cost: number; remaining: number }
export type ShowComparison = (opt: PartOption) => void;

/** GarageExperience's full API (experience.js:180). */
export interface GarageExperienceFull extends GarageExperienceApi {
  clock: typeof clock;
  homeShot: typeof homeShot;
  homeSession: typeof homeSession;
  canOrbit: typeof canOrbit;
  freePane: typeof freePane;
  fitHome: typeof fitHome;
  statsOf(team: GarageTeam): GarageExperienceStats;
  compare(team: ExperienceTeam, parts: PartSetup, cat: CompareCat, current: PartOption | null | undefined,
    candidate: PartOption, tune: PartsTune | null | undefined, cap: number): Comparison;
  partSummary(container: HTMLElement, team: ExperienceTeam, parts: PartSetup, cat: CompareCat,
    current: PartOption | null | undefined, tune: PartsTune | null | undefined, cap: number, frame: () => void): ShowComparison;
}
export type GarageExperienceStats = Readonly<Record<string, number | undefined>> | null;

export interface ExperienceDeps {
  /** Career.teamStats (the career's development, tdev). TODO(lane-race): the career module. */
  readonly career?: GarageCareer | null | undefined;
}

/** careerKey, experience.js:142-145 */
export function careerKey(ctx: GarageCtx | null | undefined): string {
  const a = ctx && ctx.achievements;
  return a && a.active ? [a.facility, a.wins, a.podiums, a.titles].join(":") : "-";
}

/** buildFacility, experience.js:147-166 */
export function buildFacility(g: Groups, liv: GarageLivery | null | undefined, ctx: GarageCtx | null | undefined): void {
  const a = ctx && ctx.achievements;
  if (!a || !a.active) return;
  const accent = rgb(liv && liv.c2, STEEL);
  // Each two earned facility levels install a research workstation; geometry
  // is built only when the career metadata changes, never on the frame clock.
  const count = Math.min(4, Math.ceil(Math.max(0, a.facility as number) / 2));
  for (let i = 0; i < count; i++) {
    const x = -3.4 + i * 1.8;
    block(g.back, x, 0.9, Z_BACK + 0.75, 0.68, 0.10, 0.38, STEEL);
    block(g.back, x, 0.45, Z_BACK + 0.75, 0.55, 0.40, 0.29, DARK);
    block(g.back, x, 1.30, Z_BACK + 0.50, 0.39, 0.27, 0.07, DARK);
    block(g.back, x, 1.30, Z_BACK + 0.59, 0.34, 0.21, 0.01, accent);
  }
  // Earned wins become a compact trophy shelf, capped to avoid clutter.
  const wins = a.wins as number;
  if (wins > 0) block(g.back, 2.95, 2.12, Z_BACK + 0.20, 1.05, 0.04, 0.15, STEEL);
  const GOLD: V3 = [0.72, 0.54, 0.18];
  for (let i = 0; i < Math.min(6, wins); i++)
    block(g.back, 2.2 + i * 0.30, 2.32, Z_BACK + 0.20, 0.09, 0.16, 0.08, GOLD);
}

/** paintCareer, experience.js:168-178 */
export function paintCareer(cv: GarageCanvas, ctx: GarageCtx | null | undefined): void {
  const a = ctx && ctx.achievements;
  if (!a || !a.active) return;
  const c = cv.getContext("2d")!;
  c.fillStyle = "#10141b"; c.fillRect(0, 320, 512, 64);
  c.fillStyle = "#f2f3f5"; c.textAlign = "center"; c.textBaseline = "middle";
  c.font = "700 23px system-ui, sans-serif";
  c.fillText("RESEARCH FACILITY " + a.facility + " / " + a.facilityMax, 256, 341, 490);
  c.font = "600 16px system-ui, sans-serif"; c.fillStyle = "#c4ccd8";
  c.fillText(a.wins + " WINS · " + a.podiums + " PODIUMS · " + a.titles + " TITLES", 256, 365, 490);
}

/** One GarageExperience over `deps.career` (experience.js:2-181). */
export function createGarageExperience(deps: ExperienceDeps = {}): GarageExperienceFull {
  const Career = deps.career || null;

  // The team's stats AS RACED: Career.teamStats folds in the career development
  // (tdev) that game.js modsFor applies, so the bars, the comparison and the wall
  // board all agree with the car. Outside a career it is team.stats.
  function statsOf(team: GarageTeam): GarageExperienceStats {
    const s = Career && Career.teamStats ? Career.teamStats(team) : null;
    return s || (team && team.stats) || null;
  }

  function compare(team: ExperienceTeam, parts: PartSetup, cat: CompareCat, current: PartOption | null | undefined,
    candidate: PartOption, tune: PartsTune | null | undefined, cap: number): Comparison {
    const next = Object.assign({}, parts, { [cat.id]: candidate.id }) as PartSetup;
    const pt = team as PartsTeam;
    const before = Parts.getMods(parts, pt, tune), after = Parts.getMods(next, pt, tune);
    const stats = statsOf(team);
    const deltas = Parts.STAT_KEYS.map(({ key, label }) => {
      const base = (stats && stats[key]) || 75;
      return { key, label, value: Math.round(Parts.displayStat(base * after[key])) - Math.round(Parts.displayStat(base * before[key])) };
    });
    return { deltas, cost: (candidate.cost || 0) - ((current && current.cost) || 0),
      remaining: cap - Parts.getCost(next, pt) };
  }

  function partSummary(container: HTMLElement, team: ExperienceTeam, parts: PartSetup, cat: CompareCat,
    current: PartOption | null | undefined, tune: PartsTune | null | undefined, cap: number, frame: () => void): ShowComparison {
    const box = document.createElement("section"); box.className = "cs-inspection";
    box.setAttribute("aria-label", "Part comparison");
    const head = document.createElement("strong"), detail = document.createElement("p");
    detail.setAttribute("aria-live", "polite"); detail.setAttribute("aria-atomic", "true");
    const inspect = document.createElement("button"); inspect.type = "button";
    inspect.className = "sel-chip"; inspect.textContent = "INSPECT " + cat.label.toUpperCase();
    inspect.onclick = frame;
    box.append(head, detail, inspect); container.appendChild(box);
    function show(opt: PartOption): void {
      const c = compare(team, parts, cat, current, opt, tune, cap);
      head.textContent = opt.label;
      const stats = c.deltas.filter((d) => d.value).map((d) => d.label + " " + (d.value > 0 ? "+" : "") + d.value);
      detail.textContent = opt.id === (current && current.id) ? "Fitted · inspect the car or compare another option."
        : (c.cost > 0 ? "+" : "") + c.cost + " cr vs fitted · " + (Number.isFinite(cap) ? c.remaining + " cr remaining" : "Free build")
          + (stats.length ? " · " + stats.join(" / ") : " · Same displayed performance");
    }
    if (current) show(current);
    return show;
  }

  return Object.freeze({ clock, homeShot, homeSession, canOrbit, freePane, fitHome, statsOf, compare, partSummary, careerKey, buildFacility, paintCareer });
}

/** The page's GarageExperience with no career (f1-game's `typeof Career === "undefined"`). */
export const GarageExperience: GarageExperienceFull = createGarageExperience();
