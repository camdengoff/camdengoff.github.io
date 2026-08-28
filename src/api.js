import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { q, tx, settings, audit } from './db.js';
import {
  evaluateCheckout, reservationConflicts, shiftDays,
  kitVisibleTo, kitEditableBy, kitDeletableBy, duplicateKit,
  requestDecidableBy, requestCancellableBy, requestableItems, checkSwap,
  canAddGear, canManageContributors, contributorAddable,
  canRenameBooking, bookingLabels
} from './policy.js';
import { requireAuth, requireAdmin } from './auth.js';
import { send, templates } from './mailer.js';
import { runReminders, localToday } from './reminders.js';
import { importItems } from '../scripts/import-csv.js';
import { importOrders } from '../scripts/import-orders.js';
// Pure and dependency-free (see its own header), so it runs here exactly as
// it does in the browser — one definition of "close enough to offer as a
// spare" instead of two that could quietly drift apart.
import { isUnmetDemand } from '../public/search.js';

export const api = express.Router();

const bad = (res, status, error) => res.status(status).json({ error });
const ints = v => (Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger);

/* ------------------------------------------------------------ policy context */

/**
 * Everything the rules engine needs, one query per relation.
 *
 * `exec` matters: when this is called inside a transaction it MUST run on that
 * transaction's client, or the availability read happens on a different
 * connection and the advisory lock protects nothing. Sequential rather than
 * Promise.all for the same reason — a single client can't multiplex.
 */
async function policyContext(exec = q) {
  const [checkouts, reservations, maintenance, cfg] = [
    await exec(`SELECT c.id, c.holder_id, c.due_on::text AS due_on, c.out_at::date::text AS out_at,
              c.shoot, c.project, c.kit_id,
              COALESCE(NULLIF(p.name, ''), p.email) AS holder_name, p.email AS holder_email,
              COALESCE(array_agg(DISTINCT ci.item_id) FILTER (WHERE ci.item_id IS NOT NULL), '{}') AS item_ids,
              COALESCE(array_agg(DISTINCT bc.person_id) FILTER (WHERE bc.person_id IS NOT NULL), '{}') AS contributor_ids
       FROM checkouts c JOIN people p ON p.id = c.holder_id
       LEFT JOIN checkout_items ci ON ci.checkout_id = c.id
       LEFT JOIN booking_contributors bc ON bc.checkout_id = c.id
       WHERE c.returned_at IS NULL GROUP BY c.id, p.id`),
    await exec(`SELECT r.id, r.person_id, r.start_on::text AS start_on, r.end_on::text AS end_on,
              r.shoot, r.project, r.kit_id, r.series_id,
              COALESCE(NULLIF(p.name, ''), p.email) AS person_name, p.email AS person_email,
              COALESCE(array_agg(DISTINCT ri.item_id) FILTER (WHERE ri.item_id IS NOT NULL), '{}') AS item_ids,
              COALESCE(array_agg(DISTINCT bc.person_id) FILTER (WHERE bc.person_id IS NOT NULL), '{}') AS contributor_ids
       FROM reservations r JOIN people p ON p.id = r.person_id
       LEFT JOIN reservation_items ri ON ri.reservation_id = r.id
       LEFT JOIN booking_contributors bc ON bc.reservation_id = r.id
       WHERE r.cancelled_at IS NULL AND r.fulfilled_at IS NULL AND r.end_on >= CURRENT_DATE - 1
       GROUP BY r.id, p.id`),
    await exec(`SELECT id, item_id, kind, notes, opened_on::text AS opened_on
       FROM maintenance WHERE closed_on IS NULL`),
    await settings(exec)
  ];
  return {
    openCheckouts: checkouts.rows,
    reservations: reservations.rows,
    openMaintenance: maintenance.rows,
    settings: cfg
  };
}

/* Adding gear to a loan that's already overdue. The window is "out now, back
   when the loan is due" — but that due date is in the past, which
   evaluateCheckout reads as a backwards range and reports as a mistake. It
   isn't one: the same "an open loan runs to at least today" rule the calendar
   uses applies here. The real objection to an overdue loan is has_overdue,
   which still fires. */
const effectiveDue = due => (String(due) < localToday() ? localToday() : String(due));

/* ----------------------------------------------------------------- read state */

api.get('/state', requireAuth, async (req, res) => {
  const isAdmin = req.person.role === 'admin';
  const [items, kits, ctx, closedMaint, people, requests] = await Promise.all([
    // image_data itself never travels here — it's a photo, not JSON, and
    // bloating every /state fetch with a few hundred of them would be silly.
    // has_image is just enough for the client to know whether GET
    // /items/:id/image has anything to show.
    // watching: this person has an active (unnotified) watch on the item —
    // enough for the client to show "You'll hear about this one" instead of
    // the "Notify me" button, without a separate round trip per item.
    q(`SELECT id, code, name, category, brand, model, serial, notes, flag, retired,
              image_data IS NOT NULL AS has_image, image_version AS image_v,
              EXISTS (SELECT 1 FROM item_watchers iw
                      WHERE iw.item_id = items.id AND iw.person_id = $1 AND iw.notified_at IS NULL) AS watching
       FROM items ORDER BY category, name`, [req.person.id]),
    /* Only kits this person is allowed to see. The same rule lives in
       kitVisibleTo(); it's expressed in SQL here so a private kit never
       travels to a browser that would only have hidden it. */
    q(`SELECT k.id, k.name, k.notes, k.owner_id, k.shared, k.type,
              k.image_data IS NOT NULL AS has_image, k.image_version AS image_v,
              p.name AS owner_name, p.email AS owner_email,
              COALESCE(array_agg(ki.item_id) FILTER (WHERE ki.item_id IS NOT NULL), '{}') AS item_ids
       FROM kits k
       LEFT JOIN kit_items ki ON ki.kit_id = k.id
       LEFT JOIN people p ON p.id = k.owner_id
       WHERE k.shared OR k.owner_id IS NULL OR k.owner_id = $1
       GROUP BY k.id, p.name, p.email ORDER BY k.name`, [req.person.id]),
    policyContext(),
    q(`SELECT m.id, m.item_id, m.kind, m.notes,
              m.opened_on::text AS opened_on, m.closed_on::text AS closed_on
       FROM maintenance m
       WHERE m.closed_on IS NOT NULL
       ORDER BY m.closed_on DESC
       LIMIT 60`),
    // image_data never travels here either — has_image/image_v are enough
    // for the client to build the actual photo's URL when it wants it.
    isAdmin
      ? q(`SELECT id, email, name, role, blocked, blocked_reason, last_seen_at,
                  image_data IS NOT NULL AS has_image, image_version AS image_v
           FROM people ORDER BY name, email`)
      : q(`SELECT id, name, email,
                  image_data IS NOT NULL AS has_image, image_version AS image_v
           FROM people ORDER BY name, email`),
    /* Only requests this person has to act on or is waiting on. An admin can
       decide any of them, so they see the lot. */
    q(`SELECT gr.id, gr.checkout_id, gr.reservation_id, gr.requester_id, gr.holder_id,
              gr.item_ids, gr.note, gr.created_at,
              gr.kind, gr.offer_item_ids, gr.offer_checkout_id,
              gr.offer_reservation_id, gr.target_checkout_id, gr.target_reservation_id,
              COALESCE(NULLIF(rq.name, ''), rq.email) AS requester_name,
              COALESCE(NULLIF(h.name, ''), h.email)   AS holder_name
       FROM gear_requests gr
       JOIN people rq ON rq.id = gr.requester_id
       JOIN people h  ON h.id  = gr.holder_id
       WHERE gr.state = 'pending' AND ($2 OR gr.holder_id = $1 OR gr.requester_id = $1)
       ORDER BY gr.created_at DESC`, [req.person.id, isAdmin])
  ]);

  res.json({
    me: req.person,
    today: localToday(),
    items: items.rows,
    kits: kits.rows,
    people: people.rows,
    openCheckouts: ctx.openCheckouts,
    reservations: ctx.reservations,
    openMaintenance: ctx.openMaintenance,
    closedMaintenance: closedMaint.rows,
    requests: requests.rows,
    settings: ctx.settings
  });
});

/**
 * Normalised bookings for the timeline, across an arbitrary window.
 * Unlike /state this includes checkouts that have already come back, so the
 * calendar can look backwards as well as forwards.
 */
api.get('/calendar', requireAuth, async (req, res, next) => {
  try {
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    const from = iso.test(req.query.from || '') ? req.query.from : localToday();
    const to = iso.test(req.query.to || '') ? req.query.to : shiftDays(from, 27);
    if (to < from) return bad(res, 400, 'The end of the range is before the start.');

    const [checkouts, reservations] = await Promise.all([
      q(`SELECT c.id, c.shoot, c.project, c.out_at::date::text AS start_on,
                c.due_on::text AS end_on, c.returned_at::date::text AS returned_on,
                COALESCE(NULLIF(p.name, ''), p.email) AS person_name, p.id AS person_id,
                COALESCE(array_agg(ci.item_id) FILTER (WHERE ci.item_id IS NOT NULL), '{}') AS item_ids
         FROM checkouts c JOIN people p ON p.id = c.holder_id
         LEFT JOIN checkout_items ci ON ci.checkout_id = c.id
         WHERE c.out_at::date <= $2
           -- An open loan occupies the shelf until it comes back, so an overdue
           -- one runs to today, not to the due date it blew past. Without this
           -- the late gear drops off the board exactly when you need to see it.
           AND COALESCE(c.returned_at::date, GREATEST(c.due_on, $3::date)) >= $1
         GROUP BY c.id, p.id
         ORDER BY c.out_at`, [from, to, localToday()]),
      q(`SELECT r.id, r.shoot, r.project, r.start_on::text AS start_on, r.end_on::text AS end_on,
                COALESCE(NULLIF(p.name, ''), p.email) AS person_name, p.id AS person_id,
                r.fulfilled_at IS NOT NULL AS fulfilled,
                COALESCE(array_agg(ri.item_id) FILTER (WHERE ri.item_id IS NOT NULL), '{}') AS item_ids
         FROM reservations r JOIN people p ON p.id = r.person_id
         LEFT JOIN reservation_items ri ON ri.reservation_id = r.id
         WHERE r.cancelled_at IS NULL AND r.fulfilled_at IS NULL
           AND r.start_on <= $2 AND r.end_on >= $1
         GROUP BY r.id, p.id
         ORDER BY r.start_on`, [from, to])
    ]);

    res.json({
      from, to, today: localToday(),
      bookings: [
        ...checkouts.rows.map(c => ({
          kind: 'checkout', id: c.id, person_id: c.person_id, person_name: c.person_name,
          // A returned loan occupied the shelf only until it came back. An open
          // one occupies it until at least today, however overdue it is — `due`
          // keeps the real date, so the bar still colours as late.
          start: c.start_on,
          end: c.returned_on || (c.end_on < localToday() ? localToday() : c.end_on),
          due: c.end_on,
          returned: Boolean(c.returned_on), shoot: c.shoot, project: c.project, item_ids: c.item_ids
        })),
        ...reservations.rows.map(r => ({
          kind: 'reservation', id: r.id, person_id: r.person_id, person_name: r.person_name,
          start: r.start_on, end: r.end_on, due: r.end_on,
          returned: false, shoot: r.shoot, project: r.project, item_ids: r.item_ids
        }))
      ]
    });
  } catch (err) { next(err); }
});

