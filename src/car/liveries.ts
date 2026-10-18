/* apex-26 port of f1-game js/car/liveries.js:1-552 (the `Liveries` IIFE global),
   verbatim: UNIVERSAL js/car/liveries.js:126-221, BY_TEAM :222-494, FIELDS
   :496-512, migratePaint :514-533, forTeam :535-548, the frozen record :550-552.
   The f1-game file's own header (js/car/liveries.js:2-124) follows unchanged.

   Deviation: forTeam read the Legends global behind a `typeof` guard
   (js/car/liveries.js:541-546); here it is the optional `deps.Legends`
   (LiveriesDeps), and an absent one takes the typeof-undefined branch. */

/* Apex 26 — custom paint jobs (liveries).
   Each livery: { id, name, c1:[r,g,b] primary bodywork, c2:[r,g,b] accent/stripe,
   stripe?:[r,g,b] optional bold centreline BODY stripe — runs the car's full
     spine continuously (nose tip → monocoque → hood → airbox → engine-cover
     ridge), broken only by the open cockpit,
   noseStripe?:[r,g,b] optional NOSE stripe — a classic band down the nose crown
     only (very tip → bulkhead). Independent of `stripe`; layers on top of it,
   accent?:[r,g,b] optional TERTIARY paint colour — a distinct third colour used to
     pick out secondary accent parts (sidepod flash, halo trim, nose flash,
     engine-cover pinstripe) SEPARATELY from the main accent c2. When absent the
     car falls back to c2 for those parts, so it is fully optional and additive.
   nose?:[r,g,b] optional painted NOSE-TIP cap — a distinct-colour nose cone.
   pod?:[r,g,b]  optional bold SIDEPOD panel — the two-tone sidepod look.
   wing?:[r,g,b] optional FRONT+REAR WING flap colour (defaults to c2 = today's look).
   logo?:[r,g,b] optional TEAM CREST colour — the mark itself, wherever it is
     drawn (engine cover + shark fin). Distinct from finArt: one is the emblem,
     the other the paint job behind it. Absent = the automatic contrast ink.
   fin?:[r,g,b]  optional SHARK-FIN paint — the dorsal tail plate every
     non-cockpit car carries (defaults to c2 = today's look).
   finArt?:[r,g,b] optional TAIL-GRAPHIC colour on that fin — the accent wash and
     the motif strokes of the painted tail. When absent it is chosen automatically
     to separate from the fin's own paint (the fin is one flat colour, so an art
     colour equal to it is invisible), which is what every livery got before.
   finStyle? optional TAIL STYLE — which motif the tail graphic draws, on the
     fin AND the engine-cover wash: "team" (absent; the per-team motif in
     LiveryTex.TAIL_STYLE), "diag" | "sweep" | "chevron" | "streak" | "check"
     to borrow another, or "none" for plain paint.
   finBadge? optional FIN BADGE — what the shark fin carries: "logo" (absent;
     the team crest), "number" (the race number, the real-F1 layout), "code"
     (the driver's three-letter abbreviation) or "none".
   tcam? optional T-CAM housing colour: "team" (absent; the accent housing),
     "auto" (the real rule — car 1 black, car 2 yellow, read off the driver
     slot), "black" or "yellow". Mesh colour, not paint (Car3D.TCAM_IDS).
   coverVents? optional COVER VENTS: "none" (absent), "gills" (rows of cooling
     slits on the engine-cover flanks) or "spine" (one slot along the ridge).
     Geometry — the second livery field besides finShape that moves a vertex.
   spineHeight? optional SPINE HEIGHT: "standard" (absent), "raised", "high"
     or "dorsal" lift the engine-cover crown behind the roll hoop, tapering to
     the tail — the fin-less 2026 look; "dorsal" runs level with the hoop.
     Geometry (Car3D.SPINE_HEIGHT_IDS); the fin's top stays at the regulation
     line, so a taller spine shortens the blade.
   spineSide? optional SPINE SIDE: "none" (absent) or an id in
     LiveryTex.SPINE_SIDE_IDS — number, logo, code, plate, wordmark, duo,
     ribbon, lockup, title (sponsor on a board), emblem (large bare crest),
     band (crease colour strip), sash (wide diagonal), slash (one bold
     diagonal stroke), rake (hard diagonal cut), shoulder (upper-third shelf),
     starfield (micro dot field). The fills take `sideTint`.
     Paints the engine-cover FLANK, both sides (car-mesh's band).
     Each flank is its own atlas region (spineSide right, spineSideL left),
     authored in that side's outside-view frame, so text reads and a graphic
     faces forward on BOTH sides.
     The grey service panels and the accent pinstripe keep clear of the band,
     so it also moves a vertex.
   spineTint? optional SPINE TINT — the colour of whatever SPINE TOP paints on
     the crown (and the saddle's flank half). Absent = secondary then primary
     against the ENGINE COVER (never BODY STRIPE / DETAIL). An explicit pick is
     honoured as-is — it is a deliberate choice about one surface, like `cover`.
   sideTint? optional SIDE TINT — the colour of every SPINE SIDE FILL on the
     cover flank (band, sash, ribbon strip, slash, rake, shoulder, starfield
     dots), as picked. Its own zone: spineTint paints the flank UNDER these when
     the crown design is a saddle. Absent = bases against the flank; rake and
     shoulder borrow saddleTint first when it clears.
   sunTint? optional SUN — the wrap's sun disc over the crown, the cover flanks
     and (Car3D) the airbox and roll hoop. Its own row because SPINE TINT used
     to paint it: one field meant a BAND on most SPINE TOP designs and the SUN
     on `wrap`. Unset = mark plate / secondary / primary against the cover —
     never inherits spineTint.
   bandTint2? optional 2ND BAND — the tricolour's second band. The design draws
     two bands with body paint between them, and only one of them was ever
     choosable; the other was derived and could land on its neighbour (four
     teams wore a "tricolour" of one colour repeated). Absent = derived, and
     re-picked against both the cover and the first band.
   plateTint? optional PLATE PANEL — the contrasting board SPINE SIDE "plate"
     and "title" paint on. Absent = SECONDARY or DETAIL, re-picked against the
     flank — never BODY STRIPE. Board lettering auto-inks.
   saddleTint? optional SADDLE — the shoulder shelf and upper-flank saddle block
     (atlas: crest shoulders + saddleFlanks). An explicit pick is honoured as-is.
     Absent = today's bandC path under saddle or saddleWrap; else derived flank fill.
   Lettering auto-inks (no crestInk / plateInk). Ridge uses BAND (`spineTint`);
   airbox mesh uses COVER (or SUN under WRAP). Dead keys ridgeTint / airboxTint /
   crestInk / plateInk are stripped by Liveries.migratePaint on load.
   coverBind? optional COVER BIND — how crown and flank zones couple:
     "independent" (absent), "saddleWrap" (saddle block spans crown shoulders and
     upper flanks), or "spineOnly" (crown/ridge accent only; shoulders stay cover).
   finHandoff? optional FIN HANDOFF — how the fin meets the cover block:
     "match" (absent), "contrast" (when fin unset, derive against crown/saddle
     block; authored fin always wins), or "hardCut" (fin ignores crown graphic
     continuation at the fin root).
   spineLogo? optional SPINE TOP — what the engine-cover crown carries on bare
     body colour (no gradient wash under any design — hard edges only).
     "logo" (absent) draws the crest there as well as on the fin; "none" leaves
     the crown bare so the mark reads once from a chase camera instead of twice;
     "wrap" (the mark's plate colour as a sun over the crown AND down both
     flanks, the plate-less mark on top — the RB22's sun and bull); "bigmark"
     (the mark without its plate at full crown width — the RB22's bull with no
     sun disc); "saddle" (the whole crown in the band colour and down the flanks
     with a raked rear edge, the SF-26's white top), "panel" (a solid accent
     block with a raked front edge), "stripe", "twin", "wordmark" (the title
     sponsor running along the spine), "carbon" (an exposed panel) and
     "number" are the crown designs that carry no mark (LiveryTex.SPINE_LOGO_IDS).
     The band designs run on down the tail top (REGIONS.tail); the crest and
     the number read top-down, nose up (the chase camera's view).
   finShape? optional FIN SHAPE — the blade's outline: "standard" (absent),
     "swept" (raked leading edge), "stub" (short rear blade) or "none" (no fin;
     the fin's graphic and badge go with it). Geometry, not paint — the one
     livery field besides the strips that moves a vertex (Car3D.FIN_SHAPES).
   halo?:[r,g,b] optional cockpit-HALO hoop tint (defaults to brushed titanium).
     All four are additive and fully optional — a livery without them renders
     exactly as before.
   finish? optional paint FINISH — the material rather than the colour. Absent
     (or "gloss") is the clearcoat-and-flake car paint every livery has always
     had. The rest: "satin" a flat wrap, "chrome" a tinted mirror, "matte" a
     chalky flat with no clearcoat at all, "carbon" exposed weave, "brushed" a
     half-metal alloy sheen, and "pearl" an interference coat whose hue swings
     with view angle and settles back to the livery's own colour face-on.
     Car3D.build applies it by remapping the body-paint surface id (see
     Car3D.FINISH_SURFACE) — decals, carbon, rubber and glass are untouched, and
     it costs no extra geometry. Sponsor-board / wordmark crispness is atlas
     raster + mip policy in LiveryTex / car-draw, never a finish override
     (garage paint lives in #1025). }.
   UNIVERSAL apply to every team; BY_TEAM are team-specific specials. A team's own
   colours are the synthesized "default" livery. Consumed by game.js
   (resolveLivery + the LIVERY tab in car setup). Colours are [r,g,b] 0..1. */

/** An [r,g,b] colour, floats 0..1. */
export type Rgb = [number, number, number];

/** Optional paint rows that are colours (the header above documents each). */
export type LiveryRgbField =
  | "stripe" | "noseStripe" | "accent" | "nose" | "pod" | "wing" | "fin" | "finArt"
  | "logo" | "logo2" | "logo3" | "halo" | "cover"
  | "spineTint" | "sideTint" | "sunTint" | "bandTint2" | "plateTint" | "saddleTint"
  | "rearWing" | "lower" | "upper" | "patternTint" | "patternSecond"
  | "mirrorTint" | "rimTint" | "caliperTint" | "sidewallInk" | "helmetBase" | "helmetAccent";

