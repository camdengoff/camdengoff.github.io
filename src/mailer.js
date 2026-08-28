import nodemailer from 'nodemailer';
import { bookingLabel } from './policy.js';

/**
 * One SMTP code path, any provider. Resend, Postmark, SendGrid, Mailgun and
 * Microsoft 365 all speak SMTP, so switching providers is an env var change
 * rather than a rewrite.
 */
const HAS_SMTP = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);

/** False when mail is only being logged, so callers can say so instead of
    claiming an email is on its way that will never arrive. */
export const mailConfigured = HAS_SMTP;

const transport = HAS_SMTP
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

const FROM = process.env.MAIL_FROM || 'The Cage <cage@example.com>';
const BASE = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

export async function verifyMail() {
  if (!transport) {
    console.warn('SMTP is not configured — mail will be logged to the console instead of sent.');
    return false;
  }
  try {
    await transport.verify();
    console.log('SMTP ready.');
    return true;
  } catch (err) {
    console.error('SMTP verification failed:', err.message);
    return false;
  }
}

export async function send({ to, subject, body, cc }) {
  const html = wrap(subject, body);
  if (!transport) {
    console.log(`\n--- mail (not sent, no SMTP) ---\nto: ${to}${cc ? `\ncc: ${cc}` : ''}\nsubject: ${subject}\n${stripTags(body)}\n---\n`);
    return { queued: false };
  }
  try {
    await transport.sendMail({ from: FROM, to, cc, subject, html, text: stripTags(body) });
    return { queued: true };
  } catch (err) {
    console.error(`Mail to ${to} failed:`, err.message);
    return { queued: false, error: err.message };
  }
}

/**
 * HTML → plaintext for the text/plain alternative. Link URLs are kept inline,
 * because a plaintext reader that only sees the anchor text gets a mail with a
 * button it cannot press.
 */
const stripTags = s => s
  .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) =>
    `${label.replace(/<[^>]+>/g, '').trim()}: ${href}`)
  .replace(/<\/(p|div|li|h\d)>/gi, '\n')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<li\b[^>]*>/gi, '  - ')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/* Inline styles only — every mail client strips <style> blocks. Dark-on-light
   because most inboxes are, and the cage UI's dark theme reads as broken here. */
