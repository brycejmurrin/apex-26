// The three.js side of the fx batches: a `ParticleSink` + `SkidSink` that turns
// ./particles.ts and ./skidmarks.ts vertex streams into three meshes.
//
// f1-game drew these through its gfx facade; this is the TLX (three/webgpu) backend's
// version of it, ported:
//   - materials: js/render/three/tsl-fx.js:19-51 `fxMaterial` (transparent, no depth
//     write, custom blend with dst alpha kept), :108-125 the skid trail, :181-191
//     `billboardPosition`, :218-252 `particleMaterial` (soft disc, sphere-lit alpha
//     group, exp² fog on the eye distance) and :238-246 its frame uniforms;
//   - streams: js/render/three/tlx.js:5335-5346 `drawSkidBatch` and :5419-5440
//     `drawParticles` (one dynamic interleaved stream per blend group, re-upload only
//     when the payload changed, draw range = the live vertex count).
// Not ported: the SSR tag MRT (tsl-fx.js:85-90; no SSR pass yet), the R9 buffer wrap
// and pipeline warm-up (perf passes), and the per-record pool (three's scene graph
// holds the three meshes instead; `beginFrame()` hides them until drawn again).
//
// TODO(lane-render): feed `uniforms` from the frame lights / fog each frame (f1-game
// glx.js sets them keyMul/ambientMul-scaled) and add `group` to the scene; until then
// they hold tsl-fx.js's defaults. World frame: the positions are the producer's world
// metres as given (no handedness flip here).
import {
  AddEquation,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  Vector3,
  ZeroFactor,
} from "three/webgpu";
import {
  abs,
  attribute,
  cameraPosition,
  cross,
  Discard,
  dot,
  exp,
  float,
  Fn,
  length,
  max,
  mix,
  normalize,
  positionGeometry,
  smoothstep,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import type { ParticleSink } from "./particles";
import type { SkidSink } from "./skidmarks";

/** Floats per particle vertex: [cornerX, cornerY, x, y, z, r, g, b, size, alpha]. */
export const PARTICLE_STRIDE = 10;
/** Floats per skid vertex: [x, y, z, u, v]. */
export const SKID_STRIDE = 5;

/** tsl-fx.js:238-246, the fx-local frame block (defaults as there). */
export function makeFxUniforms() {
  return {
    sunDir: uniform(new Vector3(0.4, 0.8, 0.4)),
    sunColor: uniform(new Vector3(1.0, 0.98, 0.9)),     // keyMul-scaled
    ambSky: uniform(new Vector3(0.3, 0.32, 0.36)),      // ambientMul-scaled
    ambGround: uniform(new Vector3(0.2, 0.19, 0.18)),
    fogColor: uniform(new Vector3(0.5, 0.6, 0.7)),      // the lit pass's fog (particles)
    fogDensity: uniform(0.0),                           // fogDensityMul-scaled
  };
}
export type FxUniforms = ReturnType<typeof makeFxUniforms>;

interface FxMaterialOpts { readonly additive?: boolean; readonly offset?: boolean; readonly doubleSided?: boolean; readonly name: string }

// Shared FX render state: transparent, no depth write, depth test, and the
// blend-stage alpha mask (dst alpha preserved). additive -> ONE/ONE like the GLX
// glow/spark groups; else SRC_ALPHA/ONE_MINUS_SRC_ALPHA.
function fxMaterial(o: FxMaterialOpts): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial();
  m.name = o.name;
  m.transparent = true;
  m.depthWrite = false;
  m.depthTest = true;
  m.fog = false;
  m.blending = CustomBlending;
  m.blendEquation = AddEquation;
  m.blendSrc = o.additive ? OneFactor : SrcAlphaFactor;
  m.blendDst = o.additive ? OneFactor : OneMinusSrcAlphaFactor;
  m.blendEquationAlpha = AddEquation;
  m.blendSrcAlpha = ZeroFactor;   // dst alpha preserved (SSR tag / canvas)
  m.blendDstAlpha = OneFactor;
  if (o.offset) {
    // Decals sit ON the road: GLX's ROAD_BIAS (-4,-8) over an UNBIASED road.
    m.polygonOffset = true;
    m.polygonOffsetFactor = -4;
    m.polygonOffsetUnits = -8;
  }
  // GLX disables CULL_FACE and draws ONE pass. three splits a transparent
  // DoubleSide material into a back pass and a front pass unless
  // forceSinglePass is set — two draws and two pipelines per FX record. Every
  // double-sided FX surface is a billboard, a road ribbon or a flat decal,
  // where the back/front split orders nothing.
  if (o.doubleSided) { m.side = DoubleSide; m.forceSinglePass = true; }
  m.lights = false;
  return m;
}

