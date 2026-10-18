// The car's one lit material. f1-game classifies car surfaces by a per-vertex id
// (materials.ts SURFACES / FINISH_SURFACE, ids 20-37) and branches per id in its TSL
// lit shader (f1-game js/render/three/tsl-lit.js:1384-1600); here the same id rides a
// `mat` attribute into a MeshStandardNodeMaterial's roughness / metalness / colour /
// emissive nodes. The numbers come from the shade contract (./material-shade.ts) and
// the tsl-lit.js clamps it mirrors. Clearcoat and the env-tint finishes (chrome tint,
// chameleon, pearl flip) wait for the render lane's environment and a physical material.
import {
  attribute, clamp, float, floor, fract, max, min, mix, positionLocal, positionView, select, sin, smoothstep, vec3, vertexColor,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { CarMaterialShade as S } from "./material-shade";

/** Vertex attribute carrying the surface id (one float per vertex). */
export const MAT_ATTRIBUTE = "mat";

export interface CarMaterialOptions {
  /** Default gloss-paint roughness (f1-game game.js car opts; tsl-lit matU.roughness). */
  paintRoughness?: number;
  /** Default paint metalness (f1-game game.js sets 0.12 on paint). */
  paintMetalness?: number;
}

export function createCarMaterial(opts: CarMaterialOptions = {}): MeshStandardNodeMaterial {
  const paintRough = opts.paintRoughness ?? 0.28;
  const paintMetal = opts.paintMetalness ?? 0.12;
  const m = new MeshStandardNodeMaterial();
  m.name = "car";
  m.vertexColors = true;

  const id = floor(attribute(MAT_ATTRIBUTE, "float").add(0.5));
  const is = (n: number) => id.equal(float(n));
  const paint = is(20).or(is(34)).or(is(35));
  const carbon = is(21);
  const carbonFinish = is(31);
  const anyCarbon = carbon.or(carbonFinish);
  const rubber = is(22);
  const metal = is(23);
  const glass = is(24).or(is(32));
  const emissive = is(25);
  const panel = is(26);
  const mirror = is(27).or(is(36));
  const matte = is(28);
  const satinMetal = is(29);
  const iri = is(30).or(is(37));
  const sidewall = is(33);

  // Carbon twill in object space, faded to its mean with view distance so the
  // ~3.3 cm cross-hatch cannot moire (tsl-lit.js:1418; CarMaterialShade.CARBON).
  const wv = positionLocal.xz.mul(S.CARBON.freq).add(positionLocal.y.mul(S.CARBON.freq));
  const dist = positionView.length();
  const wvFade = clamp(dist.sub(S.CARBON.fadeStartM).div(S.CARBON.fadeEndM - S.CARBON.fadeStartM).oneMinus(), 0, 1);
  const weave = sin(wv.x).mul(sin(wv.y)).mul(wvFade).mul(0.5).add(0.5);

  // Metallic flake cells (tsl-lit.js FLAKE; CarMaterialShade.FLAKE), a cheap hash.
  const fkC = floor(positionLocal.mul(S.FLAKE.cellsPerM));
  const fkH = fract(sin(fkC.x.mul(127.1).add(fkC.y.mul(311.7)).add(fkC.z.mul(74.7))).mul(43758.5453));
  const fkF = clamp(dist.sub(S.FLAKE.fadeStartM).div(S.FLAKE.fadeSpanM).oneMinus(), 0, 1);
  const fkS = smoothstep(S.FLAKE.sparkLo, 1.0, fkH);

  const base = vertexColor().xyz;
  const carbonFinishAlbedo = mix(base.mul(S.CARBON.finishCrushDark).add(vec3(...S.CARBON.finishResin)), base.mul(S.CARBON.finishCrushLit), S.CARBON.finishMix)
    .mul(weave.mul(S.CARBON.finishAlbedoAmp).add(S.CARBON.finishAlbedoMean));
  const candyL = base.dot(vec3(0.299, 0.587, 0.114));
  const albedo = select(carbonFinish, carbonFinishAlbedo,
    select(carbon, base.mul(weave.mul(S.CARBON.partAlbedoAmp).add(S.CARBON.partAlbedoMean)),
      select(is(34), base.mul(fkH.sub(0.5).mul(S.FLAKE.grainAmp).add(fkS.sub(S.FLAKE.sparkMean).mul(S.FLAKE.sparkGain)).mul(fkF).add(1.0)),
        select(is(35), max(mix(vec3(candyL), base, S.CANDY.satBoost), vec3(0.0)).mul(S.CANDY.darken), base))));
  m.colorNode = albedo;

  // Roughness clamps (tsl-lit.js:1545-1556).
  const r0 = float(paintRough);
  m.roughnessNode = select(anyCarbon, max(r0, S.CARBON.roughFloor).add(weave.sub(0.5).mul(S.CARBON.roughRipple)),
    select(rubber, max(r0, 0.90),
      select(sidewall, clamp(r0, 0.55, 0.65),
        select(metal, min(r0, S.METAL.roughCeil),
          select(glass, min(r0, 0.13),
            select(emissive, max(r0, 0.32),
              select(panel, max(r0, 0.72),
                select(mirror, min(r0, 0.09),
                  select(matte, max(r0, S.MATTE.roughFloor),
                    select(satinMetal, clamp(r0, 0.24, 0.40),
                      select(iri, min(r0, 0.22), r0)))))))))));

  // Metalness (tsl-lit.js:1442-1460).
  const m0 = float(paintMetal);
  m.metalnessNode = select(metal, max(m0, S.METAL.metalnessFloor),
    select(mirror, max(m0, 0.55),
      select(satinMetal, max(m0, 0.60),
        select(matte, float(S.MATTE.metalness),
          select(iri, max(m0, 0.25),
            select(anyCarbon, float(S.CARBON.metalness),
              select(paint, select(is(34), max(m0, S.FLAKE.metalness), m0), float(0.0))))))));

  // Emissive surfaces (LEDs, rain light) glow in their own colour.
  m.emissiveNode = select(emissive, base, vec3(0.0));
  return m;
}
