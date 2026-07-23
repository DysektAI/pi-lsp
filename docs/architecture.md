# Architecture

## Modules

- `catalog.ts` is the authority for language routing, roots, executable names, and installer metadata.
- `config.ts` reads user-owned install and warmup policy.
- `installer.ts` owns Pi-managed storage, prerequisite discovery, install/update execution, lock records, and ownership-checked removal.
- `index.ts` owns JSON-RPC framing, session-scoped process pools, file synchronization, semantic tools, pagination, edit diagnostics, and `/lsp` UI.

## Trust boundaries

- Catalog commands are package-controlled.
- User PATH binaries are allowed because the user owns that environment.
- Project files affect root discovery but cannot override executable or installer commands.
- Managed npm, Go, and .NET servers live below `~/.pi/agent/lsp/packages/`.
- Rustup retains ownership of its component.
- Removal requires a managed lock record and an executable path below the exact server package directory.
- Rename and code-action responses are formatted as previews; no server command is executed and no edit is applied.

## Lifecycle

Clients start on the first tool call for a matching file and are keyed by `(server, root)`. Read-triggered warmup starts only already-installed servers. Dead child processes are discarded and recreated on demand. All processes stop on `session_shutdown`.

Files are reopened from current disk content before semantic requests, guaranteeing that the server sees Pi's latest successful write. Warm edit/write feedback requests diagnostics only from an already-running workspace server to avoid surprising installation or cold-start latency.

## JSON-RPC

The client incrementally parses `Content-Length` frames, retains partial data, handles multiple frames per chunk, replies to server requests, tracks request timeouts, and handles diagnostics/progress notifications. Large user-facing results are held in a session-only cursor cache and returned in pages of 100 lines.

## Installation

Installation never starts from the extension factory. In `prompt` mode it follows explicit `/lsp` confirmation. In `auto` mode only an explicit semantic tool request can install a missing server. `off` mode disables automatic installation.

Installer state is recorded in `lsp.lock.json`. A missing executable makes the record stale; `/lsp doctor` reports it and reinstall repairs it.