/** Optional paint rows that are ids (enum strings). */
export type LiveryIdField =
  | "finish" | "numFont" | "sponsors" | "finStyle" | "finBadge" | "spineLogo" | "finShape"
  | "coverVents" | "spineHeight" | "spineSide" | "coverBind" | "finHandoff"
  | "wingCarbon" | "bodySplit" | "patternPlacement" | "patternSide"
  | "coverFinish" | "wingFinish" | "haloFinish" | "podFinish" | "finFinish" | "mirrorFinish" | "helmetStyle";

/** Optional pattern sliders (f1-game js/car/livery-design.js:8 ranges; the garage
 *  stores them as numbers or numeric strings). */
export type LiveryNumField =
  | "patternWidth" | "patternRepeat" | "patternOffset" | "patternTaper"
  | "patternOpacity" | "patternRotation" | "patternStretch" | "patternWeight";

/** T-CAM housing: a colour or an id such as auto (the garage writes either). */
export type LiveryTcamField = "tcam";

/** Every row FIELDS lists. */
export type LiveryField = LiveryRgbField | LiveryIdField | LiveryNumField | LiveryTcamField;

/** The optional paint rows a livery (or a team's `livery` block) may carry. */
export type LiveryPaint =
  & { [K in LiveryRgbField]?: Rgb }
  & { [K in LiveryIdField]?: string }
  & { [K in LiveryNumField]?: number | string }
  & { [K in LiveryTcamField]?: Rgb | string };

/** A team's own `livery` block (js/data/teams.js LIST[i].livery). */
export type TeamLivery = LiveryPaint;

/** One picker entry: { id, name, c1, c2 } plus optional paint rows. */
export type Livery = { id: string; name: string; c1: Rgb; c2: Rgb } & LiveryPaint;

/** The dead keys migratePaint folds or drops (js/car/liveries.js:514-533). */
export interface RetiredPaint {
  ridgeTint?: Rgb;
  airboxTint?: Rgb;
  crestInk?: Rgb;
  plateInk?: Rgb;
}

/** What forTeam reads off a team (js/car/liveries.js:535-548). */
export interface LiveryTeam {
  id: string;
  color: Rgb;
  color2: Rgb;
  livery?: TeamLivery;
}

/** Out-of-scope globals forTeam consults when present. */
export interface LiveriesDeps {
  /** js/data/legends.js Legends.liveries(): the legend tribute paint jobs. */
  Legends?: { liveries?: () => Livery[] };
}