api.get('/history/:itemId', requireAuth, async (req, res) => {
  const id = Number(req.params.itemId);
  const { rows } = await q(
    `SELECT c.id, c.out_at::date::text AS out_at, c.returned_at::date::text AS returned_at,
            c.due_on::text AS due_on, c.shoot, c.project, p.name, p.email
     FROM checkouts c JOIN checkout_items ci ON ci.checkout_id = c.id
     JOIN people p ON p.id = c.holder_id
     WHERE ci.item_id = $1 ORDER BY c.out_at DESC LIMIT 20`, [id]
  );
  res.json({ history: rows });
});

/* -------------------------------------------------------------- checkout flow */

async function buildEvaluation({ actor, holderId, itemIds, from, due, override, exec = q }) {
  const ctx = await policyContext(exec);
  const { rows: holderRows } = await exec(
    `SELECT id, email, name, role, blocked, blocked_reason FROM people WHERE id = $1`, [holderId]
  );
  const { rows: itemRows } = itemIds.length
    ? await exec(`SELECT id, code, name, retired FROM items WHERE id = ANY($1::int[])`, [itemIds])
    : { rows: [] };
  if (!holderRows.length) {
    const err = new Error('That person is not in the system yet.');
    err.status = 400; throw err;
  }
  const holder = holderRows[0];
  const missing = itemIds.filter(id => !itemRows.some(i => i.id === id));
  if (missing.length) {
    const err = new Error(`Unknown item id(s): ${missing.join(', ')}`);
    err.status = 400; throw err;
  }

  const decision = evaluateCheckout({
    person: { ...holder, role: actor.role },  // override authority comes from the actor
    items: itemRows, from, due, override,
    ...ctx
  });
  return { decision, holder, items: itemRows, ctx };
}

/**
 * Records unmet demand from a real submit attempt — never from the picker's
 * own live preview, which repaints constantly as someone just browses. Only
 * `already_out`/`reserved` item-level conflicts count; a bad date range or a
 * blocked person isn't "wanted gear that wasn't there". Fire-and-forget from
 * every call site — this is a report input, not something the person
 * checking gear out should ever wait on or see fail.
 */
async function logDemandMisses(conflicts, { kind, personId, start, end, ctx }) {
  const misses = conflicts.filter(c => c.item_id && (c.code === 'already_out' || c.code === 'reserved'));
  if (!misses.length) return;
  try {
    const { rows: allItems } = await q(
      'SELECT id, code, name, category, brand, retired FROM items WHERE retired = FALSE'
    );
    const hasConflict = candidate => reservationConflicts({
      itemIds: [candidate.id], start, end, reservations: ctx.reservations, openCheckouts: ctx.openCheckouts
    }).length > 0;
    for (const miss of misses) {
      const target = allItems.find(i => i.id === miss.item_id);
      if (target && isUnmetDemand(target, allItems, { hasConflict })) {
        await q(
          `INSERT INTO demand_misses (item_id, person_id, kind, wanted_from, wanted_to)
           VALUES ($1, $2, $3, $4, $5)`,
          [miss.item_id, personId, kind, start, end]
        );
      }
    }
  } catch (err) {
    console.error('logDemandMisses failed:', err);
  }
}

/* A reservation conflict hit is per overlapping booking, not per item —
   flattened to one entry per item before handing it to logDemandMisses,
   which reasons about individual items the same way a block from
   POST /checkouts does. */
const missesFromHits = hits => hits.flatMap(h =>
  h.item_ids.map(item_id => ({ item_id, code: h.kind === 'checkout' ? 'already_out' : 'reserved' }))
);

/** Dry run — powers the live "why can't I take this?" panel in the UI. */
api.post('/checkouts/preflight', requireAuth, async (req, res, next) => {
  try {
    const cfg = await settings();
    const itemIds = ints(req.body.item_ids);
    const from = req.body.from || localToday();
    const due = req.body.due_on || shiftDays(from, Number(cfg.default_loan_days || 3));
    const holderId = Number(req.body.holder_id) || req.person.id;
    if (holderId !== req.person.id && req.person.role !== 'admin') {
      return bad(res, 403, 'Only admins can check gear out on behalf of someone else.');
    }
    const { decision } = await buildEvaluation({
      actor: req.person, holderId, itemIds, from, due, override: Boolean(req.body.override)
    });
    res.json(decision);
  } catch (err) { next(err); }
});

api.post('/checkouts', requireAuth, async (req, res, next) => {
  try {
    const cfg = await settings();
    const itemIds = ints(req.body.item_ids);
    const from = localToday();
    const due = req.body.due_on || shiftDays(from, Number(cfg.default_loan_days || 3));
    const holderId = Number(req.body.holder_id) || req.person.id;
    const override = Boolean(req.body.override);
    const labels = bookingLabels(req.body);

    if (holderId !== req.person.id && req.person.role !== 'admin') {
      return bad(res, 403, 'Only admins can check gear out on behalf of someone else.');
    }
    if (override && req.person.role !== 'admin') {
      return bad(res, 403, 'Only admins can override a block.');
    }

    /* A label, not a claim — a bad or stale id from the client just means no
       label rather than a failed checkout, so it's looked up rather than
       trusted outright. */
    let kitId = null;
    if (req.body.kit_id) {
      const { rows: [k] } = await q('SELECT id FROM kits WHERE id = $1', [Number(req.body.kit_id)]);
      kitId = k?.id ?? null;
    }

    const result = await tx(async client => {
      /* Serialize checkout creation. Two people scanning the same body at the
         same moment would otherwise both pass the availability check before
         either insert landed. At this team size the contention cost is nil. */
      await client.query('SELECT pg_advisory_xact_lock(884422)');

      const exec = (text, params) => client.query(text, params);
      const { decision, holder, items, ctx } = await buildEvaluation({
        actor: req.person, holderId, itemIds, from, due, override, exec
      });
      if (!decision.allowed) return { blocked: decision, ctx, holder };

      const { rows: [co] } = await client.query(
        `INSERT INTO checkouts (holder_id, actor_id, shoot, project, due_on, note, kit_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [holderId, req.person.id, labels.shoot, labels.project, due, req.body.note || '', kitId]
      );
      for (const id of itemIds) {
        await client.query(
          'INSERT INTO checkout_items (checkout_id, item_id) VALUES ($1, $2)', [co.id, id]
        );
      }
      /* Teammates picked while building the checkout. Same transaction as the
         checkout itself — a loan that exists without the people who were
         meant to be on it is worse than one that failed outright. */
      for (const pid of ints(req.body.contributor_ids)) {
        if (pid === holderId) continue;          // the holder is already on it
        await client.query(
          `INSERT INTO booking_contributors (checkout_id, person_id, added_by)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [co.id, pid, req.person.id]
        );
      }
      if (decision.fulfils.length) {
        await client.query(
          `UPDATE reservations SET fulfilled_at = now() WHERE id = ANY($1::int[])`,
          [decision.fulfils]
        );
      }
      return { checkoutId: co.id, decision, holder, items, ctx };
    });

    // Gear swapped away from in the picker never reaches item_ids — that's
    // what a swap is — so the checks above never see it and never get a
    // chance to log the demand it represents. Checked independently of
    // whether the rest of this checkout was blocked, overridden, or went
    // through clean: the swapped-out item's own availability at this date
    // range doesn't depend on any of that.
    const swappedOutIds = ints(req.body.swapped_out);
    if (swappedOutIds.length) {
      const { rows: swappedItems } = await q(
        'SELECT id, code, name, retired FROM items WHERE id = ANY($1::int[])', [swappedOutIds]
      );
      const swapDecision = evaluateCheckout({
        person: { ...result.holder, role: req.person.role }, items: swappedItems, from, due, override: false, ...result.ctx
      });
      const swapMisses = [...swapDecision.blocks, ...swapDecision.warnings]
        .filter(c => c.item_id && (c.code === 'already_out' || c.code === 'reserved'));
      await logDemandMisses(swapMisses, {
        kind: 'checkout', personId: req.person.id, start: from, end: due, ctx: result.ctx
      });
    }

    if (result.blocked) {
      await logDemandMisses(result.blocked.blocks, {
        kind: 'checkout', personId: req.person.id, start: from, end: due, ctx: result.ctx
      });
      return res.status(409).json({ error: 'Blocked', ...result.blocked });
    }

    // An override let the checkout through anyway, but the conflict it waived
    // was still real at the moment it was asked for — that's exactly the
    // unmet demand this report exists to surface, so it's logged the same as
    // an outright block.
    await logDemandMisses(
      result.decision.warnings.filter(w => w.overridden),
      { kind: 'checkout', personId: req.person.id, start: from, end: due, ctx: result.ctx }
    );

    await audit(req.person.id, 'checkout', {
      checkout_id: result.checkoutId, holder_id: holderId, item_ids: itemIds, due,
      overridden: result.decision.warnings.filter(w => w.overridden).map(w => w.code)
    });

    if (String(cfg.send_receipts) === 'true') {
      const t = templates.receipt({
        person: result.holder, items: result.items, due, ...labels
      });
      send({ to: result.holder.email, ...t }).catch(e => console.error('receipt failed', e.message));
    }

    res.status(201).json({ id: result.checkoutId, warnings: result.decision.warnings });
  } catch (err) { next(err); }
});

/**
 * Rename a booking: what the shoot is called, and what project it's for.
 *
 * The two labels are the only thing on a booking that stays editable for its
 * whole life — a shoot gets retitled mid-week and the gear is usually already
 * out by then. Everything else about a loan is fixed once it exists.
 *
 * Both tables take the same two columns under the same rule, so one handler
 * serves both rather than two that could drift apart.
 */
for (const [path, table, ownerCol] of [
  ['checkouts', 'checkouts', 'holder_id'],
  ['reservations', 'reservations', 'person_id']
]) {
  api.patch(`/${path}/:id`, requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { rows } = await q(`SELECT id, ${ownerCol} FROM ${table} WHERE id = $1`, [id]);
      if (!rows.length) return bad(res, 404, 'No such booking.');
      if (!canRenameBooking(rows[0], req.person)) {
        return bad(res, 403, 'Only the person who made this booking can rename it.');
      }
      const labels = bookingLabels(req.body);
      await q(`UPDATE ${table} SET shoot = $2, project = $3 WHERE id = $1`,
        [id, labels.shoot, labels.project]);
      await audit(req.person.id, 'booking_rename', { kind: path, id, ...labels });
      res.json({ ok: true, ...labels });
    } catch (err) { next(err); }
  });
}

/* -------------------------------------------------------------- watchers */

/** Same three checks statusOf() runs client-side, reduced to one boolean —
    this only ever needs "can it go out right now", never which of the three
    reasons is stopping it. */
async function itemIsReadyNow(itemId) {
  const { rows: [row] } = await q(
    `SELECT
       NOT EXISTS (SELECT 1 FROM checkout_items ci JOIN checkouts c ON c.id = ci.checkout_id
                   WHERE ci.item_id = $1 AND c.returned_at IS NULL) AS free_of_checkout,
       NOT EXISTS (SELECT 1 FROM maintenance m WHERE m.item_id = $1 AND m.closed_on IS NULL) AS free_of_repair,
       NOT EXISTS (SELECT 1 FROM reservation_items ri JOIN reservations r ON r.id = ri.reservation_id
                   WHERE ri.item_id = $1 AND r.cancelled_at IS NULL AND r.fulfilled_at IS NULL
                     AND r.start_on <= CURRENT_DATE AND r.end_on >= CURRENT_DATE) AS free_of_hold
     WHERE $1 IS NOT NULL`,
    [itemId]
  );
  return Boolean(row?.free_of_checkout && row?.free_of_repair && row?.free_of_hold);
}

