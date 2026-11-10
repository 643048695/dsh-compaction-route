import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, applyEnginePolicy, name } from "../lib/index.js";

/**
 * Minimal cordis-ish context.
 *
 * `inject(['llm'], fn)` is called synchronously with a scope exposing `llm.stream`,
 * and every listener the plugin registers is captured with its event name so a
 * test can drive the one it cares about. `effect` runs its callback and its
 * cleanup immediately, which exercises the timer-based sweep without leaving
 * live timers behind.
 */
function makeCtx(stream, engines = {}) {
  const logs = [];
  const listeners = [];
  const ctx = {
    logger: {
      info: (m) => logs.push(["info", String(m)]),
      warn: (m) => logs.push(["warn", String(m)]),
    },
    inject(_deps, fn) {
      // The injected scope is the same fake, so `scope.on(...)` lands in listeners.
      fn({ llm: { stream }, on: ctx.on.bind(ctx) });
    },
    // The plugin registers on the injected scope, which is this same fake.
    on(event, handler, options) {
      listeners.push({ event, handler, options });
    },
    // Service lookup for the compaction backend, when a test supplies one.
    get(serviceName) {
      return engines[serviceName];
    },
    // Mirrors the real store shape: isolation symbol -> { name, value }.
    reflect: {
      store: Object.fromEntries(
        Object.entries(engines).map(([serviceName, value]) => [
          Symbol("isolate." + serviceName),
          { name: serviceName, value },
        ]),
      ),
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === "function") cleanup();
    },
  };
  return {
    ctx,
    logs,
    listeners,
    of: (event) => listeners.filter((entry) => entry.event === event),
    fire: (
      options,
      next = async function* () {
        yield { type: "finish", reason: { kind: "done" }, from: "next" };
      },
    ) => {
      const route = listeners.find((entry) => entry.event === "llm/stream");
      assert.ok(route, "the plugin must register an llm/stream listener");
      return route.handler(options, next);
    },
  };
}

/** Build a fake `llm.stream` that records calls and replies per model. */
function scriptedStream(replies) {
  const calls = [];
  async function* stream(call) {
    calls.push(call);
    const reply = replies[call.model];
    if (reply === undefined) {
      yield {
        type: "finish",
        reason: { kind: "error", failure: { code: "NOT_CONFIGURED", message: `no script for ${call.model}` } },
      };
      return;
    }
    for (const chunk of reply) yield chunk;
  }
  return { calls, stream };
}

/**
 * A stand-in compaction engine with the three entry points that matter.
 * Every call is recorded so a test can prove what was delegated and what was not.
 */
function makeEngine() {
  const calls = [];
  const engine = {
    async compactPressure(...args) {
      calls.push(["pressure", ...args]);
      return "pressure-result";
    },
    async compactIfNeeded(...args) {
      calls.push(["ifNeeded", ...args]);
      return "ifNeeded-result";
    },
    async compactNow(...args) {
      calls.push(["now", ...args]);
      return "now-result";
    },
  };
  return { engine, calls };
}

const ok = (text) => [{ type: "text", text }, { type: "finish", reason: { kind: "done" } }];
const failed = (code = "MODEL_INPUT_TOO_LARGE") => [
  { type: "text", text: "" },
  { type: "finish", reason: { kind: "error", failure: { code, message: "input is too large" } } },
];

function collect(iterable) {
  return (async () => {
    const chunks = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return chunks;
  })();
}

test("declares the module name the bundle patch mounts", () => {
  assert.equal(name, "compaction-route");
});

test("registers one llm/stream listener, global and prepended", () => {
  const fake = scriptedStream({});
  const { ctx, of } = makeCtx(fake.stream);
  apply(ctx, {});
  const routes = of("llm/stream");
  assert.equal(routes.length, 1);
  assert.equal(routes[0].options?.global, true);
  assert.equal(routes[0].options?.prepend, true);
});

test("chat turns and other purposes fall through untouched", async () => {
  const fake = scriptedStream({});
  const { ctx, fire } = makeCtx(fake.stream);
  apply(ctx, { primary: "openrouter|big", fallback: "openrouter|bigger" });

  const chunks = await collect(fire({ purpose: "chat", model: "x" }));
  assert.equal(chunks.at(-1).from, "next", "the host handler must be used unchanged");
  assert.equal(fake.calls.length, 0, "no compaction call was issued");
});

