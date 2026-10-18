// Car surface SHADE CONTRACT: the numbers the car material (./three.ts) reads for carbon,
// gloss, matte, metal and the extended finishes. Ported verbatim from f1-game
// js/car/car-material-shade.js:15-124.

// CARBON WEAVE — exposed parts (surface 21) and bare-weave finish (31).
// Fade keeps the 3.3 cm cross-hatch from moire at range; near-garage and
// near-track keep the twill readable.
const CARBON = Object.freeze({
  freq: 190.0,            // object-space cycles (~3.3 cm at scale)
  fadeStartM: 10.0,       // full weave closer than this
  fadeEndM: 20.0,         // mean weave beyond this (was 8..16)
  normalAmp: 0.26,        // twill micro-normal tilt (was 0.18)
  lacquer: 0.42,          // clearcoat ceiling — F1 carbon is clearcoated (was 0.30)
  metalness: 0.08,
  specular: 0.48,
  roughFloor: 0.52,       // was 0.56; a touch glossier lacquer under the weave
  roughRipple: 0.12,      // * (weave - 0.5)
  // Exposed carbon PARTS keep vertex colour; amplify the weave on albedo.
  partAlbedoMean: 0.88,   // was 0.93
  partAlbedoAmp: 0.24,    // was 0.14
  // Bare-weave FINISH crushes livery toward resin, then lays the twill.
  finishCrushDark: 0.16,
  finishResin: Object.freeze([0.030, 0.031, 0.035]),
  finishCrushLit: 0.28,
  finishMix: 0.25,
  finishAlbedoMean: 0.84, // was 0.86
  finishAlbedoAmp: 0.32,  // was 0.28
});

// GLOSS paint (surface 20, the default — FINISH_SURFACE has no gloss row).
// Clearcoat + env mirror carry the shine; orange-peel is a whisper under it.
const GLOSS = Object.freeze({
  peelAmp: 0.28,          // micro-normal strength (was 0.22) — garage shimmer
  peelFadeStartM: 18.0,
  peelFadeSpanM: 50.0,
});

// MATTE paint (FINISH_SURFACE.matte → 28). Chalky: no clearcoat, high rough,
// low specular. Must stay flatter than satin/panel (26, rough ≥ 0.72).
const MATTE = Object.freeze({
  clearcoat: 0.0,
  metalness: 0.0,
  specular: 0.11,         // was 0.16
  roughFloor: 0.92,       // was 0.88
});

// METAL / titanium bits (surface 23): halo hoop, exhaust tips, hardware.
// Dark albedos (HALO ~0.22) get a mild env boost so titanium reads at garage
// distance without blowing bright chrome-ish hubs. Roughness stays a narrow
// machined band — not mirror, not brushed satin (29).
const METAL = Object.freeze({
  metalnessFloor: 0.82,   // was 0.78
  specular: 1.0,
  roughCeil: 0.18,        // was 0.16 — slightly less mirror, more titanium
  // Env boost for dark metals: metAdd *= 1 + (1 - saturate(lum * darkLumScale)) * darkEnvBoost
  darkLumScale: 4.0,
  darkEnvBoost: 0.32,
});

// TINTED CHROME (FINISH_SURFACE.tinted -> 36). Mirror response of chrome (27: clearcoat >= 0.85, metalness
// >= 0.55, specular 1, rough <= 0.09). The lacquer env reflection is multiplied by the livery hue
// (addCC *= mix(1, albedo / max(maxChannel(albedo), chromaFloor), envTint)) AND, after the metal block, the whole lit
// colour is multiplied by that hue (finalTint) — the env terms alone left a red car pink, because the white sun glint,
// sky and metal reflections dominate. White/grey paint (hue 1) stays chrome.
const TINTED = Object.freeze({
  envTint: 0.88,          // how much of the livery hue the lacquer reflection takes
  chromaFloor: 0.04,      // max-channel floor, so near-black paint cannot divide by ~0
  finalTint: true,        // lit colour *= hue after the metal block
});

// CHAMELEON (FINISH_SURFACE.chameleon -> 37). Pearl's classification (clearcoat >= 0.70, metalness
// >= 0.25, rough <= 0.22). The albedo is NOT blended (the white clearcoat/metal terms washed any albedo-only flip to
// icy silver at every angle): after the metal block the lit colour is multiplied by mix(teamHue, flipHue, flip) with
// flip = smoothstep(flipFresLo, flipFresHi, fresnel) * flipWeight. Pearl 30 itself is untouched.
const CHAMELEON = Object.freeze({
  flipFresLo: 0.58,
  flipFresHi: 1.00,
  flipWeight: 0.90,
  flipHue: Object.freeze([0.25, 0.55, 1.0]),
  chromaFloor: 0.04,
});

// METALLIC FLAKE (FINISH_SURFACE.flake -> 34). A PAINT response (gloss clearcoat + env mirror) with
// metalness >= metalness, plus object-space hash flakes: albedo *= 1 + ((h - 0.5) * grainAmp +
// (smoothstep(sparkLo, 1, h) - sparkMean) * sparkGain) * fade, specular += spark * specGain * fade.
// fade = 1 inside fadeStartM, 0 from fadeEndM (the livery colour beyond ~26 m, so nothing can moire).
// The albedo term is mean-preserving (sparkMean = mean of the smoothstep spark term = (1 - sparkLo) / 2), so the fade has no pop.
const FLAKE = Object.freeze({
  cellsPerM: 140.0,       // object-space cells per metre (~7 mm)
  fadeStartM: 10.0,
  fadeSpanM: 16.0,        // fadeEndM = fadeStartM + fadeSpanM = 26 m
  grainAmp: 0.30,
  sparkLo: 0.82,
  sparkMean: 0.09,
  sparkGain: 0.90,
  specGain: 0.40,
  metalness: 0.35,
});

// CANDY (FINISH_SURFACE.candy -> 35). Paint response with a high-gloss lacquer (clearcoat >= clearcoat),
// albedo = max(mix(lum, albedo, satBoost), 0) * darken, the lacquer's env reflection tinted by the
// livery hue (envTint) and a saturated Fresnel rim: color += hue * ccF * rimGain, where hue = albedo /
// max(maxChannel, chromaFloor).
const CANDY = Object.freeze({
  satBoost: 1.35,
  darken: 0.62,
  clearcoat: 0.90,
  envTint: 0.55,
  rimGain: 0.45,
  chromaFloor: 0.04,
});

export const CarMaterialShade = Object.freeze({ CARBON, GLOSS, MATTE, METAL, TINTED, CHAMELEON, FLAKE, CANDY });
