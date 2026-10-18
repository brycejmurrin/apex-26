/* Apex 26 — Teams: hardcoded, verified 2026 grid (11 teams, 22 drivers).
   Colors are [r,g,b] floats 0..1. tier: 0 fastest .. 4 slowest.

   Ported verbatim from f1-game js/data/teams.js:1-388 (the `Teams` IIFE global).
   - LIST            js/data/teams.js:31-269
   - POINTS          js/data/teams.js:270-272
   - TIER_V          js/data/teams.js:274-286
   - isReal          js/data/teams.js:288-299
   - DEFAULT_CUSTOM  js/data/teams.js:301-309
   - sanitizeCustom  js/data/teams.js:311-384 (cleanText/cleanRgb/cleanDriver/liveryEnumOk)
   The IIFE is now module scope; `Teams` is still the frozen record of the same
   seven members (js/data/teams.js:386-388).

   Deviation: liveryEnumOk read the Car3D / LiveryTex globals behind `typeof`
   guards (js/data/teams.js:345-352). Here they arrive as the optional `deps`
   argument (LiveryEnumDeps); an absent dep, or an absent member, takes the
   same branch the `typeof X === "undefined"` test took. sanitizeCustom
   forwards its own optional `deps` to it. */

import type { Rgb, TeamLivery } from "./liveries";

export type { Rgb, TeamLivery } from "./liveries";

export interface Driver {
  name: string;
  code: string;
  num: number;
}

export interface TeamStats {
  speed: number;
  accel: number;
  cornering: number;
  braking: number;
}

/** One grid entry. `custom` marks the MY TEAM record and `legends` the LEGENDS
 *  entry that f1-game splices into Teams.LIST at boot (js/data/teams.js:288-299). */
export interface Team {
  id: string;
  name: string;
  short: string;
  color: Rgb;
  color2: Rgb;
  livery?: TeamLivery;
  engine: string;
  tier: number;
  stats: TeamStats;
  drivers: Driver[];
  custom?: boolean;
  legends?: boolean;
}

/** Car3D / LiveryTex id tables liveryEnumOk consults when they are loaded
 *  (js/data/teams.js:347-349). Omit a member to reproduce `typeof X === "undefined"`. */
export interface LiveryEnumDeps {
  /** Car3D.FIN_SHAPE_IDS and Car3D.FINISH_SURFACE. */
  Car3D?: { FIN_SHAPE_IDS?: readonly string[]; FINISH_SURFACE?: Readonly<Record<string, unknown>> };
  /** LiveryTex.NUM_FONT_IDS. */
  LiveryTex?: { NUM_FONT_IDS?: readonly string[] };
}


