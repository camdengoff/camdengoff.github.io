import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryBreakdown, segments, SEGMENT_ORDER, PINNED_CATEGORIES } from '../public/breakdown.js';

const gear = (id, category, status = 'ready', extra = {}) =>
  ({ id, name: `Item ${id}`, category, _status: status, ...extra });
const statusFor = i => i._status;

test('gear is counted into its own category', () => {
  const rows = categoryBreakdown([
    gear(1, 'Cameras'), gear(2, 'Cameras'), gear(3, 'Lighting')
  ], statusFor);
  assert.deepEqual(rows.map(r => [r.category, r.total]), [['Cameras', 2], ['Lighting', 1]]);
});

test('every status lands in its own bucket', () => {
  const rows = categoryBreakdown([
    gear(1, 'Cameras', 'ready'), gear(2, 'Cameras', 'out'),
    gear(3, 'Cameras', 'overdue'), gear(4, 'Cameras', 'held'),
    gear(5, 'Cameras', 'repair')
  ], statusFor);
  const c = rows[0];
  assert.deepEqual(
    { ready: c.ready, out: c.out, overdue: c.overdue, held: c.held, repair: c.repair },
    { ready: 1, out: 1, overdue: 1, held: 1, repair: 1 });
  assert.equal(c.total, 5);
  assert.equal(c.unavailable, 4, 'everything except ready is spoken for');
});

test('retired gear is not inventory', () => {
  const rows = categoryBreakdown([
    gear(1, 'Cameras'), gear(2, 'Cameras', 'ready', { retired: true })
  ], statusFor);
  assert.equal(rows[0].total, 1);
});

/* The order has to be stable, or the strip reshuffles itself every time a
   camera goes out and you lose your place. */
test('unpinned categories are ordered by size, then name', () => {
  const rows = categoryBreakdown([
    gear(1, 'Audio'), gear(2, 'Grip'), gear(3, 'Grip'),
    gear(4, 'Stands'), gear(5, 'Stands'), gear(6, 'Stands')
  ], statusFor);
  assert.deepEqual(rows.map(r => r.category), ['Stands', 'Grip', 'Audio']);
});

test('gear with no category is grouped rather than dropped', () => {
  const rows = categoryBreakdown([
    gear(1, ''), gear(2, '   '), gear(3, null), gear(4, 'Cameras')
  ], statusFor);
  const un = rows.find(r => r.category === 'Uncategorized');
  assert.equal(un.total, 3);
});

test('a category name is trimmed, so trailing spaces do not split it in two', () => {
  const rows = categoryBreakdown([gear(1, 'Lighting'), gear(2, 'Lighting ')], statusFor);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 2);
});

/* A bar that doesn't quite fill is honest. One that reports gear as available
   when the status was unreadable is not. */
test('an unrecognised status is counted in the total but claims no segment', () => {
  const rows = categoryBreakdown([
    gear(1, 'Cameras', 'ready'), gear(2, 'Cameras', 'who-knows')
  ], statusFor);
  assert.equal(rows[0].total, 2);
  assert.equal(rows[0].ready, 1);
  assert.equal(rows[0].unavailable, 0);
  assert.equal(segments(rows[0]).reduce((n, s) => n + s.count, 0), 1);
});

test('segments are proportions of the category, in a fixed order', () => {
  const [row] = categoryBreakdown([
    gear(1, 'Cameras', 'out'), gear(2, 'Cameras', 'ready'),
    gear(3, 'Cameras', 'ready'), gear(4, 'Cameras', 'ready')
  ], statusFor);
  const segs = segments(row);
  assert.deepEqual(segs.map(s => s.status), ['ready', 'out'], 'ready first, worst last');
  assert.equal(segs[0].pct, 75);
  assert.equal(segs[1].pct, 25);
});

test('empty states get no segment at all', () => {
  const [row] = categoryBreakdown([gear(1, 'Cameras', 'ready')], statusFor);
  assert.deepEqual(segments(row).map(s => s.status), ['ready']);
});

test('segments always sum to at most the whole bar', () => {
  const [row] = categoryBreakdown(
    Array.from({ length: 7 }, (_, n) => gear(n, 'Mixed', SEGMENT_ORDER[n % SEGMENT_ORDER.length])),
    statusFor);
  const total = segments(row).reduce((n, s) => n + s.pct, 0);
  assert.ok(Math.abs(total - 100) < 0.001, `expected ~100, got ${total}`);
});

test('an empty cage produces nothing rather than throwing', () => {
  assert.deepEqual(categoryBreakdown([], statusFor), []);
  assert.deepEqual(categoryBreakdown(null, statusFor), []);
  assert.deepEqual(segments(null), []);
  assert.deepEqual(segments({ total: 0 }), []);
});

test('cameras lead, then lighting, then everything else biggest-first', () => {
  const rows = categoryBreakdown([
    ...Array.from({ length: 9 }, (_, n) => gear(n + 1, 'Accessories')),
    ...Array.from({ length: 5 }, (_, n) => gear(n + 20, 'Lighting')),
    ...Array.from({ length: 2 }, (_, n) => gear(n + 30, 'Cameras')),
    ...Array.from({ length: 7 }, (_, n) => gear(n + 40, 'Lenses'))
  ], statusFor);
  assert.deepEqual(rows.map(r => r.category), ['Cameras', 'Lighting', 'Accessories', 'Lenses']);
});

test('the pinned pair lead even when the cage has none of one of them', () => {
  const rows = categoryBreakdown([
    gear(1, 'Audio'), gear(2, 'Audio'), gear(3, 'Cameras')
  ], statusFor);
  assert.deepEqual(rows.map(r => r.category), ['Cameras', 'Audio']);
});

test('pinning ignores case and stray spacing, as category matching does', () => {
  const rows = categoryBreakdown([
    gear(1, 'Audio'), gear(2, 'Audio'), gear(3, 'Audio'), gear(4, ' lighting ')
  ], statusFor);
  assert.equal(rows[0].category, 'lighting');
});