/** tsl-fx.js:98-100 the mark falloff: soft across, softer along, 0.38 peak. */
function skidMaterial(): MeshBasicNodeMaterial {
  const m = fxMaterial({ offset: true, name: "a26-fx-skid" });
  m.colorNode = vec3(0.0);
  m.opacityNode = Fn(() => {
    const uvv = vec2(attribute("uv", "vec2")).toVar();
    return smoothstep(float(1.0), float(0.4), abs(uvv.x))
      .mul(smoothstep(float(1.0), float(0.3), abs(uvv.y))).mul(0.38);
  })();
  return m;
}

// Billboard corner expansion (GLOW_VS / PARTICLE_VS). The record's centre rides in
// "position" so three's draw count derives naturally; corner is -1..1.
function billboardPosition() {
  return Fn(() => {
    const ctr = vec3(positionGeometry).toVar();
    const c = vec2(attribute("fxCorner", "vec2")).toVar();
    const size = float(attribute("fxSize", "float"));
    const fwd = normalize(cameraPosition.sub(ctr));
    const right = normalize(cross(vec3(0.0, 1.0, 0.0), fwd).add(vec3(1e-4, 0.0, 0.0)));
    const upv = cross(fwd, right);
    return ctr.add(right.mul(c.x).add(upv.mul(c.y)).mul(size));
  })();
}

// Lit + fogged (GLX PARTICLE_FS parity, 2026-10-01): the alpha group is shaded as a
// small sphere — hemisphere ambient on the quad's up plus a wrap of the key, floodlit
// floor 0.18 — and both groups take the lit pass's exp² fog on the eye distance
// (alpha → fog colour, additive → out).
function particleMaterial(U: FxUniforms, additive: boolean): MeshBasicNodeMaterial {
  const m = fxMaterial({ additive, doubleSided: true, name: additive ? "a26-fx-pt-add" : "a26-fx-pt" });
  m.positionNode = billboardPosition();
  const soft = Fn(() => {
    const c = vec2(attribute("fxCorner", "vec2")).toVar();
    const fall = max(float(1.0).sub(dot(c, c)), 0.0).toVar();
    // THE CORNERS OUTSIDE THE DISC (1 - pi/4 = 21 % of every particle and rain
    // quad) blend exactly nothing: discarding them is bit-identical and skips the
    // blend (TLX perf hunt E7). No depth write on this pass, so early-Z is unaffected.
    Discard(fall.lessThanEqual(0.0));
    fall.mulAssign(fall);            // soft-disc falloff, zero at the rim
    return float(attribute("fxAlpha", "float")).mul(fall);
  })();
  const col = Fn(() => {
    const c = vec3(attribute("fxColor", "vec3")).toVar();
    if (!additive) {
      const up = vec2(attribute("fxCorner", "vec2")).y.mul(0.5).add(0.5);
      const lit = mix(vec3(U.ambGround), vec3(U.ambSky), up).add(vec3(U.sunColor).mul(0.45));
      c.mulAssign(max(lit, vec3(0.18)));
    }
    const fd = length(cameraPosition.sub(vec3(positionGeometry))).mul(U.fogDensity);
    const fogK = float(1.0).sub(exp(fd.mul(fd).negate()));
    return additive ? c.mul(fogK.oneMinus()) : mix(c, vec3(U.fogColor), fogK);
  })();
  if (additive) {                    // vec4(col*a, 1) into ONE/ONE
    m.colorNode = col.mul(soft);
    m.opacityNode = float(1.0);
  } else {                           // vec4(col, a) classic alpha
    m.colorNode = col;
    m.opacityNode = soft;
  }
  return m;
}

/** One dynamic interleaved vertex stream drawn by one mesh (tlx.js ensureStream). */
interface Stream {
  readonly stride: number;
  readonly layout: readonly (readonly [name: string, size: number, offset: number])[];
  readonly mesh: Mesh<BufferGeometry, MeshBasicNodeMaterial>;
  cap: number;               // vertices
  buf: InterleavedBuffer;
  payload: Float32Array | null;
  payloadCount: number;
}

function makeGeometry(stream: Pick<Stream, "stride" | "layout">, capVerts: number): { geo: BufferGeometry; buf: InterleavedBuffer } {
  const buf = new InterleavedBuffer(new Float32Array(capVerts * stream.stride), stream.stride);
  buf.setUsage(DynamicDrawUsage);
  const geo = new BufferGeometry();
  for (const [name, size, offset] of stream.layout) geo.setAttribute(name, new InterleavedBufferAttribute(buf, size, offset));
  geo.setDrawRange(0, 0);
  return { geo, buf };
}

