/**
 * Timeline views.
 *
 * Gear scheduling is a resource-allocation problem, not a month-at-a-glance
 * problem, so the layout is a horizontal grid — one row per item, one column per
 * day, bars for bookings. That's the same shape as Outlook's scheduling
 * assistant, which is the mental model people already have for "when is this
 * thing free".
 *
 * Four consumers:
 *   renderBoard()         — Calendar tab, a row per item: "when is this free?"
 *   renderCheckoutBoard() — Calendar tab, a row per order: "what went out on
 *                           Thursday, and what was on it?"
 *   renderAgenda()        — Calendar tab's phone default: the same bookings,
 *                           stacked by day instead of gridded by column,
 *                           because a grid needs columns wide enough to read
 *                           a date in and a phone doesn't have that.
 *   renderPicker()        — embedded in the checkout and reserve sheets,
 *                           showing the proposed window against existing bookings
 */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/* Same alphabetical, fleet-wide colour assignment as flagTag() in app.js —
   deliberately a local copy (this module stays standalone), but it has to
   derive from the same set of items the same way or the same flag would
   get a different colour on a calendar row than on a Gear row. */
const flagIndex = (items, flag) => [...new Set(items.filter(i => !i.retired).map(i => i.flag).filter(Boolean))]
  .sort().indexOf(flag);
function flagTag(items, it) {
  if (!it?.flag) return '';
  const i = flagIndex(items, it.flag);
  const dot = i >= 0 && i < 6 ? `<i class="flag-dot" data-flag-i="${i + 1}"></i>` : '';
  return `<span class="flag-tag">${dot}${esc(it.flag)}</span>`;
}

/* A bar has room for one label. `project` wins over `shoot` because every
   import writes its label into `project` (scripts/import-orders.js) and
   `shoot` only gets filled in by hand later — on real data `shoot` is empty
   on nearly everything, so leading with it would blank out most bars.
   Deliberately a local copy of app.js's bookingHeaderMeta reasoning — this
   module stays standalone, same as esc(). */
export const bookingLabel = b =>
  (b ? String(b.project || '').trim() || String(b.shoot || '').trim() : '');

/* ------------------------------------------------------------------ date math */

export function shift(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayList(from, count) {
  return Array.from({ length: count }, (_, i) => shift(from, i));
}

export const daysBetween = (a, b) =>
  Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86_400_000);

const overlaps = (aS, aE, bS, bE) => aS <= bE && bS <= aE;

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function parts(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return { dow: d.getUTCDay(), dom: d.getUTCDate(), mon: MONTH[d.getUTCMonth()] };
}

/* --------------------------------------------------------------- bookings */

/**
 * Bookings that touch a given item, from whatever source is available.
 * The Calendar tab passes /api/calendar results; the picker uses live state so
 * it reflects edits without a round trip.
 */
export function bookingsFromState(state) {
  const out = [];
  for (const c of state.openCheckouts) {
    out.push({
      kind: 'checkout', id: c.id, person_name: c.holder_name, person_id: c.holder_id,
      start: c.out_at || state.today,
      // Still out, so it still occupies the shelf — an overdue loan runs to
      // today rather than stopping at the date it missed. `due` keeps the real
      // date so it still reads as late.
      end: c.due_on < state.today ? state.today : c.due_on,
      due: c.due_on,
      shoot: c.shoot || '', project: c.project || '', item_ids: c.item_ids, returned: false
    });
  }
  for (const r of state.reservations) {
    out.push({
      kind: 'reservation', id: r.id, person_name: r.person_name, person_id: r.person_id,
      start: r.start_on, end: r.end_on, due: r.end_on,
      shoot: r.shoot || '', project: r.project || '', item_ids: r.item_ids, returned: false
    });
  }
  return out;
}

/** Classify a bar for colouring. */
function barClass(b, today) {
  if (b.kind === 'reservation') return 'res';
  if (b.returned) return 'done';
  if (b.due < today) return 'late';
  return 'out';
}

/**
 * Assign each booking a lane so overlapping bars stack instead of hiding each
 * other. Two bars in the same lane never overlap; a second lane appearing at
 * all is itself the signal that something is double-booked.
 */
