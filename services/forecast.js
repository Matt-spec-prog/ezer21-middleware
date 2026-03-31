// Forecast Generator
//
// Takes historical actuals (IncomeStatement + BalanceSheet records) and
// projects 12 months forward.
//
// Revenue: driven by HubSpot pipeline data (amount × probability).
//   - OneDose: spread over 12 months (subscription amortization)
//   - OneWeight: recognized in the month of close
//
// Expenses: as a percentage of revenue based on trailing actuals.
// Cash: starting from last known balance, adjusted by projected net income.
//
// The forecast is a starting point — clients can edit it in the Base44 dashboard.

// ── Helper: calculate average monthly growth rate ─────────────────────────────
// Takes an array of values and returns the average month-over-month growth rate.
// Ignores months where the prior month was zero (avoids division by zero).
function avgGrowthRate(values) {
  const rates = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0) {
      rates.push((values[i] - values[i - 1]) / values[i - 1]);
    }
  }
  if (rates.length === 0) return 0;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

// ── Helper: calculate average ratio of A to B ─────────────────────────────────
function avgRatio(numerators, denominators) {
  const ratios = [];
  for (let i = 0; i < numerators.length; i++) {
    if (denominators[i] > 0) {
      ratios.push(numerators[i] / denominators[i]);
    }
  }
  if (ratios.length === 0) return 0;
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

// ── Helper: add N months to a year/month pair ─────────────────────────────────
function addMonths(year, month, n) {
  const total = (year * 12 + (month - 1)) + n;
  return {
    year:  Math.floor(total / 12),
    month: (total % 12) + 1,
  };
}

// ── Main forecast generator ───────────────────────────────────────────────────
function generateForecast(incomeStatements, balanceSheets, companyId) {
  const { readPipelineForecast } = require('./hubspot');

  // 1. Sort actuals chronologically
  const sorted = [...incomeStatements]
    .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

  const active = sorted.filter(m => m.revenue > 0 || m.net_income !== 0);
  const lookback = active.slice(-6); // last 6 active months for expense ratios

  if (lookback.length === 0) {
    console.warn('No active months found — expense ratios will default to 0.');
  }

  // 2. Calculate expense ratios from trailing actuals
  const expenseRatio = avgRatio(
    lookback.map(m => m.operating_expenses),
    lookback.map(m => m.revenue)
  );
  const cogsRatio = avgRatio(
    lookback.map(m => m.cost_of_revenue),
    lookback.map(m => m.revenue)
  );

  // 3. Get last known cash balance
  const sortedBS = [...balanceSheets]
    .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
    .filter(b => b.cash_and_equivalents > 0);

  const lastBS = sortedBS[sortedBS.length - 1];
  let runningCash = lastBS ? lastBS.cash_and_equivalents : 0;

  // 4. Load HubSpot pipeline revenue
  const { monthlyRevenue, warnings } = readPipelineForecast();

  if (warnings.length > 0) {
    console.warn(`Pipeline data quality warnings: ${warnings.length} issues found.`);
  }

  // 5. Build the list of forecast months from the pipeline data
  //    Also include the 12 months after the last actual (in case pipeline extends further)
  const lastActual = sorted[sorted.length - 1] || { year: new Date().getFullYear(), month: new Date().getMonth() };
  const forecastMonths = new Set();

  // Add months from HubSpot pipeline
  for (const key of Object.keys(monthlyRevenue)) {
    forecastMonths.add(key);
  }

  // Also ensure we have at least 12 months of forecast starting from last actual
  for (let i = 1; i <= 12; i++) {
    const { year, month } = addMonths(lastActual.year, lastActual.month, i);
    forecastMonths.add(`${year}-${month}`);
  }

  // Sort months chronologically
  const sortedMonths = Array.from(forecastMonths).sort((a, b) => {
    const [ay, am] = a.split('-').map(Number);
    const [by, bm] = b.split('-').map(Number);
    return ay !== by ? ay - by : am - bm;
  });

  // 6. Build key assumptions text
  const expensePct = (expenseRatio * 100).toFixed(1);
  const cogsPct    = (cogsRatio * 100).toFixed(1);
  const keyAssumptions = [
    'Revenue: driven by HubSpot pipeline (amount × deal stage probability).',
    'OneDose revenue amortized evenly over 12 months from close date.',
    'OneWeight revenue recognized in full in month of close.',
    `COGS: ${cogsPct}% of revenue (trailing ${lookback.length}-month average from actuals).`,
    `Operating expenses: ${expensePct}% of revenue (trailing ${lookback.length}-month average from actuals).`,
    `Starting cash balance: $${runningCash.toFixed(2)}.`,
    'Forecast generated automatically — edit in the Base44 dashboard to adjust assumptions.',
  ].join(' ');

  // 7. Generate forecast records
  const forecastIncomeStatements = [];
  const forecastRecords = [];

  for (const key of sortedMonths) {
    const [year, month] = key.split('-').map(Number);

    const pipeline      = monthlyRevenue[key] || { onedose_new: 0, onedose_renewal: 0, oneweight: 0, total: 0 };
    const revenue       = pipeline.total;
    const cost_of_revenue    = revenue * cogsRatio;
    const gross_profit       = revenue - cost_of_revenue;
    const operating_expenses = revenue * expenseRatio;
    const operating_income   = gross_profit - operating_expenses;
    const net_income         = operating_income;

    runningCash += net_income;
    const monthly_burn  = net_income < 0 ? Math.abs(net_income) : 0;
    const runway_months = monthly_burn > 0 ? Math.round(runningCash / monthly_burn) : 999;

    forecastIncomeStatements.push({
      company_id:               companyId,
      year,
      month,
      period_type:              'forecast',
      revenue:                  round2(revenue),
      cost_of_revenue:          round2(cost_of_revenue),
      gross_profit:             round2(gross_profit),
      operating_expenses:       round2(operating_expenses),
      salaries_wages:           0,
      marketing_expense:        0,
      rd_expense:               0,
      general_admin:            round2(operating_expenses),
      depreciation_amortization: 0,
      operating_income:         round2(operating_income),
      interest_expense:         0,
      other_income_expense:     0,
      income_before_tax:        round2(net_income),
      tax_expense:              0,
      net_income:               round2(net_income),
      ebitda:                   round2(operating_income),
      // Store pipeline breakdown for reference
      _pipeline_onedose_new:     pipeline.onedose_new,
      _pipeline_onedose_renewal: pipeline.onedose_renewal,
      _pipeline_oneweight:       pipeline.oneweight,
    });

    forecastRecords.push({
      company_id:          companyId,
      year,
      month,
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

  console.log(`Forecast generated: ${forecastIncomeStatements.length} months.`);
  console.log(`  COGS ratio: ${cogsPct}% | Expense ratio: ${expensePct}%`);

  return { forecastIncomeStatements, forecastRecords };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { generateForecast };

