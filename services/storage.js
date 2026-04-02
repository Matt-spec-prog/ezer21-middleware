// Storage Service
//
// Abstracts token and file-reference persistence so the rest of the code
// doesn't need to care whether it's running locally or on Vercel.
//
//   Local dev  → reads/writes JSON files on disk (tokens.json, base44_token.json)
//   Vercel     → reads/writes Vercel KV (a free Redis-based key-value store)
//
// Environment detection: Vercel automatically sets VERCEL=1 in all deployments.

const IS_VERCEL = process.env.VERCEL === '1';

// ── QBO Tokens ────────────────────────────────────────────────────────────────

async function getQBOTokens() {
  if (IS_VERCEL) {
    const { kv } = require('@vercel/kv');
    const data = await kv.get('qbo_tokens');
    if (!data) throw new Error('No QBO tokens found. Visit /api/auth/connect to connect QuickBooks.');
    return data;
  }
  const fs   = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'tokens.json');
  if (!fs.existsSync(file)) throw new Error('No tokens found. Visit /api/auth/connect to connect QuickBooks.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function setQBOTokens(data) {
  if (IS_VERCEL) {
    const { kv } = require('@vercel/kv');
    await kv.set('qbo_tokens', data);
    return;
  }
  const fs   = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'tokens.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Base44 Token ──────────────────────────────────────────────────────────────

async function getBase44Token() {
  if (IS_VERCEL) {
    const { kv } = require('@vercel/kv');
    const data = await kv.get('base44_token');
    if (!data || !data.access_token) {
      throw new Error('No Base44 token found. Visit /api/auth/base44 to log in first.');
    }
    return data.access_token;
  }
  const fs   = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'base44_token.json');
  if (!fs.existsSync(file)) {
    throw new Error('No Base44 token found. Visit /api/auth/base44 to log in first.');
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data.access_token) {
    throw new Error('Base44 token file is invalid. Visit /api/auth/base44 to log in again.');
  }
  return data.access_token;
}

async function setBase44Token(data) {
  if (IS_VERCEL) {
    const { kv } = require('@vercel/kv');
    await kv.set('base44_token', data);
    return;
  }
  const fs   = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'base44_token.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── HubSpot Blob URL ──────────────────────────────────────────────────────────
// Vercel only — stores the Vercel Blob URL for the uploaded HubSpot xlsx file.
// Not used in local dev (local dev reads from HUBSPOT_PIPELINE_FILE path).

async function getHubspotBlobUrl() {
  if (!IS_VERCEL) return null;
  const { kv } = require('@vercel/kv');
  return kv.get('hubspot_blob_url');
}

async function setHubspotBlobUrl(url) {
  if (!IS_VERCEL) return;
  const { kv } = require('@vercel/kv');
  await kv.set('hubspot_blob_url', url);
}

module.exports = {
  getQBOTokens,
  setQBOTokens,
  getBase44Token,
  setBase44Token,
  getHubspotBlobUrl,
  setHubspotBlobUrl,
};