// Available to every team.
const UNIVERSAL: Livery[] = [
  { id: "stealth",  name: "Stealth",    c1: [0.055, 0.055, 0.065], c2: [0.62, 0.64, 0.70], accent: [0.30, 0.52, 0.82] },
  { id: "chrome",   name: "Chrome",     c1: [0.82, 0.85, 0.90],    c2: [0.13, 0.13, 0.16] },
  { id: "gold",     name: "Gold Rush",  c1: [0.84, 0.65, 0.15],    c2: [0.06, 0.06, 0.07], accent: [0.96, 0.90, 0.62] },
  { id: "carbon",   name: "Carbon Red", c1: [0.10, 0.10, 0.12],    c2: [0.90, 0.10, 0.08], stripe: [0.95, 0.15, 0.10], accent: [0.92, 0.93, 0.96] },
  { id: "ice",      name: "Ice",        c1: [0.90, 0.93, 0.97],    c2: [0.05, 0.40, 0.90], accent: [0.60, 0.80, 0.95] },
  { id: "viper",    name: "Viper",      c1: [0.05, 0.06, 0.07],    c2: [0.30, 0.95, 0.25], stripe: [0.35, 1.0, 0.30], accent: [0.92, 0.94, 0.96] },
  { id: "sunset",   name: "Sunset",     c1: [0.98, 0.42, 0.06],    c2: [0.55, 0.10, 0.45], accent: [1.0, 0.82, 0.22] },
  { id: "military", name: "Military",   c1: [0.28, 0.30, 0.20],    c2: [0.95, 0.55, 0.10], accent: [0.80, 0.74, 0.52] },
  { id: "camo",     name: "Camo",       c1: [0.24, 0.28, 0.19],    c2: [0.46, 0.42, 0.30], accent: [0.86, 0.44, 0.12] },
  { id: "midnight", name: "Midnight",   c1: [0.04, 0.05, 0.12],    c2: [0.30, 0.45, 0.85], stripe: [0.55, 0.75, 1.0], accent: [0.80, 0.84, 0.92] },
  { id: "flame",    name: "Flame",      c1: [0.08, 0.07, 0.07],    c2: [0.98, 0.35, 0.03], stripe: [0.98, 0.72, 0.10], accent: [0.95, 0.96, 0.98] },
  // Stripe-forward graphic schemes — the bold centreline spine is the point.
  { id: "arrowhead", name: "Arrowhead", c1: [0.09, 0.09, 0.11],    c2: [1.0, 0.85, 0.0],   stripe: [1.0, 0.90, 0.06], accent: [0.94, 0.95, 0.98] },
  { id: "splitshot", name: "Split Shot", c1: [0.80, 0.08, 0.12],   c2: [0.05, 0.09, 0.26],  stripe: [0.95, 0.96, 0.98], accent: [0.96, 0.82, 0.14] },
  { id: "candyflip", name: "Candy Flip", c1: [0.86, 0.10, 0.55],   c2: [0.34, 0.09, 0.70],  stripe: [0.12, 0.86, 0.92], accent: [1.0, 0.90, 0.20] },
  { id: "lemans",    name: "Le Mans Hoops", c1: [0.05, 0.20, 0.72], c2: [0.95, 0.96, 0.98], stripe: [0.98, 0.55, 0.05], accent: [0.35, 0.60, 0.95] },
  { id: "twinbolt",  name: "Twin Bolt",  c1: [0.93, 0.94, 0.96],   c2: [0.05, 0.05, 0.07],  stripe: [0.90, 0.10, 0.12], accent: [0.10, 0.45, 0.85] },
  { id: "slipstream", name: "Slipstream", c1: [0.04, 0.20, 0.22],  c2: [1.0, 0.45, 0.0],    stripe: [1.0, 0.60, 0.05], accent: [0.90, 0.94, 0.95] },
  { id: "torch",     name: "Torch",      c1: [0.10, 0.04, 0.10],   c2: [0.98, 0.24, 0.42],  stripe: [1.0, 0.74, 0.16], accent: [0.95, 0.95, 0.97] },
  // Three-colour showcases — c1 body, c2 accent, bold stripe, distinct tertiary accent.
  { id: "tricircuit", name: "Tri-Circuit", c1: [0.06, 0.07, 0.10], c2: [0.0, 0.72, 0.86], stripe: [0.98, 0.96, 0.94], accent: [1.0, 0.42, 0.08] },
  { id: "prism",      name: "Prism",       c1: [0.10, 0.06, 0.20], c2: [0.95, 0.20, 0.55], stripe: [0.20, 0.80, 0.95], accent: [1.0, 0.86, 0.20] },
  { id: "tricolora",  name: "Tricolora",   c1: [0.95, 0.96, 0.98], c2: [0.90, 0.10, 0.14], stripe: [0.06, 0.55, 0.30], accent: [0.10, 0.30, 0.80] },
  // Detail showcases — exercise the optional nose / pod / wing / halo fields.
  { id: "apexworks", name: "Apex Works",  c1: [0.05, 0.06, 0.09], c2: [0.98, 0.62, 0.02], stripe: [1.0, 0.72, 0.10], accent: [0.0, 0.66, 0.90],
    nose: [0.98, 0.62, 0.02], pod: [0.0, 0.66, 0.90], wing: [0.98, 0.62, 0.02], halo: [0.90, 0.78, 0.30] },
  { id: "duotone",   name: "Duo-Tone",    c1: [0.90, 0.92, 0.95], c2: [0.06, 0.20, 0.55], stripe: [0.90, 0.14, 0.18], accent: [0.90, 0.14, 0.18],
    nose: [0.06, 0.20, 0.55], pod: [0.90, 0.14, 0.18], wing: [0.06, 0.20, 0.55], noseStripe: [0.90, 0.92, 0.95] },
  { id: "speararrow", name: "Spear",      c1: [0.93, 0.94, 0.96], c2: [0.06, 0.06, 0.08], accent: [0.90, 0.14, 0.18],
    noseStripe: [0.90, 0.14, 0.18], nose: [0.06, 0.06, 0.08] },
  { id: "neonpod",   name: "Neon Pod",    c1: [0.05, 0.05, 0.07], c2: [0.10, 0.90, 0.55], stripe: [0.12, 1.0, 0.60], accent: [0.95, 0.20, 0.60],
    pod: [0.95, 0.20, 0.60], wing: [0.10, 0.90, 0.55], halo: [0.10, 0.90, 0.55] },
  { id: "goldcrest", name: "Gold Crest",  c1: [0.04, 0.05, 0.08], c2: [0.85, 0.68, 0.28], stripe: [0.96, 0.86, 0.48], accent: [0.96, 0.86, 0.48],
    nose: [0.85, 0.68, 0.28], halo: [0.85, 0.68, 0.28], wing: [0.85, 0.68, 0.28] },
  // Gloss schemes — colour only, the classic clearcoat finish.
  { id: "redline",   name: "Redline",     c1: [0.10, 0.10, 0.12], c2: [0.88, 0.09, 0.12], stripe: [0.95, 0.13, 0.16], accent: [0.92, 0.93, 0.96],
    wing: [0.88, 0.09, 0.12], halo: [0.88, 0.09, 0.12] },
  { id: "oceanic",   name: "Oceanic",     c1: [0.02, 0.24, 0.32], c2: [0.10, 0.82, 0.78], stripe: [0.85, 0.96, 0.98], accent: [0.05, 0.55, 0.62],
    pod: [0.05, 0.55, 0.62], nose: [0.10, 0.82, 0.78] },
  { id: "magma",     name: "Magma",       c1: [0.09, 0.05, 0.05], c2: [0.98, 0.30, 0.05], stripe: [1.0, 0.62, 0.08], accent: [0.85, 0.12, 0.05],
    noseStripe: [1.0, 0.82, 0.20], wing: [0.98, 0.30, 0.05] },
  { id: "royal",     name: "Royal",       c1: [0.16, 0.06, 0.36], c2: [0.86, 0.72, 0.30], stripe: [0.96, 0.88, 0.55], accent: [0.55, 0.32, 0.85],
    nose: [0.86, 0.72, 0.30], halo: [0.86, 0.72, 0.30] },
  { id: "pastel",    name: "Pastel Drift", c1: [0.96, 0.80, 0.86], c2: [0.55, 0.88, 0.82], stripe: [0.98, 0.94, 0.62], accent: [0.42, 0.44, 0.62],
    pod: [0.55, 0.88, 0.82], wing: [0.96, 0.80, 0.86] },
  { id: "hazard",    name: "Hazard",      c1: [0.98, 0.78, 0.06], c2: [0.07, 0.07, 0.08], stripe: [0.07, 0.07, 0.08], accent: [0.96, 0.96, 0.98],
    nose: [0.07, 0.07, 0.08], pod: [0.07, 0.07, 0.08], wing: [0.98, 0.78, 0.06] },
  // Botanical / mineral / earth palettes — the hues the set above never reaches
  // (blossom, moss, clay, sky-grey, acid, mosaic tile).
  { id: "sakura",    name: "Sakura",      c1: [0.22, 0.06, 0.16], c2: [0.98, 0.66, 0.76], stripe: [0.95, 0.86, 0.90], accent: [0.86, 0.72, 0.34],
    nose: [0.98, 0.66, 0.76], pod: [0.34, 0.10, 0.24], halo: [0.86, 0.72, 0.34] },
  { id: "emerald",   name: "Emerald Cut", c1: [0.02, 0.46, 0.26], c2: [0.94, 0.95, 0.96], stripe: [0.88, 0.74, 0.28], accent: [0.05, 0.16, 0.12],
    nose: [0.88, 0.74, 0.28], wing: [0.02, 0.34, 0.20], noseStripe: [0.94, 0.95, 0.96] },
  { id: "aurora",    name: "Aurora",      c1: [0.03, 0.06, 0.16], c2: [0.20, 0.92, 0.62], stripe: [0.62, 0.36, 0.94], accent: [0.10, 0.70, 0.88],
    pod: [0.62, 0.36, 0.94], halo: [0.20, 0.92, 0.62] },
  { id: "terracotta", name: "Terracotta", c1: [0.72, 0.34, 0.22], c2: [0.10, 0.22, 0.24], stripe: [0.94, 0.88, 0.76], accent: [0.30, 0.52, 0.48],
    nose: [0.10, 0.22, 0.24], pod: [0.94, 0.88, 0.76], wing: [0.30, 0.52, 0.48] },
  { id: "jetstream", name: "Jetstream",   c1: [0.72, 0.78, 0.84], c2: [0.92, 0.34, 0.06], stripe: [0.04, 0.12, 0.28], accent: [0.98, 0.72, 0.18],
    nose: [0.04, 0.12, 0.28], wing: [0.92, 0.34, 0.06], noseStripe: [0.92, 0.34, 0.06] },
  { id: "acidrain",  name: "Acid Rain",   c1: [0.62, 0.90, 0.08], c2: [0.08, 0.09, 0.10], stripe: [0.18, 0.20, 0.22], accent: [0.0, 0.55, 0.85],
    pod: [0.08, 0.09, 0.10], halo: [0.0, 0.55, 0.85] },
  { id: "mosaic",    name: "Mosaic",      c1: [0.06, 0.30, 0.52], c2: [0.98, 0.72, 0.12], stripe: [0.90, 0.24, 0.34], accent: [0.10, 0.72, 0.58],
    nose: [0.90, 0.24, 0.34], pod: [0.10, 0.72, 0.58], wing: [0.98, 0.72, 0.12] },
  { id: "moonshot",  name: "Moonshot",    c1: [0.88, 0.86, 0.80], c2: [0.98, 0.42, 0.06], stripe: [0.06, 0.07, 0.10], accent: [0.75, 0.20, 0.16],
    nose: [0.06, 0.07, 0.10], halo: [0.98, 0.55, 0.08], noseStripe: [0.75, 0.20, 0.16] },
  { id: "satinnight", name: "Satin Night", c1: [0.07, 0.07, 0.09], c2: [0.62, 0.10, 0.14], stripe: [0.80, 0.14, 0.18], accent: [0.55, 0.57, 0.62],
    halo: [0.62, 0.10, 0.14], finish: "satin" },
  { id: "mattelime", name: "Matte Lime",  c1: [0.20, 0.24, 0.10], c2: [0.72, 0.92, 0.14], stripe: [0.80, 0.98, 0.24], accent: [0.10, 0.11, 0.12],
    wing: [0.72, 0.92, 0.14], finish: "satin" },
  { id: "frostbite", name: "Frostbite",   c1: [0.88, 0.92, 0.95], c2: [0.28, 0.58, 0.82], stripe: [0.16, 0.34, 0.60], accent: [0.55, 0.78, 0.92],
    nose: [0.28, 0.58, 0.82], noseStripe: [0.88, 0.92, 0.95], finish: "satin" },
  { id: "monochrome", name: "Monochrome", c1: [0.42, 0.43, 0.46], c2: [0.93, 0.94, 0.96], stripe: [0.08, 0.08, 0.09], accent: [0.68, 0.70, 0.74],
    pod: [0.08, 0.08, 0.09], wing: [0.93, 0.94, 0.96], finish: "satin" },
  { id: "dune",      name: "Desert Dune", c1: [0.86, 0.74, 0.50], c2: [0.55, 0.24, 0.10], stripe: [0.36, 0.16, 0.08], accent: [0.10, 0.62, 0.60],
    pod: [0.55, 0.24, 0.10], halo: [0.10, 0.62, 0.60], finish: "satin" },
  { id: "mintjulep", name: "Mint Julep",  c1: [0.72, 0.92, 0.82], c2: [0.28, 0.16, 0.10], stripe: [0.94, 0.80, 0.32], accent: [0.16, 0.44, 0.36],
    nose: [0.28, 0.16, 0.10], wing: [0.16, 0.44, 0.36], finish: "satin" },
  { id: "espresso",  name: "Espresso",    c1: [0.18, 0.11, 0.08], c2: [0.92, 0.72, 0.34], stripe: [0.62, 0.40, 0.20], accent: [0.85, 0.90, 0.92],
    pod: [0.92, 0.72, 0.34], halo: [0.92, 0.72, 0.34], finish: "satin" },
  { id: "tundra",    name: "Tundra",      c1: [0.66, 0.70, 0.68], c2: [0.86, 0.30, 0.10], stripe: [0.10, 0.14, 0.16], accent: [0.40, 0.46, 0.44],
    nose: [0.86, 0.30, 0.10], wing: [0.10, 0.14, 0.16], noseStripe: [0.10, 0.14, 0.16], finish: "satin" },
  { id: "mirrorlake", name: "Mirror Lake", c1: [0.80, 0.86, 0.92], c2: [0.06, 0.28, 0.52], stripe: [0.12, 0.52, 0.82], accent: [0.90, 0.94, 0.98],
    wing: [0.06, 0.28, 0.52], finish: "chrome" },
  { id: "copperhead", name: "Copperhead", c1: [0.72, 0.40, 0.18], c2: [0.10, 0.09, 0.10], stripe: [0.92, 0.62, 0.30], accent: [0.94, 0.78, 0.46],
    nose: [0.10, 0.09, 0.10], halo: [0.92, 0.62, 0.30], finish: "chrome" },
  { id: "bronzeage", name: "Bronze Age",  c1: [0.55, 0.42, 0.20], c2: [0.90, 0.80, 0.52], stripe: [0.30, 0.24, 0.14], accent: [0.96, 0.90, 0.70],
    pod: [0.30, 0.24, 0.14], wing: [0.90, 0.80, 0.52], finish: "chrome" },
  { id: "graphite",  name: "Graphite Mirror", c1: [0.34, 0.36, 0.40], c2: [0.98, 0.42, 0.10], stripe: [0.08, 0.08, 0.10], accent: [0.86, 0.88, 0.92],
    nose: [0.98, 0.42, 0.10], wing: [0.08, 0.08, 0.10], finish: "chrome" },
  { id: "steelrose", name: "Steel Rose",  c1: [0.86, 0.62, 0.58], c2: [0.14, 0.14, 0.18], stripe: [0.96, 0.86, 0.82], accent: [0.42, 0.20, 0.26],
    pod: [0.14, 0.14, 0.18], halo: [0.96, 0.86, 0.82], finish: "chrome" },
  { id: "pewter",    name: "Pewter",      c1: [0.58, 0.60, 0.64], c2: [0.30, 0.06, 0.10], stripe: [0.90, 0.86, 0.78], accent: [0.16, 0.17, 0.20],
    nose: [0.30, 0.06, 0.10], wing: [0.30, 0.06, 0.10], noseStripe: [0.90, 0.86, 0.78], finish: "chrome" },
];
// Per-team heritage / concept schemes.
// DISPLAY NAMES CARRY NO REAL SPONSOR BRAND (2026-10-03): a few ids still
// spell one (mer_petronas, mcl_gulf, wil_rothmans …) because ids live in
// saved garages — rename the `name`, never the `id`.
const BY_TEAM: Readonly<Record<string, Livery[]>> = {
  mercedes: [
    { id: "mer_black",  name: "Black Arrow",  c1: [0.03, 0.03, 0.04], c2: [0.0, 0.63, 0.61], stripe: [0.0, 0.78, 0.73], accent: [0.72, 0.74, 0.78] },
    { id: "mer_silver", name: "Silver Arrow", c1: [0.80, 0.83, 0.86], c2: [0.0, 0.63, 0.61], stripe: [0.04, 0.04, 0.05], accent: [0.0, 0.78, 0.73] },
    { id: "mer_petronas", name: "Deep Teal",  c1: [0.0, 0.28, 0.28], c2: [0.0, 0.63, 0.61], stripe: [0.78, 0.82, 0.85], accent: [0.0, 0.86, 0.78] },
    { id: "mer_star",   name: "Retro Star",   c1: [0.78, 0.81, 0.84], c2: [0.05, 0.06, 0.07], stripe: [0.0, 0.63, 0.61] },
    { id: "mer_amg",    name: "AMG Night",    c1: [0.07, 0.08, 0.10], c2: [0.0, 0.63, 0.61], stripe: [0.62, 0.64, 0.68], accent: [0.86, 0.14, 0.14] },
    { id: "mer_ink",    name: "Teal Ink",     c1: [0.03, 0.03, 0.04], c2: [0.0, 0.70, 0.67], accent: [0.78, 0.81, 0.85],
      nose: [0.0, 0.70, 0.67], pod: [0.0, 0.42, 0.42], wing: [0.03, 0.03, 0.04], halo: [0.0, 0.70, 0.67] },
    { id: "mer_w11",    name: "Street W11",   c1: [0.80, 0.83, 0.86], c2: [0.86, 0.14, 0.14], stripe: [0.0, 0.63, 0.61], accent: [0.05, 0.06, 0.07],
      nose: [0.05, 0.06, 0.07], wing: [0.86, 0.14, 0.14], noseStripe: [0.0, 0.63, 0.61] },
    { id: "mer_lumen",  name: "Lumen",        c1: [0.0, 0.20, 0.22], c2: [0.0, 0.86, 0.78], stripe: [0.90, 0.93, 0.95], accent: [0.62, 0.64, 0.68],
      pod: [0.0, 0.86, 0.78], halo: [0.90, 0.93, 0.95] },
    { id: "mer_satin",  name: "Satin Arrow",  c1: [0.08, 0.09, 0.10], c2: [0.0, 0.63, 0.61], stripe: [0.0, 0.78, 0.73], accent: [0.72, 0.74, 0.78],
      wing: [0.0, 0.63, 0.61], finish: "satin" },
    { id: "mer_chrome", name: "Chrome Arrow", c1: [0.84, 0.87, 0.92], c2: [0.0, 0.63, 0.61], stripe: [0.05, 0.06, 0.07], accent: [0.0, 0.86, 0.78],
      nose: [0.0, 0.63, 0.61], halo: [0.0, 0.78, 0.73], finish: "chrome" },
    { id: "mer_dtm",    name: "DTM Tribute",  c1: [0.93, 0.94, 0.96], c2: [0.05, 0.06, 0.07], stripe: [0.0, 0.63, 0.61], accent: [0.86, 0.14, 0.14],
      pod: [0.05, 0.06, 0.07], wing: [0.05, 0.06, 0.07], noseStripe: [0.86, 0.14, 0.14] },
    { id: "mer_w196",   name: "Streamliner '54", c1: [0.74, 0.76, 0.79], c2: [0.10, 0.11, 0.12], accent: [0.86, 0.14, 0.14],
      nose: [0.10, 0.11, 0.12], pod: [0.62, 0.64, 0.68], halo: [0.86, 0.14, 0.14], finish: "satin" },
    { id: "mer_evo2",   name: "190E Evo II",  c1: [0.11, 0.12, 0.15], c2: [0.90, 0.92, 0.94], stripe: [0.0, 0.63, 0.61], accent: [0.86, 0.14, 0.14],
      pod: [0.90, 0.92, 0.94], wing: [0.0, 0.63, 0.61], noseStripe: [0.86, 0.14, 0.14] },
  ],
  ferrari: [
    { id: "fer_classic", name: "Classic 412T", c1: [0.86, 0.0, 0.0],   c2: [0.97, 0.83, 0.0], stripe: [0.98, 0.86, 0.0], accent: [0.06, 0.06, 0.08] },
    { id: "fer_white",   name: "Rosso Bianco", c1: [0.86, 0.0, 0.0],   c2: [0.97, 0.97, 0.97], stripe: [0.98, 0.98, 0.98], accent: [0.02, 0.16, 0.52] },
    { id: "fer_matte",   name: "Matte Nero",   c1: [0.06, 0.06, 0.07], c2: [0.86, 0.0, 0.0], accent: [0.90, 0.78, 0.10] },
    { id: "fer_giallo",  name: "Giallo Modena", c1: [0.97, 0.80, 0.0], c2: [0.86, 0.0, 0.0], stripe: [0.90, 0.0, 0.0], accent: [0.06, 0.06, 0.08] },
    { id: "fer_scud",    name: "Scuderia",     c1: [0.78, 0.0, 0.0],   c2: [0.05, 0.05, 0.06], stripe: [0.97, 0.83, 0.0], accent: [0.95, 0.95, 0.97] },
    { id: "fer_evo",     name: "Rosso Evo",    c1: [0.86, 0.0, 0.0],   c2: [0.05, 0.05, 0.06], accent: [0.97, 0.83, 0.0],
      nose: [0.05, 0.05, 0.06], pod: [0.97, 0.83, 0.0], wing: [0.05, 0.05, 0.06], halo: [0.86, 0.0, 0.0] },
    { id: "fer_monza",   name: "Monza Speciale", c1: [0.97, 0.96, 0.90], c2: [0.86, 0.0, 0.0], stripe: [0.86, 0.0, 0.0], accent: [0.06, 0.42, 0.24],
      nose: [0.86, 0.0, 0.0], wing: [0.97, 0.96, 0.90], noseStripe: [0.06, 0.42, 0.24] },
    { id: "fer_vinaccia", name: "Vinaccia",    c1: [0.36, 0.04, 0.10], c2: [0.97, 0.83, 0.0], stripe: [0.86, 0.0, 0.0], accent: [0.95, 0.95, 0.97],
      pod: [0.86, 0.0, 0.0], halo: [0.97, 0.83, 0.0] },
    { id: "fer_lauda",   name: "Niki '77",     c1: [0.86, 0.0, 0.0],   c2: [0.95, 0.95, 0.97], accent: [0.05, 0.05, 0.06],
      nose: [0.95, 0.95, 0.97], pod: [0.95, 0.95, 0.97], wing: [0.86, 0.0, 0.0], noseStripe: [0.05, 0.05, 0.06] },
    { id: "fer_satin",   name: "Rosso Satin",  c1: [0.62, 0.02, 0.02], c2: [0.97, 0.83, 0.0], stripe: [0.86, 0.0, 0.0], accent: [0.95, 0.95, 0.97],
      halo: [0.97, 0.83, 0.0], finish: "satin" },
    { id: "fer_cromo",   name: "Cromo Rosso",  c1: [0.88, 0.06, 0.05], c2: [0.06, 0.06, 0.08], stripe: [0.97, 0.83, 0.0], accent: [0.96, 0.90, 0.62],
      nose: [0.06, 0.06, 0.08], wing: [0.06, 0.06, 0.08], finish: "chrome" },
    { id: "fer_corsa",   name: "Nero Corsa",   c1: [0.09, 0.05, 0.06], c2: [0.86, 0.0, 0.0], stripe: [0.97, 0.83, 0.0], accent: [0.60, 0.02, 0.04],
      pod: [0.86, 0.0, 0.0], nose: [0.86, 0.0, 0.0], halo: [0.97, 0.83, 0.0] },
    { id: "fer_azzurro", name: "Azzurro La Plata", c1: [0.20, 0.62, 0.86], c2: [0.06, 0.06, 0.08], stripe: [0.95, 0.95, 0.97], accent: [0.86, 0.0, 0.0],
      nose: [0.86, 0.0, 0.0], wing: [0.06, 0.06, 0.08], halo: [0.95, 0.95, 0.97] },
    { id: "fer_notte",   name: "Blu Notte",    c1: [0.04, 0.08, 0.24], c2: [0.86, 0.0, 0.0], stripe: [0.97, 0.83, 0.0], accent: [0.90, 0.92, 0.96],
      pod: [0.86, 0.0, 0.0], halo: [0.97, 0.83, 0.0], noseStripe: [0.97, 0.83, 0.0] },
    { id: "fer_grigio",  name: "Grigio Silverstone", c1: [0.62, 0.64, 0.68], c2: [0.86, 0.0, 0.0], stripe: [0.06, 0.06, 0.08], accent: [0.97, 0.83, 0.0],
      nose: [0.86, 0.0, 0.0], wing: [0.06, 0.06, 0.08], finish: "chrome" },
  ],
  mclaren: [
    { id: "mcl_papaya",  name: "Papaya",        c1: [1.0, 0.50, 0.0],  c2: [0.10, 0.11, 0.13], stripe: [0.05, 0.05, 0.06], accent: [0.0, 0.62, 0.86] },
    { id: "mcl_stealth", name: "Stealth Papaya", c1: [0.09, 0.09, 0.10], c2: [1.0, 0.50, 0.0], stripe: [1.0, 0.55, 0.05], accent: [0.0, 0.62, 0.86] },
    { id: "mcl_chrome",  name: "Chrome Papaya", c1: [0.80, 0.82, 0.86], c2: [1.0, 0.50, 0.0], accent: [0.10, 0.11, 0.13] },
    { id: "mcl_rocket",  name: "Rocket Red",    c1: [0.90, 0.06, 0.05], c2: [1.0, 0.50, 0.0], stripe: [0.10, 0.10, 0.12], accent: [0.98, 0.90, 0.30] },
    { id: "mcl_gulf",    name: "Powder Blue",   c1: [0.42, 0.74, 0.88], c2: [0.98, 0.45, 0.02], stripe: [1.0, 0.50, 0.05], accent: [0.06, 0.16, 0.34] },
    { id: "mcl_works",   name: "Papaya Works",  c1: [1.0, 0.50, 0.0],   c2: [0.10, 0.11, 0.13], accent: [0.0, 0.62, 0.86],
      nose: [0.10, 0.11, 0.13], pod: [0.0, 0.62, 0.86], wing: [0.10, 0.11, 0.13], halo: [0.10, 0.11, 0.13] },
    { id: "mcl_senna",   name: "Scarlet Era",   c1: [0.93, 0.94, 0.96], c2: [0.90, 0.08, 0.10], stripe: [0.90, 0.08, 0.10], accent: [0.10, 0.11, 0.13],
      nose: [0.90, 0.08, 0.10], pod: [0.90, 0.08, 0.10], wing: [0.93, 0.94, 0.96] },
    { id: "mcl_triple",  name: "Triple Crown",  c1: [0.10, 0.11, 0.13], c2: [1.0, 0.50, 0.0], stripe: [0.0, 0.62, 0.86], accent: [0.95, 0.96, 0.98],
      nose: [1.0, 0.50, 0.0], wing: [0.0, 0.62, 0.86], halo: [1.0, 0.50, 0.0], noseStripe: [0.95, 0.96, 0.98] },
    { id: "mcl_solar",   name: "Solar Flare",   c1: [1.0, 0.38, 0.0],  c2: [1.0, 0.72, 0.10], stripe: [1.0, 0.85, 0.20], accent: [0.10, 0.11, 0.13],
      pod: [1.0, 0.72, 0.10], halo: [0.10, 0.11, 0.13] },
    { id: "mcl_satin",   name: "Satin Papaya",  c1: [0.82, 0.40, 0.02], c2: [0.12, 0.13, 0.15], stripe: [0.10, 0.11, 0.13], accent: [0.0, 0.62, 0.86],
      wing: [0.12, 0.13, 0.15], finish: "satin" },
    { id: "mcl_mirror",  name: "Mirror Works",  c1: [0.84, 0.86, 0.90], c2: [1.0, 0.50, 0.0], stripe: [0.10, 0.11, 0.13], accent: [0.0, 0.62, 0.86],
      nose: [1.0, 0.50, 0.0], halo: [1.0, 0.50, 0.0], finish: "chrome" },
    { id: "mcl_azure",   name: "Azure Papaya",  c1: [0.0, 0.46, 0.78], c2: [1.0, 0.50, 0.0], stripe: [1.0, 0.62, 0.10], accent: [0.93, 0.95, 0.97],
      pod: [1.0, 0.50, 0.0], wing: [0.0, 0.46, 0.78], noseStripe: [1.0, 0.50, 0.0] },
    { id: "mcl_west",    name: "Silver Dart",   c1: [0.74, 0.77, 0.82], c2: [0.06, 0.10, 0.30], stripe: [0.90, 0.92, 0.95], accent: [0.90, 0.10, 0.10],
      nose: [0.06, 0.10, 0.30], wing: [0.06, 0.10, 0.30], halo: [0.90, 0.10, 0.10] },
    { id: "mcl_m8",      name: "Can-Am M8D",    c1: [0.90, 0.28, 0.0], c2: [0.05, 0.05, 0.06], stripe: [0.90, 0.92, 0.95], accent: [0.0, 0.62, 0.86],
      pod: [0.05, 0.05, 0.06], halo: [0.90, 0.92, 0.95], noseStripe: [0.90, 0.92, 0.95] },
  ],
  redbull: [
    { id: "rb_matte",  name: "Matte Navy",  c1: [0.06, 0.10, 0.22], c2: [0.95, 0.78, 0.0], stripe: [0.82, 0.10, 0.14], accent: [0.90, 0.92, 0.95] },
    { id: "rb_holo",   name: "Holo",        c1: [0.086, 0.137, 0.294], c2: [0.90, 0.20, 0.55], stripe: [0.75, 0.30, 0.90], accent: [0.25, 0.85, 0.95] },
    { id: "rb_white",  name: "White Bull",  c1: [0.93, 0.94, 0.96], c2: [0.82, 0.10, 0.14], stripe: [0.086, 0.137, 0.294], accent: [0.95, 0.78, 0.0] },
    { id: "rb_red",    name: "Red Charge",  c1: [0.80, 0.09, 0.12], c2: [0.086, 0.137, 0.294], stripe: [0.95, 0.78, 0.0], accent: [0.94, 0.95, 0.97] },
    { id: "rb_energy", name: "Energy Blue", c1: [0.086, 0.137, 0.294], c2: [0.95, 0.78, 0.0], stripe: [0.90, 0.12, 0.16], accent: [0.20, 0.55, 0.95] },
    { id: "rb_apex",   name: "Apex Bull",   c1: [0.086, 0.137, 0.294], c2: [0.90, 0.12, 0.16], accent: [0.95, 0.78, 0.0],
      nose: [0.90, 0.12, 0.16], pod: [0.95, 0.78, 0.0], wing: [0.90, 0.12, 0.16], halo: [0.95, 0.78, 0.0] },
    { id: "rb_frost",  name: "Frost Bull",  c1: [0.86, 0.90, 0.94], c2: [0.086, 0.137, 0.294], stripe: [0.20, 0.55, 0.95], accent: [0.90, 0.12, 0.16],
      nose: [0.086, 0.137, 0.294], wing: [0.20, 0.55, 0.95], noseStripe: [0.90, 0.12, 0.16] },
    { id: "rb_night",  name: "Night Raid",  c1: [0.04, 0.06, 0.13], c2: [0.95, 0.78, 0.0], stripe: [0.75, 0.30, 0.90], accent: [0.25, 0.85, 0.95],
      pod: [0.086, 0.137, 0.294], halo: [0.95, 0.78, 0.0] },
    { id: "rb_satin",  name: "Matte Charge", c1: [0.07, 0.10, 0.20], c2: [0.90, 0.12, 0.16], stripe: [0.95, 0.78, 0.0], accent: [0.90, 0.92, 0.95],
      wing: [0.90, 0.12, 0.16], finish: "satin" },
    { id: "rb_chrome", name: "Chrome Bull", c1: [0.80, 0.84, 0.90], c2: [0.086, 0.137, 0.294], stripe: [0.90, 0.12, 0.16], accent: [0.95, 0.78, 0.0],
      nose: [0.086, 0.137, 0.294], halo: [0.95, 0.78, 0.0], finish: "chrome" },
    { id: "rb_carbon", name: "Carbon Bull", c1: [0.08, 0.08, 0.10], c2: [0.20, 0.24, 0.42], stripe: [0.95, 0.78, 0.0], accent: [0.90, 0.12, 0.16],
      pod: [0.086, 0.137, 0.294], wing: [0.90, 0.12, 0.16], noseStripe: [0.95, 0.78, 0.0] },
    { id: "rb_jaguar", name: "Big Cat",     c1: [0.02, 0.30, 0.24], c2: [0.86, 0.72, 0.20], stripe: [0.90, 0.92, 0.95], accent: [0.95, 0.78, 0.0],
      nose: [0.86, 0.72, 0.20], halo: [0.86, 0.72, 0.20], noseStripe: [0.90, 0.92, 0.95] },
    { id: "rb_desert", name: "Desert Bull", c1: [0.62, 0.52, 0.32], c2: [0.086, 0.137, 0.294], stripe: [0.90, 0.12, 0.16], accent: [0.95, 0.78, 0.0],
      pod: [0.086, 0.137, 0.294], wing: [0.95, 0.78, 0.0], finish: "satin" },
  ],
  alpine: [
    { id: "alp_pink",  name: "Pink Wave",     c1: [1.0, 0.53, 0.74], c2: [0.0, 0.58, 0.80], stripe: [0.05, 0.06, 0.10], accent: [0.95, 0.96, 0.98] },
    { id: "alp_bleu",  name: "Bleu de France", c1: [0.0, 0.35, 0.85], c2: [0.95, 0.95, 0.95], stripe: [1.0, 0.53, 0.74], accent: [0.90, 0.14, 0.20] },
    { id: "alp_tricolore", name: "Tricolore", c1: [0.0, 0.22, 0.62], c2: [0.86, 0.10, 0.16], stripe: [0.96, 0.96, 0.98], accent: [0.12, 0.55, 0.95] },
    { id: "alp_neon",  name: "Neon Azur",     c1: [0.0, 0.58, 0.80], c2: [1.0, 0.53, 0.74], accent: [0.90, 0.96, 0.30] },
    { id: "alp_carbon", name: "Enstone Dark", c1: [0.07, 0.09, 0.13], c2: [0.0, 0.58, 0.80], stripe: [1.0, 0.53, 0.74], accent: [0.90, 0.92, 0.95] },
    { id: "alp_azur",  name: "Azur Rose",     c1: [0.0, 0.42, 0.85], c2: [1.0, 0.53, 0.74], stripe: [0.95, 0.96, 0.98], accent: [0.0, 0.72, 0.86] },
    { id: "alp_a110",  name: "A110",          c1: [0.0, 0.42, 0.85], c2: [0.95, 0.96, 0.98], accent: [0.05, 0.06, 0.10],
      nose: [0.95, 0.96, 0.98], wing: [0.0, 0.42, 0.85], noseStripe: [0.95, 0.96, 0.98] },
    { id: "alp_rosepod", name: "Rose Pod",    c1: [0.05, 0.07, 0.14], c2: [0.0, 0.58, 0.80], stripe: [1.0, 0.53, 0.74], accent: [0.95, 0.96, 0.98],
      pod: [1.0, 0.53, 0.74], halo: [1.0, 0.53, 0.74] },
    { id: "alp_estoril", name: "Estoril",     c1: [0.0, 0.22, 0.62], c2: [1.0, 0.53, 0.74], stripe: [0.0, 0.72, 0.86], accent: [0.90, 0.92, 0.95],
      nose: [1.0, 0.53, 0.74], wing: [0.0, 0.22, 0.62], halo: [0.90, 0.92, 0.95] },
    { id: "alp_satin",   name: "Satin Azur",  c1: [0.02, 0.30, 0.52], c2: [1.0, 0.53, 0.74], stripe: [0.0, 0.72, 0.86], accent: [0.92, 0.94, 0.96],
      wing: [1.0, 0.53, 0.74], finish: "satin" },
    { id: "alp_chrome",  name: "Chrome Alpine", c1: [0.82, 0.86, 0.92], c2: [0.0, 0.42, 0.85], stripe: [1.0, 0.53, 0.74], accent: [0.0, 0.72, 0.86],
      nose: [0.0, 0.42, 0.85], halo: [1.0, 0.53, 0.74], finish: "chrome" },
    { id: "alp_gpf",     name: "Grand Prix",  c1: [0.0, 0.16, 0.52], c2: [0.95, 0.96, 0.98], stripe: [0.86, 0.10, 0.16], accent: [1.0, 0.53, 0.74],
      pod: [0.95, 0.96, 0.98], wing: [0.86, 0.10, 0.16], noseStripe: [0.86, 0.10, 0.16] },
    { id: "alp_gitanes", name: "Jaune '86",   c1: [0.97, 0.78, 0.04], c2: [0.0, 0.30, 0.72], stripe: [0.94, 0.95, 0.97], accent: [0.06, 0.07, 0.10],
      nose: [0.0, 0.30, 0.72], wing: [0.94, 0.95, 0.97], halo: [0.06, 0.07, 0.10] },
    { id: "alp_a442",    name: "A442 '78",    c1: [0.94, 0.93, 0.88], c2: [0.0, 0.24, 0.62], stripe: [0.95, 0.80, 0.10], accent: [0.86, 0.10, 0.16],
      pod: [0.0, 0.24, 0.62], wing: [0.95, 0.80, 0.10], noseStripe: [0.86, 0.10, 0.16] },
    { id: "alp_carmine", name: "Carmine",     c1: [0.72, 0.06, 0.20], c2: [0.0, 0.58, 0.80], stripe: [0.95, 0.96, 0.98], accent: [1.0, 0.53, 0.74],
      pod: [0.0, 0.58, 0.80], halo: [1.0, 0.53, 0.74] },
  ],
  racingbulls: [
    { id: "rbv_galaxy", name: "Galaxy",     c1: [0.06, 0.08, 0.22], c2: [0.086, 0.20, 0.80], stripe: [0.75, 0.45, 1.0], accent: [0.95, 0.40, 0.80] },
    { id: "rbv_snow",   name: "Snow",       c1: [0.95, 0.94, 0.92], c2: [0.086, 0.20, 0.80], stripe: [0.85, 0.14, 0.18], accent: [0.20, 0.55, 0.95] },
    { id: "rbv_purple", name: "Ultraviolet", c1: [0.10, 0.12, 0.42], c2: [0.086, 0.20, 0.80], stripe: [0.85, 0.14, 0.18], accent: [0.75, 0.45, 1.0] },
    { id: "rbv_navy",   name: "Navy Cadet", c1: [0.086, 0.20, 0.80], c2: [0.95, 0.94, 0.92], stripe: [0.85, 0.14, 0.18], accent: [0.40, 0.70, 1.0] },
    { id: "rbv_scarlet", name: "Scarlet Flash", c1: [0.95, 0.94, 0.92], c2: [0.85, 0.14, 0.18], stripe: [0.086, 0.20, 0.80] },
    { id: "rbv_hardline", name: "Hardline",   c1: [0.94, 0.95, 0.97], c2: [0.07, 0.13, 0.42], stripe: [0.88, 0.12, 0.16], accent: [0.20, 0.55, 0.95] },
    { id: "rbv_vortex",  name: "Vortex",      c1: [0.086, 0.20, 0.80], c2: [0.75, 0.45, 1.0], accent: [0.95, 0.40, 0.80],
      nose: [0.75, 0.45, 1.0], pod: [0.06, 0.08, 0.22], wing: [0.75, 0.45, 1.0], halo: [0.95, 0.40, 0.80] },
    { id: "rbv_pearl",   name: "Faenza Pearl", c1: [0.95, 0.94, 0.92], c2: [0.85, 0.14, 0.18], stripe: [0.086, 0.20, 0.80], accent: [0.20, 0.55, 0.95],
      nose: [0.85, 0.14, 0.18], wing: [0.086, 0.20, 0.80], noseStripe: [0.086, 0.20, 0.80] },
    { id: "rbv_midway",  name: "Midway",      c1: [0.06, 0.08, 0.22], c2: [0.95, 0.94, 0.92], stripe: [0.85, 0.14, 0.18], accent: [0.75, 0.45, 1.0],
      pod: [0.086, 0.20, 0.80], halo: [0.95, 0.94, 0.92] },
    { id: "rbv_satin",   name: "Satin Cadet", c1: [0.10, 0.14, 0.42], c2: [0.95, 0.94, 0.92], stripe: [0.85, 0.14, 0.18], accent: [0.40, 0.70, 1.0],
      wing: [0.086, 0.20, 0.80], finish: "satin" },
    { id: "rbv_chrome",  name: "Chrome Faenza", c1: [0.80, 0.84, 0.90], c2: [0.086, 0.20, 0.80], stripe: [0.85, 0.14, 0.18], accent: [0.75, 0.45, 1.0],
      nose: [0.086, 0.20, 0.80], halo: [0.086, 0.20, 0.80], finish: "chrome" },
    { id: "rbv_sunset",  name: "Faenza Sunset", c1: [0.14, 0.08, 0.30], c2: [0.98, 0.45, 0.30], stripe: [0.98, 0.72, 0.30], accent: [0.086, 0.20, 0.80],
      pod: [0.98, 0.45, 0.30], wing: [0.98, 0.72, 0.30], noseStripe: [0.95, 0.94, 0.92] },
    { id: "rbv_toro",    name: "Toro Rosso",  c1: [0.72, 0.06, 0.10], c2: [0.086, 0.20, 0.80], stripe: [0.95, 0.94, 0.92], accent: [0.95, 0.78, 0.0],
      nose: [0.086, 0.20, 0.80], wing: [0.72, 0.06, 0.10], halo: [0.95, 0.78, 0.0] },
    { id: "rbv_minardi", name: "Minardi '01", c1: [0.08, 0.08, 0.10], c2: [0.86, 0.62, 0.04], stripe: [0.086, 0.20, 0.80], accent: [0.95, 0.94, 0.92],
      pod: [0.086, 0.20, 0.80], halo: [0.86, 0.62, 0.04], noseStripe: [0.86, 0.62, 0.04] },
  ],
  haas: [
    { id: "haas_black", name: "Blackout",  c1: [0.06, 0.06, 0.07], c2: [0.85, 0.16, 0.11], stripe: [0.90, 0.92, 0.94], accent: [0.70, 0.72, 0.76] },
    { id: "haas_steel", name: "Gunmetal",  c1: [0.34, 0.36, 0.40], c2: [0.85, 0.16, 0.11], stripe: [0.90, 0.92, 0.94] },
    { id: "haas_stars", name: "Stars & Stripes", c1: [0.90, 0.92, 0.94], c2: [0.85, 0.16, 0.11], stripe: [0.08, 0.16, 0.48], accent: [0.10, 0.28, 0.70] },
    { id: "haas_money", name: "Money Green", c1: [0.06, 0.32, 0.20], c2: [0.85, 0.80, 0.55], stripe: [0.85, 0.16, 0.11], accent: [0.90, 0.78, 0.30] },
    { id: "haas_red",   name: "Crimson",   c1: [0.85, 0.16, 0.11], c2: [0.08, 0.08, 0.10], stripe: [0.90, 0.92, 0.94], accent: [0.96, 0.80, 0.20] },
    { id: "haas_glory", name: "Old Glory", c1: [0.90, 0.92, 0.94], c2: [0.08, 0.16, 0.48], stripe: [0.85, 0.16, 0.11], accent: [0.10, 0.28, 0.70],
      nose: [0.08, 0.16, 0.48], wing: [0.85, 0.16, 0.11], noseStripe: [0.85, 0.16, 0.11] },
    { id: "haas_machine", name: "Machine Shop", c1: [0.13, 0.14, 0.16], c2: [0.90, 0.92, 0.94], accent: [0.85, 0.16, 0.11],
      pod: [0.34, 0.36, 0.40], halo: [0.85, 0.16, 0.11] },
    { id: "haas_racer", name: "Dirt Racer", c1: [0.85, 0.16, 0.11], c2: [0.90, 0.92, 0.94], stripe: [0.08, 0.08, 0.10], accent: [0.96, 0.80, 0.20],
      nose: [0.90, 0.92, 0.94], pod: [0.08, 0.08, 0.10], wing: [0.85, 0.16, 0.11] },
    { id: "haas_satin", name: "Satin Steel", c1: [0.24, 0.26, 0.29], c2: [0.85, 0.16, 0.11], stripe: [0.90, 0.92, 0.94], accent: [0.62, 0.64, 0.68],
      wing: [0.85, 0.16, 0.11], finish: "satin" },
    { id: "haas_chrome", name: "Chrome Machine", c1: [0.82, 0.84, 0.88], c2: [0.85, 0.16, 0.11], stripe: [0.08, 0.16, 0.48], accent: [0.10, 0.28, 0.70],
      nose: [0.85, 0.16, 0.11], halo: [0.85, 0.16, 0.11], finish: "chrome" },
    { id: "haas_stock", name: "Stock Car",  c1: [0.90, 0.92, 0.94], c2: [0.06, 0.06, 0.07], stripe: [0.85, 0.16, 0.11], accent: [0.08, 0.16, 0.48],
      pod: [0.85, 0.16, 0.11], wing: [0.06, 0.06, 0.07], noseStripe: [0.08, 0.16, 0.48] },
    { id: "haas_cup",   name: "Cup Series", c1: [0.12, 0.32, 0.72], c2: [0.96, 0.80, 0.10], stripe: [0.90, 0.92, 0.94], accent: [0.85, 0.16, 0.11],
      pod: [0.96, 0.80, 0.10], wing: [0.12, 0.32, 0.72], noseStripe: [0.85, 0.16, 0.11] },
    { id: "haas_tool",  name: "Toolbox",    c1: [0.86, 0.42, 0.06], c2: [0.13, 0.14, 0.16], stripe: [0.90, 0.92, 0.94], accent: [0.96, 0.80, 0.20],
      pod: [0.13, 0.14, 0.16], halo: [0.86, 0.42, 0.06], finish: "satin" },
  ],
  williams: [
    { id: "wil_stripe",   name: "Racing Stripe", c1: [0.94, 0.95, 0.97], c2: [0.06, 0.24, 0.79], stripe: [0.06, 0.24, 0.79], accent: [0.90, 0.14, 0.20] },
    { id: "wil_heritage", name: "Heritage Blue", c1: [0.06, 0.24, 0.79], c2: [0.95, 0.80, 0.15], stripe: [0.94, 0.95, 0.97], accent: [0.90, 0.14, 0.20] },
    { id: "wil_martini",  name: "Heritage Stripes", c1: [0.94, 0.95, 0.97], c2: [0.06, 0.24, 0.79], stripe: [0.82, 0.10, 0.18], accent: [0.12, 0.40, 0.85] },
    { id: "wil_navy",     name: "Deep Navy",     c1: [0.04, 0.10, 0.30], c2: [0.06, 0.24, 0.79], stripe: [0.55, 0.70, 0.92], accent: [0.90, 0.78, 0.20] },
    { id: "wil_camo",     name: "Blue Camo",     c1: [0.06, 0.24, 0.79], c2: [0.55, 0.70, 0.92], accent: [0.90, 0.92, 0.96] },
    { id: "wil_azzurro",  name: "Azzurro",       c1: [0.03, 0.14, 0.52], c2: [0.95, 0.96, 0.98], stripe: [0.12, 0.55, 0.95], accent: [0.90, 0.78, 0.20] },
    { id: "wil_rothko",   name: "Grove '92",     c1: [0.06, 0.24, 0.79], c2: [0.95, 0.80, 0.15], stripe: [0.94, 0.95, 0.97], accent: [0.90, 0.14, 0.20],
      nose: [0.95, 0.80, 0.15], pod: [0.94, 0.95, 0.97], wing: [0.06, 0.24, 0.79], noseStripe: [0.90, 0.14, 0.20] },
    { id: "wil_duckblue", name: "Speedbird",     c1: [0.55, 0.70, 0.92], c2: [0.06, 0.24, 0.79], accent: [0.90, 0.92, 0.96],
      nose: [0.06, 0.24, 0.79], wing: [0.55, 0.70, 0.92], halo: [0.06, 0.24, 0.79] },
    { id: "wil_grove",    name: "Grove Works",   c1: [0.04, 0.10, 0.30], c2: [0.95, 0.80, 0.15], stripe: [0.06, 0.24, 0.79], accent: [0.55, 0.70, 0.92],
      pod: [0.06, 0.24, 0.79], halo: [0.95, 0.80, 0.15] },
    { id: "wil_satin",    name: "Satin Navy",    c1: [0.05, 0.12, 0.34], c2: [0.55, 0.70, 0.92], stripe: [0.94, 0.95, 0.97], accent: [0.95, 0.80, 0.15],
      wing: [0.55, 0.70, 0.92], finish: "satin" },
    { id: "wil_chrome",   name: "Chrome Grove",  c1: [0.82, 0.86, 0.92], c2: [0.06, 0.24, 0.79], stripe: [0.06, 0.24, 0.79], accent: [0.90, 0.14, 0.20],
      nose: [0.06, 0.24, 0.79], halo: [0.06, 0.24, 0.79], finish: "chrome" },
    { id: "wil_canary",   name: "Canary",        c1: [0.95, 0.80, 0.15], c2: [0.06, 0.24, 0.79], stripe: [0.04, 0.10, 0.30], accent: [0.94, 0.95, 0.97],
      pod: [0.06, 0.24, 0.79], wing: [0.04, 0.10, 0.30], noseStripe: [0.06, 0.24, 0.79] },
    { id: "wil_rothmans", name: "Grove '96",     c1: [0.94, 0.95, 0.97], c2: [0.04, 0.10, 0.34], stripe: [0.86, 0.72, 0.24], accent: [0.86, 0.14, 0.20],
      nose: [0.04, 0.10, 0.34], wing: [0.86, 0.72, 0.24], noseStripe: [0.86, 0.14, 0.20] },
    { id: "wil_didcot",   name: "Didcot Black",  c1: [0.07, 0.08, 0.10], c2: [0.12, 0.62, 0.95], stripe: [0.94, 0.95, 0.97], accent: [0.95, 0.80, 0.15],
      pod: [0.12, 0.62, 0.95], halo: [0.95, 0.80, 0.15] },
  ],
  audi: [
    { id: "audi_black", name: "Vorsprung", c1: [0.06, 0.06, 0.07], c2: [0.96, 0.02, 0.22], stripe: [0.70, 0.71, 0.74], accent: [0.92, 0.93, 0.96] },
    { id: "audi_titan", name: "Titanium",  c1: [0.70, 0.71, 0.74], c2: [0.96, 0.02, 0.22], stripe: [0.06, 0.06, 0.07] },
    { id: "audi_rings", name: "Four Rings", c1: [0.82, 0.83, 0.85], c2: [0.96, 0.02, 0.22], stripe: [0.06, 0.06, 0.07], accent: [0.50, 0.52, 0.56] },
    { id: "audi_carbon", name: "Carbon Ruby", c1: [0.09, 0.09, 0.11], c2: [0.96, 0.02, 0.22], stripe: [0.70, 0.71, 0.74], accent: [0.60, 0.02, 0.16] },
    { id: "audi_rubine", name: "Rubine",    c1: [0.96, 0.02, 0.22], c2: [0.70, 0.71, 0.74], stripe: [0.06, 0.06, 0.07], accent: [0.94, 0.94, 0.96] },
    { id: "audi_lemans", name: "R18 Tribute", c1: [0.82, 0.83, 0.85], c2: [0.96, 0.02, 0.22], stripe: [0.06, 0.06, 0.07], accent: [0.50, 0.52, 0.56],
      nose: [0.06, 0.06, 0.07], pod: [0.96, 0.02, 0.22], wing: [0.06, 0.06, 0.07] },
    { id: "audi_night",  name: "Neuburg Night", c1: [0.05, 0.05, 0.06], c2: [0.96, 0.02, 0.22], accent: [0.70, 0.71, 0.74],
      nose: [0.96, 0.02, 0.22], wing: [0.96, 0.02, 0.22], halo: [0.70, 0.71, 0.74], noseStripe: [0.70, 0.71, 0.74] },
    { id: "audi_sport",  name: "Sport Quattro", c1: [0.93, 0.94, 0.96], c2: [0.96, 0.02, 0.22], stripe: [0.96, 0.02, 0.22], accent: [0.06, 0.06, 0.07],
      pod: [0.06, 0.06, 0.07], halo: [0.96, 0.02, 0.22] },
    { id: "audi_satin",  name: "Satin Vorsprung", c1: [0.10, 0.10, 0.12], c2: [0.96, 0.02, 0.22], stripe: [0.70, 0.71, 0.74], accent: [0.92, 0.93, 0.96],
      wing: [0.96, 0.02, 0.22], finish: "satin" },
    { id: "audi_chrome", name: "Chrome Rings",  c1: [0.84, 0.86, 0.90], c2: [0.06, 0.06, 0.07], stripe: [0.96, 0.02, 0.22], accent: [0.70, 0.71, 0.74],
      nose: [0.06, 0.06, 0.07], halo: [0.96, 0.02, 0.22], finish: "chrome" },
    { id: "audi_dtm",    name: "DTM Silver",    c1: [0.70, 0.71, 0.74], c2: [0.06, 0.06, 0.07], stripe: [0.96, 0.02, 0.22], accent: [0.50, 0.52, 0.56],
      pod: [0.06, 0.06, 0.07], wing: [0.96, 0.02, 0.22], noseStripe: [0.06, 0.06, 0.07] },
    { id: "audi_nogaro", name: "Nogaro Blue",   c1: [0.06, 0.16, 0.42], c2: [0.70, 0.71, 0.74], stripe: [0.96, 0.02, 0.22], accent: [0.92, 0.93, 0.96],
      nose: [0.70, 0.71, 0.74], wing: [0.06, 0.16, 0.42], halo: [0.96, 0.02, 0.22] },
    { id: "audi_nardo",  name: "Nardo Grey",    c1: [0.55, 0.56, 0.58], c2: [0.06, 0.06, 0.07], stripe: [0.96, 0.02, 0.22], accent: [0.90, 0.92, 0.95],
      pod: [0.06, 0.06, 0.07], halo: [0.96, 0.02, 0.22], finish: "satin" },
  ],
  astonmartin: [
    { id: "amr_green", name: "Racing Green", c1: [0.0, 0.35, 0.31], c2: [0.72, 0.88, 0.11], stripe: [0.05, 0.06, 0.06], accent: [0.90, 0.92, 0.90] },
    { id: "amr_pink",  name: "Racing Pink",  c1: [0.90, 0.30, 0.55], c2: [0.0, 0.35, 0.31], stripe: [0.72, 0.88, 0.11], accent: [0.95, 0.96, 0.96] },
    { id: "amr_brg",   name: "Deep BRG",     c1: [0.0, 0.24, 0.20],  c2: [0.72, 0.88, 0.11], accent: [0.82, 0.66, 0.28] },
    { id: "amr_gold",  name: "British Gold", c1: [0.0, 0.35, 0.31], c2: [0.82, 0.66, 0.28], stripe: [0.72, 0.88, 0.11], accent: [0.05, 0.06, 0.06] },
    { id: "amr_lime",  name: "Lime Night",   c1: [0.04, 0.08, 0.07], c2: [0.72, 0.88, 0.11], accent: [0.0, 0.55, 0.48] },
    { id: "amr_valour", name: "Valour",      c1: [0.0, 0.35, 0.31], c2: [0.82, 0.66, 0.28], accent: [0.90, 0.92, 0.90],
      nose: [0.82, 0.66, 0.28], pod: [0.0, 0.24, 0.20], wing: [0.0, 0.35, 0.31], halo: [0.82, 0.66, 0.28] },
    { id: "amr_vantage", name: "Vantage",    c1: [0.05, 0.06, 0.06], c2: [0.0, 0.35, 0.31], stripe: [0.72, 0.88, 0.11], accent: [0.82, 0.66, 0.28],
      nose: [0.0, 0.35, 0.31], wing: [0.72, 0.88, 0.11], noseStripe: [0.72, 0.88, 0.11] },
    { id: "amr_heritage", name: "Ulster",    c1: [0.0, 0.28, 0.25], c2: [0.90, 0.92, 0.90], stripe: [0.90, 0.30, 0.55], accent: [0.72, 0.88, 0.11],
      pod: [0.90, 0.30, 0.55], halo: [0.90, 0.92, 0.90] },
    { id: "amr_satin",  name: "Satin BRG",   c1: [0.0, 0.26, 0.23], c2: [0.72, 0.88, 0.11], stripe: [0.05, 0.06, 0.06], accent: [0.90, 0.92, 0.90],
      wing: [0.72, 0.88, 0.11], finish: "satin" },
    { id: "amr_chrome", name: "Chrome Vantage", c1: [0.80, 0.86, 0.84], c2: [0.0, 0.35, 0.31], stripe: [0.72, 0.88, 0.11], accent: [0.82, 0.66, 0.28],
      nose: [0.0, 0.35, 0.31], halo: [0.72, 0.88, 0.11], finish: "chrome" },
    { id: "amr_cyan",   name: "Cyan Wing",   c1: [0.04, 0.09, 0.10], c2: [0.0, 0.78, 0.72], stripe: [0.72, 0.88, 0.11], accent: [0.0, 0.35, 0.31],
      pod: [0.0, 0.35, 0.31], wing: [0.0, 0.78, 0.72], noseStripe: [0.72, 0.88, 0.11] },
    { id: "amr_dbr1",   name: "DBR1 '59",    c1: [0.12, 0.50, 0.28], c2: [0.94, 0.90, 0.78], accent: [0.05, 0.06, 0.06],
      nose: [0.94, 0.90, 0.78], halo: [0.94, 0.90, 0.78], noseStripe: [0.90, 0.14, 0.20] },
    { id: "amr_jordan", name: "Jordan '91",  c1: [0.06, 0.34, 0.16], c2: [0.95, 0.80, 0.08], stripe: [0.90, 0.14, 0.20], accent: [0.94, 0.95, 0.96],
      pod: [0.95, 0.80, 0.08], wing: [0.06, 0.34, 0.16], noseStripe: [0.90, 0.14, 0.20] },
  ],
  cadillac: [
    { id: "cad_usa",   name: "Americana", c1: [0.05, 0.10, 0.35], c2: [0.86, 0.12, 0.16], stripe: [0.94, 0.94, 0.96], accent: [0.82, 0.68, 0.32] },
    { id: "cad_pearl", name: "Pearl",     c1: [0.93, 0.93, 0.95], c2: [0.80, 0.66, 0.30], stripe: [0.06, 0.06, 0.07], accent: [0.88, 0.78, 0.44] },
    { id: "cad_gold",  name: "Gold Luxe", c1: [0.05, 0.05, 0.06], c2: [0.80, 0.66, 0.30], stripe: [0.88, 0.78, 0.42], accent: [0.96, 0.90, 0.60] },
    { id: "cad_black", name: "Onyx",      c1: [0.03, 0.03, 0.04], c2: [0.80, 0.66, 0.30], stripe: [0.86, 0.88, 0.92] },
    { id: "cad_liberty", name: "Liberty", c1: [0.90, 0.92, 0.95], c2: [0.10, 0.18, 0.50], stripe: [0.86, 0.12, 0.16], accent: [0.82, 0.68, 0.32] },
    { id: "cad_champagne", name: "Champagne", c1: [0.04, 0.05, 0.08], c2: [0.83, 0.69, 0.34], stripe: [0.94, 0.94, 0.96], accent: [0.96, 0.90, 0.62] },
    { id: "cad_vseries", name: "V-Series",   c1: [0.03, 0.03, 0.04], c2: [0.86, 0.12, 0.16], accent: [0.80, 0.66, 0.30],
      nose: [0.86, 0.12, 0.16], pod: [0.10, 0.18, 0.50], wing: [0.86, 0.12, 0.16], halo: [0.80, 0.66, 0.30] },
    { id: "cad_eldorado", name: "Eldorado",  c1: [0.93, 0.93, 0.95], c2: [0.10, 0.18, 0.50], stripe: [0.86, 0.12, 0.16], accent: [0.80, 0.66, 0.30],
      nose: [0.10, 0.18, 0.50], wing: [0.93, 0.93, 0.95], noseStripe: [0.86, 0.12, 0.16] },
    { id: "cad_motorcity", name: "Motor City", c1: [0.16, 0.17, 0.20], c2: [0.80, 0.66, 0.30], stripe: [0.94, 0.94, 0.96], accent: [0.86, 0.12, 0.16],
      pod: [0.05, 0.05, 0.06], halo: [0.94, 0.94, 0.96] },
    { id: "cad_satin",  name: "Satin Onyx",  c1: [0.08, 0.08, 0.09], c2: [0.80, 0.66, 0.30], stripe: [0.88, 0.78, 0.42], accent: [0.86, 0.88, 0.92],
      wing: [0.80, 0.66, 0.30], finish: "satin" },
    { id: "cad_chrome", name: "Chrome Luxe", c1: [0.86, 0.78, 0.52], c2: [0.05, 0.05, 0.06], stripe: [0.96, 0.90, 0.60], accent: [0.86, 0.12, 0.16],
      nose: [0.05, 0.05, 0.06], halo: [0.96, 0.90, 0.60], finish: "chrome" },
    { id: "cad_lemans", name: "Le Mans V",   c1: [0.93, 0.93, 0.95], c2: [0.05, 0.10, 0.35], stripe: [0.86, 0.12, 0.16], accent: [0.80, 0.66, 0.30],
      pod: [0.05, 0.10, 0.35], wing: [0.86, 0.12, 0.16], noseStripe: [0.80, 0.66, 0.30] },
    { id: "cad_palm",   name: "Palm Springs", c1: [0.10, 0.72, 0.68], c2: [0.93, 0.93, 0.95], stripe: [0.80, 0.66, 0.30], accent: [0.05, 0.05, 0.06],
      pod: [0.93, 0.93, 0.95], halo: [0.80, 0.66, 0.30] },
    { id: "cad_fintail", name: "Tailfin '59", c1: [0.86, 0.24, 0.42], c2: [0.93, 0.93, 0.95], stripe: [0.80, 0.66, 0.30], accent: [0.05, 0.05, 0.06],
      nose: [0.93, 0.93, 0.95], wing: [0.86, 0.24, 0.42], noseStripe: [0.80, 0.66, 0.30] },
    { id: "cad_steel",  name: "Brushed Steel", c1: [0.70, 0.72, 0.76], c2: [0.86, 0.12, 0.16], stripe: [0.05, 0.05, 0.06], accent: [0.80, 0.66, 0.30],
      nose: [0.86, 0.12, 0.16], halo: [0.80, 0.66, 0.30], finish: "chrome" },
  ],
};

