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
// Uses the QBO GeneralLedger report, which organises entries by account.
// TransactionList's `account` param filters by the bank/cash account side of a
// transaction — all P&L accounts flow through the same checking account so it
// returns the entire company ledger regardless of which account was requested.
// GeneralLedger correctly shows only entries posted to the requested account.
async function getTransactionsByAccount(accountName, startDate, endDate) {
  const tokens  = await getTokens();
  const realmId = tokens.realm_id;

  // Note: the GL report does not reliably support an `account` filter param —
  // passing it causes a 400 on some QBO accounts. Fetch the full month GL and
  // find the right section by name.
  const params = new URLSearchParams({
    start_date: startDate,
    end_date:   endDate,
  });

  console.log(`Pulling GeneralLedger for "${accountName}" (${startDate} → ${endDate})...`);

  let data;
  try {
    data = await qboRequest(
      `/v3/company/${realmId}/reports/GeneralLedger?${params.toString()}`
    );
  } catch (err) {
    if (err.response?.status === 400 || err.response?.status === 404) {
      return { account_name: accountName, period: startDate.slice(0, 7), transactions: [], live_total: 0, error: 'account_not_found' };
    }
    throw err;
  }

  // Build column index from report headers
  const columns = data?.Header?.Columns?.Column || data?.Columns?.Column || [];
  const colIdx  = {};
  columns.forEach((col, i) => {
    if (col.ColType)  colIdx[col.ColType]  = i;
    if (col.ColTitle) colIdx[col.ColTitle] = i;
  });
  console.log(`GL columns for "${accountName}":`, JSON.stringify(columns.map(c => ({ ColType: c.ColType, ColTitle: c.ColTitle }))));
  console.log(`GL top-level section headers:`, (data?.Rows?.Row || []).filter(r => r.type === 'Section').slice(0, 5).map(r => r.Header?.ColData?.[0]?.value));

  // GL report column positions.
  // QBO GL uses a single 'subt_nat_amount' column (ColTitle "Amount") for the
  // net posting amount — positive = debit (expense/asset increase), negative =
  // credit. There is no separate credit column in this GL variant.
  const idx = {
    date:   colIdx['tx_date']         ?? colIdx['Date']             ?? 0,
    type:   colIdx['txn_type']        ?? colIdx['Transaction Type'] ?? 1,
    doc:    colIdx['doc_num']         ?? colIdx['Num']              ?? 2,
    name:   colIdx['name']            ?? colIdx['Name']             ?? 4,
    memo:   colIdx['memo']            ?? colIdx['Memo/Description'] ?? 5,
    // The net amount column — subt_nat_amount is the standard ColType in QBO GL
    amount: colIdx['subt_nat_amount'] ?? colIdx['Amount']           ?? colIdx['amount'] ?? 7,
  };

  // GL response is a set of Section rows, one per account.
  // Find the section whose header exactly matches accountName.
  const rows = data?.Rows?.Row || [];
  const transactions = [];
  let foundAccount   = false;

  // Log all section headers for debugging
  const allHeaders = [];
  function collectHeaders(sectionRows, depth) {
    for (const r of sectionRows) {
      if (r.type === 'Section') {
        allHeaders.push('  '.repeat(depth) + (r.Header?.ColData?.[0]?.value || ''));
        if (r.Rows?.Row) collectHeaders(r.Rows.Row, depth + 1);
      }
    }
  }
  collectHeaders(rows, 0);
  console.log(`GL all section headers (${allHeaders.length}):`, allHeaders.join(' | '));

  function parseAmount(cols) {
    return parseFloat(cols[idx.amount]?.value) || 0;
  }

  function collectRows(sectionRows) {
    for (const row of sectionRows) {
      if (!row.ColData || row.type === 'Section') continue;
      const cols    = row.ColData;
      const dateVal = cols[idx.date]?.value || '';
      if (!dateVal) continue;
      transactions.push({
        date:             dateVal,
        type:             cols[idx.type]?.value || '',
        doc_number:       cols[idx.doc]?.value  || '',
        vendor_or_entity: cols[idx.name]?.value || '',
        memo:             cols[idx.memo]?.value || '',
        amount:           parseAmount(cols),
      });
    }
  }

  function searchSections(sectionRows) {
    for (const row of sectionRows) {
      if (row.type !== 'Section') continue;
      const header = row.Header?.ColData?.[0]?.value || '';

      // Match exact name, or header contains our name, or our name contains the
      // header's name-part (strip leading account number for looser matching).
      const headerName = header.replace(/^\d+\s+/, '');
      if (
        header === accountName ||
        header.includes(accountName) ||
        accountName.includes(headerName)
      ) {
        foundAccount = true;
        const innerRows = row.Rows?.Row || [];
        console.log(`GL matched section "${header}": ${innerRows.length} inner rows, first row keys:`, innerRows[0] ? Object.keys(innerRows[0]) : 'none');
        if (innerRows[0]) console.log(`GL first inner row sample:`, JSON.stringify(innerRows[0]).slice(0, 300));
        collectRows(innerRows);
        return true;
      }

      // Recurse — QBO sometimes nests accounts under parent group sections
      if (row.Rows?.Row && searchSections(row.Rows.Row)) return true;
    }
    return false;
  }

  searchSections(rows);

  // Fallback: if QBO returned flat Data rows with a date value at idx.date,
  // process them directly (can happen when GL is pre-filtered server-side).
  if (!foundAccount) {
    const flatRows = rows.filter(r => r.ColData && r.type !== 'Section' && r.ColData[idx.date]?.value);
    if (flatRows.length > 0) {
      foundAccount = true;
      collectRows(flatRows);
    }
  }

  if (!foundAccount) {
    return { account_name: accountName, period: startDate.slice(0, 7), transactions: [], live_total: 0, error: 'account_not_found' };
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