function wrap(title, body) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f2f2f0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1f24">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:4px;overflow:hidden">
    <div style="background:#1b1f24;padding:14px 20px">
      <span style="color:#f2c230;font-size:15px;font-weight:700;letter-spacing:.16em;text-transform:uppercase">The Cage</span>
    </div>
    <div style="padding:20px;font-size:15px;line-height:1.5">${body}</div>
    <div style="padding:14px 20px;border-top:1px solid #eee;font-size:12px;color:#888">
      Life.Church Filmmaking gear room · <a href="${BASE}" style="color:#888">open the cage</a>
    </div>
  </div></body></html>`;
}

const itemList = items => `<ul style="margin:10px 0;padding-left:20px">${
  items.map(i => `<li style="margin-bottom:3px">${escape(i.name)} <span style="color:#888;font-family:monospace;font-size:13px">${escape(i.code)}</span></li>`).join('')
}</ul>`;

const button = (label, href) =>
  `<p style="margin:22px 0"><a href="${href}" style="background:#f2c230;color:#1b1f24;padding:12px 20px;border-radius:3px;text-decoration:none;font-weight:600;display:inline-block">${label}</a></p>`;

const escape = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const pretty = d => new Date(String(d).slice(0,10) + 'T12:00:00Z')
  .toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', timeZone:'UTC' });

/* ---------------------------------------------------------------- templates */

export const templates = {
  gearRequest: ({ holder, requester, items, booking, note, tradeFor }) => (tradeFor
    /* A trade and an add are different asks, and the subject line is the only
       part most people read. Saying "wants to add gear" about a trade would
       hide the half where they lose something. */
    ? {
        subject: `${requester.name || requester.email} suggested a trade`,
        body: `<p>Hi ${escape(holder.name || 'there')} —
          ${escape(requester.name || requester.email)} would like to trade on your ${booking.kind}${
            bookingLabel(booking) ? ` for ${escape(bookingLabel(booking))}` : ''}.</p>
          <p><strong>They'd take:</strong></p>
          ${itemList(items)}
          <p><strong>You'd get instead:</strong></p>
          ${itemList(tradeFor)}
          ${note ? `<p><em>“${escape(note)}”</em></p>` : ''}
          <p>Nothing has moved. Both halves swap over only if you accept, and
          the gear is re-checked at that moment.</p>
          ${button('Accept or decline', BASE)}`
      }
    : {
        subject: `${requester.name || requester.email} wants to add gear to your ${booking.kind}`,
        body: `<p>Hi ${escape(holder.name || 'there')} —
          ${escape(requester.name || requester.email)} is asking to add
          ${items.length} item${items.length === 1 ? '' : 's'} to your ${booking.kind}${
            bookingLabel(booking) ? ` for ${escape(bookingLabel(booking))}` : ''}:</p>
          ${itemList(items)}
          ${note ? `<p><em>“${escape(note)}”</em></p>` : ''}
          <p>Nothing has changed yet — the gear is only added if you approve, and
          it's re-checked against the rules at that moment.</p>
          ${button('Approve or decline', BASE)}`
      }),

  gearRequestDecided: ({ requester, holder, items, approved, reason, kind }) => ({
    subject: approved
      ? `${holder.name || holder.email} accepted your ${kind === 'swap' ? 'trade' : 'request'}`
      : `${holder.name || holder.email} declined your ${kind === 'swap' ? 'trade' : 'request'}`,
    body: `<p>Hi ${escape(requester.name || 'there')} — your request for
      ${items.length} item${items.length === 1 ? '' : 's'} was
      ${approved ? 'approved' : 'declined'}.</p>
      ${itemList(items)}
      ${reason ? `<p><em>“${escape(reason)}”</em></p>` : ''}
      ${approved
        ? `<p>It's on their booking now.</p>`
        : `<p>Nothing changed. Ask an admin if you need it another way.</p>`}
      ${button('Open the cage', BASE)}`
  }),

  signIn: ({ token }) => ({
    subject: 'Your sign-in link for The Cage',
    body: `<p>Tap below to sign in. The link works once and expires in 15 minutes.</p>
      ${button('Sign in', `${BASE}/auth/callback?token=${token}`)}
      <p style="color:#888;font-size:13px">If you didn't ask for this, ignore it — nobody can get in without the link.</p>`
  }),

  receipt: ({ person, items, due, shoot, project }) => ({
    subject: `Checked out: ${items.length} item${items.length === 1 ? '' : 's'}, due ${pretty(due)}`,
    body: `<p>Hi ${escape(person.name || 'there')} — you've got:</p>
      ${itemList(items)}
      <p><strong>Due back ${pretty(due)}</strong>${
        [shoot, project].filter(Boolean).map(t => ` · ${escape(t)}`).join('')}</p>
      <p>You'll get a nudge the day before. Check gear in from the app when it's back on the shelf.</p>
      ${button('Open the cage', BASE)}`
  }),

  pickupToday: ({ person, items, reservation }) => ({
    subject: `Your hold is ready to pick up today`,
    body: `<p>Hi ${escape(person.name || 'there')} — the gear you reserved is ready:</p>
      ${itemList(items)}
      <p>Held through ${pretty(reservation.end_on)}${
        [reservation.shoot, reservation.project].filter(Boolean).map(t => ` · ${escape(t)}`).join('')}.</p>
      <p>Scan it out when you grab it so the board stays accurate.</p>
      ${button('Open the cage', BASE)}`
  }),

  dueTomorrow: ({ person, items, checkout }) => ({
    subject: `Due back tomorrow: ${items.length} item${items.length === 1 ? '' : 's'}`,
    body: `<p>Hi ${escape(person.name || 'there')} — a heads up that this is due back tomorrow, ${pretty(checkout.due_on)}:</p>
      ${itemList(items)}
      <p>If you need it longer, extend it in the app so nobody books it out from under you.</p>
      ${button('Extend or check in', BASE)}`
  }),

  dueToday: ({ person, items, checkout }) => ({
    subject: `Due back today: ${items.length} item${items.length === 1 ? '' : 's'}`,
    body: `<p>Hi ${escape(person.name || 'there')} — due back today:</p>
      ${itemList(items)}
      ${button('Check in or extend', BASE)}`
  }),

  overdue: ({ person, items, checkout, days, blocked }) => ({
    subject: `Overdue ${days} day${days === 1 ? '' : 's'}: ${items.length} item${items.length === 1 ? '' : 's'}`,
    body: `<p>Hi ${escape(person.name || 'there')} — this was due ${pretty(checkout.due_on)}, ${days} day${days === 1 ? '' : 's'} ago:</p>
      ${itemList(items)}
      ${blocked ? `<p style="background:#fdeceb;border-left:3px solid #e2564a;padding:10px 12px;margin:14px 0">
        You can't check out more gear until this is back.</p>` : ''}
      <p>If any of it is lost or broken, log it in the app rather than leaving it open — that's easier for everyone than a mystery.</p>
      ${button('Check in now', BASE)}`
  }),

  returned: ({ person, items }) => ({
    subject: `Checked in: ${items.length} item${items.length === 1 ? '' : 's'}`,
    body: `<p>Thanks ${escape(person.name || '')} — all back on the shelf:</p>${itemList(items)}`
  }),

  digest: ({ rows }) => ({
    subject: `Cage digest: ${rows.overdue} overdue, ${rows.out} out, ${rows.down} down`,
    body: `<p>Morning snapshot:</p>
      <ul style="padding-left:20px">
        <li>${rows.out} item(s) out on set</li>
        <li>${rows.overdue} item(s) overdue</li>
        <li>${rows.down} item(s) down for repair</li>
        <li>${rows.pickups} hold(s) being collected today</li>
      </ul>
      ${button('Open the cage', BASE)}`
  }),

  /* One-shot: sent the moment something a person is watching goes back to
     ready, then never again for that same watch. If two people are waiting
     on the same item, both get this — whoever gets to it first gets it,
     same as anything else in the cage. */
  itemAvailable: ({ person, item }) => ({
    subject: `Now available: ${item.name}`,
    body: `<p>Hi ${escape(person.name || '')} — you asked to hear about this one:</p>
      ${itemList([item])}
      <p>It's back on the shelf and free to take.</p>
      ${button('Open the cage', BASE)}`
  })
};
