/**
 * The inventory summarised by category.
 *
 * The Gear tab used to open with one small rectangle per item. At two dozen
 * items that read as a cage you could take in at a glance; at 459 it's six
 * wrapped rows of texture — you can see that *something* is yellow without
 * being able to tell what, and a 9px hover target doesn't fix that.
 *
 * A category is the unit people actually think in ("have we got cameras
 * free?"), and there are eight of them rather than 459, so the same strip of
 * screen can carry counts, proportions and a place to click.
 *
 * Pure and dependency-free: `statusFor` is passed in so this can be tested
 * without a browser or a database.
 */

/* Worst-last, so a bar reads left to right from "on the shelf" to "gone".
   Keeping repair at the end means the eye lands on it, which is the point —
   it's the state nobody notices until they need the thing. */
export const SEGMENT_ORDER = ['ready', 'held', 'out', 'overdue', 'repair'];

const KNOWN = new Set(SEGMENT_ORDER);

/** Categories that always sort first, in this order. Matched case-insensitively. */
export const PINNED_CATEGORIES = ['cameras', 'lighting'];
const PINNED = PINNED_CATEGORIES;

/**
 * @param {object[]} items      inventory, retired entries ignored
 * @param {(item) => string} statusFor  one of SEGMENT_ORDER
 * @returns {object[]} one row per category, biggest first
 */
export function categoryBreakdown(items, statusFor) {
  const rows = new Map();

  for (const it of items || []) {
    if (!it || it.retired) continue;
    const category = String(it.category ?? '').trim() || 'Uncategorized';
    if (!rows.has(category)) {
      rows.set(category, {
        category, total: 0, unavailable: 0,
        ready: 0, held: 0, out: 0, overdue: 0, repair: 0
      });
    }
    const row = rows.get(category);
    row.total++;
    const status = statusFor(it);
    /* An unrecognised status is counted in the total but given no segment,
       rather than being quietly filed as available — a bar that doesn't quite
       fill is honest; one that says gear is free when it isn't is not. */
    if (KNOWN.has(status)) {
      row[status]++;
      if (status !== 'ready') row.unavailable++;
    }
  }

  /* Cameras and lighting lead regardless of size — they're what a shoot is
     planned around, and what people check first. Everything else falls in
     behind them biggest-first, so the shape of the list doesn't shuffle day
     to day as gear goes in and out. */
  const rank = c => {
    const i = PINNED.indexOf(String(c).trim().toLowerCase());
    return i === -1 ? PINNED.length : i;
  };
  return [...rows.values()].sort((a, b) =>
    rank(a.category) - rank(b.category)
    || b.total - a.total
    || a.category.localeCompare(b.category));
}

/** The segments to draw for one row, as percentages. Empty states are dropped. */
export function segments(row) {
  if (!row || !row.total) return [];
  return SEGMENT_ORDER
    .filter(s => row[s] > 0)
    .map(s => ({ status: s, count: row[s], pct: (row[s] / row.total) * 100 }));
}