// Every team's DEFAULT livery names its 2026 engine cover: Liveries.forTeam
// folds `livery` into the synthesized "default" (new player + every AI car),
// while the picker entries in js/car/liveries.js keep the plain cover.
// Fields: LiveryTex.SPINE_LOGO_IDS / SPINE_SIDE_IDS (crown and flank
// graphics), Car3D.SPINE_HEIGHT_IDS / FIN_SHAPE_IDS (shape).
//
// SHARK FINS ARE PER TEAM (2026-10-03). This used to say no real 2026 car
// carries a tail fin; the launch and shakedown reports say four do. Red Bull
// and Ferrari run "a fairly pronounced shark fin thanks to relatively slim
// engine covers", Ferrari's and McLaren's STEPPED, Red Bull's not (Motorsport
// .com, 2026 early tech trends, /10794222/); Mercedes "a larger shark fin"
// over a relatively small engine cover (Autosport, /10791945/). Those four
// carry a blade on a `standard` or `raised` spine (a dorsal crown buries it;
// `raised` keeps the flank tall enough for the `lockup` side design) — and
// the rest keep the fin-less `dorsal` cover. Body shapes (pods, undercut,
// airbox) live in the FACTORY_PRESETS engine recipes in js/car/parts.js and
// the nose in Car3D.TEAM_STYLE. NAMES are constructor names only: no title
// sponsor (Petronas, HP) in a display name — the data hub matches the API's
// names by `short` (js/data/hub.js TEAM_KEYS), never by `name`.
//
// ONE `livery:` key per team: two sessions each adding one merged without a
// conflict, the later duplicate key silently won and the earlier design
// vanished. tests/unit/team-livery.test.mjs is the guard.
// `carbon` and `bigmark` are not defaults: on a near-black car (Audi's cover,
// Mercedes) both disappear from a race camera (tools/shot/shot.mjs --team).
const LIST: Team[] = [
  {
    id: "mercedes", name: "Mercedes-AMG", short: "MER",
    color: [0.045, 0.055, 0.065], color2: [0.0, 0.706, 0.671],   /* black #0B0E10 / team teal #00B4AB (2026 black car) */
    /* The W17 is a BLACK car with a SILVER engine cover: the launch photos show
       the airbox, roll structure and cover crown in bare-metal silver over a
       black chassis, with the star flake on the tail. The team's own launch
       renders (mercedesamgf1.com, 22 Jan 2026) add a SILVER NOSE TOP edged in
       teal ("the transition from iconic Mercedes silver to the team's deep
       black") — `noseStripe` — and a black shark fin carrying the stars. The
       upper/lower silver-to-black split is `upper`: the chassis band above
       the sidepod board line in silver, with PRIMARY (black) below. */
    livery: {
      // OUTLINE (logo3) is TEAM DATA, not a hidden re-pick: the W17's silver star carries a dark rim on its silver cover — 1.23:1 bare.
      // The brand colour is exact (markPalette never substitutes it); the rim
      // is what keeps it legible, the same row a player uses for the same job.
      // UPPER: silver upper-chassis band (CarShade.upperZone) — same silver as cover / noseStripe.
      logo3: [0.06, 0.06, 0.08], cover: [0.76, 0.78, 0.82], finStyle: "stars", finShape: "standard", spineHeight: "raised",
              spineLogo: "fade", spineSide: "starfield", coverBind: "spineOnly",
              noseStripe: [0.76, 0.78, 0.82], fin: [0.045, 0.055, 0.065],
              upper: [0.76, 0.78, 0.82] },
    engine: "Mercedes", tier: 0,
    stats: { speed: 96, accel: 91, cornering: 93, braking: 90 },
    drivers: [
      { name: "George Russell", code: "RUS", num: 63 },
      { name: "Kimi Antonelli", code: "ANT", num: 12 }
    ]
  },
  {
    id: "ferrari", name: "Scuderia Ferrari", short: "FER",
    color: [0.863, 0.0, 0.0], color2: [1.0, 1.0, 1.0],           /* red #DC0000 / white */
    /* The SF-26's white engine-cover TOP is a SADDLE ZONE on the red body —
       cover stays body red; saddleTint + saddleWrap paint the white block
       (crown + flanks). Same split as the launch photos, expressed as zones.
       Its WINGS are black, not the white c2 they fell back to (launch renders),
       and it runs a STEPPED fin on a slim cover (see the shark-fin note). */
    livery: { cover: [0.863, 0.0, 0.0], finShape: "stepped", spineHeight: "standard",
              wing: [0.06, 0.06, 0.07], rearWing: [0.06, 0.06, 0.07],
              spineLogo: "cap", spineSide: "shoulder", coverBind: "saddleWrap", finHandoff: "contrast",
              saddleTint: [0.95, 0.95, 0.96], fin: [0.863, 0.0, 0.0],
              // OUTLINE (logo3) is TEAM DATA, not a hidden re-pick: the black horse is 3.75:1 on
              // the red cover wherever it paints WITHOUT its shield (bigmark, flank logo). A
              // shield-yellow rim reads 4.3:1 on red and vanishes on the shield itself.
              logo3: [1.0, 0.925, 0.0] },
    engine: "Ferrari", tier: 1,
    stats: { speed: 97, accel: 88, cornering: 91, braking: 92 },
    drivers: [
      { name: "Charles Leclerc", code: "LEC", num: 16 },
      { name: "Lewis Hamilton", code: "HAM", num: 44 }
    ]
  },
  {
    id: "mclaren", name: "McLaren", short: "MCL",
    livery: {
      // OUTLINE (logo3) is TEAM DATA, not a hidden re-pick: papaya speedmark on the papaya cover is 1.04:1 bare — the MCL's mark is rimmed.
      // The brand colour is exact (markPalette never substitutes it); the rim
      // is what keeps it legible, the same row a player uses for the same job.
      // The MCL40 runs a STEPPED fin (Motorsport.com) — anthracite, the c2 it inherits.
      // LOWER: the MCL40's anthracite under the papaya — pod flanks and lower chassis (CarShade.lowerZone) — its own c2.
      logo3: [0.06, 0.06, 0.08], finShape: "stepped", spineHeight: "raised", spineLogo: "panel", spineSide: "wordmark",
      lower: [0.122, 0.122, 0.122] },
    color: [1.0, 0.502, 0.0], color2: [0.122, 0.122, 0.122],     /* papaya #FF8000 / anthracite #1F1F1F */
    engine: "Mercedes", tier: 1,
    stats: { speed: 93, accel: 94, cornering: 96, braking: 91 },
    drivers: [
      { name: "Lando Norris", code: "NOR", num: 1 },             /* 2025 world champion */
      { name: "Oscar Piastri", code: "PIA", num: 81 }
    ]
  },
  {
    id: "redbull", name: "Red Bull Racing", short: "RBR",
    // OUTLINE (logo3) is TEAM DATA, not a hidden re-pick: the red bulls are dark on the blue
    // wherever they paint WITHOUT the sun disc (bigmark, flank logo). A sun-gold rim reads
    // on the blue and vanishes on the disc itself.
    // The RB22 left the matte navy for a GLOSS, brighter "racing blue" (redbull.com and
    // formula1.com launch reports, 16 Jan 2026; "a richer blue than ever", Robb Report;
    // "new-look racing blue … glossy", Red Bull Content Pool 16 Jan 2026). The prior
    // #0A2F94 still read as dark navy — lift toward published ORBR #3671C6. Cap at
    // #2555B5 so the authored sun-gold logo3 rim still clears MARK_FLOOR 4.2:1 on
    // the body (full #3671C6 drops that rim to ~3.14:1). Yellow nose stays.
    livery: { finShape: "standard", spineHeight: "standard", spineLogo: "wrap", spineSide: "duo",
              logo3: [1.0, 0.788, 0.024], nose: [1.0, 0.788, 0.024], fin: [0.145, 0.333, 0.710] },
    color: [0.145, 0.333, 0.710], color2: [1.0, 0.843, 0.0],     /* gloss racing blue #2555B5 / yellow #FFD700 */
    engine: "Red Bull Ford", tier: 2,
    stats: { speed: 90, accel: 88, cornering: 91, braking: 87 },
    drivers: [
      { name: "Max Verstappen", code: "VER", num: 3 },
      { name: "Isack Hadjar", code: "HAD", num: 6 }
    ]
  },
  {
    id: "alpine", name: "Alpine", short: "ALP",
    /* spineTint must clear the blue cover (≥2:1). Launch pink #FF87BC is only
       ~1.56:1 on #0093CC and made every crown band invisible to cover-legibility,
       so a prior pass shipped WHITE. That reads as a white stripe on a BWT car.
       Restore a PINK crown with a lighter tint #FFB3D1 (~2.08:1 on #0093CC) so
       the band stays visible and still reads as BWT pink (SI/OnSI 23 Jan 2026
       names “a strip of the engine cover” among the pink zones). #FFD6E7 was
       ≥2:1 but soft-render Δ vs white stayed under the garage pixelDiff
       threshold (>24/channel) — use a deeper pink so the stripe is measurable.
       PINK WHERE THE A526 WEARS IT, not wherever c2 falls: a pink nose top
       ("pink surface on the nose", Motorsport.com), the halo, and the big pink
       sponsor lettering on otherwise blue sidepods ("the sidepods return to
       the car's main blue colour, with the logo ... in pink writing on top",
       The Race, 23 Jan 2026) — `pod`. Wing flaps go blue, not pink. */
    livery: {
      // OUTLINE (logo3) is TEAM DATA, not a hidden re-pick: the A mark IS the cover blue (1.00:1) — rimmed, as on the A524.
      // The brand colour is exact (markPalette never substitutes it); the rim
      // is what keeps it legible, the same row a player uses for the same job.
      logo3: [0.06, 0.06, 0.08], finShape: "none", spineHeight: "dorsal", spineLogo: "stripe", spineSide: "band",
              spineTint: [1.0, 0.702, 0.820], pod: [1.0, 0.529, 0.737], noseStripe: [1.0, 0.529, 0.737],
              halo: [1.0, 0.529, 0.737], wing: [0.0, 0.576, 0.8] },
    color: [0.0, 0.576, 0.8], color2: [1.0, 0.529, 0.737],       /* blue #0093CC / pink #FF87BC */
    engine: "Mercedes", tier: 3,
    stats: { speed: 83, accel: 80, cornering: 82, braking: 80 },
    drivers: [
      { name: "Pierre Gasly", code: "GAS", num: 10 },
      { name: "Franco Colapinto", code: "COL", num: 43 }
    ]
  },
  {
    id: "racingbulls", name: "Racing Bulls", short: "RB",
    livery: {
      // OUTLINE (logo3) is TEAM DATA, not a hidden re-pick: RB letters on their own blue read 1.00:1 bare — a light rim.
      // The brand colour is exact (markPalette never substitutes it); the rim
      // is what keeps it legible, the same row a player uses for the same job.
      // Detroit launch 2026 base: matte white + blue spine; no Miami yellow nose tip.
      // The VCARB 03 shows more bare carbon than paint on its wings.
      logo3: [0.97, 0.97, 0.98], finShape: "none", spineHeight: "dorsal", spineLogo: "streaks", spineSide: "sash",
              spineTint: [0.086, 0.204, 0.796], wingCarbon: "carbon", finish: "matte" },
    color: [0.961, 0.961, 0.969], color2: [0.086, 0.204, 0.796], /* cool white #F5F5F7 / blue #1634CB */
    engine: "Red Bull Ford", tier: 3,
    stats: { speed: 82, accel: 82, cornering: 81, braking: 80 },
    drivers: [
      { name: "Liam Lawson", code: "LAW", num: 30 },
      { name: "Arvid Lindblad", code: "LIN", num: 41 }
    ]
  },
  {
    id: "haas", name: "Haas", short: "HAA",
    /* The VF-26 is a WHITE car: "a predominantly white livery" (ESPN), "the
       black carbon areas of last year's car replaced by more large white areas
       and additional red accents" (Sky Sports), both 19 Jan 2026. Red on the
       wings and a red block on the engine cover (`panel`); the remaining black
       is low bodywork: the `lower` zone (pod flanks, lower chassis).
       OUTLINE (logo3) is TEAM DATA: the white monogram on the white cover is
       1.03:1 bare — a dark rim, the same row a player uses for the same job. */
    livery: { finShape: "none", spineHeight: "dorsal", spineLogo: "panel", spineSide: "number",
              logo3: [0.06, 0.06, 0.08], lower: [0.06, 0.06, 0.07] },
    color: [0.957, 0.957, 0.965], color2: [0.855, 0.161, 0.11],  /* white #F4F4F6 / red #DA291C */
    engine: "Ferrari", tier: 3,
    stats: { speed: 80, accel: 79, cornering: 79, braking: 79 },
    drivers: [
      { name: "Esteban Ocon", code: "OCO", num: 31 },
      { name: "Oliver Bearman", code: "BEA", num: 87 }
    ]
  },
  {
    id: "williams", name: "Williams", short: "WIL",
    color: [0.059, 0.235, 0.788], color2: [1.0, 1.0, 1.0],       /* blue #0F3CC9 / white */
    /* The FW48's cover is BLACK (a secondary source claimed white; the launch
       photographs and the official release say otherwise — the white is the
       sidepod and wings). docs/notes/LIVERY-2026-REFERENCE.md. The white
       sidepod panel is `pod`. */
    livery: { cover: [0.055, 0.058, 0.070], finShape: "none", spineHeight: "dorsal",
              spineLogo: "ridge", spineSide: "rake", coverBind: "independent",
              spineTint: [0.0, 0.82, 0.95], sideTint: [0.059, 0.235, 0.788], pod: [1.0, 1.0, 1.0] },
    engine: "Mercedes", tier: 3,
    stats: { speed: 82, accel: 78, cornering: 80, braking: 79 },
    drivers: [
      { name: "Carlos Sainz", code: "SAI", num: 55 },
      { name: "Alexander Albon", code: "ALB", num: 23 }
    ]
  },
  {
    id: "audi", name: "Audi", short: "AUD",
    color: [0.702, 0.722, 0.741], color2: [0.98, 0.28, 0.05],
    /* titanium silver #B3B8BD / Audi red-orange #FA470D body with a CARBON
       BLACK engine cover — silver body, black cover, red accents rearward
       (~24 launch-gallery photographs and the launch report agree;
       docs/notes/LIVERY-2026-REFERENCE.md carries the sources). */
    livery: { finShape: "none", spineHeight: "dorsal", spineLogo: "cap", spineSide: "rake",
              coverBind: "independent", cover: [0.075, 0.078, 0.085],
              saddleTint: [0.98, 0.28, 0.05], spineTint: [0.98, 0.28, 0.05] },
    engine: "Audi", tier: 4,
    stats: { speed: 76, accel: 74, cornering: 75, braking: 73 },
    drivers: [
      { name: "Nico Hülkenberg", code: "HUL", num: 27 },
      { name: "Gabriel Bortoleto", code: "BOR", num: 5 }
    ]
  },
  {
    id: "astonmartin", name: "Aston Martin", short: "AMR",
    /* The AMR26 wears a DARK STRIPE down the spine of a body-green cover
       (launch gallery; docs/notes/LIVERY-2026-REFERENCE.md). `spineTint`,
       not `stripe`: the band otherwise takes the LIME accent, and a dark
       `stripe` would darken the NOSE, which the photographs contradict.
       SATIN, not gloss ("the car sports a satin finish", Robb Report, 12 Feb
       2026; Wikipedia / formula1.com 9 Feb 2026), on a compact cover "with
       vents" (Motorsport.com) — `gills`. Launch also settles a LIGHT BLUE
       rear wing (Wikipedia citing formula1.com 9 Feb 2026) — `rearWing`.
       A near-black airbox `cover` was tried and dropped: it made player
       crown designs (cap/ridge/fade) read 0% on cover-legibility. The dark
       spineTint stripe already carries the dark-spine story on body green. */
    livery: { finShape: "none", spineHeight: "dorsal", spineLogo: "stripe", spineSide: "logo",
              spineTint: [0.008, 0.086, 0.078], finish: "satin", coverVents: "gills",
              rearWing: [0.55, 0.72, 0.88] },
    color: [0.0, 0.349, 0.31], color2: [0.718, 0.882, 0.106],    /* green #00594F / lime accents */
    engine: "Honda", tier: 4,
    stats: { speed: 74, accel: 72, cornering: 76, braking: 74 },
    drivers: [
      { name: "Fernando Alonso", code: "ALO", num: 14 },
      { name: "Lance Stroll", code: "STR", num: 18 }
    ]
  },
  {
    id: "cadillac", name: "Cadillac", short: "CAD",
    /* LEFT WHITE, RIGHT BLACK. bodySplit "lr" paints the car's left (x < 0,
       measured: js/car/liverytex.js flank frames) in `color`, so white is
       primary: "its left side will be a grayish white, while its right flank
       will be black" (Motorsport.com, 9 Feb 2026) and "the left-hand side ...
       will be white, while the right side will be black" (Crash.net, same
       day); the team's own left-side launch photo agrees. The swap is the
       whole fix — it was mirrored. Chrome halo (Robb Report) and a louvred
       cover (Motorsport.tech) complete the conventional-downwash car.
       GRAYISH white, as reported — and it is load-bearing: the gold crest
       must clear 4.2:1 on the dimmed body in the dark garage, which pure
       white (3.80) does not; logo3 rims it on the bright cover (2.16 bare). */
    livery: { finShape: "none", spineHeight: "dorsal", spineLogo: "saddle", spineSide: "plate",
              bodySplit: "lr", halo: [0.86, 0.88, 0.92], coverVents: "gills", logo3: [0.06, 0.06, 0.08] },
    color: [0.84, 0.85, 0.86], color2: [0.039, 0.039, 0.039],    /* grayish white #D6D9DB (left) / black #0A0A0A (right) */
    engine: "Ferrari", tier: 4,
    stats: { speed: 73, accel: 73, cornering: 73, braking: 72 },
    drivers: [
      { name: "Sergio Perez", code: "PER", num: 11 },
      { name: "Valtteri Bottas", code: "BOT", num: 77 }
    ]
  }
];

