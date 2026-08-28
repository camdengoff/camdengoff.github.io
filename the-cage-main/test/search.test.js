import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, editDistance, isSubsequence, scoreItem, searchItems, searchKits, baseName, interchangeable, swapCandidates, searchReservations, isUnmetDemand
} from '../public/search.js';

/* A slice of a real cage, including the near-misses that make ranking matter:
   two Sigmas, two Canon RF zooms, and a Canon body. */
const GEAR = [
  { id: 1,  code: 'LC-101', name: 'PYXIS 6K',            category: 'Camera',     brand: 'Blackmagic', model: 'PYXIS 6K',            serial: '' },
  { id: 2,  code: 'LC-102', name: 'C400',                category: 'Camera',     brand: 'Canon',      model: 'EOS C400',            serial: 'SN99321' },
  { id: 3,  code: 'LC-103', name: 'C80',                 category: 'Camera',     brand: 'Canon',      model: 'EOS C80',             serial: '' },
  { id: 4,  code: 'LC-110', name: 'Sigma 18-35 f1.8',    category: 'Lens',       brand: 'Sigma',      model: '18-35mm f/1.8 DC HSM', serial: '' },
  { id: 5,  code: 'LC-111', name: 'Sigma 50-100 f1.8',   category: 'Lens',       brand: 'Sigma',      model: '50-100mm f/1.8 DC HSM', serial: '' },
  { id: 6,  code: 'LC-112', name: 'Canon RF 24-70 f2.8', category: 'Lens',       brand: 'Canon',      model: 'RF 24-70mm f/2.8L',   serial: '' },
  { id: 7,  code: 'LC-113', name: 'Canon RF 70-200 f2.8',category: 'Lens',       brand: 'Canon',      model: 'RF 70-200mm f/2.8L',  serial: '' },
  { id: 8,  code: 'LC-130', name: 'MixPre-10 II',        category: 'Audio',      brand: 'Sound Devices', model: 'MixPre-10 II',     serial: '' },
  { id: 9,  code: 'LC-131', name: 'Sennheiser MKH 416',  category: 'Audio',      brand: 'Sennheiser', model: 'MKH 416',             serial: '' },
  { id: 10, code: 'LC-120', name: 'Astera Titan Tube (x4)', category: 'Lighting',brand: 'Astera',     model: 'Titan Tube',          serial: '' },
  { id: 11, code: 'LC-140', name: 'Sachtler FSB 8',      category: 'Support',    brand: 'Sachtler',   model: 'FSB 8 Fluid Head',    serial: '' }
];

const names = list => list.map(i => i.name);
const find = q => searchItems(GEAR, q);

/* ------------------------------------------------------------- primitives */

test('normalize folds case and treats punctuation as a word break', () => {
  assert.equal(normalize('Sigma 18-35 f1.8'), 'sigma 18 35 f1 8');
  assert.equal(normalize('  MixPre-10  II '), 'mixpre 10 ii');
  assert.equal(normalize(null), '');
});

test('editDistance gives up once it passes the threshold', () => {
  assert.equal(editDistance('camera', 'camera'), 0);
  assert.equal(editDistance('camra', 'camera'), 1);
  assert.equal(editDistance('sigmma', 'sigma'), 1);
  // Wildly different strings report max+1 rather than the true distance.
  assert.equal(editDistance('camera', 'tripod', 2), 3);
});

test('isSubsequence wants the characters in order', () => {
  assert.ok(isSubsequence('mxpre', 'mixpre'));
  assert.ok(!isSubsequence('erpxm', 'mixpre'));
});

/* ------------------------------------------------------ the searches people run */

test('an empty query returns everything, untouched', () => {
  assert.equal(searchItems(GEAR, '').length, GEAR.length);
  assert.equal(searchItems(GEAR, '   ').length, GEAR.length);
});

test('exact name match ranks first', () => {
  assert.equal(find('C400')[0].name, 'C400');
  assert.equal(find('PYXIS 6K')[0].name, 'PYXIS 6K');
});

