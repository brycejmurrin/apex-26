/* CIRCUIT LORE: the thing about each circuit a broadcast would say.
   Ported verbatim from f1-game js/data/circuit-lore.js:1-276. */
// WHY A TABLE, when js/audio/announcer.js opens by arguing against one.
//
// That argument still holds for NUMBERS. Length, corner count, elevation and
// the lights are derived from the def and the built track precisely so nothing
// can fall out of step with the circuit it describes — a hand-typed "5.8
// kilometres" survives a geometry change and a derived one cannot.
//
// It does not hold for CHARACTER. No measurement yields "Eau Rouge", "the
// Temple of Speed" or "thin air at two thousand metres", and a welcome built
// only from numbers says the same shape of thing about fifty-two circuits: a
// length, a corner count, a density band. That is what this file is for, and
// the two halves stay in their own lanes — every line here is a fact about the
// PLACE that does not change when the geometry is re-surveyed.
//
// THE FAILURE THE HEADER WARNED ABOUT is "written for the six somebody
// bothered and missing on the rest". tests/unit/announcer.test.mjs asserts the
// keys here are exactly the circuit ids in the manifest, both ways, so a new
// circuit cannot ship without its line and a retired one cannot leave a
// dangling entry.
//
// SLOTS. `line` is the identity and is required. `corner` names the piece of
// road the circuit is known for. `wet` and `night` are spoken only when the
// conditions call for them, which is what keeps a wet Spa and a dry Spa from
// being the same read. Every value is ONE spoken sentence, ending in its own
// punctuation: js/audio/announcer.js speaks one utterance per line, so a
// sentence here is a unit of phrasing, not a paragraph to be re-cut.
//
// WRITING RULES, enforced by the test: no ALL-CAPS tokens (RadioVoice
// speakable() spells short ones out letter by letter), no "GP" (say Grand

export interface LoreRow { line: string; corner?: string; wet?: string; night?: string }