function packLanes(bookings) {
  const lanes = [];
  const sorted = [...bookings].sort((a, b) => a.start.localeCompare(b.start));
  for (const b of sorted) {
    let lane = lanes.findIndex(l => l.every(x => !overlaps(b.start, b.end, x.start, x.end)));
    if (lane === -1) { lanes.push([]); lane = lanes.length - 1; }
    lanes[lane].push(b);
    b._lane = lane;
  }
  return { bookings: sorted, laneCount: Math.max(1, lanes.length) };
}

/* ------------------------------------------------------------------ openings */

/**
 * Earliest window of `length` days where every item is free.
 * Scans forward day by day — with a 60-day horizon and a handful of items this
 * is far too small to need anything cleverer.
 */
export function firstOpening({ itemIds, length, bookings, from, horizon = 60, ignore = [] }) {
  const relevant = bookings.filter(b =>
    !ignore.includes(`${b.kind}:${b.id}`) && b.item_ids.some(i => itemIds.includes(i)));

  for (let offset = 0; offset <= horizon - length; offset++) {
    const start = shift(from, offset);
    const end = shift(start, length - 1);
    const clash = relevant.some(b => overlaps(start, end, b.start, b.end));
    if (!clash) return { start, end };
  }
  return null;
}

/* ------------------------------------------------------------- day load */

/**
 * Which categories the load strip can measure.
 *
 * Anchored rather than prefix-matched on purpose: the real inventory has a
 * "Camera Stabilization" category full of tripods and gimbals, and counting
 * those as cameras would make a day look tight when every body was on the
 * shelf. Singular and plural both appear across datasets.
 */
export const LOAD_GROUPS = {
  cameras: /^cameras?$/i,
  lighting: /^light(ing|s)?$/i
};

/** Items in the chosen groups. `groups` is e.g. ['cameras', 'lighting']. */
export function itemsInGroups(items, groups) {
  const tests = groups.map(g => LOAD_GROUPS[g]).filter(Boolean);
  if (!tests.length) return [];
  return items.filter(i => !i.retired && tests.some(re => re.test(String(i.category || '').trim())));
}

/**
 * How much of a set of gear is spoken for, day by day.
 *
 * Counts distinct items, not bookings — a camera on two overlapping holds is
 * still one camera off the shelf, and counting bookings would overstate the
 * squeeze. Repairs count as unavailable, because a body in the shop is no
 * more use than one on a shoot.
 *
 * Pure, so the arithmetic can be checked without rendering anything.
 */
export function dailyLoad({ items, bookings, maintenance = [], days }) {
  const wanted = new Set(items.map(i => i.id));
  const total = wanted.size;

  return days.map(day => {
    const busy = new Set();

    for (const b of bookings) {
      if (day < b.start || day > b.end) continue;
      for (const id of b.item_ids) if (wanted.has(id)) busy.add(id);
    }
    for (const m of maintenance) {
      // An open ticket has no end — it is down from opened_on onwards.
      if (day < m.opened_on) continue;
      if (m.closed_on && day > m.closed_on) continue;
      if (wanted.has(m.item_id)) busy.add(m.item_id);
    }

    const used = busy.size;
    return { day, total, busy: used, free: total - used, ratio: total ? used / total : 0 };
  });
}

/**
 * Ratio to a band. Green means plenty free, red means it's going to be tight.
 *
 * The bands are uneven on purpose: the difference between a quarter and half
 * the cameras being out barely changes your plans, while the difference
 * between three quarters and all of them decides whether a shoot happens.
 */
export function loadLevel(ratio) {
  if (ratio <= 0) return 'free';
  if (ratio < 0.34) return 'easy';
  if (ratio < 0.6) return 'moderate';
  if (ratio < 0.85) return 'busy';
  return 'tight';
}

export const LOAD_LABEL = {
  free: 'all free',
  easy: 'plenty free',
  moderate: 'filling up',
  busy: 'getting tight',
  tight: 'very tight'
};

/* ------------------------------------------------------------ the schedule */

/**
 * Total distinct days covered by a set of ranges.
 * Overlapping and back-to-back ranges are merged, so a camera that goes out
 * Monday-Wednesday and again Wednesday-Friday counts as five days, not six.
 */
