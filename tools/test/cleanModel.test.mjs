import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanModel } from "../src/paths.ts";

test("cleanModel: strips [1m] suffix from 1M-context Opus model id", () => {
  assert.equal(cleanModel("claude-opus-4-7[1m]"), "claude-opus-4-7");
});

test("cleanModel: strips [200k] suffix", () => {
  assert.equal(cleanModel("claude-opus-4-7[200k]"), "claude-opus-4-7");
});

test("cleanModel: leaves plain model id unchanged", () => {
  assert.equal(cleanModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(cleanModel("claude-opus-4-7"), "claude-opus-4-7");
});

test("cleanModel: empty / nullish input returns 'unknown'", () => {
  assert.equal(cleanModel(""), "unknown");
  assert.equal(cleanModel(undefined), "unknown");
  assert.equal(cleanModel(null), "unknown");
});

test("cleanModel: drops chars outside [a-zA-Z0-9._-] without mangling them", () => {
  // Earlier sanitize() turned these into underscores; we drop them entirely
  // so the result either matches a real model id or fails fast at the API.
  assert.equal(cleanModel("a/b\\c?d"), "abcd");
  assert.equal(cleanModel("claude/opus"), "claudeopus");
});

test("cleanModel: caps at 64 chars", () => {
  assert.equal(cleanModel("x".repeat(200)).length, 64);
});

test("cleanModel: only strips suffix-position brackets, not mid-string ones", () => {
  // Edge case: trailing bracket is the context hint we want to drop;
  // mid-string brackets are unexpected and treated as junk chars (dropped).
  assert.equal(cleanModel("foo[1m]"), "foo");
  assert.equal(cleanModel("foo[1m]bar"), "foo1mbar");
});

test("cleanModel: trims whitespace before stripping suffix", () => {
  assert.equal(cleanModel("  claude-opus-4-7[1m]  "), "claude-opus-4-7");
});
