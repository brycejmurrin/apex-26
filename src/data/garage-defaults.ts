/* GarageDefaults: the SHIPPED DEFAULT garage (parts, liveries, setups,
   team/driver) in one file, as data. Ported verbatim from f1-game
   js/data/garage-defaults.js:1-115 (META/DEF :28-75, deepFreeze/copy :82-94,
   file :97-106, API :108-114).

   WHY THIS EXISTS. Without it a fresh install falls through to call-site
   literals (empty `parts.*` → Parts.DEFAULTS, `livery.*` → "default", and a
   bare team index). Designers tune a garage by hand and export
   GARAGE › TEAM › SAVE GARAGE FILE; this table is that export, applied as the
   miss-path default (never written over an existing player's store).

   The store consults this on every miss for a key named here — the same
   opt-in pattern as ./settings-defaults. A value the player already stored
   still outranks it, so existing saves are never wiped. RESET GARAGE TO
   DEFAULTS clears garage-shaped keys then re-applies GarageDefaults.file().
   TODO(lane-shell): the store (f1-game GameStore.get, js/core/store.js) and
   the reset (js/ui/settings-export.js) are the shell lane's; they call has()/
   get()/file() here and own the `a26.` key prefix — the keys below are
   unprefixed garage keys, as in f1-game.

   The block between the @gen markers is f1-game's generated block, copied
   unchanged apart from the type annotations on META and DEF. f1-game
   regenerates it with tools/gen/garage-defaults.mjs from a GARAGE export;
   re-copy it from there rather than hand-editing. */

/** A JSON value, as a garage export holds. */
export type GarageValue = string | number | boolean | null | readonly GarageValue[] | { readonly [k: string]: GarageValue };

export interface GarageMeta {
  format: string;
  exportedAt: string;
  build: string;
  excluded: string;
  count: number;
}

/** A garage export file (the GARAGE › TEAM › SAVE GARAGE FILE shape). */
export interface GarageFile {
  format: string;
  exportedAt: string;
  build: string;
  excluded: string;
  count: number;
  garage: Record<string, GarageValue>;
}

