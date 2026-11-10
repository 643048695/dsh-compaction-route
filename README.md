# dsh-compaction-route

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/643048695/dsh-compaction-route)](https://github.com/643048695/dsh-compaction-route/commits)
[![Stars](https://img.shields.io/github/stars/643048695/dsh-compaction-route)](https://github.com/643048695/dsh-compaction-route/stargazers)

[English](README.md) | [中文](README.zh.md)

Pick the **conversation-compaction summarizer** from the Web settings page, give it a **fallback model**, and switch off the **pre-switch capacity gate** or **automatic compaction** with one click.

A [DeepSeek Harness](https://www.deepseek.com/harness/) plugin.

---

## Why this exists

DSH's compaction engine resolves **one** summarizer from its own composition config and has **no failover**. When the summarization call is rejected it throws, `/compact` reports *"Compaction could not produce a useful summary"*, and nothing else is ever tried.

That matters because the replayed history is sized by DSH's fixed **chars/4** estimate, while every provider tokenizes the *same bytes* differently and enforces its own input ceiling. A history that comfortably fits the model you are *chatting* with can be **too large for the summarizer you picked** — and the whole compaction fails with nothing to catch it.

Measured on a real 950k-window session:

| | |
|---|---|
| DSH estimate for the replay | 743,536 tokens |
| What the chat model actually read | 744,184 tokens |
| What the chosen summarizer needed | **over its input ceiling** → HTTP 400 |

The meter was calibrated on the chat model's tokenizer (0.1% off), so it reported "fits" while the summarizer was already over. Three routes measured against one identical payload:

| Route | Tokens for the same bytes |
|---|---|
| gemini-3.8-flash | 1,027,843 |
| opencode-go/deepseek-v4.1-flash | 939,469 |
| surplan/deepseek-v4.1-flash | 939,003 |

The tokenizers differ by **~10%**; the ceilings are the **same** (1,048,576). So "just pick a different model" is not enough on its own: **a fallback only rescues an oversized replay when its window is larger than the primary's.** The settings card says so when your pick cannot help.

## What it does

Listens on the `llm/stream` waterfall — the single seam every model call passes through — and for `purpose === "compaction"` requests **only**:

1. rewrites the target to the configured **primary**;
2. if that attempt ends in a terminal error chunk, retries the same request on the **fallback**;
3. yields the first attempt that succeeds, or the last attempt's outcome.

Every other request — chat turns, subagents, session titles, web search — falls straight through untouched.

## The two switches

Besides routing, it turns two behaviours you could not reach before into switches on the settings page:

| Switch | Default | When off |
|---|---|---|
| **Condense to fit the destination model before switching** | on | A switch to a smaller window no longer condenses first; the request goes straight out, and an oversized history surfaces the provider's own "too long" error. |
| **Automatic compaction** | on | The engine stops condensing on its own: between-step pressure, model-switch pressure, and overflow recovery all go quiet. Only the manual `/compact` command still compacts. |

They are independent. Turning the gate off leaves between-step pressure and overflow recovery intact; turning automatic compaction off leaves `/compact` working — because the engine's `compactNow()` never reads that flag.

**Why wrap the instance methods instead of rewriting config.** The engine lives inside each agent preset's isolated realm, and its automatic listeners are registered once in its constructor: rewriting a config value cannot un-register them, and restarting its fiber would tear down live sessions. Wrapping the two entry points on the *instance* keeps the listener graph intact, applies on the very next call (settings are read per call), and degrades to "no effect" rather than to breakage if a future engine renames them.

With a switch off the behaviour is an **honest error**, not a softened one and not a silent model swap — whether to keep going is the user's call.

## Install

**Web UI:** *Settings → Plugins → Add plugin*, and enter the spec:

```
github:643048695/dsh-compaction-route
```

**CLI** (ordinary profiles; the `desktop` profile is managed by the Electron app and refuses the CLI):

```sh
dsh plugin --profile <profile> add github:643048695/dsh-compaction-route
```

Then enable the bundle when the installer asks. There is **no build step**, and the plugin mounts without restarting the app. The row it inserts is id `compaction-route`, which is also the settings namespace.

## Configure

*Settings → Plugins → dsh-compaction-route → Configuration.*

| Field | Meaning |
|---|---|
| **Condense to fit the destination model before switching** | On: a switch to a smaller window condenses the history first. Off: the request goes straight out and the provider reports "too long". |
| **Automatic compaction** | On: condense near the limit, recover from overflow. Off: only the manual `/compact` command compacts. |
| **Enable routing** | Off leaves the engine exactly as it was. |
| **Primary model** | The summarizer used first. |
| **Fallback model** | Tried when the primary ends in an error. Empty disables the fallback. |
| **Reasoning effort** | Effort for compaction calls; empty keeps the provider's default. |

Both dropdowns are built from **the models actually installed in your profile** — read from the `llm-pi-ai` settings namespace, so whatever you have is what you can pick — and each option shows its context window.

**A fresh install ships with both models empty and changes nothing.** Nothing is guessed: until you pick a primary, compaction behaves exactly as it did before. Naming a route in shipping code would be a guess that silently redirects someone else's profile at a provider it may not have — and a *fallback without a primary* is meaningless, so it does not start routing on its own.

Every field is `volatile`, so a change applies to the **next** compaction with no restart.

## Choosing a fallback

A fallback rescues an *oversized replay* only when its window is **larger** than the primary's. Two same-size routes just repeat the same rejection.

The card raises a warning when the fallback's window is **≤** the primary's, and when both are the same model.

## How it works

```
compaction call ──▶ llm/stream waterfall
                       │
                       ├─ purpose !== "compaction"?  ──▶ pass through untouched
                       │
                       ├─ primary ──success──▶ yield its chunks
                       │        └──terminal error──▶ fallback ──▶ yield whatever it returns
                       └─ (a call this plugin created is never re-intercepted)

engine instance ──▶ two entry points wrapped
                       ├─ compactPressure(…, true)   ← pre-switch gate  → switch `gate`
                       ├─ compactPressure(…, false)  ← between-step     → switch `auto`
                       ├─ compactIfNeeded(…)         ← pressure + overflow → switch `auto`
                       └─ compactNow()               ← manual /compact   → never intercepted
```

**Why it re-enters `ctx.llm.stream()` instead of calling `next(newOptions)`.** cordis builds a waterfall's `next` as a closure over the *original* argument array:

```js
const next = () => (cbs.shift() ?? inner)(...args)
```

so `next(modifiedOptions)` silently ignores its argument and dispatches the original options again. Changing provider/model therefore has to re-enter `ctx.llm.stream()` from the top of the chain; a `WeakSet` of the call objects this plugin created keeps that re-entry from intercepting itself.

## Notes and limits

- **Retry is on terminal error chunks only.** A thrown middleware or consumer failure is surfaced exactly as the unpatched runtime would — this seam does not swallow it.
- **Cancellation wins.** An aborted call is never retried.
- **Only compaction is touched.** `purpose` is the discriminator, so nothing else is rerouted.
- **The engine's own event still records its configured target.** `compaction/summary` reports the engine's `summarizationProvider` / `summarizationModel`, not this plugin's override; a fallback win shows up as this plugin's log line instead. Point the engine's own row at the same primary if you want the session log to agree.
- **Not a substitute for a smaller history.** If the replay exceeds *every* window you have, no fallback helps; that is a compaction-policy problem, not a routing one.

## Compatibility

Checked against `@deepseek-ai/dsh` **0.2.1-rc.5** — the core bundled with the current desktop build — and against the `0.1.7` line it was first written for. The rc.4 `conversation.chat.reasoning.body` change (`text` vs `rawText`) was read and does not apply here: this plugin renders into `plugins.bundle.config`, never a reasoning body.

"Checked" for this plugin means two concrete things, both re-runnable from the repo:

1. **The seams still exist.** The host half needs `llm/stream` (waterfall, with `purpose`, `signal` and `reasoningEffort` on the options it rewrites) and the browser half needs `plugins.bundle.config` plus the `llm-pi-ai` settings namespace it enumerates models from. All three are present in the 0.2.1-rc.5 core; if any of them disappears a future release, the plugin goes inert rather than breaking a chat turn (see the fall-through tests). The switches additionally need the engine's `compactPressure` / `compactIfNeeded` entry points — if a future engine renames them, `applyEnginePolicy` reports "not wrapped" and the switches simply stop applying.
2. **The behaviour holds.** `npm test` drives the compiled host half against a fake `llm.stream` and asserts the rewrites, the fallback chain, the abort rule and the re-entrancy guard; it also asserts each switch against a stand-in engine. `test/client.test.mjs` renders the card through a stub React and asserts the controls, the read-back values and the write payload.

## Development

Neither half needs a build step.

```
lib/index.js        host half — the llm/stream route, the engine switches, the settings schema
client/client.js    browser half — the configuration card
cordis.patch.yml    the bundle patch: one row, id "compaction-route"
test/host.test.mjs  host-half behaviour, against a fake llm.stream and a stand-in engine
test/client.test.mjs browser-half rendering, against a stub React and a fake settings service
```

## License

MIT — see [LICENSE](LICENSE).
