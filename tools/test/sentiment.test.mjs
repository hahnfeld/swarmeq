import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { withTempState } from "./_helpers.mjs";
import {
  polarity, computeSentiment,
  appendSentimentPoint, readSentimentHistory,
} from "../src/sentiment.ts";
import { SENTIMENT_FILE } from "../src/paths.ts";

test("polarity: maps positive cores to +1", () => {
  assert.equal(polarity("joyful"), 1);
  assert.equal(polarity("powerful"), 1);
  assert.equal(polarity("peaceful"), 1);
});

test("polarity: maps negative cores to -1", () => {
  assert.equal(polarity("mad"), -1);
  assert.equal(polarity("sad"), -1);
  assert.equal(polarity("scared"), -1);
});

test("polarity: unknown labels return 0", () => {
  assert.equal(polarity("zzz"), 0);
  assert.equal(polarity(""), 0);
});

test("computeSentiment: empty map yields ratio=null, agentCount=0", () => {
  const s = computeSentiment({});
  assert.deepEqual(s, { positive: 0, negative: 0, ratio: null, agentCount: 0 });
});

test("computeSentiment: all-positive yields ratio 1.0", () => {
  const s = computeSentiment({
    a: { agent: "a", feelings: [{ label: "joyful", intensity: 1 }], note: "", ts: 0 },
    b: { agent: "b", feelings: [{ label: "peaceful", intensity: 0.5 }], note: "", ts: 0 },
  });
  assert.equal(s.ratio, 1);
  assert.equal(s.agentCount, 2);
  assert.equal(s.negative, 0);
});

test("computeSentiment: all-negative yields ratio 0.0", () => {
  const s = computeSentiment({
    a: { agent: "a", feelings: [{ label: "mad", intensity: 1 }], note: "", ts: 0 },
  });
  assert.equal(s.ratio, 0);
  assert.equal(s.positive, 0);
});

test("computeSentiment: mixed yields expected ratio", () => {
  const s = computeSentiment({
    a: { agent: "a", feelings: [{ label: "joyful", intensity: 0.6 }], note: "", ts: 0 },
    b: { agent: "b", feelings: [{ label: "mad", intensity: 0.4 }], note: "", ts: 0 },
  });
  // 0.6 / (0.6 + 0.4) = 0.6
  assert.ok(Math.abs(s.ratio - 0.6) < 1e-9);
});

test("computeSentiment: agentCount counts keys even with no valenced feelings", () => {
  const s = computeSentiment({
    a: { agent: "a", feelings: [], note: "", ts: 0 },
  });
  assert.equal(s.agentCount, 1);
  assert.equal(s.ratio, null);
});

test("appendSentimentPoint + readSentimentHistory round-trip", async () => {
  await withTempState(() => {
    appendSentimentPoint({ ts: 100, ratio: 0.5, agentCount: 2 });
    appendSentimentPoint({ ts: 200, ratio: null, agentCount: 0 });
    appendSentimentPoint({ ts: 300, ratio: 0.75, agentCount: 1 });
    const history = readSentimentHistory();
    assert.equal(history.length, 3);
    assert.equal(history[0].ts, 100);
    assert.equal(history[2].ratio, 0.75);
  });
});

test("readSentimentHistory: limit caps the result count", async () => {
  await withTempState(() => {
    for (let i = 1; i <= 10; i++) appendSentimentPoint({ ts: i, ratio: 0.5, agentCount: 1 });
    const slice = readSentimentHistory(3);
    assert.equal(slice.length, 3);
    // returns oldest-first within the trailing window
    assert.equal(slice[0].ts, 8);
    assert.equal(slice[2].ts, 10);
  });
});

test("readSentimentHistory: missing file returns []", async () => {
  await withTempState(() => {
    assert.deepEqual(readSentimentHistory(), []);
  });
});

test("readSentimentHistory: skips malformed lines", async () => {
  await withTempState(() => {
    fs.writeFileSync(SENTIMENT_FILE(),
      `{"ts":1,"ratio":0.5,"agentCount":1}\nnot json\n{"ts":2,"ratio":0.6,"agentCount":1}\n`);
    const h = readSentimentHistory();
    assert.equal(h.length, 2);
  });
});
