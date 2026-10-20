// @vitest-environment happy-dom
/** CockpitPreview (src/camera/cockpit-preview.ts). Assertions ported from
 *  f1-game tests/unit/cockpit-preview.test.mjs:38-78, with the iframe's
 *  `CockpitPreviewFrame` injected through `deps.frameApi`. */
import { describe, expect, it } from "vitest";
import { createCockpitOpts } from "../../../src/camera/cockpit-opts";
import { FRAME_SRC, createCockpitPreview, type PreviewFrameApi, type PreviewState } from "../../../src/camera/cockpit-preview";
import { mapStore } from "./f1-cam-vm";

function setup(frameSrc = "about:blank") {
  const store = mapStore();
  const opts = createCockpitOpts({ store, search: () => "" });
  const delivered: PreviewState[] = [], disposed: HTMLIFrameElement[] = [];
  const apis = new Map<HTMLIFrameElement, PreviewFrameApi>();
  const race = { paused: true, clock: 122.5, camera: "chase", input: "tilt" };
  const preview = createCockpitPreview({
    opts, store, units: () => "mph", frameSrc,
    frameApi: (fr) => {
      let api = apis.get(fr);
      if (!api) { api = { set: (s) => delivered.push(s), dispose: () => disposed.push(fr) }; apis.set(fr, api); }
      return api;
    },
  });
  const fold = document.createElement("details"); fold.open = true; document.body.appendChild(fold);
  const host = document.createElement("div"); fold.appendChild(host);
  const api = preview.mount(host);
  if (!api) throw new Error("mount");
  return { store, opts, preview, host, fold, api, delivered, disposed, race, apis };
}
const last = <T>(a: T[]): T => { const v = a[a.length - 1]; if (v === undefined) throw new Error("empty"); return v; };
const frame = (host: HTMLElement): HTMLIFrameElement => {
  const f = host.querySelector("iframe");
  if (!f) throw new Error("no iframe");
  return f;
};
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("CockpitPreview", () => {
  it("open, angle changes and close preserve race state and custom saved choices", async () => {
    expect(FRAME_SRC).toBe("cockpit-view.html?cockpitpreview=1");
    const s = setup();
    s.opts.setWheel("yoke"); s.opts.setBody("wide"); s.opts.setInterior("suede"); s.opts.setSeat("low"); s.opts.setHalo("slim");
    const beforeDisk = [...s.store.disk], beforeRace = { ...s.race };
    s.api.open(); const fr = frame(s.host); fr.onload?.(new Event("load"));
    expect(fr.getAttribute("src")).toBe("about:blank");
    expect(last(s.delivered).wheel).toBe("yoke");
    expect(last(s.delivered).units).toBe("mph");
    for (const b of Array.from(s.host.querySelectorAll("#ckpreview-angles button"))) (b as HTMLButtonElement).click();
    expect(last(s.delivered).angle).toBe("above");
    expect(s.host.querySelector('[data-angle="above"]')?.getAttribute("aria-pressed")).toBe("true");
    s.api.close(true);
    expect(s.disposed.length).toBe(1);
    expect(s.host.querySelector("iframe")).toBe(null);
    expect([...s.store.disk]).toEqual(beforeDisk);
    expect(s.race).toEqual(beforeRace);
    expect(document.activeElement?.id).toBe("pm-ckpreview");
    s.api.unmount(); s.fold.remove();
    await flush();
  });

  it("changing options and coordinated presets repaint the same iframe and stay persisted after close", () => {
    const s = setup();
    s.api.open(); const fr = frame(s.host); fr.onload?.(new Event("load"));
    s.opts.setPreset("historic");
    expect(s.host.querySelector("iframe")).toBe(fr);
    expect(last(s.delivered).wheel).toBe("round");
    expect(last(s.delivered).halo).toBe(0);
    s.api.close(); s.api.open();
    expect(last(s.delivered).interior).toBe("classic");
    expect(s.opts.preset()).toBe("historic");
    s.opts.setPreset("modern");
    expect(last(s.delivered).body).toBe("sculpted");
    expect(document.querySelector("#ckpreview .adv-help")?.textContent).toBe("Stationary preview · SCULPTED · CARBON · F1 2026");
    s.api.unmount(); s.fold.remove();
  });

  it("collapse and Escape dispose the frame, stale load callbacks cannot reopen it, mount is idempotent", async () => {
    const s = setup();
    expect(s.preview.mount(s.host)).toBe(null);
    s.api.open(); const old = frame(s.host), oldLoad = old.onload;
    s.fold.open = false; s.fold.removeAttribute("open");
    await flush();
    expect(s.disposed.length).toBe(1);
    const count = s.delivered.length; oldLoad?.call(old, new Event("load"));
    expect(s.delivered.length).toBe(count);
    s.fold.open = true; s.api.open();
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(s.disposed.length).toBe(2);
    s.api.unmount();
    expect(document.getElementById("ckpreview")).toBe(null);
    s.fold.remove();
  });

  it("a bound player car reader supplies exact paint and parts without a settings write; the default car is the garage team", () => {
    const s = setup();
    const car = { teamId: "ferrari", livery: { c1: [0.8, 0, 0], c2: [0.1, 0.1, 0.1] }, parts: { aero: 4 }, units: "kmh" };
    const unbound = s.preview.snapshot("front");
    expect(typeof unbound.teamId).toBe("string");
    expect(unbound.units).toBe("mph");
    expect(unbound.layout).toBe(s.opts.layout());
    s.preview.bind(() => car);
    const st = s.preview.snapshot("rear");
    expect(st.livery).toBe(car.livery);
    expect(st.parts).toBe(car.parts);
    expect(st.teamId).toBe("ferrari");
    expect(st.angle).toBe("rear");
    expect(s.store.disk.size).toBe(0);
    s.api.unmount(); s.fold.remove();
  });

  it("without a frame API the status says the preview is unavailable", () => {
    const opts = createCockpitOpts({ store: mapStore(), search: () => "" });
    const host = document.createElement("div"); document.body.appendChild(host);
    const m = createCockpitPreview({ opts, frameSrc: "about:blank", frameApi: () => null }).mount(host);
    m?.open(); const fr = frame(host); fr.onload?.(new Event("load"));
    expect(host.querySelector("#ckpreview .adv-help")?.textContent).toBe("Preview unavailable. Your cockpit choices are saved.");
    m?.unmount(); host.remove();
  });
});
