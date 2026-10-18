// @vitest-environment happy-dom
/** CamFeel (src/camera/feel.ts). Assertions ported from f1-game
 *  tests/unit/camera-feel.test.mjs:32-298 (the behaviour tests; the source
 *  pins on game.js / vantage.js / input.js are the shell's); parity against
 *  f1-game drive-*.js + feel.js in a VM over a scripted input sequence:
 *  followers, springs (free-look), lens deltas, look-back edges and shake,
 *  Object.is on every number. */
import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/contracts/track";
import type { LensApply } from "../../../src/camera/drive-lens";
import { createCamFeel, mountCamFeelSettings, type CamFeel, type DriveExtra, type FeelTickOpts } from "../../../src/camera/feel";
import { f1Cam, hasCam, mapStore } from "./f1-cam-vm";

/** drive-chase.js:13-21, the shell lane's lens, as the test's injected chase family. */
const chaseLens: LensApply = (mode, _e, _t, ctx) => {
  if (!ctx) return null;
  const { sp, yaw, brake, slip } = ctx, abs = Math.abs;
  if (mode === "chase") return 4 * sp + 2 * abs(yaw) + 2 * brake;
  if (mode === "far") return 7 * sp + 0.4 * abs(yaw);
  if (mode === "drift") return 3 * sp + 6 * abs(yaw) + 4 * abs(slip);
  if (mode === "low") return 5 * sp;
  if (mode === "reverse") return 1.5 * sp;
  return null;
};

function load(init?: Record<string, unknown>): { F: CamFeel; store: ReturnType<typeof mapStore> } {
  const store = mapStore(init);
  return { F: createCamFeel({ store, chaseLens, doc: null }), store };
}

