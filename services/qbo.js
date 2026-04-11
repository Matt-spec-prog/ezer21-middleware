// QuickBooks Online API Service
//
// Handles all communication with the QBO API.
// Reads saved tokens via the storage service, makes report requests, and
// automatically refreshes the access token if it has expired.

const axios   = require('axios');
const storage = require('./storage');
const { refreshAccessToken } = require('../routes/auth');

// Sandbox and production base URLs
const QBO_BASE_URL = {
  sandbox:    'https://sandbox-quickbooks.api.intuit.com',
  production: 'https://quickbooks.api.intuit.com',
};

// ── Load tokens ───────────────────────────────────────────────────────────────
async function getTokens() {
  return storage.getQBOTokens();
}

// ── Check if the access token is expired ─────────────────────────────────────
// Access tokens last 60 minutes. We refresh if older than 55 minutes.
function isTokenExpired(tokens) {
  const createdAt    = new Date(tokens.created_at).getTime();
  const ageInMinutes = (Date.now() - createdAt) / 1000 / 60;
  return ageInMinutes > 55;
}

// ── Make an authenticated request to QBO ─────────────────────────────────────
async function qboRequest(url) {
  let tokens = await getTokens();

  if (isTokenExpired(tokens)) {
    console.log('Access token expired — refreshing...');
    tokens = await refreshAccessToken();
  }

  const environment = process.env.QBO_ENVIRONMENT || 'sandbox';
  const baseUrl     = QBO_BASE_URL[environment];

  const response = await axios.get(`${baseUrl}${url}`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept:        'application/json',
    },
  });

  return response.data;
}

// ── Pull Profit & Loss report ─────────────────────────────────────────────────
async function getProfitAndLoss(startDate, endDate) {
  const tokens  = await getTokens();
  const realmId = tokens.realm_id;

  const params = new URLSearchParams({
    start_date:          startDate,
    end_date:            endDate,
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
async function getBalanceSheet(startDate, endDate) {
  const tokens  = await getTokens();
  const realmId = tokens.realm_id;

  const params = new URLSearchParams({
    start_date:          startDate,
    end_date:            endDate,
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
// Returns payroll totals for the most recent full month.
// Returns null if QBO Payroll is not available (e.g. TriNet / ADP users).
async function getPayrollSummary() {
  const tokens  = await getTokens();
  const realmId = tokens.realm_id;

  const now      = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastDay   = new Date(now.getFullYear(), now.getMonth(), 0);

  const fmt       = (d) => d.toISOString().split('T')[0];
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
    console.warn(`PayrollSummary not available: ${err.message}`);
    console.warn('Forecast will use last actual month from P&L for wages/benefits/taxes.');
    return null;
  }
}

// ── Parse PayrollSummary into flat monthly totals ─────────────────────────────
function parsePayrollSummary(report) {
  if (!report || !report.Rows || !report.Rows.Row) return null;

  let wages          = 0;
  let benefits       = 0;
  let employer_taxes = 0;

  function extractValue(colData) {
    if (!colData || colData.length === 0) return 0;
    const last = colData[colData.length - 1];
    return parseFloat(last.value) || 0;
  }

  function walkRows(rows) {
    for (const row of rows) {
      const label = (row.Summary?.ColData?.[0]?.value || row.ColData?.[0]?.value || '').toLowerCase();

      if (label.includes('total wages') || label.includes('gross pay') || label.includes('total gross')) {
        wages = extractValue(row.Summary?.ColData || row.ColData);
      }
      if (label.includes('employer tax') || label.includes('company tax')) {
        employer_taxes = extractValue(row.Summary?.ColData || row.ColData);
      }
      if (label.includes('total deduction') || label.includes('benefit') || label.includes('employer contribution')) {
        benefits = extractValue(row.Summary?.ColData || row.ColData);
      }

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

// ── Pull transactions for a single account in a date range ───────────────────
// Uses the QBO TransactionList report filtered to one account.
// Returns a structured list of individual transactions for the drill-down feature.
async function getTransactionsByAccount(accountName, startDate, endDate) {
  const tokens  = await getTokens();
  const realmId = tokens.realm_id;

  const params = new URLSearchParams({
    start_date: startDate,
    end_date:   endDate,
    account:    accountName,
  });

  console.log(`Pulling TransactionList for "${accountName}" (${startDate} → ${endDate})...`);

  let data;
  try {
    data = await qboRequest(
      `/v3/company/${realmId}/reports/TransactionList?${params.toString()}`
    );
  } catch (err) {
    if (err.response?.status === 400 || err.response?.status === 404) {
      return { account_name: accountName, period: startDate.slice(0, 7), transactions: [], live_total: 0, error: 'account_not_found' };
    }
    throw err;
  }

  // Build a column index from the report headers so we don't depend on fixed positions.
  // QBO reports put column metadata in Header.Columns.Column (or Header.Column).
  const columns = data?.Header?.Columns?.Column || data?.Columns?.Column || [];
  const colIdx  = {};
  columns.forEach((col, i) => {
    if (col.ColType)  colIdx[col.ColType]  = i;
    if (col.ColTitle) colIdx[col.ColTitle] = i;
  });

  // Fallback positions if headers are missing (common TransactionList column order)
  const idx = {
    date:   colIdx['tx_date']   ?? colIdx['Date']                ?? 0,
    type:   colIdx['txn_type']  ?? colIdx['Transaction Type']    ?? 1,
    doc:    colIdx['doc_num']   ?? colIdx['Num']                 ?? 2,
    name:   colIdx['name']      ?? colIdx['Name']                ?? 3,
    memo:   colIdx['memo']      ?? colIdx['Memo/Description']    ?? 4,
    amount: colIdx['amount']    ?? colIdx['Amount']              ?? 7,
  };

  const rows = data?.Rows?.Row || [];
  const transactions = [];

  function processRow(row) {
    // Skip section/summary rows — only process data rows with ColData
    if (!row.ColData || row.type === 'Section') return;
    const cols = row.ColData;

    const dateVal   = cols[idx.date]?.value   || '';
    const typeVal   = cols[idx.type]?.value   || '';
    const docVal    = cols[idx.doc]?.value    || '';
    const nameVal   = cols[idx.name]?.value   || '';
    const memoVal   = cols[idx.memo]?.value   || '';
    const amountStr = cols[idx.amount]?.value || '0';

    if (!dateVal) return; // skip empty rows
    const amount = parseFloat(amountStr) || 0;

    transactions.push({
      date:             dateVal,
      type:             typeVal,
      doc_number:       docVal,
      vendor_or_entity: nameVal,
      memo:             memoVal,
      amount,
    });
  }

  for (const row of rows) {
    if (row.Rows?.Row) {
      // Section row — process its children
      for (const child of row.Rows.Row) processRow(child);
    } else {
      processRow(row);
    }
  }

  // Sort by date ascending
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  const live_total = Math.round(transactions.reduce((s, t) => s + t.amount, 0) * 100) / 100;

  console.log(`  Found ${transactions.length} transactions, total: $${live_total}`);
  return {
    account_name: accountName,
    period:       startDate.slice(0, 7),
    live_total,
    transactions,
  };
}

// ── Helper: Get last N months date range ─────────────────────────────────────
function getDateRange(months = 12) {
  const end   = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - months);

  const fmt = (d) => d.toISOString().split('T')[0];
  return { startDate: fmt(start), endDate: fmt(end) };
}

module.exports = { getProfitAndLoss, getBalanceSheet, getPayrollSummary, parsePayrollSummary, getDateRange, getTransactionsByAccount };
