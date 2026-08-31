/**
 * The whole backend, in the browser.
 *
 * The single-file build has no server and no Postgres, so this stands in for
 * `/api`: the same URLs, the same request bodies, the same response shapes,
 * the same errors. `app.js` can't tell the difference — it calls
 * `globalThis.__CAGE_LOCAL` instead of `fetch` and everything else is
 * unchanged.
 *
 * The rules come from `src/policy.js`, the same module the real server runs,
 * so a block here is a block there. What's missing is everything a shared
 * database gives you: this data lives in one browser's localStorage, so two
 * people opening the file see two separate cages, and there is no locking
 * because there is nobody to race with.
 *
 * Reset it from the console with:  cageReset()
 */
import {
  evaluateCheckout, reservationConflicts, shiftDays,
  kitVisibleTo, kitEditableBy, kitDeletableBy, duplicateKit
} from './policy.js';
import { DEMO_ITEMS } from './demo-data.js';
import { simulateActivity } from './demo-activity.js';
import { REAL_ACTIVITY } from './real-activity-data.js';

const KEY = 'the-cage-demo-v1';

/* ---------------------------------------------------------------- helpers */

const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shift = (dateStr, days) => shiftDays(dateStr, days);
const nowISO = () => new Date().toISOString();

let DB = null;

/**
 * Real reservations and checkouts, anonymized — see make-real-activity.js.
 * Every real person is a stable tag ("Member A") instead of a name or email;
 * gear is matched back to the local item list by code. Maintenance and kits
 * aren't part of the export yet, so they're empty here.
 */
function realActivity(items) {
  const codeToId = new Map(items.map(it => [it.code, it.id]));
  const withIds = codes => codes.map(c => codeToId.get(c)).filter(Boolean);

  const people = [
    { id: 1, email: 'demo@thecage.local', name: 'Demo User', role: 'admin', blocked: false, blocked_reason: null },
    ...REAL_ACTIVITY.people.map((p, i) => ({
      id: i + 2, email: '', name: p.tag,
      role: p.role === 'admin' ? 'admin' : 'member',
      blocked: false, blocked_reason: null
    }))
  ];
  const idForTag = new Map(REAL_ACTIVITY.people.map((p, i) => [p.tag, i + 2]));

  let coId = 0, resId = 0;
  const checkouts = REAL_ACTIVITY.checkouts
    .map(c => ({ ...c, item_ids: withIds(c.item_codes) }))
    .filter(c => c.item_ids.length)
    .map(c => ({
      id: ++coId, holder_id: idForTag.get(c.holder_tag) ?? 1, actor_id: 1,
      project: c.project || c.shoot || '', out_at: c.out_at, due_on: c.due_on,
      returned_at: c.returned_at ? `${c.returned_at}T16:00:00Z` : null,
      note: '', item_ids: c.item_ids
    }));

  const reservations = REAL_ACTIVITY.reservations
    .map(r => ({ ...r, item_ids: withIds(r.item_codes) }))
    .filter(r => r.item_ids.length)
    .map(r => ({
      id: ++resId, person_id: idForTag.get(r.person_tag) ?? 1,
      start_on: r.start_on, end_on: r.end_on, project: r.project || r.shoot || '',
      fulfilled_at: null, cancelled_at: null, item_ids: r.item_ids
    }));

  return { people, checkouts, reservations, maintenance: [], kits: [] };
}

/* ------------------------------------------------------------------- seed */

function seed() {
  const t = todayISO();

  /* The real inventory, minus anything personal — see make-demo-data.js. */
  const items = DEMO_ITEMS.map((g, i) => ({
    id: i + 1,
    code: g.code, name: g.name, category: g.category,
    brand: g.brand, model: g.model, serial: '', notes: g.notes || '',
    retired: false
  }));

  /* A real snapshot (make-real-activity.js) takes priority when there is
     one. Until it's been generated at least once, fall back to invented
     activity around a made-up crew, generated rather than hardcoded so it
     stays plausible whatever the inventory happens to contain — deterministic
     for a given day, so both machines show the same cage. */
  const hasRealActivity = REAL_ACTIVITY.checkouts.length > 0 || REAL_ACTIVITY.reservations.length > 0;
  const { people, checkouts, reservations, maintenance, kits } = hasRealActivity
    ? realActivity(items)
    : simulateActivity({ items, today: t });

  return {
    people, items, kits, checkouts, reservations, maintenance,
    settings: {
      enforce_availability: 'true',
      enforce_reservations: 'true',
      block_overdue_borrowers: 'true',
      overdue_grace_days: '0',
      default_loan_days: '3',
      escalate_after_days: '3',
      send_receipts: 'true',
      reminder_hour: '8'
    },
    seq: {
      people: people.length,
      items: items.length,
      kits: kits.length,
      checkouts: checkouts.length,
      reservations: reservations.length,
      maintenance: maintenance.length
    },
    seededOn: t
  };
}

