// Drill-Down Forecast Explanation Service
//
// Given an account name, returns a plain-English explanation of how the
// forecast value for that account is calculated, including the rule type,
// description, and underlying parameters.
//
// Used by routes/drilldown.js for forecast-month drill-downs.
// Actual-month drill-downs go to QBO live transactions instead.

const ACCT = require('./accountMap');

// Map every forecasted account to its rule metadata.
// rule_description is a static explanation of the method.
// rule_details names the ForecastAssumptions field(s) that drive the value.
const FORECAST_RULES = {

  // ── Revenue ─────────────────────────────────────────────────────────────────
  [ACCT.SUBSCRIPTION_REVENUE]: {
    rule: 'hubspot_pipeline',
    rule_description: 'Driven by HubSpot pipeline: OneDose new deals × deal stage probability (Closed won 100% → Low chance 10%), amortized equally over 12 months starting from the deal close date.',
    rule_details: { method: 'hubspot_pipeline', pipeline: 'onedose_new', amortization_months: 12, source: 'ForecastAssumptions.onedose_amortization_months' },
  },
  [ACCT.RENEWAL_REVENUE]: {
    rule: 'hubspot_pipeline',
    rule_description: 'Driven by HubSpot pipeline: OneDose renewal deals × deal stage probability, amortized equally over 12 months starting from the deal close date.',
    rule_details: { method: 'hubspot_pipeline', pipeline: 'onedose_renewal', amortization_months: 12, source: 'ForecastAssumptions.onedose_amortization_months' },
  },
  [ACCT.ONEWEIGHT_REVENUE]: {
    rule: 'hubspot_pipeline',
    rule_description: 'Driven by HubSpot pipeline: OneWeight hardware deals × deal stage probability, recognized in full in the close month (no amortization).',
    rule_details: { method: 'hubspot_pipeline', pipeline: 'oneweight', recognition: 'close_month' },
  },
  [ACCT.DISCOUNTS]: {
    rule: 'rolling_pct_of_revenue',
    rule_description: 'Rolling average discount rate (as % of gross revenue) over the prior N months, applied to this month\'s forecasted gross revenue. N is set by the Discounts Lookback Months assumption.',
    rule_details: { method: 'rolling_pct_of_revenue', source: 'ForecastAssumptions.discounts_lookback_months' },
  },
  [ACCT.INSTALLATION_TRAINING]: {
    rule: 'rolling_pct_of_revenue',
    rule_description: 'Rolling average installation & training revenue (as % of gross revenue) over the prior N months, applied to this month\'s forecasted gross revenue.',
    rule_details: { method: 'rolling_pct_of_revenue', source: 'ForecastAssumptions.installation_training_lookback_months' },
  },

  // ── COGS ─────────────────────────────────────────────────────────────────────
  [ACCT.SUPPLIES_MATERIALS]: {
    rule: 'rolling_pct_of_oneweight',
    rule_description: 'Rolling average supplies & materials cost (as % of OneWeight revenue) over the prior 8 months, applied to this month\'s forecasted OneWeight revenue.',
    rule_details: { method: 'rolling_pct_of_oneweight', source: 'ForecastAssumptions.supplies_materials_lookback_months' },
  },
  [ACCT.SHIPPING_FREIGHT]: {
    rule: 'rolling_pct_of_oneweight',
    rule_description: 'Rolling average shipping & freight cost (as % of OneWeight revenue) over the prior 12 months, applied to this month\'s forecasted OneWeight revenue.',
    rule_details: { method: 'rolling_pct_of_oneweight', source: 'ForecastAssumptions.shipping_freight_lookback_months' },
  },
  [ACCT.CLOUD_HOSTING]: {
    rule: 'pct_of_revenue',
    rule_description: 'Most recent actual cloud hosting cost as a % of revenue, held flat going forward. Can be overridden in ForecastAssumptions.',
    rule_details: { method: 'last_actual_pct_of_revenue', source: 'ForecastAssumptions.cloud_hosting_pct_override' },
  },

  // ── Payroll ──────────────────────────────────────────────────────────────────
  [ACCT.WAGES]: {
    rule: 'straightline',
    rule_description: 'Straight-lined from the most recent actual P&L month. Hinckley uses TriNet (not QBO Payroll) so per-employee data is unavailable — the last known total is held flat.',
    rule_details: { method: 'last_actual_flat', source: 'Most recent actual FinancialLineItem for 6001 Wages' },
  },
  [ACCT.BENEFITS]: {
    rule: 'straightline',
    rule_description: 'Straight-lined from the most recent actual P&L month.',
    rule_details: { method: 'last_actual_flat', source: 'Most recent actual FinancialLineItem for 6002 Benefits' },
  },
  [ACCT.EMPLOYER_TAXES]: {
    rule: 'straightline',
    rule_description: 'Straight-lined from the most recent actual P&L month.',
    rule_details: { method: 'last_actual_flat', source: 'Most recent actual FinancialLineItem for 6003 Employer Taxes' },
  },

  // ── Operating Expenses ───────────────────────────────────────────────────────
  [ACCT.COMMISSIONS]: {
    rule: 'formula',
    rule_description: 'Calculated as the commissions rate × (OneDose new + OneDose renewal + OneWeight forecasted revenue). Rate is set in ForecastAssumptions.',
    rule_details: { method: 'pct_of_revenue', source: 'ForecastAssumptions.commissions_rate', default_rate: 0.15 },
  },
  [ACCT.WORKFORCE_MGMT]: {
    rule: 'per_fte',
    rule_description: 'Per-FTE cost × total headcount. Both values are set in ForecastAssumptions and can be adjusted when headcount changes.',
    rule_details: { method: 'per_fte', source: 'ForecastAssumptions.workforce_mgmt_per_fte × fte_count', defaults: '$178 × 14 FTEs = $2,492' },
  },
  [ACCT.PROFESSIONAL_SERVICES]: {
    rule: 'flat',
    rule_description: 'Fixed monthly amount set in ForecastAssumptions.',
    rule_details: { method: 'flat_amount', source: 'ForecastAssumptions.professional_services_monthly', default: 8000 },
  },
  [ACCT.SOFTWARE_IT]: {
    rule: 'straightline',
    rule_description: 'Straight-lined from the most recent actual P&L month. Can be overridden in ForecastAssumptions.',
    rule_details: { method: 'last_actual_flat', source: 'ForecastAssumptions.software_it_monthly_override (if set)' },
  },
  [ACCT.TRAVEL]: {
    rule: 'flat',
    rule_description: 'Fixed monthly amount set in ForecastAssumptions.',
    rule_details: { method: 'flat_amount', source: 'ForecastAssumptions.travel_monthly', default: 15000 },
  },
  [ACCT.MEALS]: {
    rule: 'flat',
    rule_description: 'Fixed monthly amount set in ForecastAssumptions.',
    rule_details: { method: 'flat_amount', source: 'ForecastAssumptions.meals_monthly', default: 4000 },
  },
  [ACCT.INSURANCE]: {
    rule: 'formula',
    rule_description: 'Blended monthly insurance cost: GL liability (annual ÷ 12) + monthly premium + D&O (per-period ÷ payment frequency). All components set in ForecastAssumptions.',
    rule_details: { method: 'insurance_formula', source: 'ForecastAssumptions.insurance_general_liability_annual, insurance_monthly_premium, insurance_do_per_period, insurance_do_payment_months', default_total: '$927.30/month' },
  },
  [ACCT.BANK_CHARGES]: {
    rule: 'flat',
    rule_description: 'Fixed monthly amount set in ForecastAssumptions.',
    rule_details: { method: 'flat_amount', source: 'ForecastAssumptions.bank_charges_monthly', default: 500 },
  },
  [ACCT.OFFICE_SUPPLIES]: {
    rule: 'flat',
    rule_description: 'Fixed monthly amount set in ForecastAssumptions.',
    rule_details: { method: 'flat_amount', source: 'ForecastAssumptions.office_supplies_monthly', default: 2000 },
  },
  [ACCT.RENT_UTILITIES]: {
    rule: 'straightline',
    rule_description: 'Straight-lined from the most recent actual P&L month. Can be overridden in ForecastAssumptions.',
    rule_details: { method: 'last_actual_flat', source: 'ForecastAssumptions.rent_utilities_monthly_override (if set)' },
  },
  [ACCT.GENERAL_ADVERTISING]: {
    rule: 'flat',
    rule_description: 'Fixed monthly amount set in ForecastAssumptions.',
    rule_details: { method: 'flat_amount', source: 'ForecastAssumptions.general_advertising_monthly', default: 1000 },
  },
  [ACCT.MARKETING_PS]: {
    rule: 'straightline',
    rule_description: 'Straight-lined from the most recent actual P&L month. Can be overridden in ForecastAssumptions.',
    rule_details: { method: 'last_actual_flat', source: 'ForecastAssumptions.marketing_ps_monthly_override (if set)' },
  },
  [ACCT.TRADESHOWS]: {
    rule: 'prior_year_growth',
    rule_description: 'Prior year same month × (1 + year-over-year growth rate). If no prior year actual exists, falls back to the most recent actual tradeshow value.',
    rule_details: { method: 'prior_year_yoy_growth', source: 'ForecastAssumptions.tradeshow_yoy_growth_rate', default_growth: '10%' },
  },

  // ── Other Income / Below-the-line ────────────────────────────────────────────
  [ACCT.INTEREST_INCOME]: {
    rule: 'formula',
    rule_description: 'Running cash balance (carried forward from prior forecast month) × (annual interest rate ÷ 12).',
    rule_details: { method: 'interest_on_cash', source: 'ForecastAssumptions.interest_rate_annual', default_rate: '2.5% annual' },
  },
  [ACCT.DEPRECIATION]: {
    rule: 'straightline',
    rule_description: 'Straight-lined from the most recent actual P&L month. Can be overridden in ForecastAssumptions.',
    rule_details: { method: 'last_actual_flat', source: 'ForecastAssumptions.depreciation_monthly_override (if set)' },
  },
  [ACCT.INTEREST_EXPENSE]: {
    rule: 'straightline',
    rule_description: 'Straight-lined from the most recent actual P&L month. Can be overridden in ForecastAssumptions.',
    rule_details: { method: 'last_actual_flat', source: 'ForecastAssumptions.interest_expense_monthly_override (if set)' },
  },
};

