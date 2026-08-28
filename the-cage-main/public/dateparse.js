/**
 * Parsing the calendar's "jump to a day" box.
 *
 * People type dates a dozen ways and none of them is wrong: "friday",
 * "aug 14", "8/14", "2026-08-14", "aug 14 - aug 20", "next week". Making them
 * learn one format to answer "what's happening then?" is a poor trade, so this
 * accepts the obvious ones and returns a plain day range.
 *
 * Ambiguity is resolved the way a US film team would read it — 8/14 is
 * August 14th — and a bare month or weekday resolves forward, since asking
 * about the schedule almost always means the one coming up.
 *
 * Pure and dependency-free, with `today` injected, so it can be tested without
 * a browser or a clock.
 */

const MONTHS = ['january','february','march','april','may','june','july',
                'august','september','october','november','december'];
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Days in a 1-based month. */
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Month arithmetic that clamps rather than overflowing: Jan 31 + 1 month = Feb 28. */
export function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = (y * 12) + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return iso(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export const startOfMonth = dateStr => dateStr.slice(0, 8) + '01';

export function monthLabel(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const name = MONTHS[m - 1];
  return `${name[0].toUpperCase()}${name.slice(1)} ${y}`;
}

const isRealDate = (y, m, d) =>
  m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m) && y >= 1970 && y <= 2999;

const monthIndex = word => {
  const w = word.replace(/\.$/, '');
  if (w.length < 3) return -1;
  return MONTHS.findIndex(m => m.startsWith(w));
};

const weekdayIndex = word => {
  if (word.length < 3) return -1;
  return WEEKDAYS.findIndex(d => d.startsWith(word));
};

/**
 * Pick the year for a date typed without one: the nearest sensible reading.
 * "jan 5" typed in December means next January, not eleven months ago.
 */
function inferYear(month, day, today) {
  const thisYear = Number(today.slice(0, 4));
  const candidates = [thisYear - 1, thisYear, thisYear + 1]
    .filter(y => isRealDate(y, month, day))
    .map(y => ({ y, d: iso(y, month, day) }));
  if (!candidates.length) return null;

  // Prefer the closest, breaking ties forward — asking about the schedule
  // usually means the one ahead.
  let best = null;
  for (const c of candidates) {
    const delta = Math.abs(Date.parse(c.d) - Date.parse(today));
    const forward = c.d >= today;
    if (!best || delta < best.delta - 1 || (Math.abs(delta - best.delta) <= 1 && forward && !best.forward)) {
      best = { ...c, delta, forward };
    }
  }
  return best.y;
}

/** One day. Returns YYYY-MM-DD or null. */
function parseSingle(raw, today) {
  const s = raw.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  if (s === 'today') return today;
  if (s === 'tomorrow') return addDays(today, 1);
  if (s === 'yesterday') return addDays(today, -1);

  let m;

  // 2026-08-14
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return isRealDate(y, mo, d) ? iso(y, mo, d) : null;
  }

  // 8/14 or 8/14/26 or 8-14 (month first)
  if ((m = s.match(/^(\d{1,2})[/](\d{1,2})(?:[/](\d{2,4}))?$/))) {
    const mo = +m[1], d = +m[2];
    let y = m[3] ? +m[3] : null;
    if (y !== null && y < 100) y += 2000;
    if (y === null) y = inferYear(mo, d, today);
    return y && isRealDate(y, mo, d) ? iso(y, mo, d) : null;
  }

  // aug 14 / august 14 2026
  if ((m = s.match(/^([a-z]{3,9}\.?) (\d{1,2})(?: (\d{4}))?$/))) {
    const mo = monthIndex(m[1]) + 1;
    if (mo > 0) {
      const d = +m[2];
      const y = m[3] ? +m[3] : inferYear(mo, d, today);
      return y && isRealDate(y, mo, d) ? iso(y, mo, d) : null;
    }
  }

  // 14 aug / 14 august 2026
  if ((m = s.match(/^(\d{1,2}) ([a-z]{3,9}\.?)(?: (\d{4}))?$/))) {
    const mo = monthIndex(m[2]) + 1;
    if (mo > 0) {
      const d = +m[1];
      const y = m[3] ? +m[3] : inferYear(mo, d, today);
      return y && isRealDate(y, mo, d) ? iso(y, mo, d) : null;
    }
  }

  // friday / next friday — the next one on or after today.
  if ((m = s.match(/^(?:next )?([a-z]{3,9})$/))) {
    const wd = weekdayIndex(m[1]);
    if (wd >= 0) {
      const todayDow = new Date(today + 'T12:00:00Z').getUTCDay();
      let delta = (wd - todayDow + 7) % 7;
      if (s.startsWith('next ') && delta === 0) delta = 7;
      return addDays(today, delta);
    }
  }

  return null;
}

/** A whole month: "august", "aug 2026", "2026-08". */
function parseMonth(raw, today) {
  const s = raw.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  let m, year, month;

  if ((m = s.match(/^([a-z]{3,9}\.?)(?: (\d{4}))?$/))) {
    const idx = monthIndex(m[1]);
    if (idx < 0) return null;
    month = idx + 1;
    year = m[2] ? +m[2] : inferYear(month, 1, today);
  } else if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) {
    year = +m[1]; month = +m[2];
  } else {
    return null;
  }

  if (!year || month < 1 || month > 12) return null;
  return { start: iso(year, month, 1), end: iso(year, month, daysInMonth(year, month)) };
}

const RANGE_SPLIT = /\s+(?:to|through|thru|until|till)\s+|\s*(?:\.\.+|–|—)\s*|\s+-\s+/;

/**
 * Parse whatever was typed into a day range.
 *
 * @returns {{start:string,end:string,label:string}|null}
 */
export function parseDayQuery(input, { today } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw || !today) return null;

  const lower = raw.toLowerCase().replace(/\s+/g, ' ');

  if (lower === 'this week' || lower === 'week') {
    const dow = new Date(today + 'T12:00:00Z').getUTCDay();
    const start = addDays(today, -dow);
    return { start, end: addDays(start, 6), label: 'This week' };
  }
  if (lower === 'next week') {
    const dow = new Date(today + 'T12:00:00Z').getUTCDay();
    const start = addDays(today, 7 - dow);
    return { start, end: addDays(start, 6), label: 'Next week' };
  }
  if (lower === 'this month' || lower === 'month') {
    const start = startOfMonth(today);
    const [y, mo] = start.split('-').map(Number);
    return { start, end: iso(y, mo, daysInMonth(y, mo)), label: monthLabel(start) };
  }

  // A single day, before splitting — otherwise "2026-08-14" looks like a range.
  const one = parseSingle(lower, today);
  if (one) return { start: one, end: one, label: one };

  const month = parseMonth(lower, today);
  if (month) return { ...month, label: monthLabel(month.start) };

  const parts = lower.split(RANGE_SPLIT).map(p => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    const a = parseSingle(parts[0], today);
    const b = parseSingle(parts[1], today);
    if (a && b) {
      const [start, end] = a <= b ? [a, b] : [b, a];
      return { start, end, label: `${start} → ${end}` };
    }
  }

  return null;
}
