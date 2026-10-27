import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("reviewed development test runner", () => {
 it("pins Vitest and resolves patched mock handlers for both moderate advisories", () => {
  const manifest=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  const lock=JSON.parse(readFileSync(new URL("../package-lock.json",import.meta.url),"utf8"));
  expect(manifest.devDependencies.vitest).toBe("4.1.12");
  const mockers=Object.entries(lock.packages).filter(([name])=>name.endsWith("node_modules/@vitest/mocker"));
  expect(mockers.length).toBeGreaterThan(0);
  for(const [,entry] of mockers) expect((entry as {version:string}).version).toBe("4.1.12");
  expect(manifest.dependencies?.vitest).toBeUndefined();
  expect(manifest.files).not.toContain("node_modules/");
 });
});
