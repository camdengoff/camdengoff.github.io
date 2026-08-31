# The Cage — notes for Claude

Gear checkout, reservations and repair tracking for a small film team.
Node + Express + Postgres on the server, plain ES modules in the browser.
**No build step, no framework, no bundler.** Edit a file in `public/` and
reload — that's the whole loop.

Read `README.md` for what the app does and how it deploys. This file is about
working *in* the code.

## Commands

```bash
npm run dev                       # localhost:3000, watch mode
npm test                          # 261 tests, no database needed
npm run seed                      # demo inventory + live activity
npm run seed -- --reset           # wipe demo data and re-seed
npm run invite -- x@life.church   # print a sign-in link (no mail needed)
npm run mail:test -- x@you.com    # verify SMTP before trusting it
./start.sh                        # one-command setup on a fresh Mac
```

`.env` is loaded by Node's `--env-file-if-exists`. There is **no `dotenv`
dependency** — don't add one, and don't add `import 'dotenv/config'`.

## Where things live

```
src/policy.js       checkout rules — pure, tested, no database
src/api.js          REST endpoints, server-side enforcement
src/db.js           pool + schema (creates itself on boot)
src/auth.js         magic-link sign-in and sessions
src/mailer.js       SMTP transport and all email templates
src/reminders.js    the daily batch, with send-once claiming
src/server.js       express app, static hosting, in-process cron
public/app.js       the client — views, sheets, events
public/calendar.js  timeline rendering, conflict and schedule maths
public/search.js    fuzzy gear matching — pure, tested
public/dateparse.js calendar day search — pure, tested
public/kitlink.js   kits as shareable links — pure, tested
public/breakdown.js inventory summarised by category — pure, tested
public/icons.js     placeholder gear icons, by category then name
scripts/            importers, demo seed, invite, mail test, reminder runner
```

## Working alongside someone else

Two people work on this, each with their own Claude and their own local
Postgres. Nothing is shared until it's pushed.

- **Branch, don't commit to `main`.** `git checkout -b what-youre-doing`, then
  `gh pr create`. Two Claudes committing to `main` will collide, and a PR is
  the only place the other person sees what yours actually did.
- **Pull before you start.** `git pull --rebase origin main`.
- **CI runs the tests on every PR**, plus a check that the single-file demo
  still builds and that no personal data reached `public/demo-data.js`.
- **Databases are separate.** Your checkouts never appear on their machine.
  Only a deployed instance gives you shared data.
- **Generated files:** `dist/` (gitignored), `public/demo-data.js` and
  `public/real-activity-data.js`. Rebuild with `npm run build:standalone`,
  `npm run demo:data` and `npm run demo:activity`; don't hand-edit.
  `scripts/person-tags.json` is *not* generated — it's the persisted
  id→label map (`Member A`, `Member B`, …) that keeps each real person's
  anonymous tag stable across re-runs. Commit it; never add a name or email
  to it by hand.

### Knowing where things stand

```bash
npm run status
```

Your branch, uncommitted files, how far you are ahead of and behind `main`,
what's landed on `main` that you haven't pulled, open PRs, and the last few CI
runs. Read-only — it fetches but never merges.

### Running your version and main at the same time

A second worktree checks out `main` in its own directory, sharing the same
`.git`, so you can compare against what's actually released without stashing:

```bash
git worktree add ../the-cage-main main
cd ../the-cage-main && npm install && PORT=3001 npm run dev
```

Yours on :3000, `main` on :3001. They share a database unless you point
`DATABASE_URL` somewhere else. Remove it with
`git worktree remove ../the-cage-main`.

One catch: while a worktree holds `main`, `gh pr merge --delete-branch` fails
at the end with *"'main' is already used by worktree"*. **The merge itself
succeeds** — only gh's tidy-up afterwards doesn't. Check with `gh pr view <n>`
before re-running anything, then update the worktree with
`cd ../the-cage-main && git pull`.

## The MCP server

`mcp/server.js` exposes the cage to Claude as tools. It is a **thin client over
the REST API** — that is the design, not an implementation detail:

- It authenticates with an API token that maps to **one person**, so every
  action is attributed and constrained by that person's role.
- It has no database access. `src/policy.js` refuses it exactly as it refuses
  the browser, so a bug here cannot create a state the API would have rejected.
- New tools belong in `mcp/server.js` calling existing endpoints. If a tool
  needs something the API can't do, add the endpoint first.

**Nothing may be written to stdout except protocol messages** — the transport
is stdio, and a stray `console.log` corrupts the stream. Log to stderr.

```bash
npm run token -- --new "Claude MCP" --for x@life.church   # mint (shown once)
npm run token -- --list / --revoke <id>
CAGE_TOKEN=... node test/mcp-smoke.js                     # drive it over stdio
```

Tokens are stored as SHA-256 hashes; the plaintext is unrecoverable. The smoke
test is not part of `npm test` because it needs a database and a running app.

## The rule that matters most

**`src/policy.js` decides what's allowed. The client only advises.**

That covers kit ownership too: `kitVisibleTo` / `kitEditableBy` /
`kitDeletableBy` live there, the API calls them, and `/api/state` filters
invisible kits out in SQL so they never reach a browser. `owner_id IS NULL`
means a kit predates ownership and belongs to the team — don't "fix" it by
backfilling a `shared` flag, which would be a lie the moment an admin unticked
it.

`kits.type` is a separate axis from ownership — `'package'` (Packages tab,
hand-curated, everything above applies) vs `'kit'` (Kits tab, physical,
import-only, no owner ever). Both still live in `kits`/`kit_items`; the two
tabs are `S.kits.filter(k => k.type === ...)` in `public/app.js`, not two
tables.