/**
 * Called after anything that might have just freed an item up — a check-in,
 * a maintenance close, a released hold. Cheap to call speculatively (one
 * ready-check per item, and it only goes further than that when someone's
 * actually waiting), so every call site just calls it rather than trying to
 * reason about whether this particular change could matter.
 *
 * One email per pending watcher, then notified_at is set no matter how the
 * send went — a bounced address or a misconfigured SMTP server shouldn't
 * turn into a retry attempt every single time something else touches this
 * item afterward.
 */
async function notifyWatchers(itemIds) {
  for (const itemId of [...new Set(itemIds)]) {
    if (!(await itemIsReadyNow(itemId))) continue;
    const { rows: watchers } = await q(
      `SELECT iw.id, p.email, p.name, i.name AS item_name, i.code
       FROM item_watchers iw
       JOIN people p ON p.id = iw.person_id
       JOIN items i ON i.id = iw.item_id
       WHERE iw.item_id = $1 AND iw.notified_at IS NULL`,
      [itemId]
    );
    for (const w of watchers) {
      try {
        await send({ to: w.email, ...templates.itemAvailable({ person: w, item: { name: w.item_name, code: w.code } }) });
      } catch (err) {
        console.error('watcher notify failed:', err);
      }
      await q('UPDATE item_watchers SET notified_at = now() WHERE id = $1', [w.id]);
    }
  }
}

api.post('/items/:id/watch', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await q(
      `INSERT INTO item_watchers (item_id, person_id) VALUES ($1, $2)
       ON CONFLICT (item_id, person_id) DO NOTHING`,
      [id, req.person.id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.delete('/items/:id/watch', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await q('DELETE FROM item_watchers WHERE item_id = $1 AND person_id = $2', [id, req.person.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/checkouts/:id/return', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await q(
      `SELECT c.id, c.holder_id, p.email, p.name FROM checkouts c
       JOIN people p ON p.id = c.holder_id
       WHERE c.id = $1 AND c.returned_at IS NULL`, [id]
    );
    if (!rows.length) return bad(res, 404, 'That checkout is already closed.');
    const co = rows[0];
    /* Taking gear off a loan is the holder's alone — admins included. Adding
       to someone's loan needs their say-so (that's what requests are for);
       removing from it would decide for them, and there's no request shape
       that makes that reversible. */
    if (co.holder_id !== req.person.id) {
      return bad(res, 403,
        `That gear is out with ${co.name || co.email}. Only they can check it in.`);
    }

    const { rows: allItems } = await q('SELECT item_id FROM checkout_items WHERE checkout_id = $1', [id]);
    const partial = ints(req.body.item_ids);
    const returnedIds = partial.length ? partial : allItems.map(r => r.item_id);
    if (partial.length) {
      // Split return: move the remaining items to a fresh open checkout.
      await tx(async client => {
        const { rows: all } = await client.query(
          'SELECT item_id FROM checkout_items WHERE checkout_id = $1', [id]
        );
        const remaining = all.map(r => r.item_id).filter(i => !partial.includes(i));
        await client.query('UPDATE checkouts SET returned_at = now() WHERE id = $1', [id]);
        await client.query(
          'DELETE FROM checkout_items WHERE checkout_id = $1 AND item_id = ANY($2::int[])',
          [id, remaining]
        );
        if (remaining.length) {
          const { rows: [next] } = await client.query(
            `INSERT INTO checkouts (holder_id, actor_id, project, due_on, note)
             SELECT holder_id, $2, project, due_on, note FROM checkouts WHERE id = $1 RETURNING id`,
            [id, req.person.id]
          );
          for (const itemId of remaining) {
            await client.query(
              'INSERT INTO checkout_items (checkout_id, item_id) VALUES ($1, $2)', [next.id, itemId]
            );
          }
        }
      });
    } else {
      await q('UPDATE checkouts SET returned_at = now() WHERE id = $1', [id]);
    }

    await audit(req.person.id, 'return', { checkout_id: id, item_ids: partial });
    // Not awaited — whoever's checking gear in shouldn't wait on however many
    // watcher emails that happens to send.
    notifyWatchers(returnedIds).catch(err => console.error('notifyWatchers failed:', err));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Add gear to an open checkout without closing it and opening a new one.
 * Removing gear is already covered by a partial /return — this is the other
 * half: someone grabbed a lens after the fact and it should join the same
 * due date, not become a whole separate loan.
 */
api.post('/checkouts/:id/items', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const itemIds = ints(req.body.item_ids);
    if (!itemIds.length) return bad(res, 400, 'Pick at least one item.');
    const override = Boolean(req.body.override);
    if (override && req.person.role !== 'admin') return bad(res, 403, 'Only admins can override a block.');

    const { rows } = await q(
      `SELECT holder_id, due_on::text AS due_on FROM checkouts WHERE id = $1 AND returned_at IS NULL`, [id]
    );
    if (!rows.length) return bad(res, 404, 'No open checkout with that id.');
    const co = rows[0];
    const { rows: crew } = await q(
      'SELECT person_id FROM booking_contributors WHERE checkout_id = $1', [id]);
    if (!canAddGear(co, req.person, crew.map(r => r.person_id))) {
      return bad(res, 403, "You're not on this checkout. Ask the holder to add you, or suggest the gear.");
    }

    const result = await tx(async client => {
      // Same lock checkout creation takes — adding gear is exactly that
      // check, run against the same shared state.
      await client.query('SELECT pg_advisory_xact_lock(884422)');
      const exec = (text, params) => client.query(text, params);
      const { decision } = await buildEvaluation({
        actor: req.person, holderId: co.holder_id, itemIds,
        from: localToday(), due: effectiveDue(co.due_on), override, exec
      });
      if (!decision.allowed) return { blocked: decision };

      for (const itemId of itemIds) {
        await client.query(
          'INSERT INTO checkout_items (checkout_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, itemId]
        );
      }
      if (decision.fulfils.length) {
        await client.query(
          `UPDATE reservations SET fulfilled_at = now() WHERE id = ANY($1::int[])`, [decision.fulfils]
        );
      }
      return { decision };
    });

    if (result.blocked) return res.status(409).json({ error: 'Blocked', ...result.blocked });

    await audit(req.person.id, 'checkout_add_items', { checkout_id: id, item_ids: itemIds });
    res.json({ ok: true, warnings: result.decision.warnings });
  } catch (err) { next(err); }
});

api.post('/checkouts/:id/extend', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const due = String(req.body.due_on || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return bad(res, 400, 'Give a due date as YYYY-MM-DD.');

    const { rows } = await q(
      `SELECT c.holder_id, COALESCE(array_agg(ci.item_id) FILTER (WHERE ci.item_id IS NOT NULL), '{}') AS item_ids
       FROM checkouts c LEFT JOIN checkout_items ci ON ci.checkout_id = c.id
       WHERE c.id = $1 AND c.returned_at IS NULL GROUP BY c.holder_id`, [id]
    );
    if (!rows.length) return bad(res, 404, 'No open checkout with that id.');
    if (rows[0].holder_id !== req.person.id && req.person.role !== 'admin') {
      return bad(res, 403, "You can only extend your own checkouts.");
    }

    // Don't let an extension quietly eat somebody's reservation.
    const ctx = await policyContext();
    const hits = reservationConflicts({
      itemIds: rows[0].item_ids, start: localToday(), end: due,
      reservations: ctx.reservations.filter(r => r.person_id !== rows[0].holder_id),
      openCheckouts: []
    });
    if (hits.length && String(ctx.settings.enforce_reservations) === 'true' && req.person.role !== 'admin') {
      return res.status(409).json({
        error: 'That would run into a reservation.',
        blocks: hits.map(h => ({
          code: 'reserved',
          message: `Held for ${h.person_name}, ${h.start} to ${h.end}.`
        }))
      });
    }

    await q('UPDATE checkouts SET due_on = $2 WHERE id = $1', [id, due]);
    await q(`DELETE FROM notifications WHERE kind IN ('due_tomorrow','due_today','overdue') AND ref = $1`, [String(id)]);
    await audit(req.person.id, 'extend', { checkout_id: id, due_on: due });
    res.json({ ok: true, due_on: due });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------- reservations */

api.post('/reservations', requireAuth, async (req, res, next) => {
  try {
    const itemIds = ints(req.body.item_ids);
    const start = String(req.body.start_on || '').slice(0, 10);
    const end = String(req.body.end_on || '').slice(0, 10);
    const personId = Number(req.body.person_id) || req.person.id;
    const labels = bookingLabels(req.body);

    if (!itemIds.length) return bad(res, 400, 'Pick at least one item.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return bad(res, 400, 'Give both dates as YYYY-MM-DD.');
    }
    if (end < start) return bad(res, 400, 'The end date is before the start date.');
    if (personId !== req.person.id && req.person.role !== 'admin') {
      return bad(res, 403, 'Only admins can reserve on behalf of someone else.');
    }
    // A blocked person can't check gear out, so they mustn't be able to hold it
    // either — otherwise blocking still lets them tie the fleet up. Admins can
    // still place a hold on someone's behalf, same as they can override a checkout.
    if (req.person.role !== 'admin') {
      const { rows: [who] } = await q(
        'SELECT blocked, blocked_reason FROM people WHERE id = $1', [personId]
      );
      if (who?.blocked) {
        return res.status(409).json({
          error: 'Blocked',
          blocks: [{
            code: 'person_blocked',
            message: who.blocked_reason
              ? `You're blocked from booking gear: ${who.blocked_reason}`
              : "You're blocked from booking gear. Talk to a cage admin."
          }]
        });
      }
    }

    /* A label, not a claim — see the same check in POST /checkouts. */
    let kitId = null;
    if (req.body.kit_id) {
      const { rows: [k] } = await q('SELECT id FROM kits WHERE id = $1', [Number(req.body.kit_id)]);
      kitId = k?.id ?? null;
    }

    const result = await tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(884423)');
      const ctx = await policyContext((text, params) => client.query(text, params));
      const hits = reservationConflicts({
        itemIds, start, end,
        reservations: ctx.reservations,
        openCheckouts: ctx.openCheckouts
      });
      if (hits.length && !req.body.force) return { conflicts: hits, ctx };
      if (hits.length && req.body.force && req.person.role !== 'admin') return { conflicts: hits, ctx };

      const { rows: [r] } = await client.query(
        `INSERT INTO reservations (person_id, start_on, end_on, shoot, project, kit_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [personId, start, end, labels.shoot, labels.project, kitId]
      );
      for (const id of itemIds) {
        await client.query(
          'INSERT INTO reservation_items (reservation_id, item_id) VALUES ($1, $2)', [r.id, id]
        );
      }
      for (const pid of ints(req.body.contributor_ids)) {
        if (pid === personId) continue;
        await client.query(
          `INSERT INTO booking_contributors (reservation_id, person_id, added_by)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [r.id, pid, req.person.id]
        );
      }
      return { id: r.id, hits, ctx };
    });

    // Gear swapped away from in the picker never reaches item_ids, so the
    // conflict check above never sees it — checked independently of whether
    // the rest of this hold was blocked, force-overridden, or went through
    // clean. See the identical comment in POST /checkouts.
    const swappedOutIds = ints(req.body.swapped_out);
    if (swappedOutIds.length) {
      const swapHits = reservationConflicts({
        itemIds: swappedOutIds, start, end,
        reservations: result.ctx.reservations, openCheckouts: result.ctx.openCheckouts
      });
      if (swapHits.length) {
        await logDemandMisses(missesFromHits(swapHits), {
          kind: 'reserve', personId, start, end, ctx: result.ctx
        });
      }
    }

    if (result.conflicts) {
      await logDemandMisses(missesFromHits(result.conflicts), {
        kind: 'reserve', personId, start, end, ctx: result.ctx
      });
      return res.status(409).json({
        error: 'Double-booked',
        blocks: result.conflicts.map(h => ({
          code: h.kind === 'checkout' ? 'already_out' : 'reserved',
          item_ids: h.item_ids,
          message: `${h.kind === 'checkout' ? 'Out with' : 'Held for'} ${h.person_name}, ${h.start} to ${h.end}.`
        }))
      });
    }

    // An admin's force-override let the hold through anyway — the conflict it
    // waived was still real at the time, so it still counts as a miss.
    if (result.hits?.length) {
      await logDemandMisses(missesFromHits(result.hits), {
        kind: 'reserve', personId, start, end, ctx: result.ctx
      });
    }

    await audit(req.person.id, 'reserve', { reservation_id: result.id, item_ids: itemIds, start, end });
    res.status(201).json({ id: result.id });
  } catch (err) { next(err); }
});

/**
 * The day-of-month equivalent of shiftDays — "the 31st, one month on" lands
 * on the last real day of the next month instead of spilling into the one
 * after (Jan 31 -> Feb 28, not Mar 3). setUTCDate(0) is "the day before the
 * 1st", i.e. the last day of the month setUTCMonth just landed one past.
 */
function shiftMonths(dateStr, months) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

const MAX_SERIES_OCCURRENCES = 104; // two years weekly — a runaway backstop, not a real limit

/**
 * The dates for each occurrence of a series, first one included. Every
 * occurrence keeps the same length as the first — only the start moves.
 */
function seriesOccurrences({ start, end, frequency, interval, until }) {
  const spanDays = Math.round((new Date(`${end}T12:00:00Z`) - new Date(`${start}T12:00:00Z`)) / 86400000);
  const occurrences = [];
  let s = start;
  while (s <= until && occurrences.length <= MAX_SERIES_OCCURRENCES) {
    occurrences.push({ start: s, end: shiftDays(s, spanDays) });
    s = frequency === 'monthly' ? shiftMonths(s, interval) : shiftDays(s, 7 * interval);
  }
  return occurrences;
}

/**
 * A recurring hold is a batch of independent reservation rows, not a
 * template that keeps generating more later — see the series_id comment in
 * db.js. Each occurrence is checked and inserted on its own, the same way a
 * single POST /reservations would, so a conflict on week three never blocks
 * weeks one, two, four, and on. Conflicting occurrences are skipped and
 * reported rather than failing the whole request; a person picking a
 * recurring rehearsal slot almost always still wants the weeks that are free.
 */
api.post('/reservations/recurring', requireAuth, async (req, res, next) => {
  try {
    const itemIds = ints(req.body.item_ids);
    const start = String(req.body.start_on || '').slice(0, 10);
    const end = String(req.body.end_on || '').slice(0, 10);
    const until = String(req.body.until || '').slice(0, 10);
    const frequency = req.body.frequency === 'monthly' ? 'monthly' : 'weekly';
    const interval = Math.max(1, Math.min(12, Number(req.body.interval) || 1));
    const personId = Number(req.body.person_id) || req.person.id;
    const labels = bookingLabels(req.body);
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;

    if (!itemIds.length) return bad(res, 400, 'Pick at least one item.');
    if (![start, end, until].every(d => dateRe.test(d))) {
      return bad(res, 400, 'Give the start, end, and until dates as YYYY-MM-DD.');
    }
    if (end < start) return bad(res, 400, 'The end date is before the start date.');
    if (until < start) return bad(res, 400, "The until date is before the first occurrence.");
    if (personId !== req.person.id && req.person.role !== 'admin') {
      return bad(res, 403, 'Only admins can reserve on behalf of someone else.');
    }
    if (req.person.role !== 'admin') {
      const { rows: [who] } = await q(
        'SELECT blocked, blocked_reason FROM people WHERE id = $1', [personId]
      );
      if (who?.blocked) {
        return res.status(409).json({
          error: 'Blocked',
          blocks: [{
            code: 'person_blocked',
            message: who.blocked_reason
              ? `You're blocked from booking gear: ${who.blocked_reason}`
              : "You're blocked from booking gear. Talk to a cage admin."
          }]
        });
      }
    }

    let kitId = null;
    if (req.body.kit_id) {
      const { rows: [k] } = await q('SELECT id FROM kits WHERE id = $1', [Number(req.body.kit_id)]);
      kitId = k?.id ?? null;
    }

    const occurrences = seriesOccurrences({ start, end, frequency, interval, until });
    if (occurrences.length < 2) {
      return bad(res, 400, 'That only makes one occurrence — use a regular reservation instead.');
    }
    if (occurrences.length > MAX_SERIES_OCCURRENCES) {
      return bad(res, 400, `That's ${occurrences.length} occurrences — pick a shorter range or a longer interval.`);
    }

    const seriesId = crypto.randomUUID();
    const created = [];
    const skipped = [];

    // Sequential on purpose: each occurrence takes the same advisory lock a
    // single reservation would, so two people racing the same slot are still
    // serialized correctly. At this team size and occurrence cap, doing it
    // one at a time costs nothing worth parallelizing for.
    for (const occ of occurrences) {
      const result = await tx(async client => {
        await client.query('SELECT pg_advisory_xact_lock(884423)');
        const ctx = await policyContext((text, params) => client.query(text, params));
        const hits = reservationConflicts({
          itemIds, start: occ.start, end: occ.end,
          reservations: ctx.reservations, openCheckouts: ctx.openCheckouts
        });
        if (hits.length) return { conflicts: hits, ctx };

        const { rows: [r] } = await client.query(
          `INSERT INTO reservations (person_id, start_on, end_on, shoot, project, kit_id, series_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [personId, occ.start, occ.end, labels.shoot, labels.project, kitId, seriesId]
        );
        for (const id of itemIds) {
          await client.query(
            'INSERT INTO reservation_items (reservation_id, item_id) VALUES ($1, $2)', [r.id, id]
          );
        }
        for (const pid of ints(req.body.contributor_ids)) {
          if (pid === personId) continue;
          await client.query(
            `INSERT INTO booking_contributors (reservation_id, person_id, added_by)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [r.id, pid, req.person.id]
          );
        }
        return { id: r.id };
      });

      if (result.conflicts) {
        await logDemandMisses(missesFromHits(result.conflicts), {
          kind: 'reserve', personId, start: occ.start, end: occ.end, ctx: result.ctx
        });
        skipped.push({
          start: occ.start, end: occ.end,
          blocks: result.conflicts.map(h => ({
            code: h.kind === 'checkout' ? 'already_out' : 'reserved',
            item_ids: h.item_ids,
            message: `${h.kind === 'checkout' ? 'Out with' : 'Held for'} ${h.person_name}, ${h.start} to ${h.end}.`
          }))
        });
      } else {
        created.push({ id: result.id, start: occ.start, end: occ.end });
      }
    }

    if (created.length) {
      await audit(req.person.id, 'reserve_series', {
        series_id: seriesId, item_ids: itemIds, created: created.length, skipped: skipped.length
      });
    }
    res.status(created.length ? 201 : 409).json({
      series_id: created.length ? seriesId : null, created, skipped
    });
  } catch (err) { next(err); }
});

/**
 * "Cancel the rest of this series" — every occurrence that hasn't already
 * played out or been touched. Past or already-fulfilled/cancelled rows are
 * left alone; this is undo-the-future, not rewrite-history. Same ownership
 * rule as cancelling a single hold (see DELETE /reservations/:id) — every
 * occurrence in a series has the same person_id, so one check covers them all.
 */
api.delete('/reservations/series/:seriesId', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await q(
      `SELECT id, person_id FROM reservations
       WHERE series_id = $1 AND cancelled_at IS NULL AND fulfilled_at IS NULL AND end_on >= $2`,
      [req.params.seriesId, localToday()]
    );
    if (!rows.length) return bad(res, 404, 'No remaining holds in that series.');
    if (rows[0].person_id !== req.person.id) {
      return bad(res, 403, 'Only the person who made this series can cancel it.');
    }
    const ids = rows.map(r => r.id);
    const { rows: heldItems } = await q(
      'SELECT DISTINCT item_id FROM reservation_items WHERE reservation_id = ANY($1::int[])', [ids]
    );
    await q('UPDATE reservations SET cancelled_at = now() WHERE id = ANY($1::int[])', [ids]);
    await audit(req.person.id, 'reservation_series_cancel', { series_id: req.params.seriesId, count: ids.length });
    notifyWatchers(heldItems.map(r => r.item_id)).catch(err => console.error('notifyWatchers failed:', err));
    res.json({ ok: true, cancelled: ids.length });
  } catch (err) { next(err); }
});

