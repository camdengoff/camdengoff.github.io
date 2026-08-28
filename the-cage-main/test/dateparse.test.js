import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDayQuery, addMonths, addDays, daysInMonth, startOfMonth, monthLabel
} from '../public/dateparse.js';

/* Tuesday, 4 August 2026 — the date the demo data is built around. */
const TODAY = '2026-08-04';
const q = s => parseDayQuery(s, { today: TODAY });

/* ------------------------------------------------------------ month helpers */

test('daysInMonth handles the short months and leap years', () => {
  assert.equal(daysInMonth(2026, 8), 31);
  assert.equal(daysInMonth(2026, 9), 30);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
});

test('addMonths clamps instead of overflowing into the next month', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-08-04', 1), '2026-09-04');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
});

test('startOfMonth and monthLabel', () => {
  assert.equal(startOfMonth('2026-08-27'), '2026-08-01');
  assert.equal(monthLabel('2026-08-01'), 'August 2026');
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
});

/* --------------------------------------------------------------- single days */

test('nothing in, nothing out', () => {
  assert.equal(q(''), null);
  assert.equal(q('   '), null);
  assert.equal(q('bananas'), null);
});

test('relative days', () => {
  assert.deepEqual(q('today'), { start: TODAY, end: TODAY, label: TODAY });
  assert.equal(q('tomorrow').start, '2026-08-05');
  assert.equal(q('yesterday').start, '2026-08-03');
});

test('ISO dates are read as one day, not as a range', () => {
  const r = q('2026-08-14');
  assert.deepEqual([r.start, r.end], ['2026-08-14', '2026-08-14']);
});

test('slash dates are month-first', () => {
  assert.equal(q('8/14').start, '2026-08-14');
  assert.equal(q('12/25/26').start, '2026-12-25');
  assert.equal(q('12/25/2027').start, '2027-12-25');
});

test('month names, either way round, long or short', () => {
  assert.equal(q('aug 14').start, '2026-08-14');
  assert.equal(q('August 14').start, '2026-08-14');
  assert.equal(q('14 aug').start, '2026-08-14');
  assert.equal(q('sept 3').start, '2026-09-03');
  assert.equal(q('aug 14 2027').start, '2027-08-14');
});

test('a date with no year resolves to the nearest one', () => {
  // Typed in August, "jan 5" means the January coming up, not the one gone.
  assert.equal(q('jan 5').start, '2027-01-05');
  // But something just behind us stays behind us.
  assert.equal(q('aug 1').start, '2026-08-01');
});

test('weekdays resolve forward', () => {
  // 2026-08-04 is a Tuesday.
  assert.equal(q('friday').start, '2026-08-07');
  assert.equal(q('monday').start, '2026-08-10');
  // Tuesday is today, so plain "tuesday" is today and "next tuesday" is a week on.
  assert.equal(q('tuesday').start, '2026-08-04');
  assert.equal(q('next tuesday').start, '2026-08-11');
});

test('impossible dates are rejected rather than rolled over', () => {
  assert.equal(q('2026-02-30'), null);
  assert.equal(q('13/40'), null);
  assert.equal(q('feb 31'), null);
});

/* -------------------------------------------------------------------- ranges */

test('ranges, however they are separated', () => {
  for (const s of ['aug 14 to aug 20', 'aug 14 - aug 20', 'aug 14..aug 20', 'aug 14 – aug 20']) {
    const r = q(s);
    assert.ok(r, `failed to parse: ${s}`);
    assert.deepEqual([r.start, r.end], ['2026-08-14', '2026-08-20'], s);
  }
});

test('a backwards range is put the right way round', () => {
  const r = q('aug 20 to aug 14');
  assert.deepEqual([r.start, r.end], ['2026-08-14', '2026-08-20']);
});

test('ISO ranges', () => {
  const r = q('2026-08-14 to 2026-08-20');
  assert.deepEqual([r.start, r.end], ['2026-08-14', '2026-08-20']);
});

/* -------------------------------------------------------- months and periods */

test('a bare month covers that whole month', () => {
  const r = q('september');
  assert.deepEqual([r.start, r.end], ['2026-09-01', '2026-09-30']);
  assert.equal(r.label, 'September 2026');
});

test('a month with a year', () => {
  const r = q('feb 2028');
  assert.deepEqual([r.start, r.end], ['2028-02-01', '2028-02-29']);
});

test('this week starts on the Sunday', () => {
  const r = q('this week');
  assert.deepEqual([r.start, r.end], ['2026-08-02', '2026-08-08']);
});

test('next week is the one after', () => {
  const r = q('next week');
  assert.deepEqual([r.start, r.end], ['2026-08-09', '2026-08-15']);
});

test('this month', () => {
  const r = q('this month');
  assert.deepEqual([r.start, r.end], ['2026-08-01', '2026-08-31']);
});
