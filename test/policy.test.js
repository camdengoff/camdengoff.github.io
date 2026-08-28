import assert from 'node:assert/strict';
import {
  test } from 'node:test'; import {   evaluateCheckout, reservationConflicts, statusOf, shiftDays, kitVisibleTo, kitEditableBy, kitDeletableBy, duplicateKit, requestDecidableBy, requestCancellableBy, requestableItems, checkSwap, canAddGear, canManageContributors, contributorAddable,
  canRenameBooking, bookingLabels, bookingLabel
} from '../src/policy.js';

const S = {
  enforce_availability: 'true',
  enforce_reservations: 'true',
  block_overdue_borrowers: 'true',
  overdue_grace_days: '0'
};
const nick   = { id: 1, name: 'Alex Rivera', role: 'member', blocked: false };
const elijah = { id: 2, name: 'Priya Raman', role: 'member', blocked: false };
const boss   = { id: 3, name: 'Jordan', role: 'admin', blocked: false };
const ursa = { id: 10, code: 'LC-101', name: 'URSA Cine 12K LF', retired: false };
const c400 = { id: 11, code: 'LC-104', name: 'C400', retired: false };

const base = extra => ({
  person: nick, items: [ursa], from: '2026-08-10', due: '2026-08-13',
  openCheckouts: [], reservations: [], openMaintenance: [], settings: S, ...extra
});

test('clean checkout is allowed', () => {
  const r = evaluateCheckout(base());
  assert.equal(r.allowed, true);
  assert.equal(r.blocks.length, 0);
});

test('gear already out is blocked', () => {
  const r = evaluateCheckout(base({
    openCheckouts: [{ id: 5, holder_id: 2, holder_name: 'Priya Raman', due_on: '2026-08-20', item_ids: [10] }]
  }));
  assert.equal(r.allowed, false);
  assert.equal(r.blocks[0].code, 'already_out');
  assert.match(r.blocks[0].message, /Priya Raman/);
});

test('gear down for repair is blocked', () => {
  const r = evaluateCheckout(base({
    openMaintenance: [{ item_id: 10, kind: 'Repair', notes: 'pan lock stripped' }]
  }));
  assert.equal(r.allowed, false);
  assert.equal(r.blocks[0].code, 'in_repair');
});

test("someone else's hold blocks the window", () => {
  const r = evaluateCheckout(base({
    reservations: [{ id: 7, person_id: 2, person_name: 'Priya Raman', start_on: '2026-08-12', end_on: '2026-08-15', item_ids: [10] }]
  }));
  assert.equal(r.allowed, false);
  assert.equal(r.blocks[0].code, 'reserved');
});

test('a hold outside the window does not block', () => {
  const r = evaluateCheckout(base({
    reservations: [{ id: 7, person_id: 2, person_name: 'Priya Raman', start_on: '2026-09-01', end_on: '2026-09-04', item_ids: [10] }]
  }));
  assert.equal(r.allowed, true);
});

test('your own hold is collected, not blocked', () => {
  const r = evaluateCheckout(base({
    reservations: [{ id: 9, person_id: 1, person_name: 'Alex Rivera', start_on: '2026-08-10', end_on: '2026-08-13', item_ids: [10] }]
  }));
  assert.equal(r.allowed, true);
  assert.deepEqual(r.fulfils, [9]);
});

test('overdue borrower is blocked from taking more', () => {
  const r = evaluateCheckout(base({
    openCheckouts: [{ id: 4, holder_id: 1, holder_name: 'Alex Rivera', due_on: '2026-08-01', item_ids: [99] }]
  }));
  assert.equal(r.allowed, false);
  assert.equal(r.blocks[0].code, 'has_overdue');
});

test('grace days soften the overdue block', () => {
  const ctx = base({
    settings: { ...S, overdue_grace_days: '14' },
    openCheckouts: [{ id: 4, holder_id: 1, holder_name: 'Alex Rivera', due_on: '2026-08-01', item_ids: [99] }]
  });
  assert.equal(evaluateCheckout(ctx).allowed, true);
});

test('a manually blocked person is stopped with the reason', () => {
  const r = evaluateCheckout(base({
    person: { ...nick, blocked: true, blocked_reason: 'lost a lav twice' }
  }));
  assert.equal(r.allowed, false);
  assert.match(r.blocks[0].message, /lost a lav twice/);
});

