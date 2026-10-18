// Post chain: exposure, a light bloom and ACES, ported from f1-game
// js/render/three/tsl-post.js.
//
// - Composite order is tsl-post.js:826-835: exposure, then bloom added under the
//   highlight-suppression knee `1 - clamp(max(c) - 0.7, 0, 0.3) / 0.3 * bloomKnee`,
//   exposure-matched; then ACES on `c / whitePoint` (:911).
// - ACES is the Narkowicz fit with TLX's constants (:508-509, :531-535), not three's
//   ACESFilmicToneMapping (the Hill fit), and the output is written linear: TLX sets
//   `outputColorSpace = LinearSRGBColorSpace` and NoToneMapping (tlx.js:492-493), and
//   f1-game's vertex colours are authored for that.
// - The bloom is three's BloomNode (a mip blur chain) standing in for TLX's fixed
//   bright/down/up passes (tsl-post.js:55-67, :147-191); its threshold is on
//   luminance where TLX's bright pass keys on max(r,g,b) * exposure. TODO(lane-render
//   post wave): port the bright pass and the mip levels.
import { RenderPipeline, type PassNode, type WebGPURenderer, type Scene, type Camera } from "three/webgpu";
import { clamp, float, Fn, max, pass, uniform, vec3, vec4 } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

/** tsl-post.js:482-509 defaults. */
export function makePostUniforms() {
  return {
    exposure: uniform(1.0),
    bloomAmt: uniform(0.55),
    bloomKnee: uniform(0.5),
    whitePoint: uniform(1.0),
    acesA: uniform(2.51),
    acesB: uniform(0.03),
    acesC: uniform(2.43),
    acesD: uniform(0.59),
    acesE: uniform(0.14),
  };
}
export type PostUniforms = ReturnType<typeof makePostUniforms>;

export interface PostChain {
  readonly pipeline: RenderPipeline;
  readonly scenePass: PassNode;
  readonly U: PostUniforms;
  dispose(): void;
}

export function makePost(renderer: WebGPURenderer, scene: Scene, camera: Camera, bloomOn = true): PostChain {
  const U = makePostUniforms();
  const scenePass = pass(scene, camera);
  const sceneCol = scenePass.getTextureNode("output");
  const bloomNode = bloomOn ? bloom(sceneCol, 1.0, 0.4, 0.75) : null;

  const out = Fn(() => {
    const c = vec3(sceneCol.rgb).toVar();
    c.mulAssign(U.exposure);
    if (bloomNode) {
      const bloomSample = vec3(bloomNode.rgb);
      const bloomMask = clamp(max(c.r, max(c.g, c.b)).sub(0.7), 0.0, 0.3).div(0.3).mul(U.bloomKnee).oneMinus();
      c.addAssign(bloomSample.mul(U.bloomAmt).mul(bloomMask).mul(U.exposure));
    }
    const x = max(c.div(max(U.whitePoint, float(1e-3))), vec3(0.0));
    const t = clamp(x.mul(U.acesA.mul(x).add(U.acesB)).div(x.mul(U.acesC.mul(x).add(U.acesD)).add(U.acesE)), 0.0, 1.0);
    return vec4(t, 1.0);
  })();

  const pipeline = new RenderPipeline(renderer, out);
  pipeline.outputColorTransform = false;
  return {
    pipeline,
    scenePass,
    U,
    dispose() {
      bloomNode?.dispose();
      scenePass.dispose();
      pipeline.dispose();
    },
  };
}
