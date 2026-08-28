/**
 * Fuzzy matching for the gear search.
 *
 * People don't type gear names the way the inventory spells them. They type
 * "sigma 1835", "canon 24-70", "mixpre", "camra". A plain substring filter
 * returns nothing for all four, and an empty list reads as "we don't own one"
 * rather than "you typed it differently".
 *
 * So: exact and prefix matches rank highest, then substrings, then
 * subsequences ("mxpre" -> "mixpre"), then single-character typos. Every token
 * in the query has to land somewhere, which is what stops a loose match
 * returning the whole cage.
 *
 * Pure and dependency-free so it can be unit tested without a browser.
 */

/** Lowercase, and treat punctuation as a word break: "18-35mm" -> "18 35mm". */
export const normalize = s =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Levenshtein distance, abandoned once it exceeds `max`.
 * Returns max + 1 rather than the true distance in that case — callers only
 * ever compare against the threshold, and bailing early keeps this cheap
 * enough to run over the whole inventory on every keystroke.
 */
export function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (!al) return bl;
  if (!bl) return al;

  let prev = Array.from({ length: bl + 1 }, (_, j) => j);
  for (let i = 1; i <= al; i++) {
    const cur = new Array(bl + 1);
    cur[0] = i;
    let best = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[bl];
}

/** Are all of `q`'s characters present in `t`, in order? */
export function isSubsequence(q, t) {
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (q[i] === t[j]) i++;
  }
  return i === q.length;
}

/** Score one query token against one word. 0 means no match at all. */
function tokenScore(q, word) {
  if (word === q) return 100;
  if (word.startsWith(q)) return 88;
  // A one-character substring matches almost everything — every asset code
  // here contains an "LC" — so a lone letter only counts as a prefix.
  if (q.length >= 2 && word.includes(q)) return 72;
  // Only allow looser matches once a token is long enough to be distinctive —
  // otherwise "a" matches everything and the ranking stops meaning anything.
  //
  if (q.length >= 3 && isSubsequence(q, word)) return 46;
  if (q.length >= 4) {
    const d = editDistance(q, word, 2);
    if (d <= 2) return 58 - d * 12;
  } else if (q.length >= 3) {
    if (editDistance(q, word, 1) <= 1) return 46;
  }
  return 0;
}

/**
 * Score a normalized query token list against one field.
 * Every token must match something, so "canon probe" doesn't match a Canon
 * lens that isn't a probe.
 */
export function scoreText(queryTokens, text) {
  const t = normalize(text);
  if (!t || !queryTokens.length) return 0;
  const words = t.split(' ');
  const squashed = t.replace(/ /g, '');

  let total = 0;
  for (const q of queryTokens) {
    let best = 0;
    for (const w of words) {
      const s = tokenScore(q, w);
      if (s > best) best = s;
      if (best === 100) break;
    }
    /* Also try the field as a whole, so a query that ignores the inventory's
       spacing ("1835", "rf2470", "lc110") still lands.

       These take the best score rather than only filling in for a miss. When
       they were a fallback of last resort, "lc110" scored 34 as a two-edit
       typo of the word "110" and that blocked the exact match on the squashed
       code — a weaker reading of the query masking a stronger one. */
    if (q.length >= 2 && t.includes(q)) best = Math.max(best, 64);
    if (q.length >= 2 && squashed.includes(q)) best = Math.max(best, 58);
    /* Scored to sit just under searchItems' cutoff once field weighting is
       applied. A six-letter subsequence of a whole concatenated record matches
       an awful lot of a 400-item inventory — harmless over two dozen items,
       but it buried the real hits here. It still lifts something that matched
       another way, without qualifying anything on its own. */
    if (q.length >= 4 && isSubsequence(q, squashed)) best = Math.max(best, 34);
    if (best === 0) return 0;
    total += best;
  }

  let score = total / queryTokens.length;
  if (t.startsWith(queryTokens.join(' '))) score += 12;
  return score;
}

/* Which fields to search, and how much a hit in each is worth. A match on the
   name beats a match on a serial number nobody remembers. */
const FIELDS = [
  ['name', 1],
  ['code', 0.96],
  ['brand', 0.82],
  ['model', 0.82],
  ['category', 0.7],
  ['serial', 0.6]
];

/** Best score for one item, 0 if nothing matched. */
export function scoreItem(item, query) {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!tokens.length) return 1;

  let best = 0;
  for (const [field, weight] of FIELDS) {
    const s = scoreText(tokens, item[field]) * weight;
    if (s > best) best = s;
  }

  // Also match across fields, so "canon 24-70" works when the brand and the
  // name each hold half of what was typed.
  const combined = scoreText(
    tokens,
    `${item.brand || ''} ${item.name || ''} ${item.model || ''} ${item.category || ''} ${item.code || ''}`
  ) * 0.94;

  return Math.max(best, combined);
}

/**
 * Filter and rank. An empty query returns everything untouched, so the caller
 * doesn't need to special-case it.
 */
export function searchItems(items, query, { min = 34 } = {}) {
  if (!normalize(query)) return items;
  return items
    .map(i => ({ i, s: scoreItem(i, query) }))
    .filter(x => x.s >= min)
    .sort((a, b) => b.s - a.s || String(a.i.name).localeCompare(String(b.i.name)))
    .map(x => x.i);
}

/**
 * Score a kit, by its own name and notes and by the gear inside it.
 *
 * Searching for the kit with the Sigma in it is at least as common as
 * remembering what you called it, so contained gear counts — but discounted,
 * so a kit actually named "Interview" outranks every kit that merely holds an
 * interview mic.
 */
