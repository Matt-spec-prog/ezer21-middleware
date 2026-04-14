// Account-Level Forecast Generator
//
// Builds a 12-month+ P&L forecast for Hinckley Medical (OneDose / OneWeight).
//
// Revenue is driven by HubSpot pipeline (amount × deal stage probability).
// Every other P&L account has its own rule — see the ACCOUNT RULES section below.
//
// Rolling lookback logic:
//   Month 1  → uses last N actual months
//   Month 2  → uses last (N-1) actual months + month 1 forecast
//   Month 3  → uses last (N-2) actual months + months 1-2 forecast
//   ...and so on. Prior forecast months are treated as actuals for the lookback.
//
// Account names are configured in services/accountMap.js.
// Update that file once QBO production is connected and real account names are known.

const { readPipelineForecast } = require('./hubspot');
const ACCT = require('./accountMap');

// ── Math helpers ───────────────────────────────────────────────────────────────

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function addMonths(year, month, n) {
  const total = (year * 12 + (month - 1)) + n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function subtractMonths(year, month, n) { return addMonths(year, month, -n); }

function monthKey(year, month) { return `${year}-${month}`; }

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthLabel(year, month) { return `${MONTH_NAMES[month - 1]} ${year}`; }

// ── Data indexes ───────────────────────────────────────────────────────────────

// Build lookup: { accountName: { 'YYYY-M': value } }
function buildLineItemIndex(financialLineItems) {
  const idx = {};
  for (const item of (financialLineItems || [])) {
    if (item.period_type !== 'actual') continue;
    if (!idx[item.account_name]) idx[item.account_name] = {};
    const key = monthKey(item.year, item.month);
    idx[item.account_name][key] = (idx[item.account_name][key] || 0) + item.value;
  }
  return idx;
}

// Build lookup: { 'YYYY-M': revenue } from actual IncomeStatements
function buildRevenueIndex(incomeStatements) {
  const idx = {};
  for (const is of (incomeStatements || [])) {
    idx[monthKey(is.year, is.month)] = is.revenue;
  }
  return idx;
}

// Sort actual IS records chronologically, keeping only active months
function getActiveActualMonths(incomeStatements) {
  return [...(incomeStatements || [])]
    .filter(m => m.revenue > 0 || m.net_income !== 0)
    .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
}

// ── Lookback helpers ───────────────────────────────────────────────────────────

// Get an account's value for a specific month.
// Prefers forecastLineIdx (prior forecast months) over actualLineIdx (QBO actuals).
function getLineValue(accountName, year, month, actualLineIdx, forecastLineIdx) {
  const key = monthKey(year, month);
  return forecastLineIdx[accountName]?.[key] ?? actualLineIdx[accountName]?.[key] ?? 0;
}

// Get total revenue for a month (actual or prior forecast).
function getRevenue(year, month, actualRevenueIdx, forecastRevenueIdx) {
  const key = monthKey(year, month);
  return forecastRevenueIdx[key] ?? actualRevenueIdx[key] ?? 0;
}

// Get OneWeight revenue for a month (actual or prior forecast).
function getOneWeightRevenue(year, month, actualLineIdx, forecastLineIdx) {
  return getLineValue(ACCT.ONEWEIGHT_REVENUE, year, month, actualLineIdx, forecastLineIdx);
}

// Find the most recent non-zero actual value for an account.
// Used for straightline ("last actual month held flat") accounts.
function getLastActual(accountName, actualMonths, actualLineIdx) {
  for (let i = actualMonths.length - 1; i >= 0; i--) {
    const { year, month } = actualMonths[i];
    const val = actualLineIdx[accountName]?.[monthKey(year, month)];
    if (val != null && val !== 0) return val;
  }
  return 0;
}

// Rolling average of (account / totalRevenue) over the last N months.
// Used for discounts, installation & training, cloud hosting.
function rollingPctOfRevenue(accountName, year, month, lookback, actualLineIdx, forecastLineIdx, actualRevenueIdx, forecastRevenueIdx) {
  const ratios = [];
  for (let i = 1; i <= lookback; i++) {
    const { year: y, month: m } = subtractMonths(year, month, i);
    const num = getLineValue(accountName, y, m, actualLineIdx, forecastLineIdx);
    const den = getRevenue(y, m, actualRevenueIdx, forecastRevenueIdx);
    if (den !== 0) ratios.push(num / den);
  }
  return avg(ratios);
}

// Rolling average of (account / OneWeight revenue) over the last N months.
// Used for supplies & materials, shipping & freight.
function rollingPctOfOneWeight(accountName, year, month, lookback, actualLineIdx, forecastLineIdx) {
  const ratios = [];
  for (let i = 1; i <= lookback; i++) {
    const { year: y, month: m } = subtractMonths(year, month, i);
    const num = getLineValue(accountName, y, m, actualLineIdx, forecastLineIdx);
    const den = getOneWeightRevenue(y, m, actualLineIdx, forecastLineIdx);
    if (den !== 0) ratios.push(num / den);
  }
  return avg(ratios);
}

// ── Insurance formula ──────────────────────────────────────────────────────────
// Three vendors averaged to a monthly rate:
//   GL liability:  $1,148.66 / 12  = $95.72/month
//   Monthly policy: $718.83/month
//   D&O:           $451 / 4 months = $112.75/month
//   Total:          ~$927.30/month
function calcInsuranceMonthly(assumptions) {
  const gl      = (assumptions.insurance_general_liability_annual || 1148.66) / 12;
  const monthly = assumptions.insurance_monthly_premium          || 718.83;
  const doAmt   = assumptions.insurance_do_per_period            || 451;
  const doFreq  = assumptions.insurance_do_payment_months        || 4;
  return gl + monthly + (doAmt / doFreq);
}

// ── ForecastAssumptions defaults ───────────────────────────────────────────────
// These mirror the ForecastAssumptions entity defaults.
// The forecast runs with these values. Clients can override in Base44 —
// that feature will re-trigger the forecast with updated assumptions.
function defaultAssumptions() {
  return {
    commissions_rate:                      0.15,
    onedose_amortization_months:           12,
    discounts_lookback_months:             3,
    installation_training_lookback_months: 3,
    supplies_materials_lookback_months:    8,
    shipping_freight_lookback_months:      12,
    fte_count:                             14,
    engineer_count:                        3,
    workforce_mgmt_per_fte:                178,
    professional_services_monthly:         8000,
    travel_monthly:                        15000,
    meals_monthly:                         4000,
    bank_charges_monthly:                  500,
    office_supplies_monthly:               2000,
    general_advertising_monthly:           1000,
    tradeshow_yoy_growth_rate:             0.10,
    insurance_general_liability_annual:    1148.66,
    insurance_monthly_premium:             718.83,
    insurance_do_per_period:               451,
    insurance_do_payment_months:           4,
    interest_rate_annual:                  0.025,
    // Override fields (null = not overridden → use calculated value)
    software_it_monthly_override:          null,
    rent_utilities_monthly_override:       null,
    marketing_ps_monthly_override:         null,
    depreciation_monthly_override:         null,
    interest_expense_monthly_override:     null,
    cloud_hosting_pct_override:            null,
  };
}

// ── Per-account forecast evaluator ────────────────────────────────────────────
// Returns the forecast dollar value for one account in one month.
// Returns null for accounts with no forecast (they are omitted from output).
function forecastAccount(accountName, ctx) {
  const {
    year, month,
    pipeline,              // { onedose_new, onedose_renewal, oneweight, total }
    grossHubSpotRevenue,   // onedose_new + onedose_renewal + oneweight (before discounts)
    actualMonths,
    actualLineIdx,
    forecastLineIdx,
    actualRevenueIdx,
    forecastRevenueIdx,
    runningCash,
    assumptions,
    payrollTotals,         // { wages, benefits, employer_taxes } from QBO PayrollSummary, or null
  } = ctx;

  const asmp = assumptions;

  // ── Revenue ────────────────────────────────────────────────────────────────
  if (accountName === ACCT.SUBSCRIPTION_REVENUE) return round2(pipeline.onedose_new);
  if (accountName === ACCT.RENEWAL_REVENUE)       return round2(pipeline.onedose_renewal);
  if (accountName === ACCT.ONEWEIGHT_REVENUE)     return round2(pipeline.oneweight);

  if (accountName === ACCT.DISCOUNTS) {
    // Rolling N-month avg % of total revenue — negative value (reduces revenue)
    const pct = rollingPctOfRevenue(
      ACCT.DISCOUNTS, year, month,
      asmp.discounts_lookback_months,
      actualLineIdx, forecastLineIdx,
      actualRevenueIdx, forecastRevenueIdx
    );
    // Apply same % to current gross revenue. If no history, returns 0.
    return round2(pct * grossHubSpotRevenue);
  }

  if (accountName === ACCT.INSTALLATION_TRAINING) {
    // Rolling N-month avg % of total revenue
    const pct = rollingPctOfRevenue(
      ACCT.INSTALLATION_TRAINING, year, month,
      asmp.installation_training_lookback_months,
      actualLineIdx, forecastLineIdx,
      actualRevenueIdx, forecastRevenueIdx
    );
    return round2(pct * grossHubSpotRevenue);
  }

  // ── COGS ───────────────────────────────────────────────────────────────────
  if (accountName === ACCT.SUPPLIES_MATERIALS) {
    // Rolling 8-month avg % of OneWeight revenue
    const pct = rollingPctOfOneWeight(
      ACCT.SUPPLIES_MATERIALS, year, month,
      asmp.supplies_materials_lookback_months,
      actualLineIdx, forecastLineIdx
    );
    return round2(pct * pipeline.oneweight);
  }

  if (accountName === ACCT.SHIPPING_FREIGHT) {
    // Rolling 12-month avg % of OneWeight revenue
    const pct = rollingPctOfOneWeight(
      ACCT.SHIPPING_FREIGHT, year, month,
      asmp.shipping_freight_lookback_months,
      actualLineIdx, forecastLineIdx
    );
    return round2(pct * pipeline.oneweight);
  }

  if (accountName === ACCT.CLOUD_HOSTING) {
    // Override → use that % of revenue
    if (asmp.cloud_hosting_pct_override != null) {
      return round2(asmp.cloud_hosting_pct_override * grossHubSpotRevenue);
    }
    // Else: find last actual cloud hosting % of revenue, hold that % constant
    for (let i = actualMonths.length - 1; i >= 0; i--) {
      const { year: ay, month: am } = actualMonths[i];
      const ch  = actualLineIdx[ACCT.CLOUD_HOSTING]?.[monthKey(ay, am)] || 0;
      const rev = actualRevenueIdx[monthKey(ay, am)] || 0;
      if (rev > 0 && ch > 0) {
        return round2((ch / rev) * grossHubSpotRevenue);
      }
    }
    return 0;
  }

  // ── Payroll ────────────────────────────────────────────────────────────────
  // Hinckley uses TriNet (not QBO Payroll) so PayrollSummary is unavailable.
  // Straightline the most recent actual month from the P&L for each line.
  // Future: hiring plan feature will let clients layer incremental hires on top.
  if (accountName === ACCT.WAGES)          return round2(getLastActual(ACCT.WAGES,          actualMonths, actualLineIdx));
  if (accountName === ACCT.BENEFITS)       return round2(getLastActual(ACCT.BENEFITS,       actualMonths, actualLineIdx));
  if (accountName === ACCT.EMPLOYER_TAXES) return round2(getLastActual(ACCT.EMPLOYER_TAXES, actualMonths, actualLineIdx));

  // ── Operating expenses ─────────────────────────────────────────────────────
  if (accountName === ACCT.COMMISSIONS) {
    // 15% of (OneDose new + renewal + OneWeight) revenue
    const rate = asmp.commissions_rate || 0.15;
    return round2(rate * (pipeline.onedose_new + pipeline.onedose_renewal + pipeline.oneweight));
  }

  if (accountName === ACCT.WORKFORCE_MGMT) {
    // $178 × total FTE count. Client can adjust fte_count in ForecastAssumptions.
    return round2((asmp.workforce_mgmt_per_fte || 178) * (asmp.fte_count || 14));
  }

  if (accountName === ACCT.PROFESSIONAL_SERVICES) {
    return round2(asmp.professional_services_monthly || 8000);
  }

  if (accountName === ACCT.SOFTWARE_IT) {
    if (asmp.software_it_monthly_override != null) return round2(asmp.software_it_monthly_override);
    return round2(getLastActual(ACCT.SOFTWARE_IT, actualMonths, actualLineIdx));
  }

  if (accountName === ACCT.TRAVEL)          return round2(asmp.travel_monthly          || 15000);
  if (accountName === ACCT.MEALS)           return round2(asmp.meals_monthly           || 4000);
  if (accountName === ACCT.BANK_CHARGES)    return round2(asmp.bank_charges_monthly    || 500);
  if (accountName === ACCT.OFFICE_SUPPLIES) return round2(asmp.office_supplies_monthly || 2000);
  if (accountName === ACCT.GENERAL_ADVERTISING) return round2(asmp.general_advertising_monthly || 1000);

  if (accountName === ACCT.INSURANCE) {
    return round2(calcInsuranceMonthly(asmp));
  }

  if (accountName === ACCT.RENT_UTILITIES) {
    if (asmp.rent_utilities_monthly_override != null) return round2(asmp.rent_utilities_monthly_override);
    return round2(getLastActual(ACCT.RENT_UTILITIES, actualMonths, actualLineIdx));
  }

  if (accountName === ACCT.MARKETING_PS) {
    if (asmp.marketing_ps_monthly_override != null) return round2(asmp.marketing_ps_monthly_override);
    return round2(getLastActual(ACCT.MARKETING_PS, actualMonths, actualLineIdx));
  }

  if (accountName === ACCT.TRADESHOWS) {
    // Prior year same month × (1 + growth rate)
    const growth = asmp.tradeshow_yoy_growth_rate || 0.10;
    const { year: priorYear, month: priorMonth } = subtractMonths(year, month, 12);

    // Check prior year actual first, then prior year forecast
    const priorActual   = actualLineIdx[ACCT.TRADESHOWS]?.[monthKey(priorYear, priorMonth)];
    const priorForecast = forecastLineIdx[ACCT.TRADESHOWS]?.[monthKey(priorYear, priorMonth)];
    const priorValue    = priorActual ?? priorForecast;

    if (priorValue != null && priorValue !== 0) {
      return round2(priorValue * (1 + growth));
    }
    // Fallback: last actual tradeshow value (flat)
    return round2(getLastActual(ACCT.TRADESHOWS, actualMonths, actualLineIdx));
  }

  // Bonus, stock options, R&D, and all other unlisted accounts — no forecast
  return null;
}

// ── Account sets for roll-up math ──────────────────────────────────────────────
// The order here also determines sort_order in forecastLineItems.
const REVENUE_ACCOUNTS = [
  ACCT.SUBSCRIPTION_REVENUE,
  ACCT.RENEWAL_REVENUE,
  ACCT.ONEWEIGHT_REVENUE,
  ACCT.INSTALLATION_TRAINING,
  ACCT.DISCOUNTS,               // negative — reduces revenue
];

const COGS_ACCOUNTS = [
  ACCT.SUPPLIES_MATERIALS,
  ACCT.SHIPPING_FREIGHT,
  ACCT.CLOUD_HOSTING,
];

const OPEX_ACCOUNTS = [
  ACCT.WAGES,
  ACCT.BENEFITS,
  ACCT.EMPLOYER_TAXES,
  ACCT.COMMISSIONS,
  ACCT.WORKFORCE_MGMT,
  ACCT.PROFESSIONAL_SERVICES,
  ACCT.SOFTWARE_IT,
  ACCT.TRAVEL,
  ACCT.MEALS,
  ACCT.INSURANCE,
  ACCT.BANK_CHARGES,
  ACCT.OFFICE_SUPPLIES,
  ACCT.RENT_UTILITIES,
  ACCT.GENERAL_ADVERTISING,
  ACCT.MARKETING_PS,
  ACCT.TRADESHOWS,
];

const OTHER_EXPENSE_ACCOUNTS = [
  ACCT.DEPRECIATION,
  ACCT.INTEREST_EXPENSE,
];

// ── Override helpers ───────────────────────────────────────────────────────────

// Build a lookup index of active overrides sorted by creation time.
// Index: { accountName: [override, ...] } — each list is sorted oldest-first.
function buildOverrideIndex(forecastOverrides) {
  const index = {};
  const sorted = [...(forecastOverrides || [])]
    .filter(ov => ov.status === 'active')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const ov of sorted) {
    if (!index[ov.account_name]) index[ov.account_name] = [];
    index[ov.account_name].push(ov);
  }
  return index;
}

