import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseBackend, isWebKitUA, parsePin } from "../../src/render/policy";

const UA = {
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
  iosFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/140.0 Mobile/15E148 Safari/605.1.15",
  iosEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/141.0.0.0 Version/26.0 Mobile/15E148 Safari/604.1",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  chrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  headless:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
  edge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
};

describe("chooseBackend", () => {
  it("?gl=1 forces WebGL2 whatever else is true", () => {
    for (const isWebKit of [true, false])
      for (const hasAdapter of [true, false])
        expect(chooseBackend({ pin: "1", isWebKit, hasAdapter })).toEqual({ forceWebGL: true, reason: "pin-webgl" });
  });

  it("?gl=0 allows WebGPU even on WebKit or with no adapter", () => {
    for (const isWebKit of [true, false])
      for (const hasAdapter of [true, false])
        expect(chooseBackend({ pin: "0", isWebKit, hasAdapter })).toEqual({ forceWebGL: false, reason: "pin-webgpu" });
  });

  it("auto on WebKit forces WebGL2, adapter or not", () => {
    expect(chooseBackend({ pin: null, isWebKit: true, hasAdapter: true })).toEqual({ forceWebGL: true, reason: "webkit" });
    expect(chooseBackend({ pin: null, isWebKit: true, hasAdapter: false })).toEqual({ forceWebGL: true, reason: "webkit" });
  });

  it("auto with no adapter forces WebGL2", () => {
    expect(chooseBackend({ pin: null, isWebKit: false, hasAdapter: false })).toEqual({
      forceWebGL: true,
      reason: "no-adapter",
    });
  });

  it("auto with an adapter off WebKit allows WebGPU", () => {
    expect(chooseBackend({ pin: null, isWebKit: false, hasAdapter: true })).toEqual({ forceWebGL: false, reason: "auto" });
  });
});

describe("parsePin", () => {
  it("reads ?gl=1 and ?gl=0 only", () => {
    expect(parsePin("?gl=1")).toBe("1");
    expect(parsePin("?foo=bar&gl=0")).toBe("0");
    expect(parsePin("")).toBeNull();
    expect(parsePin("?gl=")).toBeNull();
    expect(parsePin("?gl=webgl")).toBeNull();
    expect(parsePin("?gl=2")).toBeNull();
  });
});

describe("isWebKitUA (f1-game tlx.js:208)", () => {
  it("flags Safari and every iOS browser", () => {
    for (const ua of [UA.iosSafari, UA.iosChrome, UA.iosFirefox, UA.iosEdge, UA.macSafari]) expect(isWebKitUA(ua)).toBe(true);
  });
  it("does not flag Chromium-family or Gecko desktop browsers", () => {
    for (const ua of [UA.chrome, UA.headless, UA.edge, UA.firefox, ""]) expect(isWebKitUA(ua)).toBe(false);
  });
});

describe("policy module", () => {
  it("does not import three, so it stays testable and cheap in Node", () => {
    const src = readFileSync(new URL("../../src/render/policy.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s+["']three/);
    expect(src).not.toMatch(/import\(\s*["']three/);
  });
});
