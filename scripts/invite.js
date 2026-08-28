#!/usr/bin/env node
/**
 * Mint a sign-in link for someone, and print it.
 *
 *   npm run invite -- someone@life.church
 *
 * Sign-in is by emailed link, which is a problem whenever mail isn't set up:
 * a demo over a tunnel, a fresh install before SMTP is configured, or someone
 * whose link went to spam. This creates the same link the email would have
 * contained so you can send it however you like.
 *
 * The link is single use and expires in 15 minutes, same as any other. It is
 * exactly as sensitive as a password until it's used or expires — send it
 * directly to the person, not to a channel.
 *
 * Respects ALLOWED_EMAIL_DOMAINS, so this can't quietly let in an address the
 * app itself would refuse.
 */
import crypto from 'node:crypto';
import { q, pool } from '../src/db.js';
import { emailAllowed } from '../src/auth.js';

const TOKEN_MINUTES = 15;

const email = process.argv.slice(2).find(a => !a.startsWith('-'))?.trim().toLowerCase();
const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

async function main() {
  if (!email) {
    console.error(`
Usage: npm run invite -- someone@life.church

Prints a sign-in link for that address.
`);
    process.exit(1);
  }

  if (!emailAllowed(email)) {
    const allowed = process.env.ALLOWED_EMAIL_DOMAINS || '';
    console.error(
      `\n${email} isn't allowed to sign in.\n` +
      (allowed
        ? `ALLOWED_EMAIL_DOMAINS is set to "${allowed}".\n`
        : `That doesn't look like an email address.\n`)
    );
    process.exit(1);
  }

  // Same as a normal sign-in request: create the person if they're new, so the
  // link works for someone who has never been here before.
  const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM people');
  const role = n === 0 ? 'admin' : 'member';
  await q(
    `INSERT INTO people (email, role) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
    [email, role]
  );

  const token = crypto.randomBytes(32).toString('base64url');
  await q(
    `INSERT INTO login_tokens (token, email, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [token, email, String(TOKEN_MINUTES)]
  );

  const { rows: [person] } = await q(
    'SELECT role, last_seen_at FROM people WHERE email = $1', [email]
  );

  console.log(`
Sign-in link for ${email} (${person.role}${person.last_seen_at ? '' : ', first time'}):

  ${base}/auth/callback?token=${token}

Works once, expires in ${TOKEN_MINUTES} minutes. Treat it like a password —
send it to that person directly, not to a channel.
`);

  if (base.includes('localhost')) {
    console.log(`Note: APP_URL is ${base}, so this link only works on this machine.
Set APP_URL to the address they'll actually use before generating one for
someone else.
`);
  }

  await pool.end();
}

main().catch(async err => {
  console.error('Failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
