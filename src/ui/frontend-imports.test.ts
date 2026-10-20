import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

const VALUE_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
const SERVER_ONLY = /^(?:node:|@get-bb\/plugin-sdk$)/;

function serverOnlyImports(entry: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(VALUE_IMPORT)) {
      if (SERVER_ONLY.test(specifier)) found.push(`${file}: ${specifier}`);
      else if (specifier.startsWith(".") && /\.tsx?$/.test(specifier)) visit(resolve(dirname(file), specifier));
    }
  };
  visit(entry);
  return found;
}

test("the frontend bundle imports no Node built-in or server SDK module", () => {
  assert.deepEqual(serverOnlyImports(resolve(import.meta.dirname, "../app.tsx")), []);
});
