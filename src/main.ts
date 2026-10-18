import { createRenderer } from "./render/boot";
import { App } from "./app/app";

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const label = document.querySelector<HTMLElement>("#backend")!;

const { renderer, backend, reason } = await createRenderer(canvas);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);

label.textContent = `${backend} (${reason})`;
label.dataset.backend = backend;
label.dataset.reason = reason;

const app = new App({ renderer, canvas, hudParent: document.body });
app.input.attach(window);
app.resize(window.innerWidth, window.innerHeight);

window.addEventListener("resize", () => {
  app.resize(window.innerWidth, window.innerHeight);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) app.loop.resetClock();
});

renderer.setAnimationLoop((t: number) => app.frame(t));
