// QuickBooks Online API Service
//
// This file handles all communication with the QBO API.
// It reads the saved tokens, makes report requests, and automatically
// refreshes the access token if it has expired.

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { refreshAccessToken } = require('../routes/auth');

const TOKENS_FILE = path.join(__dirname, '..', 'tokens.json');

// Sandbox and production base URLs
const QBO_BASE_URL = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
};

// ── Load tokens from file ─────────────────────────────────────────────────────
function getTokens() {
  if (!fs.existsSync(TOKENS_FILE)) {
    throw new Error('No tokens found. Please connect QuickBooks first at /api/auth/connect');
  }
  return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
}

// ── Check if the access token is expired ─────────────────────────────────────
// Access tokens last 60 minutes. We refresh if they're older than 55 minutes.
function isTokenExpired(tokens) {
  const createdAt = new Date(tokens.created_at).getTime();
  const now = Date.now();
  const ageInMinutes = (now - createdAt) / 1000 / 60;
  return ageInMinutes > 55;
}

// ── Make an authenticated request to QBO ─────────────────────────────────────
// Automatically refreshes the token if needed before making the request.
async function qboRequest(url) {
  let tokens = getTokens();

  if (isTokenExpired(tokens)) {
    console.log('Access token expired — refreshing...');
    tokens = await refreshAccessToken();
  }

  const environment = process.env.QBO_ENVIRONMENT || 'sandbox';
  const baseUrl = QBO_BASE_URL[environment];

  const response = await axios.get(`${baseUrl}${url}`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
    },
  });

  return response.data;
}

// ── Pull Profit & Loss report ─────────────────────────────────────────────────
// Returns the last 12 months of P&L data, broken down by month.
async function getProfitAndLoss(startDate, endDate) {
  const tokens = getTokens();
  const realmId = tokens.realm_id;

  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    summarize_column_by: 'Month',
  });

  console.log(`Pulling P&L report for company ${realmId}...`);
  const data = await qboRequest(
    `/v3/company/${realmId}/reports/ProfitAndLoss?${params.toString()}`
  );
  console.log('P&L report received.');
  return data;
}

// ── Pull Balance Sheet report ─────────────────────────────────────────────────
// Returns the balance sheet as of the end of the date range.
async function getBalanceSheet(startDate, endDate) {
  const tokens = getTokens();
  const realmId = tokens.realm_id;

  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    summarize_column_by: 'Month',
  });

  console.log(`Pulling Balance Sheet report for company ${realmId}...`);
  const data = await qboRequest(
    `/v3/company/${realmId}/reports/BalanceSheet?${params.toString()}`
  );
  console.log('Balance Sheet report received.');
  return data;
}

// ── Helper: Get last N months date range ─────────────────────────────────────
// Returns { startDate, endDate } formatted as YYYY-MM-DD strings.
function getDateRange(months = 12) {
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);

  const fmt = (d) => d.toISOString().split('T')[0];
  return { startDate: fmt(start), endDate: fmt(end) };
}

module.exports = { getProfitAndLoss, getBalanceSheet, getDateRange };
