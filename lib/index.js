/**
 * dsh-compaction-route — host half.
 *
 * The conversation-compaction engine resolves ONE summarizer from its own
 * composition config and has no failover: when the summarization call is
 * rejected, it throws, \`/compact\` reports "Compaction could not produce a useful
 * summary", and nothing else is ever tried.
 *
 * That is a real failure mode because DSH prices the surface with a fixed
 * chars/4 heuristic while each provider tokenizes the SAME bytes differently and
 * enforces its own input ceiling. A history that fits the model you are chatting
 * with can be too large for the summarizer you picked, and the whole compaction
 * fails with nothing to catch it.
 *
 * This plugin listens on the \`llm/stream\` waterfall — the single seam every model
 * call passes through — and for \`purpose === "compaction"\` requests only:
 *
 *   1. rewrites the target to the configured primary,
 *   2. if that attempt ends in a terminal error chunk, retries the same request
 *      on the configured fallback,
 *   3. yields the first attempt that succeeds, or the last attempt's outcome.
 *
 * Every other request (chat turns, subagents, titles, web search) falls straight
 * through to \`next()\` untouched.
 *
 * WHY IT RE-ENTERS \`ctx.llm.stream()\` INSTEAD OF CALLING \`next(newOptions)\`
 * -------------------------------------------------------------------------
 * cordis builds a waterfall's \`next\` as a closure over the ORIGINAL argument
 * array:
 *
 *     const next = () => (cbs.shift() ?? inner)(...args);
 *
 * so \`next(modifiedOptions)\` silently ignores its argument and dispatches the
 * original options again. Changing provider/model therefore has to re-enter
 * \`ctx.llm.stream()\` from the top of the chain; a WeakSet of the call objects
 * this plugin itself created keeps that re-entry from intercepting itself.
 *
 * SETTINGS
 * --------
 * Every field is \`.volatile()\`, which makes it editable from the Web settings
 * page and makes the value below a live cell: reading it at each compaction call
 * means a settings change applies to the next compaction without a restart.
 *
 * @module dsh-compaction-route
 */
import Schema from '@deepseek-ai/schemastery'

/** Cordis plugin name; the bundle patch mounts it under the same id. */
export const name = 'compaction-route'

/** No hard dependency: without \`llm\` this plugin reports and stays inert. */
export const inject = []

/** Separator between provider and model inside one settings value. */
const SEP = '|'

/** The only purpose this plugin touches. */
const COMPACTION_PURPOSE = 'compaction'

/** Call objects this plugin created, so a re-entrant dispatch delegates instead of looping. */
const OWN_CALLS = new WeakSet()

/** A target that neither the schema default nor the settings page has filled in. */
const DEFAULT_PRIMARY = 'opencodex-compact|google-antigravity/gemini-3.8-flash'
const DEFAULT_FALLBACK = 'opencodex|opencode-go/deepseek-v4.1-flash'

/**
 * The settings schema. Each field is volatile so the Web settings page can edit
 * it and the host half can read it live.
 */
export const Config = Schema.object({
  enabled: Schema.boolean()
    .default(true)
    .description('Route compaction calls through the models below. Off leaves the engine exactly as it was.')
    .volatile(),
  primary: Schema.string()
    .default(DEFAULT_PRIMARY)
    .description('The summarizer used first, as "provider|model".')
    .volatile(),
  fallback: Schema.string()
    .default(DEFAULT_FALLBACK)
    .description('Tried when the primary ends in an error. Empty disables the fallback.')
    .volatile(),
  effort: Schema.string()
    .default('high')
    .description('Reasoning effort for compaction calls. Empty keeps the provider default.')
    .volatile(),
  log: Schema.boolean()
    .default(true)
    .description('Write one info line when a fallback is used.')
    .volatile()
})

/**
 * Read one config field. A volatile field is a live reference, not a plain
 * value, so it is unwrapped on every read; anything else is returned as-is.
 *
 * @param value - the raw field from the resolved composition config.
 * @param fallback - value to use when the field is absent.
 * @returns the current plain value.
 */
function plain (value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object' && typeof value.get === 'function') {
    const current = value.get()
    return current === undefined || current === null ? fallback : current
  }
  return value
}

/**
 * Parse one settings value into a route target.
 *
 * @param value - "provider|model", a bare "model", or empty.
 * @returns the target, or undefined when the value names no model.
 */
function parseTarget (value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const at = trimmed.indexOf(SEP)
  if (at === -1) return { model: trimmed }
  const provider = trimmed.slice(0, at).trim()
  const model = trimmed.slice(at + SEP.length).trim()
  if (model === '') return undefined
  return provider === '' ? { model } : { provider, model }
}

