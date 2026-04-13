// Cash Flow Statement Generator
//
// Derives the Indirect Method cash flow statement from existing P&L and
// Balance Sheet data. No new QBO API calls — this is purely derived.
//
// Sections:
//   Operating Activities: Net Income + changes in working capital accounts
//   Financing Activities: changes in long-term debt + equity accounts
//   Summary: Net Cash Change for Period
//
// Sign conventions:
//   Assets:      increase USES cash → negate the balance change
//   Liabilities: increase PROVIDES cash → keep the balance change as-is
//   Equity:      increase PROVIDES cash → keep the balance change as-is
//
// Account classification uses numeric prefixes on QBO account names:
//   1000–1099  Cash / bank accounts (excluded — this is what we solve for)
//   1100       Accounts Receivable
//   1200       Inventory
//   1300–1499  Other current assets
//   1500       Fixed assets
//   1600–1999  Other (non-current) assets
//   2000       Accounts Payable
//   2010       Interest Payable
//   2100       Deferred Revenue-OneDose
//   2200       OneWeight Service Plan Warranty
//   2300–2399, 2500–2599  Other current liabilities
//   2400       Credit Card
//   2600–2999  Long-term debt
//   3400       APIC - Stock Options
//   "Opening Balance Equity"  (exact name match)

'use strict';

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// Extract the leading account number from a QBO account name (e.g., "1100 A/R" → 1100)
function getAcctNum(name) {
  const m = (name || '').match(/^(\d+)/);
  return m ? parseInt(m[1]) : null;
}

// Determine if a month is actual (≤ last day of last month) or forecast
function isActualMonth(year, month) {
  const now          = new Date();
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const cutoffYear   = lastMonthEnd.getFullYear();
  const cutoffMonth  = lastMonthEnd.getMonth() + 1;
  return year < cutoffYear || (year === cutoffYear && month <= cutoffMonth);
}

// ── Main export ───────────────────────────────────────────────────────────────