test('finds gear by code', () => {
  assert.equal(find('LC-130')[0].name, 'MixPre-10 II');
  assert.equal(find('lc110')[0].name, 'Sigma 18-35 f1.8');
});

test('finds gear by serial', () => {
  assert.equal(find('SN99321')[0].name, 'C400');
});

test('typos still find the thing', () => {
  assert.equal(find('sigmma')[0].brand, 'Sigma');
  assert.equal(find('sachtlr')[0].name, 'Sachtler FSB 8');
  assert.equal(find('mixpre')[0].name, 'MixPre-10 II');
});

test('punctuation the user skipped is not required', () => {
  assert.equal(find('1835')[0].name, 'Sigma 18-35 f1.8');
  assert.equal(find('18-35')[0].name, 'Sigma 18-35 f1.8');
  assert.equal(find('mixpre10')[0].name, 'MixPre-10 II');
});

test('brand and name can each hold half the query', () => {
  // "Canon" is the brand, "24-70" is in the name.
  assert.equal(find('canon 24-70')[0].name, 'Canon RF 24-70 f2.8');
  assert.equal(find('sigma 50')[0].name, 'Sigma 50-100 f1.8');
});

test('every token has to land, so extra words narrow rather than widen', () => {
  const canon = find('canon');
  assert.ok(canon.length >= 4, 'brand match should pull in every Canon');

  // Adding a term that only one of them satisfies must narrow the result.
  const narrowed = find('canon 70-200');
  assert.equal(narrowed[0].name, 'Canon RF 70-200 f2.8');
  assert.ok(narrowed.length < canon.length);
});

test('searching a category finds that category', () => {
  const audio = names(find('audio'));
  assert.ok(audio.includes('MixPre-10 II'));
  assert.ok(audio.includes('Sennheiser MKH 416'));
  assert.ok(!audio.includes('C400'));
});

test('nonsense matches nothing, rather than everything', () => {
  assert.deepEqual(find('zzzzqqq'), []);
  assert.deepEqual(find('helicopter'), []);
});

test('a single letter does not match the whole cage', () => {
  // Loose matching on very short tokens would rank everything equally and
  // make the list useless. Whatever comes back must be a real prefix hit.
  const hits = find('c');
  assert.ok(hits.length < GEAR.length);
});

test('ranking prefers the closer of two similar names', () => {
  const hits = find('sigma 18');
  assert.equal(hits[0].name, 'Sigma 18-35 f1.8');
});

test('scoreItem is zero when nothing matches and positive when it does', () => {
  assert.equal(scoreItem(GEAR[0], 'helicopter'), 0);
  assert.ok(scoreItem(GEAR[0], 'pyxis') > 0);
});

test('a whole-field match is not masked by a weaker per-word one', () => {
  // "lc110" is exactly the code with its punctuation dropped. It is also
  // within two edits of the word "110", and that weaker reading used to win
  // and push the item under the cutoff, so searching a code found nothing.
  const hits = find('lc110');
  assert.equal(hits[0]?.code, 'LC-110');
  assert.equal(find('LC-130')[0].code, 'LC-130');
  assert.equal(find('lc-112')[0].code, 'LC-112');
});

test('loose matching does not drown the real hit in a big inventory', () => {
  // Built from the shape of the real export: many similar names, one obvious
  // answer. Subsequence matching alone must not qualify an item.
  const big = Array.from({ length: 200 }, (_, i) => ({
    id: 1000 + i, code: `LC-${900 + i}`, name: `Accessory Plate ${i}`,
    category: 'Accessories', brand: 'Generic', model: `AP-${i}`, serial: ''
  })).concat(GEAR);

  const hits = searchItems(big, 'aputre');   // typo for a brand nothing else shares
  assert.equal(hits.length, 0, 'no Aputure in this fixture, so nothing should match');

  const real = searchItems(big, 'mixpre');
  assert.equal(real[0].name, 'MixPre-10 II');
  assert.ok(real.length < 20, `a specific query should stay tight, got ${real.length}`);
});

