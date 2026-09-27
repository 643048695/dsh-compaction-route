# Changelog

[English](CHANGELOG.md) | [中文](CHANGELOG.zh.md)

All notable changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-27

Initial release.

### Added

- **Host half (`lib/index.js`)** — an `llm/stream` waterfall listener that, for `purpose === "compaction"` requests only, rewrites the target to the configured primary and retries on the configured fallback when an attempt ends in a terminal error chunk. Registered `{ global: true, prepend: true }` so it wraps every inner middleware and is visible to dispatches from an agent preset's isolated realm. A `WeakSet` of the calls it created keeps the re-entrant dispatch from intercepting itself.
- **Settings schema** — five `volatile` fields (`enabled`, `primary`, `fallback`, `effort`, `log`) so the Web settings page can edit them and the host half reads them live at each compaction.
- **Browser half (`client/client.js`)** — a hand-written lazy bundle (no build step) rendering the configuration card into `plugins.bundle.config`, keyed by the bundle's package name. Both dropdowns are built from the models installed in the profile (read from the `llm-pi-ai` settings namespace) and show each model's context window.
- **Fallback-usefulness warnings** — the card warns when the fallback's context window is not larger than the primary's, and when both are the same model, because a same-size fallback cannot rescue an oversized replay.

### Design decisions

- **Empty model defaults.** Shipping a concrete route in the schema would be a guess that silently redirects another profile at a provider it may not have. With both fields empty a fresh install changes nothing.
- **A fallback without a primary does not route.** There is nothing to fail, and treating the fallback as the primary would send compaction somewhere the user never chose.
- **Retry only on terminal error chunks.** A thrown middleware or consumer failure is surfaced exactly as the unpatched runtime would.
