# npm distribution wrapper

The published `@pleaseai/github-monitor` package is the Rust-binary wrapper
generated from this directory by `scripts/generate-platform-packages.mjs` and
published via npm Trusted Publishing in `.github/workflows/release-please.yml`
(the `publish-npm` job). This is an internal note documenting the layout; it is
not published.

## Model

The package layout follows the [Biome](https://github.com/biomejs/biome)
optional-dependency model, and the launch path uses the
[esbuild](https://github.com/evanw/esbuild) **copy-over-shim** optimization —
the same shape as `@pleaseai/csp`:

- `@pleaseai/github-monitor` (the `github-monitor/` dir) is a thin **wrapper**.
  Its `bin` points at a Node launcher (`bin/github-monitor-channel.js`) that
  resolves and `exec`s the correct platform binary, forwarding argv, stdio,
  exit code, and termination signals (SIGINT/SIGTERM/SIGHUP) — used as a
  **fallback** when the copy-over did not run.
- A `postinstall` step (`install.js`) copies the resolved platform binary
  **over** the launcher, so npm's `.bin/github-monitor-channel` resolves
  directly to native code. After install there is **no Node.js process on the
  hot path** — this preserves the binary's ~5 ms startup, which matters because
  Claude Code spawns the channel server on every session start.
- The shared resolver in `lib/resolve.js` is required by both the launcher and
  `install.js`; it is never the file overwritten by the copy-over, so re-running
  the postinstall (`npm rebuild`, `npm ci`) is idempotent.
- Per-platform packages (`@pleaseai/github-monitor-<target>`) each carry one
  prebuilt binary and declare `os` + `cpu`, so install pulls only the matching
  one. The wrapper lists them all under `optionalDependencies`.

```
@pleaseai/github-monitor            (wrapper — launcher + postinstall copy-over)
├── @pleaseai/github-monitor-darwin-arm64
├── @pleaseai/github-monitor-darwin-x64
├── @pleaseai/github-monitor-linux-x64
├── @pleaseai/github-monitor-linux-arm64
└── @pleaseai/github-monitor-win32-x64   (github-monitor-channel.exe)
```

### bun note

The copy-over runs as a `postinstall` script. **npm** and **pnpm** run it by
default. **bun blocks lifecycle scripts for untrusted deps**, so under
`bun install` the launcher stays JavaScript (still functional, just without the
startup win). bun users add `@pleaseai/github-monitor` to `trustedDependencies`
for the fast path; `bunx @pleaseai/github-monitor` works regardless.

## Release flow

1. `release-rust.yml` builds `github-monitor-channel-<target>` binaries.
2. `node npm/scripts/generate-platform-packages.mjs <version> <assets-dir>`
   materializes `npm/dist/<pkg>/` for each platform plus the wrapper (with the
   repo-root `README.md` + `LICENSE` copied in).
3. Publish each platform package, then the wrapper, with
   `npm publish ./<pkg> --access public` (CI: `id-token: write`). Auth is npm
   Trusted Publishing (OIDC) — no token, provenance generated automatically.

### One-time bootstrap

Trusted Publishing needs a trusted publisher configured on npmjs.com for the
wrapper and each `@pleaseai/github-monitor-<target>` package (repo
`pleaseai/github-monitor`, workflow `release-please.yml`). After that, set the
repo variable `NPM_PUBLISH=true` to enable the `publish-npm` job.
