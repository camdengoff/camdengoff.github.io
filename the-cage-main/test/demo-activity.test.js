import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateActivity, CREW } from '../public/demo-activity.js';
import { evaluateCheckout } from '../src/policy.js';

const TODAY = '2026-08-05';

/* An inventory shaped like the real one: the same categories, enough depth in
   each that the allocator has somewhere to go. */
const ITEMS = [];
let nextId = 1;
for (const [category, n] of Object.entries({
  Cameras: 31, Lenses: 80, Lighting: 144, Audio: 31,
  Stands: 43, 'Camera Stabilization': 39, Accessories: 89, Laptops: 2
})) {
  for (let i = 0; i < n; i++) {
    ITEMS.push({
      id: nextId, code: `LC-${1000 + nextId}`, name: `${category} ${i + 1}`,
      category, brand: 'Brand', model: 'Model', serial: '', retired: false
    });
    nextId++;
  }
}

const sim = () => simulateActivity({ items: ITEMS, today: TODAY });
const overlaps = (aS, aE, bS, bE) => aS <= bE && bS <= aE;

test('produces a cage that looks used', () => {
  const { people, checkouts, reservations, maintenance, kits } = sim();
  assert.ok(people.length > 5, 'needs a crew, not one person');
  assert.ok(checkouts.filter(c => !c.returned_at).length >= 10, 'enough out to fill a board');
  assert.ok(checkouts.some(c => c.returned_at), 'some history to look back at');
  assert.ok(reservations.length >= 8, 'holds on the books');
  assert.ok(maintenance.length >= 3, 'a repair queue');
  assert.ok(kits.length >= 3, 'some saved kits');
});

test('every state the board can show is present', () => {
  const { checkouts } = sim();
  const open = checkouts.filter(c => !c.returned_at);
  assert.ok(open.some(c => c.due_on < TODAY), 'something overdue');
  assert.ok(open.some(c => c.due_on === TODAY), 'something due today');
  assert.ok(open.some(c => c.due_on > TODAY), 'something due later');
  assert.ok(checkouts.some(c => c.returned_at), 'something already back');
});

test('nothing is in two places at once', () => {
  // The whole point of the allocator. An impossible state would make the demo
  // look broken rather than busy, and policy.js would reject it.
  const { checkouts, reservations } = sim();
  const spans = [];

  for (const c of checkouts) {
    const end = c.returned_at
      ? String(c.returned_at).slice(0, 10)
      : (c.due_on < TODAY ? TODAY : c.due_on);
    for (const id of c.item_ids) spans.push({ id, start: c.out_at, end, what: `checkout ${c.id}` });
  }
  for (const r of reservations) {
    for (const id of r.item_ids) spans.push({ id, start: r.start_on, end: r.end_on, what: `hold ${r.id}` });
  }

  const byItem = new Map();
  for (const s of spans) {
    for (const other of byItem.get(s.id) || []) {
      assert.ok(!overlaps(s.start, s.end, other.start, other.end),
        `item ${s.id} is on both ${s.what} (${s.start}→${s.end}) and ${other.what} (${other.start}→${other.end})`);
    }
    byItem.set(s.id, [...(byItem.get(s.id) || []), s]);
  }
});

test('gear that is down for repair is not also out', () => {
  const { checkouts, maintenance } = sim();
  const outNow = new Set(checkouts.filter(c => !c.returned_at).flatMap(c => c.item_ids));
  for (const m of maintenance.filter(x => !x.closed_on)) {
    assert.ok(!outNow.has(m.item_id), `item ${m.item_id} is both out and in for repair`);
  }
});

