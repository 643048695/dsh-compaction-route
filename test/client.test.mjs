/**
 * Smoke test for the browser half: it loads through `window.__ModuleLoader__`,
 * registers one card into `plugins.bundle.config`, and that card renders the two
 * engine switches plus the routing controls from a fake settings service.
 *
 * The card is a real React component with hooks, so this file carries a tiny
 * renderer: hooks are stored per slot, effects run once, and rendering repeats
 * until a state update settles. That is enough to exercise the load path and the
 * shape of the tree without React or a DOM.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "client", "client.js"), "utf8");

/** A minimal hook runtime: one slot per hook call, effects run once, settle on update. */
function makeRuntime() {
  const hooks = [];
  let cursor = 0;
  let dirty = false;

  const React = {
    createElement(type, props, children) {
      return {
        type,
        props: props ?? {},
        children: children === undefined ? [] : [].concat(children),
      };
    },
    useState(initial) {
      const slot = cursor++;
      if (hooks[slot] === undefined) {
        hooks[slot] = {
          value: typeof initial === "function" ? initial() : initial,
          set(next) {
            const value = typeof next === "function" ? next(hooks[slot].value) : next;
            if (value !== hooks[slot].value) {
              hooks[slot].value = value;
              dirty = true;
            }
          },
        };
      }
      return [hooks[slot].value, hooks[slot].set];
    },
    useEffect(fn) {
      const slot = cursor++;
      if (hooks[slot] === undefined) hooks[slot] = { effect: fn };
    },
    useCallback(fn) {
      cursor++;
      return fn;
    },
  };

  /** Render until no state update is pending, letting promises settle between rounds. */
  async function render(Card) {
    let tree;
    for (let round = 0; round < 25; round += 1) {
      cursor = 0;
      dirty = false;
      tree = Card();
      for (const slot of hooks) {
        if (slot === undefined || slot.effect === undefined) continue;
        const fn = slot.effect;
        slot.effect = undefined;
        const cleanup = fn();
        if (typeof cleanup === "function") cleanup();
      }
      // Two macrotask hops: enough for describe() -> then -> setState to land.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!dirty) return tree;
    }
    throw new Error("the card never settled");
  }

  return { React, render };
}

/** Load the bundle into a fake window and hand back the exported module plus a renderer. */
function load() {
  let exported;
  const runtime = makeRuntime();
  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, "dsh-compaction-route");
        exported = factory((specifier) => {
          assert.equal(specifier, "react");
          return runtime.React;
        });
      },
    },
  };
  vm.runInNewContext(source, { window, console });
  return { module: exported, render: runtime.render };
}

/** The namespace payload a real `settings.describe()` returns for this profile. */
function describeFixture(value, revision = 7) {
  return {
    ok: true,
    value: [
      {
        ns: "llm-pi-ai",
        value: {
          providers: {
            "magpie-anthropic": {
              models: [
                { id: "kiro/claude-opus-5.5", contextWindow: 1000000 },
                { id: "kiro/claude-haiku-5.5", contextWindow: 100000 },
              ],
            },
          },
        },
      },
      { ns: "compaction-route", value, revision },
    ],
  };
}

/** Mount the card with a fake client context and return the component. */
function mount({ locale = "en-US", value = {}, update } = {}) {
  const { module, render } = load();
  let Card;
  const updates = [];
  module.apply({
    slots: {
      inject(_seat, fn) {
        fn();
      },
      register(_options, component) {
        Card = component;
        return () => {};
      },
    },
    locale: { getLocale: () => ({ active: locale }) },
    remote: {
      settings: {
        describe: async () => describeFixture(value),
        update: async (ns, patch, revision) => {
          updates.push({ ns, patch, revision });
          if (update !== undefined) return update(ns, patch, revision);
          return { ok: true };
        },
      },
    },
  });
  assert.equal(typeof Card, "function", "the card must be registered");
  return { Card, render, updates };
}

/** Flatten a rendered tree into a list of nodes. */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children ?? []) flatten(child, out);
  return out;
}

/** All text carried by a tree. */
function textOf(tree) {
  return flatten(tree)
    .map((node) => (node.children ?? []).filter((child) => typeof child === "string").join(""))
    .join("\n");
}

