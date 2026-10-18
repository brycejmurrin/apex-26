/**
 * The shared `mount(host, deps)` driver for the Data Hub tabs: spinner, a
 * generation guard so an overtaken load never paints, and the UPSTREAM case of
 * f1-game's hub errorBlock (js/data/hub.js:462-503) with a working RETRY.
 */
import type { HubDeps, MountedTab } from "../hub-deps";
import { log } from "../log";

export function mountTab(name: string, host: HTMLElement, deps: Pick<HubDeps, "el" | "clear" | "spinner">,
                  load: () => Promise<HTMLElement>, onUnmount: () => void): MountedTab {
  let gen = 0;
  function refresh(): Promise<void> {
    const myGen = ++gen;
    deps.clear(host);
    host.appendChild(deps.spinner());
    return load().then((node) => {
      if (myGen !== gen) return;
      deps.clear(host);
      host.appendChild(node);
    }, (err: unknown) => {
      if (myGen !== gen) return;
      log.warn("tab " + name + " fail", err);
      deps.clear(host);
      host.appendChild(errorNode(deps.el, () => { void refresh(); }));
    });
  }
  void refresh();
  return {
    refresh,
    unmount() {
      gen++;
      onUnmount();
      deps.clear(host);
    },
  };
}

// The UPSTREAM case of hub.js's errorBlock (hub.js:462-503), same classes.
export function errorNode(el: HubDeps["el"], retryFn: () => void): HTMLElement {
  const w = el("div", "dh-error");
  w.setAttribute("role", "status");
  w.dataset.reason = "upstream";
  const titleEl = el("div", "dh-error-msg", "SERVICE UNAVAILABLE");
  titleEl.dataset.role = "title";
  w.appendChild(titleEl);
  w.appendChild(el("div", "dh-error-msg", "Couldn't reach the F1 data service. It may be busy or blocked — try again in a moment."));
  const retry = el("button", "dh-retry", "RETRY");
  retry.type = "button";
  retry.addEventListener("click", retryFn);
  w.appendChild(retry);
  return w;
}
