import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReport } from "../src/validate.ts";

const validReport = () => ({
  agent: "alpha",
  feelings: [{ label: "joyful", intensity: 0.5 }],
  note: "doing fine",
});

test("validateReport: accepts a well-formed report", () => {
  const v = validateReport(validReport());
  assert.equal(v.ok, true);
  assert.equal(v.report.agent, "alpha");
  assert.equal(v.report.feelings.length, 1);
  assert.equal(v.report.note, "doing fine");
  assert.ok(typeof v.report.ts === "number");
});

test("validateReport: rejects non-object input", () => {
  assert.equal(validateReport(null).ok, false);
  assert.equal(validateReport("string").ok, false);
  assert.equal(validateReport(42).ok, false);
});

test("validateReport: requires non-empty string agent", () => {
  const v = validateReport({ ...validReport(), agent: "" });
  assert.equal(v.ok, false);
  assert.match(v.errs[0], /agent must be/);
});

test("validateReport: rejects 65-char agent", () => {
  const v = validateReport({ ...validReport(), agent: "x".repeat(65) });
  assert.equal(v.ok, false);
});

test("validateReport: rejects agent with control characters", () => {
  const v = validateReport({ ...validReport(), agent: "bad\x00name" });
  assert.equal(v.ok, false);
});

test("validateReport: rejects 0 or 7+ feelings", () => {
  assert.equal(validateReport({ ...validReport(), feelings: [] }).ok, false);
  const many = Array.from({ length: 7 }, () => ({ label: "joyful", intensity: 0.5 }));
  assert.equal(validateReport({ ...validReport(), feelings: many }).ok, false);
});

test("validateReport: rejects unknown feeling labels", () => {
  const v = validateReport({ ...validReport(), feelings: [{ label: "nonsense", intensity: 0.5 }] });
  assert.equal(v.ok, false);
  assert.match(v.errs[0], /Willcox/);
});

test("validateReport: rejects intensity out of [0,1]", () => {
  const bad = (i) => validateReport({ ...validReport(), feelings: [{ label: "joyful", intensity: i }] });
  assert.equal(bad(-0.1).ok, false);
  assert.equal(bad(1.1).ok, false);
  assert.equal(bad(NaN).ok, false);
  assert.equal(bad("0.5").ok, false);
});

test("validateReport: rejects non-string / oversize / control-character notes", () => {
  assert.equal(validateReport({ ...validReport(), note: 42 }).ok, false);
  assert.equal(validateReport({ ...validReport(), note: "x".repeat(201) }).ok, false);
  assert.equal(validateReport({ ...validReport(), note: "bad\x01char" }).ok, false);
});

test("validateReport: omitted note becomes empty string", () => {
  const v = validateReport({ agent: "alpha", feelings: [{ label: "joyful", intensity: 1 }] });
  assert.equal(v.ok, true);
  assert.equal(v.report.note, "");
});

test("validateReport: rejects feelings entry that's not an object", () => {
  const v = validateReport({ ...validReport(), feelings: ["not-an-object"] });
  assert.equal(v.ok, false);
});

// iwe (0.8.0+): FEVS Intrinsic Work Experience sub-index ratings. Sparse
// object keyed by item number "1"-"5" with integer values 1-5 (Likert).
// Optional both at the field level and per-item.

test("validateReport: iwe omitted → valid, report has no iwe field", () => {
  const v = validateReport(validReport());
  assert.equal(v.ok, true);
  assert.equal(v.report.iwe, undefined);
});

test("validateReport: well-formed iwe is accepted and round-tripped", () => {
  const v = validateReport({ ...validReport(), iwe: { "1": 4, "3": 5, "5": 3 } });
  assert.equal(v.ok, true);
  assert.deepEqual(v.report.iwe, { "1": 4, "3": 5, "5": 3 });
});

test("validateReport: empty iwe object is accepted", () => {
  const v = validateReport({ ...validReport(), iwe: {} });
  assert.equal(v.ok, true);
  assert.deepEqual(v.report.iwe, {});
});

test("validateReport: iwe null is treated as absent", () => {
  const v = validateReport({ ...validReport(), iwe: null });
  assert.equal(v.ok, true);
  assert.equal(v.report.iwe, undefined);
});

test("validateReport: rejects iwe as array", () => {
  const v = validateReport({ ...validReport(), iwe: [4, 5] });
  assert.equal(v.ok, false);
});

test("validateReport: rejects iwe key out of [1,5] range", () => {
  assert.equal(validateReport({ ...validReport(), iwe: { "0": 3 } }).ok, false);
  assert.equal(validateReport({ ...validReport(), iwe: { "6": 3 } }).ok, false);
  assert.equal(validateReport({ ...validReport(), iwe: { "x": 3 } }).ok, false);
});

test("validateReport: rejects iwe value out of [1,5] range", () => {
  assert.equal(validateReport({ ...validReport(), iwe: { "1": 0 } }).ok, false);
  assert.equal(validateReport({ ...validReport(), iwe: { "1": 6 } }).ok, false);
  assert.equal(validateReport({ ...validReport(), iwe: { "1": -1 } }).ok, false);
});

test("validateReport: rejects iwe non-integer value", () => {
  assert.equal(validateReport({ ...validReport(), iwe: { "1": 3.5 } }).ok, false);
  assert.equal(validateReport({ ...validReport(), iwe: { "1": "4" } }).ok, false);
  assert.equal(validateReport({ ...validReport(), iwe: { "1": NaN } }).ok, false);
});
