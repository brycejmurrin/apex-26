/**
 * CAMERA TUNER boot stub (FULL). The pause-menu panel is the CAMERA TUNER
 * (./tuner-panel.ts, f1-game's CamTunerEditor in LAZY_CAM_EDITOR); the shell
 * creates this always-loaded door, which loads and mounts the real panel on
 * first open through the same guarded opener as the FLYBY SHOT EDITOR.
 *
 * Ported verbatim from f1-game js/camera/cam-tuner-boot.js:1-34 (`CamTunerPanel`).
 *
 * Port notes: `G` becomes `CamTunerBootDeps` (EditorDoorDeps plus the loader);
 * `FlybyPanel.ensureCamEditor().then(… CamTunerEditor.create(G))` is
 * `deps.createEditor()` — TODO(lane-shell): the shell's dynamic import() of
 * ./tuner-panel.ts and mountCamTuner(el, deps), memoised through
 * createCamEditorLoader. The module-level `_real` / `_refresh` are this
 * instance's.
 */
import { log } from "../data/log";
import { createEditorOpener, type EditorDoorDeps } from "./flyby-panel";

/** What the lazily-created CAMERA TUNER exposes (./tuner-panel.ts CamTunerMount). */
export interface CamTunerLike {
  buildCamTunePanel?(): void;
  refreshCamTunePanel(): void;
  openCamTuner(): void;
  closeCamTuner(showPauseMenu?: boolean): void;
  isOpen?(): boolean;
}

export interface CamTunerBootDeps extends EditorDoorDeps {
  /** Load the editor bundle and mount the CAMERA TUNER. TODO(lane-shell). */
  createEditor(): Promise<CamTunerLike | null>;
}

/** cam-tuner-boot.js:9-31 `create` */
export function createCamTunerBoot(G: CamTunerBootDeps) {
  log.info("CamTunerPanel.create");
  let _real: CamTunerLike | null = null;
  function ensure(): Promise<CamTunerLike | null> {
    if (_real) return Promise.resolve(_real);
    return G.createEditor().then((ed) => {
      if (!ed) return null;
      if (!_real) {
        _real = ed;
        opener.bind(); // the real editor installs an unguarded button handler.
      }
      return _real;
    });
  }
  const opener = createEditorOpener(G, "pm-camtune", ensure, "openCamTuner");
  return {
    buildCamTunePanel: (): Promise<void> => ensure().then((r) => { if (r && r.buildCamTunePanel) r.buildCamTunePanel(); }),
    refreshCamTunePanel: (): void => { if (_real) _real.refreshCamTunePanel(); },
    openCamTuner: opener.open,
    closeCamTuner: (show?: boolean): void => { opener.cancel(); if (_real) _real.closeCamTuner(show); },
    isOpen: (): boolean => !!(!_real ? false : _real.isOpen && _real.isOpen()),
    /** CamTunerPanel.refresh → CamTunerEditor.refresh (tuner-panel.js:517): repaint while open. */
    refresh: (): void => { if (_real && _real.isOpen && _real.isOpen()) _real.refreshCamTunePanel(); },
  };
}
export type CamTunerBoot = ReturnType<typeof createCamTunerBoot>;
