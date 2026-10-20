/**
 * The garage scene on three.js: a GarageGfx (types.ts, f1-game's renderer
 * facade as scene.js calls it) whose meshes are three objects under one Group.
 *
 * f1-game's facade is immediate-mode — the scene calls draw(mesh, matrix, opts)
 * for each object every frame, sometimes the same mesh several times (the two
 * mechanics). three is retained-mode, so each mesh handle keeps a POOL of Mesh
 * objects sharing one BufferGeometry: beginFrame() hides them all, each draw
 * shows the next one under the given column-major matrix. Draw order is kept
 * as renderOrder so the room-first / reflection-after / decals-last order of
 * scene.js:1095-1194 survives.
 *
 * Geometry goes through src/render/geometry.ts buildGeometry (f1-game's TLX
 * buildGeometry: position, normal, colour, `mat`), the same path the track
 * meshes take. The materials are a first cut: vertex-coloured
 * MeshStandardNodeMaterial with the draw's roughness / metalness, an unlit
 * vertex-colour material for the emissive LED draw, and an unlit textured
 * decal material. TODO(lane-render): the garage pass proper — the procedural
 * `mat` materials (CONCRETE / METAL / ASPHALT), the stride-15 lamp rig
 * (scene.ts live()), the decal shader's glow and the mirror depth bias.
 */
import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color, DoubleSide, Group, Mesh, MeshBasicNodeMaterial,
  MeshStandardNodeMaterial, SRGBColorSpace, type Material, type Texture,
} from "three/webgpu";
import { buildGeometry } from "../../render/geometry";
import type { MeshData } from "../../contracts/render";
import type { MeshAcc, TexAcc } from "./prims";
import type { DecalOpts, DrawOpts, GarageCanvas, GarageGfx, GfxMesh, GfxTexture } from "./types";

/** An accumulator as typed arrays (render MeshData). Index width follows the vertex count. */
export function toMeshData(a: MeshAcc): MeshData {
  const verts = a.pos.length / 3;
  const base = {
    pos: new Float32Array(a.pos), nrm: new Float32Array(a.nrm), col: new Float32Array(a.col),
    idx: verts > 65535 ? new Uint32Array(a.idx) : new Uint16Array(a.idx),
  };
  return a.mat ? { ...base, mat: new Float32Array(a.mat) } : base;
}

/** An accumulator as a BufferGeometry (position, normal, color, mat, trk). */
export function geometryOf(a: MeshAcc): BufferGeometry {
  return buildGeometry(toMeshData(a));
}

/** A textured (decal) accumulator as a BufferGeometry (position, normal, uv). */
export function texGeometryOf(a: TexAcc): BufferGeometry {
  const g = new BufferGeometry();
  const verts = a.pos.length / 3;
  g.setAttribute("position", new BufferAttribute(new Float32Array(a.pos), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(a.nrm), 3));
  g.setAttribute("uv", new BufferAttribute(new Float32Array(a.uv), 2));
  g.setIndex(new BufferAttribute(verts > 65535 ? new Uint32Array(a.idx) : new Uint16Array(a.idx), 1));
  g.computeBoundingSphere();
  return g;
}

/** A mesh handle: one geometry, a pool of three Meshes drawn from it. */
class PooledMesh {
  readonly pool: Mesh[] = [];
  used = 0;
  constructor(readonly geometry: BufferGeometry, readonly decal: boolean) {}
}
/** A texture handle. */
class TexHandle {
  constructor(readonly texture: Texture) {}
}

export interface ThreeGarageGfx extends GarageGfx {
  /** Add this to the scene; every garage object lives under it. */
  readonly root: Group;
  /** Hide last frame's draws; call before GarageScene.draw each frame. */
  beginFrame(): void;
  /** Free every geometry, material and texture this facade made. */
  dispose(): void;
  /** Meshes drawn this frame (diagnostics). */
  drawn(): number;
}

export interface ThreeGarageOptions {
  readonly isMobile?: boolean;
}

function litMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ vertexColors: true });
  m.color = new Color(1, 1, 1);
  m.name = "a26-garage-lit";
  return m;
}
function emissiveMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ vertexColors: true });
  m.name = "a26-garage-led";
  return m;
}
function decalMaterial(): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide });
  m.name = "a26-garage-decal";
  return m;
}

