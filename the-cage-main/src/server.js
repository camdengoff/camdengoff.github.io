import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

import { migrate, settings, pool } from './db.js';
import { verifyMail, mailConfigured } from './mailer.js';
import { api } from './api.js';
import { runReminders, localToday } from './reminders.js';
import {
  attachPerson, requestLink, redeem, setSessionCookie,
  clearSessionCookie, signOut, sweep, AUTH_DISABLED
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const TZ = process.env.TZ_NAME || 'America/Chicago';

app.set('trust proxy', 1);
// A whole Cheqroom export pasted as CSV text easily clears the default
// 256kb — registered ahead of the general parser so it wins for this path;
// body-parser skips re-parsing a body it's already read.
app.use('/api/import', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '256kb' }));
app.use(attachPerson);

/* ------------------------------------------------------------------ security */
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

/* Crude in-memory throttle on link requests so nobody can be mail-bombed. */
const attempts = new Map();
function throttled(key, max = 5, windowMs = 15 * 60_000) {
  const now = Date.now();
  const hits = (attempts.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  attempts.set(key, hits);
  return hits.length > max;
}

/* ---------------------------------------------------------------------- auth */

app.post('/auth/request', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const key = (req.ip || 'unknown') + '|' + email;
  if (throttled(key)) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Wait 15 minutes.' });
  }
  try {
    await requestLink(email);
    // Same response whether or not the address exists — don't leak the roster.
    // But when there's no SMTP at all, saying "check your email" sends people
    // to an inbox that will never receive anything. That's a server
    // misconfiguration, not a secret, so say it plainly. The link itself stays
    // in the console — it is never returned here.
    res.json({
      ok: true,
      mail_configured: mailConfigured,
      message: mailConfigured
        ? 'Check your email for a sign-in link.'
        : 'No email was sent: this server has no SMTP configured. The sign-in link was printed to the server console.'
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { session } = await redeem(String(req.query.token || ''));
    setSessionCookie(res, session);
    res.redirect('/');
  } catch (err) {
    res
      .status(err.status || 500)
      .send(`<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="font-family:system-ui;background:#1b1f24;color:#e8e9ea;padding:40px;text-align:center">
          <h1 style="color:#f2c230;letter-spacing:.14em;text-transform:uppercase;font-size:18px">The Cage</h1>
          <p>${err.message}</p>
          <p><a href="/" style="color:#f2c230">Back to sign in</a></p>
        </body>`);
  }
});

app.post('/auth/signout', async (req, res) => {
  await signOut(req.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  if (!req.person) return res.status(401).json({ error: 'Not signed in.' });
  // The client boots on this: a 200 means skip the gate and render the app,
  // so with AUTH_MODE=none it opens straight onto Check Out.
  res.json({ person: req.person, auth_disabled: AUTH_DISABLED });
});

/* ----------------------------------------------------------------------- api */
app.use('/api', api);

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, today: localToday() });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

/* -------------------------------------------------------------------- client */
/* There's no build step and no hashed filenames, so a far-future max-age means
   a deploy leaves people on stale app.js/styles.css until the cache expires.
   maxAge:0 keeps the ETag, so repeat loads are cheap 304s and a deploy is
   picked up on the next refresh. */
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: 0, etag: true }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

/* ------------------------------------------------------------------ schedule */

async function scheduleReminders() {
  const cfg = await settings();
  const hour = Math.min(23, Math.max(0, Number(cfg.reminder_hour || 8)));

  cron.schedule(`0 ${hour} * * *`, async () => {
    console.log(`[cron] running reminders for ${localToday()}`);
    try { await runReminders(); } catch (err) { console.error('[cron] reminders failed:', err); }
  }, { timezone: TZ });

  cron.schedule('30 3 * * *', () => sweep().catch(e => console.error('sweep failed', e.message)),
    { timezone: TZ });

  console.log(`Reminders scheduled for ${String(hour).padStart(2, '0')}:00 ${TZ}.`);
  if (!process.env.CRON_SECRET) {
    console.warn('CRON_SECRET is unset — the external /api/tasks/reminders trigger is disabled. ' +
      'On a free instance that spins down, set it and drive reminders from an outside scheduler.');
  }
}

/* ---------------------------------------------------------------------- boot */

async function start() {
  await migrate();

  if (AUTH_DISABLED) {
    console.warn(
      '\n' +
      '  ****************************************************************\n' +
      '  *  AUTH_MODE=none — THERE IS NO SIGN-IN.                       *\n' +
      '  *                                                              *\n' +
      '  *  Every request is served as an admin. Anyone who can reach   *\n' +
      '  *  this port has full access, including deleting gear and      *\n' +
      '  *  changing settings.                                          *\n' +
      '  *                                                              *\n' +
      '  *  Fine on localhost. Do not put this on a public URL.         *\n' +
      '  *  Unset AUTH_MODE to put the magic-link sign-in back.         *\n' +
      '  ****************************************************************\n'
    );
  }

  await verifyMail();
  await scheduleReminders();
  const server = app.listen(PORT, () => console.log(`The Cage is listening on :${PORT}`));

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`${signal} received, closing up.`);
      server.close(() => pool.end().then(() => process.exit(0)));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
