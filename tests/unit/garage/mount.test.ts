// @vitest-environment happy-dom
// mountGarage (src/garage/index.ts), the seam lane-shell wires: mount into a
// plain element with a recording renderer facade, open for a team, switch
// tabs, move a SETUP slider and see SetupTune follow, draw frames, close and
// unmount — after which no window/document listener and no timer of the
// garage's is left behind.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountGarage, type GarageMountDeps, type MountedGarage } from "../../../src/garage/index";
import { createGarageStore, memoryStorage } from "../../../src/garage/store";
import type { SetupGfx } from "../../../src/garage/setup-camera";
import { recordingGfx } from "./scene-vm";

function stubGfx() {
  const rec = recordingGfx();
  const frames: string[] = [];
  const gfx = Object.assign(rec.gfx, {
    aspect: 1.6, resize() {}, begin(o: { eye: readonly number[] }) { frames.push("begin " + o.eye.map((v) => v.toFixed(3)).join(",")); return true; },
    drawGlow() { frames.push("glow"); }, present() { frames.push("present"); },
  });
  return { gfx: gfx as unknown as SetupGfx, frames, rec };
}

type Counted = { added: Map<string, number>; restore(): void };
function countListeners(target: EventTarget): Counted {
  const added = new Map<string, number>();
  const add = target.addEventListener.bind(target), rem = target.removeEventListener.bind(target);
  target.addEventListener = ((t: string, f: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => { added.set(t, (added.get(t) || 0) + 1); add(t, f, o); }) as typeof target.addEventListener;
  target.removeEventListener = ((t: string, f: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => { added.set(t, (added.get(t) || 0) - 1); rem(t, f, o); }) as typeof target.removeEventListener;
  return { added, restore() { target.addEventListener = add; target.removeEventListener = rem; } };
}
const net = (c: Counted): Record<string, number> => Object.fromEntries([...c.added].filter(([, n]) => n !== 0));

let host: HTMLElement, canvas: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame"] });
  host = document.createElement("div"); document.body.appendChild(host);
  canvas = document.createElement("canvas"); canvas.id = "game"; document.body.appendChild(canvas);
});
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe("mountGarage", () => {
  it("open → tabs → SETUP slider → frames → close → unmount, leaving no listeners or timers", () => {
    const win = countListeners(window), doc = countListeners(document), cv = countListeners(canvas);
    try {
      const { gfx, frames } = stubGfx();
      const exits: string[] = [];
      const deps: GarageMountDeps = { gfx, canvas, store: createGarageStore(memoryStorage()), onExit: (how, from) => exits.push(how + ":" + from) };
      const g: MountedGarage = mountGarage(host, deps);
      const $ = (id: string): HTMLElement => g.root.querySelector<HTMLElement>(`[id="${id}"]`)!;
      expect(host.contains(g.root)).toBe(true);
      expect(g.root.id).toBe("carsetup");
      expect(g.isOpen).toBe(false);

      g.open("ferrari", "select");
      expect(g.teamId).toBe("ferrari");
      expect(g.isOpen).toBe(true);
      expect($("cs-done").textContent).toBe("RACE SETUP");
      expect(g.root.getAttribute("aria-busy")).toBe("true");
      vi.advanceTimersToNextFrame(); vi.advanceTimersToNextFrame();
      expect(g.root.getAttribute("aria-busy")).toBeNull();
      expect($("cs-team").textContent).toBe("SCUDERIA FERRARI");
      expect(g.root.hasAttribute("data-cs-exit"), "RACE SETUP keeps BACK").toBe(false);

      // tabs: a part category, then SETUP
      $("cs-tab-brakes").click();
      expect($("cs-options").querySelectorAll(".cs-opt").length).toBeGreaterThan(1);
      expect(g.camera.spin, "a part tab frames its preset and stops the turntable").toBe(false);
      $("cs-tab-tune").click();
      const slider = $("cs-options").querySelector<HTMLInputElement>('input[data-cs-tune="arbR"]')!;
      const before = g.tune.get("ferrari").arbR;
      slider.value = String(before === 11 ? 10 : before + 1);
      slider.dispatchEvent(new Event("input"));
      expect(g.tune.get("ferrari").arbR).toBe(Number(slider.value));
      expect($("cs-tab-tune").querySelector(".cs-tab-cur")!.textContent).toBe("TUNED");

      // the shell's loop draws the bay while the garage is open
      expect(g.frame(1 / 60)).toBe(true);
      expect(g.frame(1 / 60)).toBe(true);
      expect(frames.filter((f) => f === "present").length).toBe(2);
      expect(frames.some((f) => f.startsWith("begin "))).toBe(true);

      // FREE BUILD toggles and persists
      const freeBefore = $("cs-unlimited").textContent;
      $("cs-unlimited").click();
      expect($("cs-unlimited").textContent).not.toBe(freeBefore);

      // DONE closes and hands the next screen to the shell
      $("cs-done").click();
      expect(exits).toEqual(["done:select"]);
      expect(g.isOpen).toBe(false);
      expect(g.frame(1 / 60), "no frames while closed").toBe(false);

      // a second visit, closed by BACK
      g.open(undefined, "menu");
      expect($("cs-done").textContent).toBe("CLOSE GARAGE");
      vi.advanceTimersToNextFrame(); vi.advanceTimersToNextFrame();
      expect(g.root.getAttribute("data-cs-exit")).toBe("one");
      $("cs-back").click();
      expect(exits).toEqual(["done:select", "back:menu"]);

      g.open("mclaren");   // left open: unmount closes it
      g.unmount();
      expect(host.contains(g.root), "the screen mountGarage built goes with it").toBe(false);
      vi.runAllTimers();
      expect(vi.getTimerCount(), "no timers left").toBe(0);
      expect(net(win), "window listeners").toEqual({});
      expect(net(doc), "document listeners").toEqual({});
      expect(net(cv), "canvas listeners").toEqual({});
      g.unmount();   // idempotent
    } finally { win.restore(); doc.restore(); cv.restore(); }
  });

  it("adopts an existing #carsetup and leaves it in place on unmount; the paint draft dies with close", async () => {
    const existing = document.createElement("div"); existing.id = "carsetup"; existing.hidden = true;
    host.appendChild(existing);
    const { gfx } = stubGfx();
    const store = createGarageStore(memoryStorage());
    store.set("garageTab", "livery");
    // The adopted element is empty: mountGarage builds only when none exists,
    // so here it fills nothing and the shell's markup is used as is.
    const g0 = mountGarage(document.createElement("div"), { gfx, canvas, store });
    const markup = g0.root.innerHTML; g0.unmount();
    existing.innerHTML = markup;
    const g = mountGarage(host, { gfx, canvas, store });
    expect(g.root).toBe(existing);
    g.open("mercedes");
    vi.advanceTimersToNextFrame(); vi.advanceTimersToNextFrame();
    (g.root.querySelector(".cs-liv-create") as HTMLElement).click();
    expect(g.root.querySelector(".cs-liv-editor")).toBeTruthy();
    g.close();
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 0));   // the #carsetup observer
    g.open("mercedes");
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    expect(g.root.querySelector(".cs-liv-editor"), "the unsaved draft did not survive the exit").toBeNull();
    g.unmount();
    expect(host.contains(existing)).toBe(true);
  });
});
