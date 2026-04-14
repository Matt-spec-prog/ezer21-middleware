// Cash Flow Statement Generator
//
// Derives the Indirect Method cash flow statement from existing P&L and
// Balance Sheet data. No new QBO API calls — purely derived.
//
// IMPORTANT — account classification strategy:
//   The BalanceSheet SUMMARY entity (from transform.js) already aggregates accounts
//   into QBO group totals (AR, OtherCurrentAssets, FixedAssets, CreditCards,
//   OtherCurrentLiabilities, LongTermLiabilities, etc.). We use those summary
//   fields for the aggregate buckets. This correctly captures accounts like:
//     - Fixed assets: 1510, 1520, 1590 (all in QBO FixedAssets group)
//     - Credit cards: 2410, 2420, 2430, 2440, Central Bill (all in QBO CreditCards group)
//     - Long-term debt: Loans, CN-x, SAFE-x, CS-x (all in QBO LongTermLiabilities group)
//
//   We use FinancialLineItem records only for the specific named accounts that
//   have their own display lines (2010, 2100, 2200, 3400, Opening Balance Equity).
//
// Sign conventions:
//   Assets:      increase USES cash  → negate the balance change
//   Liabilities: increase PROVIDES cash → keep the balance change as-is
//   Equity:      increase PROVIDES cash → keep the balance change as-is

'use strict';

function round2(n) { return Math.round((n || 0) * 100) / 100; }

// Determine if a month is actual or forecast using the 5th-of-month rule:
//   Before the 5th → last month's books aren't final → cutoff = 2 months ago
//   On/after the 5th → last month is closed → cutoff = last month
// This matches the same rule used in sync.js to cap the QBO pull date.
function isActualMonth(year, month) {
  const now            = new Date();
  const closedMonthEnd = now.getDate() < 5
    ? new Date(now.getFullYear(), now.getMonth() - 1, 0) // end of 2 months ago
    : new Date(now.getFullYear(), now.getMonth(), 0);    // end of last month
  const cutoffYear  = closedMonthEnd.getFullYear();
  const cutoffMonth = closedMonthEnd.getMonth() + 1;
  return year < cutoffYear || (year === cutoffYear && month <= cutoffMonth);
}

