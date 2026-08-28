import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initials } from '../public/icons.js';

test('initials takes the first letter of up to two words', () => {
  assert.equal(initials('Camden Goff'), 'CG');
  assert.equal(initials('Madonna'), 'M');
});

test('a name with extra whitespace still works', () => {
  assert.equal(initials('  Ryan   Burnett  '), 'RB');
});

test('three or more names only use the first two', () => {
  assert.equal(initials('Mary Jane Watson'), 'MJ');
});

test('nothing to work with falls back rather than throwing', () => {
  assert.equal(initials(''), '?');
  assert.equal(initials(null), '?');
  assert.equal(initials(undefined), '?');
  assert.equal(initials('   '), '?');
});

test('lowercase input is still upper-cased', () => {
  assert.equal(initials('jamie fox'), 'JF');
});
