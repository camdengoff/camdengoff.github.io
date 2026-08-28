import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeKit, decodeKit, kitPayloadFromHash, kitShareUrl, resolveKit,
  uniqueKitName, MAX_KIT_LINK_ITEMS
} from '../public/kitlink.js';

const kit = { name: 'Run & Gun', notes: 'Battery lives in the side pocket' };
const codes = ['LC-104', 'LC-110', 'LC-132'];

test('a kit survives the round trip intact', () => {
  const back = decodeKit(encodeKit(kit, codes, 'Alex Rivera'));
  assert.equal(back.name, 'Run & Gun');
  assert.equal(back.notes, 'Battery lives in the side pocket');
  assert.equal(back.from, 'Alex Rivera');
  assert.deepEqual(back.codes, codes);
});

test('names with accents and emoji survive', () => {
  const back = decodeKit(encodeKit({ name: 'Café 📷 rig' }, ['LC-1']));
  assert.equal(back.name, 'Café 📷 rig');
});

/* '+' and '/' get mangled in URLs and by messaging apps that "helpfully" fix
   links, and '=' padding confuses hash parsing. */
test('the payload is URL-safe and unpadded', () => {
  const payload = encodeKit({ name: 'A'.repeat(40) }, ['LC-1', 'LC-2']);
  assert.match(payload, /^[A-Za-z0-9\-_]+$/);
});

test('a link carries codes, not ids, so it survives crossing databases', () => {
  const url = kitShareUrl('https://cage.example.com/', kit, codes, 'Alex');
  const back = decodeKit(kitPayloadFromHash(url));
  assert.deepEqual(back.codes, codes);
  assert.ok(!/\bid\b/.test(JSON.stringify(back)));
});

test('building a link strips any hash already on the page', () => {
  const url = kitShareUrl('https://cage.example.com/#kit=stale', kit, codes);
  assert.equal(url.match(/#/g).length, 1);
  assert.ok(url.startsWith('https://cage.example.com/#kit='));
});

test('the payload is found in a bare hash and in a full url', () => {
  const payload = encodeKit(kit, codes);
  assert.equal(kitPayloadFromHash(`#kit=${payload}`), payload);
  assert.equal(kitPayloadFromHash(`https://x.test/a/b?c=d#kit=${payload}`), payload);
  assert.equal(kitPayloadFromHash('#gear=123'), null);
  assert.equal(kitPayloadFromHash(''), null);
  assert.equal(kitPayloadFromHash(null), null);
});

/* This arrives from a text message, so it's untrusted: it either parses
   cleanly or it's ignored. Nothing here may throw. */
test('junk decodes to null rather than throwing', () => {
  for (const junk of ['', 'not-base64!!', 'YWJj', null, undefined, 42, {},
                      Buffer.from('{"v":1}').toString('base64url'),
                      Buffer.from('null').toString('base64url')]) {
    assert.equal(decodeKit(junk), null, `should reject ${String(junk)}`);
  }
});

test('a payload from a future format version is refused, not guessed at', () => {
  const future = Buffer.from(JSON.stringify({ v: 99, n: 'X', c: ['LC-1'] })).toString('base64url');
  assert.equal(decodeKit(future), null);
});

test('a kit with no gear is refused at both ends', () => {
  assert.throws(() => encodeKit(kit, []), /nothing to share/);
  const empty = Buffer.from(JSON.stringify({ v: 1, n: 'X', c: [] })).toString('base64url');
  assert.equal(decodeKit(empty), null);
});

test('duplicate codes collapse, so a link never double-counts', () => {
  const back = decodeKit(encodeKit(kit, ['LC-1', 'LC-1', 'LC-2']));
  assert.deepEqual(back.codes, ['LC-1', 'LC-2']);
});

/* Truncating would hand someone half a gear list and call it the kit. */
test('an oversized kit is refused rather than silently trimmed', () => {
  const many = Array.from({ length: MAX_KIT_LINK_ITEMS + 1 }, (_, i) => `LC-${i}`);
  assert.throws(() => encodeKit(kit, many), /Too much gear/);
});

test('unknown codes are reported, not quietly dropped', () => {
  const items = [
    { id: 1, code: 'LC-104', name: 'A7S III' },
    { id: 2, code: 'LC-132', name: 'Sigma 18-35' }
  ];
  const r = resolveKit(decodeKit(encodeKit(kit, codes)), items);
  assert.deepEqual(r.found.map(i => i.id), [1, 2]);
  assert.deepEqual(r.missing, ['LC-110']);
});

test('codes match regardless of case and stray spacing', () => {
  const items = [{ id: 1, code: 'LC-104', name: 'A7S III' }];
  const r = resolveKit({ name: 'K', codes: [' lc-104 '] }, items);
  assert.deepEqual(r.found.map(i => i.id), [1]);
  assert.deepEqual(r.missing, []);
});

test('a kit from a different inventory resolves to nothing, not to wrong gear', () => {
  const r = resolveKit(decodeKit(encodeKit(kit, codes)),
    [{ id: 9, code: 'ZZ-1', name: 'Something else' }]);
  assert.equal(r.found.length, 0);
  assert.equal(r.missing.length, 3);
});

test('saving the same link twice gives two kits you can tell apart', () => {
  assert.equal(uniqueKitName('Run & Gun', []), 'Run & Gun');
  assert.equal(uniqueKitName('Run & Gun', ['Run & Gun']), 'Run & Gun 2');
  assert.equal(uniqueKitName('Run & Gun', ['Run & Gun', 'Run & Gun 2']), 'Run & Gun 3');
  assert.equal(uniqueKitName('  ', ['Kit']), 'Kit 2');
});