test('admins can override a policy block, and it is recorded as a warning', () => {
  const r = evaluateCheckout(base({
    person: boss, override: true,
    openCheckouts: [{ id: 5, holder_id: 2, holder_name: 'Priya Raman', due_on: '2026-08-20', item_ids: [10] }]
  }));
  assert.equal(r.allowed, true);
  assert.equal(r.warnings[0].overridden, true);
});

test('non-admins cannot override', () => {
  const r = evaluateCheckout(base({
    person: elijah, override: true,
    openMaintenance: [{ item_id: 10, kind: 'Repair', notes: '' }]
  }));
  assert.equal(r.allowed, false);
});

test('bad dates survive an admin override', () => {
  const r = evaluateCheckout(base({ person: boss, override: true, from: '2026-08-20', due: '2026-08-10' }));
  assert.equal(r.allowed, false);
  assert.equal(r.blocks[0].code, 'bad_dates');
});

test('turning enforcement off downgrades blocks to warnings', () => {
  const r = evaluateCheckout(base({
    settings: { ...S, enforce_availability: 'false' },
    openMaintenance: [{ item_id: 10, kind: 'Repair', notes: '' }]
  }));
  assert.equal(r.allowed, true);
  assert.equal(r.warnings[0].code, 'in_repair');
});

test('every unavailable item is reported, not just the first', () => {
  const r = evaluateCheckout(base({
    items: [ursa, c400],
    openMaintenance: [{ item_id: 10, kind: 'Repair', notes: '' }],
    openCheckouts: [{ id: 5, holder_id: 2, holder_name: 'Priya Raman', due_on: '2026-08-20', item_ids: [11] }]
  }));
  assert.equal(r.blocks.length, 2);
});

test('statusOf derives the badge shown in the list', () => {
  const state = {
    today: '2026-08-10',
    openCheckouts: [{ id: 1, holder_id: 2, holder_name: 'E', due_on: '2026-08-05', item_ids: [11] }],
    openMaintenance: [{ item_id: 12, kind: 'Repair', notes: '' }],
    reservations: [{ id: 3, person_id: 2, person_name: 'E', start_on: '2026-08-09', end_on: '2026-08-11', item_ids: [13] }]
  };
  assert.equal(statusOf(10, state), 'ready');
  assert.equal(statusOf(11, state), 'overdue');
  assert.equal(statusOf(12, state), 'repair');
  assert.equal(statusOf(13, state), 'held');
});

test('reservation conflicts catch both holds and live checkouts', () => {
  const hits = reservationConflicts({
    itemIds: [10, 11], start: '2026-08-10', end: '2026-08-12',
    reservations: [{ id: 1, person_name: 'E', start_on: '2026-08-11', end_on: '2026-08-14', item_ids: [10] }],
    openCheckouts: [{ id: 2, holder_name: 'N', out_at: '2026-08-09', due_on: '2026-08-11', item_ids: [11] }]
  });
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map(h => h.kind), ['reservation', 'checkout']);
});

test('shiftDays crosses month boundaries', () => {
  assert.equal(shiftDays('2026-08-01', -1), '2026-07-31');
  assert.equal(shiftDays('2026-02-28', 1), '2026-03-01');
});


/* ------------------------------------------------------------- kit ownership */

const kOwner  = { id: 1, name: 'Alex Rivera', role: 'member' };
const kOther  = { id: 2, name: 'Priya Raman', role: 'member' };
const kBoss   = { id: 3, name: 'Marcus Webb', role: 'admin'  };

const kMine    = { id: 10, name: 'Run-and-gun', owner_id: 1, shared: false, item_ids: [10, 11] };
const kShared  = { id: 11, name: 'Podcast 2-cam', owner_id: 2, shared: true,  item_ids: [12] };
const kPrivate = { id: 12, name: 'Half-built', owner_id: 2, shared: false, item_ids: [13] };
const kLegacy  = { id: 13, name: 'Interview Kit', owner_id: null, shared: false, item_ids: [14] };
const kPhysical = { id: 14, name: 'Aputure B7C Kit', owner_id: null, shared: false, item_ids: [15], type: 'kit' };

test('a private kit is visible only to its owner', () => {
  assert.equal(kitVisibleTo(kPrivate, kOther), true);   // kOther is this kit's owner
  assert.equal(kitVisibleTo(kMine, kOther), false);
  assert.equal(kitVisibleTo(kMine, kOwner), true);
});

