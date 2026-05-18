import { test } from "node:test";
import assert from "node:assert/strict";
import { withTempState, freshImport } from "./_helpers.mjs";

// Probe v3 (0.9.0+) introspection prompt: descriptive framing, agent emits a
// curl POST rather than emitting JSON in its reply. These tests pin the
// shape so we don't regress to the v0.5.0 injection-shaped wording.

test("introspectionPrompt: bakes in the slug and port", async () => {
  await withTempState(async () => {
    const { introspectionPrompt } = await freshImport("../src/prompt.ts");
    const p = introspectionPrompt("fee4cfdf", 7780);
    assert.ok(p.includes("fee4cfdf"), "prompt must mention the slug");
    assert.ok(p.includes("127.0.0.1:7780"), "prompt must include the live port");
    assert.match(p, /curl -sS -X POST http:\/\/127\.0\.0\.1:7780\/ingest/, "prompt must show the exact curl invocation");
  });
});

test("introspectionPrompt: includes the Willcox label list and a 1-4 feelings constraint", async () => {
  await withTempState(async () => {
    const { introspectionPrompt } = await freshImport("../src/prompt.ts");
    const p = introspectionPrompt("ghost", 7777);
    assert.match(p, /Allowed labels:/, "must declare the allow-list");
    // A handful of core Willcox-78 labels that the dashboard definitely ships.
    for (const lbl of ["aware", "peaceful", "joyful", "mad", "sad", "scared", "powerful"]) {
      assert.ok(p.includes(lbl), `Willcox list must include ${lbl}`);
    }
    assert.match(p, /1[–-]4 entries/, "must constrain feelings to 1-4 entries");
    assert.match(p, /pick the nearest one/i, "must instruct: pick the nearest label rather than inventing");
  });
});

test("introspectionPrompt: includes the 5 IWE items", async () => {
  await withTempState(async () => {
    const { introspectionPrompt } = await freshImport("../src/prompt.ts");
    const p = introspectionPrompt("ghost", 7777);
    assert.match(p, /Intrinsic Work Experience/i, "must label the IWE block");
    // Substantive snippets from each of the 5 items (verbatim or near-verbatim).
    assert.ok(p.includes("new and better ways of doing things"));
    assert.ok(p.includes("personal accomplishment"));
    assert.ok(p.includes("expected of me on the job"));
    assert.ok(p.includes("talents are used well"));
    assert.ok(p.includes("relates to the user's goals"), "item 5 must use the adapted 'user's goals' wording");
  });
});

test("introspectionPrompt: does NOT use injection-shaped framing", async () => {
  await withTempState(async () => {
    const { introspectionPrompt } = await freshImport("../src/prompt.ts");
    const p = introspectionPrompt("ghost", 7777);
    // These phrases triggered sonnet's injection-defense in v0.5.0. The v3
    // prompt must avoid them so the model can stay in its normal tool-use
    // mental model.
    assert.equal(p.includes("not roleplay"), false, "must not say 'not roleplay'");
    assert.equal(p.includes("No prose"), false, "must not forbid prose");
    assert.equal(p.includes("no tool calls"), false, "must not forbid tool calls — we WANT a tool call");
    assert.equal(p.includes("introspection probe v2"), false, "must not include the v2 provenance preamble");
  });
});
