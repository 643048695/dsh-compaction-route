# dsh-compaction-route

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Last commit](https://img.shields.io/github/last-commit/643048695/dsh-compaction-route)](https://github.com/643048695/dsh-compaction-route/commits)
[![Stars](https://img.shields.io/github/stars/643048695/dsh-compaction-route)](https://github.com/643048695/dsh-compaction-route/stargazers)

[English](README.md) | [中文](README.zh.md)

Pick the **conversation-compaction summarizer** from the Web settings page, and give it a **fallback model**.

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

Works on `@deepseek-ai/dsh` **0.1.7-rc.2** (verified against it) and the same-node `0.1.7` line.

## Development

Neither half needs a build step.

```
lib/index.js        host half — the llm/stream route + the settings schema
client/client.js    browser half — the configuration card
cordis.patch.yml    the bundle patch: one row, id "compaction-route"
```

## License

MIT — see [LICENSE](LICENSE).
