// Sync Routes
//
// These endpoints trigger the pull from QuickBooks.
// Right now there's one route: /api/sync/test
// It pulls the last 12 months of P&L and Balance Sheet and shows the raw data.
// Later phases will transform and push this data to Base44.

const express = require('express');
const router = express.Router();
const { getProfitAndLoss, getBalanceSheet, getPayrollSummary, parsePayrollSummary, getDateRange } = require('../services/qbo');
const { transformReports } = require('../services/transform');
const { generateForecast } = require('../services/forecast');
const { pushToBase44 } = require('../services/base44');
const fs = require('fs');
const path = require('path');

// ── GET /api/sync/test ────────────────────────────────────────────────────────
// Pulls the last 12 months of reports from QBO and saves them to raw_reports.json
// Visit http://localhost:3000/api/sync/test to run it
router.get('/test', async (req, res) => {
  try {
    const { startDate, endDate } = getDateRange(12);
    // Override: pull all data back to August 2023
    const customStart = '2023-08-01';
    const customEnd = endDate; // still today
    console.log(`Pulling reports from ${startDate} to ${endDate}...`);

    // Pull all reports at the same time
    const [profitAndLoss, balanceSheet, payrollRaw] = await Promise.all([
      getProfitAndLoss(customStart, customEnd),
      getBalanceSheet(customStart, customEnd),
      getPayrollSummary(),  // returns null if QBO Payroll not available
    ]);

    const payrollTotals = parsePayrollSummary(payrollRaw); // { wages, benefits, employer_taxes } or null

    // Save raw reports to a file so we can inspect them
    const rawReports = { pulledAt: new Date().toISOString(), startDate: customStart, endDate: customEnd, profitAndLoss, balanceSheet, payrollTotals };
    fs.writeFileSync(
      path.join(__dirname, '..', 'raw_reports.json'),
      JSON.stringify(rawReports, null, 2)
    );

    console.log('Reports saved to raw_reports.json');

    // Transform the raw QBO data into Base44 entity records
    // Use 'test-company' as the company ID for now — we'll use a real ID when connecting to Base44
    const transformed = transformReports(rawReports, 'test-company');

    // Save transformed records so we can inspect them before pushing to Base44
    fs.writeFileSync(
      path.join(__dirname, '..', 'transformed_data.json'),
      JSON.stringify(transformed, null, 2)
    );
    console.log('Transformed data saved to transformed_data.json');

    // Generate 12-month forecast from the actuals (account-level logic)
    const { forecastLineItems, forecastIncomeStatements, forecastRecords } = generateForecast(
      transformed.incomeStatements,
      transformed.balanceSheets,
      transformed.financialLineItems,
      'test-company',
      payrollTotals   // { wages, benefits, employer_taxes } or null → falls back to last actual
    );

    // Save everything together
    const allData = {
      ...transformed,
      forecastLineItems,
      forecastIncomeStatements,
      forecastRecords,
    };

    fs.writeFileSync(
      path.join(__dirname, '..', 'transformed_data.json'),
      JSON.stringify(allData, null, 2)
    );
    console.log('Forecast generated and saved to transformed_data.json');

    res.json({
      success: true,
      message: 'Reports pulled, transformed, and forecast generated.',
      dateRange: { startDate: customStart, endDate: customEnd },
      counts: {
        incomeStatements:         transformed.incomeStatements.length,
        balanceSheets:            transformed.balanceSheets.length,
        monthlyMetrics:           transformed.monthlyMetrics.length,
        financialLineItems:       transformed.financialLineItems.length,
        reportingPeriods:         transformed.reportingPeriods.length,
        forecastLineItems:        forecastLineItems.length,
        forecastIncomeStatements: forecastIncomeStatements.length,
        forecastRecords:          forecastRecords.length,
      },
    });
  } catch (error) {
    console.error('Sync failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /api/sync/push ────────────────────────────────────────────────────────
// Reads the last transformed_data.json saved by /api/sync/test and pushes
// everything to Base44. Run /api/sync/test first, then /api/sync/push.
// Visit http://localhost:3000/api/sync/push to run it
router.get('/push', async (req, res) => {
  try {
    const dataPath = path.join(__dirname, '..', 'transformed_data.json');
    if (!fs.existsSync(dataPath)) {
      return res.status(400).json({
        success: false,
        error: 'transformed_data.json not found. Run /api/sync/test first to pull and transform QBO data.',
      });
    }

    const allData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const pushResult = await pushToBase44(allData);

    res.json({
      success: true,
      message: 'Data pushed to Base44.',
      companyId: pushResult.companyId,
      counts: {
        reportingPeriodsActual:    pushResult.reportingPeriodsActual,
        reportingPeriodsForecast:  pushResult.reportingPeriodsForecast,
        incomeStatementsActual:    pushResult.incomeStatementsActual,
        incomeStatementsForecast:  pushResult.incomeStatementsForecast,
        balanceSheets:             pushResult.balanceSheets,
        monthlyMetrics:            pushResult.monthlyMetrics,
        financialLineItems:        pushResult.financialLineItems,
        forecastRecords:           pushResult.forecastRecords,
      },
    });
  } catch (error) {
    console.error('Push to Base44 failed:', error.message);
    const detail = error.response
      ? { status: error.response.status, data: error.response.data, url: error.config?.url }
      : null;
    if (detail) console.error('Base44 API error:', JSON.stringify(detail));
    res.status(500).json({ success: false, error: error.message, detail });
  }
});

module.exports = router;
