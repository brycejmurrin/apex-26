/// <reference lib="webworker" />
/**
 * The offline cache service worker (vite-plugin-pwa `injectManifest`).
 * Port of f1-game sw.js:1-1088 onto Workbox.
 *
 * f1-game had no build step, so its worker discovered the shell's assets by
 * parsing index.html at install and named each cache generation after
 * version.json. Here Vite content-hashes every asset and injects the list
 * (`self.__WB_MANIFEST`), so that half collapses into `precacheAndRoute`.
 * What is kept, because the reasons still hold:
 * - PRECACHE the shell pages and hashed assets; LAZY-CACHE audio on first use
 *   and NEVER precache voice packs (sw.js:209-232, 351-359).
 * - A streamed `Range:` request (music in an <audio> element) is LEFT TO THE
 *   NETWORK: the cache holds whole 200s and Safari needs a 206 (sw.js:222-232).
 * - Voice packs and the baked asset pack are unversioned, so they are
 *   NETWORK-FIRST with a 3 s race against the cache (sw.js:176-207, 339-359).
 * - Only the GAME's own address is answered with the game shell; another root
 *   page (controller.html, overlay.html) is never served index.html
 *   (sw.js:52-54, 327-334).
 * - Cross-origin requests (Jolpica, OpenF1, Nostr, TURN) are never touched.
 * - Updates wait for the player: a new worker installs and WAITS until the page
 *   posts SKIP_WAITING (src/pwa/update.ts, the shell version guard's successor).
 *
 * Cache names carry the `a26` prefix: f1-game owns `apex26-*` caches on the
 * same origin (brycejmurrin.github.io), and neither worker may sweep the other.
 */
import { clientsClaim, setCacheNameDetails } from "workbox-core";
import type { WorkboxPlugin } from "workbox-core/types";
import { ExpirationPlugin } from "workbox-expiration";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<PrecacheEntry | string> };

/** A navigation / unversioned asset races the network this long before the cache answers (sw.js:21). */
const NAV_RACE_S = 3;

setCacheNameDetails({ prefix: "a26" });

// Precached URLs never carry a query of their own, so any query (?go=,
// ?demo, a ?b= bust, #vs= is a fragment and never reaches us) still matches.
precacheAndRoute(self.__WB_MANIFEST, { ignoreURLParametersMatching: [/.*/] });
cleanupOutdatedCaches();

const scope = new URL(self.registration.scope);

// The GAME shell answers only the game's own address: an extensionless deep
// link under the scope (sw.js:52-54). Any *.html page is precached under its
// own URL and never answered with index.html.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL(new URL("index.html", scope).pathname), {
    allowlist: [new RegExp("^" + scope.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))],
    denylist: [/\.[A-Za-z0-9]+$/],
  }),
);

// workbox-expiration declares its hooks `?: Callback | undefined`, which
// exactOptionalPropertyTypes refuses against WorkboxPlugin; the object is fine.
const expire = (maxEntries: number): WorkboxPlugin => new ExpirationPlugin({ maxEntries, purgeOnQuotaError: true }) as unknown as WorkboxPlugin;

const sameOrigin = (url: URL): boolean => url.origin === self.location.origin;

// AUDIO: cache-first on first use, whole responses only (sw.js:222-232, 361-363).
registerRoute(
  ({ url, request }) => sameOrigin(url) && url.pathname.startsWith(scope.pathname + "audio/") && !request.headers.has("range"),
  new CacheFirst({
    cacheName: "a26-audio",
    plugins: [expire(400)],
  }),
);

// VOICE PACKS and the BAKED ASSET PACK: unversioned pairs, network-first
// against a NAV_RACE_S race, the cache when the network loses (sw.js:339-359).
for (const [dir, cacheName] of [
  ["assets/voice/", "a26-voice"],
  ["assets/pack/", "a26-pack"],
] as const) {
  registerRoute(
    ({ url, request }) => sameOrigin(url) && url.pathname.startsWith(scope.pathname + dir) && !request.headers.has("range"),
    new NetworkFirst({
      cacheName,
      networkTimeoutSeconds: NAV_RACE_S,
      plugins: [expire(400)],
    }),
  );
}

// The page decides when an update applies (never mid-race): src/pwa/update.ts.
self.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === "SKIP_WAITING") void self.skipWaiting();
});

// The FIRST install controls the page that registered it, so it works offline
// from the first visit; a later update still waits (above).
clientsClaim();
