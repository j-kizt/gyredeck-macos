import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { SYNC_CODE_ALPHABET, syncCodeChar } from "../adapters/bridge/gyredeck-bridge.mjs";

/**
 * A room code is a name people read to each other, not a secret — knowing one grants
 * nothing. So nothing here depends on the draw being even; it is simply free to do
 * properly, and CodeQL was right that it was not being done properly.
 *
 * The generator is imported, not copied. A copy passes just as happily when the original
 * goes back to a plain modulo, which is the one thing this file exists to notice — the
 * first version of it made that mistake.
 */
const ALPHABET = SYNC_CODE_ALPHABET;
const LIMIT = 256 - (256 % ALPHABET.length);

/** The rejected shape, kept only so the two can be compared in the same run. */
const drawByModulo = () => ALPHABET[randomBytes(1)[0] % ALPHABET.length];

/**
 * The share of draws landing on the eight characters the modulo favours.
 *
 * Not `max/min` across all 31 bins, which was the first attempt and could not work: at any
 * sample size this suite can afford, the ordinary scatter of 31 counts overlaps the 12.5%
 * edge being looked for, so the measure cannot tell luck from bias. This is one number
 * instead of 31, and it is the number the fault actually moves — the modulo sends 72 of
 * 256 byte values here (0.281) against 8 of 31 (0.258) for an even draw.
 */
const FAVOURED = new Set("abcdefgh");
const favouredShare = (draw, rounds) => {
  let landed = 0;
  const seen = new Set();
  for (let index = 0; index < rounds; index += 1) {
    const character = draw();
    seen.add(character);
    if (FAVOURED.has(character)) landed += 1;
  }
  assert.equal(seen.size, ALPHABET.length, "every character is reachable");
  return landed / rounds;
};

test("the modulo the alphabet had is measurably uneven", () => {
  // Stated as arithmetic rather than sampled, because this is the fault being fixed and a
  // sampled version of it could pass by luck. 256 is not a multiple of 31, so eight of the
  // byte values fall to the first eight letters a second time.
  assert.equal(256 % ALPHABET.length, 8);
  const reached = new Map();
  for (let byte = 0; byte < 256; byte += 1) {
    const character = ALPHABET[byte % ALPHABET.length];
    reached.set(character, (reached.get(character) ?? 0) + 1);
  }
  const favoured = [...reached].filter(([, count]) => count === 9).map(([character]) => character);
  assert.deepEqual(favoured, [...FAVOURED], "the first eight letters, and exactly those");
  assert.equal(Math.max(...reached.values()) / Math.min(...reached.values()), 9 / 8);
});

test("throwing away the bytes past the last whole multiple evens it out", () => {
  // 31 × 8 = 248, so each character owns exactly eight byte values and no others are used.
  assert.equal(LIMIT, 248);
  assert.equal(LIMIT % ALPHABET.length, 0);
  const reached = new Map();
  for (let byte = 0; byte < LIMIT; byte += 1) {
    const character = ALPHABET[byte % ALPHABET.length];
    reached.set(character, (reached.get(character) ?? 0) + 1);
  }
  assert.equal(new Set(reached.values()).size, 1, "every character owns the same number of bytes");
});

test("the generator the bridge actually uses draws evenly", () => {
  // `syncCodeChar` imported from the bridge, so this fails if the bridge goes back to a
  // plain modulo — which a local copy of the rule would not. Both are drawn in the same
  // run against the same generator, so the comparison says which is flatter rather than
  // resting on a threshold guessed in advance.
  //
  // 300k draws puts each share about fourteen standard errors from the midpoint between
  // the two expected values, so a run failing by chance is not a thing that happens.
  const rounds = 300_000;
  const even = favouredShare(syncCodeChar, rounds);
  const modulo = favouredShare(drawByModulo, rounds);
  const evenExpected = 8 / ALPHABET.length;
  const moduloExpected = (8 * 9) / 256;
  const midpoint = (evenExpected + moduloExpected) / 2;

  assert.ok(even < midpoint, `the bridge stays near ${evenExpected.toFixed(4)}: got ${even.toFixed(4)}`);
  assert.ok(modulo > midpoint, `the modulo keeps its edge near ${moduloExpected.toFixed(4)}: got ${modulo.toFixed(4)}`);
  assert.ok(even < modulo, "and the bridge is the flatter of the two");
});