api.delete('/reservations/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await q('SELECT person_id FROM reservations WHERE id = $1', [id]);
    if (!rows.length) return bad(res, 404, 'No such reservation.');
    /* Releasing is ending the booking, so it's the holder's — same rule as
       check-in. A teammate can add gear to a hold; they can't cancel it. */
    if (rows[0].person_id !== req.person.id) {
      return bad(res, 403, 'Only the person who made this hold can release it.');
    }
    const { rows: heldItems } = await q('SELECT item_id FROM reservation_items WHERE reservation_id = $1', [id]);
    await q('UPDATE reservations SET cancelled_at = now() WHERE id = $1', [id]);
    await audit(req.person.id, 'reservation_cancel', { reservation_id: id });
    notifyWatchers(heldItems.map(r => r.item_id)).catch(err => console.error('notifyWatchers failed:', err));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Add gear to an existing hold, checked against the same window it's already booked for. */
api.post('/reservations/:id/items', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const itemIds = ints(req.body.item_ids);
    if (!itemIds.length) return bad(res, 400, 'Pick at least one item.');

    const { rows } = await q(
      `SELECT person_id, start_on::text AS start_on, end_on::text AS end_on
       FROM reservations WHERE id = $1 AND cancelled_at IS NULL AND fulfilled_at IS NULL`, [id]
    );
    if (!rows.length) return bad(res, 404, 'No live hold with that id.');
    const rsv = rows[0];
    const { rows: crew } = await q(
      'SELECT person_id FROM booking_contributors WHERE reservation_id = $1', [id]);
    if (!canAddGear(rsv, req.person, crew.map(r => r.person_id))) {
      return bad(res, 403, "You're not on this hold. Ask whoever made it to add you, or suggest the gear.");
    }

    const result = await tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(884423)');
      const ctx = await policyContext((text, params) => client.query(text, params));
      const hits = reservationConflicts({
        itemIds, start: rsv.start_on, end: rsv.end_on,
        reservations: ctx.reservations.filter(r => r.id !== id),
        openCheckouts: ctx.openCheckouts
      });
      if (hits.length && !(req.body.force && req.person.role === 'admin')) return { conflicts: hits };

      for (const itemId of itemIds) {
        await client.query(
          'INSERT INTO reservation_items (reservation_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, itemId]
        );
      }
      return { ok: true };
    });

    if (result.conflicts) {
      return res.status(409).json({
        error: 'Double-booked',
        blocks: result.conflicts.map(h => ({
          code: h.kind === 'checkout' ? 'already_out' : 'reserved',
          item_ids: h.item_ids,
          message: `${h.kind === 'checkout' ? 'Out with' : 'Held for'} ${h.person_name}, ${h.start} to ${h.end}.`
        }))
      });
    }
    await audit(req.person.id, 'reservation_add_items', { reservation_id: id, item_ids: itemIds });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Remove gear from a hold. If that empties it, cancel the hold outright —
 * a reservation with nothing on it isn't holding anything, so leaving a
 * ghost entry behind is worse than just closing it.
 */
