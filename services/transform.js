// QBO → Base44 Data Transformer
//
// Takes the raw QuickBooks report JSON and converts it into structured records
// that match the Base44 entity schemas (IncomeStatement, BalanceSheet, etc.)
//
// QBO's format: a grid where rows = accounts and columns = months.
// Our job: for each month column, extract the right totals and build one record.

// ── Helpers ───────────────────────────────────────────────────────────────────

// Safely parse a string value to a float (returns 0 if empty or invalid)
function parseValue(v) {
  if (!v || v === '') return 0;
  return parseFloat(v) || 0;
}

// Find a row in the report by its "group" identifier (e.g. "Income", "COGS")
// QBO uses these group labels on summary rows
function findGroup(rows, groupName) {
  for (const row of rows) {
    if (row.group === groupName) return row;
    // Search nested rows recursively
    if (row.Rows && row.Rows.Row) {
      const found = findGroup(row.Rows.Row, groupName);
      if (found) return found;
    }
  }
  return null;
}

// Get the total value for a named group at a specific column index
function getGroupTotal(rows, groupName, colIndex) {
  const group = findGroup(rows, groupName);
  if (!group || !group.Summary) return 0;
  const colData = group.Summary.ColData;
  if (!colData || !colData[colIndex]) return 0;
  return parseValue(colData[colIndex].value);
}

// Extract the list of month columns from the report header
// Returns: [{ colIndex, year, month, colTitle }, ...]
// Skips the first "account name" column and any "total" column
function extractMonthColumns(columns) {
  const cols = columns.Column || columns;
  const months = [];

  for (let i = 1; i < cols.length; i++) {
    const col = cols[i];
    if (col.ColType !== 'Money') continue;

    const colKey = col.MetaData?.find(m => m.Name === 'ColKey')?.Value;
    if (colKey === 'total') continue; // skip the grand total column

    const startDate = col.MetaData?.find(m => m.Name === 'StartDate')?.Value;
    if (!startDate) continue;

    const [year, month] = startDate.split('-').map(Number);
    months.push({ colIndex: i, year, month, colTitle: col.ColTitle });
  }

  return months;
}

// Flatten all rows in a report section into individual line items
// Used for building FinancialLineItem drill-down records
function flattenRows(rows, results = [], depth = 0) {
  for (const row of rows) {
    if (row.type === 'Data' && row.ColData) {
      const name = row.ColData[0]?.value;
      if (name && name !== '') {
        results.push({ name, colData: row.ColData, depth });
      }
    }
    if (row.Rows && row.Rows.Row) {
      flattenRows(row.Rows.Row, results, depth + 1);
    }
  }
  return results;
}

// ── Income Statement Transformer ──────────────────────────────────────────────
// Maps P&L groups to IncomeStatement entity fields
function transformProfitAndLoss(report, companyId) {
  const months = extractMonthColumns(report.Columns);
  const rows = report.Rows.Row;
  const records = [];

  for (const { colIndex, year, month } of months) {
    const revenue            = getGroupTotal(rows, 'Income', colIndex);
    const cost_of_revenue    = getGroupTotal(rows, 'COGS', colIndex);
    const gross_profit       = getGroupTotal(rows, 'GrossProfit', colIndex);
    const operating_expenses = getGroupTotal(rows, 'Expenses', colIndex);
    const operating_income   = getGroupTotal(rows, 'NetOperatingIncome', colIndex);
    const other_income_expense = getGroupTotal(rows, 'NetOtherIncome', colIndex);
    const net_income         = getGroupTotal(rows, 'NetIncome', colIndex);

    // EBITDA approximation: operating income (we don't have D&A as a separate line yet)
    const ebitda = operating_income;

    records.push({
      company_id:             companyId,
      year,
      month,
      period_type:            'actual',
      revenue,
      cost_of_revenue,
      gross_profit,
      operating_expenses,
      salaries_wages:         0, // will be populated when we have payroll data
      marketing_expense:      0,
      rd_expense:             0,
      general_admin:          operating_expenses,
      depreciation_amortization: 0,
      operating_income,
      interest_expense:       0,
      other_income_expense,
      income_before_tax:      net_income,
      tax_expense:            0,
      net_income,
      ebitda,
    });
  }

  return records;
}