test('dates are coherent', () => {
  const { checkouts, reservations, maintenance } = sim();
  for (const c of checkouts) {
    assert.ok(c.due_on >= c.out_at, `checkout ${c.id} is due before it went out`);
    if (c.returned_at) {
      assert.ok(String(c.returned_at).slice(0, 10) >= c.out_at, `checkout ${c.id} came back before it left`);
      assert.ok(String(c.returned_at).slice(0, 10) < TODAY, `checkout ${c.id} is "returned" in the future`);
    }
  }
  for (const r of reservations) {
    assert.ok(r.end_on >= r.start_on, `hold ${r.id} ends before it starts`);
    assert.ok(r.end_on >= TODAY, `hold ${r.id} is entirely in the past`);
  }
  for (const m of maintenance) {
    assert.ok(m.opened_on <= TODAY, `ticket ${m.id} was opened in the future`);
    if (m.closed_on) assert.ok(m.closed_on >= m.opened_on, `ticket ${m.id} closed before it opened`);
  }
});

test('every booking has gear and a real person on it', () => {
  const { people, checkouts, reservations } = sim();
  const ids = new Set(people.map(p => p.id));
  const itemIds = new Set(ITEMS.map(i => i.id));

  for (const c of checkouts) {
    assert.ok(c.item_ids.length, `checkout ${c.id} has no gear`);
    assert.ok(ids.has(c.holder_id), `checkout ${c.id} has an unknown holder`);
    c.item_ids.forEach(i => assert.ok(itemIds.has(i), `checkout ${c.id} references a missing item`));
  }
  for (const r of reservations) {
    assert.ok(r.item_ids.length, `hold ${r.id} has no gear`);
    assert.ok(ids.has(r.person_id), `hold ${r.id} has an unknown person`);
  }
});

test('the rules engine accepts the state it generates', () => {
  // If policy.js would refuse to believe this cage, the demo is lying.
  const { checkouts, reservations, maintenance, people } = sim();
  const ctx = {
    openCheckouts: checkouts.filter(c => !c.returned_at).map(c => ({
      id: c.id, holder_id: c.holder_id, due_on: c.due_on, out_at: c.out_at,
      holder_name: 'x', item_ids: c.item_ids
    })),
    reservations: reservations.map(r => ({
      id: r.id, person_id: r.person_id, start_on: r.start_on, end_on: r.end_on,
      person_name: 'x', item_ids: r.item_ids
    })),
    openMaintenance: maintenance.filter(m => !m.closed_on),
    settings: {}
  };

  // Something known to be free must be checkoutable.
  const busy = new Set([
    ...ctx.openCheckouts.flatMap(c => c.item_ids),
    ...ctx.reservations.flatMap(r => r.item_ids),
    ...ctx.openMaintenance.map(m => m.item_id)
  ]);
  const free = ITEMS.find(i => !busy.has(i.id));
  assert.ok(free, 'the simulation used the entire inventory, which is not realistic');

  const ok = evaluateCheckout({
    person: { id: 1, role: 'admin', blocked: false },
    items: [free], from: TODAY, due: '2026-08-08', ...ctx
  });
  assert.equal(ok.allowed, true, `free gear was blocked: ${JSON.stringify(ok.blocks)}`);

  // And something that is out must be refused.
  const takenId = ctx.openCheckouts[0].item_ids[0];
  const taken = ITEMS.find(i => i.id === takenId);
  const no = evaluateCheckout({
    person: { id: 999, role: 'member', blocked: false },
    items: [taken], from: TODAY, due: '2026-08-08', ...ctx
  });
  assert.equal(no.allowed, false, 'gear that is already out should be blocked');
});

test('the same day and inventory always give the same cage', () => {
  // Reproducibility matters: otherwise a bug someone reports can't be
  // reproduced on the other machine.
  const a = simulateActivity({ items: ITEMS, today: TODAY });
  const b = simulateActivity({ items: ITEMS, today: TODAY });
  assert.deepEqual(a.checkouts, b.checkouts);
  assert.deepEqual(a.reservations, b.reservations);

  const c = simulateActivity({ items: ITEMS, today: TODAY, seed: 99 });
  assert.notDeepEqual(a.checkouts, c.checkouts, 'a different seed should differ');
});

test('the crew are invented, not colleagues', () => {
  assert.ok(CREW.length >= 8);
  const { people } = sim();
  for (const p of people.filter(x => x.id !== 1)) {
    assert.match(p.email, /@example\.com$/, `${p.name} must not have a real-looking address`);
    assert.equal(p.placeholder, true);
  }
});
