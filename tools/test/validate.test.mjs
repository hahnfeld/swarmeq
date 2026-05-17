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