/* --------------------------------------------------------------- kit search */

const KKITS = [
  { id: 1, name: 'Interview Kit', notes: 'Two-person sit-down', item_ids: [1, 2] },
  { id: 2, name: 'Run & Gun', notes: '', item_ids: [3] },
  { id: 3, name: 'Doc Package', notes: 'Long days, bring spares', item_ids: [4] }
];
const KGEAR = {
  1: { id: 1, name: 'Sennheiser MKH 416', category: 'Audio', brand: 'Sennheiser', code: 'LC-140' },
  2: { id: 2, name: 'C70', category: 'Cameras', brand: 'Canon', code: 'LC-102' },
  3: { id: 3, name: 'Sigma 18-35', category: 'Lenses', brand: 'Sigma', code: 'LC-132' },
  4: { id: 4, name: 'FX3', category: 'Cameras', brand: 'Sony', code: 'LC-101' }
};
const kItemsFor = k => k.item_ids.map(i => KGEAR[i]);

test('an empty kit query returns everything untouched', () => {
  assert.deepEqual(searchKits(KKITS, '', { itemsFor: kItemsFor }), KKITS);
  assert.deepEqual(searchKits(KKITS, '   ', { itemsFor: kItemsFor }), KKITS);
});

test('kits match on their own name', () => {
  const hits = searchKits(KKITS, 'interview', { itemsFor: kItemsFor });
  assert.equal(hits[0].name, 'Interview Kit');
});

/* Looking for "the kit with the Sigma in it" is at least as common as
   remembering what you called it. */
test('kits match on the gear inside them', () => {
  const hits = searchKits(KKITS, 'sigma', { itemsFor: kItemsFor });
  assert.deepEqual(hits.map(k => k.name), ['Run & Gun']);
});

test('kits match on their notes', () => {
  const hits = searchKits(KKITS, 'spares', { itemsFor: kItemsFor });
  assert.deepEqual(hits.map(k => k.name), ['Doc Package']);
});

test('a kit named for the query outranks one merely containing it', () => {
  const kits = [
    { id: 1, name: 'B-roll bag', item_ids: [2] },        // contains a Canon
    { id: 2, name: 'Canon day kit', item_ids: [4] }      // named Canon
  ];
  const hits = searchKits(kits, 'canon', { itemsFor: k => k.item_ids.map(i => KGEAR[i]) });
  assert.equal(hits[0].name, 'Canon day kit');
});

test('the forgiving matching carries over to kits', () => {
  assert.deepEqual(searchKits(KKITS, 'sigmma', { itemsFor: kItemsFor }).map(k => k.name), ['Run & Gun']);
  assert.deepEqual(searchKits(KKITS, 'lc132', { itemsFor: kItemsFor }).map(k => k.name), ['Run & Gun']);
});

test('nonsense matches no kits', () => {
  assert.deepEqual(searchKits(KKITS, 'zzzzqqq', { itemsFor: kItemsFor }), []);
});

test('kit search survives a kit whose gear is missing', () => {
  const orphan = [{ id: 9, name: 'Old kit', item_ids: [99] }];
  assert.doesNotThrow(() => searchKits(orphan, 'old', { itemsFor: () => [] }));
  assert.equal(searchKits(orphan, 'old', { itemsFor: () => [] }).length, 1);
});

/* ------------------------------------------------- interchangeable units */

const unit = (id, name, extra = {}) =>
  ({ id, name, code: `LC-${id}`, category: 'Grip', brand: 'Avenger', ...extra });