`checkouts.kit_id` / `reservations.kit_id` are a label, not a claim —
`checkout_items`/`reservation_items` still decide what's actually reserved.
It only lets `kitBookingLabel()` show "Aputure B7C Kit" instead of every
item's name, and only when the booking's gear still covers the kit's
*current* contents — if it doesn't, that function returns `null` and the
caller falls back to the plain list rather than naming a kit that isn't all
there. Set once at creation (first kit added wins — see `setCartKit()` in
`public/cart.js` and `NEW_RES_KIT_ID` in `public/app.js`), never rewritten.

The UI has its own availability filters and a conflict picker, and they agree
with the server because they read the same bookings — but the server is the one
that can't be bypassed. If you change how blocking works, change it in
`policy.js`, add a test, and let both sides read from there. Never enforce a
rule only in `public/`.

## Testing

Tests cover the **pure** modules only — `policy.js`, `calendar.js`,
`search.js`, `dateparse.js`, `kitlink.js`, `breakdown.js`, and the pure bits
of `icons.js`/`cart.js` — so `npm test` needs no database and runs in
under a second. That's deliberate: keep new logic pure and testable rather
than reaching for a test database.

Rendering tests assert on structure (`tl-bar late`, `--lane:1`), never pixels.

## Conventions

- **Escape everything interpolated into HTML.** `esc()` in `app.js` and
  `calendar.js`, `escape()` in `mailer.js`. Both client modules define their
  own; that's intentional so `calendar.js` stays standalone.
- **Parameterised SQL only.** Where columns are dynamic (`PATCH /items/:id`)
  they come from a hardcoded allowlist, never from request keys.
- **Comments explain why, not what.** Match the existing density — the tricky
  decisions are commented, the obvious lines aren't.
- Client state lives in a few module-level objects (`S`, `CAL`, `PICK`).
  Views are functions returning HTML strings; `render()` swaps `#view`.
- Events are delegated from `document` via `data-act` attributes. Add a case
  to the switch in `app.js` rather than attaching listeners.

## Gotchas that have already bitten

- **An open loan's bar runs to at least today, not to its due date.** An
  overdue loan whose bar stopped at the due date vanished from any window
  starting today — the late gear disappearing exactly when you need it.
  Handled in both `/api/calendar` and `bookingsFromState()`; keep them in step.
- **Sign-in is by emailed link, so no SMTP means nobody can get in.** The app
  otherwise looks healthy. The gate says so explicitly when `mailConfigured`
  is false — don't "simplify" that message away. `npm run invite` is the
  escape hatch.
- **Static assets are served `max-age=0` with ETags.** Filenames aren't
  hashed, so a long cache leaves people on stale `app.js` after a deploy.
- **Reminders are claimed once per (kind, subject, day)** in the
  `notifications` table. A second run sends nothing — that's correct, not a
  bug. `DELETE FROM notifications` to re-test.
- **`checkouts` and `reservations` are serialised with a Postgres advisory
  lock** inside one transaction. The availability read must run on the
  transaction's client (`exec`), or the lock protects nothing.
- Postgres `CURRENT_DATE` is the server's timezone; the app's "today" is
  `localToday()` in `TZ_NAME`. Pass the app's today into SQL rather than
  mixing the two.
- **A kit's `type` defaults to `'package'`, not `'kit'`.** A plain
  `INSERT INTO kits (name) ...` with no `type` is far more likely to be
  someone's hand-built preset than a script-driven import, so every place
  that actually creates a *physical* kit (`scripts/import-kits.js`) sets
  `type = 'kit'` explicitly rather than relying on the default. If you add
  another way to create a kit, do the same — don't lean on the default.
- **Ticking a `.pick` checkbox by code doesn't sync the cart.** The listener
  that keeps `CART.items` current only fires on a real click's `input`
  event; `paintPickList()` re-rendering checkboxes programmatically (the
  kit/package quick-add dropdowns) doesn't trigger it. Anything that ticks
  boxes without a real click has to call `syncCartFromPicker()` itself, or
  the cart silently falls behind what's on screen until the next real
  checkbox click happens to catch it up — which is exactly the bug that
  shipped with the original "Start from a kit" control.
- **Photos (items, kits/packages, people) live in Postgres, not on disk.**
  `image_data`/`image_type`/`image_version` on the row itself — same BYTEA
  shape items already used for a photo fetched at import time, extended in
  `src/api.js`'s `photoRoutes()` to cover a photo uploaded by hand for any of
  the three. Deliberately not local disk: Render's free/starter web plans
  have no persistent filesystem, so anything written there is gone on the
  next deploy. If this ever needs to move to S3/R2, `photoRoutes()` is the
  one place that has to change.
  - **`image_version` exists only so the browser's forever-cache on
    `GET /:kind/:id/image` stays honest.** That route tells the browser to
    cache a given URL for a year, which was safe when the only writer was a
    one-time import — it isn't once a photo can be replaced or removed. Every
    write bumps the version; the client always asks for `?v=<image_v>`, so a
    changed photo is a new URL, not a cache to invalidate. Anything that
    writes `image_data` directly (a new import path, a script) has to bump
    `image_version` in the same statement or a browser that already cached
    the old photo will never see the new one. `scripts/import-csv.js` does
    this on the update path; skip it and you've reintroduced the bug.
  - **A file's own `multer.MulterError` (too large) never reaches a route
    handler's try/catch** — multer's own middleware throws before your code
    runs. Handled once, in `api.js`'s router-level error handler, rather than
    per route.

## Deploying

`render.yaml` is a Render blueprint, currently on **free plans** for demoing.
Its header documents the two consequences (the instance sleeps, so reminders
must come from the GitHub Actions workflow; free Postgres expires) and the
two-line change to paid.
