/**
 * dsh-compaction-route — host half.
 *
 * The conversation-compaction engine resolves ONE summarizer from its own
 * composition config and has no failover: when the summarization call is
 * rejected, it throws, `/compact` reports "Compaction could not produce a useful
 * summary", and nothing else is ever tried.
 *
 * That is a real failure mode because DSH prices the surface with a fixed
 * chars/4 heuristic while each provider tokenizes the SAME bytes differently and
 * enforces its own input ceiling. A history that fits the model you are chatting
 * with can be too large for the summarizer you picked, and the whole compaction
 * fails with nothing to catch it.
 *
 * This plugin does two independent jobs, both driven from the Web settings card:
 *
 * 1. ROUTING — it listens on the `llm/stream` waterfall (the single seam every
 *    model call passes through) and, for `purpose === "compaction"` requests only:
 *      a. rewrites the target to the configured primary,
 *      b. if that attempt ends in a terminal error chunk, retries the same
 *         request on the configured fallback,
 *      c. yields the first attempt that succeeds, or the last attempt's outcome.
 *
 * 2. ENGINE SWITCHES — it wraps the live compaction engine's two entry points so
 *    two behaviours the engine hard-codes become user choices:
 *      - `gate`: the model-switch capacity check that condenses the history to
 *        fit the DESTINATION model before a switch is committed
 *        (`agent/request` -> `compactPressure(..., true)`),
 *      - `auto`: automatic condensation as a whole (between-step pressure,
 *        model-switch pressure, and context-overflow recovery).
 *    Turning `auto` off reproduces the engine's own `auto: false`: every
 *    automatic trigger goes quiet while `/compact` keeps working, because
 *    `compactNow()` never reads that flag.
 *
 * Every other request (chat turns, subagents, titles, web search) falls straight
 * through to `next()` untouched.
 *
 * WHY IT RE-ENTERS `ctx.llm.stream()` INSTEAD OF CALLING `next(newOptions)`
 * -------------------------------------------------------------------------
 * cordis builds a waterfall's `next` as a closure over the ORIGINAL argument
 * array:
 *
 *     const next = () => (cbs.shift() ?? inner)(...args);
 *
 * so `next(modifiedOptions)` silently ignores its argument and dispatches the
 * original options again. Changing provider/model therefore has to re-enter
 * `ctx.llm.stream()` from the top of the chain; a WeakSet of the call objects
 * this plugin itself created keeps that re-entry from intercepting itself.
 *
 * WHY THE SWITCHES WRAP METHODS INSTEAD OF REWRITING CONFIG
 * ---------------------------------------------------------
 * The engine lives inside each agent preset's isolated realm, and its automatic
 * listeners are registered in its constructor — rewriting a config value cannot
 * un-register them, and restarting the engine's fiber would tear down live
 * sessions. Wrapping the two entry points on the INSTANCE keeps the listener
 * graph intact, applies on the very next call (settings are read per call), and
 * degrades to "no effect" rather than to breakage if a future engine renames
 * them.
 *
 * SETTINGS
 * --------
 * Every field is `.volatile()`, which makes it editable from the Web settings
 * page and makes the value below a live cell: reading it at each call means a
 * settings change applies immediately, without a restart.
 *
 * @module dsh-compaction-route
 */
import Schema from '@deepseek-ai/schemastery'

/** Cordis plugin name; the bundle patch mounts it under the same id. */
export const name = 'compaction-route'

/** No hard dependency: without `llm` this plugin reports and stays inert. */
export const inject = []

/** Separator between provider and model inside one settings value. */
const SEP = '|'

/** The only purpose this plugin touches. */
const COMPACTION_PURPOSE = 'compaction'

/** Call objects this plugin created, so a re-entrant dispatch delegates instead of looping. */
const OWN_CALLS = new WeakSet()

/** Marks an engine instance this plugin already wrapped. */
const PATCHED = Symbol.for('dsh-compaction-route.patched')

