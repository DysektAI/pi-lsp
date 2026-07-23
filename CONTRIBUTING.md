# Contributing

1. Open an issue before adding a new installer strategy or mutation-capable tool.
2. Keep executable commands in the static catalog; never execute workspace-provided shell text.
3. Preserve the ownership boundary: system tools must never be removed as if Pi owned them.
4. Add Windows and POSIX coverage for command-resolution changes.
5. Run:

```bash
npm install
npm run verify
npm pack --dry-run
```

Changes to upstream comparisons must update both the README review date and `docs/upstream-references.md`. If code is copied or substantially adapted, preserve the upstream MIT notice in `NOTICE` and identify the exact revision.
