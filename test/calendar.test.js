import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  shift, dayList, daysBetween, firstOpening, collisions,
  bookingsFromState, renderBoard, renderCheckoutBoard, renderPicker,
  itemSchedule, countDays, freeGaps, dailyLoad, loadLevel, itemsInGroups,
  bookingLabel, agendaDays, renderAgenda
} from '../public/calendar.js';

const book = (id, kind, items, start, end, person = 'Nick') =>
  ({ kind, id, person_name: person, person_id: 1, start, end, due: end, project: '', item_ids: items, returned: false });

test('date helpers cross month and year boundaries', () => {
  assert.equal(shift('2026-08-31', 1), '2026-09-01');
  assert.equal(shift('2026-01-01', -1), '2025-12-31');
  assert.equal(daysBetween('2026-08-01', '2026-08-15'), 14);
  assert.equal(dayList('2026-08-01', 3).join(','), '2026-08-01,2026-08-02,2026-08-03');
});

test('collisions only report the items actually shared', () => {
  const bookings = [book(1, 'checkout', [10, 11], '2026-08-05', '2026-08-08')];
  const hits = collisions({ itemIds: [11, 12], start: '2026-08-07', end: '2026-08-09', bookings });
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].shared, [11]);
});

test('a booking that ends the day before is not a collision', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-01', '2026-08-04')];
  assert.equal(collisions({ itemIds: [10], start: '2026-08-05', end: '2026-08-06', bookings }).length, 0);
});

test('touching on a single day is a collision', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-01', '2026-08-05')];
  assert.equal(collisions({ itemIds: [10], start: '2026-08-05', end: '2026-08-06', bookings }).length, 1);
});

test('ignoring a booking excludes it, so editing a hold does not fight itself', () => {
  const bookings = [book(7, 'reservation', [10], '2026-08-05', '2026-08-08')];
  const hits = collisions({
    itemIds: [10], start: '2026-08-06', end: '2026-08-07',
    bookings, ignore: ['reservation:7']
  });
  assert.equal(hits.length, 0);
});

test('firstOpening finds the gap after a busy stretch', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-04', '2026-08-09')];
  const gap = firstOpening({ itemIds: [10], length: 3, bookings, from: '2026-08-04' });
  assert.deepEqual(gap, { start: '2026-08-10', end: '2026-08-12' });
});

test('firstOpening needs every requested item free at once', () => {
  const bookings = [
    book(1, 'checkout',    [10], '2026-08-04', '2026-08-06'),
    book(2, 'reservation', [11], '2026-08-07', '2026-08-09')
  ];
  const gap = firstOpening({ itemIds: [10, 11], length: 2, bookings, from: '2026-08-04' });
  assert.deepEqual(gap, { start: '2026-08-10', end: '2026-08-11' });
});

test('firstOpening returns today when nothing is booked', () => {
  const gap = firstOpening({ itemIds: [10], length: 2, bookings: [], from: '2026-08-04' });
  assert.deepEqual(gap, { start: '2026-08-04', end: '2026-08-05' });
});

test('firstOpening gives up rather than lying when the horizon is full', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-01', '2026-12-01')];
  assert.equal(firstOpening({ itemIds: [10], length: 3, bookings, from: '2026-08-04', horizon: 30 }), null);
});

test('bookingsFromState folds checkouts and reservations into one list', () => {
  const state = {
    today: '2026-08-04',
    openCheckouts: [{ id: 1, holder_id: 2, holder_name: 'Nick', out_at: '2026-08-02', due_on: '2026-08-06', project: 'X', item_ids: [10] }],
    reservations: [{ id: 5, person_id: 3, person_name: 'Jordan', start_on: '2026-08-10', end_on: '2026-08-12', project: 'Y', item_ids: [11] }]
  };
  const b = bookingsFromState(state);
  assert.equal(b.length, 2);
  assert.deepEqual(b.map(x => x.kind), ['checkout', 'reservation']);
  assert.equal(b[0].end, '2026-08-06');
});

/* ---- rendering: assert on structure, not pixels ---- */

const state = {
  today: '2026-08-04',
  items: [
    { id: 10, code: 'LC-101', name: 'URSA Cine 12K', category: 'Camera', retired: false },
    { id: 11, code: 'LC-110', name: 'Sigma 18-35', category: 'Lens', retired: false },
    { id: 12, code: 'LC-120', name: 'Aputure 600d', category: 'Light', retired: false }
  ],
  openCheckouts: [], reservations: []
};