/**
 * Defaults are deliberately EMPTY: the settings page fills them from the models
 * your own profile declares, and naming a provider here would be a guess that
 * silently routes someone else's profile at a route it may not have. With no
 * primary chosen the plugin stays transparent and the engine behaves as it always
 * did, which is the safe state for a fresh install.
 */
const NO_TARGET = ''

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
    .default(NO_TARGET)
    .description('The summarizer used first, as "provider|model". Empty leaves compaction untouched.')
    .volatile(),
  fallback: Schema.string()
    .default(NO_TARGET)
    .description('Tried when the primary ends in an error. Empty disables the fallback.')
    .volatile(),
  effort: Schema.string()
    .default('high')
    .description('Reasoning effort for compaction calls. Empty keeps the provider default.')
    .volatile(),
  gate: Schema.boolean()
    .default(true)
    .description('Condense the history to fit the destination model before a model switch is committed. Off lets the switch through and surfaces the provider\'s own "too long" error.')
    .volatile(),
  auto: Schema.boolean()
    .default(true)
    .description('Automatic condensation: between-step pressure, model-switch pressure, and context-overflow recovery. Off leaves only the manual /compact command.')
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
 * Wrap one live compaction engine so the two switches take effect on its next
 * call.
 *
 * The engine's automatic listeners are registered once, in its constructor, and
 * cannot be removed. Every automatic path funnels through one of these two
 * methods, so returning `null` from a wrapper is exactly what the engine itself
 * returns when a trigger decides there is nothing to do:
 *
 *   - `compactPressure(agent, header, signal, requireBelowThreshold)` —
 *     `requireBelowThreshold === true` is the model-switch gate and nothing else,
 *     which is why the `gate` switch can be separated from the rest;
 *   - `compactIfNeeded(agent, trigger, signal)` — the between-step pressure pass
 *     and context-overflow recovery.
 *
 * `compactNow()` (the manual `/compact` command) is deliberately untouched: it
 * never reads the engine's `auto` flag, and it must keep working with both
 * switches off.
 *
 * @param engine - a compaction service instance.
 * @param flags - live reader returning `{ gate, auto }`.
 * @returns true when this call installed the wrapper.
 */
export function applyEnginePolicy (engine, flags) {
  if (engine === null || typeof engine !== 'object') return false
  if (engine[PATCHED] === true) return false
  const pressure = typeof engine.compactPressure === 'function' ? engine.compactPressure : undefined
  const ifNeeded = typeof engine.compactIfNeeded === 'function' ? engine.compactIfNeeded : undefined
  if (pressure === undefined && ifNeeded === undefined) return false
  Object.defineProperty(engine, PATCHED, { value: true, enumerable: false })

  if (pressure !== undefined) {
    Object.defineProperty(engine, 'compactPressure', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: async function compactPressure (agent, header, signal, requireBelowThreshold) {
        const current = flags()
        if (current.auto !== true) return null
        if (requireBelowThreshold === true && current.gate !== true) return null
        return pressure.call(this, agent, header, signal, requireBelowThreshold)
      }
    })
  }

  if (ifNeeded !== undefined) {
    Object.defineProperty(engine, 'compactIfNeeded', {
      configurable: true,
      writable: true,
      enumerable: false,
      value: async function compactIfNeeded (agent, trigger, signal) {
        if (flags().auto !== true) return null
        return ifNeeded.call(this, agent, trigger, signal)
      }
    })
  }

  return true
}

/**
 * Every live compaction engine this process has registered.
 *
 * Agent presets mount their engine inside an isolated realm, so there is one
 * instance per preset generation rather than one per process. The service store
 * is shared and keyed by isolation symbol, which is the only way to reach all of
 * them from a host-level plugin; `ctx.get` covers the realm this plugin was
 * loaded into.
 *
 * @param ctx - the host context.
 * @returns the engines found, deduplicated.
 */
