// Warm-LSP extension for pi.
// Keeps one language server per (language, project-root) alive for the whole
// session, so the agent gets type errors / references / hover without paying a
// cold tsc-style process start on every call.
//
// Servers are spawned lazily on first tool use (never in the factory, per docs)
// and killed on session_shutdown. Pure JSON-RPC over stdio, no npm deps.
//
// ponytail: hand-rolled minimal LSP client. add a real lib only if this falls short.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { SERVERS, serverForExtension, type ServerDefinition as Lang } from "./catalog.js";
import { installRecords, installServer, managedExecutable, resolvePrerequisite, uninstallServer } from "./installer.js";
import { loadConfig } from "./config.js";

export const LANGS = SERVERS;
export const langFor = serverForExtension;
export function supportedLanguages(): string {
  return LANGS.map((server) => server.displayName).join(", ");
}

export function detectApplicableServers(root: string, maxEntries = 10000): Lang[] {
  const extensions = new Set<string>();
  const pending = [resolve(root)];
  const ignored = new Set([".git", "node_modules", "vendor", "target", "dist", "build", "bin", "obj", ".venv"]);
  let visited = 0;
  while (pending.length && visited < maxEntries) {
    const directory = pending.pop()!;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > maxEntries) break;
      if (entry.isDirectory() && !ignored.has(entry.name)) pending.push(join(directory, entry.name));
      else if (entry.isFile()) extensions.add(entry.name.split(".").pop()?.toLowerCase() ?? "");
    }
  }
  return LANGS.filter((server) => server.extensions.some((extension) => extensions.has(extension)));
}

export function selectResolvedCommand(stdout: string, windows = process.platform === "win32"): string | null {
  const matches = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!windows) return matches[0] ?? null;
  // npm installs both a Unix shell shim without an extension and a Windows
  // .cmd shim. where.exe may list the unusable extensionless shim first.
  return matches.find((match) => /\.(?:exe|com|cmd|bat)$/i.test(match)) ?? null;
}

export function resolveServerCommand(cmd: string): string | null {
  const windows = process.platform === "win32";
  const result = windows
    ? spawnSync("where.exe", [cmd], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-c", 'command -v "$1"', "sh", cmd], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return selectResolvedCommand(result.stdout, windows);
}

function spawnServer(executable: string, args: string[], root: string): ChildProcess {
  // Node does not execute npm's .cmd/.bat shims directly on Windows. Using a
  // shell only for these resolved wrappers keeps native executables direct.
  const shell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable);
  return spawn(executable, args, {
    cwd: root,
    stdio: ["pipe", "pipe", "ignore"],
    shell,
    windowsHide: true,
  });
}

function hasMarker(dir: string, marker: string): boolean {
  if (!marker.startsWith("*.")) return existsSync(join(dir, marker));
  try {
    const suffix = marker.slice(1).toLowerCase();
    return readdirSync(dir).some((entry) => entry.toLowerCase().endsWith(suffix));
  } catch {
    return false;
  }
}

export function findRoot(file: string, markers: string[], preferSolution = false): string {
  const fallback = dirname(resolve(file));
  const dirs: string[] = [];
  let dir = fallback;
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (preferSolution) {
    // C# should load a solution containing the file's nearest project. Ignore
    // unrelated solution files above the first project/config boundary.
    const boundaryIndex = dirs.findIndex((candidate) =>
      markers.slice(2).some((marker) => hasMarker(candidate, marker))
    );
    const solutionSearchDirs = boundaryIndex >= 0 ? dirs.slice(0, boundaryIndex + 3) : dirs;
    for (const marker of markers.slice(0, 2)) {
      const match = solutionSearchDirs.find((candidate) => hasMarker(candidate, marker));
      if (match) return match;
    }
    if (boundaryIndex >= 0) return dirs[boundaryIndex];
    return fallback;
  }

  for (const candidate of dirs) {
    if (markers.some((marker) => hasMarker(candidate, marker))) return candidate;
  }
  return fallback;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function withTimeout<T, S>(p: Promise<T>, ms: number, sentinel: S): Promise<T | S> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<S>((r) => { t = setTimeout(() => r(sentinel), ms); })])
    .finally(() => clearTimeout(t)) as Promise<T | S>;
}

const SEV = ["", "error", "warning", "info", "hint"];

export function isServerRequest(msg: any): boolean {
  return msg.id !== undefined && typeof msg.method === "string";
}

