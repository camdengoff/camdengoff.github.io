#!/usr/bin/env node
/**
 * Long-lived API tokens, for things that can't click a link in an inbox.
 *
 *   npm run token -- --new "Claude MCP" --for you@life.church
 *   npm run token -- --list
 *   npm run token -- --revoke 3
 *
 * Sign-in is by emailed magic link, which is right for people and useless for
 * a machine. A token is the machine's credential: it identifies one person, so
 * everything it does is attributed and constrained by that person's role, and
 * every checkout it makes shows up under their name rather than as an
 * anonymous integration.
 *
 * The token is shown ONCE. Only its SHA-256 hash is stored, so a copy of the
 * database is not a set of working credentials — and a lost token is replaced,
 * not recovered.
 */
import { q, pool, migrate } from '../src/db.js';
import { newApiToken, hashToken } from '../src/auth.js';

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? '');
};

const BOLD = '\x1b[1m', DIM = '\x1b[2m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

async function list() {
  const { rows } = await q(`
    SELECT t.id, t.name, t.created_at::date AS created, t.last_used_at,
           t.revoked_at, p.email, p.role
    FROM api_tokens t JOIN people p ON p.id = t.person_id
    ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`);

  if (!rows.length) {
    console.log('\nNo tokens yet. Create one:\n  npm run token -- --new "Claude MCP"\n');
    return;
  }
  console.log('');
  for (const r of rows) {
    const state = r.revoked_at ? `${DIM}revoked${RESET}`
      : r.last_used_at ? `last used ${new Date(r.last_used_at).toISOString().slice(0, 16).replace('T', ' ')}`
      : `${DIM}never used${RESET}`;
    console.log(`  ${String(r.id).padStart(3)}  ${(r.name || '(unnamed)').padEnd(22)} ${r.email.padEnd(28)} ${state}`);
  }
  console.log(`\n  ${DIM}Revoke with: npm run token -- --revoke <id>${RESET}\n`);
}

async function create() {
  const name = flag('--new') || 'unnamed';
  const email = (flag('--for') || process.env.ADMIN_EMAILS || '').split(',')[0].trim().toLowerCase();

  if (!email) {
    console.error(`
No person to attach the token to.

  npm run token -- --new "Claude MCP" --for you@life.church

Everything the token does is recorded against that person, so use a real
account rather than a shared one.
`);
    process.exit(1);
  }

  const { rows } = await q('SELECT id, email, role FROM people WHERE email = $1', [email]);
  if (!rows.length) {
    console.error(`\nNo account for ${email}. They need to have signed in at least once, or be in ADMIN_EMAILS.\n`);
    process.exit(1);
  }
  const person = rows[0];

  const token = newApiToken();
  const { rows: [row] } = await q(
    `INSERT INTO api_tokens (token_hash, person_id, name) VALUES ($1, $2, $3) RETURNING id`,
    [hashToken(token), person.id, name]
  );

  console.log(`
${BOLD}Token #${row.id} — "${name}"${RESET}
Acts as ${person.email} (${person.role}).

  ${GREEN}${token}${RESET}

${BOLD}This is the only time it will be shown.${RESET} Only its hash is stored, so it
can't be recovered — if it's lost, revoke it and make another.

Treat it like a password: it can check gear out, and if that account is an
admin it can change settings and override blocks. Put it in an environment
variable, never in a file you commit.

  export CAGE_TOKEN=${token}

Revoke it with:  npm run token -- --revoke ${row.id}
`);
}

async function revoke() {
  const id = Number(flag('--revoke'));
  if (!Number.isInteger(id)) {
    console.error('\nWhich token? Use --list to see the ids.\n');
    process.exit(1);
  }
  const { rows } = await q(
    `UPDATE api_tokens SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL RETURNING name`, [id]
  );
  console.log(rows.length
    ? `\nRevoked #${id} ("${rows[0].name || 'unnamed'}"). It stops working immediately.\n`
    : `\nNo live token with id ${id}.\n`);
}

async function main() {
  await migrate();
  if (args.includes('--list')) await list();
  else if (args.includes('--revoke')) await revoke();
  else if (args.includes('--new')) await create();
  else {
    console.log(`
Usage:
  npm run token -- --new "Claude MCP" --for you@life.church
  npm run token -- --list
  npm run token -- --revoke <id>
`);
  }
  await pool.end();
}

main().catch(async err => {
  console.error('Failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