api.delete('/reservations/:id/items', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const itemIds = ints(req.body.item_ids);
    if (!itemIds.length) return bad(res, 400, 'Pick at least one item.');

    const { rows } = await q(
      `SELECT person_id FROM reservations WHERE id = $1 AND cancelled_at IS NULL AND fulfilled_at IS NULL`, [id]
    );
    if (!rows.length) return bad(res, 404, 'No live hold with that id.');
    // Same rule as a checkout: only the person who made the hold takes gear off it.
    if (rows[0].person_id !== req.person.id) {
      return bad(res, 403, 'Only the person who made this hold can take gear off it.');
    }

    const emptied = await tx(async client => {
      await client.query(
        'DELETE FROM reservation_items WHERE reservation_id = $1 AND item_id = ANY($2::int[])',
        [id, itemIds]
      );
      const { rows: [remaining] } = await client.query(
        'SELECT count(*)::int AS n FROM reservation_items WHERE reservation_id = $1', [id]
      );
      if (remaining.n === 0) {
        await client.query('UPDATE reservations SET cancelled_at = now() WHERE id = $1', [id]);
      }
      return remaining.n === 0;
    });

    await audit(req.person.id, 'reservation_remove_items', { reservation_id: id, item_ids: itemIds, emptied });
    res.json({ ok: true, emptied });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- maintenance */

api.post('/maintenance', requireAuth, async (req, res, next) => {
  try {
    const itemId = Number(req.body.item_id);
    if (!Number.isInteger(itemId)) return bad(res, 400, 'Which item?');
    const { rows: [m] } = await q(
      `INSERT INTO maintenance (item_id, kind, notes, opened_by) VALUES ($1, $2, $3, $4) RETURNING id`,
      [itemId, req.body.kind || 'Repair', req.body.notes || '', req.person.id]
    );
    await audit(req.person.id, 'maintenance_open', { maintenance_id: m.id, item_id: itemId });
    res.status(201).json({ id: m.id });
  } catch (err) { next(err); }
});

api.post('/maintenance/:id/close', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await q(
      `UPDATE maintenance SET closed_on = CURRENT_DATE WHERE id = $1 AND closed_on IS NULL
       RETURNING item_id`, [id]
    );
    if (!rows.length) return bad(res, 404, 'That ticket is already closed.');
    await audit(req.person.id, 'maintenance_close', { maintenance_id: id });
    notifyWatchers([rows[0].item_id]).catch(err => console.error('notifyWatchers failed:', err));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------------- items */

api.post('/items', requireAdmin, async (req, res, next) => {
  try {
    const { name, code } = req.body;
    if (!name || !code) return bad(res, 400, 'Name and code are both required.');
    const { rows: [it] } = await q(
      `INSERT INTO items (code, name, category, brand, model, serial, notes, flag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [String(code).toUpperCase().trim(), name, req.body.category || 'Uncategorized',
       req.body.brand || '', req.body.model || '', req.body.serial || '', req.body.notes || '',
       String(req.body.flag || '').toUpperCase().trim()]
    );
    await audit(req.person.id, 'item_create', { item_id: it.id, code });
    res.status(201).json({ id: it.id });
  } catch (err) {
    if (err.code === '23505') return bad(res, 409, 'That code is already in use.');
    next(err);
  }
});

api.patch('/items/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const allowed = ['name', 'category', 'brand', 'model', 'serial', 'notes', 'code', 'retired', 'flag'];
    const sets = [], vals = [];
    for (const key of allowed) {
      if (key in req.body) {
        sets.push(`${key} = $${sets.length + 2}`);
        vals.push(key === 'flag' ? String(req.body[key] || '').toUpperCase().trim() : req.body[key]);
      }
    }
    if (!sets.length) return bad(res, 400, 'Nothing to change.');
    await q(`UPDATE items SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals]);
    await audit(req.person.id, 'item_update', { item_id: id, fields: Object.keys(req.body) });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return bad(res, 409, 'That code is already in use.');
    next(err);
  }
});

api.delete('/items/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await q(
      `SELECT 1 FROM checkout_items ci JOIN checkouts c ON c.id = ci.checkout_id
       WHERE ci.item_id = $1 AND c.returned_at IS NULL LIMIT 1`, [id]
    );
    if (rows.length) return bad(res, 409, "That item is out right now. Check it in first.");
    // Retire rather than delete so the history stays readable.
    await q('UPDATE items SET retired = TRUE WHERE id = $1', [id]);
    await audit(req.person.id, 'item_retire', { item_id: id });
    res.json({ ok: true, retired: true });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------- photos */

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES },
  fileFilter(req, file, cb) {
    if (!PHOTO_TYPES.has(file.mimetype)) {
      const err = new Error('Only JPG, PNG or WEBP photos are supported.');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

/** Always allowed to view; only admins can change gear or people photos. */
const adminOnly = message => async (req) => req.person.role === 'admin' ? null : message;

/** A kit or package's own edit rule — an owner can photograph their own
    package, same as they can change anything else about it. */
async function kitPhotoEditable(req, id) {
  const { rows: [k] } = await q('SELECT id, owner_id, shared FROM kits WHERE id = $1', [id]);
  if (!k) return 'No such kit.';
  return kitEditableBy(k, req.person) ? null : 'You can only change the photo on one you can edit.';
}

/**
 * One optional photo per row, same shape for every entity that has one:
 * image_data/image_type/image_version on the row itself. Wires GET (fetch
 * the bytes), POST (replace), and DELETE (clear) for one table — the only
 * things that differ between items, kits and people are the table name, what
 * to call it in the audit log, and who's allowed to touch it, so this is the
 * one place the actual read/write logic lives.
 *
 * image_version is why the GET route can still tell the browser to cache a
 * photo forever (nothing here rewrites bytes in place) even though the photo
 * itself is now editable — a replace or removal bumps it, which changes the
 * URL the client asks for next, rather than invalidating the old one.
 *
 * `canEdit(req, id)` returns null to allow, or a message to refuse with —
 * async, since a kit's answer depends on a row it has to look up first.
 */
function photoRoutes({ path, table, label, canEdit }) {
  api.get(`/${path}/:id/image`, requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const { rows } = await q(`SELECT image_data, image_type FROM ${table} WHERE id = $1`, [id]);
      if (!rows.length || !rows[0].image_data) return res.status(404).end();
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.set('Content-Type', rows[0].image_type || 'application/octet-stream');
      res.send(rows[0].image_data);
    } catch (err) { next(err); }
  });

  api.post(`/${path}/:id/photo`, requireAuth, upload.single('photo'), async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const refused = await canEdit(req, id);
      if (refused) return bad(res, 403, refused);
      if (!req.file) return bad(res, 400, 'No photo in the request.');
      const { rows } = await q(
        `UPDATE ${table} SET image_data = $2, image_type = $3, image_version = image_version + 1
         WHERE id = $1 RETURNING image_version`,
        [id, req.file.buffer, req.file.mimetype]
      );
      if (!rows.length) return bad(res, 404, `No such ${label}.`);
      await audit(req.person.id, `${label}_photo_set`, { id });
      res.json({ ok: true, image_v: rows[0].image_version });
    } catch (err) { next(err); }
  });

  api.delete(`/${path}/:id/photo`, requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const refused = await canEdit(req, id);
      if (refused) return bad(res, 403, refused);
      const { rows } = await q(
        `UPDATE ${table} SET image_data = NULL, image_type = '', image_version = image_version + 1
         WHERE id = $1 RETURNING image_version`,
        [id]
      );
      if (!rows.length) return bad(res, 404, `No such ${label}.`);
      await audit(req.person.id, `${label}_photo_remove`, { id });
      res.json({ ok: true, image_v: rows[0].image_version });
    } catch (err) { next(err); }
  });
}

photoRoutes({ path: 'items', table: 'items', label: 'item',
  canEdit: adminOnly('Only admins can change gear photos.') });
photoRoutes({ path: 'kits', table: 'kits', label: 'kit', canEdit: kitPhotoEditable });
photoRoutes({ path: 'people', table: 'people', label: 'person',
  canEdit: adminOnly("Only admins can change someone's photo.") });

/* ---------------------------------------------------------------------- kits */

/** One kit with its items, or null. Ownership checks all start here. */
async function loadKit(id, exec = q) {
  const { rows } = await exec(
    `SELECT k.id, k.name, k.notes, k.owner_id, k.shared, k.type,
            COALESCE(array_agg(ki.item_id) FILTER (WHERE ki.item_id IS NOT NULL), '{}') AS item_ids
     FROM kits k LEFT JOIN kit_items ki ON ki.kit_id = k.id
     WHERE k.id = $1 GROUP BY k.id`, [id]);
  return rows[0] || null;
}