test('a trailing unit number is not part of what a thing is', () => {
  assert.equal(baseName('GAT C-Stand #4'), baseName('GAT C-Stand #7'));
  assert.equal(baseName('Arri Orbiter-7'), baseName('Arri Orbiter-2'));
  assert.equal(baseName('Avenger Turtle Base C-Stand Grip Arm Kit-10'),
               baseName('Avenger Turtle Base C-Stand Grip Arm Kit-3'));
  // Unnumbered duplicates are common too — eight identical batteries.
  assert.equal(baseName('Bebob A150 micro Battery'), baseName('Bebob A150 micro Battery'));
});

/* The whole reason for the cap. Without it "Sigma 18-35" reduces to "Sigma 18"
   and an 18-50 gets offered as an identical spare. */
test('a focal length is not mistaken for a unit number', () => {
  assert.notEqual(baseName('Sigma 18-35'), baseName('Sigma 18-50'));
  assert.equal(baseName('Sigma 18-35'), 'sigma 18 35');
  assert.notEqual(baseName('Canon RF 70-200'), baseName('Canon RF 70-24'));
});

test('the cap still allows realistic unit counts', () => {
  assert.equal(baseName('Thing-30'), 'thing');
  assert.equal(baseName('Thing-31'), 'thing 31');
});

test('gear is interchangeable only within its own category', () => {
  const a = unit(1, 'C-Stand-1');
  const b = unit(2, 'C-Stand-2');
  assert.equal(interchangeable(a, b), true);
  assert.equal(interchangeable(a, unit(3, 'C-Stand-3', { category: 'Lighting' })), false);
});

test('different brands are never interchangeable, but a missing brand is not a mismatch', () => {
  const a = unit(1, 'C-Stand-1', { brand: 'Avenger' });
  assert.equal(interchangeable(a, unit(2, 'C-Stand-2', { brand: 'Matthews' })), false);
  assert.equal(interchangeable(a, unit(3, 'C-Stand-3', { brand: '' })), true);
});

test('an item is never a swap for itself, and retired gear is never offered', () => {
  const a = unit(1, 'C-Stand-1');
  assert.equal(interchangeable(a, a), false);
  assert.equal(interchangeable(a, unit(2, 'C-Stand-2', { retired: true })), false);
});

/* Models in a real export contradict each other — the same lens appears as
   "RF 15-35" and "RF 15-35mm f/2.8 L" — so matching is name-led. */
test('inconsistent model strings do not block a genuine spare', () => {
  const a = unit(1, 'Canon RF 15-35mm f/2.8-1', { brand: 'Canon', category: 'Lenses', model: 'RF 15-35' });
  const b = unit(2, 'Canon RF 15-35mm f/2.8-2', { brand: 'Canon', category: 'Lenses', model: 'RF 15-35mm f/2.8 L' });
  assert.equal(interchangeable(a, b), true);
});

test('only free spares are suggested', () => {
  const target = unit(1, 'C-Stand-1');
  const pool = [target, unit(2, 'C-Stand-2'), unit(3, 'C-Stand-3'), unit(4, 'Apple Box-1')];
  const free = new Set([3]);
  const hits = swapCandidates(target, pool, { isFree: i => free.has(i.id) });
  assert.deepEqual(hits.map(i => i.id), [3]);
});

test('an identical name outranks a same-family sibling', () => {
  const target = unit(1, 'C-Stand', { brand: '' });
  const pool = [unit(2, 'C-Stand-4', { brand: '' }), unit(3, 'C-Stand', { brand: '' })];
  const hits = swapCandidates(target, pool, {});
  assert.equal(hits[0].id, 3);
});

test('suggestions are ordered by unit number, not by string sort', () => {
  const target = unit(1, 'C-Stand-1');
  const pool = [unit(2, 'C-Stand-10'), unit(3, 'C-Stand-2'), unit(4, 'C-Stand-3')];
  const hits = swapCandidates(target, pool, { limit: 3 });
  assert.deepEqual(hits.map(i => i.name), ['C-Stand-2', 'C-Stand-3', 'C-Stand-10']);
});