export function parseLspFrames(buffer: Buffer, chunk: Buffer): { rest: Buffer; messages: any[] } {
  let rest = Buffer.concat([buffer, chunk]);
  const messages: any[] = [];
  for (;;) {
    const separator = rest.indexOf("\r\n\r\n");
    if (separator < 0) break;
    const match = /Content-Length:\s*(\d+)/i.exec(rest.subarray(0, separator).toString("ascii"));
    if (!match) { rest = rest.subarray(separator + 4); continue; }
    const length = Number(match[1]);
    const start = separator + 4;
    if (rest.length < start + length) break;
    const body = rest.subarray(start, start + length).toString("utf8");
    rest = rest.subarray(start + length);
    try { messages.push(JSON.parse(body)); } catch { /* discard malformed payload and continue */ }
  }
  return { rest, messages };
}

// ---------------------------------------------------------------------------
// Minimal LSP client over stdio.
// ---------------------------------------------------------------------------
type Diagnostic = { range: any; severity?: number; message: string; source?: string; code?: any };

class LspClient {
  private proc: ChildProcess;
  private buf: Buffer = Buffer.alloc(0);
  private id = 0;
  private pending = new Map<number, { resolve: (r: any) => void; timer: NodeJS.Timeout }>();
  private diagWaiters: Array<{ uri: string; resolve: (d: Diagnostic[]) => void }> = [];
  private latestDiags = new Map<string, Diagnostic[]>();
  private versions = new Map<string, number>();
  private opened = new Set<string>();
  private workspaceReady = Promise.resolve();
  private finishWorkspaceLoad: (() => void) | null = null;
  private alive = true;
  lastDiagAt = 0;
  ready: Promise<boolean>;
  readonly lang: Lang;
  readonly root: string;

