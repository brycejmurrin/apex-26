// Fails `npm test` when node_modules/three is reinstalled without patches/three+*.patch
// applied (or upstream changed the shape). See patches/README.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// three's exports map hides package.json from require.resolve, so locate it directly.
const threeDir = fileURLToPath(new URL("../../node_modules/three/", import.meta.url));
const pkg = JSON.parse(readFileSync(join(threeDir, "package.json"), "utf8")) as {
  version: string;
  exports: Record<string, unknown>;
};
// The file Vite bundles for `three/webgpu`.
const webgpuEntry = pkg.exports["./webgpu"] as string;
const src = readFileSync(join(threeDir, webgpuEntry), "utf8");
const count = (needle: string) => src.split(needle).length - 1;

describe("three.js patches (patches/three+0.186.1.patch)", () => {
  it("targets three 0.186.1 through build/three.webgpu.js", () => {
    expect(pkg.version).toBe("0.186.1");
    expect(webgpuEntry).toBe("./build/three.webgpu.js");
  });

  it("#1 swizzle: both GPUTextureViewDescriptor sites are undefined, none is 'rgba'", () => {
    expect(count("this.swizzle = undefined; // apex-26 patch #1")).toBe(2);
    expect(count("this.swizzle = 'rgba';")).toBe(0);
  });

  it("#4 var<private>: render-stage vars are emitted inside main()", () => {
    expect(count("this.getVars( shaderStage, shaderStage === 'compute' && allowGlobal ); // apex-26 patch #4")).toBe(1);
    expect(count("this.getVars( shaderStage, allowGlobal );")).toBe(0);
    // The pristine WGSL templates (GLSLNodeBuilder's module-scope vars are fine and stay).
    expect(count("// vars\n${shaderData.vars}\n\n// codes\n${shaderData.codes}\n\n@vertex")).toBe(0);
    expect(count("// vars\n${shaderData.vars}\n\n// codes\n${shaderData.codes}\n\n@fragment")).toBe(0);
    expect(count("@vertex\nfn main( ${shaderData.attributes} ) -> VaryingsStruct {\n\n\t// vars\n\t${shaderData.vars}\n")).toBe(1);
    expect(
      count("@fragment\nfn main( ${shaderData.varyings} ) -> ${shaderData.returnType} {\n\n\t// vars\n\t${shaderData.vars}\n"),
    ).toBe(1);
  });
});
