import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, name } from "../lib/index.js";

/**
 * Minimal cordis-ish context. `inject(['llm'], fn)` is called synchronously with
 * a scope exposing `llm.stream`, and any listener the plugin registers on that
 * scope is captured so a test can drive it.
 */
function makeCtx(stream) {
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
  };
  return {
    ctx,
    logs,
    listeners,
    fire: (options, next = async function* () { yield { type: "finish", reason: { kind: "done" }, from: "next" }; }) =>
      listeners[0].handler(options, next),
  };
}

/** Build a fake `llm.stream` that records calls and replies per model. */
function scriptedStream(replies) {
  const calls = [];
  async function* stream(call) {
    calls.push(call);
    const reply = replies[call.model];
    if (reply === undefined) {
      yield { type: "finish", reason: { kind: "error", failure: { code: "NOT_CONFIGURED", message: `no script for ${call.model}` } } };
      return;
    }
    for (const chunk of reply) yield chunk;
  }
  return { calls, stream };
}

const ok = (text) => [
  { type: "text", text },
  { type: "finish", reason: { kind: "done" } },
];
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
  const { ctx, listeners } = makeCtx(fake.stream);
  apply(ctx, {});
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].event, "llm/stream");
  assert.equal(listeners[0].options?.global, true);
  assert.equal(listeners[0].options?.prepend, true);
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