// Check whether an override applies to a given year/month.
function overrideApplies(ov, year, month) {
  const [sy, sm] = ov.start_date.split('-').map(Number);
  if (year * 12 + month < sy * 12 + sm) return false;
  if (!ov.end_date) return true;
  const [ey, em] = ov.end_date.split('-').map(Number);
  return year * 12 + month <= ey * 12 + em;
}

// Apply all applicable overrides (type: set | increment | percentage_change) to a
// computed base value. Returns { value, appliedIds, appliedDescriptions }.
// formula_change overrides are handled separately (pre-calculation in assumptions).
function applyValueOverrides(accountName, baseValue, year, month, overrideIndex) {
  const overrides = overrideIndex[accountName] || [];
  let value = baseValue;
  const appliedIds   = [];
  const appliedDescs = [];

  for (const ov of overrides) {
    if (!overrideApplies(ov, year, month)) continue;
    if (ov.override_type === 'formula_change') continue; // handled in assumptions
    if (ov.override_type === 'set') {
      value = ov.amount != null ? ov.amount : value;
    } else if (ov.override_type === 'increment') {
      value += (ov.amount != null ? ov.amount : 0);
    } else if (ov.override_type === 'percentage_change') {
      value *= (1 + (ov.percentage != null ? ov.percentage : 0) / 100);
    }
    appliedIds.push(ov.override_id);
    appliedDescs.push(ov.description || ov.account_name);
  }

  return {
    value:               round2(value),
    appliedIds,
    appliedDescriptions: appliedDescs,
  };
}

