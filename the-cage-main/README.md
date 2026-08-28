# The Cage

Gear checkout, reservations, and repair tracking for a small film team. Built to
replace a per-seat rental of Cheqroom with something you host yourself for the
price of a coffee, with unlimited people.

- Postgres-backed, so everyone sees the same inventory
- Magic-link sign-in — no passwords to manage, no seat licences
- Hard blocks on checking out gear that isn't available, and on people who are
  sitting on overdue kit
- Automatic email: checkout receipts, pickup reminders, due-tomorrow,
  due-today, escalating overdue notices, and a morning digest for admins
- QR labels that deep-link straight to an item
- Responsive: bottom tab bar on a phone, sidebar rail on a desktop

---

## 1. Deploy to Render

The repo has a `render.yaml` blueprint, so Render provisions the web service and
the database together.

`render.yaml` is currently set to Render's **free plans**, for showing the app
around before paying for anything. Read the header of that file before relying
on it: a free web service sleeps after ~15 minutes (so the built-in reminder
cron never fires — use the GitHub Actions workflow, §3) and Render's free
Postgres is time-limited and deleted when it expires. Switching to paid is two
lines, documented in the same place.

1. **Sort out email first** — see below. Nobody can sign in without it.
2. Push this repo to GitHub.
3. In Render: **New → Blueprint**, point it at the repo, apply.
4. Render creates `cage` (web service) and `cage-db` (Postgres). `DATABASE_URL`
   is wired automatically.
5. Fill in the env vars marked `sync: false` — see the table below.
6. Deploy. The schema creates itself on first boot; there is no migration step
   to run.
7. Open the URL, enter your email, click the link in your inbox. You're in.

Whatever addresses you list in `ADMIN_EMAILS` are promoted to admin on every
boot, so you can't lock yourself out. If the people table is empty, the very
first person to sign in becomes an admin too.

**Set `ADMIN_EMAILS` before the first deploy.** That fallback exists so a fresh
install isn't locked out of itself, but combined with a blank
`ALLOWED_EMAIL_DOMAINS` it would hand admin to whichever stranger signs in
first. Setting `ADMIN_EMAILS` creates a person row on boot, so the table is
never empty and the fallback can't fire.

To show it to people before any real gear exists, seed a demo cage — see §2.

### Environment variables

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. Use Render's **Internal** URL. |
| `APP_URL` | yes | The real public URL. Sign-in links are built from it, so a wrong value produces links that go nowhere. |
| `ADMIN_EMAILS` | yes | Comma-separated. Promoted to admin on every boot. |
| `ALLOWED_EMAIL_DOMAINS` | recommended | e.g. `life.church`. Blank means any address can request a link. |
| `MAIL_FROM` | yes | e.g. `The Cage <cage@life.church>` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | yes | Any SMTP provider. Without these the app still runs and logs mail to the console instead of sending it. |
| `CRON_SECRET` | see §3 | Shared secret for the external reminder trigger. |
| `TZ_NAME` | no | Defaults to `America/Chicago`. Controls what "today" and "8am" mean. |
| `PG_POOL_MAX` | no | Defaults to 8. Lower it if a small Postgres plan complains about connections. |

### Email provider

**Mail is not optional.** Sign-in is by magic link, so with no working SMTP
nobody can get in — and the app gives no clue why, because it falls back to
logging mail to the console and otherwise looks healthy. Configure this before
you hand the URL to anyone.

Check it without deploying, and without a database:

```bash
npm run mail:test -- you@example.com
```

That verifies the credentials, sends a real message, and tells you which of the
usual mistakes you made if it fails.

The catch when picking a provider is **who you're allowed to send to**:

| Provider | Sends to anyone? | Setup |
|---|---|---|
| **Brevo** | Yes, after verifying one sender address | Minutes, no DNS access needed. 300/day free. |
| **Resend** | Only your own address until a domain is verified | Needs DNS records on a domain you control |
| **Postmark** | Same — domain verification first | Needs DNS |
| **Microsoft 365** | — | Will fight you over basic auth being disabled tenant-wide |

So for a demo, or any situation where you can't get DNS records added to
`life.church` quickly, **Brevo is the path of least resistance**:

```
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=8a1b2c001@smtp-brevo.com   # the SMTP login, NOT your email address
SMTP_PASS=xsmtpsib-xxxxxxxxxxxx      # an SMTP key, NOT your account password
MAIL_FROM=The Cage <you@life.church> # must be verified in Brevo
```

Those two "NOT" lines are where most of the lost time goes.

For the real rollout, verify the sending domain properly (SPF/DKIM) with
whichever provider you settle on. Overdue notices that land in spam are worse
than no overdue notices, because everyone assumes they were sent.

---

## 2. Import your gear

Export your inventory from Cheqroom as CSV, then:

```bash
npm install
export DATABASE_URL="...your Postgres URL..."

node scripts/import-csv.js ~/Downloads/cheqroom-export.csv --dry
```

The dry run prints the column mapping it detected and the rows it would create,
and writes nothing. Check the mapping, then drop `--dry` to commit.