test('an admin does not get to see kOther people\'s private kits', () => {
  assert.equal(kitVisibleTo(kMine, kBoss), false);
  assert.equal(kitVisibleTo(kPrivate, kBoss), false);
});

test('sharing makes a kit visible to everyone', () => {
  assert.equal(kitVisibleTo(kShared, kOwner), true);
  assert.equal(kitVisibleTo(kShared, kBoss), true);
});

/* Kits predate ownership. A null owner means the old global list, which
   belongs to the team — if these were hidden the existing kits would vanish
   the moment this shipped. */
test('an ownerless kit belongs to the team and stays visible', () => {
  assert.equal(kitVisibleTo(kLegacy, kOwner), true);
  assert.equal(kitVisibleTo(kLegacy, kOther), true);
  assert.equal(kitVisibleTo(kLegacy, kBoss), true);
});

test('only the owner can edit, sharing does not grant write access', () => {
  assert.equal(kitEditableBy(kMine, kOwner), true);
  assert.equal(kitEditableBy(kShared, kOwner), false, 'seeing a shared kit is not editing it');
  assert.equal(kitEditableBy(kShared, kOther), true);
});

test('an admin cannot rewrite someone else\'s kit, but can maintain ownerless ones', () => {
  assert.equal(kitEditableBy(kShared, kBoss), false);
  assert.equal(kitEditableBy(kPrivate, kBoss), false);
  assert.equal(kitEditableBy(kLegacy, kBoss), true);
  assert.equal(kitEditableBy(kLegacy, kOwner), false, 'a member cannot edit the team list');
});

test('admins can delete clutter they can see, but not what they cannot', () => {
  assert.equal(kitDeletableBy(kShared, kBoss), true);
  assert.equal(kitDeletableBy(kMine, kBoss), false, 'invisible means undeletable');
  assert.equal(kitDeletableBy(kShared, kOwner), false, 'a member cannot delete a colleague\'s kit');
  assert.equal(kitDeletableBy(kMine, kOwner), true);
});

test('a duplicate is yours, private, and named clear of your existing kits', () => {
  const copy = duplicateKit(kShared, kOwner, []);
  assert.equal(copy.name, 'Podcast 2-cam copy');
  assert.equal(copy.owner_id, kOwner.id);
  assert.equal(copy.shared, false, 'publishing is a separate decision');
  assert.deepEqual(copy.item_ids, [12]);
  assert.equal(copy.type, 'package');
});

test('duplicating a physical kit still makes a package — a copy always has an owner', () => {
  const copy = duplicateKit(kPhysical, kOwner, []);
  assert.equal(copy.type, 'package', 'there is no ownerless reading of "your copy of the case"');
  assert.equal(copy.owner_id, kOwner.id);
});

test('duplicating twice does not collide', () => {
  const first = duplicateKit(kShared, kOwner, []);
  const second = duplicateKit(kShared, kOwner, [first.name]);
  const third = duplicateKit(kShared, kOwner, [first.name, second.name]);
  assert.deepEqual([first.name, second.name, third.name],
    ['Podcast 2-cam copy', 'Podcast 2-cam copy 2', 'Podcast 2-cam copy 3']);
});

test('a duplicate takes the gear, not a reference to it', () => {
  const source = { name: 'K', owner_id: 2, item_ids: [1, 2, 2, 3] };
  const copy = duplicateKit(source, kOwner, []);
  assert.deepEqual(copy.item_ids, [1, 2, 3], 'de-duplicated');
  copy.item_ids.push(99);
  assert.deepEqual(source.item_ids, [1, 2, 2, 3], 'source untouched');
});

test('nobody sees or edits anything when the person is missing', () => {
  assert.equal(kitVisibleTo(kShared, null), false);
  assert.equal(kitEditableBy(kLegacy, null), false);
  assert.equal(kitDeletableBy(kShared, null), false);
});

/* ------------------------------------------------------------ gear requests */

const rqOwner = { id: 1, name: 'Ryan Burnett', role: 'member' };
const rqAsker = { id: 2, name: 'Camden Goff', role: 'member' };
const rqBoss  = { id: 3, name: 'Jordan West', role: 'admin' };
const pending = { id: 10, requester_id: 2, holder_id: 1, state: 'pending', item_ids: [5] };

test('the holder decides a request about their own loan', () => {
  assert.equal(requestDecidableBy(pending, rqOwner), true);
});

/* Someone has to unblock a request when the holder is on a shoot. */
test('an admin can decide as well', () => {
  assert.equal(requestDecidableBy(pending, rqBoss), true);
});

