/**
 * Per-node scheduling caches. f1-game stores these as expando properties on
 * the AudioNode / AudioParam itself (`node._apexAimTgt`, engine.js:194-211)
 * so a stop/start pair can never leave them stale: a fresh node carries no
 * cache. A WeakMap keyed by the node keeps exactly that lifetime, typed.
 */
export interface ApexTags {
  _apexAimTgt?: number;
  _apexLimTgt?: number;
  _apexCents?: number;
  _apexTgt?: number;
  _apexHz?: number;
  _apexRate?: number;
  _apexTilt?: number;
  _apexSubF?: number;
  _apexQ?: number;
  _apexHarvQ?: number;
  _apexErsTgt?: number;
  _apexCylTgt?: number;
  _apexLfoTgt?: number;
  _apexSkidV?: number;
  _apexSkidBase?: number;
  _apexDepth?: number;
  _apexPanTgt?: number | undefined;
  _apexCut?: number;
  _apexDuckTgt?: number | null;
  _apexSubGain?: GainNode;
  _ersAim?: number;
}

const TAGS = new WeakMap<object, ApexTags>();

export function tag(o: object): ApexTags {
  let t = TAGS.get(o);
  if (!t) { t = {}; TAGS.set(o, t); }
  return t;
}
