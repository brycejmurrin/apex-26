// The lit track material, the fog stack and the sky: the T1.7 slice of f1-game's
// TLX shaders (js/render/three/tsl-lit.js, tsl-sky.js).
//
// BRDF: tsl-lit.js:1726-1743 shades `albedo * (amb + sunColor * NoL * shadow)` with
// `amb = mix(ambGround, ambSky, N.y * 0.5 + 0.5)`, plus a GGX sun specular
// (:1953-1961). three's physical model computes exactly that diffuse form with a
// HemisphereLight and a DirectionalLight, divided by pi (BRDF_Lambert), so both
// lights run at intensity pi (`LIGHT_SCALE`) and the material is a vertex-coloured
// MeshStandardNodeMaterial. TODO(lane-render lighting wave): port the 15 procedural
// track materials keyed by the `mat` attribute, wetness and the lamp loop.
//
// Fog: the squared-exponential height fog with sun in-scatter, constant for constant
// from tsl-lit.js:2166-2196, applied through `scene.fogNode` so every NodeMaterial in
// the scene (cars included) gets it.
//
// Sky: `scene.backgroundNode`, the gradient + sun disc of tsl-sky.js:507-519 and
// :685-705 at its day defaults (no clouds, stars or overcast yet). A background node
// costs no scene object, so the sky adds no per-object JS work.
import { Color, MeshStandardNodeMaterial, Vector3 } from "three/webgpu";
import {
  abs,
  cameraPosition,
  dot,
  exp,
  float,
  fog,
  Fn,
  length,
  max,
  mix,
  normalize,
  positionWorld,
  positionWorldDirection,
  pow,
  select,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";

/** three's Lambert divides by pi; TLX's does not (see header). */
export const LIGHT_SCALE = Math.PI;

/** Frame uniforms shared by fog and sky. Defaults are tsl-lit.js:178-184 / tsl-sky.js:118-135. */
export function makeFrameUniforms() {
  return {
    sunDir: uniform(new Vector3(0.4, 0.75, 0.3).normalize()),
    sunColor: uniform(new Vector3(1.0, 0.98, 0.9)),
    fogColor: uniform(new Vector3(0.62, 0.74, 0.88)),
    fogDensity: uniform(0.0),
    /** tsl-lit.js `fogHeight`: height falloff per metre above the camera (0 = off). */
    fogHeight: uniform(0.0),
    /** FOG SUN CORE knob, tight pow16 in-scatter. */
    fogSunCore: uniform(0.0),
    /** FOG WARM/COOL white balance. */
    fogTint: uniform(0.0),
    zenith: uniform(new Vector3(0.18, 0.4, 0.78)),
    horizon: uniform(new Vector3(0.62, 0.74, 0.88)),
    skyGrad: uniform(0.35),
    /** tsl-sky.js:254-256 at golden = 0, sunDiscSize = 1. */
    discOut: uniform(0.018),
    discIn: uniform(0.006),
    discCore: uniform(new Vector3(2.3, 2.2, 1.9)),
    sunCorona: uniform(1.0),
  };
}
export type FrameUniforms = ReturnType<typeof makeFrameUniforms>;

/** One material for every track mesh: one pipeline, no per-mesh state. */
export function makeTrackMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  m.color = new Color(1, 1, 1);
  m.name = "a26-track-lit";
  return m;
}

/** tsl-lit.js:2166-2196, the `fogDensity > 0` branch (ground mist and lamp fog wait for the lighting wave). */
export function makeFogNode(U: FrameUniforms) {
  return fog(
    Fn(() => {
      const wp = positionWorld;
      const toFrag = wp.sub(cameraPosition);
      const rd = normalize(toFrag);
      const sunAmount = max(dot(rd, U.sunDir), 0.0);
      const sunAmt = max(sunAmount, 1e-4);
      const sunAmt2 = sunAmt.mul(sunAmt);
      const sunAmt4 = sunAmt2.mul(sunAmt2).toVar();
      const sunAmt8 = sunAmt4.mul(sunAmt4);
      const fogSun = vec3(U.sunColor).div(max(float(1.0), max(U.sunColor.x, max(U.sunColor.y, U.sunColor.z))));
      const fogCol = mix(vec3(U.fogColor), fogSun, sunAmt4).toVar();
      fogCol.addAssign(fogSun.mul(sunAmt8.mul(sunAmt8)).mul(U.fogSunCore));
      fogCol.mulAssign(
        vec3(
          float(1.0).add(max(U.fogTint, 0.0).mul(0.25)).sub(max(U.fogTint.negate(), 0.0).mul(0.12)),
          float(1.0).sub(abs(U.fogTint).mul(0.02)),
          float(1.0).sub(max(U.fogTint, 0.0).mul(0.25)).add(max(U.fogTint.negate(), 0.0).mul(0.18)),
        ),
      );
      return fogCol;
    })(),
    Fn(() => {
      const wp = positionWorld;
      const vd = length(wp.sub(cameraPosition));
      const heightAtten = select(
        U.fogHeight.greaterThan(0.0),
        exp(max(wp.y.sub(cameraPosition.y), 0.0).negate().mul(U.fogHeight)),
        float(1.0),
      );
      const fd = vd.mul(U.fogDensity).mul(heightAtten);
      return exp(fd.mul(fd).negate()).oneMinus();
    })(),
  );
}

/** tsl-sky.js:507-519 gradient + :685-705 aureole-free corona ring and disc, day only. */
export function makeSkyNode(U: FrameUniforms) {
  return Fn(() => {
    const dir = normalize(positionWorldDirection).toVar();
    const up = dir.y;
    const sd = max(dot(dir, U.sunDir), 0.0).toVar();
    // Below the horizon tsl-sky paints an earth colour; until that ports, hold the horizon.
    const c = mix(vec3(U.horizon), vec3(U.zenith), pow(max(up, 0.0), U.skyGrad)).toVar();
    c.addAssign(vec3(1.0, 0.95, 0.85).mul(pow(sd, 300.0)).mul(0.95).mul(U.sunCorona));
    const dd = dir.sub(vec3(U.sunDir).mul(sd));
    // tsl-sky.js:701 `length(vec2(length(dd.xz), dd.y * squash))` with squash = 0
    // (it refracts only near the horizon).
    const perp = length(dd.xz);
    c.addAssign(vec3(U.discCore).mul(smoothstep(U.discOut, U.discIn, perp)));
    return c;
  })();
}
