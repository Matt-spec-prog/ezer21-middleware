// QuickBooks OAuth 2.0 + Base44 Google Auth Routes
//
// How QBO auth works:
//   1. Visit /api/auth/connect in your browser
//   2. Redirects to QuickBooks login/approval page
//   3. QuickBooks sends you back to /api/auth/callback with a temporary code
//   4. We exchange that code for real tokens (access + refresh)
//   5. Tokens are saved via the storage service (file locally, Vercel KV in production)
//
// How Base44 auth works:
//   1. Visit /api/auth/base44 in your browser
//   2. Redirects to Base44 Google login page
//   3. Base44 redirects back with ?access_token=xxx
//   4. Token saved via the storage service

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const storage  = require('../services/storage');

// ── Step 1: Start the QBO OAuth flow ─────────────────────────────────────────
router.get('/connect', (req, res) => {
  const params = new URLSearchParams({
    client_id:    process.env.QBO_CLIENT_ID,
    response_type: 'code',
    scope:        'com.intuit.quickbooks.accounting',
    redirect_uri: process.env.QBO_REDIRECT_URI,
    state:        'ezer21_auth',
  });

  const authUrl = `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
  res.redirect(authUrl);
});

// ── Step 2: Handle the callback from QuickBooks ───────────────────────────────
router.get('/callback', async (req, res) => {
  const { code, realmId } = req.query;

  if (!code || !realmId) {
    return res.status(400).send('Missing code or realmId from QuickBooks.');
  }

  try {
    const credentials = Buffer.from(
      `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
    ).toString('base64');

    const response = await axios.post(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      new URLSearchParams({
        grant_type:   'authorization_code',
        code:         code,
        redirect_uri: process.env.QBO_REDIRECT_URI,
      }).toString(),
      {
        headers: {
          Authorization:  `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept:         'application/json',
        },
      }
    );

    const tokens = {
      access_token:  response.data.access_token,
      refresh_token: response.data.refresh_token,
      realm_id:      realmId,
      token_type:    response.data.token_type,
      expires_in:    response.data.expires_in,
      created_at:    new Date().toISOString(),
    };

    await storage.setQBOTokens(tokens);
    console.log(`QuickBooks connected. Realm ID: ${realmId}`);

    res.send(`
      <h2 style="font-family:sans-serif;color:green;">QuickBooks Connected!</h2>
      <p style="font-family:sans-serif;">Realm ID: <strong>${realmId}</strong></p>
      <p style="font-family:sans-serif;">Tokens saved. You can close this window.</p>
    `);
  } catch (error) {
    console.error('Token exchange failed:', error.response?.data || error.message);
    res.status(500).send('Failed to connect to QuickBooks. Check server logs.');
  }
});

// ── Helper: Refresh an expired QBO access token ───────────────────────────────
async function refreshAccessToken() {
  const tokens = await storage.getQBOTokens();

  const credentials = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');

  const response = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: tokens.refresh_token,
    }).toString(),
    {
      headers: {
        Authorization:  `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept:         'application/json',
      },
    }
  );

  const updatedTokens = {
    ...tokens,
    access_token:  response.data.access_token,
    refresh_token: response.data.refresh_token || tokens.refresh_token,
    created_at:    new Date().toISOString(),
  };

  await storage.setQBOTokens(updatedTokens);
  console.log('Access token refreshed.');
  return updatedTokens;
}

// ── Base44 Google Auth ────────────────────────────────────────────────────────

// Step 1: redirect to Base44 Google login
router.get('/base44', (req, res) => {
  const appId       = process.env.BASE44_APP_ID;
  const callbackUrl = `${process.env.QBO_REDIRECT_URI.replace('/api/auth/callback', '')}/api/auth/base44/callback`;

  const loginUrl = `https://app.base44.app/api/apps/auth/login?app_id=${appId}&from_url=${encodeURIComponent(callbackUrl)}`;
  res.redirect(loginUrl);
});

// Step 2: Base44 redirects here with ?access_token=xxx after Google login
router.get('/base44/callback', async (req, res) => {
  const { access_token } = req.query;

  if (!access_token) {
    return res.status(400).send(`
      <h2 style="font-family:sans-serif;color:red;">No token received from Base44.</h2>
      <p style="font-family:sans-serif;">Try again: <a href="/api/auth/base44">/api/auth/base44</a></p>
    `);
  }

  const tokenData = {
    access_token,
    saved_at: new Date().toISOString(),
  };

  await storage.setBase44Token(tokenData);
  console.log('Base44 token saved.');

  res.send(`
    <h2 style="font-family:sans-serif;color:green;">Base44 Connected!</h2>
    <p style="font-family:sans-serif;">Token saved. You can close this window.</p>
    <p style="font-family:sans-serif;">Now visit <a href="/api/sync/push">/api/sync/push</a> to push data.</p>
  `);
});

// Helper: load the saved Base44 token (delegates to storage service)
async function getBase44Token() {
  return storage.getBase44Token();
}

module.exports = router;
module.exports.refreshAccessToken = refreshAccessToken;
module.exports.getBase44Token = getBase44Token;
