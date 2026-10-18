import "./styles";
import { App } from "./app/app";
import { createScreens } from "./app/screens";
import { createDebugApi } from "./debug/api";
import { createTrackRenderer } from "./render/renderer";
import { loadPhysicsTrack } from "./track/build/query";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const label = document.querySelector<HTMLElement>("#backend")!;

const TRACK = "monza";
const software = /SwiftShader|llvmpipe/i.test(navigator.userAgent);
const renderer = await createTrackRenderer(canvas, { softwareGL: software });
const dpr = (): number => Math.min(window.devicePixelRatio, 2);
const backend = renderer.backend ?? "WebGL2";
label.textContent = `${backend} · ${TRACK}`;
label.dataset.backend = backend;

// TODO(T1.13): build in the worker (src/track/build/client.ts buildInWorker) if the main-thread build shows up in time to first frame.
const app = new App({ renderer, track: loadPhysicsTrack(TRACK), hudParent: document.body });
app.input.attach(window);
window.__apex = createDebugApi(app, { name: backend, reason: "" }, TRACK);
app.resize(window.innerWidth, window.innerHeight, dpr());

const screens = createScreens(document.body, {
  startTimeTrial: () => app.startTimeTrial(),
  quitToMenu: () => app.quitToMenu(),
  setPaused: (p) => app.setPaused(p),
  profile: () => ({ team: "mclaren", seat: 0 }),
  onFriendGo: (handoff) => {
    // TODO(lane-shell): the friend race needs the multi-car world (netPlay.tick, owns(c)); until
    // then close the hand-off cleanly and fall back to the time trial.
    for (const t of handoff.transports.values()) t.close();
    console.warn("[shell] RACE A FRIEND: race start not wired yet; starting the time trial");
    app.startTimeTrial();
  },
});
app.onPause = (p) => screens.showPause(p);

window.addEventListener("resize", () => app.resize(window.innerWidth, window.innerHeight, dpr()));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) app.loop.resetClock();
});

const loop = (t: number): void => {
  app.frame(t);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
