/**
 * Active-aero ACTIVATION ZONES: the lookup half. Port of f1-game
 * js/physics/aero-zones.js:215-225 (`at(s)`), verbatim. The zone builder
 * (`zonesFor`, curvature in, arc spans out) is circuit geometry for the track
 * lane; a built track hands the zones over as [start, end] arc metres.
 */
export type AeroZone = readonly [start: number, end: number];

/** The zone containing arc `s` (wrap-aware), or null. `L` is the lap length (`track.total`). */
export function zoneAt(zones: readonly AeroZone[], L: number, s: number): AeroZone | null {
  if (!L) return null;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i] as AeroZone;
    if (s >= z[0] && s <= z[1]) return z;
    if (z[1] > L && s + L <= z[1]) return z;
  }
  return null;
}
