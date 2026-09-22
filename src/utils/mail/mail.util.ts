import * as nodemailer from 'nodemailer';

function smtpPassword() {
  // Gmail app passwords / Brevo keys are often pasted with spaces from the UI.
  return (process.env.SMTP_PASSWORD || '').replace(/\s+/g, '');
}

function createTransporter() {
  const port = Number(process.env.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure:
      process.env.SMTP_SECURE === 'true' ||
      (process.env.SMTP_SECURE !== 'false' && port === 465),
    requireTLS: port === 587 || port === 2525,
    auth: {
      user: process.env.SMTP_USER,
      pass: smtpPassword(),
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

export function isSmtpConfigured() {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
      process.env.SMTP_USER?.trim() &&
      process.env.SMTP_PASSWORD?.trim(),
  );
}

export function isBrevoApiConfigured() {
  return Boolean(
    process.env.BREVO_API_KEY?.trim() || process.env.SENDINBLUE_API_KEY?.trim(),
  );
}

function brevoApiKey() {
  return (
    process.env.BREVO_API_KEY?.trim() ||
    process.env.SENDINBLUE_API_KEY?.trim() ||
    ''
  );
}

function isBrevoSmtpHost() {
  const host = (process.env.SMTP_HOST || '').toLowerCase();
  return host.includes('brevo') || host.includes('sendinblue');
}

/** Mail is configured when any transport is available. */
export function isMailConfigured() {
  return Boolean(
    isBrevoApiConfigured() ||
      process.env.RESEND_API_KEY?.trim() ||
      isSmtpConfigured(),
  );
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
  return Boolean(isBrevoApiConfigured() || process.env.RESEND_API_KEY?.trim());
}

function stripWrappingQuotes(value: string) {
  return value.trim().replace(/^['"]+|['"]+$/g, '').trim();
}

/**
 * Always brand outbound mail as Opal. Accepts "Name <email>" or bare email.
 */
export function resolveMailFrom(): string {
  const raw = stripWrappingQuotes(
    process.env.SMTP_FROM ||
      process.env.BREVO_FROM ||
      process.env.RESEND_FROM ||
      process.env.SMTP_USER ||
      '',
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

async function sendViaBrevoApi(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const apiKey = brevoApiKey();
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not set');
  }
  const sender = parseMailFrom();

  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      sender: { name: sender.name, email: sender.email },
      to: [{ email: options.to }],
      subject: options.subject,
      htmlContent: options.html,
      textContent: options.text,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Brevo API ${response.status}: ${body || response.statusText}`,
    );
  }
}

async function sendViaResend(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not set');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: resolveMailFrom(),
      to: [options.to],
      subject: options.subject,
      text: options.text,
      html: options.html,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Resend API ${response.status}: ${body || response.statusText}`,
    );
  }
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
 * 1. Brevo HTTPS API (works on Render free — SMTP ports are often blocked)
 * 2. SMTP (Brevo relay / other)
 * 3. Resend only when explicitly chosen, or as last resort when Brevo is not configured
 *
 * When Brevo SMTP/API is configured we do NOT fall back to Resend — Resend free
 * only delivers to the account owner and masks real Brevo failures.
 */
export async function sendMail(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const prefer =
    (process.env.MAIL_PROVIDER || '').trim().toLowerCase() || 'auto';
  const errors: string[] = [];
  const brevoConfigured = isBrevoApiConfigured() || isBrevoSmtpHost();

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
    if (prefer === 'brevo' || prefer === 'brevo_api') {
      if (!(await run('brevo-api', () => sendViaBrevoApi(options)))) {
        throw new Error(errors.join(' | '));
      }
      return;
    }
    if (prefer === 'smtp') {
      if (!(await run('smtp', () => sendViaSmtp(options)))) {
        // On Render, SMTP is often blocked — try Brevo HTTPS if available.
        if (
          isBrevoApiConfigured() &&
          (await run('brevo-api', () => sendViaBrevoApi(options)))
        ) {
          return;
        }
        throw new Error(errors.join(' | '));
      }
      return;
    }
    if (prefer === 'resend') {
      if (!(await run('resend', () => sendViaResend(options)))) {
        throw new Error(errors.join(' | '));
      }
      return;
    }

    // auto
    if (isBrevoApiConfigured()) {
      if (await run('brevo-api', () => sendViaBrevoApi(options))) return;
    }
    if (isSmtpConfigured()) {
      if (await run('smtp', () => sendViaSmtp(options))) return;
    }
    // Only use Resend when Brevo is not the configured provider.
    if (!brevoConfigured && process.env.RESEND_API_KEY?.trim()) {
      if (await run('resend', () => sendViaResend(options))) return;
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
  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
      Use this one-time code to reset your Opal password:
    </p>
    <p style="margin:0 0 8px;font-size:32px;line-height:1.2;font-weight:700;letter-spacing:8px;color:#0f172a;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">
      ${escapeHtml(params.otp)}
    </p>
    <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#64748b;">
      This code expires in <strong>10 minutes</strong> and can only be used once.
      Enter the 6-digit code on the reset page — not your email address.
    </p>`;

  return emailShell({
    title: 'Your Opal recovery code',
    heading: 'Password recovery',
    bodyHtml,
    footer: 'If you did not request a password reset, you can ignore this email.',
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