function compactionEngines (ctx) {
  const found = new Set()
  try {
    const direct = typeof ctx.get === 'function' ? ctx.get('compaction', false) : undefined
    if (direct !== undefined && direct !== null) found.add(direct)
  } catch {
    // The service is absent in realms that do not mount a backend.
  }
  try {
    const store = ctx.reflect === undefined || ctx.reflect === null ? undefined : ctx.reflect.store
    if (store !== undefined && store !== null) {
      for (const key of Object.getOwnPropertySymbols(store)) {
        const value = store[key] === undefined || store[key] === null ? undefined : store[key].value
        if (value !== undefined && value !== null && typeof value === 'object') found.add(value)
      }
    }
  } catch {
    // Reflection is best-effort; a failure here must never break a turn.
  }
  return found
}

/**
 * Mount the compaction route and the two engine switches.
 *
 * @param ctx - the Cordis plugin context.
 * @param config - the composition entry's resolved config (volatile cells).
 */
export function apply (ctx, config) {
  const settings = config === undefined || config === null ? {} : config

  /** Read the routing plan. Called per compaction so a settings edit applies at once. */
  const plan = () => {
    if (plain(settings.enabled, true) !== true) return undefined
    const primary = parseTarget(plain(settings.primary, NO_TARGET))
    // A fallback without a primary is meaningless — there is nothing to fail — and
    // treating it as the primary would silently route compaction somewhere the
    // person never chose. No primary means this plugin stays transparent.
    if (primary === undefined) return undefined
    const chain = [primary]
    const fallback = parseTarget(plain(settings.fallback, NO_TARGET))
    if (fallback !== undefined) chain.push(fallback)
    return {
      chain,
      effort: plain(settings.effort, 'high'),
      log: plain(settings.log, true) === true
    }
  }

  /** Read the two engine switches. Independent of the routing settings above. */
  const flags = () => ({
    gate: plain(settings.gate, true) === true,
    auto: plain(settings.auto, true) === true
  })

  /** Wrap every engine currently alive; new ones are caught by the sweeps below. */
  const sweep = () => {
    let wrapped = 0
    try {
      for (const engine of compactionEngines(ctx)) {
        try {
          if (applyEnginePolicy(engine, flags)) wrapped += 1
        } catch {
          // One malformed instance must not stop the rest.
        }
      }
    } catch {
      return
    }
    if (wrapped > 0) {
      ctx.logger?.info('[compaction-route] engine switches attached to ' + wrapped + ' compaction engine(s)')
    }
  }

  // Engines that already exist when this plugin loads.
  sweep()

  // Engines constructed later: a preset generation is built before its first
  // step, so the pre-step sweep lands before any request can hit the gate.
  for (const event of ['agent/pre-step', 'agent/request']) {
    try {
      ctx.on(event, (_payload, next) => {
        sweep()
        return next()
      }, { global: true, prepend: true })
    } catch {
      // An older host without this event simply keeps the timer-based sweep.
    }
  }

  // Service registration is the earliest signal that a new engine exists.
  try {
    ctx.on('internal/service', (serviceName) => {
      if (serviceName === 'compaction') sweep()
    }, { global: true })
  } catch {
    // Optional fast path only.
  }

  // Narrow race cover for engines already mid-construction when this row loads.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timers = [0, 200, 1000, 3000].map((delay) => setTimeout(() => sweep(), delay))
      return () => {
        for (const timer of timers) clearTimeout(timer)
      }
    }, 'compaction-route engine sweep')
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

    // `prepend` makes this the outermost listener so it wraps every inner
    // middleware and the adapter itself; `global` keeps it visible to dispatches
    // from any scope (the compaction engine mounts inside each agent preset's
    // isolated realm).
    scope.on('llm/stream', handler, { global: true, prepend: true })
    ctx.logger?.info('[compaction-route] mounted; configure it in Settings -> Plugins')
  })
}
