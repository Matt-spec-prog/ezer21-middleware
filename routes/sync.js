// Sync Routes
//
// These endpoints trigger the pull from QuickBooks.
// Right now there's one route: /api/sync/test
// It pulls the last 12 months of P&L and Balance Sheet and shows the raw data.
// Later phases will transform and push this data to Base44.

const express = require('express');
const router = express.Router();
const { getProfitAndLoss, getBalanceSheet, getDateRange } = require('../services/qbo');
const { transformReports } = require('../services/transform');
const { generateForecast } = require('../services/forecast');
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

    // Pull both reports at the same time
    const [profitAndLoss, balanceSheet] = await Promise.all([
      getProfitAndLoss(customStart, customEnd),
      getBalanceSheet(customStart, customEnd),
    ]);

    // Save raw reports to a file so we can inspect them
    const rawReports = { pulledAt: new Date().toISOString(), startDate: customStart, endDate: customEnd, profitAndLoss, balanceSheet };
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

    // Generate 12-month forecast from the actuals
    const { forecastIncomeStatements, forecastRecords } = generateForecast(
      transformed.incomeStatements,
      transformed.balanceSheets,
      'test-company'
    );

    // Save everything together
    const allData = {
      ...transformed,
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
        forecastIncomeStatements: forecastIncomeStatements.length,
        forecastRecords:          forecastRecords.length,
      },
    });
  } catch (error) {
    console.error('Sync failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