test("the bundle registers one card under plugins.bundle.config", () => {
  const { module } = load();
  const registered = [];
  module.apply({
    slots: {
      inject(_seat, fn) {
        fn();
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
    locale: { getLocale: () => ({ active: "zh-CN" }) },
    remote: { settings: { describe: async () => describeFixture({}), update: async () => ({ ok: true }) } },
  });
  assert.equal(registered.length, 1);
  // The bundle runs inside its own VM realm, so its objects come from another
  // Object.prototype and cannot be compared structurally with deepEqual.
  assert.equal(
    JSON.stringify(registered[0].options),
    JSON.stringify({ name: "plugins.bundle.config", key: "dsh-compaction-route" }),
  );
  assert.equal(typeof registered[0].component, "function");
});

test("the card renders both engine switches plus routing, all on by default", async () => {
  const { Card, render } = mount();
  const nodes = flatten(await render(Card));
  const checkboxes = nodes.filter((node) => node.type === "input" && node.props.type === "checkbox");
  // gate, auto, and the routing enable checkbox.
  assert.equal(checkboxes.length, 3);
  assert.deepEqual(checkboxes.map((node) => node.props.checked), [true, true, true]);

  const text = textOf(await render(Card));
  assert.ok(text.includes("Condense to fit the destination model before switching"), "the gate switch must be labelled");
  assert.ok(text.includes("Automatic compaction"), "the auto switch must be labelled");
  assert.ok(!text.includes("Automatic compaction is off"), "no warning while auto is on");
});

test("stored switch values are read back, and the off-state warning appears", async () => {
  const { Card, render } = mount({
    value: { enabled: true, primary: "", fallback: "", effort: "", gate: false, auto: false },
  });
  const tree = await render(Card);
  const checkboxes = flatten(tree).filter((node) => node.type === "input" && node.props.type === "checkbox");
  assert.equal(checkboxes.length, 3, "the loaded card must show all three checkboxes");
  assert.equal(checkboxes[0].props.checked, false, "gate must read back as off");
  assert.equal(checkboxes[1].props.checked, false, "auto must read back as off");
  assert.ok(textOf(tree).includes("Automatic compaction is off"));
});

test("the model dropdowns are built from the llm-pi-ai namespace", async () => {
  const { Card, render } = mount();
  const nodes = flatten(await render(Card));
  const selects = nodes.filter((node) => node.type === "select");
  assert.equal(selects.length, 3, "primary, fallback, effort");

  const options = flatten(selects[0]).filter((node) => node.type === "option");
  // The empty stored value renders an explicit placeholder first, so the browser
  // cannot show the first real model while nothing is actually chosen.
  const values = options.map((node) => node.props.value).filter((value) => value !== "");
  assert.deepEqual(values, ["magpie-anthropic|kiro/claude-opus-5.5", "magpie-anthropic|kiro/claude-haiku-5.5"]);
  assert.ok(options[0].children.join("").includes("pick"), "the empty slot must read as a prompt, not a model");
  assert.ok(options[1].children.join("").includes("1M"), "the window hint must be shown");
});

test("flipping a switch writes only that field, with the current revision", async () => {
  const { Card, render, updates } = mount();
  const tree = await render(Card);
  const checkbox = flatten(tree).filter((node) => node.type === "input" && node.props.type === "checkbox")[0];

  checkbox.props.onChange({ currentTarget: { checked: false } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(updates.length, 1);
  assert.equal(updates[0].ns, "compaction-route");
  // Cross-realm objects cannot be compared with deepEqual; compare their shape.
  assert.equal(JSON.stringify(updates[0].patch), JSON.stringify({ gate: false }));
  assert.equal(updates[0].revision, 7, "the write must carry the revision it read");
});

test("the card speaks Chinese when the locale is Chinese", async () => {
  const { Card, render } = mount({ locale: "zh-CN" });
  const text = textOf(await render(Card));
  assert.ok(text.includes("换模型前先压到新模型容量以内"));
  assert.ok(text.includes("自动压缩"));
  assert.ok(text.includes("压缩模型路由"));
});

test("a missing settings service renders an explanation instead of controls", async () => {
  const { module, render } = load();
  let Card;
  module.apply({
    slots: { inject: (_s, fn) => fn(), register: (_o, component) => { Card = component; return () => {}; } },
    locale: { getLocale: () => ({ active: "en-US" }) },
    remote: {},
  });
  const nodes = flatten(await render(Card));
  assert.equal(nodes.filter((node) => node.type === "input").length, 0, "no controls without a settings service");
  assert.ok(textOf(nodes).length > 0, "the card must explain why it is empty");
});