export function scoreKit(kit, query, items = []) {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!tokens.length) return 1;

  let best = Math.max(scoreText(tokens, kit.name), scoreText(tokens, kit.notes) * 0.62);
  /* Only a light discount. Steeper (0.55) and an exact gear *code* scored 30.6
     against searchItems' cutoff of 34 — searching a kit by the code printed on
     something inside it found nothing at all. */
  for (const it of items) {
    const s = scoreItem(it, query) * 0.8;
    if (s > best) best = s;
  }
  return best;
}

/**
 * Score a reservation by who booked it, what it's for, and the gear on it.
 *
 * Gear is discounted the same way kits discount their contents, so a hold
 * whose project is called "Orbiter" outranks the twelve that merely contain
 * one — but only lightly, because searching a booking by a piece of kit on it
 * is exactly what the box is for.
 */
export function scoreReservation(res, query, items = []) {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!tokens.length) return 1;

  let best = Math.max(
    scoreText(tokens, res.person_name),
    scoreText(tokens, res.person_email) * 0.9,
    scoreText(tokens, res.project) * 0.95
  );
  for (const it of items) {
    const s = scoreItem(it, query) * 0.8;
    if (s > best) best = s;
  }
  return best;
}

/** Filter and rank reservations. `itemsFor` resolves a hold's gear. */
export function searchReservations(list, query, { itemsFor = () => [], min = 34 } = {}) {
  if (!normalize(query)) return list;
  return list
    .map(r => ({ r, s: scoreReservation(r, query, itemsFor(r)) }))
    .filter(x => x.s >= min)
    .map(x => x.r);
}

/* ------------------------------------------------- interchangeable units */

/**
 * Strip the trailing unit number from a name: "GAT C-Stand #4" and
 * "Arri Orbiter-7" are one of several identical things, and the number is
 * which one, not what it is.
 *
 * The cap is what makes this safe. "Sigma 18-35" would otherwise reduce to
 * "Sigma 18" and match an 18-50 — a different lens offered as an identical
 * spare. Unit counts are small (the largest family in this inventory is 12)
 * and focal lengths are not, so a trailing number above 30 is treated as part
 * of the name. It costs nothing: a cage with 31 of anything can still swap
 * units 1 to 30.
 */
export const MAX_UNIT_NUMBER = 30;

export function baseName(name) {
  const s = String(name ?? '').trim();
  const m = /^(.*?)[\s]*[-#][\s]*(\d{1,3})$/.exec(s);
  if (!m) return normalize(s);
  return Number(m[2]) <= MAX_UNIT_NUMBER ? normalize(m[1]) : normalize(s);
}

/**
 * Are these two the same thing, differing only in which unit it is?
 *
 * Name-led on purpose. The model field in a real export is inconsistent —
 * the same lens appears as "RF 15-35" and "RF 15-35mm f/2.8 L", and one row's
 * model contradicts its own name — so requiring models to match would refuse
 * genuine spares, and trusting models alone would offer wrong ones. The name
 * carries the full spec and is the field people actually maintain.
 */
export function interchangeable(a, b) {
  if (!a || !b || a.id === b.id || b.retired) return false;
  if (normalize(a.category) !== normalize(b.category)) return false;
  // Brands only have to agree when both are filled in; the export has gaps.
  const ba = normalize(a.brand), bb = normalize(b.brand);
  if (ba && bb && ba !== bb) return false;
  const base = baseName(a.name);
  return Boolean(base) && base === baseName(b.name);
}

/**
 * Spares for an item that isn't available, best first.
 *
 * `isFree` is passed in rather than worked out here so this stays pure and
 * so the caller decides what "free" means — checking out now and reserving a
 * future window are different questions.
 */
export function swapCandidates(target, items, { isFree = () => true, limit = 3 } = {}) {
  if (!target) return [];
  return items
    .filter(i => interchangeable(target, i) && isFree(i))
    // Same name beats a same-family sibling; then lowest unit number, so
    // suggestions are stable rather than reshuffling on every repaint.
    .map(i => ({ i, exact: normalize(i.name) === normalize(target.name) ? 1 : 0 }))
    .sort((a, b) => b.exact - a.exact
      || String(a.i.name).localeCompare(String(b.i.name), undefined, { numeric: true })
      || String(a.i.code).localeCompare(String(b.i.code)))
    .slice(0, limit)
    .map(x => x.i);
}

/**
 * Whether a blocked pick represents real unmet demand for a usage report, or
 * whether there was a same-family spare sitting free instead — someone who
 * hits "no Sigma 18-35, but here's another one" and takes it wasn't denied
 * gear, they just didn't get the exact unit they first clicked. Reuses
 * swapCandidates' own definition of "close enough to offer as a spare" on
 * purpose, so a miss here means the same thing the picker's own "no spare to
 * offer" message already means.
 *
 * `hasConflict` is supplied rather than worked out here for the same reason
 * swapCandidates' isFree is: what counts as "conflicting" depends on the
 * window being asked about, which is the caller's question to answer, not
 * this function's.
 */
export function isUnmetDemand(target, items, { hasConflict = () => false } = {}) {
  return swapCandidates(target, items, { isFree: i => !hasConflict(i) }).length === 0;
}

/** Filter and rank kits. `itemsFor` resolves a kit's gear, ids being local. */
export function searchKits(kits, query, { itemsFor = () => [], min = 34 } = {}) {
  if (!normalize(query)) return kits;
  return kits
    .map(k => ({ k, s: scoreKit(k, query, itemsFor(k)) }))
    .filter(x => x.s >= min)
    .sort((a, b) => b.s - a.s || String(a.k.name).localeCompare(String(b.k.name)))
    .map(x => x.k);
}