export function countDays(ranges) {
  if (!ranges.length) return 0;
  const sorted = [...ranges].sort((a, b) => a[0].localeCompare(b[0]));
  let total = 0;
  let [curStart, curEnd] = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= shift(curEnd, 1)) {          // overlapping or touching — extend
      if (e > curEnd) curEnd = e;
    } else {
      total += daysBetween(curStart, curEnd) + 1;
      curStart = s; curEnd = e;
    }
  }
  return total + daysBetween(curStart, curEnd) + 1;
}

/**
 * The stretches inside [from, to] that nothing covers.
 *
 * "When is it booked?" and "when is it free?" are the same question asked from
 * opposite ends, and the second one is what you actually need when someone
 * asks whether they can have a camera next week. Ranges are merged first, so
 * two overlapping loans don't manufacture a phantom gap between them.
 */
export function freeGaps({ ranges, from, to }) {
  const sorted = [...ranges]
    .filter(([s, e]) => e >= from && s <= to)
    .map(([s, e]) => [s < from ? from : s, e > to ? to : e])
    .sort((a, b) => a[0].localeCompare(b[0]));

  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (!last || s > shift(last[1], 1)) merged.push([s, e]);
    else if (e > last[1]) last[1] = e;
  }

  const gaps = [];
  let cursor = from;
  for (const [s, e] of merged) {
    if (s > cursor) gaps.push({ start: cursor, end: shift(s, -1) });
    const after = shift(e, 1);
    if (after > cursor) cursor = after;
  }
  if (cursor <= to) gaps.push({ start: cursor, end: to });
  return gaps;
}

/**
 * When is this gear spoken for, and when is it free?
 *
 * The board answers that visually, but "which days is the PYXIS out in
 * September?" is a list question, not a picture question — you want dates you
 * can read out on a phone call. One entry per item: its bookings in order,
 * the gaps between them, and what each adds up to. All clipped to the period,
 * so nothing reports days outside the range being asked about.
 *
 * Pure, so the arithmetic can be tested without rendering anything.
 */
export function itemSchedule({ items, bookings, from, to }) {
  const spanDays = daysBetween(from, to) + 1;

  return items.map(it => {
    const mine = bookings
      .filter(b => b.item_ids.includes(it.id) && overlaps(b.start, b.end, from, to))
      .map(b => ({
        ...b,
        clippedStart: b.start < from ? from : b.start,
        clippedEnd: b.end > to ? to : b.end,
        runsInFrom: b.start < from,
        runsOnPast: b.end > to
      }))
      .sort((a, b) => a.clippedStart.localeCompare(b.clippedStart) || a.id - b.id);

    const ranges = mine.map(b => [b.clippedStart, b.clippedEnd]);
    const gaps = freeGaps({ ranges, from, to });
    const days = countDays(ranges);

    return {
      item: it,
      bookings: mine,
      gaps,
      days,
      freeDays: spanDays - days,
      spanDays
    };
  });
}

/** Bookings that collide with a proposed window, for the conflict readout. */
export function collisions({ itemIds, start, end, bookings, ignore = [] }) {
  return bookings
    .filter(b => !ignore.includes(`${b.kind}:${b.id}`))
    .map(b => ({ ...b, shared: b.item_ids.filter(i => itemIds.includes(i)) }))
    .filter(b => b.shared.length && overlaps(start, end, b.start, b.end));
}

/* -------------------------------------------------------------- rendering */

function headerRow(days, today, cell, highlight = null) {
  const cells = days.map(d => {
    const p = parts(d);
    const weekend = p.dow === 0 || p.dow === 6;
    const inHi = highlight && d >= highlight.start && d <= highlight.end;
    return `<div class="tl-cell ${weekend ? 'weekend' : ''} ${d === today ? 'today' : ''} ${inHi ? 'hi' : ''}">
      <span class="tl-dow">${WEEKDAY[p.dow][0]}</span>
      <span class="tl-dom">${p.dom}</span>
      ${p.dom === 1 || d === days[0] ? `<span class="tl-mon">${p.mon}</span>` : ''}
    </div>`;
  }).join('');
  return `<div class="tl-row tl-header">
    <div class="tl-name tl-corner"></div>
    <div class="tl-track">${cells}</div>
  </div>`;
}

/**
 * The load strip: one cell per day, coloured by how much of the chosen gear is
 * spoken for. Sits directly under the date header so the colour lines up with
 * the column it describes.
 */
