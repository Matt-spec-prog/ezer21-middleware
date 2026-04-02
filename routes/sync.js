// Sync Routes
//
// Three endpoints:
//
//   GET /api/sync/test  — pull QBO data, transform, generate forecast, save locally
//   GET /api/sync/push  — read transformed_data.json, push to Base44
//   GET /api/sync/run   — do both in one call (used by cron job + manual trigger on Vercel)
//
// Local dev: use /test then /push (lets you inspect transformed_data.json between steps)
// Vercel:    use /run (does everything in memory — no intermediate file needed)

const express = require('express');
const router  = express.Router();
const { getProfitAndLoss, getBalanceSheet, getPayrollSummary, parsePayrollSummary, getDateRange } = require('../services/qbo');
const { transformReports }   = require('../services/transform');
const { generateForecast }   = require('../services/forecast');
const { pushToBase44, readForecastAssumptions, makeClient, loadToken } = require('../services/base44');
const fs   = require('fs');
const path = require('path');

const IS_VERCEL = process.env.VERCEL === '1';

// ── Shared: pull + transform + forecast ──────────────────────────────────────
// Used by both /test and /run so the logic lives in one place.
async function pullAndTransform() {
  const customStart = '2023-08-01';

  // Cap end date at the last day of 2 months ago so partially-closed months
  // are never included as actuals. (March books typically close in early April;
  // once March is confirmed closed, run /api/sync/run to pull it in.)
  const now        = new Date();
  const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 1, 0); // last day of 2 months ago
  const customEnd  = twoMonthsAgo.toISOString().split('T')[0];

  console.log(`Pulling reports from ${customStart} to ${customEnd}...`);

  const [profitAndLoss, balanceSheet, payrollRaw] = await Promise.all([
    getProfitAndLoss(customStart, customEnd),
    getBalanceSheet(customStart, customEnd),
    getPayrollSummary(),
  ]);

  const payrollTotals = parsePayrollSummary(payrollRaw);

  const rawReports = {
    pulledAt:     new Date().toISOString(),
    startDate:    customStart,
    endDate:      customEnd,
    profitAndLoss,
    balanceSheet,
    payrollTotals,
  };

  // Save raw reports locally for debugging (local dev only — Vercel filesystem is read-only)
  if (!IS_VERCEL) {
    fs.writeFileSync(
      path.join(__dirname, '..', 'raw_reports.json'),
      JSON.stringify(rawReports, null, 2)
    );
    console.log('Reports saved to raw_reports.json');
  }

  const transformed = transformReports(rawReports, 'test-company');

  // Read client-edited assumptions from Base44 so they affect the forecast
  let clientAssumptions = null;
  try {
    const token = await loadToken();
    const http  = makeClient(token);
    clientAssumptions = await readForecastAssumptions(http, process.env.BASE44_COMPANY_ID || '69cd6288f1b9adf4f7eeb809');
    if (clientAssumptions) console.log('Loaded client assumptions from Base44.');
  } catch (e) {
    console.warn('Could not read ForecastAssumptions from Base44 — using defaults.', e.message);
  }

  const { forecastLineItems, forecastIncomeStatements, forecastRecords } = await generateForecast(
    transformed.incomeStatements,
    transformed.balanceSheets,
    transformed.financialLineItems,
    'test-company',
    payrollTotals,
    clientAssumptions
  );

  const allData = { ...transformed, forecastLineItems, forecastIncomeStatements, forecastRecords };

  // Save transformed data locally for inspection (local dev only)
  if (!IS_VERCEL) {
    fs.writeFileSync(
      path.join(__dirname, '..', 'transformed_data.json'),
      JSON.stringify(allData, null, 2)
    );
    console.log('Transformed data + forecast saved to transformed_data.json');
  }

  return allData;
}

// ── GET /api/sync/test ────────────────────────────────────────────────────────
// Pull QBO, transform, generate forecast, save files locally. Inspect first, then /push.
router.get('/test', async (req, res) => {
  try {
    const allData = await pullAndTransform();

    res.json({
      success:   true,
      message:   'Reports pulled, transformed, and forecast generated.',
      counts: {
        incomeStatements:         allData.incomeStatements.length,
        balanceSheets:            allData.balanceSheets.length,
        monthlyMetrics:           allData.monthlyMetrics.length,
        financialLineItems:       allData.financialLineItems.length,
        reportingPeriods:         allData.reportingPeriods.length,
        forecastLineItems:        allData.forecastLineItems.length,
        forecastIncomeStatements: allData.forecastIncomeStatements.length,
        forecastRecords:          allData.forecastRecords.length,
      },
    });
  } catch (error) {
    console.error('Sync failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /api/sync/push ────────────────────────────────────────────────────────
// Reads transformed_data.json (local dev only) and pushes to Base44.
// On Vercel, use /run instead — this endpoint needs the local file.
router.get('/push', async (req, res) => {
  try {
    if (IS_VERCEL) {
      return res.status(400).json({
        success: false,
        error:   'Use /api/sync/run on Vercel — /push requires a local file that does not exist in production.',
      });
    }

    const dataPath = path.join(__dirname, '..', 'transformed_data.json');
    if (!fs.existsSync(dataPath)) {
      return res.status(400).json({
        success: false,
        error:   'transformed_data.json not found. Run /api/sync/test first.',
      });
    }

    const allData    = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const pushResult = await pushToBase44(allData);

    res.json({
      success:   true,
      message:   'Data pushed to Base44.',
      companyId: pushResult.companyId,
      counts: {
        reportingPeriodsActual:   pushResult.reportingPeriodsActual,
        reportingPeriodsForecast: pushResult.reportingPeriodsForecast,
        incomeStatementsActual:   pushResult.incomeStatementsActual,
        incomeStatementsForecast: pushResult.incomeStatementsForecast,
        balanceSheets:            pushResult.balanceSheets,
        monthlyMetrics:           pushResult.monthlyMetrics,
        financialLineItems:       pushResult.financialLineItems,
        forecastRecords:          pushResult.forecastRecords,
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

// ── GET /api/sync/run ─────────────────────────────────────────────────────────
// Pull QBO + transform + forecast + push to Base44 all in one call.
// Used by the monthly cron job and for manual one-click syncs on Vercel.
// Also works in local dev as an alternative to /test + /push.
router.get('/run', async (req, res) => {
  try {
    console.log('\n=== Starting full sync run ===');

    const allData    = await pullAndTransform();
    const pushResult = await pushToBase44(allData);

    console.log('=== Sync run complete ===\n');

    res.json({
      success:   true,
      message:   'Full sync complete — QBO pulled, transformed, and pushed to Base44.',
      companyId: pushResult.companyId,
      counts: {
        actuals: {
          reportingPeriods: pushResult.reportingPeriodsActual,
          incomeStatements: pushResult.incomeStatementsActual,
          balanceSheets:    pushResult.balanceSheets,
          monthlyMetrics:   pushResult.monthlyMetrics,
          financialLineItems: pushResult.financialLineItems,
        },
        forecast: {
          reportingPeriods: pushResult.reportingPeriodsForecast,
          incomeStatements: pushResult.incomeStatementsForecast,
          forecastRecords:  pushResult.forecastRecords,
        },
      },
    });
  } catch (error) {
    console.error('Full sync run failed:', error.message);
    const detail = error.response
      ? { status: error.response.status, data: error.response.data, url: error.config?.url }
      : null;
    if (detail) console.error('API error:', JSON.stringify(detail));
    res.status(500).json({ success: false, error: error.message, detail });
  }
});

module.exports = router;
