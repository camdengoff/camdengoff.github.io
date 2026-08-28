import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Point it at your Postgres instance.');
  process.exit(1);
}

/* Render's managed Postgres requires TLS but uses a cert Node won't verify by
   default. Local Postgres usually has no TLS at all. */
const needsSsl = /render\.com|amazonaws\.com|neon\.tech|supabase\./.test(process.env.DATABASE_URL)
  || process.env.PGSSL === 'true';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  // Small Postgres plans cap connections hard. Tune with PG_POOL_MAX if you
  // see "too many clients" under load.
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

export const q = (text, params) => pool.query(text, params);

/** Run all statements in one transaction. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id             SERIAL PRIMARY KEY,
  email          TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL DEFAULT '',
  role           TEXT NOT NULL DEFAULT 'member',
  blocked        BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS login_tokens (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

/* Long-lived tokens for machines — the MCP server, scripts, anything that
   can't click a link in an inbox.

   Only the SHA-256 hash is stored. The token is shown once at creation and is
   unrecoverable afterwards, so a copy of this table is not a set of working
   credentials. Revoking sets revoked_at rather than deleting, so the audit
   trail survives. */
CREATE TABLE IF NOT EXISTS api_tokens (
  id           SERIAL PRIMARY KEY,
  token_hash   TEXT UNIQUE NOT NULL,
  person_id    INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_tokens_live_idx ON api_tokens(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS items (
  id         SERIAL PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'Uncategorized',
  brand      TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  serial     TEXT NOT NULL DEFAULT '',
  value_cents INTEGER,
  notes      TEXT NOT NULL DEFAULT '',
  retired    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_category_idx ON items(category);

CREATE TABLE IF NOT EXISTS kits (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kit_items (
  kit_id  INTEGER NOT NULL REFERENCES kits(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (kit_id, item_id)
);

CREATE TABLE IF NOT EXISTS checkouts (
  id          SERIAL PRIMARY KEY,
  holder_id   INTEGER NOT NULL REFERENCES people(id),
  actor_id    INTEGER REFERENCES people(id),
  project     TEXT NOT NULL DEFAULT '',
  out_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_on      DATE NOT NULL,
  returned_at TIMESTAMPTZ,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS checkouts_open_idx ON checkouts(returned_at) WHERE returned_at IS NULL;

CREATE TABLE IF NOT EXISTS checkout_items (
  checkout_id INTEGER NOT NULL REFERENCES checkouts(id) ON DELETE CASCADE,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (checkout_id, item_id)
);

CREATE TABLE IF NOT EXISTS reservations (
  id           SERIAL PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  start_on     DATE NOT NULL,
  end_on       DATE NOT NULL,
  project      TEXT NOT NULL DEFAULT '',
  fulfilled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reservation_items (
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  item_id        INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (reservation_id, item_id)
);

CREATE TABLE IF NOT EXISTS maintenance (
  id        SERIAL PRIMARY KEY,
  item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL DEFAULT 'Repair',
  notes     TEXT NOT NULL DEFAULT '',
  opened_on DATE NOT NULL DEFAULT CURRENT_DATE,
  closed_on DATE,
  opened_by INTEGER REFERENCES people(id)
);
CREATE INDEX IF NOT EXISTS maintenance_open_idx ON maintenance(item_id) WHERE closed_on IS NULL;

CREATE TABLE IF NOT EXISTS audit (
  id        SERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  person_id INTEGER REFERENCES people(id),
  action    TEXT NOT NULL,
  detail    JSONB NOT NULL DEFAULT '{}'::jsonb
);

/* One row per (kind, subject, day) so a restart or a double cron never
   sends the same nudge twice. */
CREATE TABLE IF NOT EXISTS notifications (
  kind    TEXT NOT NULL,
  ref     TEXT NOT NULL,
  on_date DATE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref, on_date)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

/* Migration state carried over from another system. external_ref holds the
   source system's order/reservation id so an import can be re-run safely. */
ALTER TABLE checkouts    ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS external_ref TEXT;
ALTER TABLE people       ADD COLUMN IF NOT EXISTS placeholder BOOLEAN NOT NULL DEFAULT FALSE;

/* Two labels, not one. "Project" was carrying both jobs — the client and the
   shoot — so a booking said "Easter" and you couldn't tell whether that was
   the campaign or the Sunday it was for. Existing rows keep whatever they had
   under project; shoot starts empty rather than being guessed at. */
ALTER TABLE checkouts    ADD COLUMN IF NOT EXISTS shoot TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS shoot TEXT NOT NULL DEFAULT '';

/* Who owns a piece of gear — Cheqroom's "Flag" column, values like FLMKR and
   GAT. Free text rather than an enum: it's whatever the export says, so a
   flag we haven't seen before still comes through instead of getting
   rejected at import time. */
ALTER TABLE items ADD COLUMN IF NOT EXISTS flag TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS items_flag_idx ON items(flag) WHERE flag <> '';

/* The photo itself, fetched once from wherever the import found it (Cheqroom's
   CDN) and kept here rather than hot-linked, so a gear photo still loads after
   the Cheqroom account this is replacing goes away. image_source is the URL it
   came from, kept only so a re-import can tell "same photo, skip the fetch"
   from "the export points somewhere new, fetch again" — it is never served to
   the browser. */
ALTER TABLE items ADD COLUMN IF NOT EXISTS image_data   BYTEA;
ALTER TABLE items ADD COLUMN IF NOT EXISTS image_type   TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN IF NOT EXISTS image_source TEXT NOT NULL DEFAULT '';

/* Kits are personal packages you build, edit and publish. They started as one
   global unowned list, so owner_id is nullable on purpose: NULL means the kit
   predates ownership and belongs to the team. See kitVisibleTo in policy.js.
   ON DELETE SET NULL rather than CASCADE — losing a person shouldn't quietly
   delete the packages the rest of the team checks out. */
ALTER TABLE kits ADD COLUMN IF NOT EXISTS owner_id   INTEGER REFERENCES people(id) ON DELETE SET NULL;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS shared     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE kits ADD COLUMN IF NOT EXISTS notes      TEXT NOT NULL DEFAULT '';
ALTER TABLE kits ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS kits_owner_idx ON kits(owner_id);

/* Asking someone to add gear to their own loan or hold.
   Exactly one of checkout_id / reservation_id is set — a request is about one
   booking, and a row that pointed at both (or neither) would have no sensible
   approve path. item_ids is a snapshot of what was asked for; the gear is
   re-checked against the rules at the moment of approval, not now, because
   days can pass and availability moves. */
CREATE TABLE IF NOT EXISTS gear_requests (
  id             SERIAL PRIMARY KEY,
  checkout_id    INTEGER REFERENCES checkouts(id) ON DELETE CASCADE,
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
  requester_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  holder_id      INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  item_ids       INTEGER[] NOT NULL DEFAULT '{}',
  note           TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'pending',
  reason         TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at     TIMESTAMPTZ,
  decided_by     INTEGER REFERENCES people(id),
  CONSTRAINT gear_requests_one_target
    CHECK ((checkout_id IS NULL) <> (reservation_id IS NULL))
);
CREATE INDEX IF NOT EXISTS gear_requests_open_idx
  ON gear_requests(holder_id) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS gear_requests_mine_idx
  ON gear_requests(requester_id) WHERE state = 'pending';

/* Two shapes of request now. 'add' asks the holder to put gear on their
   booking; 'swap' offers a trade — you take something of theirs, they take
   something of yours. offer_* is the half coming *from* the requester, and is
   empty for an add. Both halves are re-checked at approval, not now. */
ALTER TABLE gear_requests ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'add';
ALTER TABLE gear_requests ADD COLUMN IF NOT EXISTS offer_item_ids INTEGER[] NOT NULL DEFAULT '{}';
ALTER TABLE gear_requests ADD COLUMN IF NOT EXISTS offer_checkout_id INTEGER REFERENCES checkouts(id) ON DELETE CASCADE;
/* A trade's offered half can come from a loan of yours, a hold of yours, or
   straight off the shelf — all three are "what they get instead". Both null
   means free gear, which is why neither is required. */
ALTER TABLE gear_requests ADD COLUMN IF NOT EXISTS offer_reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE;
/* Where the gear you're asking for lands if they accept. */
ALTER TABLE gear_requests ADD COLUMN IF NOT EXISTS target_checkout_id INTEGER REFERENCES checkouts(id) ON DELETE CASCADE;
ALTER TABLE gear_requests ADD COLUMN IF NOT EXISTS target_reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE;
ALTER TABLE gear_requests ADD COLUMN IF NOT EXISTS decided_note TEXT NOT NULL DEFAULT '';

/* Extra people on a booking. A shoot is rarely one person, so a teammate can
   add gear to a loan or a hold without asking each time — but they're not the
   holder: taking gear off, checking in, extending and releasing all stay with
   whoever made it. One row per person per booking, exactly one target. */
CREATE TABLE IF NOT EXISTS booking_contributors (
  id             SERIAL PRIMARY KEY,
  checkout_id    INTEGER REFERENCES checkouts(id) ON DELETE CASCADE,
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
  person_id      INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  added_by       INTEGER REFERENCES people(id),
  added_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT booking_contributors_one_target
    CHECK ((checkout_id IS NULL) <> (reservation_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_contributors_co_idx
  ON booking_contributors(checkout_id, person_id) WHERE checkout_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS booking_contributors_res_idx
  ON booking_contributors(reservation_id, person_id) WHERE reservation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS checkouts_external_ref_idx
  ON checkouts(external_ref) WHERE external_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reservations_external_ref_idx
  ON reservations(external_ref) WHERE external_ref IS NOT NULL;

/* 'kits' has quietly meant two different things: a checkout preset someone
   curated by hand (the Packages tab), and a physical case Cheqroom already
   assembled (the Kits tab, import-only — see scripts/import-kits.js). They
   share a table because both are still just "a name and some item_ids", but
   the app now needs to tell them apart to know which page a row belongs on
   and which controls make sense for it (a case has no owner to duplicate or
   share on behalf of).
   Free text rather than an enum, matching items.flag's reasoning: an
   unexpected value still shows up somewhere instead of failing to insert.
   Defaults to 'package' — a plain INSERT with no type is far more likely to
   be someone's hand-built preset than a script-driven import, and every
   place that actually creates a kit now sets this explicitly anyway. */
ALTER TABLE kits ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'package';
CREATE INDEX IF NOT EXISTS kits_type_idx ON kits(type);

/* One-time backfill for rows that predate the column above. These are
   exactly the kit names scripts/import-kits.js has ever created from a
   Cheqroom kit export — matched by name and by owner_id IS NULL as a second
   check, since a physical kit is never personally owned. Everything else
   already defaults to 'package', including the handful of hand-curated
   presets that predate personal ownership entirely (see kits.owner_id above)
   — those were never physical, so leaving them at the default is correct,
   not an oversight. Safe to leave running on every boot: once a row is
   already 'kit', re-matching its name here is a no-op. */
UPDATE kits SET type = 'kit'
  WHERE owner_id IS NULL AND type = 'package' AND name IN (
    'Quasar Light Kit-1', 'Quasar Light Kit-2', 'Gimbal Rig',
    'C70 With Monitor-1', 'C70 With Monitor-2', 'Aputure B7C Kit',
    'GAT | DZO Primes Set (PL Mount)', 'GAT | Weekend Broadcast Kit',
    'Benro Sticks with Vinton Head'
  );

/* Which kit or package (if any) started this booking — a label, not a
   source of truth. checkout_items/reservation_items still decide what's
   actually reserved; this only lets the UI say "Aputure B7C Kit" instead of
   listing every item. ON DELETE SET NULL rather than CASCADE, for the same
   reason external_ref is nullable: deleting the kit later shouldn't take a
   real booking down with it, it should just fall back to listing items. */
ALTER TABLE checkouts    ADD COLUMN IF NOT EXISTS kit_id INTEGER REFERENCES kits(id) ON DELETE SET NULL;
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS kit_id INTEGER REFERENCES kits(id) ON DELETE SET NULL;

/* Optional photos — items, kits/packages, and people. Nullable everywhere;
   nothing is ever required to have one. Same BYTEA-in-Postgres shape items
   already used for photos fetched at import time (see image_data above),
   extended here to cover a person uploading one by hand instead of it
   arriving from a CSV.
   image_version exists purely for cache-busting: the image route tells the
   browser to cache a given URL forever (it's a photo, it doesn't change in
   place), which was safe when the only writer was a one-time import. Now
   that a photo can be replaced or removed, the URL itself has to change
   when the bytes do, or a browser that already has "/api/items/9/image"
   cached would never see the new one. Bumped on every upload and removal;
   never reset, never means anything on its own beyond "different from last
   time". */
ALTER TABLE items  ADD COLUMN IF NOT EXISTS image_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kits   ADD COLUMN IF NOT EXISTS image_data    BYTEA;
ALTER TABLE kits   ADD COLUMN IF NOT EXISTS image_type    TEXT NOT NULL DEFAULT '';
ALTER TABLE kits   ADD COLUMN IF NOT EXISTS image_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN IF NOT EXISTS image_data    BYTEA;
ALTER TABLE people ADD COLUMN IF NOT EXISTS image_type    TEXT NOT NULL DEFAULT '';
ALTER TABLE people ADD COLUMN IF NOT EXISTS image_version INTEGER NOT NULL DEFAULT 0;

-- The audit log has always been written to; nothing ever read it back until
-- now. Ordering by "at" is every query the viewer makes, so it's the one
-- index worth having on a table this write-heavy.
CREATE INDEX IF NOT EXISTS audit_at_idx ON audit(at DESC);

/* "Tell me when this is free." One-shot: notified_at is set the moment the
   email goes out and never cleared, so re-checking out and returning the
   same item a week later doesn't quietly resurrect an old watch nobody
   asked to keep. Watching again after that is a fresh row. UNIQUE stops a
   double-tap on the button from queuing the same person twice. */
CREATE TABLE IF NOT EXISTS item_watchers (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ,
  UNIQUE (item_id, person_id)
);
CREATE INDEX IF NOT EXISTS item_watchers_pending_idx ON item_watchers(item_id) WHERE notified_at IS NULL;

/* A checkout or reservation attempt that got blocked because the item was
   already out or already held — logged only when nothing interchangeable
   was free at the time (see isUnmetDemand in public/search.js), so this
   counts genuine unmet demand, not "wanted the exact unit but happily took
   the identical one next to it". Kept even when an admin overrides the
   block and the booking goes through anyway — the conflict was still real
   at the moment it was asked for. person_id is nullable because the person
   who asked matters less here than the fact that someone did; deleting
   their account shouldn't erase the demand signal itself. */
CREATE TABLE IF NOT EXISTS demand_misses (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  person_id   INTEGER REFERENCES people(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  wanted_from DATE NOT NULL,
  wanted_to   DATE NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demand_misses_item_idx ON demand_misses(item_id, at);

/* Recurring reservations are batch-created rows, not a live template that
   keeps generating more — series_id is only what ties them together after
   the fact, for showing "part of a series" and for the "cancel remaining"
   action. Nullable because a plain one-off reservation is never part of
   one. */
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS series_id UUID;
CREATE INDEX IF NOT EXISTS reservations_series_idx ON reservations(series_id) WHERE series_id IS NOT NULL;
`;

const DEFAULT_SETTINGS = {
  enforce_availability: 'true',   // hard-block gear that is out, down, or held
  enforce_reservations: 'true',   // hard-block gear held by someone else
  block_overdue_borrowers: 'true',// hard-block people sitting on overdue gear
  overdue_grace_days: '0',
  default_loan_days: '3',
  escalate_after_days: '3',       // cc admins on overdue notices after this long
  send_receipts: 'true',
  reminder_hour: '8'              // local hour to send the daily batch
};

export async function migrate() {
  await q(SCHEMA);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await q(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }

  // With sign-in switched off, every request runs as this person, so the row
  // has to exist before anything can be checked out in its name.
  if (process.env.AUTH_MODE === 'none') {
    await q(
      `INSERT INTO people (email, name, role) VALUES ($1, $2, 'admin')
       ON CONFLICT (email) DO UPDATE SET role = 'admin'`,
      ['demo@thecage.local', 'Demo User']
    );
  }

  // Promote the addresses in ADMIN_EMAILS, creating them if they've never signed in.
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const email of admins) {
    await q(
      `INSERT INTO people (email, role) VALUES ($1, 'admin')
       ON CONFLICT (email) DO UPDATE SET role = 'admin'`,
      [email]
    );
  }
  console.log(`Schema ready. ${admins.length} admin${admins.length === 1 ? '' : 's'} configured.`);
}

export async function settings(exec = q) {
  const { rows } = await exec('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export async function audit(personId, action, detail = {}) {
  await q('INSERT INTO audit (person_id, action, detail) VALUES ($1, $2, $3)',
    [personId, action, JSON.stringify(detail)]);
}
