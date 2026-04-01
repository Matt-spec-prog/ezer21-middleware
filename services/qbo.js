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

// ── Pull PayrollSummary report ────────────────────────────────────────────────
// Returns payroll totals (wages, benefits, employer taxes) for the most recent
// full month. These are used in the forecast as flat monthly run rates.
//
// Note: requires the company to use QBO Payroll (or QBO-integrated payroll).
// If the company uses a third-party payroll app (Gusto, ADP, etc.) this report
// may not be available — in that case the function returns null and the forecast
// falls back to straightlining the last actual month from the P&L.
//
// The report is pulled for the most recent completed calendar month.
async function getPayrollSummary() {
  const tokens = getTokens();
  const realmId = tokens.realm_id;

  // Use the most recently completed calendar month
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);

  const fmt = (d) => d.toISOString().split('T')[0];
  const startDate = fmt(lastMonth);
  const endDate   = fmt(lastDay);

  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });

  console.log(`Pulling PayrollSummary for ${startDate} → ${endDate}...`);

  try {
    const data = await qboRequest(
      `/v3/company/${realmId}/reports/PayrollSummary?${params.toString()}`
    );
    console.log('PayrollSummary report received.');
    return data;
  } catch (err) {
    // PayrollSummary is only available if the company uses QBO Payroll.
    // Return null so the caller can fall back gracefully.
    console.warn(`PayrollSummary not available: ${err.message}`);
    console.warn('Forecast will use last actual month from P&L for wages/benefits/taxes.');
    return null;
  }
}

// ── Parse PayrollSummary into flat monthly totals ─────────────────────────────
// Extracts three numbers from the raw QBO PayrollSummary response:
//   wages:          total gross wages paid (salaries + hourly)
//   benefits:       total employee benefits (health, 401k, etc.)
//   employer_taxes: total employer-side payroll taxes (FUTA, SUTA, FICA match)
//
// Returns { wages, benefits, employer_taxes } or null if parsing fails.
function parsePayrollSummary(report) {
  if (!report || !report.Rows || !report.Rows.Row) return null;

  // QBO PayrollSummary groups rows under labels like:
  //   "Total Wages" / "Wages" / "Gross Pay"
  //   "Total Taxes" / "Employee Taxes" / "Employer Taxes"
  //   "Total Deductions" / "Benefits"
  // The exact structure varies by QBO version and payroll setup.
  // We search for these group names case-insensitively.

  let wages         = 0;
  let benefits      = 0;
  let employer_taxes = 0;

  function extractValue(colData) {
    // The summary column is usually the last ColData entry
    if (!colData || colData.length === 0) return 0;
    const last = colData[colData.length - 1];
    return parseFloat(last.value) || 0;
  }

  function walkRows(rows) {
    for (const row of rows) {
      const label = (row.Summary?.ColData?.[0]?.value || row.ColData?.[0]?.value || '').toLowerCase();

      // Wages / gross pay
      if (label.includes('total wages') || label.includes('gross pay') || label.includes('total gross')) {
        wages = extractValue(row.Summary?.ColData || row.ColData);
      }

      // Employer taxes
      if (label.includes('employer tax') || label.includes('company tax')) {
        employer_taxes = extractValue(row.Summary?.ColData || row.ColData);
      }

      // Benefits / deductions (employer-paid portion)
      if (label.includes('total deduction') || label.includes('benefit') || label.includes('employer contribution')) {
        benefits = extractValue(row.Summary?.ColData || row.ColData);
      }

      // Recurse into nested rows
      if (row.Rows?.Row) walkRows(row.Rows.Row);
    }
  }

  walkRows(report.Rows.Row);

  if (wages === 0 && benefits === 0 && employer_taxes === 0) {
    console.warn('PayrollSummary parsed but all values are zero — check report structure.');
    return null;
  }

  console.log(`  Payroll totals: Wages $${wages.toFixed(2)}, Benefits $${benefits.toFixed(2)}, Employer Taxes $${employer_taxes.toFixed(2)}`);
  return { wages, benefits, employer_taxes };
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

module.exports = { getProfitAndLoss, getBalanceSheet, getPayrollSummary, parsePayrollSummary, getDateRange };
