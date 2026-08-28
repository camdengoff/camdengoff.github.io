import crypto from 'node:crypto';
import { q, audit } from './db.js';
import { send, templates } from './mailer.js';

const TOKEN_MINUTES = 15;
const SESSION_DAYS = 60;
const COOKIE = 'cage_session';

/**
 * AUTH_MODE=none turns sign-in off entirely: every request arrives as a
 * built-in admin and the app opens straight onto the Check Out tab.
 *
 * This exists so the sign-in can be replaced without the magic-link flow
 * getting in the way. Everything below still works and is left in place as a
 * reference for what a replacement has to provide: a `req.person` with
 * `{ id, email, name, role, blocked }`, and the `requireAuth` / `requireAdmin`
 * guards the API already leans on.
 *
 * There is no authentication of any kind when this is on. Anyone who can reach
 * the port is an admin.
 */
export const AUTH_DISABLED = process.env.AUTH_MODE === 'none';

export const DEMO_EMAIL = 'demo@thecage.local';
export const DEMO_NAME = 'Demo User';

const newToken = () => crypto.randomBytes(32).toString('base64url');

/** Restrict sign-in to your own domain(s). Empty means anyone with an invite row. */
const ALLOWED = (process.env.ALLOWED_EMAIL_DOMAINS || '')
  .split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);

export function emailAllowed(email) {
  const clean = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) return false;
  if (!ALLOWED.length) return true;
  return ALLOWED.some(d => clean.endsWith('@' + d));
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map(c => c.trim().split('=')).filter(p => p.length === 2)
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

/* ------------------------------------------------------------------ requests */

export async function requestLink(rawEmail) {
  const email = String(rawEmail).trim().toLowerCase();
  if (!emailAllowed(email)) {
    const err = new Error(ALLOWED.length
      ? `Sign-in is limited to ${ALLOWED.map(d => '@' + d).join(' or ')} addresses.`
      : 'That does not look like an email address.');
    err.status = 400;
    throw err;
  }

  // First person in gets admin so the install isn't locked out of itself.
  const { rows: [{ n }] } = await q('SELECT count(*)::int AS n FROM people');
  const role = n === 0 ? 'admin' : 'member';
  await q(`INSERT INTO people (email, role) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`, [email, role]);

  const token = newToken();
  await q(
    `INSERT INTO login_tokens (token, email, expires_at) VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [token, email, String(TOKEN_MINUTES)]
  );
  await send({ to: email, ...templates.signIn({ token }) });
  return { sent: true };
}

export async function redeem(token) {
  const { rows } = await q(
    `UPDATE login_tokens SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING email`, [token]
  );
  if (!rows.length) {
    const err = new Error('That link has expired or already been used. Request a new one.');
    err.status = 401;
    throw err;
  }
  const email = rows[0].email;
  // Seed a display name from the address so mail doesn't read "Hi there".
  // Anyone can correct it later from their profile.
  const guess = email.split('@')[0].split(/[._-]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const { rows: [person] } = await q(
    `INSERT INTO people (email, name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE
       SET last_seen_at = now(),
           name = CASE WHEN people.name = '' THEN EXCLUDED.name ELSE people.name END
     RETURNING id, email, name, role`, [email, guess]
  );

  const session = newToken();
  await q(
    `INSERT INTO sessions (token, person_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [session, person.id, String(SESSION_DAYS)]
  );
  await audit(person.id, 'sign_in', { email });
  return { session, person };
}

export function setSessionCookie(res, token) {
  const parts = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* --------------------------------------------------------------- middleware */

/* --------------------------------------------------------------- api tokens */

export const TOKEN_PREFIX = 'cage_';

/** Only the hash is ever stored, so the table isn't a set of working keys. */
export const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

export const newApiToken = () => TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');

/**
 * Resolve a bearer token to a person.
 *
 * Looks up by hash, so a stolen database gives an attacker hashes rather than
 * usable tokens. Touches last_used_at on a hit — worth knowing which
 * integrations are actually live before revoking one.
 */
export async function personForToken(token) {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const { rows } = await q(
    `UPDATE api_tokens SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL
     RETURNING person_id`,
    [hashToken(token)]
  );
  if (!rows.length) return null;

  const { rows: people } = await q(
    `SELECT id, email, name, role, blocked, blocked_reason FROM people WHERE id = $1`,
    [rows[0].person_id]
  );
  return people[0] || null;
}

/** Attaches req.person when a valid session cookie or bearer token is present. */
export async function attachPerson(req, _res, next) {
  try {
    // No sign-in: everyone is the demo admin. The row is real, because
    // checkouts and audit entries have a foreign key onto people.
    if (AUTH_DISABLED) {
      const { rows } = await q(
        `SELECT id, email, name, role, blocked, blocked_reason
         FROM people WHERE email = $1`, [DEMO_EMAIL]
      );
      if (rows.length) req.person = rows[0];
      return next();
    }

    // A bearer token identifies a machine client — the MCP server, a script.
    // Checked before the cookie so an explicit credential always wins.
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    if (bearer) {
      const person = await personForToken(bearer.trim());
      if (person) {
        req.person = person;
        req.viaToken = true;
      }
      return next();
    }

    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const { rows } = await q(
        `SELECT p.id, p.email, p.name, p.role, p.blocked, p.blocked_reason
         FROM sessions s JOIN people p ON p.id = s.person_id
         WHERE s.token = $1 AND s.expires_at > now()`, [token]
      );
      if (rows.length) {
        req.person = rows[0];
        req.sessionToken = token;
      }
    }
  } catch (err) {
    console.error('Session lookup failed:', err.message);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.person) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.person) return res.status(401).json({ error: 'Sign in to continue.' });
  if (req.person.role !== 'admin') {
    return res.status(403).json({ error: 'Only cage admins can do that.' });
  }
  next();
}

export async function signOut(token) {
  if (token) await q('DELETE FROM sessions WHERE token = $1', [token]);
}

/** Housekeeping — expired sessions and spent links. */
export async function sweep() {
  await q('DELETE FROM sessions WHERE expires_at < now()');
  await q(`DELETE FROM login_tokens WHERE expires_at < now() - interval '1 day'`);
}