const META: Readonly<GarageMeta> = {
  "format": "apex26-garage-v1",
  "exportedAt": "2026-10-16T22:00:09.756Z",
  "build": "17179",
  "excluded": "career and season saves, lap records, ghosts, settings, tuners, control bindings, accounts",
  "count": 38
};
const DEF: Readonly<Record<string, GarageValue>> = {
  "driver": 0,
  "livery.alpine": "custom_17893711436331",
  "livery.astonmartin": "custom_17921141028183",
  "livery.audi": "custom_17893716467453",
  "livery.cadillac": "custom_17894116326921",
  "livery.custom.alpine": [{"id":"custom_17893711436331","name":"Custom","c1":[0,0.3764705882352941,0.803921568627451],"c2":[1,0.5294117647058824,0.7372549019607844],"accent":[1,1,1],"wing":[0.08627450980392157,0.08627450980392157,0.08627450980392157],"logo":[1,1,1],"finish":"brushed","spineLogo":"wrap","finShape":"none","spineHeight":"dorsal","spineSide":"logo"}],
  "livery.custom.astonmartin": [{"id":"custom_17921141028183","name":"Custom","c1":[0,0.20392156862745098,0.1450980392156863],"c2":[0.8745098039215686,0.8274509803921568,0.3058823529411765],"stripe":[0,0.20392156862745098,0.1450980392156863],"accent":[0,0.20392156862745098,0.1450980392156863],"pod":[0.08235294117647059,0.08235294117647059,0.08235294117647059],"lower":[0.08235294117647059,0.08235294117647059,0.08235294117647059],"upper":[0,0.20392156862745098,0.1450980392156863],"wing":[0.08235294117647059,0.08235294117647059,0.08235294117647059],"cover":[0,0.29411764705882354,0.19607843137254902],"spineTint":[0,0.29411764705882354,0.19607843137254902],"logo":[0.8745098039215686,0.8274509803921568,0.3058823529411765],"logo3":[0,0.20392156862745098,0.1450980392156863],"wingCarbon":"carbon","finish":"brushed","spineLogo":"cap","finShape":"none","coverVents":"spine","spineHeight":"dorsal","spineSide":"emblem","coverBind":"saddleWrap","finHandoff":"hardCut"}],
  "livery.custom.audi": [{"id":"custom_17893716467453","name":"Custom","c1":[0.2,0.2,0.2],"c2":[0.2,0.2,0.2],"accent":[0,0,0],"wing":[0.054901960784313725,0.054901960784313725,0.054901960784313725],"cover":[0.9803921568627451,0.20784313725490197,0.050980392156862744],"logo":[1,1,1],"logo2":[1,1,1],"logo3":[0.9803921568627451,0.20784313725490197,0.050980392156862744],"wingCarbon":"carbon","finish":"brushed","spineLogo":"wrap","finShape":"none","spineHeight":"dorsal","spineSide":"logo"}],
  "livery.custom.cadillac": [{"id":"custom_17894116326921","name":"Custom","c1":[0.0392156862745098,0.0392156862745098,0.0392156862745098],"c2":[0.9607843137254902,0.9607843137254902,0.9607843137254902],"wing":[0.07058823529411765,0.07058823529411765,0.07058823529411765],"wingCarbon":"carbon","finish":"brushed","spineLogo":"saddle","finShape":"none","spineHeight":"dorsal","spineSide":"logo","bodySplit":"lr"}],
  "livery.custom.ferrari": [{"id":"custom_17921134894571","name":"H","c1":[0.42745098039215684,0,0],"c2":[1,1,1],"accent":[0.9294117647058824,0.796078431372549,0],"wing":[0.10196078431372549,0.10196078431372549,0.10196078431372549],"spineTint":[1,1,1],"saddleTint":[1,1,1],"sideTint":[0.42745098039215684,0,0],"sunTint":[0.42745098039215684,0,0],"bandTint2":[0.42745098039215684,0,0],"logo":[0,0,0],"logo2":[0.9294117647058824,0.796078431372549,0],"logo3":[0,0,0],"finish":"brushed","spineLogo":"saddle","finShape":"none","spineHeight":"dorsal","spineSide":"logo","coverBind":"spineOnly"}],
  "livery.custom.haas": [{"id":"custom_17893761682261","name":"Custom","c1":[1,1,1],"c2":[0.4980392156862745,0.0392156862745098,0],"accent":[0.07450980392156863,0.0784313725490196,0.08627450980392157],"pod":[0.07450980392156863,0.0784313725490196,0.08627450980392157],"wing":[0.09803921568627451,0.09803921568627451,0.09803921568627451],"spineTint":[0.07450980392156863,0.0784313725490196,0.08627450980392157],"logo":[0.4980392156862745,0.0392156862745098,0],"logo2":[0.4980392156862745,0.0392156862745098,0],"wingCarbon":"carbon","finish":"brushed","spineLogo":"fade","finShape":"none","coverVents":"spine","spineHeight":"dorsal","spineSide":"logo","coverBind":"saddleWrap","finHandoff":"hardCut"}],
  "livery.custom.mclaren": [{"id":"custom_17894883626032","name":"Custom","c1":[1,0.5019607843137255,0],"c2":[0,0,0],"accent":[1,1,1],"wing":[0.10980392156862745,0.10980392156862745,0.10980392156862745],"logo":[1,1,1],"wingCarbon":"carbon","finish":"brushed","spineLogo":"panel","finShape":"none","spineHeight":"dorsal","spineSide":"logo"}],
  "livery.custom.mercedes": [{"id":"custom_17921868639491","name":"Custom","c1":[0.043137254901960784,0.054901960784313725,0.08627450980392157],"c2":[0,0.5098039215686274,0.5137254901960784],"stripe":[0.043137254901960784,0.054901960784313725,0.06666666666666667],"noseStripe":[0.043137254901960784,0.054901960784313725,0.08627450980392157],"upper":[0.043137254901960784,0.054901960784313725,0.06666666666666667],"wing":[0.07058823529411765,0.07058823529411765,0.07058823529411765],"rearWing":[0.043137254901960784,0.054901960784313725,0.08627450980392157],"cover":[0.043137254901960784,0.054901960784313725,0.06666666666666667],"sunTint":[0.5215686274509804,0.5215686274509804,0.5215686274509804],"logo":[0.9215686274509803,0.9215686274509803,0.9215686274509803],"logo2":[0.9215686274509803,0.9215686274509803,0.9215686274509803],"wingCarbon":"carbon","finish":"brushed","finStyle":"stars","spineLogo":"wrap","finShape":"none","coverVents":"gills","spineHeight":"dorsal","spineSide":"logo","coverBind":"saddleWrap"}],
  "livery.custom.racingbulls": [{"id":"custom_17893713980192","name":"Custom","c1":[0.9568627450980393,0.9411764705882353,0.9254901960784314],"c2":[0,0.058823529411764705,0.47058823529411764],"accent":[1,0.22745098039215686,0.18823529411764706],"wing":[0,0,0],"cover":[0.7568627450980392,0.5294117647058824,0],"spineTint":[0.9568627450980393,0.9411764705882353,0.9254901960784314],"sideTint":[1,0.22745098039215686,0.18823529411764706],"logo2":[1,0.22745098039215686,0.18823529411764706],"finish":"brushed","spineLogo":"wrap","finShape":"none","spineHeight":"dorsal","spineSide":"logo"}],
  "livery.custom.redbull": [{"id":"custom_17921685243141","name":"Custom","c1":[0.08627450980392157,0.13725490196078433,0.29411764705882354],"c2":[0.8274509803921568,0.5137254901960784,0.00392156862745098],"stripe":[0.08627450980392157,0.13725490196078433,0.29411764705882354],"accent":[0.08627450980392157,0.13725490196078433,0.29411764705882354],"nose":[0.8274509803921568,0.5137254901960784,0.00392156862745098],"pod":[0.2,0.2,0.2],"lower":[0.2,0.2,0.2],"upper":[0.08627450980392157,0.13725490196078433,0.29411764705882354],"wing":[0.2,0.2,0.2],"cover":[0.8274509803921568,0.5137254901960784,0.00392156862745098],"sideTint":[0.08627450980392157,0.13725490196078433,0.29411764705882354],"sunTint":[1,0.7372549019607844,0],"logo":[0.5137254901960784,0.06666666666666667,0],"logo2":[1,0.7372549019607844,0],"logo3":[0.08627450980392157,0.13725490196078433,0.29411764705882354],"wingCarbon":"carbon","finish":"brushed","spineLogo":"wrap","finShape":"none","spineHeight":"dorsal","spineSide":"sash","coverBind":"spineOnly"}],
  "livery.custom.williams": [{"id":"custom_17893764171573","name":"Custom","c1":[0,0.043137254901960784,0.592156862745098],"c2":[1,1,1],"wing":[0.0784313725490196,0.0784313725490196,0.0784313725490196],"finish":"brushed","spineLogo":"wrap","finShape":"none","coverVents":"gills","spineHeight":"dorsal","spineSide":"logo","coverBind":"spineOnly","finHandoff":"hardCut"}],
  "livery.ferrari": "custom_17921134894571",
  "livery.haas": "custom_17893761682261",
  "livery.legends": "default",
  "livery.mclaren": "custom_17894883626032",
  "livery.mercedes": "custom_17921868639491",
  "livery.racingbulls": "custom_17893713980192",
  "livery.redbull": "custom_17921685243141",
  "livery.williams": "custom_17893764171573",
  "parts.alpine": {"engine":"sig_alpine_pu","aero":"sig_alpine_wing","suspension":"sig_alpine_susp","brakes":"sig_alpine_brakes","tyres":"sig_alpine_tyre","ers":"sig_alpine_boost","gearbox":"sig_alpine_gbox","fuel":"sig_alpine_efuel","exhaust":"sig_alpine_exh","floor":"sig_alpine_floor","cockpit":"sig_alpine_cpit","wheels":"sig_alpine_rim"},
  "parts.astonmartin": {"engine":"v_power","aero":"sig_aston_tunnel","suspension":"sig_astonmartin_susp","brakes":"sig_aston_carbon","tyres":"sig_astonmartin_tyre","ers":"sig_astonmartin_ers","gearbox":"sig_astonmartin_gbox","fuel":"sig_astonmartin_fuel","exhaust":"sig_astonmartin_exh","floor":"sig_astonmartin_floor","cockpit":"sig_astonmartin_cpit","wheels":"sig_astonmartin_rim"},
  "parts.audi": {"engine":"manu_audi","aero":"sig_audi_wing","suspension":"sig_audi_damper","brakes":"sig_audi_brakes","tyres":"sig_audi_tyre","ers":"sig_audi_quattro","gearbox":"sig_audi_gbox","fuel":"sig_audi_fuel","exhaust":"sig_audi_exh","floor":"sig_audi_floor","cockpit":"sig_audi_cpit","wheels":"sig_audi_rim"},
  "parts.cadillac": {"engine":"sig_cadillac_pu","aero":"sig_cadillac_lowline","suspension":"sig_cadillac_susp","brakes":"sig_cadillac_brakes","tyres":"sig_cadillac_sprint","ers":"sig_cadillac_ers","gearbox":"sig_cadillac_gbox","fuel":"sig_cadillac_fuel","exhaust":"sig_cadillac_exh","floor":"sig_cadillac_floor","cockpit":"sig_cadillac_cpit","wheels":"sig_cadillac_rim"},
  "parts.ferrari": {"engine":"manu_ferrari","aero":"sig_ferrari_wing","suspension":"sig_ferrari_susp","brakes":"sig_ferrari_brembo","tyres":"sig_ferrari_tyre","ers":"sig_ferrari_ers","gearbox":"standard","fuel":"sig_ferrari_fuel","exhaust":"sig_ferrari_exh","floor":"sig_ferrari_floor","cockpit":"sig_ferrari_cpit","wheels":"sig_ferrari_rim"},
  "parts.haas": {"engine":"sig_haas_pu","aero":"sig_haas_wing","suspension":"sig_haas_susp","brakes":"sig_haas_carbonmag","tyres":"sig_haas_tyre","ers":"sig_haas_ers","gearbox":"sig_haas_gbox","fuel":"sig_haas_blend","exhaust":"sig_haas_exh","floor":"sig_haas_floor","cockpit":"sig_haas_cpit","wheels":"sig_haas_rim"},
  "parts.legends": {"engine":"highrev","aero":"high","suspension":"active","brakes":"carbon","tyres":"soft","ers":"standard","gearbox":"sequential_pro","fuel":"standard","exhaust":"free_flow","floor":"standard","cockpit":"standard","wheels":"dished"},
  "parts.mclaren": {"engine":"sig_mclaren_pu","aero":"sig_mclaren_flex","suspension":"sig_mclaren_active","brakes":"sig_mclaren_brakes","tyres":"sig_mclaren_tyre","ers":"sig_mclaren_ers","gearbox":"sig_mclaren_gbox","fuel":"sig_mclaren_fuel","exhaust":"sig_mclaren_exh","floor":"sig_mclaren_floor","cockpit":"sig_mclaren_cpit","wheels":"sig_mclaren_rim"},
  "parts.mercedes": {"engine":"sig_mercedes_zero","aero":"sig_mercedes_wing","suspension":"sig_mercedes_susp","brakes":"sig_mercedes_discs","tyres":"sig_mercedes_tyre","ers":"sig_mercedes_ers","gearbox":"sig_mercedes_gbox","fuel":"sig_mercedes_fuel","exhaust":"sig_mercedes_exh","floor":"sig_mercedes_floor","cockpit":"sig_mercedes_cpit","wheels":"sig_mercedes_rim"},
  "parts.racingbulls": {"engine":"sig_racingbulls_pu","aero":"sig_racingbulls_wing","suspension":"sig_racingbulls_susp","brakes":"sig_racingbulls_brakes","tyres":"sig_rb_street","ers":"sig_racingbulls_ers","gearbox":"sig_rb_shortcase","fuel":"sig_racingbulls_fuel","exhaust":"sig_racingbulls_exh","floor":"sig_racingbulls_floor","cockpit":"sig_racingbulls_cpit","wheels":"sig_racingbulls_rim"},
  "parts.redbull": {"engine":"manu_ford","aero":"circuit_adaptive","suspension":"sig_redbull_pullrod","brakes":"sig_redbull_brakes","tyres":"sig_redbull_tyre","ers":"sig_redbull_ers","gearbox":"sig_redbull_gbox","fuel":"sig_redbull_fuel","exhaust":"sig_redbull_exh","floor":"sig_redbull_floor","cockpit":"sig_redbull_cpit","wheels":"standard"},
  "parts.williams": {"engine":"sig_williams_pu","aero":"sig_williams_lowdrag","suspension":"sig_williams_susp","brakes":"sig_williams_brakes","tyres":"sig_williams_tyre","ers":"sig_williams_ers","gearbox":"sig_williams_longshift","fuel":"sig_williams_fuel","exhaust":"sig_williams_exh","floor":"sig_williams_floor","cockpit":"sig_williams_cpit","wheels":"sig_williams_rim"},
  "setup.mercedes": {"arbF":6,"arbR":5,"rideF":24,"rideR":60,"brakeBias":56},
  "team": 3,
};
// @gen-garage-defaults end