test('nothing similar means no suggestion, not a bad one', () => {
  const target = unit(1, 'C-Stand-1');
  assert.deepEqual(swapCandidates(target, [unit(2, 'Sandbag-1')], {}), []);
  assert.deepEqual(swapCandidates(null, [unit(2, 'C-Stand-2')], {}), []);
});

test('the number of suggestions is capped', () => {
  const target = unit(1, 'C-Stand-1');
  const pool = Array.from({ length: 9 }, (_, n) => unit(n + 2, `C-Stand-${n + 2}`));
  assert.equal(swapCandidates(target, pool, { limit: 3 }).length, 3);
});

test('isUnmetDemand: a free sibling means the demand was met, not missed', () => {
  const target = unit(1, 'C-Stand-1');
  const pool = [target, unit(2, 'C-Stand-2')];
  assert.equal(isUnmetDemand(target, pool, { hasConflict: () => false }), false);
});

test('isUnmetDemand: no sibling at all, or every one conflicted, counts as missed', () => {
  const target = unit(1, 'C-Stand-1');
  assert.equal(isUnmetDemand(target, [target, unit(2, 'Sandbag-1')], {}), true, 'nothing interchangeable exists');
  const pool = [target, unit(2, 'C-Stand-2')];
  assert.equal(isUnmetDemand(target, pool, { hasConflict: () => true }), true, 'the only sibling was also busy');
});

/* ---------------------------------------------------- reservation search */

const RGEAR = {
  1: { id: 1, name: 'Arri Orbiter-3', category: 'Lighting', brand: 'Arri', code: 'LC-901' },
  2: { id: 2, name: 'Canon C300-2', category: 'Cameras', brand: 'Canon', code: 'LC-902' }
};
const RES = [
  { id: 1, person_name: 'Ryan Burnett', person_email: 'ryan.burnett@life.church',
    project: 'PKR Launch', start_on: '2026-09-30', end_on: '2026-10-08', item_ids: [1] },
  { id: 2, person_name: 'Camden Goff', person_email: 'camden.goff@life.church',
    project: 'Weekend service', start_on: '2026-08-06', end_on: '2026-08-09', item_ids: [2] }
];
const rItemsFor = r => r.item_ids.map(i => RGEAR[i]);

test('an empty reservation query returns everything untouched', () => {
  assert.deepEqual(searchReservations(RES, '', { itemsFor: rItemsFor }), RES);
});

test('reservations match on who booked them', () => {
  assert.deepEqual(searchReservations(RES, 'camden', { itemsFor: rItemsFor }).map(r => r.id), [2]);
  assert.deepEqual(searchReservations(RES, 'burnett', { itemsFor: rItemsFor }).map(r => r.id), [1]);
});

test('reservations match on email, so a part-remembered address lands', () => {
  assert.deepEqual(searchReservations(RES, 'camden.goff', { itemsFor: rItemsFor }).map(r => r.id), [2]);
});

test('reservations match on the project', () => {
  assert.deepEqual(searchReservations(RES, 'pkr', { itemsFor: rItemsFor }).map(r => r.id), [1]);
});

/* Searching a booking by a piece of kit on it is much of the point. */
test('reservations match on the gear they hold', () => {
  assert.deepEqual(searchReservations(RES, 'orbiter', { itemsFor: rItemsFor }).map(r => r.id), [1]);
  assert.deepEqual(searchReservations(RES, 'c300', { itemsFor: rItemsFor }).map(r => r.id), [2]);
});

test('the forgiving matching carries over to reservations', () => {
  assert.deepEqual(searchReservations(RES, 'orbitter', { itemsFor: rItemsFor }).map(r => r.id), [1]);
});

test('nonsense matches no reservations', () => {
  assert.deepEqual(searchReservations(RES, 'zzzqqq', { itemsFor: rItemsFor }), []);
});

test('reservation search survives gear that no longer exists', () => {
  const orphan = [{ id: 9, person_name: 'Jo', project: 'Old', item_ids: [99] }];
  assert.equal(searchReservations(orphan, 'jo', { itemsFor: () => [] }).length, 1);
});