/** Label one target for a log line. */
function labelOf (target) {
  return target.provider === undefined ? target.model : target.provider + SEP + target.model
}

/** Human-readable one-line summary of a failure. */
function describeFailure (failure) {
  const code = failure === undefined || failure.code === undefined ? 'UNKNOWN' : failure.code
  const message = failure === undefined || failure.message === undefined
    ? ''
    : String(failure.message).replace(/\s+/g, ' ').slice(0, 300)
  return message === '' ? code : code + ': ' + message
}

/** Collect one attempt's chunks, stopping at its terminal finish chunk. */
async function collectAttempt (stream) {
  const chunks = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') break
  }
  return chunks
}

/**
 * Interpret collected chunks.
 *
 * @returns the terminal failure, or undefined when the attempt succeeded.
 */
function outcomeOf (chunks) {
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object' || chunk.type !== 'finish') continue
    const reason = chunk.reason === undefined ? {} : chunk.reason
    if (reason.kind === 'aborted') return { aborted: true, failure: reason.failure }
    if (reason.kind === 'error') return { aborted: false, failure: reason.failure === undefined ? { code: 'UNKNOWN' } : reason.failure }
    return { aborted: false, failure: undefined }
  }
  return { aborted: false, failure: undefined }
}

/**
 * Mount the compaction route.
 *
 * @param ctx - the Cordis plugin context.
 * @param config - the composition entry's resolved config (volatile cells).
 */
export function apply (ctx, config) {
  const settings = config === undefined || config === null ? {} : config

  /** Read the routing plan. Called per compaction so a settings edit applies at once. */
  const plan = () => {
    if (plain(settings.enabled, true) !== true) return undefined
    const chain = []
    const primary = parseTarget(plain(settings.primary, DEFAULT_PRIMARY))
    if (primary !== undefined) chain.push(primary)
    const fallback = parseTarget(plain(settings.fallback, DEFAULT_FALLBACK))
    if (fallback !== undefined) chain.push(fallback)
    if (chain.length === 0) return undefined
    return {
      chain,
      effort: plain(settings.effort, 'high'),
      log: plain(settings.log, true) === true
    }
  }

  ctx.inject(['llm'], (scope) => {
    const llm = scope.llm
    if (llm === undefined) {
      ctx.logger?.warn('[compaction-route] no llm service; compaction routing stays inert')
      return
    }

    /**
     * The waterfall listener. Async generator: the value returned here IS the
     * chunk stream the caller iterates.
     */
    const handler = async function * (options, next) {
      if (options === null || typeof options !== 'object') return yield * next()
      if (options.purpose !== COMPACTION_PURPOSE) return yield * next()
      // Our own retry re-enters the waterfall; hand it straight to the adapter.
      if (OWN_CALLS.has(options)) return yield * next()

      const route = plan()
      if (route === undefined) return yield * next()

      const signal = options.signal
      const chain = route.chain
      const effort = route.effort === '' ? undefined : route.effort

      for (let index = 0; index < chain.length; index += 1) {
        const target = chain[index]
        const isLast = index === chain.length - 1
        const call = {
          ...options,
          ...target,
          ...effort === undefined ? {} : { reasoningEffort: effort }
        }
        OWN_CALLS.add(call)

        let chunks
        try {
          chunks = await collectAttempt(llm.stream(call))
        } catch (error) {
          // A thrown middleware or consumer failure is not a provider outcome
          // this seam can retry; surface it exactly as the unpatched runtime would.
          throw error
        }

        const { aborted, failure } = outcomeOf(chunks)
        if (aborted || failure === undefined) {
          if (index > 0 && route.log) {
            ctx.logger?.info('[compaction-route] summarized with fallback ' + labelOf(target))
          }
          yield * chunks
          return
        }

        if (signal !== undefined && signal.aborted === true) {
          yield * chunks
          return
        }

        if (isLast) {
          if (route.log) {
            ctx.logger?.info('[compaction-route] ' + labelOf(target) + ' failed (' + describeFailure(failure) + '); no candidate left')
          }
          yield * chunks
          return
        }

        if (route.log) {
          ctx.logger?.info('[compaction-route] ' + labelOf(target) + ' failed (' + describeFailure(failure) + '); retrying on ' + labelOf(chain[index + 1]))
        }
      }
    }

    // \`prepend\` makes this the outermost listener so it wraps every inner
    // middleware and the adapter itself; \`global\` keeps it visible to dispatches
    // from any scope (the compaction engine mounts inside each agent preset's
    // isolated realm).
    scope.on('llm/stream', handler, { global: true, prepend: true })
    ctx.logger?.info('[compaction-route] mounted; configure it in Settings -> Plugins')
  })
}