Column names are matched loosely and case-insensitively — `Asset Tag`,
`asset_tag` and `Barcode` all resolve to the item code. Rows are matched on code
first and serial second, so **re-running the import updates existing gear rather
than duplicating it.** Any row without a usable code gets one generated; the
script tells you how many, so you know to print fresh labels for those.

Print labels from **Gear → QR labels** (admin only). Each label encodes a URL,
so a phone camera pointed at a case opens that item directly.

### Or: seed a demo cage

To show the app to people before any real gear exists, `scripts/seed-demo.js`
fills it with a plausible film inventory and enough live activity that the
board, the calendar and the reminder batch all have something to show.

```bash
npm run seed              # add anything missing
npm run seed -- --reset   # wipe the demo data and start over
```

24 items across camera/lens/lighting/audio/support/grip/power, four crew, three
kits, four open checkouts (one overdue, one due today), a returned loan, three
reservations, and two repair tickets. Everything is dated relative to
`CURRENT_DATE`, so a demo left up for a month still looks current.

It refuses to run against a database holding gear it didn't create, so it can't
scribble over a real inventory — override with `--force` if you're certain.
Demo people are marked `placeholder` and use `@example.com` addresses, so
they're easy to spot and clear out under **Admin → People** later.

---

## 2b. Bring over what's already out

Inventory alone isn't enough to switch over — on day one, gear is on shoots and
shoots are booked. `scripts/import-orders.js` carries live state across.

Cheqroom's own exports don't arrive in this shape, so reshape them first:

```bash
node scripts/reshape-cheqroom.js \
  --items=items.csv --reservations=reservations.csv --out=./out
```

That writes `checkouts.csv`, `reservations.csv` and, if any exist, `repairs.csv`.
Three things it handles that will otherwise bite:

- **Reservations don't name their gear.** The items are a comma-separated list
  of Cheqroom's internal ids, so a reservations export is only importable when
  joined back to the items export — which is why both files are needed.
- **The reservation dates are malformed**, arriving as `2026-09-09/30/26` — a
  `YYYY-MM-` prefix glued onto a US `MM/DD/YY`.
- **Gear parked for repair is checked out to a contact called "Maintenance"**
  with the address `todo@update.me`. Importing that as a loan invents a person
  and shows the gear as out with them rather than down for repair, so those
  rows are split into `repairs.csv` to raise as tickets instead.

Then:

```bash
# always dry-run first
node scripts/import-orders.js orders.csv       --kind=checkout    --dry
node scripts/import-orders.js reservations.csv --kind=reservation --dry

# then commit
node scripts/import-orders.js orders.csv       --kind=checkout    --people=map.csv
node scripts/import-orders.js reservations.csv --kind=reservation --people=map.csv
```

Run the inventory import first. This script **never creates gear** — an order
referring to unknown equipment is reported, not invented, because silently
conjuring an item makes a migration look successful when it wasn't.

### What it handles

- **Either export shape.** One row per order with items on it, or one row per
  line item repeating the order reference. Grouping on the reference covers both.
- **Closed rows are skipped.** Anything marked returned, closed, cancelled or
  completed is ignored, as are reservations whose end date has already passed.
- **Mixed date formats.** ISO, `M/D/YYYY`, `D/M/YYYY` and `12 Aug 2026` all
  parse. Ambiguous numeric dates are only read day-first when the first number
  can't be a month — it fails loudly rather than guessing wrong quietly.
- **Re-running is safe.** The source system's order id is stored in
  `external_ref` under a unique index, so a second run reports "already
  present" instead of double-booking your cameras.

### People

Matching runs in this order: the `--people` map, then email, then name against
existing accounts.

Anyone whose **email is in the export** gets a real account created
automatically. They've never signed in, but a magic link to that address works
immediately, so there's nothing to invite.

Anyone with only a **name** needs a two-column mapping file:

```csv
Source name,Email
Priya Raman,priya.raman@life.church
Marcus Webb,marcus.webb@life.church
```

The dry run prints every unrecognised name, so the practical loop is: dry-run,
paste the names into `map.csv`, dry-run again, commit. If you'd rather not chase
addresses first, `--allow-placeholders` creates stub accounts at
`@placeholder.invalid` that hold the gear correctly but can't sign in until an
admin fixes the address under **Admin → People**.

### The email storm, and why it's suppressed

This is the part that bites. Import twenty open checkouts where three are
already past due, and the next reminder batch emails those people an overdue
notice for gear they took out under the old system — plus a pickup notice for
every hold starting that day. That is a poor first impression of a tool you
want people to trust.

So the importer pre-claims today's notification slots for everything it creates.
**The first batch after a migration sends nothing about imported rows.** The
following morning behaves normally. Pass `--notify-immediately` if you actually
want the nudges to go out on day one.

The admin digest still sends, so you get the full picture.

### One thing to check before day one

If anyone is holding overdue gear at cutover, `block_overdue_borrowers` will
stop them checking anything out — which on a Monday morning reads as "the new
system is broken". The importer warns you when this applies. Either chase the
gear first, or raise `overdue_grace_days` on the Admin screen for the first week
and lower it once everyone's caught up.

### If a CSV export isn't available

