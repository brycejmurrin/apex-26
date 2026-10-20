/**
 * Mount/unmount leak probe for the camera lane's DOM panels: records every
 * addEventListener / removeEventListener on EventTarget.prototype and every
 * setTimeout / clearTimeout while installed, so a test can assert that an
 * unmount left no listener on anything still reachable (window, document, a
 * connected node) and no timer pending.
 */
type Rec = { target: EventTarget; type: string; fn: unknown; capture: boolean };

export interface LeakProbe {
  /** Listeners still registered on window / document / connected nodes. */
  liveListeners(): string[];
  /** Timers set and neither fired nor cleared. */
  pendingTimers(): number;
  restore(): void;
}

const captureOf = (o: unknown): boolean => (typeof o === "boolean" ? o : !!(o && (o as { capture?: boolean }).capture));

export function leakProbe(): LeakProbe {
  // The DOM's own EventTarget (happy-dom's), which may not be the runtime's global one.
  const owner = (o: object): EventTarget => {
    let p: object | null = o;
    while (p && !Object.prototype.hasOwnProperty.call(p, "addEventListener")) p = Object.getPrototypeOf(p) as object | null;
    return p as EventTarget;
  };
  const protos = [...new Set([owner(document.body), owner(window), owner(document), EventTarget.prototype])];
  const live: Rec[] = [];
  const saved = protos.map((p) => [p.addEventListener, p.removeEventListener] as const);
  protos.forEach((proto, k) => {
  const add = saved[k]![0], remove = saved[k]![1];
  proto.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | AddEventListenerOptions) {
    if (fn) {
      const capture = captureOf(o);
      if (!live.some((r) => r.target === this && r.type === type && r.fn === fn && r.capture === capture)) live.push({ target: this, type, fn, capture });
    }
    return add.call(this, type, fn, o);
  };
  proto.removeEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, o?: boolean | EventListenerOptions) {
    const capture = captureOf(o);
    const i = live.findIndex((r) => r.target === this && r.type === type && r.fn === fn && r.capture === capture);
    if (i >= 0) live.splice(i, 1);
    return remove.call(this, type, fn, o);
  };
  });
  const st = globalThis.setTimeout, ct = globalThis.clearTimeout;
  const pending = new Set<unknown>();
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const id: unknown = st(((...a: unknown[]) => { pending.delete(id); cb(...a); }) as () => void, ms, ...rest);
    pending.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: unknown) => { pending.delete(id); ct(id as Parameters<typeof clearTimeout>[0]); }) as typeof clearTimeout;
  const reachable = (t: EventTarget): boolean =>
    (typeof window !== "undefined" && t === window) || (typeof document !== "undefined" && t === document) || (t instanceof Node && t.isConnected);
  const name = (t: EventTarget): string => (t instanceof Element ? t.tagName.toLowerCase() + (t.id ? "#" + t.id : "") : t === window ? "window" : "document");
  return {
    liveListeners: () => live.filter((r) => reachable(r.target)).map((r) => name(r.target) + ":" + r.type),
    pendingTimers: () => pending.size,
    restore() {
      protos.forEach((p, k) => { p.addEventListener = saved[k]![0]; p.removeEventListener = saved[k]![1]; });
      globalThis.setTimeout = st; globalThis.clearTimeout = ct;
    },
  };
}
