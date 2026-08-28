/**
 * The rules that decide whether gear can leave the cage.
 *
 * Deliberately pure: everything comes in as plain data so the rules can be
 * unit tested without a database, and so the same logic can answer both
 * "can I check this out right now?" and "why is this row greyed out?".
 */

export const overlaps = (aStart, aEnd, bStart, bEnd) => aStart <= bEnd && bStart <= aEnd;

const asDate = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

/**
 * @param {object} ctx
 * @param {object}   ctx.person            { id, role, blocked, blocked_reason }
 * @param {object[]} ctx.items             items being requested
 * @param {string}   ctx.from              YYYY-MM-DD, first day out
 * @param {string}   ctx.due               YYYY-MM-DD, expected back
 * @param {object[]} ctx.openCheckouts     [{ id, holder_id, holder_name, due_on, item_ids }]
 * @param {object[]} ctx.reservations       live holds [{ id, person_id, person_name, start_on, end_on, item_ids }]
 * @param {object[]} ctx.openMaintenance   [{ item_id, kind, notes }]
 * @param {object}   ctx.settings
 * @param {boolean}  ctx.override          admin is knowingly forcing it
 * @returns {{ allowed:boolean, blocks:object[], warnings:object[], fulfils:number[] }}
 */
export function evaluateCheckout(ctx) {
  const {
    person, items, from, due,
    openCheckouts = [], reservations = [], openMaintenance = [],
    settings = {}, override = false
  } = ctx;

  const on = key => String(settings[key] ?? 'true') === 'true';
  const blocks = [];
  const warnings = [];
  const fulfils = new Set();

  const start = asDate(from);
  const end = asDate(due);

  if (end < start) {
    blocks.push({ code: 'bad_dates', message: 'The due date is before the checkout date.' });
  }

  /* ---- person-level gates ---------------------------------------------- */
  if (person.blocked) {
    blocks.push({
      code: 'person_blocked',
      message: person.blocked_reason
        ? `${person.name || person.email} is blocked from checking out gear: ${person.blocked_reason}`
        : `${person.name || person.email} is blocked from checking out gear.`
    });
  }

  const grace = Number(settings.overdue_grace_days || 0);
  const cutoff = shiftDays(start, -grace);
  const theirOverdue = openCheckouts.filter(
    c => c.holder_id === person.id && asDate(c.due_on) < cutoff
  );
  if (theirOverdue.length && on('block_overdue_borrowers')) {
    blocks.push({
      code: 'has_overdue',
      message: `${theirOverdue.length} item${theirOverdue.length === 1 ? '' : 's'} already overdue. Return those first.`,
      detail: theirOverdue.map(c => ({ checkout_id: c.id, due_on: asDate(c.due_on) }))
    });
  } else if (theirOverdue.length) {
    warnings.push({ code: 'has_overdue', message: `Note: ${theirOverdue.length} item(s) already overdue.` });
  }

  /* ---- item-level gates ------------------------------------------------ */
  if (!items.length) {
    blocks.push({ code: 'no_items', message: 'Pick at least one item.' });
  }

  for (const it of items) {
    const label = `${it.name} (${it.code})`;

    if (it.retired) {
      blocks.push({ code: 'retired', item_id: it.id, message: `${label} is retired.` });
      continue;
    }

    const down = openMaintenance.find(m => m.item_id === it.id);
    if (down) {
      const msg = `${label} is down — ${down.kind.toLowerCase()}${down.notes ? `: ${down.notes}` : ''}.`;
      if (on('enforce_availability')) blocks.push({ code: 'in_repair', item_id: it.id, message: msg });
      else warnings.push({ code: 'in_repair', item_id: it.id, message: msg });
      continue;
    }

    const out = openCheckouts.find(c => c.item_ids.includes(it.id));
    if (out) {
      const msg = `${label} is already out with ${out.holder_name}, due ${asDate(out.due_on)}.`;
      if (on('enforce_availability')) blocks.push({ code: 'already_out', item_id: it.id, message: msg });
      else warnings.push({ code: 'already_out', item_id: it.id, message: msg });
      continue;
    }

    for (const r of reservations) {
      if (!r.item_ids.includes(it.id)) continue;
      if (!overlaps(start, end, asDate(r.start_on), asDate(r.end_on))) continue;

      if (r.person_id === person.id) {
        // Their own hold — this checkout is the hold being collected.
        fulfils.add(r.id);
        continue;
      }
      const msg = `${label} is held for ${r.person_name}, ${asDate(r.start_on)} to ${asDate(r.end_on)}.`;
      if (on('enforce_reservations')) blocks.push({ code: 'reserved', item_id: it.id, message: msg });
      else warnings.push({ code: 'reserved', item_id: it.id, message: msg });
    }
  }

  /* ---- override -------------------------------------------------------- */
  // Bad dates and empty carts are never overridable — they're mistakes, not policy.
  const hard = blocks.filter(b => b.code === 'bad_dates' || b.code === 'no_items');
  if (override && person.role === 'admin' && !hard.length) {
    return {
      allowed: true,
      blocks: [],
      warnings: [...warnings, ...blocks.map(b => ({ ...b, overridden: true }))],
      fulfils: [...fulfils]
    };
  }

  return { allowed: blocks.length === 0, blocks, warnings, fulfils: [...fulfils] };
}