function heatRow({ load, label }) {
  const cells = load.map(d => {
    const level = loadLevel(d.ratio);
    const pct = Math.round(d.ratio * 100);
    return `<div class="tl-cell heat ${level}"
      title="${d.day} — ${d.busy} of ${d.total} out (${pct}%), ${d.free} free · ${LOAD_LABEL[level]}">
      <span class="heat-n">${d.free}</span>
    </div>`;
  }).join('');

  return `<div class="tl-row tl-heat">
    <div class="tl-name tl-heat-name">
      <span class="tl-name-t">${esc(label)}</span>
      <span class="tl-name-c">free / day</span>
    </div>
    <div class="tl-track">${cells}</div>
  </div>`;
}

function trackCells(days, today, { clickable = false, selection = null, highlight = null } = {}) {
  return days.map((d, i) => {
    const p = parts(d);
    const weekend = p.dow === 0 || p.dow === 6;
    const inSel = selection && d >= selection.start && d <= selection.end;
    const inHi = highlight && d >= highlight.start && d <= highlight.end;
    return `<div class="tl-cell ${weekend ? 'weekend' : ''} ${d === today ? 'today' : ''} ${inSel ? 'sel' : ''} ${inHi ? 'hi' : ''}"
      ${clickable ? `data-act="tl-pick" data-date="${d}" role="button" tabindex="0" aria-label="${d}"` : ''}
      style="--i:${i}"></div>`;
  }).join('');
}

function bars(bookings, days, today, { compact = false } = {}) {
  const from = days[0], to = days[days.length - 1];
  const { bookings: sorted, laneCount } = packLanes(
    bookings.filter(b => overlaps(b.start, b.end, from, to))
  );

  const html = sorted.map(b => {
    const s = Math.max(0, daysBetween(from, b.start));
    const e = Math.min(days.length - 1, daysBetween(from, b.end));
    const span = Math.max(1, e - s + 1);
    const clippedLeft = b.start < from;
    const clippedRight = b.end > to;
    const label = b._label != null
      ? esc(b._label)
      : compact
        ? esc(b.person_name)
        : `${esc(b.person_name)}${bookingLabel(b) ? ` · ${esc(bookingLabel(b))}` : ''}`;
    return `<button class="tl-bar ${barClass(b, today)} ${clippedLeft ? 'clip-l' : ''} ${clippedRight ? 'clip-r' : ''}"
      style="--s:${s};--n:${span};--lane:${b._lane}"
      data-act="tl-open" data-kind="${b.kind}" data-id="${b.id}"
      title="${esc(b.person_name)} · ${b.start} → ${b.end}${b.kind === 'reservation' ? ' (hold)' : ''}${b.returned ? ' (returned)' : ''}">
      <span class="tl-bar-t">${label}</span>
    </button>`;
  }).join('');

  return { html, laneCount };
}

/* ---------------------------------------------------------------- the board */

/**
 * The Calendar tab. One row per item that has activity in the window; the
 * whole fleet would be mostly empty rows, which buries the information.
 */