/* Approving your own request is just taking the gear, which is the thing the
   request exists to avoid. */
test('the person who asked cannot approve their own request', () => {
  assert.equal(requestDecidableBy(pending, rqAsker), false);
});

test('an admin who asked can still act, because they could have just taken it', () => {
  const mine = { ...pending, requester_id: rqBoss.id };
  assert.equal(requestDecidableBy(mine, rqBoss), true);
});

test('an unrelated person decides nothing', () => {
  assert.equal(requestDecidableBy(pending, { id: 9, role: 'member' }), false);
});

test('a request that has already been decided is closed to everyone', () => {
  for (const state of ['approved', 'declined', 'cancelled']) {
    assert.equal(requestDecidableBy({ ...pending, state }, rqOwner), false, state);
    assert.equal(requestDecidableBy({ ...pending, state }, rqBoss), false, state);
    assert.equal(requestCancellableBy({ ...pending, state }, rqAsker), false, state);
  }
});

test('you can withdraw what you asked for; the holder cannot withdraw it for you', () => {
  assert.equal(requestCancellableBy(pending, rqAsker), true);
  assert.equal(requestCancellableBy(pending, rqOwner), false);
  assert.equal(requestCancellableBy(pending, rqBoss), true, 'an admin can clear the queue');
});

test('missing arguments decide nothing rather than throwing', () => {
  assert.equal(requestDecidableBy(null, rqOwner), false);
  assert.equal(requestDecidableBy(pending, null), false);
  assert.equal(requestCancellableBy(null, null), false);
});

/* Asking for gear that's already on the booking is a no-op that would produce
   an approvable request which changes nothing. */
test('gear already on the booking is not requestable', () => {
  assert.deepEqual(requestableItems([1, 2, 3], [2]), [1, 3]);
  assert.deepEqual(requestableItems([1, 1, 2], []), [1, 2], 'de-duplicated');
  assert.deepEqual(requestableItems([1, 2], [1, 2]), []);
});

test('requestable items reject junk the same way the cart does', () => {
  assert.deepEqual(requestableItems([1, null, 'x', 0, -3, 2.5, 2], []), [1, 2]);
  assert.deepEqual(requestableItems(null, []), []);
});

/* -------------------------------------------------------------- swap offers */

const swapBase = { theirItems: [10, 11, 12], myItems: [20, 21] };

