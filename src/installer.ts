import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configDir } from "./config.js";
import type { ServerDefinition } from "./catalog.js";

export type InstallRecord = { serverId: string; installer: string; executable: string; installedAt: string; owned?: boolean };
type Lockfile = { version: 1; servers: Record<string, InstallRecord> };

export function runtimeDir(): string { return join(configDir(), "lsp"); }
function lockPath(): string { return join(runtimeDir(), "lsp.lock.json"); }
function readLock(): Lockfile {
  try { return JSON.parse(readFileSync(lockPath(), "utf8")); } catch { return { version: 1, servers: {} }; }
}
function writeLock(lock: Lockfile): void {
  mkdirSync(runtimeDir(), { recursive: true });
  writeFileSync(lockPath(), JSON.stringify(lock, null, 2) + "\n");
}
function executableName(bin: string): string { return process.platform === "win32" ? `${bin}.exe` : bin; }

export function windowsNpmInvocation(args: string[], nodeExecutable: string, npmCli: string) {
  return { command: nodeExecutable, args: [npmCli, ...args] };
}

function resolveNpmCli(): string | null {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npm-cli.js") : "",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

export function resolvePrerequisite(command: string): string | null {
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
    if (result.status === 0) {
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /\.(?:exe|com|cmd|bat)$/i.test(line)) ?? null;
    }
    return null;
  }
  const result = spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function runWithEnv(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveResult({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => resolveResult({ code: code ?? -1, stdout, stderr }));
  });
}

export function managedExecutable(server: ServerDefinition): string | null {
  const record = readLock().servers[server.key];
  return record?.owned !== false && existsSync(record?.executable ?? "") ? record.executable : null;
}

export function installRecords(): Record<string, InstallRecord> {
  return { ...readLock().servers };
}

export function uninstallServer(server: ServerDefinition): { ok: boolean; message: string } {
  const lock = readLock();
  const record = lock.servers[server.key];
  if (!record || record.owned === false) return { ok: false, message: `${server.displayName} is not owned by Pi and will not be removed.` };
  const packageDir = resolve(runtimeDir(), "packages", server.key);
  const executable = resolve(record.executable);
  if (executable !== packageDir && !executable.startsWith(`${packageDir}\\`) && !executable.startsWith(`${packageDir}/`)) {
    return { ok: false, message: `Refusing to remove executable outside Pi-managed storage: ${record.executable}` };
  }
  rmSync(packageDir, { recursive: true, force: true });
  delete lock.servers[server.key];
  writeLock(lock);
  return { ok: true, message: `Uninstalled managed ${server.displayName}` };
}

export async function installServer(pi: ExtensionAPI, server: ServerDefinition): Promise<{ ok: boolean; message: string; executable?: string }> {
  const dir = join(runtimeDir(), "packages", server.key);
  mkdirSync(dir, { recursive: true });
  let command: string;
  let args: string[];
  let executable: string;
  switch (server.installer.type) {
    case "npm": {
      command = "npm";
      args = ["install", "--prefix", dir, "--no-save", ...server.installer.packages];
      if (process.platform === "win32") {
        const npmCli = resolveNpmCli();
        if (!npmCli) return { ok: false, message: "npm-cli.js was not found beside Node or in the user npm directory." };
        ({ command, args } = windowsNpmInvocation(args, process.execPath, npmCli));
      }
      const shim = process.platform === "win32" ? `${server.installer.bin}.cmd` : server.installer.bin;
      executable = join(dir, "node_modules", ".bin", shim);
      break;
    }
    case "dotnet":
      command = "dotnet";
      executable = join(dir, executableName(server.installer.bin));
      args = ["tool", existsSync(executable) ? "update" : "install", "--tool-path", dir, server.installer.package];
      break;
    case "go":
      command = "go";
      args = ["install", server.installer.package];
      executable = join(dir, executableName(server.installer.bin));
      break;
    case "rustup":
      command = "rustup";
      args = ["component", "add", server.installer.component];
      executable = server.installer.bin;
      break;
  }
  let result: { code: number; stdout: string; stderr: string };
  if (server.installer.type === "go") {
    let goExecutable = resolvePrerequisite("go");
    if (!goExecutable && process.platform === "win32") {
      const winget = resolvePrerequisite("winget");
      if (!winget) return { ok: false, message: "The Go toolchain is required. Install it from https://go.dev/dl/ and retry." };
      const bootstrap = await pi.exec(winget, ["install", "--id", "GoLang.Go", "--exact", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"], { timeout: 300000 });
      if (bootstrap.code !== 0) return { ok: false, message: bootstrap.stderr.trim() || bootstrap.stdout.trim() || "winget could not install the Go toolchain" };
      const programFilesGo = join(process.env.ProgramFiles ?? "C:\\Program Files", "Go", "bin", "go.exe");
      goExecutable = existsSync(programFilesGo) ? programFilesGo : resolvePrerequisite("go");
    }
    if (!goExecutable) return { ok: false, message: "The Go toolchain is required. Install it from https://go.dev/dl/ (or your system package manager) and retry." };
    result = await runWithEnv(goExecutable, ["install", server.installer.package], { ...process.env, GOBIN: dir });
  } else {
    try {
      result = await pi.exec(command, args, { timeout: 180000 });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
  if (result.code !== 0) return { ok: false, message: result.stderr.trim() || result.stdout.trim() || `${command} exited ${result.code}` };
  if (server.installer.type === "rustup") executable = server.installer.bin;
  if (server.installer.type !== "rustup" && !existsSync(executable)) return { ok: false, message: `Install completed but executable was not found at ${executable}` };
  const lock = readLock();
  lock.servers[server.key] = { serverId: server.key, installer: server.installer.type, executable, installedAt: new Date().toISOString(), owned: server.installer.type !== "rustup" };
  writeLock(lock);
  return { ok: true, message: `Installed ${server.displayName}`, executable };
}
