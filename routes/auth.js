// QuickBooks OAuth 2.0 Routes
//
// How this works:
//   1. You visit /api/auth/connect in your browser
//   2. It redirects you to QuickBooks' login/approval page
//   3. QuickBooks sends you back to /api/auth/callback with a temporary code
//   4. We exchange that code for real tokens (access + refresh)
//   5. Tokens are saved to tokens.json so we can pull reports later

const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Where we store the QBO tokens locally
const TOKENS_FILE = path.join(__dirname, '..', 'tokens.json');

// ── Step 1: Start the OAuth flow ──────────────────────────────────────────────
// Visit http://localhost:3000/api/auth/connect to kick things off
router.get('/connect', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: process.env.QBO_REDIRECT_URI,
    state: 'ezer21_auth', // a simple value to verify the request came from us
  });

  const authUrl = `https://appcenter.intuit.com/connect/oauth2?${params.toString()}`;
  res.redirect(authUrl);
});

// ── Step 2: Handle the callback from QuickBooks ───────────────────────────────
// QuickBooks redirects here after the user approves access
router.get('/callback', async (req, res) => {
  const { code, realmId } = req.query;

  if (!code || !realmId) {
    return res.status(400).send('Missing code or realmId from QuickBooks.');
  }

  try {
    // Build the Basic Auth header using Client ID + Secret (base64 encoded)
    const credentials = Buffer.from(
      `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
    ).toString('base64');

    // Exchange the temporary code for real access + refresh tokens
    const response = await axios.post(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: process.env.QBO_REDIRECT_URI,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      }
    );

    // Save the tokens and the realmId (realmId = QuickBooks company ID)
    const tokens = {
      access_token: response.data.access_token,   // expires in ~60 minutes
      refresh_token: response.data.refresh_token, // used to get a new access token
      realm_id: realmId,                          // identifies which QBO company
      token_type: response.data.token_type,
      expires_in: response.data.expires_in,
      created_at: new Date().toISOString(),
    };

    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));

    console.log(`QuickBooks connected. Realm ID: ${realmId}`);

    res.send(`
      <h2 style="font-family: sans-serif; color: green;">QuickBooks Connected!</h2>
      <p style="font-family: sans-serif;">Realm ID: <strong>${realmId}</strong></p>
      <p style="font-family: sans-serif;">Tokens saved. You can close this window.</p>
    `);
  } catch (error) {
    console.error('Token exchange failed:', error.response?.data || error.message);
    res.status(500).send('Failed to connect to QuickBooks. Check server logs.');
  }
});

// ── Helper: Refresh an expired access token ───────────────────────────────────
// Access tokens expire every ~60 min. This uses the refresh token to get a new one.
async function refreshAccessToken() {
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));

  const credentials = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');

  const response = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }).toString(),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    }
  );

  // Update and save the new tokens
  const updatedTokens = {
    ...tokens,
    access_token: response.data.access_token,
    refresh_token: response.data.refresh_token || tokens.refresh_token,
    created_at: new Date().toISOString(),
  };

  fs.writeFileSync(TOKENS_FILE, JSON.stringify(updatedTokens, null, 2));
  console.log('Access token refreshed.');
  return updatedTokens;
}

// ── Base44 Google Auth ────────────────────────────────────────────────────────
// Mirrors the QBO OAuth flow but for Base44.
//
// How it works:
//   1. Visit /api/auth/base44 in your browser
//   2. You're redirected to Base44's Google login page
//   3. After login, Base44 redirects back here with ?access_token=xxx
//   4. We save the token to base44_token.json for the push service to use
//
// Tokens last roughly 7 days. When the push fails with 401, visit
// /api/auth/base44 again to re-authenticate.

const BASE44_TOKEN_FILE = path.join(__dirname, '..', 'base44_token.json');

// Step 1: redirect to Base44 Google login
router.get('/base44', (req, res) => {
  const appId       = process.env.BASE44_APP_ID;
  const callbackUrl = 'http://localhost:3000/api/auth/base44/callback';

  // Login via the app's own URL — Base44 will redirect back with ?access_token=xxx
  const appBaseUrl  = `https://app.base44.app`;
  const loginUrl    = `${appBaseUrl}/api/apps/auth/login?app_id=${appId}&from_url=${encodeURIComponent(callbackUrl)}`;
  res.redirect(loginUrl);
});

// Step 2: Base44 redirects here with ?access_token=xxx after Google login
router.get('/base44/callback', (req, res) => {
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

  fs.writeFileSync(BASE44_TOKEN_FILE, JSON.stringify(tokenData, null, 2));
  console.log('Base44 token saved to base44_token.json');

  res.send(`
    <h2 style="font-family:sans-serif;color:green;">Base44 Connected!</h2>
    <p style="font-family:sans-serif;">Token saved. You can close this window.</p>
    <p style="font-family:sans-serif;">Now visit <a href="/api/sync/push">http://localhost:3000/api/sync/push</a> to push data.</p>
  `);
});

// Helper: load the saved Base44 token
function getBase44Token() {
  if (!fs.existsSync(BASE44_TOKEN_FILE)) {
    throw new Error('No Base44 token found. Visit http://localhost:3000/api/auth/base44 to log in first.');
  }
  const data = JSON.parse(fs.readFileSync(BASE44_TOKEN_FILE, 'utf8'));
  if (!data.access_token) {
    throw new Error('Base44 token file is invalid. Visit http://localhost:3000/api/auth/base44 to log in again.');
  }
  return data.access_token;
}

// Export the refresh function so other parts of the app can use it
module.exports = router;
module.exports.refreshAccessToken = refreshAccessToken;
module.exports.getBase44Token = getBase44Token;