Cheqroom also has a REST API covering orders and reservations. Because this
sandbox can't reach it, the puller isn't written yet — send a sample response or
your API docs and the exact field mapping is a small addition. Either way the
importer above is what ingests it; the API script would just produce the same
normalised CSV.

---

## 2bb. Getting around

The tabs are ordered by how often they're used, not by how much they contain.

**Check Out** is the landing tab and deliberately holds almost nothing: check
out, reserve, scan a code, and the list of what you're personally holding so
you can check it back in. Someone standing in the gear room with a camera under
one arm should not have to read an inventory to get out of the door.

**Gear** is everything else about the fleet — the status strip, the alerts, the
full inventory, and the filters.

- **The strip at the top is one bar per category**, not one rectangle per
  item. A rectangle each worked at two dozen items and became texture at 459 —
  you could see that something was yellow without being able to tell what, and
  a 9px hover target didn't fix it. A category is the unit people think in
  ("have we got cameras free?"), and eight of them fit where 459 didn't.
  Every segment is a filter: tap the sliver of *held* under Cameras and the
  list below is those four cameras. Tap it again to clear.
- **Status chips** double as the legend. The colours already mean something, so
  tapping *Out*, *Overdue*, *Held* or *Down* filters to exactly those.
- **Category chips** narrow to Camera, Lens, Lighting, Audio and so on, built
  from whatever categories your inventory actually uses.
- **The search is forgiving.** `sigmma 1835` finds the Sigma 18-35, `canon
  24-70` matches when the brand and the name each hold half of what was typed,
  and codes and serials are searched too. Exact matches still rank first; the
  fuzziness only decides what else is worth showing. The matching rules are
  pure functions in `public/search.js` with tests in `test/search.test.js`.