describe("CamFeel", () => {
  it("follow is exact with no dt and eases when a frame has one", () => {
    const { F } = load();
    F.resetFollow("t");
    expect(F.follow("t", 1, 2, 0)).toBe(1);
    const mid = F.follow("t", -1, 2, 0.05);
    expect(mid < 1 && mid > -1).toBe(true);
    expect(mid).toBeGreaterThan(0);
  });

  it("drive opens the lens with speed and does not move the eye", () => {
    const { F } = load();
    const eye: Vec3 = [0, 2, 0], tgt: Vec3 = [0, 1, 10];
    expect(F.drive("chase", eye, tgt, 57, { dt: 0, att: {} }, 1)).toBe(57);
    const moved = F.drive("chase", eye, tgt, 57, { dt: 0.05, att: { yawRateCur: 0, baPitch: 0 }, slipLat: 0 }, 1);
    expect(eye).toEqual([0, 2, 0]);
    expect(tgt[2]).toBe(10);
    expect(moved).toBeGreaterThan(57);
    const locked: Vec3 = [0, 2, 0];
    expect(F.drive("cockpit", locked, [0, 1, 10], 64, { dt: 0.05, att: {} }, 1)).toBe(65.5);
    expect(locked).toEqual([0, 2, 0]);
    expect(F.drive("chase", [0, 2, 0], [0, 1, 10], 57, { dt: 0.05, reduceMotion: true, att: {} }, 1)).toBe(57);
    F.resetFollow();
    const chaseEye: Vec3 = [0, 2, -8], heliEye: Vec3 = [0, 2, -8], wallEye: Vec3 = [0, 2, -8];
    const ex = { dt: 1, att: { yawRateCur: 0.8, baPitch: 0 }, slipLat: 0 };
    const chaseFov = F.drive("chase", chaseEye, [0, 1, 0], 57, ex, 1);
    const heliFov = F.drive("heli", heliEye, [0, 1, 0], 36, ex, 1);
    F.drive("trackside", wallEye, [0, 1, 0], 42, ex, 1);
    expect(heliFov - 36).toBeGreaterThan(chaseFov - 57);
    expect([chaseEye, heliEye, wallEye]).toEqual([[0, 2, -8], [0, 2, -8], [0, 2, -8]]);
  });

  it("without the chase family's lens the chase modes keep their FOV (no DriveChase loaded)", () => {
    const F = createCamFeel({ doc: null });
    expect(F.drive("chase", [0, 2, 0], [0, 1, 10], 57, { dt: 0.05, att: {} }, 1)).toBe(57);
    expect(F.drive("hood", [0, 2, 0], [0, 1, 10], 64, { dt: 0.05, att: {} }, 1)).not.toBe(64);
  });

  it("speedFov is one shared curve scaled per mode", () => {
    const { F } = load();
    expect(F.speedFov(64, 14, 0, 1)).toBe(64);
    expect(F.speedFov(64, 14, 1, 1)).toBe(78);
    expect(F.speedFov(46, 8, 1, 0.5, 2)).toBe(46 + 4 + 2);
    for (const m of ["tcam", "heli", "side"]) expect(F.modeFov(m, 1, 0)).toBeGreaterThan(F.modeFov(m, 0, 0));
    expect(F.modeFov("cockpit", 0, 0)).toBe(64);
    expect(F.modeFov("cockpit", 1, 0)).toBe(78);
    expect(F.modeFov("cockpit", 1, 1)).toBe(81);
    expect(F.modeFov("far", 0, 0)).toBe(61);
    expect(F.modeFov("far", 1, 0)).toBe(67);
    expect(F.modeFov("nope", 1, 1)).toBe(F.modeFov("chase", 1, 1));
  });

  it("LOOK BACK skips reverse and rear; latch toggles on rising edge", () => {
    const { F } = load();
    expect(F.shouldLookBack("chase", true)).toBe(true);
    expect(F.shouldLookBack("reverse", true)).toBe(false);
    expect(F.shouldLookBack("rear", true)).toBe(false);
    F.setLookBackLatch(true);
    expect(F.lookBackLatch()).toBe(true);
    F.tick({ mode: "cockpit", dt: 0.016, racing: true, lookHeld: true });
    expect(F.shouldLookBack("cockpit", true)).toBe(true);
    expect(F.shouldLookBack("cockpit", false)).toBe(true);
    F.tick({ mode: "cockpit", dt: 0.016, racing: true, lookHeld: false });
    F.tick({ mode: "cockpit", dt: 0.016, racing: true, lookHeld: true });
    expect(F.shouldLookBack("cockpit", true)).toBe(false);
    F.tick({ mode: "cockpit", dt: 0.016, racing: true, lookHeld: false });
    F.tick({ mode: "cockpit", dt: 0.016, racing: true, lookHeld: true });
    expect(F.shouldLookBack("cockpit", false)).toBe(true);
    F.tick({ mode: "reverse", dt: 0.016, racing: true, lookHeld: false });
    expect(F.shouldLookBack("cockpit", false)).toBe(false);
  });

  it("free-look accumulates on stick, recenters on release, respects comfort and mode", () => {
    const { F } = load();
    F.tick({ mode: "cockpit", dt: 0.05, racing: true, comfort: false, stickX: 1, stickY: 0, mouseDx: 0, mouseDy: 0 });
    const a = F.freeLookState();
    expect(a.yaw).toBe(4.5);   // STICK_RATE 90 deg/s x 0.05 s
    F.tick({ mode: "cockpit", dt: 0.5, racing: true, comfort: false, stickX: 0, stickY: 0, mouseDx: 0, mouseDy: 0 });
    expect(Math.abs(F.freeLookState().yaw)).toBeLessThan(Math.abs(a.yaw));
    F.resetFreeLook();
    F.tick({ mode: "cockpit", dt: 0.05, racing: true, comfort: true, stickX: 1, stickY: 0 });
    expect(F.freeLookState().yaw).toBe(0);
    F.resetFreeLook();
    F.tick({ mode: "chase", dt: 0.05, racing: true, comfort: false, stickX: 1, stickY: 0 });
    expect(F.freeLookState().yaw).toBe(0);
  });

  it("applyFreeLook is additive yaw on the aim about the eye", () => {
    const { F } = load();
    F.tick({ mode: "hood", dt: 0.2, racing: true, comfort: false, stickX: 1, stickY: 0 });
    const eye: Vec3 = [0, 1, 0], tgt: Vec3 = [0, 1, 10];
    F.applyFreeLook(eye, tgt);
    expect(Math.abs(tgt[0])).toBeGreaterThan(0.01);
    expect(eye[0]).toBe(0);
  });

  it("buzz / free-look scope tables stay aligned; HELMET is bolted like the cockpit", () => {
    const { F } = load();
    expect([...F.BUZZ_MODES]).toEqual([...F.FREELOOK_MODES]);
    expect([...F.LOOKBACK_SKIP]).toEqual(["reverse", "rear"]);
    for (const m of F.BUZZ_MODES) expect(F.isBuzzMode(m)).toBe(true);
    expect(F.isBuzzMode("chase")).toBe(false);
    expect(F.isFreeLookMode("helmet")).toBe(true);
    for (const sp of [0, 0.5, 1]) expect(F.modeFov("helmet", sp, 1)).toBe(F.modeFov("cockpit", sp, 1));
  });

  it("speed vignette defaults off, persists, and paints into #overlay or body", () => {
    const { F, store } = load();
    expect(F.speedVignette()).toBe(false);
    F.setSpeedVignette(true);
    expect(F.speedVignette()).toBe(true);
    expect(store.disk.get("speedVignette")).toBe(true);
    expect(load({ speedVignette: "1", lookBackLatch: "on" }).F.lookBackLatch()).toBe(true);
    const D = createCamFeel({ store: mapStore({ speedVignette: true }), doc: document });
    D.tick({ mode: "chase", dt: 0.016, racing: true, spN: 1 });
    const el = document.getElementById("speed-vignette");
    expect(el?.style.opacity).toBe("0.55");
    D.tick({ mode: "chase", dt: 0.016, racing: true, comfort: true, spN: 1 });
    expect(el?.style.opacity).toBe("0");
    D.dispose();
    expect(document.getElementById("speed-vignette")).toBe(null);
  });

  it("trauma shake is frame-rate independent through the chase damper", () => {
    const { F } = load();
    const rmsAt = (hz: number): number => {
      const dt = 1 / hz, lam = 18;
      let y = 0, s = 0, k = 0;
      for (let t = 0; t < 20; t += dt) {
        const eye: Vec3 = [0, 0, 0], tgt: Vec3 = [0, 0, 10];
        F.shake(eye, tgt, 1, t, false);
        y += (eye[0] - y) * (1 - Math.exp(-lam * dt));
        if (t > 2) { s += y * y; k++; }
      }
      return Math.sqrt(s / k);
    };
    const r30 = rmsAt(30), r60 = rmsAt(60), r144 = rmsAt(144);
    expect(r30 / r144).toBeLessThan(1.15);
    expect(Math.abs(r60 - 0.111)).toBeLessThan(0.02);
    for (let ch = 0; ch < 4; ch++) for (let t = 0; t < 5; t += 0.013) {
      const n = F.shakeNoise(ch, t);
      expect(n >= -0.5 && n <= 0.5).toBe(true);
    }
  });

  it("onboard shake stays inside the tub and becomes aim rotation", () => {
    const { F } = load();
    let maxEye = 0, maxAim = 0;
    for (let t = 0; t < 10; t += 0.007) {
      const eye: Vec3 = [0, 1, 0], tgt: Vec3 = [0, 1, 20];
      F.shake(eye, tgt, 0.9, t, true);
      maxEye = Math.max(maxEye, Math.abs(eye[0]), Math.abs(eye[1] - 1));
      maxAim = Math.max(maxAim, Math.abs(Math.atan2(tgt[0] - eye[0], tgt[2] - eye[2])));
    }
    expect(maxEye).toBeLessThanOrEqual(F.TUB_EYE_MAX + 1e-12);
    expect(maxAim).toBeGreaterThan(1 * Math.PI / 180);
    const eye: Vec3 = [0, 1, 0];
    F.shake(eye, [0, 1, 20], 0, 1.234, true);
    expect(eye).toEqual([0, 1, 0]);
  });

  it("LOOK BACK flips are a cut for the aim: one snap per edge", () => {
    const { F } = load();
    F.resetLatch();
    F.tick({ mode: "chase", dt: 0.016, racing: true, lookHeld: false });
    expect(F.consumeAimSnap()).toBe(false);
    F.tick({ mode: "chase", dt: 0.016, racing: true, lookHeld: true });
    expect(F.lookingBackNow()).toBe(true);
    expect(F.consumeAimSnap()).toBe(true);
    expect(F.consumeAimSnap()).toBe(false);
    F.tick({ mode: "chase", dt: 0.016, racing: true, lookHeld: true });
    expect(F.consumeAimSnap()).toBe(false);
    F.tick({ mode: "chase", dt: 0.016, racing: true, lookHeld: false });
    expect(F.lookingBackNow()).toBe(false);
    expect(F.consumeAimSnap()).toBe(true);
    F.tick({ mode: "reverse", dt: 0.016, racing: true, lookHeld: true });
    expect(F.consumeAimSnap()).toBe(false);
  });

  it("mouse free-look holds while the right button is held still; tickRace reads the injected input", () => {
    const { F } = load();
    F.tick({ mode: "cockpit", dt: 0.016, racing: true, mouseDx: 200, mouseHeld: true });
    const a = F.freeLookState().yaw;
    expect(a).toBeGreaterThan(10);
    for (let i = 0; i < 30; i++) F.tick({ mode: "cockpit", dt: 0.016, racing: true, mouseHeld: true });
    expect(F.freeLookState().yaw).toBe(a);
    for (let i = 0; i < 30; i++) F.tick({ mode: "cockpit", dt: 0.016, racing: true, mouseHeld: false });
    expect(F.freeLookState().yaw).toBeLessThan(a * 0.2);
    let held = true;
    const R = createCamFeel({ doc: null, input: { lookStick: () => ({ x: 0, y: 0 }), consumeLookMouse: () => ({ dx: 100, dy: 0 }), lookMouseHeld: () => held, lookingBack: () => false } });
    R.tickRace("cockpit", 0.016, false, true, 0.5);
    expect(R.freeLookState().yaw).toBe(8);
    held = false;
  });

  it("a reset is a cut: follows, free-look and a latched look-back all reset", () => {
    const { F } = load();
    F.setLookBackLatch(true);
    F.tick({ mode: "cockpit", dt: 0.016, racing: true, lookHeld: true });
    expect(F.shouldLookBack("cockpit", false)).toBe(true);
    F.follow("sp:chase", 1, 4, 0);
    F.resetFollow(); F.resetFreeLook(); F.resetLatch();
    expect(F.shouldLookBack("cockpit", false)).toBe(false);
    expect(F.follow("sp:chase", 0, 4, 0.016)).toBe(0);
  });

  it("scoped follows never share state with the player's", () => {
    const { F } = load();
    F.follow("k", 10, 3, 0);
    F.scoped("tv:", () => F.follow("k", -10, 3, 0));
    expect(F.follow("k", 10, 3, 0.1)).toBe(10);
    expect(F.scoped("tv:", () => F.scopeKey("k"))).toBe("tv:k");
  });

  it("mountCamFeelSettings builds the two rows and writes through", () => {
    const { F, store } = load();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const m = mountCamFeelSettings(host, F);
    const sel = document.getElementById("pm-speedvig-sel") as HTMLSelectElement;
    expect(sel.value).toBe("off");
    sel.value = "on";
    sel.dispatchEvent(new Event("change"));
    expect(F.speedVignette()).toBe(true);
    expect(store.disk.get("speedVignette")).toBe(true);
    (document.getElementById("pm-looklatch-next") as HTMLButtonElement).click();
    expect(F.lookBackLatch()).toBe(true);
    m.unmount();
    expect(document.getElementById("pm-camfeel")).toBe(null);
    host.remove();
  });

  it.skipIf(!hasCam)("bit-exact against f1-game feel.js over a scripted race (ticks, lens, shake, aim)", () => {
    const vmStore = mapStore();
    const V = f1Cam<CamFeel>(["drive-chase.js", "drive-broadcast.js", "drive-onboard.js", "feel.js"], "CamFeel",
      { GameStore: { store: vmStore }, document: undefined });
    const { F } = load();
    const MODES = ["chase", "far", "drift", "low", "reverse", "cockpit", "helmet", "hood", "visor", "tcam", "rear",
      "heli", "side", "cinematic", "overhead", "drone", "rival", "pitwall", "trackside", "tv"];
    for (const T of [F, V]) { T.resetFollow(); T.resetFreeLook(); T.resetLatch(); T.setLookBackLatch(false); }
    const same = (a: number, b: number, what: string): void => { if (!Object.is(a, b)) throw new Error(`${what}: ${a} vs ${b}`); };
    let n = 0;
    for (let f = 0; f < 2400; f++) {
      const t = f / 60;
      const mode = MODES[Math.floor(f / 97) % MODES.length] ?? "chase";
      const dt = f % 211 === 0 ? 0 : [1 / 60, 1 / 144, 1 / 30, 0.0213][f % 4] ?? 1 / 60;
      if (f === 900) for (const T of [F, V]) T.setLookBackLatch(true);
      if (f === 1700) for (const T of [F, V]) T.setLookBackLatch(false);
      const opts: FeelTickOpts = {
        mode, dt, comfort: f % 503 < 40, racing: f % 701 > 25,
        lookHeld: Math.floor(f / 37) % 3 === 0, mouseHeld: Math.floor(f / 53) % 4 === 1,
        stickX: Math.sin(t * 1.7) * 1.2, stickY: Math.cos(t * 0.9) * (f % 5 === 0 ? 0.01 : 0.8),
        mouseDx: f % 7 === 0 ? (f % 3) * 13.5 - 9 : 0, mouseDy: f % 11 === 0 ? -6.25 : 0, spN: 0.5 + 0.6 * Math.sin(t * 0.3),
      };
      F.tick({ ...opts }); V.tick({ ...opts });
      const a = F.freeLookState(), b = V.freeLookState();
      same(a.yaw, b.yaw, `yaw f${f}`); same(a.pitch, b.pitch, `pitch f${f}`);
      expect(F.lookingBackNow()).toBe(V.lookingBackNow());
      expect(F.consumeAimSnap()).toBe(V.consumeAimSnap());
      // The lens over every family, one follow state per mode, as vantage drives it.
      const extra: DriveExtra = { dt, snap: dt === 0, att: { yawRateCur: 1.6 * Math.sin(t * 2.1), baPitch: 0.03 * Math.max(0, Math.sin(t * 0.7)) }, slipLat: 7 * Math.sin(t * 1.3) };
      for (const m of [mode, "chase", "heli", "hood"]) {
        const fov0 = F.modeFov(m, opts.spN ?? 0, f % 2);
        same(fov0, V.modeFov(m, opts.spN ?? 0, f % 2), "modeFov");
        same(F.drive(m, [0, 2, -8], [0, 1, 0], fov0, extra, opts.spN ?? 0), V.drive(m, [0, 2, -8], [0, 1, 0], fov0, extra, opts.spN ?? 0), `drive ${m} f${f}`);
      }
      // Free-look on a pose, and the trauma shake both ways.
      const e1: Vec3 = [1, 2, 3], t1: Vec3 = [4, 1.5, 30], e2: Vec3 = [1, 2, 3], t2: Vec3 = [4, 1.5, 30];
      F.applyFreeLook(e1, t1); V.applyFreeLook(e2, t2);
      F.shake(e1, t1, 0.4 + 0.5 * Math.sin(t), t, f % 2 === 0); V.shake(e2, t2, 0.4 + 0.5 * Math.sin(t), t, f % 2 === 0);
      [...e1, ...t1].forEach((v, i) => same(v, [...e2, ...t2][i] ?? NaN, `pose f${f}`));
      same(F.follow("spring", Math.sin(t * 3), 7.5, dt), V.follow("spring", Math.sin(t * 3), 7.5, dt), "follow");
      n++;
    }
    expect(n).toBe(2400);
    expect(vmStore.disk.get("lookBackLatch")).toBe(false);
  });
});
