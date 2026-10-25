// The SerpApi key is server-only: read in one module, which only the route imports, and never in a
// file that can reach the browser. (Route responses are checked in tests/serp-server.test.ts.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const files: string[] = [];
(function walk(d: string) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(f)) files.push(p);
  }
})(join(ROOT, "src"));
const rel = (p: string) => relative(ROOT, p);

describe("SerpApi key stays on the server", () => {
  it("only src/serp/server.ts reads SERPAPI_API_KEY", () => {
    const readers = files.filter((f) => readFileSync(f, "utf8").includes("SERPAPI_API_KEY")).map(rel);
    // the route and the client mention it only in comments / messages, never via process.env
    const envReaders = files.filter((f) => /process\.env\.SERPAPI_API_KEY|process\.env\[["']SERPAPI_API_KEY/.test(readFileSync(f, "utf8"))).map(rel);
    expect(envReaders).toEqual(["src/serp/server.ts"]);
    expect(readers.every((f) => /^src\/(serp|app\/api\/serp|components\/serp)\//.test(f))).toBe(true);
  });
  it("no NEXT_PUBLIC_ variant exists (it would be inlined into client bundles)", () => {
    expect(files.filter((f) => readFileSync(f, "utf8").includes("NEXT_PUBLIC_SERP")).map(rel)).toEqual([]);
  });
  it("the server module is imported only by the route handler", () => {
    const importers = files.filter((f) => /from ["']@\/serp\/server["']|from ["']\.\/server["']/.test(readFileSync(f, "utf8")) && !f.endsWith("server.ts")).map(rel);
    expect(importers).toEqual(["src/app/api/serp/route.ts"]);
  });
});
