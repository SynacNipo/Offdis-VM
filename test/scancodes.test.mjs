import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chordParts, resolveKey, textToGroups, keyNames, burstGroups,
} from '../src/scancodes.mjs';

const G = (len) => new Array(len).fill(0x1e);

test('chordParts resolves plain keys', () => {
  assert.deepEqual(chordParts('enter'), { makes: [0x1c], breaks: [0x9c] });
});

test('chordParts resolves modifier chords', () => {
  assert.deepEqual(chordParts('win+r'), { makes: [0xe0, 0x5b, 0x13], breaks: [0x93, 0xe0, 0xdb] });
  assert.deepEqual(chordParts('ctrl+alt+del'), { makes: [0x1d, 0x38, 0xe0, 0x53], breaks: [0xe0, 0xd3, 0xb8, 0x9d] });
});

test('chordParts handles aliases and case', () => {
  assert.deepEqual(chordParts('dEl'), { makes: [0xe0, 0x53], breaks: [0xe0, 0xd3] });
  assert.deepEqual(chordParts('WIN+R').makes, [0xe0, 0x5b, 0x13]);
});

test('chordParts rejects unknown and empty chords', () => {
  assert.throws(() => chordParts('boguskey'), /unknown key 'boguskey'/);
  assert.throws(() => chordParts(''), /no key given/);
});

test('resolveKey returns make+break', () => {
  assert.deepEqual(resolveKey('enter'), [0x1c, 0x9c]);
});

test('textToGroups types plain letters', () => {
  assert.deepEqual(textToGroups('abc'), [[0x1e, 0x9e], [0x30, 0xb0], [0x2e, 0xae]]);
});

test('textToGroups shifts per char with one held group', () => {
  assert.deepEqual(textToGroups('Abc'), [[0x2a, 0x1e, 0x9e], [0xaa, 0x30, 0xb0], [0x2e, 0xae]]);
});

test('textToGroups keeps shift held across a run', () => {
  // '!' is Shift+'1', so the held-shift burst reuses the 1 key make/break
  assert.deepEqual(textToGroups('!!'), [[0x2a, 0x02, 0x82], [0x02, 0x82], [0xaa]]);
});

test('textToGroups composes accented chars via dead keys', () => {
  // dead-key press/release is its own group, then the base char group
  assert.deepEqual(textToGroups('á'), [[0x28, 0xa8], [0x1e, 0x9e]]);
  assert.deepEqual(textToGroups('ü'), [[0x2a, 0x28, 0xa8, 0xaa], [0x16, 0x96]]);
});

test('textToGroups maps whitespace keys', () => {
  assert.deepEqual(textToGroups('a\t'), [[0x1e, 0x9e], [0x0f, 0x8f]]);
  assert.deepEqual(textToGroups('a b'), [[0x1e, 0x9e], [0x39, 0xb9], [0x30, 0xb0]]);
});

test('textToGroups rejects untypeable characters', () => {
  assert.throws(() => textToGroups('€'), /cannot type character '€'/);
});

test('textToGroups handles empty text', () => {
  assert.deepEqual(textToGroups(''), []);
});

test('burstGroups batches shift-free codes up to max', () => {
  const groups = [G(2), G(2), G(2), G(2), G(2), G(2), G(2), G(2), G(2), G(2)];
  const bursts = burstGroups(groups, 8);
  assert.deepEqual(bursts.map((b) => b.length), [16, 4]);
});

test('burstGroups never splits a shift group', () => {
  const bursts = burstGroups([G(2), G(4), G(2), G(2), G(2)], 3);
  assert.deepEqual(bursts.map((b) => b.length), [2, 8, 2]);
});

test('burstGroups handles exact and empty input', () => {
  assert.deepEqual(burstGroups([], 8), []);
  const exact = burstGroups([G(2), G(2), G(2), G(2)], 4);
  assert.deepEqual(exact.map((b) => b.length), [8]);
});

test('keyNames lists every key sorted', () => {
  const names = keyNames();
  assert.ok(names.includes('win') && names.includes('delete') && names.includes('f12'));
  assert.deepEqual(names, [...names].sort());
});