/** A GarageGfx on three.js. */
export function createThreeGarageGfx(opts: ThreeGarageOptions = {}): ThreeGarageGfx {
  const root = new Group();
  root.name = "garage";
  const meshes = new Set<PooledMesh>();
  const textures = new Set<TexHandle>();
  let order = 0;

  const asMesh = (h: GfxMesh): PooledMesh => {
    if (!(h instanceof PooledMesh)) throw new Error("garage gfx: not a mesh handle");
    return h;
  };
  const asTex = (h: GfxTexture): TexHandle => {
    if (!(h instanceof TexHandle)) throw new Error("garage gfx: not a texture handle");
    return h;
  };
  function next(h: PooledMesh, make: () => Material): Mesh {
    let m = h.pool[h.used];
    if (!m) {
      m = new Mesh(h.geometry, make());
      m.matrixAutoUpdate = false;
      m.frustumCulled = false;
      h.pool.push(m);
      root.add(m);
    }
    h.used++;
    m.visible = true;
    m.renderOrder = order++;
    return m;
  }
  function place(m: Mesh, matrix: Float32Array): void {
    m.matrix.fromArray(matrix);
    m.matrixWorldNeedsUpdate = true;
  }

  const gfx: ThreeGarageGfx = {
    root,
    isMobile: !!opts.isMobile,
    createMesh(data: MeshAcc): GfxMesh {
      const h = new PooledMesh(geometryOf(data), false);
      meshes.add(h);
      return h;
    },
    createTexMesh(data: TexAcc): GfxMesh {
      const h = new PooledMesh(texGeometryOf(data), true);
      meshes.add(h);
      return h;
    },
    createTexture(src: GarageCanvas): GfxTexture | null {
      // CanvasTexture uploads with flipY (FLIP_Y), which the atlas UVs assume.
      const t = new CanvasTexture(src as unknown as HTMLCanvasElement);
      t.colorSpace = SRGBColorSpace;
      const h = new TexHandle(t);
      textures.add(h);
      return h;
    },
    freeMesh(mesh: GfxMesh): void {
      const h = asMesh(mesh);
      for (const m of h.pool) { root.remove(m); (m.material as Material).dispose(); }
      h.pool.length = 0;
      h.geometry.dispose();
      meshes.delete(h);
    },
    freeTexture(tex: GfxTexture): void {
      const h = asTex(tex);
      h.texture.dispose();
      textures.delete(h);
    },
    draw(mesh: GfxMesh, matrix: Float32Array, o: DrawOpts): void {
      const h = asMesh(mesh);
      const emissive = o.emissive !== undefined;
      const m = next(h, emissive ? emissiveMaterial : litMaterial);
      const mat = m.material as Material;
      if (mat instanceof MeshStandardNodeMaterial) {
        mat.roughness = o.roughness ?? 1;
        mat.metalness = o.metalness ?? 0;
      }
      const alpha = o.alpha ?? 1;
      mat.transparent = alpha < 1;
      mat.opacity = alpha;
      // MIRROR_RESOLVE's depthBias: [factor, units] as polygon offset.
      if (o.depthBias) {
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = o.depthBias[0]!;
        mat.polygonOffsetUnits = o.depthBias[1]!;
      }
      place(m, matrix);
    },
    drawDecal(mesh: GfxMesh, matrix: Float32Array, tex: GfxTexture, _o: DecalOpts): void {
      const h = asMesh(mesh);
      const m = next(h, decalMaterial);
      const mat = m.material as MeshBasicNodeMaterial;
      const t = asTex(tex).texture;
      if (mat.map !== t) { mat.map = t; mat.needsUpdate = true; }
      place(m, matrix);
    },
    beginFrame(): void {
      order = 0;
      for (const h of meshes) {
        for (const m of h.pool) m.visible = false;
        h.used = 0;
      }
    },
    dispose(): void {
      for (const h of [...meshes]) gfx.freeMesh(h);
      for (const h of [...textures]) gfx.freeTexture!(h);
    },
    drawn(): number {
      let n = 0;
      for (const h of meshes) n += h.used;
      return n;
    },
  };
  return gfx;
}