test('the board shows only items with activity unless told otherwise', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-04', '2026-08-06')];
  const narrow = renderBoard({ state, bookings, from: '2026-08-04', days: 7, cell: 38 });
  assert.ok(narrow.includes('URSA Cine 12K'));
  assert.ok(!narrow.includes('Aputure 600d'));

  const wide = renderBoard({ state, bookings, from: '2026-08-04', days: 7, cell: 38, scope: 'all' });
  assert.ok(wide.includes('Aputure 600d'));
});

test('an overdue loan renders as late, a hold as reserved', () => {
  const bookings = [
    book(1, 'checkout', [10], '2026-08-01', '2026-08-02'),   // due before today
    book(2, 'reservation', [11], '2026-08-05', '2026-08-06')
  ];
  const html = renderBoard({ state, bookings, from: '2026-08-01', days: 10, cell: 38, scope: 'all' });
  assert.ok(html.includes('tl-bar late'), 'overdue checkout should be late');
  assert.ok(html.includes('tl-bar res'), 'reservation should be res');
});

test('bars clipped by the window edge are marked so they read as continuing', () => {
  const bookings = [book(1, 'checkout', [10], '2026-07-20', '2026-09-01')];
  const html = renderBoard({ state, bookings, from: '2026-08-04', days: 7, cell: 38 });
  assert.ok(html.includes('clip-l'));
  assert.ok(html.includes('clip-r'));
});

test('overlapping bookings on one item stack into separate lanes', () => {
  const bookings = [
    book(1, 'reservation', [10], '2026-08-04', '2026-08-08', 'A'),
    book(2, 'reservation', [10], '2026-08-06', '2026-08-10', 'B')
  ];
  const html = renderBoard({ state, bookings, from: '2026-08-04', days: 10, cell: 38 });
  assert.ok(html.includes('--lane:0'));
  assert.ok(html.includes('--lane:1'), 'second overlapping booking needs its own lane');
  assert.ok(html.includes('--lanes:2'), 'row must grow to fit both lanes');
});

test('the picker reports free when nothing clashes', () => {
  const html = renderPicker({
    state, bookings: [], itemIds: [10], start: '2026-08-04', end: '2026-08-06',
    from: '2026-08-04', days: 10, cell: 38
  });
  assert.ok(html.includes('tl-status ok'));
  assert.ok(html.includes('Everything is free'));
});

test('the picker flags the clash and offers the next opening', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-04', '2026-08-09', 'Elijah')];
  const html = renderPicker({
    state, bookings, itemIds: [10], start: '2026-08-05', end: '2026-08-07',
    from: '2026-08-04', days: 14, cell: 38
  });
  assert.ok(html.includes('tl-status bad'));
  assert.ok(html.includes('1 conflict'));
  assert.ok(html.includes('Elijah'));
  assert.ok(html.includes('data-act="tl-apply"'), 'must offer a suggested window');
  assert.ok(html.includes('data-start="2026-08-10"'));
});

test('the picker marks which rows are the problem', () => {
  const bookings = [book(1, 'checkout', [11], '2026-08-05', '2026-08-08')];
  const html = renderPicker({
    state, bookings, itemIds: [10, 11], start: '2026-08-06', end: '2026-08-07',
    from: '2026-08-04', days: 10, cell: 38
  });
  assert.equal((html.match(/tl-row clash/g) || []).length, 1, 'only the booked item is flagged');
});

test('the picker asks for gear before drawing anything', () => {
  const html = renderPicker({
    state, bookings: [], itemIds: [], start: '2026-08-04', end: '2026-08-05',
    from: '2026-08-04', days: 10, cell: 38
  });
  assert.ok(html.includes('Pick gear'));
  assert.ok(!html.includes('tl-row'));
});