  constructor(lang: Lang, root: string, executable: string) {
    this.lang = lang;
    this.root = root;
    this.proc = spawnServer(executable, lang.args, root);
    this.proc.on("error", () => { this.alive = false; });
    this.proc.on("exit", () => {
      this.alive = false;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(undefined); }
      this.pending.clear();
    });
    this.proc.stdin!.on("error", () => { this.alive = false; });
    this.proc.stdout!.on("data", (d) => this.onData(d));
    this.ready = this.initialize();
  }

  private onData(d: Buffer) {
    const parsed = parseLspFrames(this.buf, d);
    this.buf = parsed.rest;
    for (const message of parsed.messages) this.dispatch(message);
  }

  private dispatch(msg: any) {
    // Server requests have their own id namespace. Check method first so a
    // server request whose id matches one of ours is not mistaken for a reply.
    if (isServerRequest(msg)) {
      let result: any = null;
      if (msg.method === "workspace/configuration") {
        result = (msg.params?.items ?? []).map(() => ({}));
      }
      this.send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    // response to our request
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!;
      clearTimeout(pending.timer);
      pending.resolve(msg.result);
      this.pending.delete(msg.id);
      return;
    }
    // notifications
    if (msg.method === "$/progress" && msg.params?.value?.kind === "end") {
      this.finishWorkspaceLoad?.();
      this.finishWorkspaceLoad = null;
      return;
    }
    if (msg.method === "window/logMessage" && msg.params?.type === 1) {
      this.finishWorkspaceLoad?.();
      this.finishWorkspaceLoad = null;
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const uri: string = msg.params.uri;
      const diags: Diagnostic[] = msg.params.diagnostics ?? [];
      this.latestDiags.set(uri, diags);
      this.lastDiagAt = performance.now();
      for (let i = this.diagWaiters.length - 1; i >= 0; i--) {
        if (this.diagWaiters[i].uri === uri) {
          this.diagWaiters[i].resolve(diags);
          this.diagWaiters.splice(i, 1);
        }
      }
    }
  }

  private send(obj: any) {
    if (!this.alive || !this.proc.stdin?.writable) return;
    const s = JSON.stringify(obj);
    try { this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`); } catch { this.alive = false; }
  }
  private request<T = any>(method: string, params: any): Promise<T> {
    if (!this.alive) return Promise.reject(new Error(`${this.lang.cmd} is not running`));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} request timed out`));
      }, method === "initialize" ? 25000 : 30000);
      this.pending.set(id, { resolve, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  private notify(method: string, params: any) { this.send({ jsonrpc: "2.0", method, params }); }
  private nextDiag(uri: string) { return new Promise<Diagnostic[]>((res) => this.diagWaiters.push({ uri, resolve: res })); }
  private drainDiag(uri: string) { this.diagWaiters = this.diagWaiters.filter((w) => w.uri !== uri); }

  private async initialize(): Promise<boolean> {
    const rootUri = pathToFileURL(this.root).href;
    const init = await this.request("initialize", {
      processId: process.pid,
      rootPath: this.root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "root" }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
        },
        workspace: { configuration: true, workspaceFolders: true },
        window: { workDoneProgress: true },
      },
      initializationOptions: {},
    }).catch(() => null);
    if (init === null) return false;
    if (this.lang.key === "csharp") {
      this.workspaceReady = new Promise<void>((resolve) => { this.finishWorkspaceLoad = resolve; });
      setTimeout(() => {
        this.finishWorkspaceLoad?.();
        this.finishWorkspaceLoad = null;
      }, 60000).unref();
    }
    this.notify("initialized", {});
    return true;
  }

  private async waitUntilWorkspaceReady(): Promise<void> {
    if (this.lang.key === "csharp") await this.workspaceReady;
  }

  /** Open (or re-open) a file with current disk content; returns the text. */
  openFresh(file: string): string {
    const abs = resolve(file);
    const uri = pathToFileURL(abs).href;
    const text = readFileSync(abs, "utf8");
    if (this.opened.has(uri)) { this.notify("textDocument/didClose", { textDocument: { uri } }); this.opened.delete(uri); }
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.lang.languageId, version, text } });
    this.opened.add(uri);
    return text;
  }

  /** Re-open and wait for the server to publish diagnostics; settle on the final report. */
  async diagnostics(file: string): Promise<{ diags: Diagnostic[]; timedOut: boolean }> {
    const uri = pathToFileURL(resolve(file)).href;
    if (this.lang.key === "csharp") {
      this.openFresh(file);
      await this.waitUntilWorkspaceReady();
      const report = await this.request<any>("textDocument/diagnostic", {
        textDocument: { uri },
      }).catch(() => null);
      if (report === null) return { diags: [], timedOut: true };
      return { diags: report.items ?? [], timedOut: false };
    }

    this.drainDiag(uri); // clear any leftover waiter from a prior timed-out call
    const waiter = this.nextDiag(uri);
    this.openFresh(file);
    let diags = await withTimeout(waiter, 12000, null);
    if (diags === null) return { diags: this.latestDiags.get(uri) ?? [], timedOut: true };
    // server emits a stale empty report on reopen, then syntactic, then semantic:
    // keep taking newer reports until quiet, so we settle on the real (last) one
    for (;;) {
      const more = await withTimeout(this.nextDiag(uri), 500, "DONE" as const);
      if (more === "DONE") break;
      diags = more;
    }
    return { diags, timedOut: false };
  }

  async hover(file: string, pos: { line: number; character: number }) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    await sleep(150); // let the server index the freshly-opened doc
    return this.request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(resolve(file)).href }, position: pos,
    }).catch(() => null);
  }
  async definition(file: string, pos: { line: number; character: number }) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    await sleep(150);
    return this.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(resolve(file)).href }, position: pos,
    }).catch(() => null);
  }
  async references(file: string, pos: { line: number; character: number }) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    await sleep(150);
    return this.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(resolve(file)).href }, position: pos, context: { includeDeclaration: false },
    }).catch(() => null);
  }
  async documentSymbols(file: string) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    return this.request("textDocument/documentSymbol", {
      textDocument: { uri: pathToFileURL(resolve(file)).href },
    }).catch(() => null);
  }
  async workspaceSymbols(file: string, query: string) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    await sleep(150);
    return this.request("workspace/symbol", { query }).catch(() => null);
  }
  async rename(file: string, pos: { line: number; character: number }, newName: string) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    return this.request("textDocument/rename", {
      textDocument: { uri: pathToFileURL(resolve(file)).href }, position: pos, newName,
    }).catch(() => null);
  }
  async codeActions(file: string, range: any, diagnostics: Diagnostic[]) {
    this.openFresh(file);
    await this.waitUntilWorkspaceReady();
    return this.request("textDocument/codeAction", {
      textDocument: { uri: pathToFileURL(resolve(file)).href }, range, context: { diagnostics },
    }).catch(() => null);
  }

  isAlive() { return this.alive; }

  kill() {
    this.alive = false;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    try { this.proc.kill(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Helpers shared by the tools
// ---------------------------------------------------------------------------
/** Resolve a 0-based LSP position from explicit line/char (1-based) or a symbol name. */
function resolvePosition(text: string, params: { symbol?: string; line?: number; character?: number }): { line: number; character: number } | { error: string } {
  if (params.line != null) {
    return { line: Math.max(0, params.line - 1), character: Math.max(0, (params.character ?? 1) - 1) };
  }
  if (params.symbol) {
    const lines = text.split("\n");
    const re = new RegExp(`\\b${params.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    for (let i = 0; i < lines.length; i++) {
      const c = lines[i].search(re);
      if (c >= 0) return { line: i, character: c };
    }
    return { error: `symbol "${params.symbol}" not found in file` };
  }
  return { error: "provide either `symbol` or `line` (1-based)" };
}

function fmtLocation(loc: any): string {
  const uri = loc.uri ?? loc.targetUri;
  const range = loc.range ?? loc.targetSelectionRange ?? loc.targetRange;
  const p = fileURLToPath(uri);
  const rel = relative(process.cwd(), p);
  return `${rel.startsWith("..") ? p : rel}:${range.start.line + 1}:${range.start.character + 1}`;
}
function hoverText(h: any): string {
  if (!h || !h.contents) return "";
  const c = h.contents;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x.value)).join("\n");
  return c.value ?? "";
}

export function formatWorkspaceEdit(edit: any): string[] {
  const entries: Array<[string, any[]]> = [];
  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) entries.push([uri, edits as any[]]);
  for (const change of edit?.documentChanges ?? []) {
    if (change?.textDocument?.uri && Array.isArray(change.edits)) entries.push([change.textDocument.uri, change.edits]);
  }
  return entries.flatMap(([uri, edits]) => {
    let file: string;
    try { file = fileURLToPath(uri); } catch { file = uri; }
    return edits.map((textEdit) => {
      const start = textEdit.range?.start ?? { line: 0, character: 0 };
      const end = textEdit.range?.end ?? start;
      const replacement = String(textEdit.newText ?? "").replace(/\r?\n/g, "\\n");
      return `${file}:${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1} => ${replacement}`;
    });
  });
}
const textResult = (text: string, details: Record<string, unknown> = {}, isError = false) =>
  ({ content: [{ type: "text" as const, text }], details, isError });

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  const pool = new Map<string, LspClient>(); // key: `${lang.key}::${root}`
  const pages = new Map<string, { lines: string[]; offset: number }>();
  const PAGE_SIZE = 100;

  function paginatedResult(lines: string[], prefix: string, details: Record<string, unknown> = {}) {
    const shown = lines.slice(0, PAGE_SIZE);
    if (lines.length <= PAGE_SIZE) return textResult(`${prefix}${shown.join("\n")}`, { ...details, count: lines.length });
    const id = randomUUID().slice(0, 8);
    pages.set(id, { lines, offset: PAGE_SIZE });
    return textResult(`${prefix}${shown.join("\n")}\n\nShowing 1-${PAGE_SIZE} of ${lines.length}. Call lsp_more with cursor \"${id}\".`, { ...details, count: lines.length, cursor: id });
  }

  /** Get-or-spawn a warm server for this file. Returns client or an error string. */
  async function serverFor(file: string, ctx: ExtensionContext, allowInstall = true): Promise<LspClient | string> {
    const abs = resolve(file);
    if (!existsSync(abs)) return `file not found: ${file}`;
    const lang = langFor(abs);
    if (!lang) return `no language server configured for ${file} (supported: ${supportedLanguages()})`;
    let executable = managedExecutable(lang) ?? resolveServerCommand(lang.cmd);
    if (!executable) {
      const config = loadConfig();
      if (allowInstall && config.installMode === "auto") {
        const installed = await installServer(pi, lang);
        if (installed.ok) executable = installed.executable ?? resolveServerCommand(lang.cmd);
        else return `${lang.displayName} could not be installed: ${installed.message}`;
      }
    }
    if (!executable) return `${lang.displayName} is not installed. Open /lsp to install or manage it.`;
    const root = findRoot(abs, lang.markers, lang.key === "csharp");
    const key = `${lang.key}::${root}`;
    let client = pool.get(key);
    if (client && !client.isAlive()) { client.kill(); pool.delete(key); client = undefined; }
    if (!client) {
      client = new LspClient(lang, root, executable);
      pool.set(key, client);
      ctx.ui.setStatus("lsp", `lsp: starting ${lang.cmd}…`);
    }
    const ok = await client.ready;
    if (!ok) { client.kill(); pool.delete(key); return `${lang.cmd} failed to initialize (timed out)`; }
    ctx.ui.setStatus("lsp", `lsp: ${pool.size} server${pool.size === 1 ? "" : "s"} warm`);
    return client;
  }

  pi.on("session_shutdown", async () => {
    for (const c of pool.values()) c.kill();
    pool.clear();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !["read", "edit", "write"].includes(event.toolName)) return;
    const file = (event.input as { path?: unknown }).path;
    if (typeof file !== "string" || !langFor(file)) return;
    const absolute = resolve(ctx.cwd, file.replace(/^@/, ""));
    if (!existsSync(absolute)) return;
    const lang = langFor(absolute)!;
    const root = findRoot(absolute, lang.markers, lang.key === "csharp");
    const existing = pool.get(`${lang.key}::${root}`);
    if ((event.toolName === "edit" || event.toolName === "write") && existing) {
      const { diags } = await existing.diagnostics(absolute);
      const errors = diags.filter((diag) => (diag.severity ?? 1) === 1).slice(0, 10);
      if (errors.length) {
        const summary = errors.map((diag) => `${diag.range.start.line + 1}:${diag.range.start.character + 1} ${diag.message.replace(/\n/g, " ")}`);
        return { content: [...event.content, { type: "text" as const, text: `LSP diagnostics (${lang.displayName}):\n${summary.join("\n")}` }] };
      }
      return;
    }
    if (event.toolName === "read" && loadConfig().warmup && (managedExecutable(lang) ?? resolveServerCommand(lang.cmd))) {
      void serverFor(absolute, ctx, false);
    }
  });

  const posParams = {
    file: Type.String({ description: "Path to the source file." }),
    symbol: Type.Optional(Type.String({ description: "Symbol name to locate (first occurrence). Use this OR line/character." })),
    line: Type.Optional(Type.Number({ description: "1-based line number (overrides symbol)." })),
    character: Type.Optional(Type.Number({ description: "1-based column. Defaults to 1." })),
  };

  // ---- diagnostics ----
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Get type/compiler errors and warnings for a file from a warm language server (TS/JS, Python, Rust, Go, C#). Faster and more accurate than running a full build; use after editing a file to check it still type-checks.",
    promptSnippet: "Get type errors/warnings for a file via a warm language server",
    promptGuidelines: ["Use lsp_diagnostics after editing a TS/JS/Python/Rust/Go/C# file to verify it type-checks, instead of running a full build for a quick check."],
    parameters: Type.Object({ file: Type.String({ description: "Path to the source file to check." }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await serverFor(params.file, ctx);
      if (typeof c === "string") return textResult(c, {}, true);
      const { diags, timedOut } = await c.diagnostics(params.file);
      if (timedOut && diags.length === 0) return textResult(`No diagnostics received within timeout for ${params.file} (server may not push on open).`, { timedOut });
      if (diags.length === 0) return textResult(`No problems found in ${params.file}.`, { count: 0 });
      const lines = diags
        .sort((a, b) => (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line)
        .map((d) => {
          const code = d.code != null ? ` ${d.source ?? ""}${d.source ? "/" : ""}${d.code}` : d.source ? ` ${d.source}` : "";
          return `${d.range.start.line + 1}:${d.range.start.character + 1} ${SEV[d.severity ?? 1]}: ${d.message.replace(/\n/g, " ")}${code}`;
        });
      const errors = diags.filter((d) => (d.severity ?? 1) === 1).length;
      return textResult(`${params.file}\n${lines.join("\n")}`, { count: diags.length, errors });
    },
  });

  // ---- references ----
  pi.registerTool({
    name: "lsp_references",
    label: "LSP Find References",
    description: "Find all references to a symbol using semantic analysis (real call sites, not text matches). More precise than grep for renaming or impact analysis. Give a symbol name or an exact line/column.",
    promptSnippet: "Find semantic references to a symbol (more precise than grep)",
    promptGuidelines: ["Prefer lsp_references over grep when you need exact call sites of a symbol in TS/JS/Python/Rust/Go/C# code (e.g. before renaming or assessing impact)."],
    parameters: Type.Object(posParams),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await serverFor(params.file, ctx);
      if (typeof c === "string") return textResult(c, {}, true);
      const text = c.openFresh(params.file);
      const pos = resolvePosition(text, params);
      if ("error" in pos) return textResult(pos.error, {}, true);
      const res = await c.references(params.file, pos);
      if (res === null) return textResult("references request timed out", {}, true);
      const locs = (res as any[]) ?? [];
      if (locs.length === 0) return textResult("No references found.", { count: 0 });
      return paginatedResult(locs.map(fmtLocation), `${locs.length} reference(s):\n`);
    },
  });

  // ---- definition ----
  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Go to Definition",
    description: "Jump to where a symbol is defined using semantic analysis. Give a symbol name or an exact line/column.",
    promptSnippet: "Find where a symbol is defined (semantic go-to-definition)",
    parameters: Type.Object(posParams),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await serverFor(params.file, ctx);
      if (typeof c === "string") return textResult(c, {}, true);
      const text = c.openFresh(params.file);
      const pos = resolvePosition(text, params);
      if ("error" in pos) return textResult(pos.error, {}, true);
      const res = await c.definition(params.file, pos);
      if (res === null) return textResult("definition request timed out", {}, true);
      const locs = Array.isArray(res) ? res : res ? [res] : [];
      if (locs.length === 0) return textResult("No definition found.", { count: 0 });
      return textResult(locs.map(fmtLocation).join("\n"), { count: locs.length });
    },
  });

  // ---- hover ----
  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Get the type signature and documentation for a symbol (hover info). Give a symbol name or an exact line/column.",
    promptSnippet: "Get type signature + docs for a symbol (hover)",
    parameters: Type.Object(posParams),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const c = await serverFor(params.file, ctx);
      if (typeof c === "string") return textResult(c, {}, true);
      const text = c.openFresh(params.file);
      const pos = resolvePosition(text, params);
      if ("error" in pos) return textResult(pos.error, {}, true);
      const res = await c.hover(params.file, pos);
      if (res === null) return textResult("hover request timed out", {}, true);
      const t = hoverText(res);
      return t ? textResult(t, {}) : textResult("No hover info at that position.", {});
    },
  });

  pi.registerTool({
    name: "lsp_document_symbols",
    label: "LSP Document Symbols",
    description: "List classes, functions, methods, and other symbols in a source file using its language server.",
    promptSnippet: "List semantic symbols in a source file",
    parameters: Type.Object({ file: Type.String({ description: "Path to the source file." }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const client = await serverFor(params.file, ctx);
      if (typeof client === "string") return textResult(client, {}, true);
      const result = await client.documentSymbols(params.file);
      if (result === null) return textResult("document symbols request timed out", {}, true);
      const symbols = (result as any[]) ?? [];
      const flatten = (items: any[], depth = 0): string[] => items.flatMap((item) => {
        const range = item.selectionRange ?? item.range ?? item.location?.range;
        const line = range?.start?.line != null ? `:${range.start.line + 1}` : "";
        return [`${"  ".repeat(depth)}${item.name}${line}`, ...flatten(item.children ?? [], depth + 1)];
      });
      const lines = flatten(symbols);
      return lines.length ? paginatedResult(lines, "") : textResult("No document symbols found.", { count: 0 });
    },
  });

  pi.registerTool({
    name: "lsp_workspace_symbols",
    label: "LSP Workspace Symbols",
    description: "Search semantic symbols in the workspace containing a source file.",
    promptSnippet: "Search classes, functions, and other symbols across a workspace",
    parameters: Type.Object({
      file: Type.String({ description: "A source file used to select the workspace and language server." }),
      query: Type.String({ description: "Symbol name or search query." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const client = await serverFor(params.file, ctx);
      if (typeof client === "string") return textResult(client, {}, true);
      const result = await client.workspaceSymbols(params.file, params.query);
      if (result === null) return textResult("workspace symbol request timed out", {}, true);
      const symbols = (result as any[]) ?? [];
      const lines = symbols.map((symbol) => {
        const location = symbol.location ?? symbol;
        let where = "";
        try { where = fmtLocation(location); } catch { where = location.uri ?? "unknown"; }
        return `${symbol.name}${symbol.containerName ? ` — ${symbol.containerName}` : ""} (${where})`;
      });
      return lines.length ? paginatedResult(lines, `${symbols.length} workspace symbol(s):\n`) : textResult("No workspace symbols found.", { count: 0 });
    },
  });

  pi.registerTool({
    name: "lsp_rename_preview",
    label: "LSP Rename Preview",
    description: "Preview the semantic workspace edits a symbol rename would make. This tool never writes files.",
    promptSnippet: "Preview a semantic rename without applying changes",
    parameters: Type.Object({ ...posParams, newName: Type.String({ description: "Replacement symbol name." }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const client = await serverFor(params.file, ctx);
      if (typeof client === "string") return textResult(client, {}, true);
      const text = client.openFresh(params.file);
      const pos = resolvePosition(text, params);
      if ("error" in pos) return textResult(pos.error, {}, true);
      const edit = await client.rename(params.file, pos, params.newName);
      if (edit === null) return textResult("rename is unsupported, invalid at this position, or timed out", {}, true);
      const lines = formatWorkspaceEdit(edit);
      return lines.length ? paginatedResult(lines, `Rename preview (${lines.length} edit(s); no files changed):\n`) : textResult("The server returned no rename edits.", { count: 0 });
    },
  });

  pi.registerTool({
    name: "lsp_code_actions",
    label: "LSP Code Actions",
    description: "Preview code actions available at a source position. This tool never applies edits or executes commands.",
    promptSnippet: "Preview semantic quick fixes and refactorings",
    parameters: Type.Object(posParams),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const client = await serverFor(params.file, ctx);
      if (typeof client === "string") return textResult(client, {}, true);
      const text = client.openFresh(params.file);
      const pos = resolvePosition(text, params);
      if ("error" in pos) return textResult(pos.error, {}, true);
      const range = { start: pos, end: pos };
      const actions = await client.codeActions(params.file, range, []);
      if (actions === null) return textResult("code action request timed out", {}, true);
      const list = (actions as any[]) ?? [];
      const lines = list.flatMap((action, index) => {
        const title = `${index + 1}. ${action.title ?? action.command?.title ?? "Untitled action"}${action.kind ? ` [${action.kind}]` : ""}`;
        const edits = formatWorkspaceEdit(action.edit);
        return edits.length ? [title, ...edits.map((edit) => `   ${edit}`)] : [title, "   Preview unavailable (server command; not executed)."];
      });
      return lines.length ? paginatedResult(lines, `${list.length} code action(s); nothing applied:\n`, { actions: list.length }) : textResult("No code actions available.", { count: 0 });
    },
  });

  pi.registerTool({
    name: "lsp_more",
    label: "LSP More Results",
    description: "Read the next page of a large LSP result using the cursor returned by another LSP tool.",
    promptSnippet: "Read the next page of an LSP result",
    parameters: Type.Object({ cursor: Type.String({ description: "Cursor returned by an LSP tool." }) }),
    async execute(_id, params) {
      const page = pages.get(params.cursor);
      if (!page) return textResult("Unknown or expired LSP result cursor.", {}, true);
      const start = page.offset;
      const chunk = page.lines.slice(start, start + PAGE_SIZE);
      page.offset += chunk.length;
      const done = page.offset >= page.lines.length;
      if (done) pages.delete(params.cursor);
      return textResult(`${chunk.join("\n")}\n\nShowing ${start + 1}-${start + chunk.length} of ${page.lines.length}.${done ? " End of results." : ` Call lsp_more again with cursor \"${params.cursor}\".`}`, { cursor: done ? undefined : params.cursor, done });
    },
  });

  const statusFor = (server: Lang) => {
    const warm = [...pool.values()].filter((client) => client.lang.key === server.key);
    const executable = managedExecutable(server) ?? resolveServerCommand(server.cmd);
    return { executable, warm, label: warm.length ? `running (${warm.length})` : executable ? "installed" : "not installed" };
  };

  function doctorReport(): string[] {
    const records = installRecords();
    return [
      "LSP doctor:",
      ...LANGS.map((server) => {
        const status = statusFor(server);
        const record = records[server.key];
        if (record && !existsSync(record.executable) && record.owned !== false) return `  ✗ ${server.displayName}: stale managed record — reinstall recommended`;
        if (status.executable) return `  ✓ ${server.displayName}: ${status.executable}${status.warm.length ? ` (${status.warm.length} running)` : ""}`;
        const prerequisite = server.installer.type === "go" && !resolvePrerequisite("go") ? "; Go toolchain missing" : "";
        return `  ○ ${server.displayName}: not installed${prerequisite}`;
      }),
    ];
  }

  async function openManager(ctx: ExtensionContext): Promise<void> {
    for (;;) {
      const rows = LANGS.map((server) => {
        const status = statusFor(server);
        const icon = status.warm.length ? "●" : status.executable ? "◉" : "○";
        return `${icon} ${server.displayName.padEnd(24)} ${status.label}`;
      });
      const selected = await ctx.ui.select("Language servers — select one to manage", [...rows, "Install all applicable", "Doctor", "Close"]);
      if (!selected || selected === "Close") return;
      if (selected === "Doctor") { ctx.ui.notify(doctorReport().join("\n"), "info"); continue; }
      if (selected === "Install all applicable") {
        const applicable = detectApplicableServers(ctx.cwd).filter((server) => !statusFor(server).executable);
        if (!applicable.length) { ctx.ui.notify("All language servers applicable to this workspace are already installed.", "info"); continue; }
        const confirmed = await ctx.ui.confirm("Install applicable language servers?", applicable.map((server) => server.displayName).join("\n"));
        if (!confirmed) continue;
        const messages: string[] = [];
        for (const server of applicable) {
          ctx.ui.setStatus("lsp-install", `installing ${server.displayName}…`);
          const result = await installServer(pi, server);
          messages.push(`${result.ok ? "✓" : "✗"} ${result.message}`);
        }
        ctx.ui.setStatus("lsp-install", undefined);
        ctx.ui.notify(messages.join("\n"), messages.some((message) => message.startsWith("✗")) ? "warning" : "info");
        continue;
      }
      const index = rows.indexOf(selected);
      const server = LANGS[index];
      if (!server) continue;
      const status = statusFor(server);
      const managed = installRecords()[server.key]?.owned !== false && Boolean(installRecords()[server.key]);
      const action = await ctx.ui.select(`${server.displayName} — ${status.label}`, [
        status.executable ? "Details" : "Install",
        ...(status.executable ? ["Reinstall / update"] : []),
        ...(status.warm.length ? ["Stop"] : []),
        ...(managed ? ["Uninstall managed copy"] : []),
        "Back",
      ]);
      if (!action || action === "Back") continue;
      if (action === "Stop") {
        for (const [key, client] of pool) if (client.lang.key === server.key) { client.kill(); pool.delete(key); }
        ctx.ui.notify(`Stopped ${server.displayName}`, "info");
        continue;
      }
      if (action === "Details") {
        ctx.ui.notify(`${server.displayName}\nCommand: ${status.executable}\nInstaller: ${server.installer.type}\nRoots: ${server.markers.join(", ")}\nExtensions: ${server.extensions.join(", ")}`, "info");
        continue;
      }
      if (action === "Uninstall managed copy") {
        const confirmed = await ctx.ui.confirm(`Uninstall ${server.displayName}?`, "Only the Pi-managed copy will be removed. System installations are never removed.");
        if (!confirmed) continue;
        for (const [key, client] of pool) if (client.lang.key === server.key) { client.kill(); pool.delete(key); }
        const result = uninstallServer(server);
        ctx.ui.notify(result.message, result.ok ? "info" : "error");
        continue;
      }
      const prerequisite = server.installer.type === "go" && !resolvePrerequisite("go")
        ? "\nThe Go toolchain is missing. On Windows, Pi will first install the official GoLang.Go package with winget."
        : "";
      const confirmed = await ctx.ui.confirm(`Install ${server.displayName}?`, `Installer: ${server.installer.type}\nPi will manage this server under ~/.pi/agent/lsp/.${prerequisite}`);
      if (!confirmed) continue;
      ctx.ui.setStatus("lsp-install", `installing ${server.displayName}…`);
      const result = await installServer(pi, server);
      ctx.ui.setStatus("lsp-install", undefined);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    }
  }

  pi.registerCommand("lsp", {
    description: "Open the language-server manager; use /lsp status for text status",
    handler: async (args, ctx) => {
      if (args.trim() === "doctor") {
        ctx.ui.notify(doctorReport().join("\n"), "info");
        return;
      }
      if (args.trim() === "status" || ctx.mode !== "tui") {
        const lines = ["Language servers:", ...LANGS.map((server) => {
          const status = statusFor(server);
          return `  ${server.displayName.padEnd(24)} ${status.label}${status.executable ? ` — ${status.executable}` : ""}`;
        })];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      await openManager(ctx);
    },
  });
}
