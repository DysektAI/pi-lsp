import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const expectedVersion = "5.0.12";
const manifest = readJson(new URL("package.json", root));
const lock = readJson(new URL("package-lock.json", root));

assert.equal(manifest.overrides?.["brace-expansion"], expectedVersion, "brace-expansion override must be exact");
const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith("node_modules/brace-expansion"));
assert.ok(entries.length > 0, "lockfile must contain brace-expansion");
for (const [path, entry] of entries) {
  assert.equal(entry.version, expectedVersion, `${path} must resolve ${expectedVersion}`);
}

// Use the same npm CLI and Node as the invoking npm command, including on Windows.
assert.ok(process.env.npm_execpath, "run this validator through npm run verify:dependencies");
const tree = JSON.parse(execFileSync(process.execPath, [process.env.npm_execpath, "ls", "--all", "--json"], {
  cwd: root,
  encoding: "utf8",
}));
let installedCount = 0;
const visit = (node) => {
  assert.ok(!node.problems?.length, `dependency tree problems: ${node.problems?.join(", ")}`);
  for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
    if (name === "brace-expansion") {
      installedCount++;
      assert.equal(dependency.version, expectedVersion, `installed ${name} must resolve ${expectedVersion}`);
    }
    visit(dependency);
  }
};
visit(tree);
assert.ok(installedCount > 0, "installed tree must contain brace-expansion");

const piRequire = createRequire(new URL("node_modules/@earendil-works/pi-coding-agent/package.json", root));
const minimatchRequire = createRequire(piRequire.resolve("minimatch"));
assert.equal(minimatchRequire("brace-expansion/package.json").version, expectedVersion, "Pi's minimatch must use patched brace-expansion");
assert.deepEqual(minimatchRequire("brace-expansion").expand("src/{index,installer}.ts"), ["src/index.ts", "src/installer.ts"]);
console.log(`Verified brace-expansion ${expectedVersion}: ${entries.length} lockfile and ${installedCount} installed tree entries; Pi minimatch resolution and ordinary expansion pass.`);