/** Same rules, reduced to a single status word per item, for painting the UI. */
export function statusOf(itemId, { openCheckouts = [], openMaintenance = [], reservations = [], today = null }) {
  const day = today || new Date().toISOString().slice(0, 10);
  if (openMaintenance.some(m => m.item_id === itemId)) return 'repair';
  const out = openCheckouts.find(c => c.item_ids.includes(itemId));
  if (out) return asDate(out.due_on) < day ? 'overdue' : 'out';
  const held = reservations.find(r => r.item_ids.includes(itemId)
    && overlaps(day, day, asDate(r.start_on), asDate(r.end_on)));
  if (held) return 'held';
  return 'ready';
}

export function shiftDays(dateStr, days) {
  const d = new Date(asDate(dateStr) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------------- kits */

/**
 * Who can see and change a kit.
 *
 * Kits began as one global list that belonged to nobody. A kit with a null
 * owner_id predates personal kits, so it belongs to the team — and it can't
 * be made private, because there's no one to make it private *for*. That's
 * why ownerless is treated as visible rather than migrated to a `shared`
 * flag: the flag would be a lie the moment an admin unticked it.
 */
export function kitVisibleTo(kit, person) {
  if (!kit || !person) return false;
  return Boolean(kit.shared) || kit.owner_id == null || kit.owner_id === person.id;
}

/**
 * Editing is the owner's alone. Admins get the ownerless ones so the legacy
 * list stays maintainable, but deliberately *not* someone else's personal
 * kit — a half-built package is a draft, and rewriting another person's
 * draft under their name is worse than being unable to help.
 */
export function kitEditableBy(kit, person) {
  if (!kit || !person) return false;
  if (kit.owner_id != null && kit.owner_id === person.id) return true;
  return kit.owner_id == null && person.role === 'admin';
}

/** Admins can clear out clutter they can see, even when they can't edit it. */
export function kitDeletableBy(kit, person) {
  if (kitEditableBy(kit, person)) return true;
  return Boolean(person) && person.role === 'admin' && kitVisibleTo(kit, person);
}

/** Copying needs only the right to look at it — the copy is yours, and private. */
export function duplicateKit(kit, person, existingNames = []) {
  const base = `${String(kit.name || 'Kit').trim()} copy`;
  let name = base;
  for (let n = 2; existingNames.includes(name); n++) name = `${base} ${n}`;
  return {
    name,
    notes: kit.notes || '',
    item_ids: [...new Set(kit.item_ids || [])],
    owner_id: person.id,
    shared: false,    // a copy starts private; publishing is a separate decision
    // A copy is always personally owned, so it's always a package — even
    // when duplicating a physical kit. There's no ownerless reading of
    // "your copy of the case".
    type: 'package'
  };
}

/* ------------------------------------------------------------ contributors */

/**
 * Who may put gear *on* a booking.
 *
 * The holder, and anyone they've named as a teammate. A shoot is rarely one
 * person, and making the second camera op ask permission for every battery is
 * the friction this removes.
 *
 * Deliberately narrower than it looks: this is add-only. Taking gear off,
 * checking in, extending and releasing stay with whoever made the booking —
 * a teammate contributing to a loan is not the same as being able to end it.
 */
export function canAddGear(booking, person, contributorIds = []) {
  if (!booking || !person) return false;
  const owner = booking.holder_id ?? booking.person_id;
  if (owner === person.id) return true;
  return contributorIds.map(Number).includes(person.id);
}

/** Naming teammates is the holder's call — it's their booking to share. */
export function canManageContributors(booking, person) {
  if (!booking || !person) return false;
  return (booking.holder_id ?? booking.person_id) === person.id;
}

/**
 * Who may rename a booking — its shoot and its project.
 *
 * The person who made it, and only them, for as long as it exists. A label is
 * not a lock: a shoot gets renamed halfway through the week and the loan it's
 * on is often already out, so this deliberately has no "while it's still
 * open" condition the way check-in and extend do.
 *
 * Not teammates. They can add gear to the booking; retitling someone else's
 * loan is a different thing, and the sheet already promises they can't.
 */
export function canRenameBooking(booking, person) {
  if (!booking || !person) return false;
  return (booking.holder_id ?? booking.person_id) === person.id;
}

/** Trim and cap what goes in those two labels. Both are optional. */
export function bookingLabels(raw = {}) {
  const clean = v => (typeof v === 'string' ? v : '').trim().slice(0, 120);
  return { shoot: clean(raw.shoot), project: clean(raw.project) };
}

/**
 * What to call a booking in one line, where there's only room for one.
 *
 * The shoot wins: it's the specific thing ("Christmas Eve 6pm"), where the
 * project is the bucket it belongs to ("Christmas"). Falls back to the project
 * so bookings made before shoot existed still read as something.
 */
export function bookingLabel(booking) {
  if (!booking) return '';
  return String(booking.shoot || '').trim() || String(booking.project || '').trim();
}

/** The holder is already on it; adding them again would be a no-op row. */
export function contributorAddable(booking, personId, contributorIds = []) {
  if (!booking || !Number.isInteger(personId) || personId <= 0) return false;
  const owner = booking.holder_id ?? booking.person_id;
  if (owner === personId) return false;
  return !contributorIds.map(Number).includes(personId);
}

/* ------------------------------------------------------------- gear requests */

/**
 * Who may decide a request to add gear to a booking.
 *
 * The holder, because it's their loan, and an admin, because someone has to
 * be able to unblock a request when the holder is on a shoot with no signal.
 * Deliberately not the requester: approving your own request is just taking
 * the gear, which is the thing the request exists to avoid.
 */
export function requestDecidableBy(req, person) {
  if (!req || !person || req.state !== 'pending') return false;
  if (req.requester_id === person.id && person.role !== 'admin') return false;
  return req.holder_id === person.id || person.role === 'admin';
}

/** You can withdraw what you asked for; an admin can clear the queue. */
export function requestCancellableBy(req, person) {
  if (!req || !person || req.state !== 'pending') return false;
  return req.requester_id === person.id || person.role === 'admin';
}

/** A request is only worth making for gear that isn't already on the booking. */
export function requestableItems(itemIds, alreadyOn = []) {
  const have = new Set(alreadyOn.map(Number));
  return [...new Set((itemIds || []).map(Number).filter(Number.isInteger))]
    .filter(id => id > 0 && !have.has(id));
}

/**
 * A swap offer: you take gear off their booking, they take gear off yours.
 *
 * Returns the reasons it can't stand, so the caller can say which half is
 * wrong. Both sides have to be real and disjoint — offering someone an item
 * they already hold, or asking for one you already have, is a trade that
 * changes nothing and would still need approving.
 */
export function checkSwap({
  theirItems = [], myItems = [], freeItems = [], wanted = [], offered = []
}) {
  const problems = [];
  const theirs = new Set(theirItems.map(Number));
  const mine = new Set(myItems.map(Number));
  /* Offered gear can be yours *or* free off the shelf — "take this one
     instead" is as much a trade as "take mine". What it can't be is
     something a third person is holding. */
  const offerable = new Set([...mine, ...freeItems.map(Number)]);
  const want = [...new Set(wanted.map(Number))];
  const give = [...new Set(offered.map(Number))];

  if (!want.length) problems.push('Pick something of theirs to take.');
  if (!give.length) problems.push('Offer something in exchange.');
  if (want.some(id => !theirs.has(id))) problems.push('That gear is not on their booking.');
  if (give.some(id => !offerable.has(id))) {
    problems.push("Offer gear you're holding, or something that's free.");
  }
  if (want.some(id => mine.has(id))) problems.push('You already hold that.');
  if (give.some(id => theirs.has(id))) problems.push('They already hold that.');

  return { ok: problems.length === 0, problems, wanted: want, offered: give };
}

/** Reservation collisions, used before saving a hold. */
export function reservationConflicts({ itemIds, start, end, reservations = [], openCheckouts = [], skipId = null }) {
  const s = asDate(start), e = asDate(end);
  const hits = [];
  for (const r of reservations) {
    if (r.id === skipId) continue;
    if (!overlaps(s, e, asDate(r.start_on), asDate(r.end_on))) continue;
    const shared = r.item_ids.filter(i => itemIds.includes(i));
    if (shared.length) {
      hits.push({ kind: 'reservation', id: r.id, person_name: r.person_name, start: asDate(r.start_on), end: asDate(r.end_on), item_ids: shared });
    }
  }
  for (const c of openCheckouts) {
    if (!overlaps(s, e, asDate(c.out_at || s), asDate(c.due_on))) continue;
    const shared = c.item_ids.filter(i => itemIds.includes(i));
    if (shared.length) {
      hits.push({ kind: 'checkout', id: c.id, person_name: c.holder_name, start: asDate(c.out_at || s), end: asDate(c.due_on), item_ids: shared });
    }
  }
  return hits;
}