// ── Balance Sheet Transformer ─────────────────────────────────────────────────
// Maps Balance Sheet groups to BalanceSheet entity fields
function transformBalanceSheet(report, companyId) {
  const months = extractMonthColumns(report.Columns);
  const rows = report.Rows.Row;
  const records = [];

  for (const { colIndex, year, month } of months) {
    // Assets
    const cash_and_equivalents   = getGroupTotal(rows, 'BankAccounts', colIndex);
    const accounts_receivable     = getGroupTotal(rows, 'AR', colIndex);
    const other_current_assets    = getGroupTotal(rows, 'OtherCurrentAssets', colIndex);
    const total_current_assets    = getGroupTotal(rows, 'CurrentAssets', colIndex);
    const property_equipment_net  = getGroupTotal(rows, 'FixedAssets', colIndex);
    const total_assets            = getGroupTotal(rows, 'TotalAssets', colIndex);

    // Liabilities
    const accounts_payable        = getGroupTotal(rows, 'AP', colIndex);
    const accrued_liabilities     = getGroupTotal(rows, 'CreditCards', colIndex); // credit cards as accrued liabilities
    const other_current_liab      = getGroupTotal(rows, 'OtherCurrentLiabilities', colIndex);
    const total_current_liabilities = getGroupTotal(rows, 'CurrentLiabilities', colIndex);
    const long_term_debt          = getGroupTotal(rows, 'LongTermLiabilities', colIndex);
    const total_liabilities       = getGroupTotal(rows, 'Liabilities', colIndex);

    // Equity
    const total_equity            = getGroupTotal(rows, 'Equity', colIndex);
    const total_liabilities_equity = total_liabilities + total_equity;

    records.push({
      company_id:               companyId,
      year,
      month,
      period_type:              'actual',
      cash_and_equivalents,
      accounts_receivable,
      inventory:                0,
      prepaid_expenses:         0,
      total_current_assets,
      property_equipment_net,
      intangible_assets:        0,
      other_long_term_assets:   0,
      total_assets,
      accounts_payable,
      accrued_liabilities,
      short_term_debt:          other_current_liab,
      total_current_liabilities,
      long_term_debt,
      other_long_term_liabilities: 0,
      total_liabilities,
      common_stock:             0,
      retained_earnings:        total_equity,
      total_equity,
      total_liabilities_equity,
    });
  }

  return records;
}

// ── Monthly Metrics Calculator ────────────────────────────────────────────────
// Derives dashboard KPIs from the income statement and balance sheet records
function buildMonthlyMetrics(incomeStatements, balanceSheets, companyId) {
  const metrics = [];

  for (const is of incomeStatements) {
    // Find the matching balance sheet for the same month
    const bs = balanceSheets.find(b => b.year === is.year && b.month === is.month);

    const cash_on_hand    = bs ? bs.cash_and_equivalents : 0;
    const monthly_burn    = is.net_income < 0 ? Math.abs(is.net_income) : 0;
    const runway_months   = monthly_burn > 0 ? Math.round(cash_on_hand / monthly_burn) : 999;

    metrics.push({
      company_id:   companyId,
      year:         is.year,
      month:        is.month,
      period_type:  'actual',
      cash_on_hand,
      monthly_burn,
      runway_months,
      revenue:      is.revenue,
      net_income:   is.net_income,
      mrr:          is.revenue, // for subscription businesses this would differ; same for now
      net_operating_income: is.operating_income,
    });
  }

  return metrics;
}

// ── Financial Line Items Builder ──────────────────────────────────────────────
// Creates one record per account line per month — used for drill-down views
function buildFinancialLineItems(report, companyId, statementType) {
  const months = extractMonthColumns(report.Columns);
  const rows = report.Rows.Row;
  const lineItems = [];

  const allLines = flattenRows(rows);

  for (const { colIndex, year, month } of months) {
    allLines.forEach((line, sortOrder) => {
      const value = parseValue(line.colData[colIndex]?.value);
      if (value === 0) return; // skip empty cells

      lineItems.push({
        company_id:   companyId,
        statement:    statementType,
        account_name: line.name,
        year,
        month,
        period_type:  'actual',
        value,
        sort_order:   sortOrder,
        indent_level: line.depth,
      });
    });
  }

  return lineItems;
}

// ── ReportingPeriod Builder ───────────────────────────────────────────────────
// Creates a metadata record for each month we're importing
function buildReportingPeriods(incomeStatements, companyId) {
  return incomeStatements.map(is => ({
    company_id:  companyId,
    year:        is.year,
    month:       is.month,
    label:       `${monthName(is.month)} ${is.year}`,
    status:      'final',
    period_type: 'actual',
  }));
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function monthName(m) { return MONTH_NAMES[m - 1] || m; }

// ── Main export ───────────────────────────────────────────────────────────────
function transformReports(rawReports, companyId) {
  const incomeStatements  = transformProfitAndLoss(rawReports.profitAndLoss, companyId);
  const balanceSheets     = transformBalanceSheet(rawReports.balanceSheet, companyId);
  const monthlyMetrics    = buildMonthlyMetrics(incomeStatements, balanceSheets, companyId);
  const incomeLineItems   = buildFinancialLineItems(rawReports.profitAndLoss, companyId, 'income_statement');
  const bsLineItems       = buildFinancialLineItems(rawReports.balanceSheet, companyId, 'balance_sheet');
  const reportingPeriods  = buildReportingPeriods(incomeStatements, companyId);

  return {
    incomeStatements,
    balanceSheets,
    monthlyMetrics,
    financialLineItems: [...incomeLineItems, ...bsLineItems],
    reportingPeriods,
  };
}

module.exports = { transformReports };
