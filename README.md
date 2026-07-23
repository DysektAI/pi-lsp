# @dysektai/pi-lsp

Managed, cross-platform language-server intelligence for [Pi](https://github.com/badlogic/pi-mono), with a menu-first control panel, warm semantic tools, isolated server ownership, and first-class C#/.NET and Windows support.

## Install

From GitHub:

```bash
pi install git:github.com/DysektAI/pi-lsp
```

Local development:

```bash
pi install C:\\path\\to\\pi-lsp
```

Then run `/lsp`. Do not load another extension that registers the same `lsp_*` tools.

## `/lsp` manager

`/lsp` opens an interactive list; command memorization is not required. The manager supports:

- Inspecting install and running status
- Installing and updating one server
- Installing all missing servers applicable to the current workspace
- Stopping warm processes
- Uninstalling only Pi-owned copies
- Doctor checks for stale records and missing prerequisites

Text commands remain available for scripts and non-TUI sessions:

```text
/lsp status
/lsp doctor
```

## Built-in servers

| Language | Server | Installation strategy |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server` | Isolated npm prefix |
| Python | `pyright-langserver` | Isolated npm prefix |
| Rust | `rust-analyzer` | rustup component (rustup-owned) |
| Go | `gopls` | Isolated `GOBIN` |
| C# / .NET | `csharp-ls` | Isolated `dotnet tool --tool-path` |
| JSON / JSONC | `vscode-json-languageserver` | Isolated npm prefix |
| YAML | `yaml-language-server` | Isolated npm prefix |

On Windows, installing Go support can bootstrap the official `GoLang.Go` winget package when Go is absent. The confirmation screen discloses this system prerequisite before installation.

C# roots recognize `.sln`, `.slnx`, `.csproj`, `global.json`, `Directory.Build.props`, and `Directory.Build.targets`, preferring a containing solution without walking into unrelated solutions.

See [docs/server-catalog.md](docs/server-catalog.md) for prerequisites and ownership details.

## Tools

| Tool | Purpose |
|---|---|
| `lsp_diagnostics` | Compiler/type diagnostics |
| `lsp_hover` | Type signature and documentation |
| `lsp_definition` | Semantic go-to-definition |
| `lsp_references` | Semantic reference search |
| `lsp_document_symbols` | Classes, methods, functions, and other file symbols |
| `lsp_workspace_symbols` | Workspace-wide semantic symbol search |
| `lsp_rename_preview` | Preview all edits for a semantic rename; never writes |
| `lsp_code_actions` | Preview quick fixes/refactorings; never applies or executes |
| `lsp_more` | Continue paginated results using an opaque cursor |

Large references, symbols, rename edits, and action previews are paginated at 100 lines. Servers start lazily, stay warm per `(language, project root)`, recover after process exits, and stop at session shutdown.

Successful `read` calls can warm an already-installed server. Successful `edit` and `write` calls receive focused error diagnostics when that workspace server is already warm.

## Configuration

`~/.pi/agent/lsp.json` (or `$PI_CODING_AGENT_DIR/lsp.json`):

```json
{
  "installMode": "prompt",
  "warmup": true
}
```

| `installMode` | Behavior |
|---|---|
| `prompt` | Default. Installs occur only through confirmed `/lsp` actions. |
| `auto` | An explicit LSP tool call may install its missing server. |
| `off` | Never install automatically; existing managed and PATH servers still work. |

Malformed configuration falls back to consent-preserving defaults.

## Storage and ownership

```text
~/.pi/agent/lsp/
├── packages/
│   └── <server>/
└── lsp.lock.json
```

Pi-owned npm, Go, and .NET installations are removable through `/lsp`. System PATH binaries and rustup components are never removed by this package. The uninstaller verifies that the recorded executable is inside the expected Pi-owned server directory before deleting anything.

## Security model

Language servers execute native processes with the Pi process permissions and may inspect a workspace. This release therefore keeps executable selection package-controlled:

- Repository files may influence project-root discovery.
- Repository configuration cannot override executable or installer commands.
- Installer arguments come from the static catalog, not workspace content.
- npm is invoked through `node npm-cli.js` on Windows, avoiding unsafe shell shim handling.
- Go uses a direct process with an isolated `GOBIN`.
- Rename and code-action tools are preview-only.

See [docs/architecture.md](docs/architecture.md) and [SECURITY.md](SECURITY.md).

## Development

```bash
npm install
npm run verify
npm pack --dry-run
```

The test suite covers catalog routing, Windows command resolution, npm invocation, JSON-RPC framing, root selection, workspace detection, config fallback, edit previews, and uninstall boundaries.

## Comparison

Last reviewed: 2026-07-23. Re-check upstream before making adoption decisions.

| Capability | DysektAI Pi LSP | pi-lsp-adapter | @narumitw/pi-lsp | @spences10/pi-lsp | pi-lsp-extension |
|---|:---:|:---:|:---:|:---:|:---:|
| Interactive management menu | ✅ | ✅ | ❌ | ❌ | ❌ |
| Managed isolated installs | ✅ | ✅ | ❌ | ❌ | ❌ |
| Safe managed uninstall | ✅ | ✅ | ❌ | ❌ | ❌ |
| Automatic install policy | ✅ | ✅ | ❌ | ❌ | ❌ |
| Built-in C# support | ✅ | Custom | ✅ | ❌ | Custom |
| Isolated .NET tool install | ✅ | ❌ | ❌ | ❌ | ❌ |
| Diagnostics/navigation/symbols | ✅ | ✅ | Partial | ✅ | ✅ |
| Code-action preview | ✅ | ❌ | ✅ | ❌ | ❌ |
| Rename preview | ✅ | ❌ | ❌ | ❌ | ✅ |
| Paginated large results | ✅ | ✅ | ❌ | Undocumented | ❌ |
| Tree-sitter fallback | ❌ | ❌ | ❌ | ❌ | ✅ |

See [docs/upstream-references.md](docs/upstream-references.md) for versions, sources, and deliberate adoption decisions.

## License

MIT
