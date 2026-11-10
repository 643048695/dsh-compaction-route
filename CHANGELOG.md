# Changelog

[English](CHANGELOG.md) | [中文](CHANGELOG.zh.md)

All notable changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-11-10

Turns two engine behaviours that previously required editing host code into switches on the settings page.

### Added

- **"Condense to fit the destination model before switching" switch.** Off: a switch to a smaller window no longer condenses the history first — the request goes straight out, and an oversized history surfaces the provider's own "too long" error. This gate only exists since DSH 0.2.1-alpha.4, which is why switching models used to be free of it; it is also what blocked an entire switch once the previous model's entry disappeared. Implemented by wrapping the engine instance's `compactPressure` and intercepting only the `requireBelowThreshold === true` call, so the between-step pressure pass is unaffected.
- **"Automatic compaction" switch.** Off: the engine stops condensing on its own — between-step pressure, model-switch pressure and overflow recovery all go quiet, leaving only the manual `/compact`. Equivalent to the engine's own `auto: false`, but without editing composition config, restarting, or touching a preset row.
- **Switch UI in the browser half.** The two switches sit at the top of the card — they decide *whether* to condense, while everything below decides *which model* does it — and show their state side by side. With automatic compaction off, the card states plainly that a full context will be rejected by the provider and that `/compact` becomes the user's job.
- **`test/client.test.mjs`.** Renders the card through a stub React and asserts the control set and defaults, the read-back of stored values, the Chinese UI, the degradation when the settings service is missing, and that a switch write carries only its own field plus the current revision.

### Changed

- **`applyEnginePolicy(engine, flags)` is now an exported function**, shared by the host half and the tests. It marks the instance with `Symbol.for('dsh-compaction-route.patched')` so a second wrap is refused, and returns `false` instead of throwing when the entry points are absent — a future engine rename degrades to "no effect" rather than to breakage.
- **Engine discovery uses two paths:** `ctx.get('compaction', false)` first, then every isolation-symbol key in `ctx.reflect.store` — each agent preset mounts its own engine instance, so the former alone would miss other realms. A sweep runs at mount, then on `internal/service`, on `agent/pre-step` and `agent/request`, plus four short-delay timers.
- **`compactNow()` is deliberately not wrapped.** The manual command never reads the `auto` flag and must keep working with both switches off; a test asserts it is never replaced.
- **Host-half tests went from 10 to 18**, the eight new ones covering: both switches on passes through unchanged, gate off alone leaves between-step pressure intact, auto off silences all four automatic paths while the manual command survives, settings are read per call so an edit applies immediately, a second wrap is refused, an engine without the entry points is left alone, a live engine is wrapped at mount, and an engine reachable only through an isolated store is wrapped too.
- Version bumped to `0.3.0`; `npm test` now runs both test files.

### Notes

- Both switches default to **on**, which is exactly the behaviour before the plugin was installed; they work on their own, without routing or a primary model.
- With a switch off the behaviour is an **honest error**, not a softened one and not a silent model swap — whether to continue is the user's call.

## [0.2.1] — 2026-10-30

Re-checked against DSH 0.2.1-rc.5, the core the current desktop build ships.

### Changed

- **Verified against DSH 0.2.1-rc.5** (local `DeepSeek Harness.exe` FileVersion `0.2.1-rc.5`; the last check was `0.2.1-rc.3`). Both intervening releases were read, not assumed: rc.4 is an ACP-only stdout fix, rc.5 only reworks how thinking content is displayed. Neither touches a seam this plugin stands on — `llm/stream` still takes `(options, next)` and still carries `purpose: 'compaction' | 'session-title'`, `signal` and `reasoningEffort`; a finish chunk still reports `reason.kind === 'error' | 'aborted'` with `failure`; `plugins.bundle.config` still registers `{ name, key }`; the `llm-pi-ai` namespace still carries each model's `contextWindow`.
- **rc.4's one contract change is not ours.** `conversation.chat.reasoning.body` now passes the processed display text in `text` and the raw model output in `rawText` (see `docs/upgrade-guide/v0.2.1-rc.4/reasoning-body-props` in the core repo). This plugin renders into `plugins.bundle.config` and never touches a reasoning body, so no migration was needed — recorded so the next reader does not have to re-derive it.
- **No peer range to widen.** The package declares no `@deepseek-ai/dsh-*` peers; its only DeepSeek dependency is `@deepseek-ai/schemastery` (`^3.18.2`, resolving to 3.18.4), a caret range that already spans the host's copy. Nothing here can pin the host to a version it will silently skip.

### Notes

- No behaviour change and no settings migrate; the host-half suite is still 10/10.

## [0.2.0] — 2026-10-29

Moves the plugin onto the current core and makes its claims checkable.

### Changed

- **Verified against DSH 0.2.1-rc.3**, the core shipped with the current desktop build. The three seams this plugin stands on are all still there: `llm/stream` (waterfall, carrying `purpose`, `signal` and `reasoningEffort`), `plugins.bundle.config`, and the `llm-pi-ai` settings namespace the card enumerates models from. The README compatibility note now says exactly which of those were checked instead of citing an older release.
- **CI added.** A `manifest` job checks the things the plugin market refuses on (bundle patch present and naming the package, every `exports` target existing), and a `test` job runs the suite on ubuntu + windows against node 20 and 22 after syntax-checking both shipped modules. Green checks are the point: a claim about compatibility that nothing runs is just prose.

- **`npm test` exists now.** Ten host-half cases run against a fake `llm.stream`: pass-through for non-compaction purposes, the empty-primary no-op, the primary rewrite with effort, the fallback chain, the both-failed outcome, the abort rule, the re-entrancy guard, and the disabled switch.

### Notes

- No behaviour change for existing installs; no settings migrate.

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
