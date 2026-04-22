// Drill-Down Route
//
// GET /api/drilldown?account=ACCOUNT_NAME&month=YYYY-MM[&statement=balance_sheet]
//
// Income statement accounts (default, statement omitted or 'income_statement'):
//   Actual months: pulls live transactions from QBO + compares to last synced value.
//   Forecast months: returns the forecast rule explanation + stored forecast value.
//
// Balance sheet accounts (statement=balance_sheet):
//   Always actual — shows transactions (activity) for the month + the stored
//   ending balance. No forecast variant exists for balance sheet accounts.
//
// "Actual" = month is on or before the last day of last month (same cutoff
//   as the sync endpoint). "Forecast" = anything after that.

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const { getTransactionsByAccount } = require('../services/qbo');
const { getForecastExplanation }   = require('../services/drilldown');
const storage  = require('../services/storage');

const BASE44_BASE  = 'https://base44.app/api';
const BASE44_APP_ID  = process.env.BASE44_APP_ID  || '69af0abd25154e7bfda8378a';
const BASE44_COMPANY = process.env.BASE44_COMPANY_ID || '69cd6288f1b9adf4f7eeb809';

// Accounts that exist only in the forecast (split from a single QBO account).
// Clicking these in an actual month should explain the mapping, not fail.
const FORECAST_ONLY_ACCOUNTS = new Set([
  '4000 OneDose Software Revenue - New',
  '4000 OneDose Software Revenue - Renewal',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns true if year/month is an actual (≤ last day of last month).
function isActualMonth(year, month) {
  const now          = new Date();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const cutoffYear   = lastMonthEnd.getFullYear();
  const cutoffMonth  = lastMonthEnd.getMonth() + 1;
  return year < cutoffYear || (year === cutoffYear && month <= cutoffMonth);
}

// Last day of a given month as "YYYY-MM-DD".
function lastDayOf(year, month) {
  return new Date(year, month, 0).toISOString().split('T')[0];
}

// Query a Base44 entity with filters. Returns the items array.
async function queryBase44(entityName, query) {
  const tokenData = await storage.getBase44Token();
  const token     = tokenData?.access_token || tokenData;
  if (!token) throw new Error('Base44 token not available.');

  const res = await axios.get(`${BASE44_BASE}/apps/${BASE44_APP_ID}/entities/${entityName}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-App-Id':    BASE44_APP_ID,
    },
    params: { q: JSON.stringify(query), limit: 10 },
    timeout: 15_000,
  });

  const data = res.data;
  return Array.isArray(data) ? data : (data?.items || data?.data || []);
}

// ── GET /api/drilldown ────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { account, month, statement } = req.query;
  const isBalanceSheet = statement === 'balance_sheet';

  // ── Validate params ─────────────────────────────────────────────────────────
  if (!account || !month) {
    return res.status(400).json({ error: 'missing_params', message: 'Both "account" and "month" (YYYY-MM) query parameters are required.' });
  }
  const monthMatch = month.match(/^(\d{4})-(\d{2})$/);
  if (!monthMatch) {
    return res.status(400).json({ error: 'invalid_month', message: 'Month must be in YYYY-MM format (e.g. 2026-03).' });
  }

  const year      = parseInt(monthMatch[1], 10);
  const monthNum  = parseInt(monthMatch[2], 10);
  const startDate = `${year}-${String(monthNum).padStart(2, '0')}-01`;
  const endDate   = lastDayOf(year, monthNum);
  const isActual  = isActualMonth(year, monthNum);

  try {

    // ── BALANCE SHEET ACCOUNT ─────────────────────────────────────────────────
    if (isBalanceSheet) {

      // Forecast BS month: return rule explanation + stored forecast value
      if (!isActual) {
        const explanation = getForecastExplanation(account, 'balance_sheet');

        let forecastValue = null;
        try {
          const items = await queryBase44('FinancialLineItem', {
            company_id:   BASE44_COMPANY,
            period_type:  'forecast',
            statement:    'balance_sheet',
            account_name: account,
            year,
            month:        monthNum,
          });
          if (items.length > 0) forecastValue = items[0].value ?? null;
        } catch (e) {
          console.warn('Could not fetch forecast BS value from Base44:', e.message);
        }

        return res.json({
          period_type:    'forecast',
          statement:      'balance_sheet',
          account_name:   account,
          period:         month,
          forecast_value: forecastValue,
          ...explanation,
        });
      }

      // Actual BS month: pull live transactions from QBO.
      // Transactions show the month's activity; synced_balance is the ending balance.
      // These are different things — no variance warning is shown.
      let qboResult;
      try {
        qboResult = await getTransactionsByAccount(account, startDate, endDate);
      } catch (err) {
        if (err.response?.status === 401 || err.response?.status === 403) {
          return res.status(401).json({
            error:   'qbo_auth_expired',
            message: 'QuickBooks connection needs to be re-authenticated. Visit /api/auth/connect to reconnect.',
          });
        }
        if (err.response?.status === 429) {
          return res.status(429).json({
            error:   'qbo_rate_limited',
            message: 'QuickBooks API rate limit hit. Please try again in a moment.',
          });
        }
        throw err;
      }

      if (qboResult.error === 'account_not_found') {
        return res.json({
          period_type:  'balance_sheet',
          account_name: account,
          period:       month,
          error:        'account_not_found',
          message:      `"${account}" was not found in QuickBooks for this period. The account name may not match exactly.`,
        });
      }

      // Fetch the stored ending balance from Base44
      let syncedBalance = null;
      try {
        const items = await queryBase44('FinancialLineItem', {
          company_id:   BASE44_COMPANY,
          statement:    'balance_sheet',
          account_name: account,
          year,
          month:        monthNum,
        });
        if (items.length > 0) syncedBalance = items[0].value ?? null;
      } catch (e) {
        console.warn('Could not fetch synced balance from Base44:', e.message);
      }

      return res.json({
        period_type:       'balance_sheet',
        account_name:      account,
        period:            month,
        synced_balance:    syncedBalance,
        transaction_net:   qboResult.live_total,
        transactions:      qboResult.transactions,
      });
    }

    // ── INCOME STATEMENT — ACTUAL MONTH ───────────────────────────────────────
    if (isActual) {

      // Forecast-only accounts (split in our model, combined in QBO) can't be
      // drilled into directly — explain the mapping instead.
      if (FORECAST_ONLY_ACCOUNTS.has(account)) {
        return res.json({
          period_type:  'actual',
          account_name: account,
          period:       month,
          error:        'account_not_found',
          message:      `"${account}" is a forecast-only split of "4000 OneDose Software Revenue" in QuickBooks. In actuals, both new and renewal revenue appear under the single QBO account. Use the drill-down on "4000 OneDose Software Revenue" to see the underlying transactions.`,
        });
      }

      // Pull live transactions from QBO
      let qboResult;
      try {
        qboResult = await getTransactionsByAccount(account, startDate, endDate);
      } catch (err) {
        if (err.response?.status === 401 || err.response?.status === 403) {
          return res.status(401).json({
            error:   'qbo_auth_expired',
            message: 'QuickBooks connection needs to be re-authenticated. Visit /api/auth/connect to reconnect.',
          });
        }
        if (err.response?.status === 429) {
          return res.status(429).json({
            error:   'qbo_rate_limited',
            message: 'QuickBooks API rate limit hit. Please try again in a moment.',
          });
        }
        throw err;
      }

      if (qboResult.error === 'account_not_found') {
        return res.json({
          period_type:  'actual',
          account_name: account,
          period:       month,
          error:        'account_not_found',
          message:      `"${account}" was not found in QuickBooks for this period. It may be a forecast-only account or the account name may not match exactly.`,
        });
      }

      // Fetch the synced total from Base44 for comparison
      let syncedTotal = null;
      try {
        const items = await queryBase44('FinancialLineItem', {
          company_id:   BASE44_COMPANY,
          period_type:  'actual',
          account_name: account,
          year,
          month:        monthNum,
        });
        if (items.length > 0) syncedTotal = items[0].value ?? null;
      } catch (e) {
        console.warn('Could not fetch synced total from Base44:', e.message);
      }

      const liveTotal   = qboResult.live_total;
      const hasVariance = syncedTotal !== null && Math.abs(liveTotal - syncedTotal) > 0.01;

      return res.json({
        period_type:      'actual',
        account_name:     account,
        period:           month,
        synced_total:     syncedTotal,
        live_total:       liveTotal,
        has_variance:     hasVariance,
        variance_message: hasVariance
          ? `QBO currently shows $${liveTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} for this account, but the last sync recorded $${syncedTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}. Hit Sync Now to update.`
          : null,
        transactions: qboResult.transactions,
      });
    }

    // ── INCOME STATEMENT — FORECAST MONTH ────────────────────────────────────
    const explanation = getForecastExplanation(account);

    if (!explanation) {
      return res.json({
        period_type:  'forecast',
        account_name: account,
        period:       month,
        error:        'no_forecast',
        message:      `"${account}" does not have a forecast rule — it is excluded from the forecast model.`,
      });
    }

    // Fetch the stored forecast value from Base44
    let forecastValue = null;
    try {
      const items = await queryBase44('FinancialLineItem', {
        company_id:   BASE44_COMPANY,
        period_type:  'forecast',
        account_name: account,
        year,
        month:        monthNum,
      });
      if (items.length > 0) forecastValue = items[0].value ?? null;
    } catch (e) {
      console.warn('Could not fetch forecast value from Base44:', e.message);
    }

    return res.json({
      period_type:    'forecast',
      account_name:   account,
      period:         month,
      forecast_value: forecastValue,
      ...explanation,
    });

  } catch (err) {
    console.error('Drilldown error:', err.message);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

module.exports = router;