/* Top 10 race points, 2026: no fastest-lap point. */
const POINTS: readonly number[] = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

/* The pace ladder the `tier` field above indexes: ground-speed scale per
   tier, 0 fastest .. 4 slowest. game.js folds it with the career development
   multiplier into each AI car's tierV.

   Calibrated to the FASTEST era (all twenty cars inside one second in 2023
   Brazilian qualifying, ~1.4% of a lap): ~0.26% a step, 1.05% across the
   field, ~1.5% with the driver span — a [1.0 .. 0.942] ladder puts the
   field 8.64% apart, five times any real season. Compressed about the
   MEASURED FIELD MEAN (0.9631), not the table mean, so average pace is
   unchanged to the digit and the DIFF ladder in js/physics/consts.js still
   means what it is calibrated to; the tier ladder stays ~2x the driver span.
   Evidence: docs/notes/AI-FIELD-RESEARCH.md. */
const TIER_V: readonly number[] = [0.9695, 0.9674, 0.9648, 0.9622, 0.9594];

/* Is this one of the eleven REAL constructors?
   Teams.LIST is appended to at boot: custom-team.js splices in the MY TEAM
   record (`custom: true`) and then pushes the twelve-driver LEGENDS entry
   (`legends: true`, js/data/legends.js). Both are grid furniture for one
   screen, not championship entrants — so every rule that walks the field
   (standings, the driver market, contract offers, winter development, a
   lobby seat move, the menu car warm-up) has to exclude them.
   Filtering on `custom` ALONE, which is what the career rules did, admitted
   Legends everywhere: a driver career at Haas opened with twelve legends in
   its own standings. One predicate so the next append is excluded by
   default rather than by remembering. */