// ── Main export ───────────────────────────────────────────────────────────────
//
// Parameters:
//   incomeStatements   — IS records (actual + forecast), each with { year, month, period_type, net_income }
//   balanceSheets      — BalanceSheet SUMMARY records (actuals only)
//                        Fields: cash_and_equivalents, accounts_receivable, other_current_assets,
//                        property_equipment_net, other_long_term_assets, intangible_assets,
//                        accounts_payable, accrued_liabilities (=credit cards), short_term_debt
//                        (=OtherCurrentLiabilities), long_term_debt (=LongTermLiabilities)
//   financialLineItems — per-account per-month records (both IS and BS, actual + forecast)
//   companyId          — placeholder ('test-company') remapped by pushToBase44
//
// Returns one CashFlowRecord per month, Sep 2023 → Dec 2027.
// Aug 2023 is the baseline (no prior month), so Sep 2023 is the first record.
function generateCashFlowStatements(incomeStatements, balanceSheets, financialLineItems, companyId) {
  const COMPANY_ID = companyId || 'test-company';

  // ── Index income statements (actual + forecast, skip prior_forecast) ─────
  // Actuals always win: if a month has both an actual and a forecast IS record
  // (which happens when HubSpot deal close dates fall in already-closed months),
  // the actual QBO data must be used — not the forecast-model estimate.
  const isMap = {};
  for (const is of (incomeStatements || [])) {
    if (is.period_type === 'prior_forecast') continue;
    const key = `${is.year}-${is.month}`;
    if (!isMap[key] || is.period_type === 'actual') {
      isMap[key] = is;
    }
  }

  // ── Index BalanceSheet summary records (actuals only) ────────────────────
  const bsMap = {};
  for (const bs of (balanceSheets || [])) {
    bsMap[`${bs.year}-${bs.month}`] = bs;
  }

  // ── Index BS FinancialLineItem records for specific named account lookups ─
  const linesByMonth = {};
  for (const li of (financialLineItems || [])) {
    if (li.statement !== 'balance_sheet') continue;
    if (li.period_type === 'prior_forecast') continue;
    const key = `${li.year}-${li.month}`;
    if (!linesByMonth[key]) linesByMonth[key] = {};
    linesByMonth[key][li.account_name] = (linesByMonth[key][li.account_name] || 0) + li.value;
  }

  // All IS months sorted chronologically (drives iteration for both actual + forecast)
  const allKeys = [...new Set(Object.keys(isMap))].sort((a, b) => {
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return ay !== by ? ay - by : am - bm;
  });

  const results = [];

  // Start at index 1 — index 0 is August 2023, used only as the prior-month baseline
  for (let i = 1; i < allKeys.length; i++) {
    const currKey  = allKeys[i];
    const priorKey = allKeys[i - 1];

    const [year, month] = currKey.split('-').map(Number);
    const period_type   = isActualMonth(year, month) ? 'actual' : 'forecast';
    const period        = `${year}-${String(month).padStart(2, '0')}`;

    const isRec = isMap[currKey];
    if (!isRec) continue;

    const net_income = round2(isRec.net_income || 0);

    // BalanceSheet summary for current and prior month (null for forecast months)
    const cBS = bsMap[currKey]  || null;
    const pBS = bsMap[priorKey] || null;

    // FinancialLineItem maps for specific named account lookups
    const curr  = linesByMonth[currKey]  || {};
    const prior = linesByMonth[priorKey] || {};

    // Helper: delta of a BalanceSheet summary field (0 if BS not available)
    function bsDelta(field) {
      return round2((cBS?.[field] ?? 0) - (pBS?.[field] ?? 0));
    }

    // Helper: sum FLI accounts whose name starts with a given prefix
    function fliPrefix(items, prefix) {
      let total = 0;
      for (const [name, val] of Object.entries(items)) {
        if (name.startsWith(prefix)) total += val;
      }
      return total;
    }

    // ── OPERATING — Asset changes (negate: increase = cash used) ─────────────

    // A/R: BS.accounts_receivable = QBO AR group
    const ar_change = round2(-bsDelta('accounts_receivable'));

    // Inventory: FLI prefix '1200' (1200 Inventory is inside QBO OtherCurrentAssets group)
    const inv_curr  = fliPrefix(curr,  '1200');
    const inv_prior = fliPrefix(prior, '1200');
    const inventory_change = round2(-(inv_curr - inv_prior));

    // Other current assets: derive from BS totals (BS.other_current_assets is not stored
    // as a separate field — we back it out from total_current_assets - cash - AR).
    // Then subtract inventory (already shown on its own line) to get the residual OCA.
    const oca_total_curr  = (cBS?.total_current_assets ?? 0) - (cBS?.cash_and_equivalents ?? 0) - (cBS?.accounts_receivable ?? 0);
    const oca_total_prior = (pBS?.total_current_assets ?? 0) - (pBS?.cash_and_equivalents ?? 0) - (pBS?.accounts_receivable ?? 0);
    const oca_curr  = oca_total_curr  - inv_curr;
    const oca_prior = oca_total_prior - inv_prior;
    const other_current_assets_change = round2(-(oca_curr - oca_prior));

    // Fixed assets: BS.property_equipment_net = QBO FixedAssets group (net of depreciation)
    // Covers 1510 Computing Equipment, 1520 Furniture & Fixtures, 1590 Accumulated Depreciation
    const fixed_assets_change = round2(-bsDelta('property_equipment_net'));

    // Other non-current assets: BS.other_long_term_assets + intangible_assets
    const oa_curr  = (cBS?.other_long_term_assets ?? 0) + (cBS?.intangible_assets ?? 0);
    const oa_prior = (pBS?.other_long_term_assets ?? 0) + (pBS?.intangible_assets ?? 0);
    const other_assets_change = round2(-(oa_curr - oa_prior));

    const total_asset_changes = round2(
      ar_change + inventory_change + other_current_assets_change +
      fixed_assets_change + other_assets_change
    );

    // ── OPERATING — Liability changes (keep sign: increase = cash provided) ──

    // A/P: BS.accounts_payable = QBO AP group
    const ap_change = round2(bsDelta('accounts_payable'));

    // Credit cards: BS.accrued_liabilities = QBO CreditCards group
    // Covers 2410 Credit Card-2791, 2420 Credit Card-9986, 2430 Credit Card-9994,
    //        2440 Central Bill Account-3316
    const credit_card_change = round2(bsDelta('accrued_liabilities'));

    // Interest Payable: FLI prefix '2010'
    const ip_curr  = fliPrefix(curr,  '2010');
    const ip_prior = fliPrefix(prior, '2010');
    const interest_payable_change = round2(ip_curr - ip_prior);

    // Deferred Revenue-OneDose: FLI prefix '2100'
    const dr_curr  = fliPrefix(curr,  '2100');
    const dr_prior = fliPrefix(prior, '2100');
    const deferred_revenue_onedose_change = round2(dr_curr - dr_prior);

    // OneWeight Service Plan Warranty: FLI prefix '2200'
    const wt_curr  = fliPrefix(curr,  '2200');
    const wt_prior = fliPrefix(prior, '2200');
    const oneweight_warranty_change = round2(wt_curr - wt_prior);

    // Other current liabilities: BS.short_term_debt (= QBO OtherCurrentLiabilities group)
    // Covers: 2010 Interest Payable, 2100 Deferred Revenue, 2200 Warranty,
    //         payroll tax payables (Federal/State), 2500 Line of Credit
    // Subtract the explicit items already shown on their own lines above
    const std_delta = bsDelta('short_term_debt');
    const other_current_liabilities_change = round2(
      std_delta - interest_payable_change - deferred_revenue_onedose_change - oneweight_warranty_change
    );

    const total_liability_changes = round2(
      ap_change + credit_card_change + interest_payable_change +
      deferred_revenue_onedose_change + oneweight_warranty_change +
      other_current_liabilities_change
    );

    const balance_sheet_check = round2(total_asset_changes + total_liability_changes);
    const net_cash_operating  = round2(net_income + total_asset_changes + total_liability_changes);

    // ── FINANCING ─────────────────────────────────────────────────────────────

    // Long-term debt: BS.long_term_debt = QBO LongTermLiabilities group
    // Covers: Loan - MC Elsbernd, Loan - MN Growth Loan Fund, Loan - T Hazlett,
    //         Loan USBank (4683), CN Accrued Interest, CN-1 through CN-4
    // NOTE: CS-04 through CS-7 and SAFE-1 through SAFE-19 are in QBO's Equity
    //       group — they are captured via equity_residual below, not here.
    const long_term_debt_change = round2(bsDelta('long_term_debt'));

    // APIC: FLI prefix '3400'
    const apic_curr  = fliPrefix(curr,  '3400');
    const apic_prior = fliPrefix(prior, '3400');
    const apic_stock_options_change = round2(apic_curr - apic_prior);

    // Opening Balance Equity FLI (exact name match)
    const obe_fli_curr  = curr['Opening Balance Equity']  ?? 0;
    const obe_fli_prior = prior['Opening Balance Equity'] ?? 0;
    const obe_fli_change = round2(obe_fli_curr - obe_fli_prior);

    // Equity residual: captures CS-/SAFE- and any other equity-classified instruments
    // that QBO puts in the Equity group (not LongTermLiabilities).
    // total_equity_delta = net_income + ΔAPIC + ΔOBE_FLI + ΔCS/SAFE/other
    // ⟹ residual = total_equity_delta − net_income − ΔAPIC − ΔOBE_FLI
    const total_equity_delta = bsDelta('total_equity');
    const equity_residual = (cBS && pBS)
      ? round2(total_equity_delta - net_income - apic_stock_options_change - obe_fli_change)
      : 0;

    // opening_balance_equity_change now represents OBE + all equity financing (CS/SAFE/etc.)
    const opening_balance_equity_change = round2(obe_fli_change + equity_residual);

    const net_cash_financing = round2(long_term_debt_change + apic_stock_options_change + opening_balance_equity_change);

    const net_cash_change = round2(net_cash_operating + net_cash_financing);

    // ── VERIFICATION ──────────────────────────────────────────────────────────
    // net_cash_change should ≈ change in cash account on Balance Sheet.
    // Residual variance is mainly the year-end retained earnings sweep (January only).
    let actual_cash_change = null;
    let cash_variance      = null;
    if (cBS && pBS) {
      actual_cash_change = round2((cBS.cash_and_equivalents || 0) - (pBS.cash_and_equivalents || 0));
      cash_variance      = round2(net_cash_change - actual_cash_change);
      if (Math.abs(cash_variance) > 1) {
        console.warn(`  [CashFlow] Variance ${period}: calculated $${net_cash_change.toFixed(2)}, actual Δcash $${actual_cash_change.toFixed(2)}, diff $${cash_variance.toFixed(2)}`);
      }
    }

    results.push({
      company_id: COMPANY_ID,
      period,
      year,
      month,
      period_type,

      net_income,

      accounts_receivable_change:          ar_change,
      inventory_change,
      other_current_assets_change,
      fixed_assets_change,
      other_assets_change,
      total_asset_changes,

      accounts_payable_change:             ap_change,
      credit_card_change,
      interest_payable_change,
      deferred_revenue_onedose_change,
      oneweight_warranty_change,
      other_current_liabilities_change,
      total_liability_changes,

      balance_sheet_check,
      net_cash_operating,

      long_term_debt_change,
      apic_stock_options_change,
      opening_balance_equity_change,
      net_cash_financing,

      net_cash_change,
      actual_cash_change,
      cash_variance,
    });
  }

  console.log(`  CashFlow: generated ${results.length} records (${results.filter(r => r.period_type === 'actual').length} actual, ${results.filter(r => r.period_type === 'forecast').length} forecast)`);
  return results;
}

module.exports = { generateCashFlowStatements };
