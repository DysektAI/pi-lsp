# Upstream references

Last reviewed: 2026-07-23. These projects are inspirations and comparison points; this package is independently implemented unless a source file explicitly says otherwise. All advertised MIT licenses when reviewed.

| Project | Reviewed version | Repository | Watching / adopted concepts |
|---|---:|---|---|
| pi-lsp-adapter | 0.1.3 | https://github.com/nikmmd/pi-lsp-adapter | Interactive management, isolated ownership, install policies, doctor UX, pagination |
| @narumitw/pi-lsp | 0.25.0 | https://github.com/narumiruna/pi-extensions | Declarative routing, broad catalog, multiple diagnostic servers, code actions |
| @spences10/pi-lsp | 0.0.42 | https://github.com/spences10/my-pi | Project-binary trust and restricted child environments |
| pi-lsp-extension | 1.3.0 | https://github.com/samfoy/pi-lsp-extension | File synchronization, edit diagnostics, rename previews, tree-sitter fallback |

## Current decisions

- **Adopted independently:** managed ownership, prompt/auto/off policy, warm per-root clients, Windows shim resolution, interactive management/doctor UX, pagination, workspace symbols, code-action previews, rename previews, and edit-triggered diagnostics.
- **Differentiators:** isolated C#/.NET tooling with solution-aware roots; ownership-checked uninstall; Windows npm invocation without `.cmd` spawning; explicit preview-only mutation boundary.
- **Deferred:** transactional application of rename/code-action edits, trusted project-local binaries, and Java until a reliable managed JDTLS distribution strategy is established.
- **Not justified:** shared cross-session daemons and tree-sitter structural rewrite tools; both materially increase lifecycle and correctness scope.

When reviewing upstream progress, update the README comparison date and this document together. Preserve upstream MIT notices in `NOTICE` and affected files if source is ever copied or substantially adapted.
