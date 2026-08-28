/**
 * A gear room with people in it.
 *
 * Four checkouts against 459 items looks like a system nobody uses — every
 * screen is empty, the calendar has three bars on it, and you can't tell
 * whether a feature works because there's nothing for it to work on. This
 * invents a fortnight either side of today: crew with gear out, some of it
 * late, holds stacking up for next month, and a repair queue.
 *
 * Two things it will not do:
 *
 *   - Double-book. Every allocation checks what that item is already
 *     committed to. `src/policy.js` would reject an impossible state, so
 *     generating one would make the demo look broken rather than busy.
 *   - Use anybody real. The crew are invented; only the gear is real.
 *
 * Deterministic, given the same items and date. Same demo on both machines,
 * and a test can assert on it.
 */

/* Small seeded PRNG. Nothing here needs cryptographic quality, but it does
   need to be repeatable — Math.random would reshuffle the demo on every
   reload and make a bug impossible to describe to anyone. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const iso = d => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => iso(new Date(Date.parse(dateStr + 'T12:00:00Z') + n * DAY));
const overlaps = (aS, aE, bS, bE) => aS <= bE && bS <= aE;

/* Invented. Checked against the real inventory export so none of them
   collides with a colleague who actually appears in it. */
export const CREW = [
  'Alex Rivera', 'Priya Raman', 'Marcus Webb', 'Jo Feldman',
  'Dana Whitfield', 'Tomas Lindqvist', 'Neve Sutherland', 'Idris Bello',
  'Cora Mendel', 'Rafe Okonkwo', 'Sylvie Bourne', 'Hugo Trent'
];

const PROJECTS = [
  'Weekend series', 'Baptism shoot', 'Staff headshots', 'Anniversary tribute',
  'Small groups promo', 'Easter promo', 'Volunteer interviews', 'Kids ministry spot',
  'Christmas rehearsal', 'Worship night', 'Testimony film', 'Campus b-roll',
  'Leadership podcast', 'Youth camp recap', 'Sermon bumper', 'Donor thank-you'
];

/** Roughly what a shoot takes out, by category. */
const SHOOT_SHAPES = [
  { Cameras: 1, Lenses: 2, Audio: 1, Lighting: 2, Stands: 2 },
  { Cameras: 1, Lenses: 1, Audio: 2 },
  { Cameras: 2, Lenses: 3, Lighting: 3, Stands: 3, 'Camera Stabilization': 1 },
  { Cameras: 1, Lenses: 1 },
  { Lighting: 4, Stands: 4, Accessories: 2 },
  { Cameras: 1, 'Camera Stabilization': 1, Lenses: 2, Accessories: 1 },
  { Audio: 3, Accessories: 1 }
];

