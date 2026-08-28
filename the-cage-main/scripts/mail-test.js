#!/usr/bin/env node
/**
 * Prove the mail config works before anyone depends on it.
 *
 *   npm run mail:test -- you@example.com
 *
 * Sign-in is by magic link, so if mail doesn't send, nobody can get in and the
 * app looks broken rather than misconfigured. This checks the two things that
 * actually go wrong — the credentials, and whether the provider will accept
 * your MAIL_FROM — and sends a real message so you can confirm it arrives and
 * isn't sitting in spam.
 *
 * Needs no database.
 */
import { send, templates, verifyMail } from '../src/mailer.js';

const to = process.argv.slice(2).find(a => !a.startsWith('-'));

if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
  console.error(`
Usage: npm run mail:test -- you@example.com

Send a test message to an address you can actually check.
`);
  process.exit(1);
}

const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'];
const missing = required.filter(k => !process.env[k]);

console.log('Config:');
console.log(`  SMTP_HOST  ${process.env.SMTP_HOST || '(unset)'}`);
console.log(`  SMTP_PORT  ${process.env.SMTP_PORT || '587 (default)'}`);
console.log(`  SMTP_USER  ${process.env.SMTP_USER || '(unset)'}`);
console.log(`  SMTP_PASS  ${process.env.SMTP_PASS ? '(set, ' + process.env.SMTP_PASS.length + ' chars)' : '(unset)'}`);
console.log(`  MAIL_FROM  ${process.env.MAIL_FROM || '(unset)'}`);
console.log(`  APP_URL    ${process.env.APP_URL || 'http://localhost:3000 (default)'}`);
console.log('');

if (missing.length) {
  console.error(
    `Missing: ${missing.join(', ')}\n\n` +
    `Without these the app runs but logs mail to the console instead of sending\n` +
    `it, which means magic-link sign-in silently doesn't work. Put them in .env\n` +
    `(see .env.example) and re-run.\n`
  );
  process.exit(1);
}

if (!(await verifyMail())) {
  console.error(`
The SMTP server rejected the connection or the credentials.

Common causes:
  - Using your account password instead of the provider's SMTP key.
    Brevo, Resend and Postmark all issue a separate key.
  - Wrong SMTP_USER. On Brevo it is not your email address — it's the SMTP
    login shown on the SMTP & API page, like 8a1b2c001@smtp-brevo.com.
  - Port blocked. Try 465 (implicit TLS) instead of 587.
`);
  process.exit(1);
}

const result = await send({
  to,
  subject: 'The Cage: mail is working',
  body: `<p>If you're reading this, sign-in links will reach people.</p>
    <p>Sent by <code>npm run mail:test</code>.</p>
    <p style="color:#888;font-size:13px">Check whether this landed in spam. Overdue
    notices are the whole point of the app, and they're useless in a junk folder.</p>`
});

if (!result.queued) {
  console.error(`\nThe server accepted the connection but refused the message.\n`);
  if (/from|sender|domain|unverified|not allowed/i.test(result.error || '')) {
    console.error(
      `That error points at MAIL_FROM. Providers only send from an address or\n` +
      `domain you've verified with them. Verify "${process.env.MAIL_FROM}" in the\n` +
      `provider's dashboard, or change MAIL_FROM to one you already verified.\n`
    );
  }
  console.error(`Provider said: ${result.error}\n`);
  process.exit(1);
}

console.log(`
Sent to ${to}.

Now go and confirm it actually arrived — a provider accepting a message is not
the same as an inbox showing it. If it landed in spam, verify your sending
domain (SPF/DKIM) with the provider before people start relying on overdue
notices.
`);
process.exit(0);