test("an empty primary keeps the plugin transparent", async () => {
  const fake = scriptedStream({});
  const { ctx, fire } = makeCtx(fake.stream);
  apply(ctx, { primary: "", fallback: "openrouter|bigger" });

  const chunks = await collect(fire({ purpose: "compaction", model: "engine-default" }));
  assert.equal(chunks.at(-1).from, "next");
  assert.equal(fake.calls.length, 0, "a fallback without a primary must not route anything");
});

test("a compaction call is rewritten to the configured primary and effort", async () => {
  const fake = scriptedStream({ big: ok("summary") });
  const { ctx, fire } = makeCtx(fake.stream);
  apply(ctx, { primary: "openrouter|big", effort: "high" });

  const chunks = await collect(fire({ purpose: "compaction", provider: "engine", model: "engine-default" }));
  assert.deepEqual(chunks.map((c) => c.type), ["text", "finish"]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].provider, "openrouter");
  assert.equal(fake.calls[0].model, "big");
  assert.equal(fake.calls[0].reasoningEffort, "high");
});

test("a failed primary is retried on the fallback, and the fallback's chunks are yielded", async () => {
  const fake = scriptedStream({ big: failed(), bigger: ok("fallback summary") });
  const { ctx, fire, logs } = makeCtx(fake.stream);
  apply(ctx, { primary: "openrouter|big", fallback: "openrouter|bigger" });

  const chunks = await collect(fire({ purpose: "compaction" }));
  assert.deepEqual(fake.calls.map((c) => c.model), ["big", "bigger"]);
  assert.equal(chunks[0].text, "fallback summary");
  assert.ok(
    logs.some(([, m]) => m.includes("summarized with fallback")),
    "the win must be reported",
  );
});

test("when every candidate fails the last attempt's chunks are yielded, not a retry", async () => {
  const fake = scriptedStream({ big: failed(), bigger: failed("RATE_LIMIT") });
  const { ctx, fire, logs } = makeCtx(fake.stream);
  apply(ctx, { primary: "openrouter|big", fallback: "openrouter|bigger" });

  const chunks = await collect(fire({ purpose: "compaction" }));
  assert.equal(fake.calls.length, 2);
  assert.equal(chunks.at(-1).reason.kind, "error");
  assert.ok(logs.some(([, m]) => m.includes("no candidate left")));
});

test("an aborted signal stops the chain instead of trying the fallback", async () => {
  const fake = scriptedStream({ big: failed("ABORTED"), bigger: ok("never used") });
  const { ctx, fire } = makeCtx(fake.stream);
  apply(ctx, { primary: "openrouter|big", fallback: "openrouter|bigger" });

  const controller = new AbortController();
  controller.abort();
  const chunks = await collect(fire({ purpose: "compaction", signal: controller.signal }));
  assert.deepEqual(fake.calls.map((c) => c.model), ["big"], "cancellation must win");
  assert.equal(chunks.at(-1).reason.kind, "error");
});

test("its own re-entrant dispatch delegates instead of looping", async () => {
  const fake = scriptedStream({ big: ok("summary") });
  const { ctx, fire } = makeCtx(fake.stream);
  apply(ctx, { primary: "openrouter|big" });

  await collect(fire({ purpose: "compaction" }));
  const ownCall = fake.calls[0];
  // The runtime re-enters the waterfall with the very object the plugin created;
  // seeing that object again must delegate, or the plugin would recurse forever.
  const replayed = await collect(fire(ownCall));
  assert.equal(replayed.at(-1).from, "next");
  assert.equal(fake.calls.length, 1, "no second dispatch");
});

test("disabled leaves the engine alone", async () => {
  const fake = scriptedStream({ big: ok("summary") });
  const { ctx, fire } = makeCtx(fake.stream);
  apply(ctx, { enabled: false, primary: "openrouter|big" });

  const chunks = await collect(fire({ purpose: "compaction" }));
  assert.equal(chunks.at(-1).from, "next");
  assert.equal(fake.calls.length, 0);
});

// --- engine switches -------------------------------------------------------

