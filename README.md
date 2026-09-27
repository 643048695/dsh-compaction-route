# dsh-compaction-route

Pick the **conversation-compaction summarizer** in the Web settings page, and give it a **fallback model**.

A [DeepSeek Harness](https://www.deepseek.com/harness/) plugin.

---

## The problem

DSH's compaction engine resolves **one** summarizer from its own composition config and has **no failover**. When the summarization call is rejected it throws, `/compact` reports *"Compaction could not produce a useful summary"*, and nothing else is ever tried.

That matters because the replay is sized by DSH's fixed **chars/4** estimate, while each provider tokenizes the *same bytes* differently and enforces its own input ceiling. A history that comfortably fits the model you are chatting with can be **too large for the summarizer you picked** — and the whole compaction fails with nothing to catch it.

Worked example from a real 950k-window session:

| | |
|---|---|
| DSH estimate for the replay | 743,536 tokens |
| The chat model actually read it at | 744,184 tokens (0.1% off — the meter is calibrated on this tokenizer) |
| The chosen summarizer needed | **over its 1,048,576 input ceiling** → 400 |
| 3 separate routes measured on one payload | 1,027,843 / 939,469 / 939,003 tokens — the tokenizers differ by ~10%, the ceilings are the *same* |

So "just pick a different model" is not enough on its own: the fallback only rescues an oversized replay when its window is **bigger** than the primary's. The card tells you when your pick cannot help.

## What it does

Listens on the `llm/stream` waterfall — the single seam every model call passes through — and for `purpose === "compaction"` requests **only**:

1. rewrites the target to the configured **primary**;
2. if that attempt ends in a terminal error chunk, retries the same request on the **fallback**;
3. yields the first attempt that succeeds, or the last attempt's outcome.

Every other request — chat turns, subagents, session titles, web search — falls straight through untouched.

## Install

In the Web UI: **Settings → Plugins → Add plugin**, and enter the spec.

```
github:643048695/dsh-compaction-route
```

There is no build step and no restart is required for the plugin to mount. The row it inserts is id `compaction-route`, which is also the settings namespace.

> `dsh plugin --profile <name> add …` also works for ordinary profiles; the `desktop` profile is managed by the Electron app and refuses the CLI, so use the Web installer there.

## Configure

**Settings → Plugins → dsh-compaction-route → Configuration**.

| Field | Meaning |
|---|---|
| **Enable routing** | Off leaves the engine exactly as it was. |
| **Primary model** | The summarizer used first. |
| **Fallback model** | Tried when the primary ends in an error. Empty disables the fallback. |
| **Reasoning effort** | Effort for compaction calls; empty keeps the provider's default. |

The dropdowns are built from **the models actually installed in your profile** (read from the `llm-pi-ai` settings namespace), not a hard-coded list, and each option shows its context window.

Every field is `volatile`, so a change applies to the **next** compaction with no restart.

## Choosing a fallback

A fallback rescues an *oversized replay* only if its window is larger than the primary's. Two same-size routes just repeat the same rejection. Prefer the largest window you have.

The card raises a warning when the fallback's window is **≤** the primary's.

## Notes and limits

* **Retry is on terminal error chunks only.** A thrown middleware or consumer failure is surfaced exactly as the unpatched runtime would — this seam does not swallow it.
* **Cancellation wins.** An aborted call is never retried.
* **Only compaction is touched.** `purpose` is the discriminator, so nothing else is rerouted.
* **The engine's own event still records its configured target.** `compaction/summary` reports the engine's `summarizationProvider`/`summarizationModel`, not this plugin's override; a fallback win shows up as this plugin's log line instead. Point the engine's own row at the same primary if you want the session log to agree.
* **Not a substitute for a smaller history.** If the replay exceeds *every* window you have, no fallback helps; that is a compaction-policy problem, not a routing one.

## Licence

MIT