/* -------------------------------------------------------------- persistence */

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* private mode, corrupt data — fall through and re-seed */ }
  return null;
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(DB)); }
  catch { /* storage full or blocked — the session still works in memory */ }
}

/**
 * Demo dates are relative to the day it was seeded. Left alone for a fortnight
 * the "overdue" loan becomes ancient and the holds all fall in the past, which
 * makes the demo look broken rather than lived-in. Re-seed if the day moved.
 */
function init() {
  const saved = load();
  DB = saved && saved.seededOn === todayISO() ? saved : seed();
  save();
}

/* ------------------------------------------------------------------ lookups */

const person = id => DB.people.find(p => p.id === Number(id));
const item = id => DB.items.find(i => i.id === Number(id));
const personName = p => (p?.name || p?.email || 'someone');
const nextId = key => (DB.seq[key] = (DB.seq[key] || 0) + 1);

const ME = () => DB.people.find(p => p.email === 'demo@thecage.local') || DB.people[0];

const openCheckouts = () => DB.checkouts.filter(c => !c.returned_at);
const liveReservations = () => DB.reservations.filter(r => !r.cancelled_at && !r.fulfilled_at);
const openMaintenance = () => DB.maintenance.filter(m => !m.closed_on);

/** Shaped exactly like the rows the API's policy query returns. */
function policyContext() {
  return {
    openCheckouts: openCheckouts().map(c => ({
      id: c.id, holder_id: c.holder_id, due_on: c.due_on, out_at: c.out_at,
      project: c.project, kit_id: c.kit_id ?? null,
      holder_name: personName(person(c.holder_id)),
      holder_email: person(c.holder_id)?.email,
      item_ids: [...c.item_ids]
    })),
    reservations: liveReservations()
      .filter(r => r.end_on >= shift(todayISO(), -1))
      .map(r => ({
        id: r.id, person_id: r.person_id, start_on: r.start_on, end_on: r.end_on,
        project: r.project, kit_id: r.kit_id ?? null,
        person_name: personName(person(r.person_id)),
        person_email: person(r.person_id)?.email,
        item_ids: [...r.item_ids]
      })),
    openMaintenance: openMaintenance().map(m => ({
      id: m.id, item_id: m.item_id, kind: m.kind, notes: m.notes, opened_on: m.opened_on
    })),
    settings: { ...DB.settings }
  };
}

function fail(status, error, extra = {}) {
  const err = new Error(error);
  err.status = status;
  err.payload = { error, ...extra };
  throw err;
}

const ints = v => (Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger);

/* -------------------------------------------------------------------- routes */

function getState() {
  const ctx = policyContext();
  return {
    me: ME(),
    today: todayISO(),
    items: DB.items.map(i => ({ ...i })),
    kits: DB.kits.filter(k => kitVisibleTo(k, ME())).map(k => {
      const owner = DB.people.find(p => p.id === k.owner_id);
      return {
        ...k, item_ids: [...k.item_ids],
        owner_id: k.owner_id ?? null, shared: Boolean(k.shared),
        owner_name: owner?.name || '', owner_email: owner?.email || ''
      };
    }),
    people: DB.people.map(p => ({ ...p })),
    openCheckouts: ctx.openCheckouts,
    reservations: ctx.reservations,
    openMaintenance: ctx.openMaintenance,
    closedMaintenance: DB.maintenance.filter(m => m.closed_on).map(m => ({ ...m })),
    settings: ctx.settings
  };
}

