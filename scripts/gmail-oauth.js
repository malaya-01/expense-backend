/**
 * One-time consent so Opal can send password-reset and verification mail
 * through the Gmail API. Reads GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET from
 * .env and writes GMAIL_REFRESH_TOKEN and GMAIL_USER back into .env.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const clientId = (process.env.GMAIL_CLIENT_ID || '').trim();
const clientSecret = (process.env.GMAIL_CLIENT_SECRET || '').trim();
const port = 53682;
const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
const scope = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
].join(' ');

if (!clientId || !clientSecret) {
  console.error('MISSING_CLIENT');
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.searchParams.set('client_id', clientId);
authUrl.searchParams.set('redirect_uri', redirectUri);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', scope);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'consent');

function upsertEnv(key, value) {
  const envPath = path.join(__dirname, '..', '.env');
  let text = fs.readFileSync(envPath, 'utf8');
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) text = text.replace(pattern, line);
  else {
    if (!text.endsWith('\n')) text += '\n';
    text += `${line}\n`;
  }
  fs.writeFileSync(envPath, text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', redirectUri);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const oauthError = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  if (oauthError || !code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      `<p>Gmail authorization failed: ${oauthError || 'missing code'}. You can close this tab.</p>`,
    );
    console.error('OAUTH_ERROR', oauthError || 'missing code');
    server.close();
    process.exit(1);
    return;
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.refresh_token) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<p>Google did not return a refresh token. Close this tab and approve the prompt again.</p>',
      );
      console.error(
        'TOKEN_ERROR',
        tokenJson.error || tokenRes.status,
        tokenJson.error_description || '',
      );
      server.close();
      process.exit(1);
      return;
    }

    let email = '';
    if (tokenJson.id_token) {
      const part = tokenJson.id_token.split('.')[1];
      const payload = JSON.parse(Buffer.from(part, 'base64url').toString());
      email = payload.email || '';
    }
    if (!email && tokenJson.access_token) {
      const info = await fetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        { headers: { Authorization: `Bearer ${tokenJson.access_token}` } },
      );
      if (info.ok) {
        const profile = await info.json();
        email = profile.email || '';
      }
    }

    upsertEnv('GMAIL_REFRESH_TOKEN', tokenJson.refresh_token);
    if (email) upsertEnv('GMAIL_USER', email);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>Gmail is connected for Opal. You can close this tab.</p>');
    console.log('TOKEN_SAVED', email || 'unknown-user');
    server.close();
    process.exit(0);
  } catch (error) {
    console.error('TOKEN_ERROR', error instanceof Error ? error.message : error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Failed');
    server.close();
    process.exit(1);
  }
});

server.listen(port, '127.0.0.1', () => {
  const url = authUrl.toString();
  console.log('OAUTH_URL');
  console.log(url);
  if (process.platform === 'win32') {
    const file = path.join(os.tmpdir(), 'opal-gmail-auth.html');
    fs.writeFileSync(
      file,
      '<!doctype html><meta http-equiv="refresh" content="0;url=' +
        url.replace(/&/g, '&amp;') +
        '">',
    );
    spawn('cmd', ['/c', 'start', '', file], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  }
});