export const LORE: Readonly<Record<string, Readonly<LoreRow>>> = {
  // ── the current calendar ────────────────────────────────────────────────
  abudhabi: {
    line: "Yas Marina, where the sun goes down during the race and the track lights take over.",
    corner: "The long left under the hotel is the one that decides your exit onto the back straight.",
    night: "We start in daylight and finish in the dark — the grip comes to you as the track cools.",
  },
  albert_park: {
    line: "A public park circuit around a lake in Melbourne, fast and unforgiving of a wide line.",
    corner: "The fast right-left onto the lakeside run rewards anyone brave with the throttle.",
    wet: "The park surface goes greasy quickly, and the walls are close enough to punish it.",
  },
  bahrain: {
    line: "A desert circuit built around heavy braking, with the wind moving the sand across it.",
    corner: "Turn one is the big stop of the lap and the best overtake on it.",
    night: "Under the floodlights the desert cools fast, and the track comes alive with it.",
  },
  baku: {
    line: "A street circuit through Baku, half medieval castle walls and half full-throttle seafront.",
    corner: "The castle section is barely wider than a car, and it leads onto the longest straight of the year.",
    wet: "Rain on these polished city stones takes the grip away everywhere at once.",
  },
  catalunya: {
    line: "Barcelona, where every team has tested and every weakness in a car shows up.",
    corner: "Turn three is long, fast and relentless on the front tyres.",
  },
  cota: {
    line: "Austin, a circuit that borrowed the best corners in the world and put them on a Texas hillside.",
    corner: "The blind climb to turn one, then straight into the esses — the run every driver talks about.",
  },
  hungaroring: {
    line: "A tight, twisting circuit outside Budapest where a lap never really opens up.",
    corner: "Turn two drops downhill under braking and offers the one clean pass of the lap.",
    wet: "In the rain it becomes the hardest circuit of the year to keep a car on.",
  },
  imola: {
    line: "An old-school Italian circuit that runs the wrong way round, with kerbs that bite.",
    corner: "Acque Minerali drops away downhill and asks you to trust the car over the brow.",
  },
  interlagos: {
    line: "Sao Paulo, anticlockwise, bumpy, and built on a hillside that never lets the car settle.",
    corner: "The Senna S plunges downhill off the line and sets up the whole lap.",
    wet: "Rain arrives here in minutes and the uphill drag to the flag becomes a river.",
  },
  jeddah: {
    line: "The fastest street circuit there is — walls on both sides and barely a corner below flat.",
    corner: "The long left-right walls through the middle sector never stop coming.",
    night: "Floodlit and fast, with the barriers closer than they look at this speed.",
  },
  madrid: {
    line: "Madrid's new circuit, part city street and part purpose-built, and nobody has old data for it.",
    corner: "The banked turn is the feature everyone came to see.",
  },
  mexico: {
    line: "Mexico City, more than two thousand metres up, where the thin air robs the wings of their grip.",
    corner: "The stadium section takes you through a grandstand on three sides, slow and loud.",
  },
  miami: {
    line: "A circuit laid out around the stadium, part car park and part fast sweeping infield.",
    corner: "The tight left-right under the flyover is where the lap is lost.",
    wet: "The painted surfaces here turn to ice the moment it rains.",
  },
  monaco: {
    line: "Monaco. Barriers the whole way round, no run-off, and a circuit that has never needed to change.",
    corner: "Casino, the tunnel, then the harbour chicane — the most famous sequence in the sport.",
    wet: "Wet, this place stops being about lap time and starts being about survival.",
  },
  montreal: {
    line: "Ile Notre-Dame, a semi-permanent circuit on an island, all long straights and hard stops.",
    corner: "The final chicane is lined by the wall that has caught out champions.",
    wet: "It rains here often, and the wall on the exit does not move.",
  },
  monza: {
    line: "Monza, the temple of speed, in a royal park where the wings come off and the tow is everything.",
    corner: "Parabolica is a long, loaded right that decides the run to the line.",
  },
  portimao: {
    line: "The Algarve circuit, a rollercoaster where half the corners are taken on a crest or a dip.",
    corner: "The blind drop after the start line is the corner nobody forgets.",
  },
  qatar: {
    line: "Losail, built for motorcycles, which is why it is one long chain of fast sweeps.",
    corner: "The right-handers through the middle are flat out and merciless on a front tyre.",
    night: "Floodlit in the desert, with the dew coming down as the night goes on.",
  },
  redbull: {
    line: "A short lap in the Styrian hills — three big braking zones and a climb between them.",
    corner: "Turn three is uphill under braking, and the best overtake of the lap.",
    wet: "The mountain weather can soak one half of the circuit and leave the other dry.",
  },
  shanghai: {
    line: "Shanghai, where the opening corner spirals ever tighter before the longest straight on the lap.",
    corner: "Turns one to three wind inward and reward patience over commitment.",
  },
  silverstone: {
    line: "Silverstone, an old airfield turned into the fastest flowing circuit in Europe.",
    corner: "Maggotts, Becketts and Chapel — a change of direction at full speed that no simulator does justice.",
    wet: "The wind and rain come across the open airfield from nowhere.",
  },
  singapore: {
    line: "A street circuit through Singapore under lights, in heat and humidity that never let up.",
    corner: "The run along the bay and back through the concrete is relentlessly tight.",
    night: "Floodlit the whole way round, which is the only way this one is raced.",
  },
  spa: {
    line: "Spa-Francorchamps, through the Ardennes forest, the longest and most loved lap of the year.",
    corner: "Eau Rouge and Raidillon, uphill, blind over the crest, and flat if you dare.",
    wet: "It can rain on one half of this circuit and stay dry on the other — it usually does.",
  },
  suzuka: {
    line: "Suzuka, a figure of eight that crosses over itself, and a drivers' favourite for good reason.",
    corner: "The esses in the first sector flow one into the next, and 130R later is taken almost flat.",
  },
  vegas: {
    line: "Las Vegas, straight down the Strip at night, with the casinos going past at three hundred.",
    corner: "The long left onto the Strip is where the lap is made.",
    night: "Run in the small hours, on a cold track that never quite comes to you.",
  },
  zandvoort: {
    line: "Zandvoort, in the dunes on the Dutch coast, narrow and banked and unlike anywhere else.",
    corner: "The banked final turn fires you onto the straight and can be taken two abreast.",
    wet: "Sea wind carries sand onto the circuit, and rain turns that into a skating rink.",
  },
  istanbul: {
    line: "Istanbul Park, anticlockwise and sweeping, with a corner that sits in a class of its own.",
    corner: "Turn eight is a quadruple-apex left that lasts most of a minute and never stops loading the tyre.",
  },
  sepang: {
    line: "Sepang, two enormous straights joined by fast corners, in tropical heat that punishes everything.",
    corner: "The long final right feeds the main straight and rewards a patient exit.",
    wet: "The afternoon storm here arrives all at once and floods the circuit in minutes.",
  },
  sochi: {
    line: "A circuit through an Olympic park, flat and walled, with one corner that goes on forever.",
    corner: "Turn three is a long left that keeps tightening after you have committed to it.",
  },
  // ── the archive ─────────────────────────────────────────────────────────
  anderstorp: {
    line: "A Swedish circuit laid out on an airfield, with a runway for a back straight.",
    corner: "The long right onto the runway is flat and endless, and the braking at the end of it is enormous.",
  },
  brands_hatch: {
    line: "Brands Hatch, a natural amphitheatre in Kent where the crowd looks down on the whole lap.",
    corner: "Paddock Hill Bend falls away downhill the moment you turn in, which is what makes it famous.",
  },
  buddh: {
    line: "The Buddh circuit outside Delhi, wide, fast and built on rising ground.",
    corner: "The banked double-right is taken at a speed the eye does not believe.",
  },
  buenos_aires: {
    line: "The Oscar Galvez autodrome in Buenos Aires, fast, flat and famously hot.",
    corner: "The long curving left onto the straight is where a tow is won or lost.",
  },
  dijon: {
    line: "Dijon-Prenois, a short circuit in the Burgundy hills with more height change than length.",
    corner: "The plunging downhill left is blind on entry and quick on exit.",
  },
  donington: {
    line: "Donington Park, in the Leicestershire parkland, where the middle of the lap drops away from you.",
    corner: "The Craner Curves run downhill at full speed with no barrier to reassure you.",
    wet: "This circuit made its name in the rain, and it still rewards the brave in it.",
  },
  estoril: {
    line: "Estoril, on the Portuguese coast, where one corner defines the entire lap.",
    corner: "The final right is long and loaded and leads onto the longest straight — get it wrong and you lose the lap twice.",
  },
  fuji: {
    line: "Fuji Speedway, in the shadow of the mountain, with a straight longer than anything else in Japan.",
    corner: "The long right at the end of the straight arrives after the hardest braking of the lap.",
    wet: "Cloud comes down off the mountain and takes the visibility with it.",
  },
  hockenheim: {
    line: "Hockenheim, now a short lap that ends in a stadium with the crowd on all sides.",
    corner: "The stadium section is slow, tight and watched by every seat in the place.",
  },
  indianapolis: {
    line: "The road course inside the Brickyard, running the banking backwards onto the famous straight.",
    corner: "The banked oval turn is taken flat and leads onto a straight that never ends.",
  },
  jacarepagua: {
    line: "Rio de Janeiro, flat, bumpy and brutally hot, with the track surface moving under the car.",
    corner: "The long right onto the straight is taken with the car sliding all the way through it.",
  },
  jerez: {
    line: "Jerez, in Andalusia, the circuit every team has tested at and nobody has ever found easy.",
    corner: "Dry Sack is a slow right with a long entry, and it punishes an early throttle.",
  },
  korea: {
    line: "Yeongam, half harbour front and half enormous straight, built for a city that never arrived.",
    corner: "The tight left-right by the water is where a lap comes undone.",
  },
  kyalami: {
    line: "Kyalami, high on the South African veld, where the altitude takes the power out of the engine.",
    corner: "The long right-hander onto the main straight is fast, committed and utterly blind at the crest.",
  },
  magny_cours: {
    line: "Magny-Cours, the smoothest surface in the sport, where the car never has an excuse.",
    corner: "The Adelaide hairpin at the end of the back straight is the one real overtake.",
  },
  mont_tremblant: {
    line: "Saint-Jovite in the Laurentian mountains, fast and hilly and lined with trees.",
    corner: "The crest before the downhill plunge unloads the car completely at the worst moment.",
  },
  mosport: {
    line: "Mosport in Ontario, old, fast and blind, with corners that arrive over the top of a hill.",
    corner: "Turn two falls away downhill at high speed with nothing but grass beside it.",
  },
  mugello: {
    line: "Mugello, in the Tuscan hills, a succession of fast uphill sweeps and one enormous straight.",
    corner: "The Arrabbiata corners are quick, uphill and taken on trust.",
  },
  nurburgring: {
    line: "The Grand Prix circuit in the Eifel, in the shadow of the old Nordschleife.",
    corner: "The long right onto the back straight is where a lap is set up.",
    wet: "Eifel weather is its own opponent — it can rain on one corner and nowhere else.",
  },
  okayama: {
    line: "Okayama, a tight Japanese circuit where the corners come one after another with no rest.",
    corner: "The double right at the top of the hill is slow, awkward and easy to lose time in.",
  },
  paul_ricard: {
    line: "Paul Ricard in Provence, with painted run-off instead of gravel and a straight split in two.",
    corner: "The Mistral straight is interrupted by a chicane, which is where the passes happen.",
  },
  watkins_glen: {
    line: "Watkins Glen in upstate New York, fast, hilly and lined with trees the whole way round.",
    corner: "The esses climb away from the start line at a speed that leaves no room for a mistake.",
  },
  zolder: {
    line: "Zolder, in the Belgian pine woods, a short lap of hard braking and awkward kerbs.",
    corner: "The chicane named for Gilles Villeneuve breaks up the fastest part of the lap.",
  },
};

/** The authored lines for a circuit, or null. Pure. Own keys only, so "constructor" is not a circuit. */
export function forId(id: unknown): Readonly<LoreRow> | null {
  const key = String(id || "");
  return Object.prototype.hasOwnProperty.call(LORE, key) ? LORE[key] ?? null : null;
}

export const ids = (): string[] => Object.keys(LORE);