export function renderBoard({
  state, bookings, from, days, cell,
  scope = 'booked',            // 'booked' | 'outnow' | 'all'
  outNowIds = new Set(),
  itemFilter = () => true,
  highlight = null,
  heat = null
}) {
  const dayArr = dayList(from, days);
  const today = state.today;
  const windowEnd = dayArr[dayArr.length - 1];

  const active = new Set();
  bookings.forEach(b => {
    if (overlaps(b.start, b.end, from, windowEnd)) b.item_ids.forEach(i => active.add(i));
  });

  const inScope = i =>
    scope === 'all' ? true
    : scope === 'outnow' ? outNowIds.has(i.id)
    : active.has(i.id);

  const items = state.items
    .filter(i => !i.retired && itemFilter(i) && inScope(i))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  if (!items.length) {
    const note = `<div class="empty">${
      scope === 'outnow' ? 'Nothing is checked out right now.'
      : scope === 'all' ? 'No gear matches these filters.'
      : 'Nothing is out or booked in this window. Switch to "Every item" to see the whole fleet.'
    }</div>`;
    // The load strip answers a different question from the rows, so keep it
    // even when nothing matches — "every camera is free all week" is the most
    // useful thing an empty board can tell you.
    return heat?.length
      ? `<div class="tl" style="--days:${days};--cell:${cell}px">
          ${headerRow(dayArr, today, cell, highlight)}
          ${heat.map(heatRow).join('')}
        </div>${note}`
      : note;
  }

  let lastCat = null;
  const rows = items.map(it => {
    const mine = bookings.filter(b => b.item_ids.includes(it.id));
    const { html, laneCount } = bars(mine, dayArr, today, { compact: true });
    const head = it.category !== lastCat
      ? `<div class="tl-cat"><span class="lbl">${esc(it.category)}</span></div>`
      : '';
    lastCat = it.category;
    return `${head}<div class="tl-row" style="--lanes:${laneCount}">
      <button class="tl-name" data-act="item" data-id="${it.id}" title="${esc(it.name)}">
        <span class="tl-name-t">${esc(it.name)}${flagTag(state.items, it)}</span>
        <span class="tl-name-c">${esc(it.code)}</span>
      </button>
      <div class="tl-track">${trackCells(dayArr, today, { highlight })}${html}</div>
    </div>`;
  }).join('');

  return `<div class="tl" style="--days:${days};--cell:${cell}px">
    ${headerRow(dayArr, today, cell, highlight)}
    ${(heat || []).map(heatRow).join('')}
    ${rows}
  </div>`;
}

/* ------------------------------------------------------- the checkout board */

const bookingGroup = (b, today) =>
  b.kind === 'reservation' ? 'Reserved'
  : b.returned ? 'Returned'
  : b.due < today ? 'Overdue'
  : 'Out on set';

const GROUP_ORDER = ['Overdue', 'Out on set', 'Reserved', 'Returned'];

/**
 * The same window, but a row per checkout rather than a row per item.
 *
 * The item view answers "when is this camera free?". This one answers "what
 * went out on Thursday, and what was on it?" — which is the question you have
 * when someone returns a case and you need to know what should be in it.
 * Clicking a row opens the whole order, whatever day it belongs to.
 */
export function renderCheckoutBoard({
  state, bookings, from, days, cell, itemFilter = () => true, highlight = null, heat = null
}) {
  const dayArr = dayList(from, days);
  const today = state.today;
  const windowEnd = dayArr[dayArr.length - 1];
  const byId = new Map(state.items.map(i => [i.id, i]));

  const visible = bookings
    .filter(b => overlaps(b.start, b.end, from, windowEnd))
    .filter(b => b.item_ids.some(id => {
      const it = byId.get(id);
      return it && itemFilter(it);
    }))
    .sort((a, b) => {
      const ga = GROUP_ORDER.indexOf(bookingGroup(a, today));
      const gb = GROUP_ORDER.indexOf(bookingGroup(b, today));
      return ga - gb || a.start.localeCompare(b.start) || a.id - b.id;
    });

  if (!visible.length) {
    const note = '<div class="empty">No checkouts or holds in this window.</div>';
    return heat?.length
      ? `<div class="tl" style="--days:${days};--cell:${cell}px">
          ${headerRow(dayArr, today, cell, highlight)}
          ${heat.map(heatRow).join('')}
        </div>${note}`
      : note;
  }

  let lastGroup = null;
  const rows = visible.map(b => {
    const group = bookingGroup(b, today);
    const head = group !== lastGroup
      ? `<div class="tl-cat"><span class="lbl">${esc(group)}</span></div>`
      : '';
    lastGroup = group;

    const n = b.item_ids.length;
    // The person is already in the row label, so the bar carries the payload.
    const labelled = { ...b, _label: `${n} item${n === 1 ? '' : 's'}` };
    const { html, laneCount } = bars([labelled], dayArr, today);

    // Same lead as bookingHeaderMeta in app.js: the project is what someone's
    // scanning this board for, not who booked it — falls back to the person,
    // then to a bare item count, when there's nothing more specific.
    const label = bookingLabel(b);
    const names = b.item_ids.map(id => byId.get(id)?.name).filter(Boolean).join(', ');
    return `${head}<div class="tl-row" style="--lanes:${laneCount}">
      <button class="tl-name" data-act="tl-open" data-kind="${b.kind}" data-id="${b.id}"
              title="${esc(names)}">
        <span class="tl-name-t">${esc(label || b.person_name)}</span>
        <span class="tl-name-c">${esc(label ? b.person_name : `${n} item${n === 1 ? '' : 's'}`)}</span>
      </button>
      <div class="tl-track">${trackCells(dayArr, today, { highlight })}${html}</div>
    </div>`;
  }).join('');

  return `<div class="tl" style="--days:${days};--cell:${cell}px">
    ${headerRow(dayArr, today, cell, highlight)}
    ${(heat || []).map(heatRow).join('')}
    ${rows}
  </div>`;
}

