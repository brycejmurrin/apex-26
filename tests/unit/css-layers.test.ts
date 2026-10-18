/**
 * Cascade-layer guards for every stylesheet under src/. Ported from f1-game
 * tests/unit/css-layers.test.mjs:72-155: content outside a layer is UNLAYERED
 * and beats every layered rule in the project regardless of specificity, and
 * the layer ORDER statement must live in one place (src/styles/tokens.css).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd(), "src");
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : []);
}
const stripComments = (s: string): string => s.replace(/\/\*[^]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
const files = walk(ROOT).sort();
const TOKENS = join(ROOT, "styles/tokens.css");
const rel = (f: string): string => relative(ROOT, f);
const src = (f: string): string => stripComments(readFileSync(f, "utf8"));

describe("css layers", () => {
  it("finds the foundation sheets", () => {
    expect(files.map(rel)).toEqual(expect.arrayContaining(["styles/tokens.css", "styles/components.css"]));
  });

  for (const file of files.filter((f) => f !== TOKENS)) {
    it(`${rel(file)}: opens with its @layer and has nothing outside a layer`, () => {
      const lines = src(file).split("\n");
      const first = (lines.find((l) => l.trim()) || "").trim();
      expect(first, "first rule").toMatch(/^@layer\s+[\w-]+\s*\{/);
      const bare: string[] = [];
      let d = 0;
      lines.forEach((line, idx) => {
        const t = line.trim();
        if (t && d === 0 && !/^@layer\s+[\w-]+\s*\{/.test(t) && !t.startsWith("}")) bare.push(`${idx + 1}: ${t.slice(0, 60)}`);
        d += (line.match(/\{/g) || []).length;
        d -= (line.match(/\}/g) || []).length;
      });
      expect(d, "unbalanced braces").toBe(0);
      expect(bare).toEqual([]);
    });
  }

  it("declares the cascade order exactly once, in src/styles/tokens.css", () => {
    const decls = files.filter((f) => /@layer\s+[\w-]+\s*(,\s*[\w-]+\s*)+;/.test(src(f))).map(rel);
    expect(decls).toEqual(["styles/tokens.css"]);
  });
});
