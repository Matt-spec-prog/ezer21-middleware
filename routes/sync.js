// Sync Routes
//
// These endpoints trigger the pull from QuickBooks.
// Right now there's one route: /api/sync/test
// It pulls the last 12 months of P&L and Balance Sheet and shows the raw data.
// Later phases will transform and push this data to Base44.

const express = require('express');
const router = express.Router();
const { getProfitAndLoss, getBalanceSheet, getDateRange } = require('../services/qbo');
const fs = require('fs');
const path = require('path');

// ── GET /api/sync/test ────────────────────────────────────────────────────────
// Pulls the last 12 months of reports from QBO and saves them to raw_reports.json
// Visit http://localhost:3000/api/sync/test to run it
router.get('/test', async (req, res) => {
  try {
    const { startDate, endDate } = getDateRange(12);
    console.log(`Pulling reports from ${startDate} to ${endDate}...`);

    // Pull both reports at the same time
    const [profitAndLoss, balanceSheet] = await Promise.all([
      getProfitAndLoss(startDate, endDate),
      getBalanceSheet(startDate, endDate),
    ]);

    // Save raw reports to a file so we can inspect them
    const rawReports = { pulledAt: new Date().toISOString(), startDate, endDate, profitAndLoss, balanceSheet };
    fs.writeFileSync(
      path.join(__dirname, '..', 'raw_reports.json'),
      JSON.stringify(rawReports, null, 2)
    );

    console.log('Reports saved to raw_reports.json');

    res.json({
      success: true,
      message: 'Reports pulled successfully. Saved to raw_reports.json.',
      dateRange: { startDate, endDate },
      reportNames: {
        profitAndLoss: profitAndLoss?.Header?.ReportName,
        balanceSheet: balanceSheet?.Header?.ReportName,
      },
    });
  } catch (error) {
    console.error('Sync failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