function makeStream(layout: Stream["layout"], stride: number, mat: MeshBasicNodeMaterial, name: string): Stream {
  const capVerts = 6;
  const { geo, buf } = makeGeometry({ stride, layout }, capVerts);
  const mesh = new Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = false;          // a world-space batch: its bounds change every frame
  mesh.matrixAutoUpdate = false;       // identity model matrix (world-space positions)
  mesh.visible = false;
  return { stride, layout, mesh, cap: capVerts, buf, payload: null, payloadCount: 0 };
}

/** Grow to hold `verts` vertices; true when the geometry was replaced (must upload). */
function ensureStream(s: Stream, verts: number): boolean {
  if (verts <= s.cap) return false;
  const cap = Math.max(verts, s.cap * 2);
  const { geo, buf } = makeGeometry(s, cap);
  s.mesh.geometry.dispose();
  s.mesh.geometry = geo;
  s.buf = buf;
  s.cap = cap;
  s.payload = null;
  return true;
}

function upload(s: Stream, data: Float32Array, floatCount: number): void {
  const arr = s.buf.array as Float32Array;
  arr.set(data.length <= floatCount ? data : data.subarray(0, floatCount));
  s.buf.clearUpdateRanges();
  s.buf.addUpdateRange(0, floatCount);
  s.buf.needsUpdate = true;
}

const PARTICLE_LAYOUT = [["fxCorner", 2, 0], ["position", 3, 2], ["fxColor", 3, 5], ["fxSize", 1, 8], ["fxAlpha", 1, 9]] as const;
const SKID_LAYOUT = [["position", 3, 0], ["uv", 2, 3]] as const;

export interface FxThreeOptions {
  /** The mobile memory tier: ./particles.ts sizes its pool from this (gfx.mobileTier). */
  readonly mobileTier?: boolean;
}

/** The fx batches as three meshes. Add `group` to the scene once; call `beginFrame()`
 *  before the frame's particles.draw() / skids.draw(this). */
export class FxThree implements ParticleSink, SkidSink {
  readonly group = new Group();
  readonly uniforms: FxUniforms = makeFxUniforms();
  readonly mobileTier: boolean;
  private readonly particles: readonly [Stream, Stream];
  private readonly skid: Stream;

  constructor(opts: FxThreeOptions = {}) {
    this.mobileTier = !!opts.mobileTier;
    this.group.name = "a26-fx";
    this.skid = makeStream(SKID_LAYOUT, SKID_STRIDE, skidMaterial(), "a26-fx-skid");
    this.particles = [
      makeStream(PARTICLE_LAYOUT, PARTICLE_STRIDE, particleMaterial(this.uniforms, false), "a26-fx-particles"),
      makeStream(PARTICLE_LAYOUT, PARTICLE_STRIDE, particleMaterial(this.uniforms, true), "a26-fx-sparks"),
    ];
    // Submission order as f1-game's game.js render(): skid trail (on the road), then
    // the alpha batch, then the additive one.
    this.skid.mesh.renderOrder = 1;
    this.particles[0].mesh.renderOrder = 2;
    this.particles[1].mesh.renderOrder = 3;
    this.group.add(this.skid.mesh, this.particles[0].mesh, this.particles[1].mesh);
  }

  /** Hide every batch; this frame's draw calls show what they draw (tlx.js resetRecs). */
  beginFrame(): void {
    this.skid.mesh.visible = false;
    this.particles[0].mesh.visible = false;
    this.particles[1].mesh.visible = false;
  }

  /** tlx.js:5419-5440. */
  drawParticles(data: Float32Array, floatCount: number, additive: boolean, dirty: boolean): void {
    if (!(floatCount > 0)) return;
    const s = this.particles[additive ? 1 : 0];
    const verts = (floatCount / PARTICLE_STRIDE) | 0;
    const fresh = ensureStream(s, verts);
    if (fresh || dirty !== false || s.payload !== data || s.payloadCount !== floatCount) {
      s.payload = data; s.payloadCount = floatCount;
      upload(s, data, floatCount);
    }
    s.mesh.geometry.setDrawRange(0, verts);
    s.mesh.visible = true;
  }

  /** tlx.js:5335-5346. Always draws the whole batch (true). */
  drawSkidBatch(verts: Float32Array, vertCount: number, dirty: boolean): boolean {
    if (!(vertCount > 0)) return true;
    const s = this.skid;
    const fresh = ensureStream(s, vertCount);
    if (dirty || fresh) upload(s, verts, vertCount * SKID_STRIDE);
    s.mesh.geometry.setDrawRange(0, vertCount);
    s.mesh.visible = true;
    return true;
  }

  dispose(): void {
    for (const s of [this.skid, ...this.particles]) {
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
    }
    this.group.removeFromParent();
  }
}