- **A photo is optional, everywhere.** Gear, kits, packages, and people can
  all have one — attached by hand from their edit screen (JPG/PNG/WEBP, up to
  5MB), or arriving with gear at import time if the export has an image URL.
  Nothing requires one: without a photo, an item falls back to a line-drawing
  icon picked from its category (refined by name, so a tripod, a gimbal and a
  slider don't all get the same glyph), a kit or package falls back to a
  generic case icon, and a person falls back to their initials. Every photo
  lives in Postgres rather than on disk — see `CLAUDE.md` for why.

**Reservations** is the ledger — the act of reserving lives on the Check Out
tab. With a real cage this runs to dozens of holds months out, so it narrows
down rather than scrolls:

- **Search** covers who booked it, the project, and *the gear on the hold* —
  the same forgiving matcher as everywhere else, so a typo or a code still
  lands.
- **Filter by person**, built from whoever actually holds something.
- **A date range**, with From/To pickers and This week / This month / Next 30
  days. A hold counts as inside a range if any part of it falls there, so a
  shoot running across the end of the month still shows under that month.
- **Soonest or Latest** first, and anything running today is tagged `now`.

The line above the list says how much of the total you're looking at, so a
filter can't quietly hide half the book.

### Packages — your own saved gear selections

**Packages** are checkout presets you build once for a specific kind of
shoot: the interview rig, the run-and-gun bag, the two-camera podcast setup.
A package is a saved *selection*, not a reservation — the gear stays free
until someone actually takes it.

The tab has two collapsible sections. **Your packages** are the ones you
built, and opens by default because it's what you came for. **Team packages**
is a browse, so it starts closed.

- **Yours are yours.** You build them, edit them and delete them. Nobody else
  can change a package you own — not even an admin. A half-built preset is a
  draft, and quietly rewriting someone's draft under their name is worse than
  being unable to help.
- **Share publishes it.** A shared package shows up in everyone's Team list.
  They can see it, check it out and copy it; only you can change it. Unshare
  and it drops back to private.
- **Duplicate is how you borrow someone's thinking.** Copying needs only the
  right to see the package. The copy is yours, starts private, and diverges
  from there — publishing it again is a separate decision.
- **Start from a kit** appears above the gear list in the checkout and reserve
  sheets, listing every package (and every physical kit — see below) so you
  can add one in a tap. It *adds* to what's already ticked rather than
  replacing it, so a shoot needing two presets doesn't mean hunting for
  fifteen items by hand.
- Gear that gets retired after a package was built stays listed and ticked in
  the editor rather than vanishing on the next save. Dropping it should be a
  choice.

**Finding one.** The search above the sections covers package names, their
notes, and *the gear inside them* — looking for "the one with the Sigma in
it" is at least as common as remembering what you called it. It's the same
forgiving matcher the Gear tab uses, so typos and codes both land. A package
named for what you typed still outranks one that merely contains it. **All /
Yours / Team** narrows which section you're searching; picking one opens it,
and a search opens whatever it found.

### Kits — physical gear bundles

**Kits** are the other, simpler shape: a case that already holds a fixed set
of gear — a Pelican of eight Aputure B7Cs, a gimbal rig with its monitor and
lens. Cheqroom called these kits too, and the name stuck for the concept even
though the tab now means something narrower than it used to.

Unlike a package, a kit has no personal owner — nobody duplicates a case, or
shares one that was already visible to the whole team — so the Kits tab is a
flat list with none of a package's Yours/Team scoping, sharing or duplicating.
An admin can still fix a kit's contents or delete one that's been broken up;
that's maintenance, not ownership.

Kits arrive via `scripts/import-kits.js` from a Cheqroom kit export — there's
no "build a kit" button, only "Build a package". Checking one out (or holding
it, or adding it to your cart) works exactly like a package: it resolves to
its individual gear and reserves each item, not the kit itself. See
`CLAUDE.md`'s gotchas for why that's true by construction rather than
something the import had to implement separately.

Both live in the same `kits`/`kit_items` tables under a `type` column
(`'package'` or `'kit'`) — the tables predate the distinction, so this is a
column, not a rename.

### Sending a package to someone as a link

**Send link** on any package puts a link on your clipboard — or straight into
the share sheet on a phone, which is the actual "text it to them". Whoever
opens it sees what's inside and can save it to their own with one tap. They
can rename it first, and it saves private — always as a package, since a
saved copy is always personally owned.

The whole thing travels *inside* the link rather than as a pointer to a row,
for two reasons:

- **Item ids are per-database.** A link like `#kit/12` built on one instance
  resolves to whatever happens to be row 12 on another. Not an error — just the
  wrong gear, which is worse. The link carries the **codes printed on the
  cases**, which are the same everywhere the inventory came from one export.
- **The single-file build has no server**, so there's nothing to look up. A
  self-contained link works there, on a hosted cage, and between the two.

A three-item package is a 134-character URL and an eight-item one is 236, so
it fits in a text message without shortening.

Things it deliberately does:

- **Reports gear it can't find rather than dropping it.** "6 of 8 items" tells
  you to go and find the other two; silently saving 6 does not. If none of the
  codes match, it says the link came from a different inventory and doesn't
  offer to save anything.
- **Refuses a damaged link** instead of guessing. This arrives from a text
  message, so it's untrusted input: it parses cleanly or it's ignored, and a
  link from a future format version is refused rather than half-read.
- **Suggests a distinct name** if you already have one called that, so
  opening the same link twice leaves two you can tell apart.
- **Is a snapshot.** Editing your package later doesn't change a link you
  already sent. That's the right trade for something sent over SMS — the
  alternative is a link that silently changes under the person you sent it to.

The format is pure and tested in `public/kitlink.js` / `test/kitlink.test.js`
— it still deals in "kits" internally, the wire format and the underlying
table predate the Packages/Kits split.

Visibility is enforced in SQL, so a package you can't see never reaches your
browser at all. Editing, sharing, duplicating and deleting are decided by
`kitVisibleTo` / `kitEditableBy` / `kitDeletableBy` in `src/policy.js`, tested
in `test/policy.test.js`, and checked again on the server — the buttons the UI
hides are refused even if you call the API directly.

Packages predate ownership too, and some still exist as one unowned global
list from before personal ownership existed. Those still work: a package with
no owner belongs to the team, stays visible to everyone, and can be
maintained by an admin. It can't be made private, because there's nobody to
make it private for.

### Finding gear without scrolling

Both the checkout and reserve sheets have a **search box** above the gear list,
using the same forgiving matcher as the Gear tab — name, brand, model, category
and code, with typos tolerated. 459 items is too many to scroll.

**Start from a kit** is a button; press it and the list appears — every
package and every physical kit together. Adding one *stacks* onto whatever
is already ticked, so a shoot needing two presets isn't thirty manual ticks.

**The cart icon in the header opens the review screen** — your list on its own,
with a × beside each item, the dates, and *Check out*. The picker has to show
all 459 items so you can find things, which makes it useless for checking what
you've actually got: you'd be scanning a long list for ticks. This is the other
half of that. **Add more gear** goes back to the picker, and **Go to checkout**
comes forward again, so the two screens are a loop rather than a dead end.

Unavailable gear gets a card on the review screen naming who has it, offering
the free identical units to swap in, and a Remove button — the same
spare-finding the picker uses. The confirm button stays disabled until it's
dealt with, but dealing with it never means going back: the fix is one tap
from the thing that told you about it. When nothing identical is free it says
so rather than suggesting something that isn't the same.

Anything you've ticked stays on screen even when it fails the search or the
availability filter, and the line above the list says how many selected items
are being kept visible that way. A list that quietly drops something out of
your cart is worse than a list with an extra row in it.

### When a kit or package has gear that's already out

The whole thing goes into the list, including the parts that aren't
available. Preselecting only the free items hid the gap — you'd be told
there was a conflict without being shown which item, and what you thought
you were taking wasn't what was in front of you.

Unavailable-and-ticked rows are **red**, not merely dimmed, because they're
what's stopping the checkout. Under the list, a **Conflicts** panel names each
one, says who has it and until when, and offers the fix:

- **A free identical unit**, shown with its icon and its full name — not its
  barcode. `Avenger Turtle Base C-Stand Grip Arm Kit-2` next to the same icon
  as the one you can't have is what makes "this is the same thing" obvious at a
  glance; `94B47414` makes you go and look it up. One tap swaps it.
- **Remove from list** — when there's no spare, or you'd rather go without.

Conflicts appear however the item got there: adding a kit or package, or
ticking something yourself in the Everything view.

Under that sits the day grid, and by default a checkout only shows the rows
that actually clash — labelled with who has the gear and until when. Ten items
means ten rows of empty calendar to scroll past to reach the button, and the
row you were looking for was always the one in red. **All gear** brings the
rest back, and the heading says how many clashes there are either way.

Reserving starts on **All gear**, because there the grid isn't a report — it's
how you pick the dates.

Matching identical units is name-led, and deliberately so. In a real export the
model field contradicts itself: the same lens appears as `RF 15-35` and
`RF 15-35mm f/2.8 L`, and one row's model says 100mm while its own name says
24mm. Requiring models to match would refuse genuine spares; trusting models
alone would offer wrong ones. The name carries the full spec and is the field
people actually maintain.

A trailing number is treated as *which unit*, not *what it is*, so
`GAT C-Stand #4` and `GAT C-Stand #7` are the same thing — but only up to 30.
Above that it's part of the name, which is what stops `Sigma 18-35` reducing to
`Sigma 18` and matching an 18-50. Category and brand must agree too, so a free
Canon RF KOMODO is *not* offered as a spare for a Z-mount one. When nothing
qualifies it says so rather than suggesting something close enough.

The rules are pure functions — `baseName`, `interchangeable`, `swapCandidates`
in `public/search.js`, tested in `test/search.test.js`. The server still decides:
a conflict card is advice, and `src/policy.js` refuses the checkout regardless.

### Asking someone to add gear to their booking

Only the holder or an admin can change a loan or a hold. Everyone else gets
**Ask ⟨name⟩ to add gear** on that booking: pick the gear, say why, send. They
get an email and an **Waiting on you** panel on their Check Out tab with
Approve and Decline; an admin can decide it too, so a request doesn't sit
unanswered while someone's on a shoot.

Nothing is held while a request is pending. The item list is a snapshot of
what was asked for, not a claim — the gear goes through exactly the same rules
as a direct add at the moment it's approved, because days can pass and
availability moves. Approving gear that has since gone out fails with the
real reason and leaves the request open.

You can't approve your own request, which would just be taking the gear. An
admin can, because they could have added it directly anyway.

**Teammates.** A shoot is rarely one person, so the holder can name others on
a loan or a hold. A teammate adds gear to it without asking each time — and
that's all: check-in, extend, remove and release stay with whoever made the
booking, because contributing to it isn't the same as being able to end it.
Anyone can take *themselves* off. Add and remove as many as you like.

**Add gear** opens the same picker on a booking that isn't yours and sends a
*suggestion* — the holder confirms before anything is added. It works on holds
as well as loans. Nothing is reserved while it sits pending; the gear only
leaves the shelf once they've confirmed and, for a loan, once it's actually
checked out.

**Suggest trade** is the other half. Tick something on their loan, pick what
goes back from one of your own open checkouts, and send it. If they accept,
both items change hands in one transaction — otherwise the gear could end up
on both loans or neither. Both halves are re-read at that moment, so an offer
made against a loan that's since been checked in fails rather than half-
applying.

**Nobody takes gear off someone else's booking — admins included.** Adding to
a loan needs the holder's say-so and that's what requests are for; removing
from it would decide for them, and there's no request shape that makes that
reversible. The practical consequence is that gear left on the desk has to be
checked in by whoever took it out, not by whoever is standing there.

### Filtering by what's actually free

Both the checkout and reserve sheets have an **Available / Everything** toggle
above the gear list, defaulting to Available.

What "available" means depends on what you're doing, because the honest answer
differs:

- **Checking out** starts now, so anything already out is unavailable no matter
  when it's due back.
- **Reserving** is for a window, so gear that's out but back before your dates
  is fair game. Change the dates and the list re-evaluates.

Overdue gear is unavailable in both, because there's no reliable return date to
book around.

Anything you've already ticked stays visible even when it fails the filter, so
switching views can never quietly drop something from your cart. The toggle is
advisory — `src/policy.js` on the server is still what decides.

---

## 2c. The calendar

Gear scheduling is a resource problem, not a month-at-a-glance problem, so both
calendar views are horizontal timelines: one row per item, one column per day,
bars for bookings. That's the same shape as Outlook's scheduling assistant,
which is the model people already have for "when is this thing free".

### The Calendar tab

Everything out and everything booked, over 1, 2 or 4 weeks, or a whole month.
Bars are coloured by state — amber out on set, red overdue, blue reserved, grey
already returned.

**Month view** snaps to the 1st and runs the length of that month, so ◀ and ▶
step a month at a time rather than 30 days. The other spans page by their own
width. **Today** always comes back to now.

#### Three ways to slice it

The views answer different questions, and it's worth knowing which you want:

- **By checkout** — a row per order. *"What went out on Thursday, and what was
  on it?"* Rows are grouped Overdue → Out on set → Reserved → Returned, labelled
  with who has it and what for, and the bar says how many items are on it.
  Clicking one opens the whole order **on any day it covers**, past or future —
  useful when a case comes back and you need to know what should be in it.
- **By item** — a row per piece of gear. *"When is this camera free?"* This is
  the scheduling-assistant view. Three scopes: **Booked** (only gear with
  activity in the window, the default, since forty empty rows buries the
  information), **Out now** (everything currently checked out, whatever the
  window shows), and **Every item** for hunting something free.
- **List** — no bars at all. Every item, with each stretch it's booked *and*
  each stretch it's free, interleaved in date order. *"Read me the dates."*

#### The List view

Bars are good for seeing shape and useless for reading dates down a phone.
The list gives you both sides of the same question:

```
C80   LC-103 · Canon                              5 booked · 72 free
  ○ Sat Jul 4  → Sun Aug 2    Free — tap to reserve                    30d
  ▪ Mon Aug 3  → Fri Aug 7    Out with Priya Raman · Weekend series   5d
  ○ Sat Aug 8  → Fri Sep 18   Free — tap to reserve                    42d
```

Booked and free always add up to the period, which is the check that the
arithmetic is right. Tapping a free stretch opens a reservation with those
exact dates and that item already filled in. Tapping a booked one opens the
order.

**Booked + free / Booked only / Free only** narrows it. *Free only* is the
"what can I actually have next week?" view.

**Set the period** with the two date boxes. It defaults to everything loaded —
wider than the fortnight on screen — and you can point it anywhere, including
months out; the fetch widens to match, so nothing is reported free merely
because it wasn't loaded. Typing a range into the day search sets the period
too, so `aug 14 to aug 20` works as well as picking dates.

#### Filters and the two searches

**Category chips** — Camera, Lens, Lighting, Audio and so on — narrow both
views. In the checkout view an order survives the filter if any item on it
matches, so filtering to Lenses still shows you the whole order that lens went
out on.

The calendar has two search boxes, doing different jobs.

**Search gear** narrows the board to specific kit, using the same forgiving
matching as the Gear tab — `sigmma` finds the Sigma. It also opens a
**schedule list**: for each match, every date range it's spoken for, who has
it, what for, and how long. A camera out Mon-Wed and again Wed-Fri reports
five days, not six.

```
PYXIS 6K   LC-101 · Blackmagic                    9 of 77 days
  ▪ Sun Aug 2  → Thu Aug 6    Out with Alex Rivera · Anniversary tribute   5d
  ▪ Sat Aug 8  → Tue Aug 11   Held for Jo Feldman · Easter promo           4d
```

That answers "which days is the PYXIS free in September?" with dates you can
read down a phone, which the bars can't. Tapping a line opens that whole
booking. Anything with nothing on it says so plainly rather than showing an
empty row.

The list covers the **whole loaded period**, not just the fortnight on screen —
the header states the range — because "every day it's booked" shouldn't be
silently trimmed to what happens to be visible. Bookings running in from before
or on past the end are marked *(from earlier)* and *(continues)*, and their day
counts are clipped to the period so the totals stay honest.

**Jump to a day** takes dates however you'd say them out loud:

| You type | You get |
|---|---|
| `friday`, `next tuesday` | that day, resolved forward |
| `today`, `tomorrow` | the obvious |
| `aug 14`, `14 aug`, `8/14`, `2026-08-14` | that day |
| `aug 14 to aug 20`, `aug 14 - aug 20`, `aug 14..aug 20` | that range |
| `september`, `feb 2028` | the whole month |
| `this week`, `next week`, `this month` | the period |

Matching days are tinted blue — cool on purpose, so a highlight never reads as
a booking — and the window moves to centre them. A date with no year resolves to
the nearest one, so `jan 5` typed in August means the January coming up. The
parsing is a pure module, `public/dateparse.js`, with tests.

#### How busy is each day

The **How busy** filter adds a colour strip under the dates: green means plenty
free, red means it's going to be tight. Each cell shows how many are still
free, and the tooltip gives the full count.

**Cameras and Lighting are separate layers**, toggled independently, and that
separation is the point. There are 144 lighting items and 31 cameras, so a
single pooled strip would let the lights drown out the cameras — a day with
half the bodies already gone reads as 17% used once the lights are averaged in,
which is green. Scaled per category, that same day reads amber on the camera
layer and green on lighting, which is the truth.

Bands are uneven on purpose: the gap between a quarter and half the cameras
being out barely changes your plans; the gap between three quarters and all of
them decides whether a shoot happens. Gear in for repair counts as unavailable,
and an item on two overlapping holds counts once — it's one camera off the
shelf either way.

It's most useful on the month view, where a run of amber days is visible at a
glance. The maths is pure and tested (`dailyLoad`, `loadLevel` in
`public/calendar.js`).

#### Two things worth knowing

- **Bars clipped at the window edge are drawn square** rather than rounded, so a
  loan running past the edge doesn't read as ending there.
- **Overlapping bookings on one item stack into separate lanes.** A second lane
  appearing at all is the signal something is double-booked — normally
  impossible, but reachable through an admin override.
- **An overdue loan's bar runs to today**, not to the due date it blew past,
  because the gear is still out. The bar keeps its real due date for colouring,
  so it stays red. Without this the late gear drops off the board at exactly
  the moment you need to see it.

### The scheduling picker

Inside both the checkout and reserve sheets, once gear is selected, a timeline
appears showing that gear's existing bookings against the window you're asking
for. Rows that clash are tinted red, and the readout underneath names who has
the item and until when.

Tap a day to set the start, tap again to set the end. The date inputs and the
timeline stay in step whichever one you move.

When there is a conflict it computes the **next opening** — the earliest window
of the same length where every selected item is free — and offers it as a
one-tap button. If nothing opens up within 60 days it says so rather than
suggesting something useless.

The picker is advisory; `src/policy.js` on the server is what actually decides.
The two agree because they read the same bookings, but the server is the one
that can't be bypassed.

---

## 3. Reminders

The daily batch sends pickup notices, due-tomorrow, due-today, overdue notices,
and an admin digest. Every message is claimed in a `notifications` table before
sending, keyed on (kind, subject, day) — so running the batch twice sends
nothing twice. Trigger it as often as you like.

The app runs its own scheduler at `reminder_hour` (default 8am, set on the Admin
screen). **On Render's free tier this is not enough:** a free web service sleeps
after 15 minutes of inactivity, and a sleeping process runs no cron. Pick one:

**Option A — paid instance (simplest).** The `starter` plan in `render.yaml`
doesn't sleep. The built-in scheduler just works. Nothing else to configure.

**Option B — stay free, schedule externally.** Set `CRON_SECRET`, then add
`.github/workflows/reminders.yml` (included in this repo) and set the repository
secrets `CAGE_URL` and `CRON_SECRET`. GitHub Actions pings the endpoint every
morning, which also wakes the instance.

Either way, admins can fire the batch by hand from **Admin → Send today's
reminders now**.

---

## 4. The rules

Every rule below is a toggle on the Admin screen. All of them are enforced
**server-side** — turning off JavaScript or crafting a request by hand won't get
around them.

| Setting | Default | Effect when on |
|---|---|---|
| `enforce_availability` | on | Gear already out, or with an open repair ticket, cannot be checked out. Off downgrades these to warnings. |
| `enforce_reservations` | on | Gear held by someone else for overlapping dates cannot be checked out. Your own hold is treated as collecting it, and is marked fulfilled. |
| `block_overdue_borrowers` | on | Anyone holding overdue gear cannot take more until it's back. |
| `overdue_grace_days` | 0 | Days past due before the overdue block bites. |
| `default_loan_days` | 3 | Pre-fills the due date. |
| `escalate_after_days` | 3 | Overdue notices CC all admins once a loan is this late. |
| `send_receipts` | on | Email confirmation on checkout listing what they took. |
| `reminder_hour` | 8 | Local hour for the daily batch. Takes effect on restart. |

Admins can override a policy block from the checkout sheet. The override is
recorded in the `audit` table with the reason codes it bypassed. Genuine
mistakes — an empty cart, a due date before the checkout date — cannot be
overridden by anyone.

Two people scanning the same camera at the same moment is handled with a
Postgres advisory lock: the availability check and the insert happen inside one
transaction, so exactly one of them wins.

### Roles

**Members** can check gear out to themselves, check anything in (including a
teammate's, which is logged), reserve gear, log repairs, and build kits.

**Admins** additionally manage inventory, check out on behalf of others,
override blocks, block and unblock people, change settings, and print labels.

---

## 5. Local development

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL at minimum
npm run dev                 # http://localhost:3000
```

With no SMTP configured, mail is printed to the console — including the sign-in
link, so you can get in without a mail provider. The sign-in screen says so
rather than telling you to check an inbox that will never receive anything.

### Seeing the email properly

Console output is fine for grabbing a sign-in link, but useless for judging
whether an overdue notice actually reads well. [Mailpit](https://mailpit.axllent.org)
is a local SMTP server that catches everything and renders it in a browser:

```bash
brew install mailpit
mailpit --smtp 127.0.0.1:1025 --listen 127.0.0.1:8025
```

Then point `.env` at it:

```
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_USER=mailpit
SMTP_PASS=mailpit
MAIL_FROM=The Cage <cage@life.church>
```

Mail is now genuinely sent over SMTP — the same code path production uses — but
nothing leaves the machine. Read it at **http://localhost:8025**, including a
spam-score and mail-client compatibility check per message.

That last part matters: it means you can fire the whole reminder batch against
the demo data and inspect every template at once, without emailing anyone.

```bash
curl -X POST localhost:3000/api/tasks/reminders -H "x-cron-secret: $CRON_SECRET"
```

Reminders are claimed once per day, so if the batch says it sent nothing,
clear the claims and run it again:

```bash
psql -d cage -c "DELETE FROM notifications"
```

```bash
npm test                    # 94 tests (rules, timeline, search, dates), no database needed
```

The checkout rules live in `src/policy.js`, the timeline maths in
`public/calendar.js` and the search matching in `public/search.js` — all pure
functions unit tested in isolation. If you change how blocking behaves, change
it there and add a test; the API and the UI both read their behaviour from that
one module.

### Layout

```
src/policy.js      checkout rules — pure, tested, no database
src/api.js         REST endpoints, server-side enforcement
src/db.js          pool + schema (creates itself on boot)
src/auth.js        magic-link sign-in and sessions
src/mailer.js      SMTP transport and all email templates
src/reminders.js   the daily batch, with send-once claiming
src/server.js      express app, static hosting, in-process cron
public/app.js      the client — views, sheets, events
public/calendar.js timeline rendering, conflict and opening maths
public/search.js   fuzzy gear matching — pure, tested
public/dateparse.js the calendar day search — pure, tested
public/icons.js    placeholder gear icons, chosen by category then name
scripts/           importers (inventory, live state), demo seed, reminder runner
```

`npm run dev`, `npm run seed`, `npm run import` and `npm run reminders` all read
`.env` if it's there, via Node's built-in `--env-file-if-exists`. There is no
`dotenv` dependency.

There is no build step and no framework on the frontend. Editing
`public/app.js` and reloading is the whole loop.

---

## 6. Things deliberately left out

Worth knowing before you rely on this:

- **No barcode scanning on desktop Safari.** Scanning uses the browser's native
  `BarcodeDetector`, which Chrome on Android and Safari 17+ on iOS support.
  Elsewhere the code entry field is the fallback, and it always works.
- **No per-item quantities.** Each physical thing is its own row. Six C-stands
  are either one row called "C-stand (x6)" or six rows — your call, but the app
  won't track "4 of 6 out".
- **No push notifications.** Email only.
- **Placeholder accounts can't sign in.** If you migrate with
  `--allow-placeholders`, that gear is tracked correctly but the holder can't
  log in until an admin corrects the address.
- **Backups are Render's, not yours.** Their managed Postgres has automated
  backups on paid plans. Verify that before this becomes the only record of a
  six-figure camera fleet.

---

## 7. Asking Claude to do it

The Cage speaks [MCP](https://modelcontextprotocol.io), so Claude — in Claude
Code, Claude Desktop, or anything else that speaks the protocol — can read the
gear room and act in it:

> *"What cameras are free next Tuesday?"*
> *"Check out the C400 and a 24-70 until Friday for the baptism shoot."*
> *"What's overdue, and who has it?"*

### Setting it up

**1. Mint a token.** Sign-in is by emailed magic link, which is useless to a
machine. A token is the machine's credential:

```bash
npm run token -- --new "Claude MCP" --for you@life.church
```

It's shown once — only its SHA-256 hash is stored, so a copy of the database
isn't a set of working keys. Put it in your environment:

```bash
export CAGE_TOKEN=cage_...        # add to ~/.zshrc to persist
```

**2. Point Claude at it.**

*Claude Code* — nothing to do. `.mcp.json` is in the repo, so opening this
folder picks the server up. It reads `CAGE_TOKEN` from your environment, which
is why the token isn't in the file.

*Claude Desktop* — add this to `claude_desktop_config.json`
(**Settings → Developer → Edit Config**), using absolute paths:

```json
{
  "mcpServers": {
    "the-cage": {
      "command": "node",
      "args": ["/Users/you/the-cage/mcp/server.js"],
      "env": {
        "CAGE_URL": "http://localhost:3000",
        "CAGE_TOKEN": "cage_..."
      }
    }
  }
}
```

Desktop doesn't expand environment variables, so the token goes in the file —
which makes that file as sensitive as a password. Restart Desktop after saving.

**3. Have the app running** — `npm run dev`, or point `CAGE_URL` at a deployed
instance.

### What Claude can do

| Tool | For |
|---|---|
| `search_gear` / `list_gear` | Find kit by name, brand, code or category, with its current state |
| `check_availability` | Whether specific gear is free over a date range, and who has it if not |
| `check_out_gear` | Take gear out, starting today |
| `reserve_gear` | Hold gear for future dates |
| `check_in_gear` | Return a loan, whole or in part |
| `my_gear` / `whats_out` | What you're holding; what's out, overdue, or down |
| `whats_happening` | Everything booked over a date range |
| `report_problem` | Open a repair ticket, taking the item out of service |
| `whoami` | Which account this connection acts as |

### What it can't do, and why that matters

**The token is a person, not a robot.** It maps to one account, so every
checkout it makes shows up under their name in the calendar and the audit log.
There is no anonymous "the integration did it."

**`src/policy.js` still decides.** The MCP server is a thin client over the same
REST API the browser uses — it has no privileged path to the database. Gear
that's already out, in for repair, or held by someone else is refused exactly as
it would be in the UI, and the refusal is passed back to Claude in words it can
act on. A bug in the MCP layer cannot produce a state the API would have
rejected.

**Its reach is the account's reach.** A token on an admin account can change
settings and override blocks. If you don't want that, mint it against a member
account.

Revoke any time — it stops working immediately:

```bash
npm run token -- --list
npm run token -- --revoke 3
```

### Checking it works

```bash
CAGE_TOKEN=$CAGE_TOKEN node test/mcp-smoke.js
```

Drives the server over stdio with real JSON-RPC: handshake, tool discovery,
schema sanity, and a full checkout → verify → check-in round trip. It's separate
from `npm test` because it needs a database and a running app, where the main
suite deliberately needs neither.
