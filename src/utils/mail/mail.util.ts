import * as nodemailer from 'nodemailer';

function smtpPassword() {
  // Gmail app passwords are often pasted with spaces from Google's UI.
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
    auth: {
      user: process.env.SMTP_USER,
      pass: smtpPassword(),
    },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
}

/** Prefer Resend (HTTPS) on hosts that block SMTP, e.g. Render free tier. */
export function isMailConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() ||
      (process.env.SMTP_HOST &&
        process.env.SMTP_USER &&
        process.env.SMTP_PASSWORD),
  );
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
  const from =
    process.env.RESEND_FROM ||
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    'FinOS <onboarding@resend.dev>';

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
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
  const transporter = createTransporter();
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    ...options,
  });
}

export async function sendMail(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  try {
    if (process.env.RESEND_API_KEY?.trim()) {
      await sendViaResend(options);
      return;
    }
    await sendViaSmtp(options);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown mail error';
    // Surface the real reason in Render logs (no secrets).
    // eslint-disable-next-line no-console
    console.error('[FinOS] sendMail failed:', message);
    throw error;
  }
}

export function buildVerificationEmailHtml(params: {
  fullName?: string | null;
  verifyUrl: string;
  expiresHours: number;
}) {
  const name = params.fullName?.trim() || 'there';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Verify your FinOS email</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#171717;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e8e8e8;">
          <tr>
            <td style="background:#0f172a;padding:28px 32px;">
              <div style="font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#94a3b8;font-weight:600;">FinOS</div>
              <div style="margin-top:8px;font-size:22px;line-height:1.3;font-weight:700;color:#ffffff;">Verify your email</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">Hi ${escapeHtml(name)},</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#475569;">
                Confirm this email to unlock your personal financial operating system. The link expires in
                <strong>${params.expiresHours} hour${params.expiresHours === 1 ? '' : 's'}</strong>.
              </p>
              <a href="${params.verifyUrl}"
                 style="display:inline-block;background:#0072f5;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 22px;border-radius:10px;">
                Verify email address
              </a>
              <p style="margin:28px 0 0;font-size:12px;line-height:1.6;color:#94a3b8;">
                If the button does not work, paste this link into your browser:<br />
                <a href="${params.verifyUrl}" style="color:#0072f5;word-break:break-all;">${params.verifyUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 28px;border-top:1px solid #f1f5f9;font-size:11px;line-height:1.5;color:#94a3b8;">
              If you did not create a FinOS account, you can ignore this message.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