// Build a per-month assumptions object with formula_change overrides applied.
// Currently handles: commissions_rate (account: "6004 Commissions").
function applyFormulaOverrides(baseAssumptions, year, month, overrideIndex) {
  const modified = { ...baseAssumptions };

  // Commissions rate formula override: percentage field = new rate as number (e.g. 20 → 0.20)
  const commissionOverrides = (overrideIndex['6004 Commissions'] || [])
    .filter(ov => ov.override_type === 'formula_change' && overrideApplies(ov, year, month));
  if (commissionOverrides.length > 0) {
    // Last applicable override wins for formula changes
    const last = commissionOverrides[commissionOverrides.length - 1];
    modified.commissions_rate = (last.percentage != null ? last.percentage : 15) / 100;
  }

  return modified;
}

// ── Main forecast generator ────────────────────────────────────────────────────

// payrollTotals = { wages, benefits, employer_taxes } from QBO PayrollSummary.
// If null (QBO Payroll not available), wages/benefits/taxes fall back to
// straightlining the last actual month from financialLineItems.
// forecastOverrides = array of ForecastOverride records from Base44 (status: "active").
// If null/empty, no overrides are applied (backwards-compatible).
async function generateForecast(incomeStatements, balanceSheets, financialLineItems, companyId, payrollTotals = null, clientAssumptions = null, forecastOverrides = null) {
  // Merge client-edited assumptions from Base44 over the system defaults.
  // Any field the client has changed in the dashboard takes precedence.
  const assumptions = { ...defaultAssumptions(), ...(clientAssumptions || {}) };

  // Build override index for fast lookup during the forecast loop.
  const overrideIndex = buildOverrideIndex(forecastOverrides);

  // 1. Build data indexes from actuals
  const actualLineIdx    = buildLineItemIndex(financialLineItems);
  const actualRevenueIdx = buildRevenueIndex(incomeStatements);
  const actualMonths     = getActiveActualMonths(incomeStatements);

  // 2. Load HubSpot pipeline revenue
  const { monthlyRevenue, warnings } = await readPipelineForecast();
  if (warnings.length > 0) {
    console.warn(`  Pipeline warnings: ${warnings.length} issues (see earlier output).`);
  }

  // 3. Get starting cash balance from last known balance sheet
  const sortedBS = [...(balanceSheets || [])]
    .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
    .filter(b => b.cash_and_equivalents > 0);
  const lastBS = sortedBS[sortedBS.length - 1];
  let runningCash = lastBS ? lastBS.cash_and_equivalents : 0;

  // 4. Build forecast months = union of HubSpot months + 12 after last actual
  const lastActual = actualMonths[actualMonths.length - 1]
    || { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
  const forecastMonthSet = new Set(Object.keys(monthlyRevenue));
  for (let i = 1; i <= 12; i++) {
    const { year, month } = addMonths(lastActual.year, lastActual.month, i);
    forecastMonthSet.add(monthKey(year, month));
  }

  const sortedForecastMonths = Array.from(forecastMonthSet).sort((a, b) => {
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return ay !== by ? ay - by : am - bm;
  });

  // 5. Running indexes — populated as we compute each forecast month
  const forecastLineIdx     = {}; // { accountName: { 'YYYY-M': value } }
  const forecastRevenueIdx  = {}; // { 'YYYY-M': grossRevenue }

  // Output arrays
  const forecastLineItems         = [];
  const forecastIncomeStatements  = [];
  const forecastRecords           = [];

  // 6. Loop over each forecast month
  for (const key of sortedForecastMonths) {
    const [year, month] = key.split('-').map(Number);
    const pipeline = monthlyRevenue[key] || { onedose_new: 0, onedose_renewal: 0, oneweight: 0, total: 0 };
    const grossHubSpotRevenue = pipeline.onedose_new + pipeline.onedose_renewal + pipeline.oneweight;

    // Apply formula_change overrides to assumptions for this specific month.
    // This modifies things like commissions_rate before the formula evaluates.
    const monthAssumptions = applyFormulaOverrides(assumptions, year, month, overrideIndex);

    // Context object passed to every account evaluator
    const ctx = {
      year, month, pipeline, grossHubSpotRevenue,
      actualMonths, actualLineIdx, forecastLineIdx,
      actualRevenueIdx, forecastRevenueIdx,
      runningCash,
      assumptions: monthAssumptions,  // use month-specific (formula-overridden) assumptions
      payrollTotals,
    };

    // Track all values for this month (value + override attribution)
    const monthValues    = {}; // { accountName: value }
    const monthOverrides = {}; // { accountName: { appliedIds, appliedDescriptions } }

    // ── Revenue accounts ──────────────────────────────────────────────────────
    for (const acctName of REVENUE_ACCOUNTS) {
      const base = forecastAccount(acctName, ctx);
      if (base !== null) {
        const { value, appliedIds, appliedDescriptions } = applyValueOverrides(acctName, base, year, month, overrideIndex);
        monthValues[acctName] = value;
        if (appliedIds.length > 0) monthOverrides[acctName] = { appliedIds, appliedDescriptions };
      }
    }

    // ── COGS accounts ─────────────────────────────────────────────────────────
    for (const acctName of COGS_ACCOUNTS) {
      const base = forecastAccount(acctName, ctx);
      if (base !== null) {
        const { value, appliedIds, appliedDescriptions } = applyValueOverrides(acctName, base, year, month, overrideIndex);
        monthValues[acctName] = value;
        if (appliedIds.length > 0) monthOverrides[acctName] = { appliedIds, appliedDescriptions };
      }
    }

    // ── OpEx accounts ─────────────────────────────────────────────────────────
    for (const acctName of OPEX_ACCOUNTS) {
      const base = forecastAccount(acctName, ctx);
      if (base !== null) {
        const { value, appliedIds, appliedDescriptions } = applyValueOverrides(acctName, base, year, month, overrideIndex);
        monthValues[acctName] = value;
        if (appliedIds.length > 0) monthOverrides[acctName] = { appliedIds, appliedDescriptions };
      }
    }

    // ── Below-the-line: depreciation and interest expense ─────────────────────
    for (const acctName of OTHER_EXPENSE_ACCOUNTS) {
      let base;
      if (acctName === ACCT.DEPRECIATION && monthAssumptions.depreciation_monthly_override != null) {
        base = round2(monthAssumptions.depreciation_monthly_override);
      } else if (acctName === ACCT.INTEREST_EXPENSE && monthAssumptions.interest_expense_monthly_override != null) {
        base = round2(monthAssumptions.interest_expense_monthly_override);
      } else {
        base = round2(getLastActual(acctName, actualMonths, actualLineIdx));
      }
      if (base !== 0) {
        const { value, appliedIds, appliedDescriptions } = applyValueOverrides(acctName, base, year, month, overrideIndex);
        monthValues[acctName] = value;
        if (appliedIds.length > 0) monthOverrides[acctName] = { appliedIds, appliedDescriptions };
      }
    }

    // ── Roll up P&L totals ────────────────────────────────────────────────────
    const revenue = sumAccounts(monthValues, REVENUE_ACCOUNTS);
    const cost_of_revenue = sumAccounts(monthValues, COGS_ACCOUNTS);
    const gross_profit = round2(revenue - cost_of_revenue);
    const operating_expenses = sumAccounts(monthValues, OPEX_ACCOUNTS);
    const operating_income = round2(gross_profit - operating_expenses);

    // ── Interest income (needs running cash from prior forecast) ──────────────
    const interest_income = round2(runningCash * ((monthAssumptions.interest_rate_annual || 0.025) / 12));
    if (interest_income !== 0) {
      const { value: iiVal, appliedIds: iiIds, appliedDescriptions: iiDescs } =
        applyValueOverrides(ACCT.INTEREST_INCOME, interest_income, year, month, overrideIndex);
      monthValues[ACCT.INTEREST_INCOME] = iiVal;
      if (iiIds.length > 0) monthOverrides[ACCT.INTEREST_INCOME] = { appliedIds: iiIds, appliedDescriptions: iiDescs };
    }

    const depreciation    = monthValues[ACCT.DEPRECIATION]    || 0;
    const interest_expense = monthValues[ACCT.INTEREST_EXPENSE] || 0;
    const other_income_expense = round2(interest_income - depreciation - interest_expense);

    const net_income = round2(operating_income + other_income_expense);

    // ── Update running indexes for next month's lookback ──────────────────────
    for (const [acctName, val] of Object.entries(monthValues)) {
      if (!forecastLineIdx[acctName]) forecastLineIdx[acctName] = {};
      forecastLineIdx[acctName][key] = val;
    }
    forecastRevenueIdx[key] = revenue;

    // Update running cash balance (simplified: cash changes by net income)
    runningCash = round2(runningCash + net_income);

    // ── Build forecastLineItem records ────────────────────────────────────────
    let sortOrder = 0;
    for (const [acctName, val] of Object.entries(monthValues)) {
      if (val === 0) continue; // omit zero rows
      const ovMeta = monthOverrides[acctName];
      forecastLineItems.push({
        company_id:           companyId,
        statement:            'income_statement',
        account_name:         acctName,
        year, month,
        period_type:          'forecast',
        value:                val,
        sort_order:           sortOrder++,
        indent_level:         1,
        // Override attribution — present only when this value was modified by an override
        override_ids:         ovMeta ? JSON.stringify(ovMeta.appliedIds)         : null,
        override_description: ovMeta ? ovMeta.appliedDescriptions.join('; ')    : null,
      });
    }

    // ── Build forecastIncomeStatement record ──────────────────────────────────
    const ebitda = round2(operating_income + depreciation); // add back D&A
    const monthly_burn = net_income < 0 ? Math.abs(net_income) : 0;
    const runway_months = monthly_burn > 0 ? Math.round(runningCash / monthly_burn) : 999;

    forecastIncomeStatements.push({
      company_id:               companyId,
      year, month,
      period_type:              'forecast',
      revenue:                  round2(revenue),
      cost_of_revenue:          round2(cost_of_revenue),
      gross_profit:             round2(gross_profit),
      operating_expenses:       round2(operating_expenses),
      salaries_wages:           round2((monthValues[ACCT.WAGES] || 0) + (monthValues[ACCT.BENEFITS] || 0)),
      marketing_expense:        round2(monthValues[ACCT.MARKETING_PS] || 0),
      rd_expense:               0,
      general_admin:            round2(operating_expenses),
      depreciation_amortization: round2(depreciation),
      operating_income:         round2(operating_income),
      interest_expense:         round2(interest_expense),
      other_income_expense:     round2(other_income_expense),
      income_before_tax:        round2(net_income),
      tax_expense:              0,
      net_income:               round2(net_income),
      ebitda:                   round2(ebitda),
    });

    // ── Build forecastRecord (high-level cash + runway) ───────────────────────
    const keyAssumptions = buildKeyAssumptionsText(assumptions, cost_of_revenue, revenue, operating_expenses, actualMonths.length);

    forecastRecords.push({
      company_id:          companyId,
      year, month,
      scenario:            'base',
      revenue:             round2(revenue),
      total_expenses:      round2(cost_of_revenue + operating_expenses),
      net_income:          round2(net_income),
      operating_cash_flow: round2(net_income),
      ending_cash_balance: round2(runningCash),
      cash_burn:           round2(monthly_burn),
      runway_months,
      key_assumptions:     keyAssumptions,
    });
  }

  const payrollSource = payrollTotals ? 'QBO PayrollSummary' : 'last actual month (PayrollSummary unavailable)';
  console.log(`\nForecast generated: ${forecastIncomeStatements.length} months, ${forecastLineItems.length} line items.`);
  console.log(`  Payroll source: ${payrollSource}`);

  return { forecastLineItems, forecastIncomeStatements, forecastRecords };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Sum the values for a set of accounts from the monthly values map.
function sumAccounts(monthValues, accountNames) {
  return round2(accountNames.reduce((sum, name) => sum + (monthValues[name] || 0), 0));
}

// Build a human-readable key assumptions string for a forecast month.
function buildKeyAssumptionsText(assumptions, cogs, revenue, opex, actualMonthCount) {
  const parts = [
    'Revenue: HubSpot pipeline (amount × deal stage probability).',
    'OneDose amortized over 12 months; OneWeight recognized at close.',
    `Commissions: ${((assumptions.commissions_rate || 0.15) * 100).toFixed(0)}% of OneDose + OneWeight revenue.`,
    `Insurance: $${calcInsuranceMonthly(assumptions).toFixed(2)}/month (GL + monthly + D&O amortized).`,
    `Tradeshows: prior year same month × ${((1 + (assumptions.tradeshow_yoy_growth_rate || 0.10)) * 100).toFixed(0)}%.`,
    `Payroll: straightlined from most recent actual (PayrollSummary pull coming in Phase 5).`,
    `Based on ${actualMonthCount} months of historical actuals.`,
  ];
  return parts.join(' ');
}

module.exports = { generateForecast };
