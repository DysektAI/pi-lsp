# Security policy

## Reporting

Please report vulnerabilities privately through GitHub's **Security → Report a vulnerability** flow for `DysektAI/pi-lsp`. Do not open a public issue for an unpatched vulnerability.

Include the affected version, operating system, server/catalog entry, reproduction, attacker-controlled input, and expected impact.

## Trust boundary

Language servers are executable code and commonly inspect or evaluate project metadata. `@dysektai/pi-lsp` limits—but cannot remove—that risk:

- Executable and installer commands are selected from a static package catalog or the user's PATH.
- Workspace files cannot override process commands.
- Installation requires confirmation by default.
- Managed uninstall refuses paths outside the expected Pi-owned package directory.
- Rename and code-action tools produce previews only.

Users remain responsible for trusting the workspace, language server, compiler/toolchain, and dependencies they run.

## Supported versions

Security fixes are applied to the latest release. There is no long-term support branch before 1.0.
