/**
 * PitSigns: each team's identity on the OUTSIDE of its pit garage. One canvas
 * atlas of twelve fascia cells (crest, the team's short code, the name where
 * it fits), one texMesh of twelve quads a centimetre proud of the lintels
 * (src/track/scenery/pits.ts lays them out as track.pitSigns from pit.ts
 * SIGN), one drawDecal per frame after the sky. Nothing here touches the props
 * buffer, and every GPU or canvas step is feature-detected so a headless build
 * sees only the pure quad numbers.
 *
 * Ported verbatim from f1-game js/garage/pit-signs.js:1-206 (PitSigns).
 * Differences: the globals it read (`document`, LiveryTex, Log) are injected
 * through createPitSigns(deps); the frame counters are per instance.
 */
import { SIGN } from "../../track/core/pit";
import type { BayRow } from "../../track/core/pit";
import type {
  CanvasFactory, CanvasRect, GarageCanvas, GarageCtx2D, GarageGfx, GarageLiveryTex, GarageLog, GfxMesh, GfxTexture,
} from "./types";
import type { V3 } from "./prims";

/** A sign quad buffer as pits.ts writes it (track.pitSigns / track.pitSignal). */
export interface SignQuads {
  readonly pos: ArrayLike<number>;
  readonly nrm: ArrayLike<number>;
  readonly uv: ArrayLike<number>;
  readonly idx: ArrayLike<number>;
  readonly centre?: readonly number[] | null;
  readonly anchors?: readonly (readonly number[])[] | null;
}

/** The slots upload() writes on track.meshes (pit-signs.js:122-131). */
export interface PitSignMeshes {
  pitSigns?: GfxMesh | null;
  pitSignTex?: GfxTexture | null;
  pitSignal?: GfxMesh | null;
  [k: string]: unknown;
}

/** A bay as the painter reads it (pit.ts BayRow: team, name, short, col, col2, logo3). */
export type SignBox = Pick<BayRow, "team" | "name" | "short"> & {
  readonly col?: readonly number[] | null;
  readonly col2?: readonly number[] | null;
  readonly logo3?: unknown;
};

/** The track fields PitSigns reads and writes. */
export interface PitSignTrack {
  readonly pitSigns?: SignQuads | null | undefined;
  readonly pitSignal?: SignQuads | null | undefined;
  meshes?: PitSignMeshes | Record<string, unknown> | null;
  readonly pit?: { readonly row: { readonly boxes: readonly SignBox[] }; readonly side?: number; readonly limitKph?: number } | null | undefined;
  readonly def?: { readonly id?: string } | null | undefined;
}

/** The facade members upload/draw/free use; each is feature-tested, as in pit-signs.js. */
export type SignGfx = Partial<Pick<GarageGfx, "createTexture" | "freeMesh" | "freeTexture" | "drawDecal" | "isMobile" | "mobileTier">> & {
  createTexMesh?(data: { pos: ArrayLike<number>; nrm: ArrayLike<number>; uv: ArrayLike<number>; idx: ArrayLike<number> }): GfxMesh;
};

export interface PitSignsDeps {
  /** LiveryTex.paintTeamMark / inkOn. TODO(lane-car): src/car/liverytex.ts. */
  readonly livery?: Pick<GarageLiveryTex, "paintTeamMark" | "inkOn"> | null | undefined;
  /** `document.createElement("canvas")`; null where there is no DOM. */
  readonly createCanvas?: CanvasFactory | null | undefined;
  readonly log?: GarageLog | undefined;
}

export interface PaintOpts {
  readonly mobile?: boolean;
  readonly side?: number | null;
  readonly limitKph?: number | null;
}

/** The atlas rectangle (pixels, full-size layout) of row cell `i`. pit-signs.js:148-152 */
export function cellRect(i: number): CanvasRect {
  const S = SIGN;
  return { x: (i % S.cols) * S.cellW, y: Math.floor(i / S.cols) * S.cellH, w: S.cellW, h: S.cellH };
}
/** …and of crest cell `i` (SIGN.crests, the atlas's lower half). pit-signs.js:153-157 */
export function crestRect(i: number): CanvasRect {
  const S = SIGN;
  return { x: (i % S.crestCols) * S.crestPx, y: S.crestY + Math.floor(i / S.crestCols) * S.crestPx, w: S.crestPx, h: S.crestPx };
}
/** UV rect of cell `i`, V flipped as createTexture uploads with FLIP_Y
 *  (the garage's uvOf does the same; U is NOT flipped — these quads are
 *  world-space on the identity, a U flip would mirror every crest). pit-signs.js:159-166 */
