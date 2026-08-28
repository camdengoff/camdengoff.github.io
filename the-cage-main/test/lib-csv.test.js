import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, sniffDelimiter, buildIndex, norm, toDate } from '../scripts/lib-csv.js';

test('sniffDelimiter picks the separator actually used', () => {
  assert.equal(sniffDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3'), '\t');
});

test('sniffDelimiter ignores separators inside quoted headers', () => {
  // A quoted comma in the header must not outvote the real semicolons.
  assert.equal(sniffDelimiter('"Name, full";"Category";"Brand"\n"x";"y";"z"'), ';');
});

test('sniffDelimiter defaults to comma when there is nothing to go on', () => {
  assert.equal(sniffDelimiter('OneColumn\nvalue'), ',');
});

test('parseCsv reads a semicolon-delimited export without being told', () => {
  const rows = parseCsv('"Name";"Category"\n"C400";"Cameras"');
  assert.deepEqual(rows, [['Name', 'Category'], ['C400', 'Cameras']]);
});

test('parseCsv keeps newlines inside a quoted field', () => {
  // Cheqroom puts whole paragraphs in the description column.
  const rows = parseCsv('"Name";"Description"\n"Kit";"line one\nline two"');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'line one\nline two');
});

test('parseCsv handles escaped quotes, including in a name', () => {
  const rows = parseCsv('"Name";"Brand"\n"10"" iPad";"Apple"');
  assert.equal(rows[1][0], '10" iPad');
});

test('parseCsv still reads plain comma files', () => {
  const rows = parseCsv('Name,Category\nC400,Cameras');
  assert.deepEqual(rows, [['Name', 'Category'], ['C400', 'Cameras']]);
});

test('parseCsv respects an explicit delimiter over the sniff', () => {
  const rows = parseCsv('a;b\n1;2', ',');
  assert.deepEqual(rows, [['a;b'], ['1;2']]);
});

test('buildIndex prefers an exact header match over a substring one', () => {
  // "Kind" must not win the category slot when a real "Category" exists.
  const header = ['Name', 'Category', 'Kind', 'Brand'];
  const idx = buildIndex(header, {
    category: ['category', 'kind', 'type'],
    name: ['name'],
    brand: ['brand']
  });
  assert.equal(header[idx.category], 'Category');
});

test('buildIndex will not map two fields to the same column', () => {
  const header = ['Code'];
  const idx = buildIndex(header, { code: ['code'], serial: ['code'] });
  assert.equal(idx.code, 0);
  assert.equal(idx.serial, undefined);
});

test('norm strips punctuation and case', () => {
  assert.equal(norm('Asset Tag'), 'assettag');
  assert.equal(norm('Serial number'), 'serialnumber');
});

test('toDate reads plain ISO dates, with or without a time', () => {
  assert.equal(toDate('2026-08-24'), '2026-08-24');
  assert.equal(toDate('2026-08-24T10:30:00'), '2026-08-24');
});

test('toDate reads M/D/Y, falling back to D/M/Y only when M/D is impossible', () => {
  assert.equal(toDate('8/24/2026'), '2026-08-24');
  assert.equal(toDate('24/8/2026'), '2026-08-24');   // 24 can't be a month
  assert.equal(toDate('8/24/26'), '2026-08-24');      // 2-digit year
});

test('toDate rejects a numeric date where neither reading is valid', () => {
  assert.equal(toDate('13/32/2026'), null);
});

/* A real Cheqroom export mangles "M/D/YYYY H:MM:SS" into
   "YYYY-MM-MM/DD/YY HH:MM:SS" — the day slot in the ISO-looking prefix is
   always the month repeated, and the real day is hidden after the first
   slash. Confirmed against 10,000+ rows of a real export with zero
   exceptions to the "fake day equals month" rule. */
test('toDate unscrambles the "YYYY-MM-MM/DD/YY" Cheqroom export corruption', () => {
  // Real case: the fake day (10) reads as a plausible date on its own,
  // which is exactly why this needs its own check ahead of the plain ISO
  // regex — a naive parse would confidently return the wrong day.
  assert.equal(toDate('2026-10-10/06/26 10:30:00'), '2026-10-06');
  assert.equal(toDate('2018-03-03/13/18 00:00:00'), '2018-03-13');
  assert.equal(toDate('2022-08-08/22/22 09:30:00'), '2022-08-22');
});

test('toDate leaves a genuine plain ISO date alone even when day equals month', () => {
  // Nothing after it that looks like the corruption's "/DD/YY" suffix, so
  // this must NOT be treated as scrambled.
  assert.equal(toDate('2026-10-10'), '2026-10-10');
});

test('toDate returns null for empty or unparseable input', () => {
  assert.equal(toDate(''), null);
  assert.equal(toDate(null), null);
  assert.equal(toDate('not a date'), null);
});