export function simulateActivity({ items, today, seed = 20260805 }) {
  const rand = rng(seed);
  const pickOne = arr => arr[Math.floor(rand() * arr.length)];
  const intBetween = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

  const byCategory = {};
  for (const it of items) (byCategory[it.category] ||= []).push(it);
  const categories = Object.keys(byCategory);

  // itemId -> [[start, end], ...] already committed, so nothing double-books.
  const busy = new Map();
  const isFree = (id, start, end) =>
    !(busy.get(id) || []).some(([s, e]) => overlaps(start, end, s, e));
  const reserve = (id, start, end) => {
    if (!busy.has(id)) busy.set(id, []);
    busy.get(id).push([start, end]);
  };

  /** Gear for one booking, skipping anything already spoken for. */
  function gearFor(shape, start, end) {
    const chosen = [];
    for (const [category, count] of Object.entries(shape)) {
      const pool = byCategory[category] || byCategory[pickOne(categories)] || [];
      if (!pool.length) continue;
      let tries = 0;
      let found = 0;
      while (found < count && tries < pool.length * 2) {
        const it = pool[Math.floor(rand() * pool.length)];
        tries++;
        if (chosen.includes(it.id) || !isFree(it.id, start, end)) continue;
        chosen.push(it.id);
        found++;
      }
    }
    chosen.forEach(id => reserve(id, start, end));
    return chosen;
  }

  const people = [
    { id: 1, email: 'demo@thecage.local', name: 'Demo User', role: 'admin', blocked: false, blocked_reason: null, placeholder: false },
    ...CREW.map((name, i) => ({
      id: i + 2,
      email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com',
      name,
      role: i === 0 ? 'admin' : 'member',
      blocked: false, blocked_reason: null, placeholder: true
    }))
  ];
  const crewIds = people.filter(p => p.id !== 1).map(p => p.id);

  const checkouts = [];
  const reservations = [];
  const maintenance = [];
  let coId = 0, resId = 0, mId = 0;

  /* ---- gear that is out right now ------------------------------------- */
  /* A spread of due dates so the board shows every state at once: overdue,
     due today, due tomorrow, and comfortably in the future. */
  const OPEN = [
    { out: -11, due: -5 }, { out: -9, due: -4 }, { out: -8, due: -2 },  // overdue
    { out: -4, due: 0 }, { out: -2, due: 0 },                            // due today
    { out: -3, due: 1 }, { out: -1, due: 1 },                            // due tomorrow
    { out: -5, due: 3 }, { out: -2, due: 4 }, { out: -1, due: 5 },
    { out: 0, due: 6 }, { out: -6, due: 7 }, { out: -1, due: 8 },
    { out: 0, due: 9 }
  ];

  for (const { out, due } of OPEN) {
    const start = addDays(today, out);
    const end = addDays(today, due);
    // Still out, so it holds the shelf until at least today however late.
    const held = end < today ? today : end;
    const ids = gearFor(pickOne(SHOOT_SHAPES), start, held);
    if (!ids.length) continue;
    checkouts.push({
      id: ++coId,
      holder_id: pickOne(crewIds),
      actor_id: 1,
      project: pickOne(PROJECTS),
      out_at: start,
      due_on: end,
      returned_at: null,
      note: '',
      item_ids: ids
    });
  }

  /* ---- history, so the calendar can look backwards --------------------- */
  for (let i = 0; i < 22; i++) {
    const out = -intBetween(12, 70);
    const span = intBetween(1, 6);
    const start = addDays(today, out);
    const end = addDays(today, out + span);
    if (end >= today) continue;                    // that's an open loan's job
    const ids = gearFor(pickOne(SHOOT_SHAPES), start, end);
    if (!ids.length) continue;
    checkouts.push({
      id: ++coId,
      holder_id: pickOne(crewIds),
      actor_id: 1,
      project: pickOne(PROJECTS),
      out_at: start,
      due_on: end,
      // Mostly back on time; occasionally a day or two late.
      returned_at: addDays(end, rand() < 0.75 ? 0 : intBetween(1, 2)) + 'T16:00:00Z',
      note: '',
      item_ids: ids
    });
  }

  /* ---- holds ----------------------------------------------------------- */
  for (let i = 0; i < 14; i++) {
    const start = addDays(today, intBetween(0, 40));
    const end = addDays(start, intBetween(1, 5));
    const ids = gearFor(pickOne(SHOOT_SHAPES), start, end);
    if (!ids.length) continue;
    reservations.push({
      id: ++resId,
      person_id: pickOne(crewIds),
      start_on: start,
      end_on: end,
      project: pickOne(PROJECTS),
      fulfilled_at: null,
      cancelled_at: null,
      item_ids: ids
    });
  }

  /* ---- the repair queue ------------------------------------------------ */
  const FAULTS = [
    ['Repair', 'Iris ring sticking at the wide end — away for service.'],
    ['Damage', 'Dented barn door, still usable. Replacement on order.'],
    ['Repair', 'Intermittent power. Suspect the D-tap cable, not the body.'],
    ['Service', 'Annual sensor clean.'],
    ['Damage', 'Cracked filter thread after a fall. Glass is fine.'],
    ['Repair', 'Left channel noisy above unity.']
  ];
  const downCandidates = items.filter(it => !busy.has(it.id));
  for (let i = 0; i < FAULTS.length && i < downCandidates.length; i++) {
    const it = downCandidates[Math.floor(rand() * downCandidates.length)];
    if (maintenance.some(m => m.item_id === it.id)) continue;
    const [kind, notes] = FAULTS[i];
    const opened = addDays(today, -intBetween(1, 20));
    const closed = i >= 4 ? addDays(opened, intBetween(2, 8)) : null;   // last two are closed
    maintenance.push({
      id: ++mId, item_id: it.id, kind, notes,
      opened_on: opened, closed_on: closed && closed < today ? closed : null,
      opened_by: 1
    });
  }

  /* ---- kits ------------------------------------------------------------ */
  const kitOf = (name, shape) => {
    const ids = [];
    for (const [category, count] of Object.entries(shape)) {
      const pool = byCategory[category] || [];
      for (let k = 0; k < count && k < pool.length; k++) {
        const it = pool[Math.floor(rand() * pool.length)];
        if (!ids.includes(it.id)) ids.push(it.id);
      }
    }
    return { name, item_ids: ids, type: 'package' };   // all four are hand-curated presets
  };
  const kits = [
    kitOf('Interview Kit', { Cameras: 1, Lenses: 2, Audio: 2, Stands: 1, Lighting: 2 }),
    kitOf('Run & Gun', { Cameras: 1, Lenses: 1, Audio: 1, Accessories: 1 }),
    kitOf('Doc Package', { Cameras: 1, Lenses: 3, 'Camera Stabilization': 1, Audio: 1 }),
    kitOf('Studio Lighting', { Lighting: 4, Stands: 4 })
  ].map((k, i) => ({ id: i + 1, ...k }));

  return { people, checkouts, reservations, maintenance, kits };
}