const isReal = (t: { custom?: boolean; legends?: boolean } | null | undefined): boolean => !!t && !t.custom && !t.legends;

/* The MY TEAM custom entry — same record shape as LIST, the seed a fresh
   apex26.customTeam save starts from (game.js loadCustomTeam). */
const DEFAULT_CUSTOM: Team & { livery: TeamLivery } = {
  id: "custom", name: "My Team", short: "YOU", engine: "Custom", tier: 2, custom: true,
  livery: { finShape: "none", spineHeight: "dorsal", spineLogo: "number", spineSide: "number" },
  color: [0.13, 0.79, 0.85], color2: [0.96, 0.86, 0.0],
  stats: { speed: 84, accel: 82, cornering: 83, braking: 81 },
  drivers: [{ name: "Your Name", code: "YOU", num: 99 }],
};

/* A STORED OR IMPORTED CUSTOM TEAM IS PLAYER INPUT. The customize dialog
   caps every field as it is typed (custom-team.js `clean()`), but a garage
   file (js/ui/settings-export.js) or a hand-edited localStorage reaches
   Teams.LIST without passing that dialog — and the names are painted into
   chips, the HUD and the results table. aria-state.js paintOnOff once wrote
   one back through innerHTML (stored XSS, 2026-09-24); this is the defence
   in depth behind that fix: every field is rebuilt to the dialog's own
   limits at LOAD, whatever wrote it. REPAIR, NOT DISCARD — a bad field falls
   back to its default and the player's other fields survive. Always a fresh
   record with exactly the keys the dialog writes; `id`/`custom` are forced,
   because syncCustomTeam() splices on id === "custom". */