test('selected days are highlighted across the range', () => {
  const html = renderPicker({
    state, bookings: [], itemIds: [10], start: '2026-08-05', end: '2026-08-07',
    from: '2026-08-04', days: 7, cell: 38
  });
  assert.equal((html.match(/tl-cell[^"]*\ssel/g) || []).length, 3, 'three days selected');
});

/* ---- the checkout board, filters, and the day highlight ---- */

test('the checkout board draws one row per order, not per item', () => {
  const bookings = [book(1, 'checkout', [10, 11, 12], '2026-08-04', '2026-08-06')];
  const html = renderCheckoutBoard({ state, bookings, from: '2026-08-04', days: 7, cell: 38 });
  // Three items, one order: one row, and the bar says how much is on it.
  assert.equal((html.match(/class="tl-row"/g) || []).length, 1);
  assert.ok(html.includes('3 items'));
  assert.ok(html.includes('Nick'), 'the row is labelled by who has it');
});

test('checkout rows are grouped by state, overdue first', () => {
  const bookings = [
    book(1, 'reservation', [11], '2026-08-08', '2026-08-09', 'Held'),
    book(2, 'checkout', [10], '2026-08-01', '2026-08-02', 'Late'),   // due before today
    book(3, 'checkout', [12], '2026-08-04', '2026-08-09', 'Current')
  ];
  const html = renderCheckoutBoard({ state, bookings, from: '2026-08-01', days: 14, cell: 38 });
  const order = ['Overdue', 'Out on set', 'Reserved'].map(g => html.indexOf(g));
  assert.ok(order.every(i => i > -1), 'every group should appear');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'groups should be in severity order');
});

test('a whole order is reachable from any day it covers', () => {
  const bookings = [book(42, 'checkout', [10, 11], '2026-08-10', '2026-08-14')];
  // A window that contains none of today, only future days.
  const html = renderCheckoutBoard({ state, bookings, from: '2026-08-10', days: 7, cell: 38 });
  assert.ok(html.includes('data-act="tl-open"'));
  assert.ok(html.includes('data-id="42"'), 'the row carries the order id so it can be opened');
});

test('the category filter narrows both boards', () => {
  const bookings = [
    book(1, 'checkout', [10], '2026-08-04', '2026-08-06'),   // Camera
    book(2, 'checkout', [12], '2026-08-04', '2026-08-06')    // Light
  ];
  const onlyLights = i => i.category === 'Light';

  const items = renderBoard({
    state, bookings, from: '2026-08-04', days: 7, cell: 38, itemFilter: onlyLights
  });
  assert.ok(items.includes('Aputure 600d'));
  assert.ok(!items.includes('URSA Cine 12K'));

  const orders = renderCheckoutBoard({
    state, bookings, from: '2026-08-04', days: 7, cell: 38, itemFilter: onlyLights
  });
  assert.equal((orders.match(/class="tl-row"/g) || []).length, 1, 'only the lighting order survives');
});

test('"out now" shows gear on an open loan even when the window has moved on', () => {
  const withLoan = {
    ...state,
    openCheckouts: [{ id: 1, holder_id: 1, due_on: '2026-08-06', item_ids: [12] }]
  };
  // A window well clear of the loan, so nothing has activity in it.
  const html = renderBoard({
    state: withLoan, bookings: [], from: '2026-11-01', days: 7, cell: 38,
    scope: 'outnow', outNowIds: new Set([12])
  });
  assert.ok(html.includes('Aputure 600d'), 'the item that is out should still be listed');
  assert.ok(!html.includes('URSA Cine 12K'));
});

test('"out now" says so plainly when nothing is out', () => {
  const html = renderBoard({
    state, bookings: [], from: '2026-08-04', days: 7, cell: 38,
    scope: 'outnow', outNowIds: new Set()
  });
  assert.ok(html.includes('Nothing is checked out right now'));
});

test('searched days are highlighted on both boards', () => {
  const hi = { start: '2026-08-06', end: '2026-08-08' };
  const bookings = [book(1, 'checkout', [10], '2026-08-04', '2026-08-06')];

  const items = renderBoard({
    state, bookings, from: '2026-08-04', days: 7, cell: 38, highlight: hi
  });
  // Three highlighted days in the item row, plus three in the header.
  assert.ok((items.match(/tl-cell[^"]*\shi/g) || []).length >= 3);

  const orders = renderCheckoutBoard({
    state, bookings, from: '2026-08-04', days: 7, cell: 38, highlight: hi
  });
  assert.ok((orders.match(/tl-cell[^"]*\shi/g) || []).length >= 3);
});

test('an empty checkout board says so rather than rendering a bare grid', () => {
  const html = renderCheckoutBoard({ state, bookings: [], from: '2026-08-04', days: 7, cell: 38 });
  assert.ok(html.includes('No checkouts or holds'));
  assert.ok(!html.includes('tl-row'));
});

test('an overdue loan still runs to today, so it stays on the board', () => {
  // Due three days ago and never returned — the gear is still on someone's set.
  const withLate = {
    ...state,
    openCheckouts: [{
      id: 1, holder_id: 1, holder_name: 'Sam', due_on: '2026-08-01',
      out_at: '2026-07-26', project: 'Baptism', item_ids: [10]
    }]
  };
  const [b] = bookingsFromState(withLate);
  assert.equal(b.end, '2026-08-04', 'the bar must reach today, not stop at the due date');
  assert.equal(b.due, '2026-08-01', 'the real due date is kept so it still colours as late');

  // And it must actually appear in a window that starts today.
  const html = renderCheckoutBoard({
    state: withLate, bookings: [b], from: '2026-08-04', days: 7, cell: 38
  });
  assert.ok(html.includes('Overdue'), 'overdue loans belong on a board showing today');
  assert.ok(html.includes('tl-bar late'));
});

/* ---- the agenda: the same bookings stacked by day for a phone ---- */

test('agendaDays only lists a day the booking actually touches', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-04', '2026-08-06')];
  const days = agendaDays({ items: state.items, bookings, from: '2026-08-04', days: 5, today: '2026-08-04' });
  assert.deepEqual(days.map(d => d.day), ['2026-08-04', '2026-08-05', '2026-08-06']);
});

test('agendaDays leaves out days with nothing booked, rather than padding with empties', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-04', '2026-08-04')];
  const days = agendaDays({ items: state.items, bookings, from: '2026-08-04', days: 7, today: '2026-08-04' });
  assert.equal(days.length, 1);
});

test('agendaDays marks a booking as continuing on the days that are not its start or end', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-01', '2026-08-10')];
  const days = agendaDays({ items: state.items, bookings, from: '2026-08-04', days: 3, today: '2026-08-04' });
  // The whole 3-day window is in the middle of a longer booking.
  for (const d of days) {
    const [entry] = d.groups[0].entries;
    assert.equal(entry.continuesFrom, true, `${d.day} should read as continuing from earlier`);
    assert.equal(entry.continuesTo, true, `${d.day} should read as continuing on`);
  }
});

test('agendaDays groups each day the same way the checkout board does, overdue first', () => {
  const bookings = [
    book(1, 'reservation', [11], '2026-08-04', '2026-08-04', 'Held'),
    book(2, 'checkout', [10], '2026-08-01', '2026-08-02', 'Late'),   // due before today
    book(3, 'checkout', [12], '2026-08-04', '2026-08-04', 'Current')
  ];
  const [today] = agendaDays({ items: state.items, bookings, from: '2026-08-04', days: 1, today: '2026-08-04' });
  assert.deepEqual(today.groups.map(g => g.group), ['Out on set', 'Reserved']);
  // "Late"'s checkout ran 08-01→08-02, clamped to today by bookingsFromState
  // in real use — here it simply doesn't reach 08-04, so it isn't on today's agenda.
  assert.ok(!today.groups.some(g => g.entries.some(e => e.person_name === 'Late')));
});

test('agendaDays respects the item filter, same as the boards', () => {
  const bookings = [
    book(1, 'checkout', [10], '2026-08-04', '2026-08-04'),   // Camera
    book(2, 'checkout', [12], '2026-08-04', '2026-08-04')    // Light
  ];
  const onlyLights = i => i.category === 'Light';
  const [today] = agendaDays({
    items: state.items, bookings, from: '2026-08-04', days: 1, today: '2026-08-04', itemFilter: onlyLights
  });
  const names = today.groups.flatMap(g => g.entries.flatMap(e => e.itemNames));
  assert.deepEqual(names, ['Aputure 600d']);
});

test('renderAgenda flags today and reaches the underlying order or hold', () => {
  const bookings = [book(1, 'checkout', [10], '2026-08-04', '2026-08-04')];
  const html = renderAgenda({ state, bookings, from: '2026-08-04', days: 1 });
  assert.ok(html.includes('agenda-today-badge'), 'the one day shown is today');
  assert.ok(html.includes('data-act="tl-open"'));
  assert.ok(html.includes('data-kind="checkout"'));
  assert.ok(html.includes('data-id="1"'));
  assert.ok(html.includes('Out on set'), 'grouped under the same heading the checkout board uses');
});

test('renderAgenda still shows today, saying plainly that nothing is booked, even in an empty window', () => {
  const html = renderAgenda({ state, bookings: [], from: '2026-08-04', days: 7 });
  assert.ok(html.includes('agenda-today-badge'), 'today does not just vanish for having nothing on it');
  assert.ok(html.includes('Nothing booked today'));
});

test('renderAgenda falls back to the panel-level empty state when today is not even in the window', () => {
  const html = renderAgenda({ state, bookings: [], from: '2026-09-01', days: 7 });
  assert.ok(html.includes('Nothing booked in this window'));
  assert.ok(!html.includes('agenda-day'));
});

test('renderAgenda only badges the day that is actually today', () => {
  const bookings = [
    book(1, 'checkout', [10], '2026-08-03', '2026-08-03'),
    book(2, 'checkout', [11], '2026-08-05', '2026-08-05')
  ];
  const html = renderAgenda({ state, bookings, from: '2026-08-03', days: 3 });
  assert.equal((html.match(/agenda-today-badge/g) || []).length, 1);
});

/* ---- the schedule list: which days is this gear spoken for? ---- */

test('countDays merges overlapping and touching ranges', () => {
  assert.equal(countDays([]), 0);
  assert.equal(countDays([['2026-08-01', '2026-08-01']]), 1);
  assert.equal(countDays([['2026-08-01', '2026-08-03']]), 3);

  // Back-to-back: Mon-Wed then Wed-Fri is five days, not six.
  assert.equal(countDays([['2026-08-03', '2026-08-05'], ['2026-08-05', '2026-08-07']]), 5);
  // Adjacent with no gap.
  assert.equal(countDays([['2026-08-01', '2026-08-02'], ['2026-08-03', '2026-08-04']]), 4);
  // A real gap is not counted.
  assert.equal(countDays([['2026-08-01', '2026-08-02'], ['2026-08-10', '2026-08-11']]), 4);
  // Out of order input.
  assert.equal(countDays([['2026-08-10', '2026-08-11'], ['2026-08-01', '2026-08-02']]), 4);
  // Fully contained.
  assert.equal(countDays([['2026-08-01', '2026-08-10'], ['2026-08-03', '2026-08-04']]), 10);
});

test('itemSchedule lists each item\'s bookings in date order', () => {
  const bookings = [
    book(2, 'reservation', [10], '2026-08-20', '2026-08-22', 'Maya'),
    book(1, 'checkout', [10], '2026-08-04', '2026-08-06', 'Nick')
  ];
  const [entry] = itemSchedule({
    items: [state.items[0]], bookings, from: '2026-08-01', to: '2026-08-31'
  });
  assert.equal(entry.item.name, 'URSA Cine 12K');
  assert.deepEqual(entry.bookings.map(b => b.person_name), ['Nick', 'Maya']);
  assert.equal(entry.days, 6, 'three days out plus three days held');
  assert.equal(entry.spanDays, 31);
});

test('itemSchedule clips to the period rather than reporting days outside it', () => {
  // A loan that started last month and runs into next.
  const bookings = [book(1, 'checkout', [10], '2026-07-20', '2026-09-10')];
  const [entry] = itemSchedule({
    items: [state.items[0]], bookings, from: '2026-08-01', to: '2026-08-31'
  });
  assert.equal(entry.bookings[0].clippedStart, '2026-08-01');
  assert.equal(entry.bookings[0].clippedEnd, '2026-08-31');
  assert.ok(entry.bookings[0].runsInFrom, 'should be flagged as starting earlier');
  assert.ok(entry.bookings[0].runsOnPast, 'should be flagged as continuing later');
  assert.equal(entry.days, 31, 'the whole month, not the whole loan');
});

test('itemSchedule reports gear with nothing on it', () => {
  const [entry] = itemSchedule({
    items: [state.items[2]], bookings: [], from: '2026-08-01', to: '2026-08-31'
  });
  assert.deepEqual(entry.bookings, []);
  assert.equal(entry.days, 0);
});

test('itemSchedule ignores bookings outside the period entirely', () => {
  const bookings = [book(1, 'checkout', [10], '2026-05-01', '2026-05-04')];
  const [entry] = itemSchedule({
    items: [state.items[0]], bookings, from: '2026-08-01', to: '2026-08-31'
  });
  assert.equal(entry.bookings.length, 0);
  assert.equal(entry.days, 0);
});

/* ---- free gaps: the same question from the other end ---- */

test('freeGaps returns the whole period when nothing is booked', () => {
  const gaps = freeGaps({ ranges: [], from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(gaps, [{ start: '2026-08-01', end: '2026-08-31' }]);
});

test('freeGaps returns nothing when the period is fully covered', () => {
  const gaps = freeGaps({ ranges: [['2026-07-20', '2026-09-10']], from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(gaps, []);
});

test('freeGaps finds the days either side of a booking', () => {
  const gaps = freeGaps({ ranges: [['2026-08-10', '2026-08-12']], from: '2026-08-08', to: '2026-08-15' });
  assert.deepEqual(gaps, [
    { start: '2026-08-08', end: '2026-08-09' },
    { start: '2026-08-13', end: '2026-08-15' }
  ]);
});

test('freeGaps does not invent a gap between overlapping bookings', () => {
  const gaps = freeGaps({
    ranges: [['2026-08-05', '2026-08-10'], ['2026-08-08', '2026-08-14']],
    from: '2026-08-01', to: '2026-08-20'
  });
  assert.deepEqual(gaps, [
    { start: '2026-08-01', end: '2026-08-04' },
    { start: '2026-08-15', end: '2026-08-20' }
  ]);
});

test('freeGaps treats back-to-back bookings as continuous', () => {
  // Ends the 10th, next starts the 11th — there is no free day between them.
  const gaps = freeGaps({
    ranges: [['2026-08-05', '2026-08-10'], ['2026-08-11', '2026-08-14']],
    from: '2026-08-05', to: '2026-08-14'
  });
  assert.deepEqual(gaps, []);
});

test('freeGaps handles a single free day between two loans', () => {
  const gaps = freeGaps({
    ranges: [['2026-08-05', '2026-08-09'], ['2026-08-11', '2026-08-14']],
    from: '2026-08-05', to: '2026-08-14'
  });
  assert.deepEqual(gaps, [{ start: '2026-08-10', end: '2026-08-10' }]);
});

test('itemSchedule reports booked and free days that add up to the period', () => {
  const bookings = [
    book(1, 'checkout', [10], '2026-08-04', '2026-08-06'),
    book(2, 'reservation', [10], '2026-08-20', '2026-08-22')
  ];
  const [entry] = itemSchedule({
    items: [state.items[0]], bookings, from: '2026-08-01', to: '2026-08-31'
  });
  assert.equal(entry.days, 6);
  assert.equal(entry.freeDays, 25);
  assert.equal(entry.days + entry.freeDays, entry.spanDays, 'booked plus free is the whole period');
  assert.deepEqual(entry.gaps, [
    { start: '2026-08-01', end: '2026-08-03' },
    { start: '2026-08-07', end: '2026-08-19' },
    { start: '2026-08-23', end: '2026-08-31' }
  ]);
});

test('itemSchedule shows gear with nothing on it as free for the whole period', () => {
  const [entry] = itemSchedule({
    items: [state.items[2]], bookings: [], from: '2026-08-01', to: '2026-08-31'
  });
  assert.equal(entry.days, 0);
  assert.equal(entry.freeDays, 31);
  assert.deepEqual(entry.gaps, [{ start: '2026-08-01', end: '2026-08-31' }]);
});

/* ---- the load strip: how tight is each day? ---- */

const LOAD_ITEMS = [
  { id: 1, name: 'C400',      category: 'Cameras',              retired: false },
  { id: 2, name: 'C80',       category: 'Cameras',              retired: false },
  { id: 3, name: 'FX3',       category: 'Camera',               retired: false }, // singular
  { id: 4, name: 'Ronin',     category: 'Camera Stabilization', retired: false }, // NOT a camera
  { id: 5, name: 'Aputure',   category: 'Lighting',             retired: false },
  { id: 6, name: 'Astera',    category: 'Lighting',             retired: false },
  { id: 7, name: 'Sigma',     category: 'Lenses',               retired: false },
  { id: 8, name: 'Old body',  category: 'Cameras',              retired: true }
];

test('itemsInGroups does not mistake Camera Stabilization for a camera', () => {
  const cams = itemsInGroups(LOAD_ITEMS, ['cameras']).map(i => i.name);
  assert.deepEqual(cams.sort(), ['C400', 'C80', 'FX3'], 'tripods and gimbals are not cameras');
  assert.ok(!cams.includes('Ronin'));
  assert.ok(!cams.includes('Old body'), 'retired gear is not counted');
});

test('itemsInGroups handles singular and plural, and combines groups', () => {
  assert.equal(itemsInGroups(LOAD_ITEMS, ['lighting']).length, 2);
  assert.equal(itemsInGroups(LOAD_ITEMS, ['cameras', 'lighting']).length, 5);
  assert.deepEqual(itemsInGroups(LOAD_ITEMS, []), [], 'no groups selected means nothing to measure');
});

test('dailyLoad counts free gear per day', () => {
  const cams = itemsInGroups(LOAD_ITEMS, ['cameras']);   // 3 cameras
  const bookings = [book(1, 'checkout', [1, 2], '2026-08-04', '2026-08-05')];
  const load = dailyLoad({
    items: cams, bookings, days: ['2026-08-03', '2026-08-04', '2026-08-06']
  });

  assert.deepEqual(load.map(d => d.busy), [0, 2, 0]);
  assert.deepEqual(load.map(d => d.free), [3, 1, 3]);
  assert.equal(load[1].total, 3);
});

test('dailyLoad counts an item once even on overlapping bookings', () => {
  // Two bookings on the same camera is still one camera off the shelf.
  const cams = itemsInGroups(LOAD_ITEMS, ['cameras']);
  const bookings = [
    book(1, 'checkout', [1], '2026-08-04', '2026-08-06'),
    book(2, 'reservation', [1], '2026-08-05', '2026-08-07')
  ];
  const load = dailyLoad({ items: cams, bookings, days: ['2026-08-05'] });
  assert.equal(load[0].busy, 1, 'double-booked gear must not be double-counted');
  assert.equal(load[0].free, 2);
});

test('dailyLoad treats gear in for repair as unavailable', () => {
  const cams = itemsInGroups(LOAD_ITEMS, ['cameras']);
  const maintenance = [{ item_id: 1, opened_on: '2026-08-04', closed_on: null }];
  const load = dailyLoad({
    items: cams, bookings: [], maintenance,
    days: ['2026-08-03', '2026-08-04', '2026-08-20']
  });
  assert.deepEqual(load.map(d => d.busy), [0, 1, 1], 'an open ticket runs indefinitely');
});

test('dailyLoad respects a closed repair ticket', () => {
  const cams = itemsInGroups(LOAD_ITEMS, ['cameras']);
  const maintenance = [{ item_id: 1, opened_on: '2026-08-04', closed_on: '2026-08-06' }];
  const load = dailyLoad({
    items: cams, bookings: [], maintenance,
    days: ['2026-08-05', '2026-08-07']
  });
  assert.deepEqual(load.map(d => d.busy), [1, 0], 'back in service after it closes');
});

test('dailyLoad does not count gear outside the chosen groups', () => {
  const cams = itemsInGroups(LOAD_ITEMS, ['cameras']);
  // A lens and a gimbal go out; neither is a camera.
  const bookings = [book(1, 'checkout', [7, 4], '2026-08-04', '2026-08-05')];
  const load = dailyLoad({ items: cams, bookings, days: ['2026-08-04'] });
  assert.equal(load[0].busy, 0);
  assert.equal(load[0].free, 3);
});

test('dailyLoad copes with an empty group rather than dividing by zero', () => {
  const load = dailyLoad({ items: [], bookings: [], days: ['2026-08-04'] });
  assert.equal(load[0].total, 0);
  assert.equal(load[0].ratio, 0, 'no gear must not produce NaN');
  assert.equal(loadLevel(load[0].ratio), 'free');
});

test('loadLevel runs green through red as gear fills up', () => {
  assert.equal(loadLevel(0), 'free');
  assert.equal(loadLevel(0.2), 'easy');
  assert.equal(loadLevel(0.5), 'moderate');
  assert.equal(loadLevel(0.75), 'busy');
  assert.equal(loadLevel(1), 'tight');
});

test('loadLevel is monotonic — more out is never a greener day', () => {
  const rank = { free: 0, easy: 1, moderate: 2, busy: 3, tight: 4 };
  let previous = -1;
  for (let r = 0; r <= 1.0001; r += 0.01) {
    const level = rank[loadLevel(Math.min(r, 1))];
    assert.ok(level >= previous, `ratio ${r.toFixed(2)} went backwards`);
    previous = level;
  }
});

test('the load strip renders only when asked for', () => {
  const cams = itemsInGroups(LOAD_ITEMS, ['cameras']);
  const days = dayList('2026-08-04', 7);
  const load = dailyLoad({ items: cams, bookings: [], days });

  const off = renderBoard({ state, bookings: [], from: '2026-08-04', days: 7, cell: 38, scope: 'all' });
  assert.ok(!off.includes('tl-heat'), 'no strip unless the filter is on');

  const on = renderBoard({
    state, bookings: [], from: '2026-08-04', days: 7, cell: 38, scope: 'all',
    heat: [{ load, label: 'Cameras' }]
  });
  assert.ok(on.includes('tl-heat'));
  assert.ok(on.includes('Cameras'));
  assert.ok(on.includes('tl-cell heat free'), 'an empty cage is all green');
});

test('the load strip appears on the checkout board too', () => {
  const cams = itemsInGroups(LOAD_ITEMS, ['cameras']);
  const days = dayList('2026-08-04', 5);
  const bookings = [book(1, 'checkout', [1, 2, 3], '2026-08-04', '2026-08-06')];
  const load = dailyLoad({ items: cams, bookings, days });

  const html = renderCheckoutBoard({
    state, bookings, from: '2026-08-04', days: 5, cell: 38,
    heat: [{ load, label: 'Cameras' }]
  });
  assert.ok(html.includes('tl-cell heat tight'), 'every camera out should read as tight');
});

test('each layer is scaled to its own category, not pooled', () => {
  // The whole reason layers are separate: 3 cameras vs 30 lights. Every camera
  // out must read as tight even while almost every light is free — pooling
  // them would let the lights hide it.
  const many = Array.from({ length: 30 }, (_, i) => ({
    id: 100 + i, name: `Light ${i}`, category: 'Lighting', retired: false
  }));
  const items = [...LOAD_ITEMS, ...many];
  const days = dayList('2026-08-04', 2);
  const bookings = [book(1, 'checkout', [1, 2, 3], '2026-08-04', '2026-08-05')]; // all 3 cameras

  const cams = dailyLoad({ items: itemsInGroups(items, ['cameras']), bookings, days });
  const lights = dailyLoad({ items: itemsInGroups(items, ['lighting']), bookings, days });

  assert.equal(loadLevel(cams[0].ratio), 'tight', 'every camera is out');
  assert.equal(loadLevel(lights[0].ratio), 'free', 'no lights are out');

  // Pooled, the same day would look almost entirely free — the bug this avoids.
  const pooled = dailyLoad({ items: itemsInGroups(items, ['cameras', 'lighting']), bookings, days });
  assert.ok(pooled[0].ratio < 0.1, 'pooling really does mask it');
  assert.notEqual(loadLevel(pooled[0].ratio), 'tight');
});

test('two layers render as two independent strips', () => {
  const items = [...LOAD_ITEMS];
  const days = dayList('2026-08-04', 4);
  const bookings = [book(1, 'checkout', [1, 2, 3], '2026-08-04', '2026-08-05')];

  const html = renderBoard({
    state, bookings: [], from: '2026-08-04', days: 4, cell: 38, scope: 'all',
    heat: [
      { label: 'Cameras',  load: dailyLoad({ items: itemsInGroups(items, ['cameras']), bookings, days }) },
      { label: 'Lighting', load: dailyLoad({ items: itemsInGroups(items, ['lighting']), bookings, days }) }
    ]
  });

  assert.equal((html.match(/tl-row tl-heat/g) || []).length, 2, 'one row per layer');
  assert.ok(html.includes('Cameras'));
  assert.ok(html.includes('Lighting'));
  assert.ok(html.includes('tl-cell heat tight'), 'the camera layer is tight');
  assert.ok(html.includes('tl-cell heat free'), 'the lighting layer is free');
});

test('one layer on its own renders one strip', () => {
  const days = dayList('2026-08-04', 3);
  const html = renderBoard({
    state, bookings: [], from: '2026-08-04', days: 3, cell: 38, scope: 'all',
    heat: [{ label: 'Lighting', load: dailyLoad({ items: itemsInGroups(LOAD_ITEMS, ['lighting']), bookings: [], days }) }]
  });
  assert.equal((html.match(/tl-row tl-heat/g) || []).length, 1);
  assert.ok(!html.includes('Cameras'));
});

/* ------------------------------------------------- what a bar is called */

test('a bar is labelled with the project, falling back to the shoot', () => {
  assert.equal(bookingLabel({ shoot: 'Easter 9am', project: 'Easter' }), 'Easter');
  assert.equal(bookingLabel({ shoot: 'Easter 9am', project: '' }), 'Easter 9am');
  assert.equal(bookingLabel({}), '');
  assert.equal(bookingLabel(null), '');
});

test('the timeline carries both labels off state', () => {
  const b = bookingsFromState({
    today: '2026-08-07', openMaintenance: [], reservations: [],
    openCheckouts: [{ id: 1, holder_id: 1, holder_name: 'Jo', out_at: '2026-08-07',
      due_on: '2026-08-09', shoot: 'Sunday 9am', project: 'Weekend', item_ids: [1] }]
  });
  assert.equal(b[0].shoot, 'Sunday 9am');
  assert.equal(b[0].project, 'Weekend');
});