// Every field a team's `livery` block may carry onto the derived default —
// every row that is NOT c1/c2/id/name. Published as Liveries.FIELDS because
// hand copies drifted (render-car carried 23 of 33, so nine tint rows were
// unreachable from the shot tools). Dead keys (ridgeTint / airboxTint /
// crestInk / plateInk) are NOT listed: migratePaint folds or drops them
// before paint.
const FIELDS: readonly LiveryField[] = ["stripe", "noseStripe", "accent", "nose", "pod", "wing", "fin", "finArt",
  "logo", "logo2", "logo3", "halo", "finish", "numFont", "sponsors", "finStyle", "finBadge",
  "spineLogo", "finShape", "tcam", "coverVents", "spineHeight", "spineSide", "cover",
  "spineTint", "sideTint", "sunTint", "bandTint2", "plateTint",
  "saddleTint", "coverBind", "finHandoff",
  "rearWing", "wingCarbon", "bodySplit", "lower", "upper",
  "patternTint", "patternSecond", "patternPlacement", "patternSide", "patternWidth", "patternRepeat",
  "patternOffset", "patternTaper", "patternOpacity", "patternRotation", "patternStretch", "patternWeight", "coverFinish", "wingFinish", "haloFinish",
  // GARAGE FINISHES/PARTS contract (docs/notes/GARAGE-FINISHES-PARTS-2026-10-17.md): one row per field, owned by the slice named there.
  "mirrorTint", "rimTint", "caliperTint", "sidewallInk", "helmetBase", "helmetAccent",
  "podFinish", "finFinish", "mirrorFinish", "helmetStyle"];