export function uvRect(i: number): { uL: number; uR: number; vT: number; vB: number } {
  const S = SIGN, r = cellRect(i);
  return { uL: r.x / S.w, uR: (r.x + r.w) / S.w, vT: 1 - r.y / S.h, vB: 1 - (r.y + r.h) / S.h };
}

const to255 = (c: number): number => Math.max(0, Math.min(255, Math.round(c * 255)));
const css = (c: readonly number[]): string => "rgb(" + to255(c[0]!) + "," + to255(c[1]!) + "," + to255(c[2]!) + ")";

export interface PitSignsApi {
  supported(): boolean;
  paintAtlas(boxes: readonly SignBox[], opts?: PaintOpts | null): GarageCanvas;
  cellRect: typeof cellRect;
  uvRect: typeof uvRect;
  upload(G: SignGfx | null | undefined, track: PitSignTrack | null | undefined): boolean;
  free(gfx: SignGfx, track: PitSignTrack | null | undefined): void;
  draw(gfx: SignGfx, track: PitSignTrack | null | undefined, model: Float32Array, eye: readonly number[] | null | undefined,
    night: boolean, hidden: boolean, called?: boolean): boolean;
  stats(): { drawn: number; calls: number };
}

/** One PitSigns (pit-signs.js:9-205). */
export function createPitSigns(deps: PitSignsDeps = {}): PitSignsApi {
  const LiveryTex = deps.livery || null;
  const createCanvas = deps.createCanvas || null;
  const warn = (msg: string): void => { if (deps.log) deps.log.warn(msg); };

  /** True where an atlas can be painted: a canvas and the livery painter. pit-signs.js:13-17 */
  function supported(): boolean {
    return !!createCanvas && !!LiveryTex && typeof LiveryTex.paintTeamMark === "function";
  }

  /** Paint the twelve cells for a row (`pit.row.boxes`) onto a fresh canvas
   *  laid out by SIGN; `mobile` halves it (the UVs are fractions, so the
   *  layout is size-independent). Each cell sits on a TRANSPARENT field — the
   *  lintel's own colour shows through, as the garage's door sign does — with
   *  the crest at the left and the team's code beside it in an ink that reads
   *  on that colour. pit-signs.js:22-146 */
  function paintAtlas(boxes: readonly SignBox[], opts?: PaintOpts | null): GarageCanvas {
    const S = SIGN, mobile = !!(opts && opts.mobile), div = mobile ? 2 : 1;
    const Tex = LiveryTex!;
    const cv = createCanvas!(S.w / div, S.h / div);
    const ctx: GarageCtx2D | null = cv.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.clearRect(0, 0, cv.width, cv.height);
    const cw = S.cellW / div, ch = S.cellH / div;
    for (let i = 0; i < boxes.length && i < S.cells; i++) {
      const box = boxes[i]!, cell = cellRect(i), x = cell.x / div, y = cell.y / div;
      const col = box.col || [0.6, 0.6, 0.65], col2 = box.col2 || [0.9, 0.9, 0.9];
      const ink = Tex.inkOn!([col]);
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, cw, ch); ctx.clip();
      // The crest: a square cell-high box at the left, on the lintel's colour.
      const pad = Math.round(ch * 0.08), crestW = ch - pad * 2;
      try {
        Tex.paintTeamMark!(ctx, box.team, { c1: col, c2: col2, logo3: (box.logo3 || null) as V3 | null },
                           { x: x + pad, y: y + pad, w: crestW, h: crestW }, col, { fullLockup: true });
      } catch { /* an unpaintable crest leaves the code and the name */ }
      // The code, then the name where the fascia has room for it.
      ctx.fillStyle = css(ink); ctx.textBaseline = "middle"; ctx.textAlign = "left";
      const codeH = Math.round(ch * 0.62);
      ctx.font = "700 " + codeH + "px system-ui, sans-serif";
      const code = String(box.short || box.team || "").toUpperCase().slice(0, 4);
      let cx = x + pad * 2 + crestW;
      ctx.fillText(code, cx, y + ch / 2);
      cx += ctx.measureText(code).width + pad * 3;
      const nameH = Math.round(ch * 0.34), room = x + cw - pad * 2 - cx;
      if (room > nameH * 4) {
        ctx.font = "600 " + nameH + "px system-ui, sans-serif";
        const name = String(box.name || "").toUpperCase();
        if (name && name !== code) {
          ctx.globalAlpha = 0.92;
          ctx.fillText(name, cx, y + ch / 2 + 1, room);
        }
      }
      ctx.restore();
    }
    // The BOARDS (cells 12 and 13, SIGN.boards): opaque, blue, white
    // lettering — a sign, not a fascia. "PIT ENTRY" carries an arrow at the
    // pit side; the entry-line board names the limit the lane is authored at.
    if (S.boards) {
      const side = opts && opts.side != null ? opts.side : 1;
      const lim = Math.round((opts && opts.limitKph) || 80);
      const texts = [(side < 0 ? "◀ " : "") + "PIT ENTRY" + (side > 0 ? " ▶" : ""), "PIT LANE " + lim + " km/h"];
      for (let b = 0; b < S.boards && b < texts.length; b++) {
        const cell = cellRect(S.cells + b), x = cell.x / div, y = cell.y / div;
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, cw, ch); ctx.clip();
        ctx.fillStyle = "rgb(18,38,92)"; ctx.fillRect(x, y, cw, ch);
        ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = "800 " + Math.round(ch * 0.66) + "px system-ui, sans-serif";
        ctx.fillText(texts[b]!, x + cw / 2, y + ch / 2 + 1, cw - 16 / div);
        ctx.restore();
      }
    }
    // The CRESTS (SIGN.crests): the crest alone, on an OPAQUE field of the
    // team's colour — a plaque on the door's pier, not a fascia.
    if (S.crests) {
      const cp = S.crestPx / div;
      for (let i = 0; i < boxes.length && i < S.crests; i++) {
        const box = boxes[i]!, cell = crestRect(i), x = cell.x / div, y = cell.y / div;
        const col = box.col || [0.6, 0.6, 0.65], col2 = box.col2 || [0.9, 0.9, 0.9];
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, cp, cp); ctx.clip();
        ctx.fillStyle = css(col); ctx.fillRect(x, y, cp, cp);
        const pad = Math.round(cp * 0.12);
        try {
          Tex.paintTeamMark!(ctx, box.team, { c1: col, c2: col2, logo3: (box.logo3 || null) as V3 | null },
                             { x: x + pad, y: y + pad, w: cp - pad * 2, h: cp - pad * 2 }, col, { fullLockup: true });
        } catch { /* an unpaintable crest leaves the plaque in the team's colour */ }
        ctx.restore();
      }
    }
    // The ENTRANCE LAMPS' aspects (SIGN.signals): GREEN and RED, each an
    // opaque disc on a dark square — the GREEN one is the decal the pit row
    // lays over the lamps' painted RED face, drawn only while this car is
    // called in.
    if (S.signals) {
      const sp = S.signalPx / div, cols = [[0.10, 0.95, 0.30], [1.0, 0.12, 0.08]] as const;
      for (let i = 0; i < S.signals; i++) {
        const x = (S.signalPx * 1.25 * i) / div, y = S.signalY / div;
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, sp, sp); ctx.clip();
        ctx.fillStyle = "rgb(12,12,16)"; ctx.fillRect(x, y, sp, sp);
        ctx.fillStyle = css(cols[i] || cols[0]);
        if (typeof ctx.arc === "function") { ctx.beginPath(); ctx.arc(x + sp / 2, y + sp / 2, sp * 0.42, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(x + sp * 0.1, y + sp * 0.1, sp * 0.8, sp * 0.8);
        ctx.restore();
      }
    }
    return cv;
  }

  // ── Runtime: the mesh, the texture and the draw ──
  let _drawn = 0, _calls = 0;           // frames drawn / frames asked (agent probe)
  const _opts = { glow: 0 };
  const meshesOf = (track: PitSignTrack): PitSignMeshes => (track.meshes || (track.meshes = {})) as PitSignMeshes;

  /** Build the track's sign mesh and texture through the render facade; skipped
   *  where either half is missing. pit-signs.js:113-138 */
  function upload(G: SignGfx | null | undefined, track: PitSignTrack | null | undefined): boolean {
    const q = track && track.pitSigns;
    if (!q || !q.idx || !q.idx.length || !G || typeof G.createTexMesh !== "function" ||
        typeof G.createTexture !== "function" || !supported()) return false;
    const t = track!;
    try {
      const canvas = paintAtlas(t.pit!.row.boxes, { mobile: !!(G.isMobile || G.mobileTier), side: t.pit!.side ?? null, limitKph: t.pit!.limitKph ?? null });
      const m = meshesOf(t);
      m.pitSignTex = G.createTexture(canvas);
      m.pitSigns = G.createTexMesh({ pos: q.pos, nrm: q.nrm, uv: q.uv, idx: q.idx });
      // The entrance lamps' RED aspects: a second mesh on the same texture,
      // drawn only under a red flag (draw()).
      const r = t.pitSignal;
      m.pitSignal = r && r.idx && r.idx.length
        ? G.createTexMesh({ pos: r.pos, nrm: r.nrm, uv: r.uv, idx: r.idx }) : null;
      return true;
    } catch (e) {
      free(G, t);   // the texture or the first mesh may already be on the GPU
      warn(`${t.def && t.def.id}: pit signs skipped: ${e && (e as Error).message}`);
      return false;
    }
  }

  /** pit-signs.js:140-147 */
  function free(gfx: SignGfx, track: PitSignTrack | null | undefined): void {
    const m = track && track.meshes as PitSignMeshes | null | undefined;
    if (!m) return;
    if (m.pitSigns && gfx.freeMesh) gfx.freeMesh(m.pitSigns);
    if (m.pitSignal && gfx.freeMesh) gfx.freeMesh(m.pitSignal);
    if (m.pitSignTex && gfx.freeTexture) gfx.freeTexture(m.pitSignTex);
    m.pitSigns = m.pitSignTex = m.pitSignal = null;
  }

  /** One decal draw, after the sky (opaque → sky → decal: the decal shader
   *  depth-tests against the opaque world and never writes). Gated to 350 m
   *  from the row's centre: the decal shader has no fog, and a sign that far
   *  off would float unfogged on a misty dusk. `glow` reads as a lit fascia
   *  at night (the garage's door sign draws at 0.62). pit-signs.js:149-191 */
  const _near = (eye: readonly number[], a: readonly number[]): boolean => {
    const dx = eye[0]! - a[0]!, dz = eye[2]! - a[2]!; return dx * dx + dz * dz <= 350 * 350;
  };   // hoisted: no closure per frame
  function draw(gfx: SignGfx, track: PitSignTrack | null | undefined, model: Float32Array, eye: readonly number[] | null | undefined,
    night: boolean, hidden: boolean, called?: boolean): boolean {
    const m = track && track.meshes as PitSignMeshes | null | undefined, q = track && track.pitSigns;
    _calls++;
    if (hidden || !m || !m.pitSigns || !m.pitSignTex || !q || typeof gfx.drawDecal !== "function") return false;
    if (eye) {
      // Within 350 m of the row's centre OR of any board (the approach boards
      // stand up to 400 m before the row).
      let ok = q.centre ? _near(eye, q.centre) : !q.anchors || !q.anchors.length;
      if (!ok && q.anchors) for (let i = 0; i < q.anchors.length && !ok; i++) ok = _near(eye, q.anchors[i]!);
      if (!ok) return false;
    }
    _opts.glow = night ? 0.5 : 0;
    gfx.drawDecal(m.pitSigns, model, m.pitSignTex, _opts);
    // YOU ARE CALLED IN: the entrance lamps' GREEN aspects over their red.
    if (called && m.pitSignal) gfx.drawDecal(m.pitSignal, model, m.pitSignTex, _opts);
    _drawn++;
    return true;
  }

  /** `{drawn, calls}`: frames the signs were drawn, frames the draw was asked. */
  const stats = (): { drawn: number; calls: number } => ({ drawn: _drawn, calls: _calls });

  return Object.freeze({ supported, paintAtlas, cellRect, uvRect, upload, free, draw, stats });
}