// Parameters:
//   incomeStatements   — IS records (actual + forecast), each with { year, month, period_type, net_income }
//   balanceSheets      — BalanceSheet summary records (actuals only), each with { year, month, cash_and_equivalents }
//   financialLineItems — per-account, per-month records, each with { statement, account_name, year, month, period_type, value }
//   companyId          — placeholder (e.g. 'test-company') remapped by pushToBase44
//
// Returns an array of CashFlowStatement records, Sep 2023 → Dec 2027.
// August 2023 is the baseline month (no prior month for changes), so Sep 2023 is first.
function generateCashFlowStatements(incomeStatements, balanceSheets, financialLineItems, companyId) {
  const COMPANY_ID = companyId || 'test-company';

  // ── Index income statements by 'YYYY-M' ──────────────────────────────────────
  // Keep both actual and forecast IS, skip prior_forecast
  const isMap = {};
  for (const is of (incomeStatements || [])) {
    if (is.period_type === 'prior_forecast') continue;
    const key = `${is.year}-${is.month}`;
    isMap[key] = is;
  }

  // ── Index balance sheet summaries by 'YYYY-M' ─────────────────────────────────
  // Only actuals exist; used for the cash verification check
  const bsMap = {};
  for (const bs of (balanceSheets || [])) {
    const key = `${bs.year}-${bs.month}`;
    bsMap[key] = bs;
  }

  // ── Index balance sheet line items by month → accountName → value ─────────────
  // Only balance_sheet statement rows, exclude prior_forecast
  const linesByMonth = {};
  for (const li of (financialLineItems || [])) {
    if (li.statement !== 'balance_sheet') continue;
    if (li.period_type === 'prior_forecast') continue;
    const key = `${li.year}-${li.month}`;
    if (!linesByMonth[key]) linesByMonth[key] = {};
    // Accumulate (there shouldn't be duplicates, but guard anyway)
    linesByMonth[key][li.account_name] = (linesByMonth[key][li.account_name] || 0) + li.value;
  }

  // ── All month keys sorted chronologically ─────────────────────────────────────
  // Drive iteration from IS months so forecast months are included
  const allKeys = [...new Set(Object.keys(isMap))].sort((a, b) => {
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return ay !== by ? ay - by : am - bm;
  });

  // ── Helpers for account lookup in a month's line item map ─────────────────────

  // Sum all accounts in 'items' whose leading number falls in [low, high] inclusive
  function sumRange(items, low, high) {
    let total = 0;
    for (const [name, val] of Object.entries(items)) {
      const num = getAcctNum(name);
      if (num !== null && num >= low && num <= high) total += val;
    }
    return total;
  }

  // Sum all accounts matching a specific string prefix (e.g., '1100')
  function sumPrefix(items, prefix) {
    let total = 0;
    for (const [name, val] of Object.entries(items)) {
      if (name.startsWith(prefix)) total += val;
    }
    return total;
  }

  // ── Main loop ─────────────────────────────────────────────────────────────────
  const results = [];

  // Start at index 1 — index 0 is August 2023, the baseline month
  for (let i = 1; i < allKeys.length; i++) {
    const currKey  = allKeys[i];
    const priorKey = allKeys[i - 1];

    const [year, month] = currKey.split('-').map(Number);
    const period_type   = isActualMonth(year, month) ? 'actual' : 'forecast';

    const isRec = isMap[currKey];
    if (!isRec) continue; // no IS data for this month — skip

    const net_income = round2(isRec.net_income || 0);

    const curr  = linesByMonth[currKey]  || {};
    const prior = linesByMonth[priorKey] || {};
    const currBS  = bsMap[currKey];
    const priorBS = bsMap[priorKey];

    // ── Changes in specific balance sheet accounts ─────────────────────────────
    // For assets: negate the raw change (increase = cash used)
    // For liabilities/equity: keep the raw change (increase = cash provided)

    // OPERATING — Asset changes
    const ar_change                  = round2(-(sumPrefix(curr, '1100') - sumPrefix(prior, '1100')));
    const inventory_change           = round2(-(sumPrefix(curr, '1200') - sumPrefix(prior, '1200')));
    const other_current_assets_change = round2(-(sumRange(curr, 1300, 1499) - sumRange(prior, 1300, 1499)));
    const fixed_assets_change        = round2(-(sumPrefix(curr, '1500') - sumPrefix(prior, '1500')));
    const other_assets_change        = round2(-(sumRange(curr, 1600, 1999) - sumRange(prior, 1600, 1999)));

    const total_asset_changes = round2(
      ar_change + inventory_change + other_current_assets_change +
      fixed_assets_change + other_assets_change
    );

    // OPERATING — Liability changes
    const ap_change                    = round2(sumPrefix(curr, '2000') - sumPrefix(prior, '2000'));
    const interest_payable_change      = round2(sumPrefix(curr, '2010') - sumPrefix(prior, '2010'));
    const deferred_revenue_change      = round2(sumPrefix(curr, '2100') - sumPrefix(prior, '2100'));
    const oneweight_warranty_change    = round2(sumPrefix(curr, '2200') - sumPrefix(prior, '2200'));
    const credit_card_change           = round2(sumPrefix(curr, '2400') - sumPrefix(prior, '2400'));

    // Other current liabilities: 2300–2399 and 2500–2599 (excluding 2400 credit card)
    const other_current_liabilities_change = round2(
      (sumRange(curr, 2300, 2399) - sumRange(prior, 2300, 2399)) +
      (sumRange(curr, 2500, 2599) - sumRange(prior, 2500, 2599))
    );

    const total_liability_changes = round2(
      ap_change + credit_card_change + interest_payable_change +
      deferred_revenue_change + oneweight_warranty_change +
      other_current_liabilities_change
    );

    const balance_sheet_check = round2(total_asset_changes + total_liability_changes);
    const net_cash_operating  = round2(net_income + total_asset_changes + total_liability_changes);

    // FINANCING — Long-term debt and equity changes
    const long_term_debt_change          = round2(sumRange(curr, 2600, 2999) - sumRange(prior, 2600, 2999));
    const apic_stock_options_change      = round2(sumPrefix(curr, '3400') - sumPrefix(prior, '3400'));

    const obe_curr  = curr['Opening Balance Equity']  || 0;
    const obe_prior = prior['Opening Balance Equity'] || 0;
    const opening_balance_equity_change  = round2(obe_curr - obe_prior);

    const net_cash_financing = round2(long_term_debt_change + apic_stock_options_change + opening_balance_equity_change);

    const net_cash_change = round2(net_cash_operating + net_cash_financing);

    // VERIFICATION — Compare calculated net cash to actual change in cash account balance
    let actual_cash_change = null;
    let cash_variance      = null;
    if (currBS && priorBS) {
      actual_cash_change = round2((currBS.cash_and_equivalents || 0) - (priorBS.cash_and_equivalents || 0));
      cash_variance      = round2(net_cash_change - actual_cash_change);
      if (Math.abs(cash_variance) > 1) {
        console.warn(`  [CashFlow] Variance ${currKey}: calculated $${net_cash_change}, actual change $${actual_cash_change}, diff $${cash_variance}`);
      }
    }

    results.push({
      company_id: COMPANY_ID,
      period:     currKey,
      year,
      month,
      period_type,

      net_income,

      // Operating — Asset changes
      accounts_receivable_change:   ar_change,
      inventory_change,
      other_current_assets_change,
      fixed_assets_change,
      other_assets_change,
      total_asset_changes,

      // Operating — Liability changes
      accounts_payable_change:              ap_change,
      credit_card_change,
      interest_payable_change,
      deferred_revenue_onedose_change:      deferred_revenue_change,
      oneweight_warranty_change,
      other_current_liabilities_change,
      total_liability_changes,

      // Operating totals
      balance_sheet_check,
      net_cash_operating,

      // Financing
      long_term_debt_change,
      apic_stock_options_change,
      opening_balance_equity_change,
      net_cash_financing,

      // Summary
      net_cash_change,

      // Verification (null for forecast months where no actual BS exists)
      actual_cash_change,
      cash_variance,
    });
  }

  console.log(`  CashFlow: generated ${results.length} records (${results.filter(r => r.period_type === 'actual').length} actual, ${results.filter(r => r.period_type === 'forecast').length} forecast)`);
  return results;
}

module.exports = { generateCashFlowStatements };
