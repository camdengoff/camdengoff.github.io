# The Cage — getting set up

Gear checkout, reservations and repair tracking for the Life.Church filmmaking
team. A working prototype, built as a possible replacement for Cheqroom: same
core job, self-hosted, no per-seat licence.

This guide gets you from nothing to a running copy with demo gear in it. It
should take about five minutes, most of it waiting on downloads.

**You'll need:** a Mac, and access to the repo. Everything else installs itself.

---

## 1. Get it running

```bash
gh repo clone jordanwest-LC/the-cage && cd the-cage && ./start.sh
```

No `gh`? Clone over HTTPS instead:

```bash
git clone https://github.com/jordanwest-LC/the-cage.git && cd the-cage && ./start.sh
```

`start.sh` checks for Node and PostgreSQL, offers to install whatever's missing
via Homebrew, creates a local database, fills it with demo inventory, starts the
app and opens your browser already signed in.

It asks before installing anything, and it's safe to re-run — the second time is
much faster. `Ctrl-C` stops it.

Everything runs on your own machine. Nothing is sent anywhere, no email goes
out, and no real gear data is involved.

---

## 2. Two things that look broken but aren't

**Sign-in asks for an email and never sends one.** The app normally emails a
magic link. There's no mail provider locally, so the link prints to your
terminal instead and `start.sh` opens it for you. The sign-in screen says so
too. If you need another link later:

```bash
npm run invite -- you@life.church
```

**The gear is real; the activity isn't.** The inventory is the actual 459 items
exported from Cheqroom — names, categories, brands, models and asset codes. It
carries no people, no serial numbers and no prices. Every checkout, hold and
repair ticket is made up, against four invented crew, dated around today so the
calendar looks alive. One loan is deliberately overdue and one is due today, so
you can see those states. Nobody named in it has actually borrowed anything.

You'll be an admin, so you'll see Admin, Add Gear and QR Labels.

---

## 3. Worth a look

- **Check Out** — the landing tab, deliberately sparse. Check gear out, reserve
  it, or scan a code. The gear picker has an **Available / Everything** toggle,
  and what counts as "available" differs by intent: a checkout starts now, a
  reservation only cares about its own dates.
- **Gear** — the inventory. Colour-coded by state, filterable by category, and
  the search is forgiving on purpose. Try `sigmma 1835` or `canon 24-70`.
- **Calendar** — **By checkout** is a row per order; click any bar to see
  everything on it, on any day it covers. **By item** answers "when is this
  camera free?". There's a month view, and two search boxes: one for gear (which
  also lists every day that gear is spoken for) and one that takes dates however
  you'd say them — `friday`, `aug 14`, `next week`.
- **Bookings / Repairs / Kits** — holds, repair tickets, saved gear lists.

Feedback on what's missing, wrong or annoying is the entire point.

---

## 4. If you're going to change something

```bash
npm test        # 107 tests, no database needed, runs in under a second
```

Three things worth knowing before you edit:

1. **`src/policy.js` decides what's allowed. The client only advises.** The UI
   has its own availability filters, and they agree with the server because they
   read the same bookings — but the server is what can't be bypassed. Never
   enforce a rule only in `public/`.
2. **There's no build step and no framework.** Edit a file in `public/` and
   reload. Don't add a bundler.
3. **Keep new logic pure where you can.** The tested modules — `policy.js`,
   `calendar.js`, `search.js`, `dateparse.js` — need no database, which is why
   the suite is fast. Add tests there rather than reaching for a test database.

Work on a branch and open a PR, so two people pointing Claude at `main` don't
collide:

```bash
git pull --rebase origin main && git checkout -b your-change
```

CI runs the tests on every PR, and also checks the single-file demo still
builds and that no personal data reached `public/demo-data.js`.

---

## 5. Where the rest is written down

- **`CLAUDE.md`** — architecture, conventions, and the gotchas already found the
  hard way. Claude Code reads this automatically when you open the folder.
- **`README.md`** — what the app does, every rule, deployment, importing real
  inventory from Cheqroom.
- **`SETUP.md`** — the same as section 1, in more detail, including what to do
  when something goes wrong.

## Troubleshooting

| Problem | Fix |
|---|---|
| `permission denied: ./start.sh` | `chmod +x start.sh` |
| Postgres won't start | `brew services restart postgresql@16` |
| Port 3000 in use | Quit other dev servers and re-run |
| Sign-in link expired | `npm run invite -- you@life.church` |
| Anything else | The log is `cage-local.log` in the project folder |
