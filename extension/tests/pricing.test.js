import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/pricing.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const pricing = context.FocusRewardsPricing;

test("prices duration in seconds with the central multiplier and rounds up", () => {
  const examples = [
    [5, 6],
    [10, 12],
    [15, 18],
    [20, 24],
    [30, 36],
    [45, 54],
    [60, 72],
  ];
  for (const [minutes, expected] of examples) {
    assert.equal(pricing.priceForDurationSeconds(minutes * 60), expected);
  }
  assert.equal(pricing.priceForDurationSeconds(1), 1);
  assert.equal(pricing.priceForDurationSeconds(61), 2);
});

test("does not price missing, invalid, or non-positive durations", () => {
  for (const duration of [null, undefined, NaN, Infinity, 0, -30, "300"]) {
    assert.equal(pricing.priceForDurationSeconds(duration), null);
  }
});

test("parses YouTube clock and accessible duration formats", () => {
  assert.equal(pricing.parseDurationSeconds("5:00"), 300);
  assert.equal(pricing.parseDurationSeconds("1:02:03"), 3723);
  assert.equal(pricing.parseDurationSeconds("5 minutes, 2 seconds"), 302);
  assert.equal(pricing.parseDurationSeconds("Duration 1 hour, 2 minutes"), 3720);
  assert.equal(pricing.parseDurationSeconds("Live now"), null);
  assert.equal(pricing.parseDurationSeconds(""), null);
  assert.equal(pricing.parseDurationSeconds("1:99"), null);
});