/** Replace a kit's contents. Callers have already checked permission. */
async function setKitItems(client, kitId, itemIds) {
  await client.query('DELETE FROM kit_items WHERE kit_id = $1', [kitId]);
  for (const itemId of itemIds) {
    await client.query(
      'INSERT INTO kit_items (kit_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [kitId, itemId]);
  }
}

/* Every kit created through the API is personally owned, which makes it a
   package by construction — a physical kit is never created this way, only
   by scripts/import-kits.js writing straight to the database. `type` is
   hardcoded rather than trusted from the request body for exactly that
   reason: there's no legitimate way for a client to ask for a "physical"
   kit here. */
api.post('/kits', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return bad(res, 400, 'Name the kit.');
    const itemIds = ints(req.body.item_ids);
    const id = await tx(async client => {
      const { rows: [k] } = await client.query(
        `INSERT INTO kits (name, notes, owner_id, shared, type) VALUES ($1, $2, $3, $4, 'package') RETURNING id`,
        [name, String(req.body.notes || ''), req.person.id, Boolean(req.body.shared)]);
      await setKitItems(client, k.id, itemIds);
      return k.id;
    });
    await audit(req.person.id, 'kit.create', { id, name, items: itemIds.length });
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

api.put('/kits/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const kit = await loadKit(id);
    if (!kit) return bad(res, 404, 'No such kit.');
    if (!kitEditableBy(kit, req.person)) {
      return bad(res, 403, "That kit belongs to someone else. Duplicate it and change your copy.");
    }
    const itemIds = ints(req.body.item_ids);
    await tx(async client => {
      const name = String(req.body.name ?? kit.name).trim() || kit.name;
      await client.query('UPDATE kits SET name = $2, notes = $3 WHERE id = $1',
        [id, name, String(req.body.notes ?? kit.notes ?? '')]);
      await setKitItems(client, id, itemIds);
    });
    await audit(req.person.id, 'kit.update', { id, items: itemIds.length });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Publish or withdraw. Separate from PUT so one tap can't also rewrite gear. */
api.patch('/kits/:id/share', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const kit = await loadKit(id);
    if (!kit) return bad(res, 404, 'No such kit.');
    if (!kitEditableBy(kit, req.person)) {
      return bad(res, 403, 'Only the person who owns a kit can share it.');
    }
    const shared = Boolean(req.body.shared);
    await q('UPDATE kits SET shared = $2 WHERE id = $1', [id, shared]);
    await audit(req.person.id, shared ? 'kit.share' : 'kit.unshare', { id, name: kit.name });
    res.json({ ok: true, shared });
  } catch (err) { next(err); }
});

/**
 * Copy a kit into your own. Needs only the right to see it, which is the
 * point of sharing: take someone's package as a starting point and diverge.
 */
api.post('/kits/:id/duplicate', requireAuth, async (req, res, next) => {
  try {
    const kit = await loadKit(Number(req.params.id));
    if (!kit) return bad(res, 404, 'No such kit.');
    if (!kitVisibleTo(kit, req.person)) return bad(res, 403, 'That kit is not shared with you.');

    const { rows: mine } = await q('SELECT name FROM kits WHERE owner_id = $1', [req.person.id]);
    const copy = duplicateKit(kit, req.person, mine.map(r => r.name));
    // Not part of loadKit's own SELECT — that one backs every kit route,
    // including ones with no reason to pull a photo's bytes off disk just to
    // check a name or toggle sharing. Only duplicating needs them, so only
    // duplicating asks for them.
    const { rows: [photo] } = await q('SELECT image_data, image_type FROM kits WHERE id = $1', [kit.id]);

    const id = await tx(async client => {
      const { rows: [k] } = await client.query(
        `INSERT INTO kits (name, notes, owner_id, shared, type, image_data, image_type)
         VALUES ($1, $2, $3, FALSE, $4, $5, $6) RETURNING id`,
        [copy.name, copy.notes, req.person.id, copy.type, photo.image_data, photo.image_type]);
      await setKitItems(client, k.id, copy.item_ids);
      return k.id;
    });
    await audit(req.person.id, 'kit.duplicate', { from: kit.id, id, name: copy.name });
    res.status(201).json({ id, name: copy.name });
  } catch (err) { next(err); }
});

api.delete('/kits/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const kit = await loadKit(id);
    if (!kit) return res.json({ ok: true });   // already gone
    if (!kitDeletableBy(kit, req.person)) return bad(res, 403, 'That kit belongs to someone else.');
    await q('DELETE FROM kits WHERE id = $1', [id]);
    await audit(req.person.id, 'kit.delete', { id, name: kit.name });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------------- import */
// Thin wrappers over scripts/import-csv.js and scripts/import-orders.js —
// the actual parsing/matching/writing logic lives there so the CLI and the
// Admin → Import screen can't drift apart. See src/server.js for the wider
// body-size limit this path needs.

api.post('/import/items', requireAdmin, async (req, res, next) => {
  try {
    const csv = req.body.csv;
    if (typeof csv !== 'string' || !csv.trim()) return bad(res, 400, 'No CSV content received.');
    const dry = Boolean(req.body.dry);
    // Defaults on: most exports that have a photo column want the photos.
    const fetchImages = req.body.fetchImages !== false;
    const result = await importItems(csv, { dry, fetchImages });
    if (!result.ok) return bad(res, 400, result.error);
    if (!dry) {
      await audit(req.person.id, 'import_items', {
        created: result.created, updated: result.updated, skipped: result.skipped,
        imagesFetched: result.imagesFetched, imagesFailed: result.imagesFailed
      });
    }
    res.json(result);
  } catch (err) { next(err); }
});

api.post('/import/orders', requireAdmin, async (req, res, next) => {
  try {
    const csv = req.body.csv;
    if (typeof csv !== 'string' || !csv.trim()) return bad(res, 400, 'No CSV content received.');
    if (!['checkout', 'reservation'].includes(req.body.kind)) return bad(res, 400, 'kind must be "checkout" or "reservation".');
    const dry = Boolean(req.body.dry);
    const result = await importOrders(csv, req.body.kind, {
      dry,
      notifyImmediately: Boolean(req.body.notifyImmediately),
      allowPlaceholders: Boolean(req.body.allowPlaceholders),
      peopleMapText: typeof req.body.peopleMap === 'string' && req.body.peopleMap.trim() ? req.body.peopleMap : null
    });
    if (!result.ok) return bad(res, 400, result.error);
    if (!dry) {
      await audit(req.person.id, 'import_orders', {
        kind: req.body.kind, created: result.created, skipped: result.skipped, stubs: result.stubs, invited: result.invited
      });
    }
    res.json(result);
  } catch (err) { next(err); }
});


/* ------------------------------------------------------------ gear requests */

/**
 * Asking the holder to add gear to their loan or hold.
 *
 * The item list is a snapshot of what was asked for, not a claim on anything:
 * nothing is reserved while a request sits pending, and the gear is put
 * through the same rules as a direct add at the moment it's approved. Days
 * can pass, and availability moves.
 */
async function loadRequest(id, exec = q) {
  const { rows } = await exec(
    `SELECT r.*, 
            rq.name AS requester_name, rq.email AS requester_email,
            h.name  AS holder_name,    h.email  AS holder_email
     FROM gear_requests r
     JOIN people rq ON rq.id = r.requester_id
     JOIN people h  ON h.id  = r.holder_id
     WHERE r.id = $1`, [id]);
  return rows[0] || null;
}

api.post('/requests', requireAuth, async (req, res, next) => {
  try {
    const checkoutId = Number(req.body.checkout_id) || null;
    const reservationId = Number(req.body.reservation_id) || null;
    if (Boolean(checkoutId) === Boolean(reservationId)) {
      return bad(res, 400, 'Say which booking this is about.');
    }

    const target = checkoutId
      ? (await q(`SELECT c.id, c.holder_id, c.shoot, c.project,
                         COALESCE(array_agg(ci.item_id) FILTER (WHERE ci.item_id IS NOT NULL), '{}') AS item_ids
                  FROM checkouts c LEFT JOIN checkout_items ci ON ci.checkout_id = c.id
                  WHERE c.id = $1 AND c.returned_at IS NULL GROUP BY c.id`, [checkoutId])).rows[0]
      : (await q(`SELECT r.id, r.person_id AS holder_id, r.shoot, r.project,
                         COALESCE(array_agg(ri.item_id) FILTER (WHERE ri.item_id IS NOT NULL), '{}') AS item_ids
                  FROM reservations r LEFT JOIN reservation_items ri ON ri.reservation_id = r.id
                  WHERE r.id = $1 AND r.cancelled_at IS NULL AND r.fulfilled_at IS NULL
                  GROUP BY r.id`, [reservationId])).rows[0];
    if (!target) return bad(res, 404, 'That booking is no longer open.');

    if (target.holder_id === req.person.id) {
      return bad(res, 400, "That's your own booking — add the gear directly.");
    }

    const kind = req.body.kind === 'swap' ? 'swap' : 'add';
    let wanted, offered = [], offerCheckoutId = null, offerReservationId = null;
    let targetCheckoutId = null, targetReservationId = null;

    if (kind === 'swap') {
      /* A trade is "give me that, take this instead". The half you're giving
         can come off a loan of yours, a hold of yours, or straight off the
         shelf — all three are gear they can actually end up with. What it
         can't be is something a third person is holding. */
      const offerIds = ints(req.body.offer_item_ids);
      const [{ rows: myLoans }, { rows: myHolds }] = await Promise.all([
        q(`SELECT c.id, COALESCE(array_agg(ci.item_id) FILTER (WHERE ci.item_id IS NOT NULL), '{}') AS item_ids
           FROM checkouts c LEFT JOIN checkout_items ci ON ci.checkout_id = c.id
           WHERE c.holder_id = $1 AND c.returned_at IS NULL GROUP BY c.id`, [req.person.id]),
        q(`SELECT r.id, COALESCE(array_agg(ri.item_id) FILTER (WHERE ri.item_id IS NOT NULL), '{}') AS item_ids
           FROM reservations r LEFT JOIN reservation_items ri ON ri.reservation_id = r.id
           WHERE r.person_id = $1 AND r.cancelled_at IS NULL AND r.fulfilled_at IS NULL
           GROUP BY r.id`, [req.person.id])
      ]);
      const fromLoan = myLoans.find(c => offerIds.length && offerIds.every(i => c.item_ids.includes(i)));
      const fromHold = fromLoan ? null
        : myHolds.find(r => offerIds.length && offerIds.every(i => r.item_ids.includes(i)));
      const mineNow = fromLoan?.item_ids || fromHold?.item_ids || [];

      /* Anything not on anyone's live booking is offerable off the shelf. */
      const ctx = await policyContext();
      const spoken = new Set([
        ...ctx.openCheckouts.flatMap(c => c.item_ids),
        ...ctx.reservations.flatMap(r => r.item_ids)
      ]);
      const freeIds = offerIds.filter(i => !spoken.has(i));

      const check = checkSwap({
        theirItems: target.item_ids, myItems: mineNow, freeItems: freeIds,
        wanted: ints(req.body.item_ids), offered: offerIds
      });
      if (!check.ok) return bad(res, 400, check.problems[0]);

      /* Their gear has to land somewhere. Without a booking of your own there
         is nowhere for it to go, and a trade that only gives is a donation. */
      const mineTarget = checkoutId ? myLoans[0] : (myHolds[0] || myLoans[0]);
      if (!mineTarget) {
        return bad(res, 400, 'Check something out or make a hold first — their gear needs somewhere to land.');
      }
      wanted = check.wanted;
      offered = check.offered;
      offerCheckoutId = fromLoan?.id ?? null;
      offerReservationId = fromHold?.id ?? null;
      targetCheckoutId = checkoutId ? mineTarget.id : null;
      targetReservationId = checkoutId ? null : mineTarget.id;
    } else {
      wanted = requestableItems(ints(req.body.item_ids), target.item_ids);
      if (!wanted.length) return bad(res, 400, 'Pick gear that isn\'t already on it.');
    }

    /* One pending request per person per booking, so a double tap doesn't
       leave the holder with the same ask twice. */
    const { rows: dupe } = await q(
      `SELECT id FROM gear_requests
       WHERE state = 'pending' AND requester_id = $1
         AND checkout_id IS NOT DISTINCT FROM $2 AND reservation_id IS NOT DISTINCT FROM $3`,
      [req.person.id, checkoutId, reservationId]);

    const id = dupe.length
      ? (await q(`UPDATE gear_requests SET item_ids = $2, note = $3, created_at = now(),
                         kind = $4, offer_item_ids = $5, offer_checkout_id = $6,
                         offer_reservation_id = $7, target_checkout_id = $8, target_reservation_id = $9
                  WHERE id = $1 RETURNING id`,
                 [dupe[0].id, wanted, String(req.body.note || '').slice(0, 500),
                  kind, offered, offerCheckoutId, offerReservationId,
                  targetCheckoutId, targetReservationId])).rows[0].id
      : (await q(`INSERT INTO gear_requests
                    (checkout_id, reservation_id, requester_id, holder_id, item_ids, note,
                     kind, offer_item_ids, offer_checkout_id,
                     offer_reservation_id, target_checkout_id, target_reservation_id)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
                 [checkoutId, reservationId, req.person.id, target.holder_id, wanted,
                  String(req.body.note || '').slice(0, 500), kind, offered, offerCheckoutId,
                  offerReservationId, targetCheckoutId, targetReservationId])).rows[0].id;

    const [{ rows: holderRows }, { rows: itemRows }] = await Promise.all([
      q('SELECT id, name, email FROM people WHERE id = $1', [target.holder_id]),
      q('SELECT id, code, name FROM items WHERE id = ANY($1::int[])', [wanted])
    ]);
    const { rows: offerRows } = offered.length
      ? await q('SELECT id, code, name FROM items WHERE id = ANY($1::int[])', [offered])
      : { rows: [] };
    const t = templates.gearRequest({
      holder: holderRows[0], requester: req.person, items: itemRows,
      booking: { kind: checkoutId ? 'checkout' : 'hold', shoot: target.shoot, project: target.project },
      note: req.body.note || '', tradeFor: kind === 'swap' ? offerRows : null
    });
    /* Fire and forget: the request is already saved and visible in the app,
       so a bounced email must not fail the call. */
    send({ to: holderRows[0].email, ...t }).catch(e => console.error('request mail failed', e.message));

    await audit(req.person.id, 'request.create',
      { id, kind, holder_id: target.holder_id, items: wanted.length, offered: offered.length });
    res.status(201).json({ id, kind, item_ids: wanted, offer_item_ids: offered });
  } catch (err) { next(err); }
});

api.post('/requests/:id/approve', requireAuth, async (req, res, next) => {
  try {
    const reqRow = await loadRequest(Number(req.params.id));
    if (!reqRow) return bad(res, 404, 'No such request.');
    if (!requestDecidableBy(reqRow, req.person)) {
      return bad(res, 403, 'Only the person holding the gear, or an admin, can approve this.');
    }

    const result = await tx(async client => {
      const exec = (text, params) => client.query(text, params);
      await exec('SELECT pg_advisory_xact_lock(884422)');

      /* A swap is two moves that have to happen together, or the gear ends up
         on both loans or neither. Same transaction and same lock as a
         checkout, and both halves are re-read inside it — either side may
         have been checked in since the offer was made. */
      if (reqRow.kind === 'swap') {
        /* Four moves, all or nothing: their gear off theirs and onto yours,
           yours off yours and onto theirs. Each side can be a loan or a hold,
           and the offered half can come off neither if it was free. */
        const tbl = co => (co ? 'checkout_items' : 'reservation_items');
        const col = co => (co ? 'checkout_id' : 'reservation_id');
        const theirIsCo = Boolean(reqRow.checkout_id);
        const theirId = reqRow.checkout_id ?? reqRow.reservation_id;
        const mineIsCo = Boolean(reqRow.target_checkout_id);
        const mineId = reqRow.target_checkout_id ?? reqRow.target_reservation_id;
        if (!mineId) return { gone: 'The booking this was offered from is gone.' };

        const live = async (isCo, id) => (await exec(
          isCo
            ? `SELECT c.id, COALESCE(array_agg(ci.item_id) FILTER (WHERE ci.item_id IS NOT NULL), '{}') AS item_ids
               FROM checkouts c LEFT JOIN checkout_items ci ON ci.checkout_id = c.id
               WHERE c.id = $1 AND c.returned_at IS NULL GROUP BY c.id`
            : `SELECT r.id, COALESCE(array_agg(ri.item_id) FILTER (WHERE ri.item_id IS NOT NULL), '{}') AS item_ids
               FROM reservations r LEFT JOIN reservation_items ri ON ri.reservation_id = r.id
               WHERE r.id = $1 AND r.cancelled_at IS NULL AND r.fulfilled_at IS NULL GROUP BY r.id`,
          [id])).rows[0];

        const theirs = await live(theirIsCo, theirId);
        const mine = await live(mineIsCo, mineId);
        if (!theirs) return { gone: 'That booking is no longer open.' };
        if (!mine) return { gone: 'The booking this was offered from is no longer open.' };

        if (!reqRow.item_ids.every(i => theirs.item_ids.includes(i))) {
          return { gone: 'That gear has already come off their booking.' };
        }

        await exec(`DELETE FROM ${tbl(theirIsCo)} WHERE ${col(theirIsCo)} = $1 AND item_id = ANY($2::int[])`,
          [theirId, reqRow.item_ids]);
        // The offered half only leaves a booking if it came from one.
        if (reqRow.offer_checkout_id) {
          await exec(`DELETE FROM checkout_items WHERE checkout_id = $1 AND item_id = ANY($2::int[])`,
            [reqRow.offer_checkout_id, reqRow.offer_item_ids]);
        } else if (reqRow.offer_reservation_id) {
          await exec(`DELETE FROM reservation_items WHERE reservation_id = $1 AND item_id = ANY($2::int[])`,
            [reqRow.offer_reservation_id, reqRow.offer_item_ids]);
        }
        for (const itemId of reqRow.item_ids) {
          await exec(`INSERT INTO ${tbl(mineIsCo)} (${col(mineIsCo)}, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [mineId, itemId]);
        }
        for (const itemId of reqRow.offer_item_ids) {
          await exec(`INSERT INTO ${tbl(theirIsCo)} (${col(theirIsCo)}, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [theirId, itemId]);
        }
      } else if (reqRow.checkout_id) {
        const { rows } = await exec(
          `SELECT holder_id, due_on::text AS due_on FROM checkouts
           WHERE id = $1 AND returned_at IS NULL`, [reqRow.checkout_id]);
        if (!rows.length) return { gone: 'That checkout has been closed.' };
        const { decision } = await buildEvaluation({
          actor: req.person, holderId: rows[0].holder_id, itemIds: reqRow.item_ids,
          from: localToday(), due: effectiveDue(rows[0].due_on), override: false, exec
        });
        if (!decision.allowed) return { blocked: decision };
        for (const itemId of reqRow.item_ids) {
          await exec('INSERT INTO checkout_items (checkout_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [reqRow.checkout_id, itemId]);
        }
      } else {
        const { rows } = await exec(
          `SELECT person_id, start_on::text AS start_on, end_on::text AS end_on FROM reservations
           WHERE id = $1 AND cancelled_at IS NULL AND fulfilled_at IS NULL`, [reqRow.reservation_id]);
        if (!rows.length) return { gone: 'That hold is no longer live.' };
        const ctx = await policyContext(exec);
        const hits = reservationConflicts({
          itemIds: reqRow.item_ids, start: rows[0].start_on, end: rows[0].end_on,
          reservations: ctx.reservations.filter(r => r.id !== reqRow.reservation_id),
          openCheckouts: ctx.openCheckouts
        });
        if (hits.length) return { conflicts: hits };
        for (const itemId of reqRow.item_ids) {
          await exec('INSERT INTO reservation_items (reservation_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [reqRow.reservation_id, itemId]);
        }
      }

        await exec(`UPDATE gear_requests SET state = 'approved', decided_at = now(), decided_by = $2,
                         decided_note = $3 WHERE id = $1`,
        [reqRow.id, req.person.id, String(req.body.note || '').slice(0, 500)]);
      return { ok: true };
    });

    if (result.gone) return bad(res, 409, result.gone);
    if (result.blocked) return res.status(409).json({ error: 'Blocked', ...result.blocked });
    if (result.conflicts) {
      return res.status(409).json({ error: 'That gear is spoken for over those dates.', conflicts: result.conflicts });
    }

    const { rows: items } = await q('SELECT id, code, name FROM items WHERE id = ANY($1::int[])', [reqRow.item_ids]);
    send({
      to: reqRow.requester_email,
      ...templates.gearRequestDecided({
        requester: { name: reqRow.requester_name, email: reqRow.requester_email },
        holder: { name: reqRow.holder_name, email: reqRow.holder_email },
        items, approved: true, reason: String(req.body.note || ''),
        kind: reqRow.kind, offered: [], swapBack: []
      })
    }).catch(e => console.error('request mail failed', e.message));

    await audit(req.person.id, 'request.approve', { id: reqRow.id, items: reqRow.item_ids.length });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.post('/requests/:id/decline', requireAuth, async (req, res, next) => {
  try {
    const reqRow = await loadRequest(Number(req.params.id));
    if (!reqRow) return bad(res, 404, 'No such request.');
    if (!requestDecidableBy(reqRow, req.person)) {
      return bad(res, 403, 'Only the person holding the gear, or an admin, can decline this.');
    }
    const reason = String(req.body.reason || '').slice(0, 500);
    await q(`UPDATE gear_requests SET state = 'declined', reason = $2, decided_at = now(), decided_by = $3
             WHERE id = $1`, [reqRow.id, reason, req.person.id]);

    const { rows: items } = await q('SELECT id, code, name FROM items WHERE id = ANY($1::int[])', [reqRow.item_ids]);
    send({
      to: reqRow.requester_email,
      ...templates.gearRequestDecided({
        requester: { name: reqRow.requester_name, email: reqRow.requester_email },
        holder: { name: reqRow.holder_name, email: reqRow.holder_email },
        items, approved: false, reason, kind: reqRow.kind
      })
    }).catch(e => console.error('request mail failed', e.message));

    await audit(req.person.id, 'request.decline', { id: reqRow.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

api.delete('/requests/:id', requireAuth, async (req, res, next) => {
  try {
    const reqRow = await loadRequest(Number(req.params.id));
    if (!reqRow) return res.json({ ok: true });
    if (!requestCancellableBy(reqRow, req.person)) {
      return bad(res, 403, 'You can only withdraw your own requests.');
    }
    await q(`UPDATE gear_requests SET state = 'cancelled', decided_at = now(), decided_by = $2
             WHERE id = $1`, [reqRow.id, req.person.id]);
    await audit(req.person.id, 'request.cancel', { id: reqRow.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});


/* ------------------------------------------------------------- contributors */

/** Load a booking of either kind, plus who's already on it. */
async function loadBooking(kind, id) {
  const isCo = kind === 'checkout';
  const { rows } = await q(isCo
    ? `SELECT id, holder_id FROM checkouts WHERE id = $1 AND returned_at IS NULL`
    : `SELECT id, person_id FROM reservations
       WHERE id = $1 AND cancelled_at IS NULL AND fulfilled_at IS NULL`, [id]);
  if (!rows.length) return null;
  const { rows: crew } = await q(
    `SELECT person_id FROM booking_contributors WHERE ${isCo ? 'checkout_id' : 'reservation_id'} = $1`,
    [id]);
  return { booking: rows[0], contributors: crew.map(r => r.person_id), isCo };
}

for (const kind of ['checkout', 'reservation']) {
  const path = kind === 'checkout' ? 'checkouts' : 'reservations';
  const col = kind === 'checkout' ? 'checkout_id' : 'reservation_id';

  api.post(`/${path}/:id/contributors`, requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const found = await loadBooking(kind, id);
      if (!found) return bad(res, 404, 'That booking is no longer open.');
      if (!canManageContributors(found.booking, req.person)) {
        return bad(res, 403, "Only the person who made this booking can name who's on it.");
      }
      const personId = Number(req.body.person_id);
      if (!contributorAddable(found.booking, personId, found.contributors)) {
        return bad(res, 400, 'That person is already on it.');
      }
      const { rows: who } = await q('SELECT id FROM people WHERE id = $1', [personId]);
      if (!who.length) return bad(res, 400, 'No such person.');

      await q(`INSERT INTO booking_contributors (${col}, person_id, added_by)
               VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, personId, req.person.id]);
      await audit(req.person.id, 'contributor.add', { kind, id, person_id: personId });
      res.status(201).json({ ok: true });
    } catch (err) { next(err); }
  });

  api.delete(`/${path}/:id/contributors/:personId`, requireAuth, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const personId = Number(req.params.personId);
      const found = await loadBooking(kind, id);
      if (!found) return res.json({ ok: true });
      /* You can always take yourself off. Otherwise it's the holder's list. */
      if (personId !== req.person.id && !canManageContributors(found.booking, req.person)) {
        return bad(res, 403, "Only the person who made this booking can change who's on it.");
      }
      await q(`DELETE FROM booking_contributors WHERE ${col} = $1 AND person_id = $2`, [id, personId]);
      await audit(req.person.id, 'contributor.remove', { kind, id, person_id: personId });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

/* -------------------------------------------------------------------- people */

api.post('/people', requireAdmin, async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 400, 'Enter a valid email address.');
    const name = String(req.body.name || '').trim();
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    const { rows: [p] } = await q(
      `INSERT INTO people (email, name, role) VALUES ($1, $2, $3) RETURNING id`,
      [email, name, role]
    );
    await audit(req.person.id, 'person_create', { person_id: p.id, email });
    res.status(201).json({ id: p.id });
  } catch (err) {
    if (err.code === '23505') return bad(res, 409, 'Someone with that email is already in the cage.');
    next(err);
  }
});

api.patch('/people/:id', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.person.id && req.body.role && req.body.role !== 'admin') {
      return bad(res, 400, "Promote someone else before demoting yourself.");
    }
    const sets = [], vals = [];
    if ('name' in req.body)    { sets.push(`name = $${sets.length + 2}`); vals.push(req.body.name); }
    if ('role' in req.body)    { sets.push(`role = $${sets.length + 2}`); vals.push(req.body.role === 'admin' ? 'admin' : 'member'); }
    if ('blocked' in req.body) { sets.push(`blocked = $${sets.length + 2}`); vals.push(Boolean(req.body.blocked)); }
    if ('blocked_reason' in req.body) { sets.push(`blocked_reason = $${sets.length + 2}`); vals.push(req.body.blocked_reason || null); }
    if (!sets.length) return bad(res, 400, 'Nothing to change.');
    await q(`UPDATE people SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals]);
    await audit(req.person.id, 'person_update', { person_id: id, fields: Object.keys(req.body) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Let anyone set their own display name on first sign-in. */
api.patch('/me', requireAuth, async (req, res, next) => {
  try {
    if (!req.body.name) return bad(res, 400, 'Name cannot be blank.');
    await q('UPDATE people SET name = $2 WHERE id = $1', [req.person.id, String(req.body.name).slice(0, 80)]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ settings */

api.put('/settings', requireAdmin, async (req, res, next) => {
  try {
    const entries = Object.entries(req.body || {});
    for (const [key, value] of entries) {
      await q(
        `UPDATE settings SET value = $2 WHERE key = $1`, [key, String(value)]
      );
    }
    await audit(req.person.id, 'settings_update', req.body);
    res.json({ ok: true, settings: await settings() });
  } catch (err) { next(err); }
});

/* --------------------------------------------------------------------- tasks */

/**
 * Reminder trigger for an external scheduler. Protected by a shared secret so
 * it can be hit by GitHub Actions, cron-job.org, or a Render cron job.
 */
/** Same batch, triggered by a signed-in admin from the settings screen. */
api.post('/tasks/reminders/manual', requireAdmin, async (req, res, next) => {
  try {
    const result = await runReminders({ verbose: true });
    await audit(req.person.id, 'reminders_manual', { count: result.sent.length });
    res.json(result);
  } catch (err) { next(err); }
});

api.post('/tasks/reminders', async (req, res, next) => {
  try {
    const secret = process.env.CRON_SECRET;
    const given = req.get('x-cron-secret') || req.query.key;
    if (!secret) return bad(res, 503, 'CRON_SECRET is not configured on the server.');
    if (given !== secret) return bad(res, 401, 'Bad cron secret.');
    const result = await runReminders({ verbose: true });
    res.json(result);
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ audit */

/**
 * Every admin action and account change, oldest last. `before` is a cursor
 * (the id of the last row already shown) rather than an OFFSET, so paging
 * through while new rows keep arriving never skips or repeats one.
 */
api.get('/audit', requireAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = Number(req.query.before) || null;
    const personId = Number(req.query.person_id) || null;
    const qtext = String(req.query.q || '').trim();

    const clauses = [];
    const vals = [];
    if (before)   { vals.push(before);   clauses.push(`a.id < $${vals.length}`); }
    if (personId) { vals.push(personId); clauses.push(`a.person_id = $${vals.length}`); }
    if (qtext) {
      // Matches the action string or anything in the detail blob — "kit 16"
      // finds both a create action naming kit 16 and one whose action text
      // happens to say so, without needing per-action-type search fields.
      vals.push(`%${qtext.toLowerCase()}%`);
      clauses.push(`(lower(a.action) LIKE $${vals.length} OR lower(a.detail::text) LIKE $${vals.length})`);
    }
    vals.push(limit);

    const { rows } = await q(
      `SELECT a.id, a.at, a.action, a.detail, a.person_id,
              COALESCE(NULLIF(p.name, ''), p.email) AS person_name
       FROM audit a LEFT JOIN people p ON p.id = a.person_id
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY a.id DESC LIMIT $${vals.length}`,
      vals
    );
    res.json({ rows, more: rows.length === limit });
  } catch (err) { next(err); }
});

/* -------------------------------------------------------------- reports */

const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/**
 * Per-item usage over a date range: checkouts started, days spent out
 * (clipped to the window, an open loan counting through today), and how
 * often the item was wanted but unavailable with nothing interchangeable
 * free to offer instead (see `isUnmetDemand` / `demand_misses`).
 *
 * Days out overlaps the window rather than only counting checkouts that
 * started inside it — a loan that began before `from` and is still running
 * genuinely used the item for every day of the window it was out, and
 * excluding it would understate exactly the long-running loans this report
 * exists to surface.
 */
async function usageReport({ from, to, itemId }) {
  const { rows } = await q(
    `WITH period AS (SELECT $1::date AS from_d, $2::date AS to_d),
     co AS (
       SELECT ci.item_id, c.out_at, c.returned_at
       FROM checkout_items ci
       JOIN checkouts c ON c.id = ci.checkout_id, period p
       WHERE c.out_at::date <= p.to_d
         AND COALESCE(c.returned_at::date, CURRENT_DATE) >= p.from_d
     ),
     agg AS (
       SELECT co.item_id,
              COUNT(*) AS checkout_count,
              SUM(
                LEAST(COALESCE(co.returned_at::date, CURRENT_DATE), (SELECT to_d FROM period))
                - GREATEST(co.out_at::date, (SELECT from_d FROM period)) + 1
              ) AS days_out
       FROM co
       GROUP BY co.item_id
     ),
     last_used AS (
       SELECT ci.item_id, MAX(c.out_at) AS last_used_at
       FROM checkout_items ci JOIN checkouts c ON c.id = ci.checkout_id
       GROUP BY ci.item_id
     ),
     misses AS (
       SELECT item_id, COUNT(*) AS miss_count
       FROM demand_misses, period
       WHERE at::date BETWEEN from_d AND to_d
       GROUP BY item_id
     )
     SELECT i.id, i.code, i.name, i.category, i.brand, i.flag, i.retired,
            COALESCE(agg.checkout_count, 0)::int AS checkout_count,
            COALESCE(agg.days_out, 0)::int AS days_out,
            last_used.last_used_at,
            COALESCE(misses.miss_count, 0)::int AS demand_misses
     FROM items i
     LEFT JOIN agg ON agg.item_id = i.id
     LEFT JOIN last_used ON last_used.item_id = i.id
     LEFT JOIN misses ON misses.item_id = i.id
     WHERE ($3::int IS NULL OR i.id = $3::int)
     ORDER BY days_out DESC NULLS LAST, i.name`,
    [from, to, itemId || null]
  );

  const periodDays = Math.round((new Date(to) - new Date(from)) / 86400000) + 1;
  return rows.map(r => ({
    ...r,
    utilization_pct: periodDays > 0 ? Math.round((r.days_out / periodDays) * 1000) / 10 : 0
  }));
}

const CSV_COLUMNS = [
  ['code', 'Code'], ['name', 'Name'], ['category', 'Category'], ['brand', 'Brand'],
  ['checkout_count', 'Checkouts'], ['days_out', 'Days out'], ['utilization_pct', 'Utilization %'],
  ['last_used_at', 'Last used'], ['demand_misses', 'Turned away'], ['retired', 'Retired']
];

const csvCell = v => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = rows => [
  CSV_COLUMNS.map(([, label]) => csvCell(label)).join(','),
  ...rows.map(r => CSV_COLUMNS.map(([key]) => csvCell(r[key])).join(','))
].join('\r\n');

/**
 * `item_id` narrows to one item's own history (the "individual" report);
 * omitted, it's the whole fleet for the period. Same query either way —
 * a per-item report is just this with one row.
 */
api.get('/reports/usage', requireAdmin, async (req, res, next) => {
  try {
    const to = isoDate(req.query.to) ? req.query.to : localToday();
    const from = isoDate(req.query.from) ? req.query.from : shiftDays(to, -29);
    if (from > to) return bad(res, 400, 'The start date is after the end date.');
    const itemId = Number(req.query.item_id) || null;

    const rows = await usageReport({ from, to, itemId });

    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv');
      res.set('Content-Disposition', `attachment; filename="usage-${from}-to-${to}.csv"`);
      return res.send(toCsv(rows));
    }
    res.json({ from, to, rows });
  } catch (err) { next(err); }
});

/**
 * One item's own checkout history and unmet-demand hits for the period —
 * the drill-down behind a fleet report row, not a report of its own.
 */
api.get('/reports/usage/:itemId/detail', requireAdmin, async (req, res, next) => {
  try {
    const to = isoDate(req.query.to) ? req.query.to : localToday();
    const from = isoDate(req.query.from) ? req.query.from : shiftDays(to, -29);
    const itemId = Number(req.params.itemId);

    const { rows: checkouts } = await q(
      `SELECT c.id, c.out_at, c.returned_at, c.due_on,
              COALESCE(NULLIF(p.name, ''), p.email) AS holder_name
       FROM checkout_items ci
       JOIN checkouts c ON c.id = ci.checkout_id
       JOIN people p ON p.id = c.holder_id
       WHERE ci.item_id = $1 AND c.out_at::date <= $3 AND COALESCE(c.returned_at::date, CURRENT_DATE) >= $2
       ORDER BY c.out_at DESC`,
      [itemId, from, to]
    );
    const { rows: misses } = await q(
      `SELECT dm.id, dm.at, dm.kind, dm.wanted_from, dm.wanted_to,
              COALESCE(NULLIF(p.name, ''), p.email) AS person_name
       FROM demand_misses dm
       LEFT JOIN people p ON p.id = dm.person_id
       WHERE dm.item_id = $1 AND dm.at::date BETWEEN $2 AND $3
       ORDER BY dm.at DESC`,
      [itemId, from, to]
    );
    res.json({ checkouts, misses });
  } catch (err) { next(err); }
});

api.use((err, _req, res, _next) => {
  // multer rejects an oversized file from inside its own middleware, before
  // any route handler runs — it never gets the chance to set err.status, so
  // this is the only place left to turn it into the message someone actually
  // typing a filename over 5MB should see.
  if (err.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That photo is over the 5MB limit.' });
  }
  console.error('API error:', err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something broke on the server.' });
});
