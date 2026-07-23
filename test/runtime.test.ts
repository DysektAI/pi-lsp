import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { detectApplicableServers, findRoot, formatWorkspaceEdit, parseLspFrames } from "../src/index.js";
import { runtimeDir, uninstallServer } from "../src/installer.js";
import { SERVERS } from "../src/catalog.js";

const tempDirs: string[] = [];
const originalConfigDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalConfigDir;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-lsp-"));
  tempDirs.push(dir);
  return dir;
}

function frame(value: unknown): Buffer {
  const body = JSON.stringify(value);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

describe("JSON-RPC framing", () => {
  it("retains partial messages and parses multiple frames", () => {
    const first = frame({ jsonrpc: "2.0", id: 1, result: "ok" });
    const split = Math.floor(first.length / 2);
    const partial = parseLspFrames(Buffer.alloc(0), first.subarray(0, split));
    expect(partial.messages).toEqual([]);
    const complete = parseLspFrames(partial.rest, Buffer.concat([first.subarray(split), frame({ method: "ready" })]));
    expect(complete.messages).toEqual([{ jsonrpc: "2.0", id: 1, result: "ok" }, { method: "ready" }]);
    expect(complete.rest.length).toBe(0);
  });
});

describe("workspace behavior", () => {
  it("prefers a containing C# solution over the nearest project", () => {
    const root = temp();
    const project = join(root, "src", "App");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(root, "App.sln"), "");
    writeFileSync(join(project, "App.csproj"), "");
    const file = join(project, "Program.cs");
    writeFileSync(file, "class Program {}");
    expect(findRoot(file, ["*.sln", "*.slnx", "global.json", "Directory.Build.props", "Directory.Build.targets", "*.csproj"], true)).toBe(root);
  });

  it("detects applicable servers while ignoring dependency trees", () => {
    const root = temp();
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
    writeFileSync(join(root, "src", "main.go"), "package main");
    writeFileSync(join(root, "config.yaml"), "name: test");
    writeFileSync(join(root, "node_modules", "ignored", "hidden.py"), "");
    expect(detectApplicableServers(root).map((server) => server.key)).toEqual(["go", "yaml"]);
  });

  it("formats changes and documentChanges for safe previews", () => {
    const file = join(temp(), "a.ts");
    const lines = formatWorkspaceEdit({
      changes: { [pathToFileURL(file).href]: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, newText: "next" }] },
    });
    expect(lines[0]).toContain(`${file}:2:3-2:6 => next`);
  });
});

describe("managed ownership", () => {
  it("uninstalls only an executable recorded inside the server package directory", () => {
    const agentDir = temp();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const server = SERVERS.find((candidate) => candidate.key === "typescript")!;
    const packageDir = join(runtimeDir(), "packages", server.key);
    const executable = join(packageDir, "node_modules", ".bin", "typescript-language-server.cmd");
    mkdirSync(join(packageDir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(executable, "");
    mkdirSync(runtimeDir(), { recursive: true });
    writeFileSync(join(runtimeDir(), "lsp.lock.json"), JSON.stringify({ version: 1, servers: { typescript: { serverId: "typescript", installer: "npm", executable, installedAt: new Date().toISOString(), owned: true } } }));
    expect(uninstallServer(server)).toMatchObject({ ok: true });
    expect(existsSync(packageDir)).toBe(false);
  });

  it("refuses to remove an executable outside managed storage", () => {
    const agentDir = temp();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const server = SERVERS.find((candidate) => candidate.key === "typescript")!;
    mkdirSync(runtimeDir(), { recursive: true });
    const external = join(agentDir, "external.cmd");
    writeFileSync(external, "");
    writeFileSync(join(runtimeDir(), "lsp.lock.json"), JSON.stringify({ version: 1, servers: { typescript: { serverId: "typescript", installer: "npm", executable: external, installedAt: new Date().toISOString(), owned: true } } }));
    expect(uninstallServer(server)).toMatchObject({ ok: false });
    expect(existsSync(external)).toBe(true);
  });
});