test('a straight trade is allowed', () => {
  const r = checkSwap({ ...swapBase, wanted: [10], offered: [20] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.wanted, [10]);
  assert.deepEqual(r.offered, [20]);
});

test('both halves are required — a swap is not a request', () => {
  assert.match(checkSwap({ ...swapBase, wanted: [10], offered: [] }).problems[0], /Offer something/);
  assert.match(checkSwap({ ...swapBase, wanted: [], offered: [20] }).problems[0], /Pick something/);
});

test('you cannot ask for gear that is not on their booking', () => {
  const r = checkSwap({ ...swapBase, wanted: [99], offered: [20] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /not on their booking/);
});

/* Offering gear a third person is holding would move it off them without
   their say-so. Free gear is fine — "take this one instead" is a trade too. */
test('you can offer your own gear, or anything free', () => {
  assert.equal(checkSwap({ ...swapBase, wanted: [10], offered: [20] }).ok, true, 'mine');
  assert.equal(checkSwap({ ...swapBase, freeItems: [50], wanted: [10], offered: [50] }).ok, true,
    'off the shelf');
});

test('you cannot offer gear a third person is holding', () => {
  const r = checkSwap({ ...swapBase, wanted: [10], offered: [99] });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /holding, or something that's free/);
});

/* A trade that changes nothing would still need approving, which is worse
   than being told it's pointless. */
test('a swap that would change nothing is refused', () => {
  const both = { theirItems: [10], myItems: [10] };
  assert.match(checkSwap({ ...both, wanted: [10], offered: [10] }).problems.join(' '), /already hold/);
});

test('many-for-many works, and repeats collapse', () => {
  const r = checkSwap({ ...swapBase, wanted: [10, 11, 10], offered: [20, 21, 20] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.wanted, [10, 11]);
  assert.deepEqual(r.offered, [20, 21]);
});

test('an empty swap reports both halves rather than throwing', () => {
  const r = checkSwap({});
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
});

/* -------------------------------------------------------------- teammates */

const loan = { id: 1, holder_id: 10 };
const hold = { id: 2, person_id: 10 };
const owner10 = { id: 10, role: 'member' };
const mate20  = { id: 20, role: 'member' };
const other30 = { id: 30, role: 'member' };
const admin40 = { id: 40, role: 'admin' };

test('the holder can always add gear to their own booking', () => {
  assert.equal(canAddGear(loan, owner10, []), true);
  assert.equal(canAddGear(hold, owner10, []), true, 'holds use person_id, loans holder_id');
});

test('a named teammate can add gear without asking', () => {
  assert.equal(canAddGear(loan, mate20, [20]), true);
  assert.equal(canAddGear(hold, mate20, [20]), true);
});

test('everyone else cannot — including an admin who was never named', () => {
  assert.equal(canAddGear(loan, other30, [20]), false);
  assert.equal(canAddGear(loan, admin40, [20]), false,
    'the admin carve-out was removed on purpose; suggest instead');
});

/* Contributing to a booking is not the same as being able to end it. */
test('naming teammates is the holder\'s alone', () => {
  assert.equal(canManageContributors(loan, owner10), true);
  assert.equal(canManageContributors(loan, mate20), false, 'a teammate cannot recruit more');
  assert.equal(canManageContributors(loan, admin40), false);
  assert.equal(canManageContributors(hold, owner10), true);
});

test('the holder is already on it, so cannot be added as a teammate', () => {
  assert.equal(contributorAddable(loan, 10, []), false);
  assert.equal(contributorAddable(hold, 10, []), false);
});

test('someone already named cannot be added twice', () => {
  assert.equal(contributorAddable(loan, 20, [20]), false);
  assert.equal(contributorAddable(loan, 20, []), true);
});

test('junk ids are refused rather than written', () => {
  for (const bad of [0, -1, 2.5, NaN, null, undefined]) {
    assert.equal(contributorAddable(loan, bad, []), false, String(bad));
  }
});

test('missing arguments permit nothing rather than throwing', () => {
  assert.equal(canAddGear(null, owner10, []), false);
  assert.equal(canAddGear(loan, null, []), false);
  assert.equal(canManageContributors(null, null), false);
  assert.equal(contributorAddable(null, 20, []), false);
});

test('contributor ids arriving as strings still match', () => {
  assert.equal(canAddGear(loan, mate20, ['20']), true);
  assert.equal(contributorAddable(loan, 20, ['20']), false);
});

/* ------------------------------------------------- naming a booking */

test('only the person who made a booking can rename it', () => {
  assert.equal(canRenameBooking(loan, owner10), true);
  assert.equal(canRenameBooking(hold, owner10), true);
  assert.equal(canRenameBooking(loan, mate20), false, 'a teammate adds gear, not titles');
  assert.equal(canRenameBooking(loan, other30), false);
  assert.equal(canRenameBooking(loan, admin40), false);
  assert.equal(canRenameBooking(null, owner10), false);
  assert.equal(canRenameBooking(loan, null), false);
});

/* A shoot gets renamed mid-week, and the gear is usually already out by then. */
test('renaming does not depend on the booking still being open', () => {
  assert.equal(canRenameBooking({ ...loan, returned_at: '2026-01-01' }, owner10), true);
});

test('labels are trimmed, capped and never undefined', () => {
  assert.deepEqual(bookingLabels({ shoot: '  Easter 9am  ', project: ' Easter ' }),
    { shoot: 'Easter 9am', project: 'Easter' });
  assert.deepEqual(bookingLabels({}), { shoot: '', project: '' });
  assert.deepEqual(bookingLabels(), { shoot: '', project: '' });
  assert.deepEqual(bookingLabels({ shoot: 42, project: null }), { shoot: '', project: '' });
  assert.equal(bookingLabels({ shoot: 'x'.repeat(300) }).shoot.length, 120);
});

/* One line, two labels: the specific one wins. */
test('the shoot names a booking, falling back to the project', () => {
  assert.equal(bookingLabel({ shoot: 'Christmas Eve 6pm', project: 'Christmas' }), 'Christmas Eve 6pm');
  assert.equal(bookingLabel({ shoot: '', project: 'Christmas' }), 'Christmas',
    'bookings made before shoot existed still read as something');
  assert.equal(bookingLabel({ shoot: '   ', project: 'Christmas' }), 'Christmas');
  assert.equal(bookingLabel({}), '');
  assert.equal(bookingLabel(null), '');
});