const CUSTOM_MAX_DRIVERS = 2;   // a team's seat count; the dialog writes one
// C0/C1 controls, and the bidi overrides/isolates that reorder a label.
const CTRL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
function cleanText(v: unknown, fb: string, n: number, upper: boolean): string {
  if (typeof v !== "string") return fb;
  let s = v.replace(CTRL, "").trim().slice(0, n).trim();
  if (upper) s = s.toUpperCase();
  return s || fb;
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
function cleanRgb(v: unknown, fb: Rgb): Rgb {
  if (!Array.isArray(v) || v.length < 3 || !(v as unknown[]).slice(0, 3).every(fin)) return fb.slice() as Rgb;
  return (v as number[]).slice(0, 3).map((x) => Math.min(1, Math.max(0, x))) as Rgb;
}
function cleanDriver(d: unknown, fb: Driver): Driver {
  const num = isObj(d) && fin(d["num"]) ? Math.round(d["num"]) : fb.num;
  return {
    name: cleanText(isObj(d) ? d["name"] : null, fb.name, 22, false),
    code: cleanText(isObj(d) ? d["code"] : null, fb.code, 3, true),
    num: Math.min(99, Math.max(0, num)),
  };
}
// Enum-typed livery fields index plain tables (Car3D finOf / FINISH_SURFACE, LiveryTex NUM_FONTS), so
// a kept "constructor" resolves to an inherited function and throws in every build. The three the garage
// offers as pills must be a real id when those tables are loaded (they load after this file; call time);
// any other string is refused only when it names an Object.prototype member.
// apex-26: the tables arrive as `deps`; an absent one is f1-game's `typeof X === "undefined"`.
function liveryEnumOk(k: string, v: unknown, deps?: LiveryEnumDeps): boolean {
  if (typeof v !== "string" || v in Object.prototype) return false;
  const Car3D = deps?.Car3D, LiveryTex = deps?.LiveryTex;
  const ids = k === "finShape" ? (Car3D !== undefined && Car3D.FIN_SHAPE_IDS)
    : k === "numFont" ? (LiveryTex !== undefined && LiveryTex.NUM_FONT_IDS)
    : k === "finish" ? (Car3D !== undefined && Car3D.FINISH_SURFACE && ["gloss"].concat(Object.keys(Car3D.FINISH_SURFACE)))
    : null;
  return !ids || ids.indexOf(v) >= 0;
}
function sanitizeCustom(t: unknown, deps?: LiveryEnumDeps): Team {
  const D = DEFAULT_CUSTOM;
  const src: Record<string, unknown> = isObj(t) ? t : {};
  const rows = Array.isArray(src["drivers"]) ? (src["drivers"] as unknown[]).filter(isObj).slice(0, CUSTOM_MAX_DRIVERS) : [];
  const srcStats = src["stats"];
  const stats = {} as TeamStats;
  for (const k of Object.keys(D.stats) as (keyof TeamStats)[]) {
    const sv = isObj(srcStats) ? srcStats[k] : undefined;
    stats[k] = isObj(srcStats) && fin(sv) ? Math.min(100, Math.max(0, sv)) : D.stats[k];
  }
  // Livery values are ids (strings) and rgb triples; nothing nested.
  // apex-26: keys are copied as found, not filtered to the TeamLivery fields.
  const livery: Record<string, string | Rgb> = {};
  const srcLivery = src["livery"];
  for (const [k, v] of Object.entries(isObj(srcLivery) ? srcLivery : D.livery)) {
    if (k === "__proto__") continue;
    if (typeof v === "string") { const s = cleanText(v, "", 32, false); if (s && liveryEnumOk(k, s, deps)) livery[k] = s; }
    else if (Array.isArray(v) && v.length === 3 && (v as unknown[]).every(fin)) livery[k] = cleanRgb(v, [0, 0, 0]);
  }
  const tier = src["tier"];
  return {
    id: "custom", custom: true,
    name: cleanText(src["name"], D.name, 22, false),
    short: cleanText(src["short"], D.short, 4, true),
    engine: cleanText(src["engine"], D.engine, 16, false),
    tier: typeof tier === "number" && Number.isInteger(tier) && tier >= 0 && tier <= 4 ? tier : D.tier,
    color: cleanRgb(src["color"], D.color),
    color2: cleanRgb(src["color2"], D.color2),
    stats,
    livery: livery as TeamLivery,
    drivers: rows.length ? rows.map((d) => cleanDriver(d, D.drivers[0] as Driver)) : D.drivers.map((d) => cleanDriver(d, d)),
  };
}

export { LIST, POINTS, TIER_V, DEFAULT_CUSTOM, isReal, sanitizeCustom, liveryEnumOk };

/** The f1-game `Teams` global's members, frozen as it was (js/data/teams.js:386-388).
 *  Like f1-game, only the record is frozen: LIST is appended to at boot. */
export const Teams = Object.freeze({ LIST, POINTS, TIER_V, DEFAULT_CUSTOM, isReal, sanitizeCustom, liveryEnumOk });