// THE SHIPPED TABLE IS NEVER HANDED OUT. get() used to return DEF[k] itself;
// the store returns that on a miss, the garage mutates it in place

// THE SHIPPED TABLE IS NEVER HANDED OUT. get() used to return DEF[k] itself;
// the store returns that on a miss, the garage mutates it in place
// (p[cat] = opt.id), and file() then serialised the mutated table — so RESET
// GARAGE TO DEFAULTS restored the player's own edits. DEF is frozen here and
// every way out is a deep copy (a livery row holds c1/c2 arrays).
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    Object.keys(v).forEach((k) => deepFreeze((v as Record<string, unknown>)[k]));
  }
  return v;
}
// Rebuilt with this realm's literals (a JSON round trip hands back the caller's realm, which deepStrictEqual sees).
function copy(v: GarageValue): GarageValue;
function copy(v: GarageValue | undefined): GarageValue | undefined;
function copy(v: GarageValue | undefined): GarageValue | undefined {
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) return (v as readonly GarageValue[]).map((x) => copy(x));
  const o: Record<string, GarageValue> = {};
  const src = v as { readonly [k: string]: GarageValue };
  Object.keys(src).forEach((k) => { o[k] = copy(src[k] as GarageValue); });
  return o;
}
deepFreeze(DEF);

function file(): GarageFile {
  return {
    format: META.format || "apex26-garage-v1",
    exportedAt: META.exportedAt,
    build: META.build,
    excluded: META.excluded,
    count: Object.keys(DEF).length,
    garage: copy(DEF) as Record<string, GarageValue>,
  };
}

const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(DEF, k);

export const GarageDefaults = Object.freeze({
  has,
  // DEVIATION: f1-game returns copy(DEF[k]) for any k, so get("constructor")
  // handed back Object itself; here a key that is not an own key answers
  // undefined, like any other miss (the store only asks after has()).
  get: (k: string): GarageValue | undefined => (has(k) ? copy(DEF[k]) : undefined),
  keys: (): string[] => Object.keys(DEF),
  meta: (): Readonly<GarageMeta> => META,
  file,
});