test("both switches on delegates to the engine unchanged", async () => {
  const { engine, calls } = makeEngine();
  assert.equal(applyEnginePolicy(engine, () => ({ gate: true, auto: true })), true);

  assert.equal(await engine.compactPressure("a", "h", undefined, true), "pressure-result");
  assert.equal(await engine.compactIfNeeded("a", "pressure", undefined), "ifNeeded-result");
  assert.deepEqual(calls.map((c) => c[0]), ["pressure", "ifNeeded"]);
  assert.deepEqual(calls[0].slice(1), ["a", "h", undefined, true], "arguments must pass through");
});

test("gate off lets the model switch through but keeps the other pressure passes", async () => {
  const { engine, calls } = makeEngine();
  const settings = { gate: false, auto: true };
  applyEnginePolicy(engine, () => ({ gate: settings.gate, auto: settings.auto }));

  // requireBelowThreshold === true is the model-switch gate, and nothing else.
  assert.equal(await engine.compactPressure("a", "h", undefined, true), null);
  assert.equal(calls.length, 0, "the gate must not reach the engine");

  // The between-step pressure pass passes false and must still run.
  assert.equal(await engine.compactPressure("a", "h", undefined, false), "pressure-result");
  assert.equal(calls.length, 1);
});

test("auto off silences every automatic path but not the manual command", async () => {
  const { engine, calls } = makeEngine();
  const settings = { gate: true, auto: false };
  applyEnginePolicy(engine, () => ({ gate: settings.gate, auto: settings.auto }));
  const manual = engine.compactNow;

  assert.equal(await engine.compactPressure("a", "h", undefined, true), null);
  assert.equal(await engine.compactPressure("a", "h", undefined, false), null);
  assert.equal(await engine.compactIfNeeded("a", "pressure", undefined), null);
  assert.equal(await engine.compactIfNeeded("a", "context-overflow", undefined), null);
  assert.equal(calls.length, 0, "no automatic trigger may reach the engine");

  // /compact never reads the flag: it must survive both switches being off.
  assert.equal(engine.compactNow, manual, "compactNow must not be wrapped");
  assert.equal(await engine.compactNow("a", undefined), "now-result");
  assert.deepEqual(calls.map((c) => c[0]), ["now"]);
});

test("the switches are read per call, so a settings edit applies immediately", async () => {
  const { engine, calls } = makeEngine();
  const settings = { gate: true, auto: true };
  applyEnginePolicy(engine, () => ({ gate: settings.gate, auto: settings.auto }));

  assert.equal(await engine.compactPressure("a", "h", undefined, true), "pressure-result");
  settings.gate = false;
  assert.equal(await engine.compactPressure("a", "h", undefined, true), null);
  settings.gate = true;
  settings.auto = false;
  assert.equal(await engine.compactPressure("a", "h", undefined, true), null);
  settings.auto = true;
  assert.equal(await engine.compactPressure("a", "h", undefined, true), "pressure-result");
  assert.equal(calls.length, 2, "only the two enabled calls reach the engine");
});

test("wrapping the same engine twice is refused", async () => {
  const { engine } = makeEngine();
  const flags = () => ({ gate: true, auto: true });
  assert.equal(applyEnginePolicy(engine, flags), true);
  assert.equal(applyEnginePolicy(engine, flags), false, "a second wrap would double-wrap and must be refused");
});

test("an engine without the entry points is left alone", () => {
  assert.equal(applyEnginePolicy({}, () => ({ gate: true, auto: true })), false);
  assert.equal(applyEnginePolicy(null, () => ({ gate: true, auto: true })), false);
});

test("a live engine is wrapped when the plugin mounts", async () => {
  const fake = scriptedStream({});
  const { engine, calls } = makeEngine();
  const { ctx } = makeCtx(fake.stream, { compaction: engine });
  apply(ctx, { gate: false, auto: true });

  assert.equal(await engine.compactPressure("a", "h", undefined, true), null);
  assert.equal(calls.length, 0, "the switch must be in force without waiting for a timer");
});

test("an engine found only through the service store is wrapped too", async () => {
  const fake = scriptedStream({});
  const { engine, calls } = makeEngine();
  // Not reachable through ctx.get(): only the isolated realm's store entry exists.
  const { ctx } = makeCtx(fake.stream, {});
  ctx.reflect.store[Symbol("isolate.other")] = { name: "compaction", value: engine };
  apply(ctx, { gate: true, auto: false });

  assert.equal(await engine.compactIfNeeded("a", "pressure", undefined), null);
  assert.equal(calls.length, 0);
});
