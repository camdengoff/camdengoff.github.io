import { q, settings } from './db.js';
import { send, templates } from './mailer.js';

const TZ = process.env.TZ_NAME || 'America/Chicago';

/** Today's date in the team's timezone, not the server's. */
export function localToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

const dayDiff = (a, b) =>
  Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86_400_000);

/**
 * Claim a notification slot. Returns false if this exact nudge already went
 * out today, so a restart, a retry, or two overlapping cron triggers can't
 * double-send. The unique constraint does the work, not a read-then-write.
 */
async function claim(kind, ref, onDate) {
  const { rowCount } = await q(
    `INSERT INTO notifications (kind, ref, on_date) VALUES ($1, $2, $3)
     ON CONFLICT (kind, ref, on_date) DO NOTHING`,
    [kind, String(ref), onDate]
  );
  return rowCount === 1;
}

async function openCheckoutsWithItems() {
  const { rows } = await q(`
    SELECT c.id, c.due_on::text AS due_on, c.project, c.out_at,
           p.id AS person_id, p.email, p.name, p.blocked,
           COALESCE(json_agg(json_build_object('name', i.name, 'code', i.code)
             ORDER BY i.name) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
    FROM checkouts c
    JOIN people p ON p.id = c.holder_id
    LEFT JOIN checkout_items ci ON ci.checkout_id = c.id
    LEFT JOIN items i ON i.id = ci.item_id
    WHERE c.returned_at IS NULL
    GROUP BY c.id, p.id
    ORDER BY c.due_on`);
  return rows;
}

async function pickupsFor(today) {
  const { rows } = await q(`
    SELECT r.id, r.start_on::text AS start_on, r.end_on::text AS end_on, r.project,
           p.id AS person_id, p.email, p.name,
           COALESCE(json_agg(json_build_object('name', i.name, 'code', i.code)
             ORDER BY i.name) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
    FROM reservations r
    JOIN people p ON p.id = r.person_id
    LEFT JOIN reservation_items ri ON ri.reservation_id = r.id
    LEFT JOIN items i ON i.id = ri.item_id
    WHERE r.cancelled_at IS NULL AND r.fulfilled_at IS NULL AND r.start_on = $1
    GROUP BY r.id, p.id`, [today]);
  return rows;
}

/**
 * The whole daily batch. Safe to call as often as you like — every message is
 * claimed before it's sent.
 */
export async function runReminders({ today = localToday(), verbose = true } = {}) {
  const cfg = await settings();
  const escalateAfter = Number(cfg.escalate_after_days || 3);
  const log = [];
  const note = (kind, to) => { log.push(`${kind} → ${to}`); if (verbose) console.log(`  ${kind} → ${to}`); };

  const { rows: adminRows } = await q(`SELECT email FROM people WHERE role = 'admin'`);
  const adminCc = adminRows.map(a => a.email).join(', ') || undefined;

  /* ---- holds being collected today ---- */
  const pickups = await pickupsFor(today);
  for (const r of pickups) {
    if (!r.items.length) continue;
    if (!(await claim('pickup', r.id, today))) continue;
    const t = templates.pickupToday({ person: r, items: r.items, reservation: r });
    await send({ to: r.email, ...t });
    note('pickup', r.email);
  }

  /* ---- due and overdue ---- */
  const open = await openCheckoutsWithItems();
  let overdueCount = 0;

  for (const c of open) {
    if (!c.items.length) continue;
    const delta = dayDiff(c.due_on, today); // >0 future, 0 today, <0 overdue

    if (delta === 1) {
      if (await claim('due_tomorrow', c.id, today)) {
        await send({ to: c.email, ...templates.dueTomorrow({ person: c, items: c.items, checkout: c }) });
        note('due-tomorrow', c.email);
      }
    } else if (delta === 0) {
      if (await claim('due_today', c.id, today)) {
        await send({ to: c.email, ...templates.dueToday({ person: c, items: c.items, checkout: c }) });
        note('due-today', c.email);
      }
    } else if (delta < 0) {
      overdueCount += c.items.length;
      const days = -delta;
      // Daily for the first week, then Mondays only, so it nags without becoming noise.
      const weekday = new Date(today + 'T12:00:00Z').getUTCDay();
      const shouldSend = days <= 7 || weekday === 1;
      if (shouldSend && await claim('overdue', c.id, today)) {
        const t = templates.overdue({
          person: c, items: c.items, checkout: c, days,
          blocked: String(cfg.block_overdue_borrowers) === 'true'
        });
        await send({
          to: c.email,
          cc: days >= escalateAfter ? adminCc : undefined,
          ...t
        });
        note(`overdue-${days}d${days >= escalateAfter ? '+cc' : ''}`, c.email);
      }
    }
  }

  /* ---- admin digest ---- */
  if (adminCc && await claim('digest', 'all', today)) {
    const { rows: [down] } = await q(`SELECT count(*)::int AS n FROM maintenance WHERE closed_on IS NULL`);
    const outCount = open.reduce((n, c) => n + c.items.length, 0);
    await send({
      to: adminCc,
      ...templates.digest({
        rows: { out: outCount - overdueCount, overdue: overdueCount, down: down.n, pickups: pickups.length }
      })
    });
    note('digest', adminCc);
  }

  if (verbose) console.log(`Reminders for ${today}: ${log.length} message(s).`);
  return { today, sent: log };
}
