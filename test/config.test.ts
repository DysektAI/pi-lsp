import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

const original = process.env.PI_CODING_AGENT_DIR;
let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = original;
});

function isolate() {
  directory = mkdtempSync(join(tmpdir(), "pi-lsp-config-"));
  process.env.PI_CODING_AGENT_DIR = directory;
}

describe("configuration", () => {
  it("uses consent-preserving defaults", () => {
    isolate();
    expect(loadConfig()).toEqual({ installMode: "prompt", warmup: true });
  });

  it("loads supported values", () => {
    isolate();
    writeFileSync(join(directory!, "lsp.json"), JSON.stringify({ installMode: "off", warmup: false }));
    expect(loadConfig()).toEqual({ installMode: "off", warmup: false });
  });

  it("falls back safely for malformed or unknown values", () => {
    isolate();
    writeFileSync(join(directory!, "lsp.json"), JSON.stringify({ installMode: "always", warmup: "yes" }));
    expect(loadConfig()).toEqual({ installMode: "prompt", warmup: true });
    writeFileSync(join(directory!, "lsp.json"), "not-json");
    expect(loadConfig()).toEqual({ installMode: "prompt", warmup: true });
  });
});