/* ---------------------------------------------------------------- the agenda */

const GROUP_SWATCH = { Overdue: 'late', 'Out on set': 'out', Reserved: 'res', Returned: 'done' };

/**
 * Bookings grouped by the day they touch, for a phone-sized agenda instead of
 * a wide grid. Days with nothing on them are left out — a run of "nothing
 * booked" between now and next month isn't useful; that's what the grid's
 * "Every item" scope already answers. Today is the one exception: dropping
 * it when it's empty would read as the day itself missing rather than as
 * good news, so it always appears, with an empty group list the render side
 * turns into "nothing booked today".
 *
 * A booking appears on every day it touches, same as a bar spans every
 * column it covers on the grid — `continuesFrom`/`continuesTo` say whether
 * that's the start/end or the middle of a longer run, so the render side can
 * mark it rather than repeat the full date range on each day.
 *
 * Pure, so the day-by-day grouping can be tested without rendering anything.
 */
export function agendaDays({ items, bookings, from, days, today, itemFilter = () => true }) {
  const byId = new Map(items.map(i => [i.id, i]));
  const relevant = bookings.filter(b => b.item_ids.some(id => {
    const it = byId.get(id);
    return it && itemFilter(it);
  }));

  return dayList(from, days).map(day => {
    const touching = relevant.filter(b => day >= b.start && day <= b.end);
    const groups = GROUP_ORDER
      .map(group => ({
        group,
        entries: touching
          .filter(b => bookingGroup(b, today) === group)
          .map(b => ({
            kind: b.kind, id: b.id, person_name: b.person_name,
            label: bookingLabel(b),
            itemNames: b.item_ids.map(id => byId.get(id)?.name).filter(Boolean),
            continuesFrom: b.start < day,
            continuesTo: b.end > day
          }))
          .sort((a, b) => (a.label || a.person_name).localeCompare(b.label || b.person_name))
      }))
      .filter(g => g.entries.length);
    return { day, isToday: day === today, groups };
  }).filter(d => d.groups.length || d.isToday);
}

/**
 * The Calendar tab's phone default. `renderBoard`/`renderCheckoutBoard` both
 * answer "what does the whole window look like at once", which needs columns
 * wide enough to read a date in — the one thing a phone screen doesn't have.
 * This answers "what's happening Wednesday" instead, which stacks.
 */
export function renderAgenda({ state, bookings, from, days, itemFilter = () => true }) {
  const grouped = agendaDays({
    items: state.items.filter(i => !i.retired), bookings, from, days,
    today: state.today, itemFilter
  });

  if (!grouped.length) return `<div class="empty">Nothing booked in this window.</div>`;

  return `<div class="panel sched agenda">${grouped.map(d => {
    const p = parts(d.day);
    return `<div class="agenda-day ${d.isToday ? 'today' : ''}">
      <div class="agenda-date">
        <span class="agenda-dow">${WEEKDAY[p.dow]}</span>
        <span class="agenda-dom">${p.mon} ${p.dom}</span>
        ${d.isToday ? '<span class="agenda-today-badge">Today</span>' : ''}
      </div>
      ${d.groups.length ? d.groups.map(g => `
        <div class="tl-cat"><span class="lbl">${esc(g.group)}</span></div>
        ${g.entries.map(e => {
          const n = e.itemNames.length;
          const primary = e.label || e.person_name;
          const secondary = e.label
            ? `${e.person_name}${n ? ` · ${e.itemNames.slice(0, 3).join(', ')}${n > 3 ? ` +${n - 3}` : ''}` : ''}`
            : `${e.itemNames.slice(0, 3).join(', ')}${n > 3 ? ` +${n - 3}` : ''}`;
          return `<button class="sched-row" data-act="tl-open" data-kind="${e.kind}" data-id="${e.id}">
            <i class="tl-swatch ${GROUP_SWATCH[g.group]}"></i>
            <span class="sched-when">${esc(primary)}${
              e.continuesFrom ? ' <span class="sched-cont">(from earlier)</span>' : ''}${
              e.continuesTo ? ' <span class="sched-cont">(continues)</span>' : ''}</span>
            <span class="sched-who">${esc(secondary)}</span>
            <span class="sched-len">${n} item${n === 1 ? '' : 's'}</span>
          </button>`;
        }).join('')}`).join('')
        : `<div class="agenda-none">Nothing booked ${d.isToday ? 'today' : 'this day'}.</div>`}
    </div>`;
  }).join('')}</div>`;
}

