import { MailtrapClient } from 'mailtrap';
import * as nodemailer from 'nodemailer';
import appConfiguration from 'src/app.configuration';

function realSecret(...values: Array<string | undefined>) {
  for (const value of values) {
    const trimmed = (value || '').trim();
    if (!trimmed || trimmed === '<YOUR_API_TOKEN>') continue;
    return trimmed.replace(/\s+/g, '');
  }
  return '';
}

function smtpPassword() {
  // Mailtrap SMTP password is the same API token.
  return realSecret(
    process.env.SMTP_PASSWORD,
    process.env.MAILTRAP_API_TOKEN,
    process.env.MAILTRAP_API_KEY,
  );
}

function smtpUser() {
  return (appConfiguration().MAIL.SMTP_USER || '').trim();
}

function createTransporter() {
  const mail = appConfiguration().MAIL;
  const port = Number(mail.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: mail.SMTP_HOST,
    port,
    secure: mail.SMTP_SECURE || port === 465,
    requireTLS: !mail.SMTP_SECURE && (port === 587 || port === 2525 || port === 25),
    auth: {
      user: smtpUser(),
      pass: smtpPassword(),
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

export function isSmtpConfigured() {
  return Boolean(
    appConfiguration().MAIL.SMTP_HOST?.trim() && smtpUser() && smtpPassword(),
  );
}

function mailtrapToken() {
  return realSecret(process.env.MAILTRAP_API_TOKEN, process.env.MAILTRAP_API_KEY);
}

export function isMailtrapConfigured() {
  return Boolean(mailtrapToken());
}

function mailtrapSender(): { email: string; name: string } {
  const mail = appConfiguration().MAIL;
  return {
    email: mail.MAILTRAP_FROM_EMAIL.trim(),
    name: mail.MAILTRAP_FROM_NAME.trim() || 'Opal',
  };
}

function getMailtrapClient() {
  const token = mailtrapToken();
  if (!token) {
    throw new Error('MAILTRAP_API_TOKEN is not set');
  }
  const mail = appConfiguration().MAIL;
  const sandbox = mail.MAILTRAP_USE_SANDBOX;
  const inboxId = Number(mail.MAILTRAP_INBOX_ID);
  return new MailtrapClient({
    token,
    sandbox,
    testInboxId: sandbox && Number.isFinite(inboxId) && inboxId > 0
      ? inboxId
      : undefined,
  });
}

/** Mail is configured when any transport is available. */
export function isMailConfigured() {
  return Boolean(isMailtrapConfigured() || isSmtpConfigured());
}

/**
 * Inline recovery codes when mail cannot be delivered.
 * Set PASSWORD_RESET_INLINE_CODE=false to disable.
 */
export function shouldOfferInlineRecoveryCode() {
  const flag = (process.env.PASSWORD_RESET_INLINE_CODE || '')
    .trim()
    .toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  if (flag === 'false' || flag === '0' || flag === 'no') return false;
  return (
    process.env.RENDER === 'true' || Boolean(process.env.RENDER_SERVICE_ID)
  );
}

export function hasReliableMailTransport() {
  return isMailtrapConfigured();
}

function stripWrappingQuotes(value: string) {
  return value.trim().replace(/^['"]+|['"]+$/g, '').trim();
}

/**
 * Always brand outbound mail as Opal. Accepts "Name <email>" or bare email.
 */
export function resolveMailFrom(): string {
  const mail = appConfiguration().MAIL;
  const raw = stripWrappingQuotes(
    mail.SMTP_FROM ||
      (mail.MAILTRAP_FROM_EMAIL
        ? `${mail.MAILTRAP_FROM_NAME} <${mail.MAILTRAP_FROM_EMAIL}>`
        : ''),
  );
  if (!raw) return 'Opal <noreply@opal.app>';

  const angled = raw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    return `Opal <${angled[2].trim()}>`;
  }
  if (raw.includes('@')) {
    return `Opal <${raw}>`;
  }
  return `Opal <${raw}>`;
}

export function parseMailFrom(from = resolveMailFrom()): {
  name: string;
  email: string;
} {
  const angled = from.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    return {
      name: stripWrappingQuotes(angled[1]) || 'Opal',
      email: angled[2].trim(),
    };
  }
  return { name: 'Opal', email: from };
}

async function sendViaMailtrap(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  if (!isMailtrapConfigured()) {
    throw new Error('MAILTRAP_API_TOKEN is not set');
  }
  const mail = appConfiguration().MAIL;
  const client = getMailtrapClient();
  await client.send({
    from: mailtrapSender(),
    to: [{ email: options.to }],
    subject: options.subject,
    text: options.text,
    html: options.html,
    category: mail.MAILTRAP_CATEGORY,
  });
}

async function sendViaSmtp(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP is not configured');
  }
  const transporter = createTransporter();
  await transporter.sendMail({
    from: resolveMailFrom(),
    ...options,
  });
}

/**
 * Priority:
 * 1. Mailtrap Email API (send.api.mailtrap.io — HTTPS, preferred on Render)
 * 2. Mailtrap SMTP (live.smtp.mailtrap.io)
 *
 * MAIL_PROVIDER=mailtrap pins the API. MAIL_PROVIDER=smtp pins SMTP.
 */
export async function sendMail(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const prefer = appConfiguration().MAIL.PROVIDER || 'auto';
  const errors: string[] = [];

  const run = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${label}: ${message}`);
      // eslint-disable-next-line no-console
      console.error(`[Opal] mail transport ${label} failed:`, message);
      return false;
    }
  };

  try {
    if (prefer === 'mailtrap') {
      if (!(await run('mailtrap', () => sendViaMailtrap(options)))) {
        throw new Error(errors.join(' | '));
      }
      return;
    }
    if (prefer === 'smtp') {
      if (!(await run('smtp', () => sendViaSmtp(options)))) {
        throw new Error(errors.join(' | '));
      }
      return;
    }

    // auto
    if (isMailtrapConfigured()) {
      if (await run('mailtrap', () => sendViaMailtrap(options))) return;
    }
    if (isSmtpConfigured()) {
      if (await run('smtp', () => sendViaSmtp(options))) return;
    }

    throw new Error(errors[0] || 'No mail transport configured');
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown mail error';
    // eslint-disable-next-line no-console
    console.error('[Opal] sendMail failed:', message);
    throw error;
  }
}

function emailShell(params: {
  title: string;
  heading: string;
  bodyHtml: string;
  footer?: string;
}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(params.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#171717;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e8e8e8;">
          <tr>
            <td style="background:#0f172a;padding:28px 32px;">
              <div style="font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#94a3b8;font-weight:600;">Opal</div>
              <div style="margin-top:8px;font-size:22px;line-height:1.3;font-weight:700;color:#ffffff;">${escapeHtml(params.heading)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${params.bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px;border-top:1px solid #f1f5f9;font-size:11px;line-height:1.5;color:#94a3b8;">
              ${escapeHtml(params.footer || 'Sent by Opal — your personal financial operating system.')}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function buildVerificationEmailHtml(params: {
  fullName?: string | null;
  verifyUrl: string;
  expiresHours: number;
}) {
  const name = params.fullName?.trim() || 'there';
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">Hi ${escapeHtml(name)},</p>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#475569;">
      Confirm this email to unlock Opal. The link expires in
      <strong>${params.expiresHours} hour${params.expiresHours === 1 ? '' : 's'}</strong>.
    </p>
    <a href="${params.verifyUrl}"
       style="display:inline-block;background:#0072f5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:10px;">
      Verify email address
    </a>
    <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#94a3b8;">
      If the button does not work, paste this link into your browser:<br />
      <a href="${params.verifyUrl}" style="color:#0072f5;word-break:break-all;">${params.verifyUrl}</a>
    </p>`;

  return emailShell({
    title: 'Verify your Opal email',
    heading: 'Verify your email',
    bodyHtml,
    footer: 'If you did not create an Opal account, you can ignore this message.',
  });
}

export function buildRecoveryEmailHtml(params: { otp: string }) {
  const otp = String(params.otp || '').replace(/\D/g, '').slice(0, 6);
  // Visual digit chips — each chip is a digit with NO spaces between table cells'
  // text nodes that would break paste; the continuous code sits in a select-all block too.
  const chips = otp
    .split('')
    .map(
      (digit) =>
        `<td align="center" style="padding:0 4px;">
          <div style="width:40px;height:48px;line-height:48px;border-radius:10px;background:#0f172a;color:#ffffff;font-size:22px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">
            ${escapeHtml(digit)}
          </div>
        </td>`,
    )
    .join('');

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#334155;">
      Your one-time Opal recovery code:
    </p>
    <p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#64748b;">
      Tap or click the code to select it, copy, then paste into the 6 boxes on the reset page.
    </p>

    <table role="presentation" cellspacing="0" cellpadding="0" align="center" style="margin:0 auto 16px;">
      <tr>${chips}</tr>
    </table>

    <!-- Continuous digits for one-tap select / copy (no spaces — pastes cleanly into Opal). -->
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 12px;">
      <tr>
        <td align="center" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;">
          <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#94a3b8;margin-bottom:8px;">
            Copy this code
          </div>
          <div style="font-size:28px;line-height:1.2;font-weight:700;letter-spacing:0.35em;color:#0f172a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;-webkit-user-select:all;user-select:all;-moz-user-select:all;ms-user-select:all;">
            ${escapeHtml(otp)}
          </div>
          <div style="margin-top:10px;font-size:12px;color:#64748b;">
            Long-press or triple-click → Copy → paste on the reset page
          </div>
        </td>
      </tr>
    </table>

    <table role="presentation" cellspacing="0" cellpadding="0" align="center" style="margin:0 auto 20px;">
      <tr>
        <td align="center" style="background:#0f172a;border-radius:10px;padding:10px 18px;">
          <span style="font-size:13px;font-weight:600;color:#ffffff;letter-spacing:0.02em;">
            Code is 6 digits · no spaces · paste works
          </span>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:13px;line-height:1.6;color:#64748b;">
      Expires in <strong>10 minutes</strong> and can only be used once.
      Never share this code. If you did not request a reset, you can ignore this email.
    </p>`;

  return emailShell({
    title: 'Your Opal recovery code',
    heading: 'Password recovery',
    bodyHtml,
    footer: 'Sent by Opal — your personal financial operating system.',
  });
}

export function buildRecoveryEmailText(otpRaw: string) {
  const otp = String(otpRaw || '').replace(/\D/g, '').slice(0, 6);
  return [
    'Your Opal password recovery code:',
    '',
    otp,
    '',
    'Copy the 6 digits above (no spaces) and paste them into the boxes on the reset page.',
    'The code expires in 10 minutes and can only be used once.',
    '',
    'If you did not request this, ignore this email.',
  ].join('\n');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