function getCalendar(params) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const today = todayISO();
  const from = iso.test(params.get('from') || '') ? params.get('from') : today;
  const to = iso.test(params.get('to') || '') ? params.get('to') : shift(from, 27);
  if (to < from) fail(400, 'The end of the range is before the start.');

  const overlaps = (aS, aE, bS, bE) => aS <= bE && bS <= aE;
  const bookings = [];

  for (const c of DB.checkouts) {
    const returnedOn = c.returned_at ? String(c.returned_at).slice(0, 10) : null;
    // An open loan holds the shelf until it comes back, so an overdue one runs
    // to today rather than stopping at the date it missed.
    const end = returnedOn || (c.due_on < today ? today : c.due_on);
    if (!overlaps(c.out_at, end, from, to)) continue;
    bookings.push({
      kind: 'checkout', id: c.id, person_id: c.holder_id,
      person_name: personName(person(c.holder_id)),
      start: c.out_at, end, due: c.due_on,
      returned: Boolean(returnedOn), project: c.project, item_ids: [...c.item_ids]
    });
  }

  for (const r of liveReservations()) {
    if (!overlaps(r.start_on, r.end_on, from, to)) continue;
    bookings.push({
      kind: 'reservation', id: r.id, person_id: r.person_id,
      person_name: personName(person(r.person_id)),
      start: r.start_on, end: r.end_on, due: r.end_on,
      returned: false, project: r.project, item_ids: [...r.item_ids]
    });
  }

  return { from, to, today, bookings };
}

function evaluate({ holderId, itemIds, from, due, override }) {
  const holder = person(holderId);
  if (!holder) fail(400, 'That person is not in the system yet.');
  const rows = itemIds.map(id => item(id));
  const missing = itemIds.filter((id, i) => !rows[i]);
  if (missing.length) fail(400, `Unknown item id(s): ${missing.join(', ')}`);

  return {
    decision: evaluateCheckout({
      person: { ...holder, role: ME().role },
      items: rows, from, due, override, ...policyContext()
    }),
    holder, items: rows
  };
}

function createCheckout(body) {
  const cfg = DB.settings;
  const itemIds = ints(body.item_ids);
  const from = todayISO();
  const due = body.due_on || shift(from, Number(cfg.default_loan_days || 3));
  const holderId = Number(body.holder_id) || ME().id;
  const override = Boolean(body.override);

  const { decision } = evaluate({ holderId, itemIds, from, due, override });
  if (!decision.allowed) fail(409, 'Blocked', decision);

  const id = nextId('checkouts');
  DB.checkouts.push({
    id, holder_id: holderId, actor_id: ME().id, project: body.project || '',
    out_at: from, due_on: due, returned_at: null, note: body.note || '',
    item_ids: itemIds, kit_id: body.kit_id ? Number(body.kit_id) : null
  });
  if (decision.fulfils.length) {
    for (const r of DB.reservations) {
      if (decision.fulfils.includes(r.id)) r.fulfilled_at = nowISO();
    }
  }
  save();
  return { id, warnings: decision.warnings };
}

function returnCheckout(id, body) {
  const c = DB.checkouts.find(x => x.id === Number(id) && !x.returned_at);
  if (!c) fail(404, 'That checkout is already closed.');

  const partial = ints(body.item_ids);
  if (partial.length && partial.length < c.item_ids.length) {
    // Split return: the rest moves to a fresh open loan, same as the server.
    const remaining = c.item_ids.filter(i => !partial.includes(i));
    c.returned_at = nowISO();
    c.item_ids = c.item_ids.filter(i => partial.includes(i));
    DB.checkouts.push({
      id: nextId('checkouts'), holder_id: c.holder_id, actor_id: ME().id,
      project: c.project, out_at: c.out_at, due_on: c.due_on,
      returned_at: null, note: c.note, item_ids: remaining
    });
  } else {
    c.returned_at = nowISO();
  }
  save();
  return { ok: true };
}

function extendCheckout(id, body) {
  const due = String(body.due_on || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) fail(400, 'Give a due date as YYYY-MM-DD.');
  const c = DB.checkouts.find(x => x.id === Number(id) && !x.returned_at);
  if (!c) fail(404, 'No open checkout with that id.');

  const ctx = policyContext();
  const hits = reservationConflicts({
    itemIds: c.item_ids, start: todayISO(), end: due,
    reservations: ctx.reservations.filter(r => r.person_id !== c.holder_id),
    openCheckouts: []
  });
  if (hits.length && String(ctx.settings.enforce_reservations) === 'true' && ME().role !== 'admin') {
    fail(409, 'That would run into a reservation.', {
      blocks: hits.map(h => ({ code: 'reserved', message: `Held for ${h.person_name}, ${h.start} to ${h.end}.` }))
    });
  }
  c.due_on = due;
  save();
  return { ok: true, due_on: due };
}