/* --------------------------------------------------------------- the picker */

/**
 * The scheduling-assistant view inside the checkout and reserve sheets.
 * Shows only the items being requested, the bookings already on them, and the
 * proposed window as a selection overlay. Tapping a day moves the window.
 */
export function renderPicker({ state, bookings, itemIds, start, end, from, days, cell, ignore = [] }) {
  const dayArr = dayList(from, days);
  const today = state.today;
  const selection = { start, end };

  if (!itemIds.length) {
    return `<div class="tl-hint">Pick gear below and its availability appears here.</div>`;
  }

  const relevant = bookings.filter(b => !ignore.includes(`${b.kind}:${b.id}`));
  const clashes = collisions({ itemIds, start, end, bookings: relevant, ignore });
  const clashItemIds = new Set(clashes.flatMap(c => c.shared));

  const rows = itemIds.map(id => {
    const it = state.items.find(x => x.id === id);
    if (!it) return '';
    const mine = relevant.filter(b => b.item_ids.includes(id));
    const { html, laneCount } = bars(mine, dayArr, today, { compact: true });
    return `<div class="tl-row ${clashItemIds.has(id) ? 'clash' : ''}" style="--lanes:${laneCount}">
      <div class="tl-name" title="${esc(it.name)}">
        <span class="tl-name-t">${esc(it.name)}${flagTag(state.items, it)}</span>
        <span class="tl-name-c">${esc(it.code)}</span>
      </div>
      <div class="tl-track">
        ${trackCells(dayArr, today, { clickable: true, selection })}
        ${html}
      </div>
    </div>`;
  }).join('');

  const length = Math.max(1, daysBetween(start, end) + 1);
  const opening = clashes.length
    ? firstOpening({ itemIds, length, bookings: relevant, from: today, ignore })
    : null;

  const status = clashes.length
    ? `<div class="tl-status bad">
        <span class="lbl">${clashes.length} conflict${clashes.length === 1 ? '' : 's'}</span>
        ${clashes.slice(0, 4).map(c => `<div class="tl-clash">
          ${c.kind === 'reservation' ? 'Held by' : 'Out with'} ${esc(c.person_name)},
          ${c.start} → ${c.end} · ${c.shared.length} item${c.shared.length === 1 ? '' : 's'}
        </div>`).join('')}
        ${clashes.length > 4 ? `<div class="tl-clash">…and ${clashes.length - 4} more</div>` : ''}
        ${opening ? `<button class="btn small" data-act="tl-apply"
            data-start="${opening.start}" data-end="${opening.end}" style="margin-top:8px">
            Next ${length}-day opening: ${opening.start} → ${opening.end}</button>`
          : `<div class="tl-clash">No ${length}-day opening in the next 60 days.</div>`}
      </div>`
    : `<div class="tl-status ok">
        <span class="lbl">Everything is free</span>
        ${start} → ${end} · ${length} day${length === 1 ? '' : 's'} · ${itemIds.length} item${itemIds.length === 1 ? '' : 's'}
      </div>`;

  return `
    <div class="tl-bar-head">
      <button class="btn small" data-act="tl-shift" data-by="-${days}">◀</button>
      <span class="tl-range">${dayArr[0]} → ${dayArr[dayArr.length - 1]}</span>
      <button class="btn small" data-act="tl-shift" data-by="${days}">▶</button>
    </div>
    <div class="tl picker" style="--days:${days};--cell:${cell}px">
      ${headerRow(dayArr, today, cell)}
      ${rows}
    </div>
    <div class="tl-hint">Tap a day to set the start, then tap again to set the end.</div>
    ${status}`;
}
