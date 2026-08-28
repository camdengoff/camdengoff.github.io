# Running The Cage on your Mac

This is a gear checkout system for the filmmaking team — a possible replacement
for Cheqroom. It runs entirely on your own machine. **Nothing is sent anywhere,
no email goes out, and no real gear data is involved** — it starts with made-up
demo inventory so there's something to look at.

Takes about five minutes, most of it waiting on downloads.

---

## The quick way

1. Unzip the folder somewhere you'll find it again, like your Desktop.
2. Open **Terminal** (⌘-Space, type "Terminal", Enter).
3. Type `cd ` — with a space after it — then **drag the unzipped folder onto the
   Terminal window** and press Enter.
4. Paste this and press Enter:

   ```bash
   ./start.sh
   ```

It'll tell you what it's doing and ask before installing anything. When it's
done, your browser opens and you're signed in.

**To stop it:** click the Terminal window and press `Ctrl-C`.
**To start it again later:** repeat steps 2–4. It's much faster the second time.

---

## What it installs

Only if you don't already have them, and it asks first:

- **Node** — runs the app.
- **PostgreSQL** — the database the app stores everything in.

Both come from [Homebrew](https://brew.sh), the standard Mac package manager. If
you don't have Homebrew, the script will point you at it and stop.

To remove everything afterwards: `brew uninstall node postgresql@16`, then
delete the folder.

---

## Things that will look odd, but are meant to

**Sign-in asks for an email but never sends one.** The app normally emails you a
link to sign in. Locally there's no email provider, so the link prints into the
Terminal instead — the script grabs it and opens it for you. The sign-in screen
says so too.

**The gear isn't real.** 24 made-up items, four made-up crew members, and some
invented checkouts and holds, dated around today so the calendar looks alive.
One loan is deliberately overdue and one is due today, so you can see what those
look like.

**You're an admin.** So you'll see Admin, Add Gear and QR Labels, which most
people wouldn't.

---

## Having a look around

- **Check Out** — the home screen. Check gear out, reserve it for later, or scan
  a code. The gear picker has an **Available / Everything** toggle.
- **Gear** — the full inventory. Colour-coded by state, filterable by category,
  and the search is forgiving: try `sigmma 1835` or `canon 24-70`.
- **Calendar** — **By checkout** shows a row per order; click any bar to see
  everything on it. **By item** shows when each piece is free. There's a month
  view, category filters, and a box that takes dates however you'd say them:
  `friday`, `aug 14`, `next week`.
- **Bookings / Repairs / Kits** — holds, repair tickets, and saved gear lists.

Feedback on what's missing or wrong is the whole point — it's a prototype.

---

## If something goes wrong

**"command not found: ./start.sh"** — you're not in the right folder. Redo step 3.

**"permission denied"** — run this once, then try again:

```bash
chmod +x start.sh
```

**"Postgres wouldn't start"** — try:

```bash
brew services restart postgresql@16
```

**Port 3000 is in use** — the script stops whatever's on it, but if that fails,
quit other dev servers and re-run.

**Anything else** — the log is `cage-local.log` in the same folder. Send it over
and it'll be obvious what happened.

---

## Not on a Mac?

The script is macOS-only, but the app isn't. You'd need Node 20.12+ and
PostgreSQL 16, then:

```bash
npm install
createdb cage
echo "DATABASE_URL=postgresql://localhost:5432/cage" > .env
echo "APP_URL=http://localhost:3000" >> .env
echo "ADMIN_EMAILS=you@example.com" >> .env
npm run seed
npm run dev
```

Then open http://localhost:3000 and use the sign-in link printed in the terminal.
