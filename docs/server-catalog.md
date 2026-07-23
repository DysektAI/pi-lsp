# Server catalog

The catalog is compiled into `src/catalog.ts`. Workspaces cannot add or replace commands.

| Key | Extensions | Root markers | Installer | Prerequisite ownership |
|---|---|---|---|---|
| `typescript` | ts, tsx, js, jsx, mjs, cjs, mts, cts | tsconfig.json, package.json, jsconfig.json | npm | Pi-owned server and TypeScript package |
| `python` | py, pyi | pyproject.toml, setup.py, setup.cfg, requirements.txt, Pipfile | npm | Pi-owned Pyright |
| `rust` | rs | Cargo.toml | rustup | rustup-owned component; never uninstalled by Pi LSP |
| `go` | go | go.mod, go.work | `go install` with isolated GOBIN | Pi-owned gopls; Go toolchain is system-owned |
| `csharp` | cs | solution/project and Directory.Build markers | dotnet tool path | Pi-owned csharp-ls; .NET SDK is system-owned |
| `json` | json, jsonc | package.json, .git | npm | Pi-owned vscode language server package |
| `yaml` | yaml, yml | .git | npm | Pi-owned YAML language server |

## Windows behavior

npm is invoked as `node.exe npm-cli.js`, avoiding Node's inability to spawn npm `.cmd` shims directly. Installed npm language-server `.cmd` shims are launched through a shell only after resolving their absolute path.

If Go is absent and winget is available, the confirmed Go installation flow installs the official `GoLang.Go` package. The extension then resolves `C:\\Program Files\\Go\\bin\\go.exe` directly so the current Pi process does not need a PATH refresh.

## Adding a server

A new entry needs:

1. Stable file-extension routing and root markers.
2. A noninteractive, argv-based installer strategy.
3. A deterministic executable path or safe PATH resolution.
4. An explicit ownership/uninstall decision.
5. Windows and POSIX tests.
6. README and comparison updates where relevant.
