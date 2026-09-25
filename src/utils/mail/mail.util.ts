import { MailtrapClient } from 'mailtrap';
import * as nodemailer from 'nodemailer';
import appConfiguration from 'src/app.configuration';
import { resolvePublicAppOrigin } from 'src/utils/url/public-app-url';

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

function emailAsset(path: string) {
  const origin = resolvePublicAppOrigin();
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${clean}`;
}

function emailButton(href: string, label: string) {
  return `<table role="presentation" cellspacing="0" cellpadding="0">
  <tr>
    <td class="email-btn" bgcolor="#0072f5" style="border-radius:10px;background:#0072f5;">
      <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"
         style="display:inline-block;padding:12px 22px;font-size:14px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">
        ${escapeHtml(label)}
      </a>
    </td>
  </tr>
</table>`;
}

function emailShell(params: {
  title: string;
  heading: string;
  bodyHtml: string;
  footer: string;
}) {
  const logoLight = emailAsset('/brand/themes/vercel-light.png?v=4');
  const logoDark = emailAsset('/brand/themes/midnight.png?v=4');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${escapeHtml(params.title)}</title>
  <style>
    :root { color-scheme: light dark; }
    @media (prefers-color-scheme: dark) {
      .email-bg { background:#0c0d12 !important; }
      .email-card { background:#161821 !important; border-color:#1e2030 !important; }
      .email-header { background:#161821 !important; border-color:#1e2030 !important; }
      .email-heading { color:#f3f4f8 !important; }
      .email-brand { color:#b0b4c4 !important; }
      .email-text { color:#f3f4f8 !important; }
      .email-muted { color:#b0b4c4 !important; }
      .email-code { background:#0c0d12 !important; border-color:#1e2030 !important; color:#f3f4f8 !important; }
      .email-footer { border-color:#1e2030 !important; color:#8b90a4 !important; }
      .email-btn { background:#8b7cf7 !important; }
      .logo-light { display:none !important; width:0 !important; height:0 !important; overflow:hidden !important; }
      .logo-dark { display:block !important; width:40px !important; height:40px !important; }
    }
  </style>
</head>
<body class="email-bg" style="margin:0;padding:0;background:#fafafa;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" class="email-bg" width="100%" cellspacing="0" cellpadding="0" style="background:#fafafa;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" class="email-card" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #ececec;">
          <tr>
            <td class="email-header" style="padding:24px 28px 20px;border-bottom:1px solid #ececec;">
              <table role="presentation" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="width:40px;height:40px;vertical-align:middle;">
                    <img class="logo-light" src="${escapeHtml(logoLight)}" alt="Opal" width="40" height="40" style="display:block;border-radius:10px;border:0;" />
                    <img class="logo-dark" src="${escapeHtml(logoDark)}" alt="Opal" width="40" height="40" style="display:none;border-radius:10px;border:0;width:0;height:0;overflow:hidden;" />
                  </td>
                  <td style="padding-left:12px;vertical-align:middle;">
                    <div class="email-brand" style="font-size:16px;line-height:20px;font-weight:700;letter-spacing:-0.3px;color:#171717;">Opal</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <h1 class="email-heading" style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:700;letter-spacing:-0.4px;color:#171717;">${escapeHtml(params.heading)}</h1>
              ${params.bodyHtml}
            </td>
          </tr>
          <tr>
            <td class="email-footer" style="padding:16px 28px 24px;border-top:1px solid #ececec;font-size:12px;line-height:18px;color:#6b6b6b;">
              ${escapeHtml(params.footer)}
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
  const name = params.fullName?.trim();
  const greeting = name
    ? `<p class="email-text" style="margin:0 0 12px;font-size:15px;line-height:22px;color:#171717;">Hello ${escapeHtml(name)},</p>`
    : '';
  const hours = `${params.expiresHours} hour${params.expiresHours === 1 ? '' : 's'}`;
  const bodyHtml = `
    ${greeting}
    <p class="email-muted" style="margin:0 0 24px;font-size:15px;line-height:22px;color:#4d4d4d;">
      Confirm this email address to continue. This link expires in ${hours}.
    </p>
    ${emailButton(params.verifyUrl, 'Verify email')}`;

  return emailShell({
    title: 'Verify your email',
    heading: 'Verify your email',
    bodyHtml,
    footer: 'If you did not create this account, you can ignore this email.',
  });
}

export function buildRecoveryEmailHtml(params: { otp: string }) {
  const otp = String(params.otp || '').replace(/\D/g, '').slice(0, 6);
  const bodyHtml = `
    <p class="email-muted" style="margin:0 0 20px;font-size:15px;line-height:22px;color:#4d4d4d;">
      Use this code to reset your password. It expires in 10 minutes.
    </p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr>
        <td class="email-code" align="center" style="background:#f4f4f5;border:1px solid #ececec;border-radius:12px;padding:18px 16px;font-size:28px;line-height:34px;font-weight:700;letter-spacing:0.28em;color:#171717;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;-webkit-user-select:all;user-select:all;">
          ${escapeHtml(otp)}
        </td>
      </tr>
    </table>
    <p class="email-muted" style="margin:20px 0 0;font-size:13px;line-height:20px;color:#6b6b6b;">
      Enter the code on the password reset page. Do not share it.
    </p>`;

  return emailShell({
    title: 'Password recovery',
    heading: 'Password recovery',
    bodyHtml,
    footer: 'If you did not request this, you can ignore this email.',
  });
}

export function buildRecoveryEmailText(otpRaw: string) {
  const otp = String(otpRaw || '').replace(/\D/g, '').slice(0, 6);
  return [
    'Password recovery',
    '',
    `Your code: ${otp}`,
    '',
    'This code expires in 10 minutes. Enter it on the password reset page.',
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