// One-shot paint migrate: fold ridge→BAND, airbox→COVER; drop lettering overrides.
// Idempotent. Mutates and returns `liv` (or a shallow copy when null-safe).
function migratePaint<T>(liv: T): T {
  if (!liv || typeof liv !== "object") return liv;
  const l = liv as Record<string, unknown>;
  if (l["ridgeTint"]) {
    if (!l["spineTint"]) l["spineTint"] = l["ridgeTint"];
    delete l["ridgeTint"];
  }
  // AIRBOX is DROPPED, not folded onto `cover`. It painted the roll hoop,
  // snorkel and intake lips ALONE — a strict subset of `cover`, which paints
  // the whole loft AND is the surface the atlas inks the crown crest and
  // every spine design against. Promoting it would repaint the cover and
  // flip the crest ink on any stored file that set it; the row's own
  // fallback was always ENGINE COVER, so dropping it lands where the sheet
  // said it would land.
  if (l["airboxTint"]) delete l["airboxTint"];
  if (l["crestInk"]) delete l["crestInk"];
  if (l["plateInk"]) delete l["plateInk"];
  return liv;
}

function forTeam(team: LiveryTeam, deps?: LiveriesDeps): Livery[] {
  const def: Livery = { id: "default", name: "Team Livery", c1: team.color, c2: team.color2 };
  const ex = team.livery;
  if (ex) {
    for (const k of FIELDS) if (ex[k]) (def as Record<string, unknown>)[k] = ex[k];
  }
  // LEGEND TRIBUTES last, so they never displace a team's own specials at the
  // top of the tab. Guarded on `typeof` rather than ordered by the manifest
  // alone: liveries.js is reachable from tools that load a subset of the
  // roster (the cockpit and crest sweeps build a car without js/data), and a
  // missing Legends there must cost the picker its extras, never throw.
  const Legends = deps?.Legends;
  const legends = (Legends !== undefined && Legends.liveries) ? Legends.liveries() : [];
  return [def].concat(BY_TEAM[team.id] || [], UNIVERSAL, legends);
}

export { UNIVERSAL, BY_TEAM, FIELDS, forTeam, migratePaint };

/** The f1-game `Liveries` global's members, frozen as it was (js/car/liveries.js:550-552). */
export const Liveries = Object.freeze({ UNIVERSAL, BY_TEAM, FIELDS, forTeam, migratePaint });