function createReservation(body) {
  const itemIds = ints(body.item_ids);
  const start = String(body.start_on || '').slice(0, 10);
  const end = String(body.end_on || '').slice(0, 10);
  const personId = Number(body.person_id) || ME().id;

  if (!itemIds.length) fail(400, 'Pick at least one item.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    fail(400, 'Give both dates as YYYY-MM-DD.');
  }
  if (end < start) fail(400, 'The end date is before the start date.');

  const who = person(personId);
  if (who?.blocked && ME().role !== 'admin') {
    fail(409, 'Blocked', {
      blocks: [{
        code: 'person_blocked',
        message: who.blocked_reason
          ? `You're blocked from booking gear: ${who.blocked_reason}`
          : "You're blocked from booking gear. Talk to a cage admin."
      }]
    });
  }

  const ctx = policyContext();
  const hits = reservationConflicts({
    itemIds, start, end,
    reservations: ctx.reservations, openCheckouts: ctx.openCheckouts
  });
  const forcing = Boolean(body.force) && ME().role === 'admin';
  if (hits.length && !forcing) {
    fail(409, 'Double-booked', {
      blocks: hits.map(h => ({
        code: h.kind === 'checkout' ? 'already_out' : 'reserved',
        item_ids: h.item_ids,
        message: `${h.kind === 'checkout' ? 'Out with' : 'Held for'} ${h.person_name}, ${h.start} to ${h.end}.`
      }))
    });
  }

  const id = nextId('reservations');
  DB.reservations.push({
    id, person_id: personId, start_on: start, end_on: end,
    project: body.project || '', fulfilled_at: null, cancelled_at: null,
    item_ids: itemIds, kit_id: body.kit_id ? Number(body.kit_id) : null
  });
  save();
  return { id };
}

function runReminders() {
  // No mail in the browser, so this reports what would have gone out.
  const today = todayISO();
  const sent = [];
  for (const r of liveReservations()) {
    if (r.start_on === today && r.item_ids.length) sent.push(`pickup → ${person(r.person_id)?.email}`);
  }
  for (const c of openCheckouts()) {
    if (!c.item_ids.length) continue;
    const p = person(c.holder_id);
    if (c.due_on === shift(today, 1)) sent.push(`due-tomorrow → ${p?.email}`);
    else if (c.due_on === today) sent.push(`due-today → ${p?.email}`);
    else if (c.due_on < today) sent.push(`overdue → ${p?.email}`);
  }
  sent.push('digest → demo@thecage.local');
  return { today, sent, note: 'Nothing was actually emailed — this build has no mail.' };
}

/* --------------------------------------------------------------- the router */

