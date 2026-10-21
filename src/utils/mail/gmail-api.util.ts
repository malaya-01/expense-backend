import { randomBytes } from 'crypto';
import { OAuth2Client } from 'google-auth-library';

function realSecret(...values: Array<string | undefined>) {
  for (const value of values) {
    const trimmed = (value || '').trim().replace(/^['"]+|['"]+$/g, '');
    if (!trimmed) continue;
    return trimmed.replace(/\s+/g, '');
  }
  return '';
}

export function gmailUser() {
  return (process.env.GMAIL_USER || '').trim().replace(/^['"]+|['"]+$/g, '');
}

/** Password reset and email verification send through the Gmail API. */
export function isGmailApiConfigured() {
  return Boolean(
    gmailUser() &&
      realSecret(process.env.GMAIL_CLIENT_ID) &&
      realSecret(process.env.GMAIL_CLIENT_SECRET) &&
      realSecret(process.env.GMAIL_REFRESH_TOKEN),
  );
}

function encodeRaw(message: string) {
  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export async function sendAuthMail(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const user = gmailUser();
  const clientId = realSecret(process.env.GMAIL_CLIENT_ID);
  const clientSecret = realSecret(process.env.GMAIL_CLIENT_SECRET);
  const refreshToken = realSecret(process.env.GMAIL_REFRESH_TOKEN);
  if (!user || !clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail API is not configured');
  }

  const oauth = new OAuth2Client(clientId, clientSecret);
  oauth.setCredentials({ refresh_token: refreshToken });
  const access = await oauth.getAccessToken();
  const token = access?.token;
  if (!token) {
    throw new Error('Gmail API did not return an access token');
  }

  const boundary = `opal_${randomBytes(12).toString('hex')}`;
  const subject = options.subject.replace(/[\r\n]+/g, ' ');
  const raw = encodeRaw(
    [
      `From: Opal <${user}>`,
      `To: ${options.to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      options.text,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"',
      'Content-Transfer-Encoding: 8bit',
      '',
      options.html,
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  );

  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Gmail API ${response.status}: ${body || response.statusText}`,
    );
  }

  // eslint-disable-next-line no-console
  console.info('[Opal] mail accepted via gmail-api');
}