// ── Balance Sheet forecast rules ─────────────────────────────────────────────
// Keyed by exact QBO account name. Used for forecast-month drill-down on BS accounts.
const BS_FORECAST_RULES = {
  '1030 US Bank Treasury (3144)': {
    rule: 'prior_plus_cash_flow',
    rule_description: 'Prior month balance + net cash change for the period. All net cash flow (net income + depreciation add-back) accumulates here. All other bank accounts are straight-lined.',
    rule_details: { method: 'prior_plus_net_cash_change', components: 'net_income + depreciation_add_back' },
  },
  '1590 Accumulated Depreciation': {
    rule: 'prior_plus_depreciation',
    rule_description: 'Prior month balance minus this month\'s depreciation expense from the Income Statement (7000 Depreciation). Becomes more negative over time as the asset base depreciates.',
    rule_details: { method: 'contra_asset_accumulation', source: '7000 Depreciation from IS forecast' },
  },
  'Net Income': {
    rule: 'cumulative_net_income',
    rule_description: 'Cumulative year-to-date net income from the Income Statement. Accumulates monthly net income from January through December. Resets at the start of each new fiscal year (January) and prior year balance rolls into Retained Earnings.',
    rule_details: { method: 'ytd_net_income_accumulation' },
  },
  '3500 Retained Earnings': {
    rule: 'prior_with_yearend_rollover',
    rule_description: 'Straight-lined from last actual value except at fiscal year start (January), when the prior year\'s accumulated Net Income is added to Retained Earnings.',
    rule_details: { method: 'straightline_with_annual_rollover' },
  },
  '1100 Accounts Receivable (A/R)': {
    rule: 'placeholder',
    rule_description: '⚠️ Placeholder — carrying forward the last actual balance. A/R forecast based on Days Sales Outstanding (DSO) has not yet been implemented.',
    rule_details: { method: 'placeholder_last_actual', future: 'DSO × revenue forecast' },
  },
  '2100 Deferred Revenue-OneDose': {
    rule: 'placeholder',
    rule_description: '⚠️ Placeholder — carrying forward the last actual balance. Deferred revenue forecast based on the OneDose revenue recognition schedule has not yet been implemented.',
    rule_details: { method: 'placeholder_last_actual', future: 'revenue recognition schedule from HubSpot pipeline' },
  },
  '2200 OneWeight Service Plan Warranty': {
    rule: 'placeholder',
    rule_description: '⚠️ Placeholder — carrying forward the last actual balance. OneWeight warranty reserve forecast has not yet been implemented.',
    rule_details: { method: 'placeholder_last_actual' },
  },
};

// All other BS accounts default to straight-line from last actual.
const BS_DEFAULT_RULE = {
  rule: 'straightline',
  rule_description: 'Straight-lined from the last actual month\'s balance. No change is expected in the forecast for this account.',
  rule_details: { method: 'last_actual_flat' },
};

// Returns the forecast rule explanation for a given account, or null if the
// account has no forecast (e.g. 4110, 5100, 6900, 8100).
// Pass statement='balance_sheet' to look up BS accounts; defaults to IS lookup.
function getForecastExplanation(accountName, statement) {
  if (statement === 'balance_sheet') {
    const rule = BS_FORECAST_RULES[accountName];
    // For BS forecast months, all accounts are forecasted (most are straightline).
    // Return specific rule if defined, otherwise the default straightline rule.
    return { ...(rule || BS_DEFAULT_RULE), overrides_applied: [] };
  }
  const rule = FORECAST_RULES[accountName];
  if (!rule) return null;
  return { ...rule, overrides_applied: [] };
}

module.exports = { getForecastExplanation };