const ROUTES = [
  ['GET',    /^\/auth\/me$/,                       () => ({ person: ME(), auth_disabled: true })],
  ['POST',   /^\/auth\/signout$/,                  () => ({ ok: true })],

  ['GET',    /^\/api\/state$/,                     () => getState()],
  ['GET',    /^\/api\/calendar$/,                  (m, b, params) => getCalendar(params)],
  ['GET',    /^\/api\/history\/(\d+)$/,            (m) => ({
    history: DB.checkouts
      .filter(c => c.item_ids.includes(Number(m[1])))
      .sort((a, b2) => b2.out_at.localeCompare(a.out_at))
      .slice(0, 20)
      .map(c => ({
        id: c.id, out_at: c.out_at,
        returned_at: c.returned_at ? String(c.returned_at).slice(0, 10) : null,
        due_on: c.due_on, project: c.project,
        name: person(c.holder_id)?.name, email: person(c.holder_id)?.email
      }))
  })],

  ['POST',   /^\/api\/checkouts\/preflight$/,      (m, body) => {
    const cfg = DB.settings;
    const from = body.from || todayISO();
    return evaluate({
      holderId: Number(body.holder_id) || ME().id,
      itemIds: ints(body.item_ids),
      from,
      due: body.due_on || shift(from, Number(cfg.default_loan_days || 3)),
      override: Boolean(body.override)
    }).decision;
  }],
  ['POST',   /^\/api\/checkouts$/,                 (m, body) => createCheckout(body)],
  ['POST',   /^\/api\/checkouts\/(\d+)\/return$/,  (m, body) => returnCheckout(m[1], body)],
  ['POST',   /^\/api\/checkouts\/(\d+)\/extend$/,  (m, body) => extendCheckout(m[1], body)],

  ['POST',   /^\/api\/reservations$/,              (m, body) => createReservation(body)],
  ['DELETE', /^\/api\/reservations\/(\d+)$/,       (m) => {
    const r = DB.reservations.find(x => x.id === Number(m[1]));
    if (!r) fail(404, 'No such reservation.');
    r.cancelled_at = nowISO(); save(); return { ok: true };
  }],

  ['POST',   /^\/api\/maintenance$/,               (m, body) => {
    const itemId = Number(body.item_id);
    if (!Number.isInteger(itemId)) fail(400, 'Which item?');
    const id = nextId('maintenance');
    DB.maintenance.push({
      id, item_id: itemId, kind: body.kind || 'Repair', notes: body.notes || '',
      opened_on: todayISO(), closed_on: null, opened_by: ME().id
    });
    save(); return { id };
  }],
  ['POST',   /^\/api\/maintenance\/(\d+)\/close$/, (m) => {
    const t = DB.maintenance.find(x => x.id === Number(m[1]) && !x.closed_on);
    if (!t) fail(404, 'That ticket is already closed.');
    t.closed_on = todayISO(); save(); return { ok: true };
  }],

  ['POST',   /^\/api\/items$/,                     (m, body) => {
    if (!body.name || !body.code) fail(400, 'Name and code are both required.');
    const code = String(body.code).toUpperCase().trim();
    if (DB.items.some(i => i.code === code)) fail(409, 'That code is already in use.');
    const id = nextId('items');
    DB.items.push({
      id, code, name: body.name, category: body.category || 'Uncategorized',
      brand: body.brand || '', model: body.model || '', serial: body.serial || '',
      notes: body.notes || '', retired: false
    });
    save(); return { id };
  }],
  ['PATCH',  /^\/api\/items\/(\d+)$/,              (m, body) => {
    const it = item(m[1]);
    if (!it) fail(404, 'No such item.');
    for (const k of ['name','category','brand','model','serial','notes','code','retired']) {
      if (k in body) it[k] = k === 'code' ? String(body[k]).toUpperCase().trim() : body[k];
    }
    save(); return { ok: true };
  }],
  ['DELETE', /^\/api\/items\/(\d+)$/,              (m) => {
    const id = Number(m[1]);
    if (openCheckouts().some(c => c.item_ids.includes(id))) {
      fail(409, 'That item is out right now. Check it in first.');
    }
    const it = item(id);
    if (it) it.retired = true;
    save(); return { ok: true, retired: true };
  }],

  ['POST',   /^\/api\/kits$/,                      (m, body) => {
    if (!body.name) fail(400, 'Name the kit.');
    const id = nextId('kits');
    DB.kits.push({
      id, name: body.name, notes: body.notes || '', item_ids: ints(body.item_ids),
      owner_id: ME().id, shared: Boolean(body.shared), type: 'package'
    });
    save(); return { id };
  }],
  ['PUT',    /^\/api\/kits\/(\d+)$/,               (m, body) => {
    const k = DB.kits.find(x => x.id === Number(m[1]));
    if (!k) fail(404, 'No such kit.');
    if (!kitEditableBy(k, ME())) fail(403, "That kit belongs to someone else. Duplicate it and change your copy.");
    if (body.name) k.name = body.name;
    if (body.notes !== undefined) k.notes = body.notes;
    if (body.shared !== undefined) k.shared = Boolean(body.shared);
    k.item_ids = ints(body.item_ids);
    save(); return { ok: true };
  }],
  ['PATCH',  /^\/api\/kits\/(\d+)\/share$/,        (m, body) => {
    const k = DB.kits.find(x => x.id === Number(m[1]));
    if (!k) fail(404, 'No such kit.');
    if (!kitEditableBy(k, ME())) fail(403, 'Only the person who owns a kit can share it.');
    k.shared = Boolean(body.shared);
    save(); return { ok: true, shared: k.shared };
  }],
  ['POST',   /^\/api\/kits\/(\d+)\/duplicate$/,    (m) => {
    const k = DB.kits.find(x => x.id === Number(m[1]));
    if (!k) fail(404, 'No such kit.');
    if (!kitVisibleTo(k, ME())) fail(403, 'That kit is not shared with you.');
    const mine = DB.kits.filter(x => x.owner_id === ME().id).map(x => x.name);
    const copy = duplicateKit(k, ME(), mine);
    const id = nextId('kits');
    DB.kits.push({ id, ...copy });
    save(); return { id, name: copy.name };
  }],
  ['DELETE', /^\/api\/kits\/(\d+)$/,               (m) => {
    const k = DB.kits.find(x => x.id === Number(m[1]));
    if (k && !kitDeletableBy(k, ME())) fail(403, 'That kit belongs to someone else.');
    DB.kits = DB.kits.filter(x => x.id !== Number(m[1]));
    save(); return { ok: true };
  }],

  ['POST',   /^\/api\/people$/,                    (m, body) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Enter a valid email address.');
    if (DB.people.some(p => p.email === email)) fail(409, 'Someone with that email is already in the cage.');
    const id = nextId('people');
    DB.people.push({
      id, email, name: String(body.name || '').trim(),
      role: body.role === 'admin' ? 'admin' : 'member',
      blocked: false, blocked_reason: null, last_seen_at: null
    });
    save(); return { id };
  }],
  ['PATCH',  /^\/api\/people\/(\d+)$/,             (m, body) => {
    const p = person(m[1]);
    if (!p) fail(404, 'No such person.');
    if (p.id === ME().id && body.role && body.role !== 'admin') {
      fail(400, 'Promote someone else before demoting yourself.');
    }
    if ('name' in body) p.name = body.name;
    if ('role' in body) p.role = body.role === 'admin' ? 'admin' : 'member';
    if ('blocked' in body) p.blocked = Boolean(body.blocked);
    if ('blocked_reason' in body) p.blocked_reason = body.blocked_reason || null;
    save(); return { ok: true };
  }],
  ['PATCH',  /^\/api\/me$/,                        (m, body) => {
    if (!body.name) fail(400, 'Name cannot be blank.');
    ME().name = String(body.name).slice(0, 80);
    save(); return { ok: true };
  }],

  ['PUT',    /^\/api\/settings$/,                  (m, body) => {
    for (const [k, v] of Object.entries(body || {})) {
      if (k in DB.settings) DB.settings[k] = String(v);
    }
    save(); return { ok: true, settings: { ...DB.settings } };
  }],

  ['POST',   /^\/api\/tasks\/reminders\/manual$/,  () => runReminders()],
  ['POST',   /^\/api\/tasks\/reminders$/,          () => runReminders()],

  // CSV import needs a real database to match against and isn't worth
  // reimplementing for a browser-only demo — a clear message beats a raw
  // "no route" error.
  ['POST',   /^\/api\/import\/items$/,             () => fail(400, "CSV import needs the real app — this demo has no database behind it.")],
  ['POST',   /^\/api\/import\/orders$/,            () => fail(400, "CSV import needs the real app — this demo has no database behind it.")]
];

/** Same contract as `req()` in app.js: resolve with data, or throw with .status. */
function handle(method, url, body) {
  if (!DB) init();
  const [path, query = ''] = String(url).split('?');
  const params = new URLSearchParams(query);

  for (const [verb, pattern, fn] of ROUTES) {
    if (verb !== method) continue;
    const m = path.match(pattern);
    if (m) return fn(m, body || {}, params);
  }
  fail(404, `No route for ${method} ${path}`);
}

export function install() {
  init();
  globalThis.__CAGE_LOCAL = (method, url, body) =>
    new Promise((resolve, reject) => {
      // Async, so the client's loading states behave as they do against a
      // real server rather than resolving before the DOM has caught up.
      setTimeout(() => {
        try { resolve(handle(method, url, body)); }
        catch (err) { reject(err); }
      }, 0);
    });

  globalThis.cageReset = () => {
    DB = seed();
    save();
    location.reload();
  };
}
