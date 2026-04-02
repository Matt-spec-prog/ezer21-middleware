// HubSpot Pipeline Revenue Forecast
//
// Reads a HubSpot deals export (.xlsx) and generates a monthly revenue forecast.
//
// Two product lines, two different recognition methods:
//
//   OneDose Pipeline / OneDose Renewal Pipeline (software subscription):
//     → amount × probability ÷ 12, spread evenly over 12 months from close date
//
//   OneWeight Pipeline (device, one-time sale):
//     → amount × probability, all recognized in the month of close date
//
//   OneWeight Renewal Pipeline:
//     → excluded with a warning (OneWeight does not renew)
//
// Exclusion rule:
//   → If column E (billing start/install date) has any value, skip the deal.
//     It has already been closed and handled by the bookkeeper.

const XLSX    = require('xlsx');
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const storage = require('./storage');

// ── Deal stage → probability mapping ─────────────────────────────────────────
const STAGE_PROBABILITY = {
  'closed won':          1.00,
  'verbal commit':       0.90,
  'pending':             0.70,
  'high chance':         0.60,
  'close <30':           0.55,
  'close <30 days':      0.55, // HubSpot variant with "days" suffix
  'close 30-90 days':    0.40,
  'quote built':         0.30,
  'close 90+ days':      0.25,
  'qualified deal':      0.20,
  'low chance':          0.10,
  'closed lost':         0.00,
};

// Look up probability for a deal stage (case-insensitive, trims whitespace)
function getProbability(stage) {
  if (!stage) return null;
  const key = stage.toString().trim().toLowerCase();
  if (key in STAGE_PROBABILITY) return STAGE_PROBABILITY[key];
  return null; // unknown stage
}

// ── Pipeline type classifier ──────────────────────────────────────────────────
function classifyPipeline(pipeline) {
  if (!pipeline) return null;
  const p = pipeline.toString().trim().toLowerCase();
  if (p === 'onedose pipeline' || p === 'onedose renewal pipeline') return 'onedose';
  if (p === 'oneweight pipeline')                                    return 'oneweight';
  if (p === 'oneweight renewal pipeline')                            return 'oneweight_renewal';
  return null;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

// Parse a date value from Excel (can be a JS Date, a serial number, or a string)
function parseExcelDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  // Excel serial date number
  if (typeof value === 'number') {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) return new Date(date.y, date.m - 1, date.d);
  }
  // String date
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Add N months to a Date, return { year, month }
function addMonths(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth() + n, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

// ── Get the xlsx file as a buffer ─────────────────────────────────────────────
// Local dev: reads from HUBSPOT_PIPELINE_FILE env var path
// Vercel:    downloads from the blob URL stored in KV (uploaded via /api/hubspot/upload)
async function getFileBuffer() {
  if (process.env.VERCEL === '1') {
    const blobUrl = await storage.getHubspotBlobUrl();
    if (!blobUrl) return null;
    const response = await axios.get(blobUrl, { responseType: 'arraybuffer' });
    return Buffer.from(response.data);
  }
  const filePath = process.env.HUBSPOT_PIPELINE_FILE;
  if (!filePath || !fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

// ── Main pipeline reader ──────────────────────────────────────────────────────
async function readPipelineForecast() {
  const fileBuffer = await getFileBuffer();

  if (!fileBuffer) {
    console.warn('HubSpot pipeline file not found.');
    console.warn('Skipping pipeline forecast. Upload the file at /api/hubspot/upload and re-run sync.');
    return { monthlyRevenue: {}, warnings: ['Pipeline file not found — forecast excludes HubSpot data.'] };
  }

  // Read the Excel file from buffer
  const workbook  = XLSX.read(fileBuffer, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];
  const rows      = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, dateNF: 'yyyy-mm-dd' });

  // Row 0 is the header — data starts at row 1
  const headers = rows[0];
  const dataRows = rows.slice(1);

  // Column indices (0-based: A=0, B=1, ...)
  const COL_RECORD_ID    = 0; // A
  const COL_DEAL_NAME    = 1; // B
  const COL_STAGE        = 2; // C
  const COL_CLOSE_DATE   = 3; // D
  const COL_INSTALL_DATE = 4; // E — if set, deal is already closed/paid
  const COL_PIPELINE     = 5; // F
  const COL_OWNER        = 6; // G
  const COL_AMOUNT       = 7; // H
  const COL_COMPANY      = 8; // I

  // monthlyRevenue structure:
  // { 'YYYY-M': { onedose_new: 0, onedose_renewal: 0, oneweight: 0 } }
  const monthlyRevenue = {};
  const warnings = [];
  let skippedInstalled = 0;
  let skippedUnknownStage = 0;
  let skippedUnknownPipeline = 0;
  let skippedNoCloseDate = 0;
  let skippedNoAmount = 0;
  let skippedOneWeightRenewal = 0;

  function ensureMonth(key) {
    if (!monthlyRevenue[key]) {
      monthlyRevenue[key] = { onedose_new: 0, onedose_renewal: 0, oneweight: 0 };
    }
  }

  for (const row of dataRows) {
    const recordId    = row[COL_RECORD_ID];
    const dealName    = row[COL_DEAL_NAME];
    const stage       = row[COL_STAGE];
    const closeDateRaw = row[COL_CLOSE_DATE];
    const installDate  = row[COL_INSTALL_DATE];
    const pipeline     = row[COL_PIPELINE];
    const amountRaw    = row[COL_AMOUNT];
    const company      = row[COL_COMPANY];

    // Skip blank rows
    if (!recordId && !dealName) continue;

    // EXCLUSION: already installed/billed — bookkeeper handles actuals
    if (installDate && installDate.toString().trim() !== '') {
      skippedInstalled++;
      continue;
    }

    // Validate close date
    const closeDate = parseExcelDate(closeDateRaw);
    if (!closeDate) {
      skippedNoCloseDate++;
      warnings.push(`No close date: "${dealName}" (${company}) — excluded from forecast.`);
      continue;
    }

    // Validate amount
    const amount = parseFloat(String(amountRaw).replace(/[$,]/g, ''));
    if (!amount || isNaN(amount) || amount <= 0) {
      skippedNoAmount++;
      warnings.push(`No amount: "${dealName}" (${company}) — excluded from forecast.`);
      continue;
    }

    // Validate deal stage
    const probability = getProbability(stage);
    if (probability === null) {
      skippedUnknownStage++;
      warnings.push(`Unknown stage "${stage}": "${dealName}" (${company}) — excluded from forecast.`);
      continue;
    }

    // Skip Closed Lost (probability 0) — no contribution to forecast
    if (probability === 0) continue;

    // Validate pipeline
    const pipelineType = classifyPipeline(pipeline);
    if (!pipelineType) {
      skippedUnknownPipeline++;
      warnings.push(`Unknown pipeline "${pipeline}": "${dealName}" (${company}) — excluded from forecast.`);
      continue;
    }

    // Warn and skip OneWeight Renewal (doesn't exist as a product)
    if (pipelineType === 'oneweight_renewal') {
      skippedOneWeightRenewal++;
      warnings.push(`OneWeight Renewal deal found: "${dealName}" (${company}) — excluded (OneWeight does not renew). Please review in HubSpot.`);
      continue;
    }

    // ── Calculate forecast contribution ──────────────────────────────────────

    const weightedAmount = amount * probability;

    if (pipelineType === 'onedose') {
      // Spread evenly over 12 months starting from close date
      const monthlyAmount = weightedAmount / 12;
      const isRenewal = pipeline.toString().trim().toLowerCase().includes('renewal');

      for (let i = 0; i < 12; i++) {
        const { year, month } = addMonths(closeDate, i);
        const key = `${year}-${month}`;
        ensureMonth(key);
        if (isRenewal) {
          monthlyRevenue[key].onedose_renewal += monthlyAmount;
        } else {
          monthlyRevenue[key].onedose_new += monthlyAmount;
        }
      }
    } else if (pipelineType === 'oneweight') {
      // All revenue in the month of close
      const { year, month } = addMonths(closeDate, 0);
      const key = `${year}-${month}`;
      ensureMonth(key);
      monthlyRevenue[key].oneweight += weightedAmount;
    }
  }

  // Round all values to 2 decimal places
  for (const key of Object.keys(monthlyRevenue)) {
    monthlyRevenue[key].onedose_new     = Math.round(monthlyRevenue[key].onedose_new     * 100) / 100;
    monthlyRevenue[key].onedose_renewal = Math.round(monthlyRevenue[key].onedose_renewal * 100) / 100;
    monthlyRevenue[key].oneweight       = Math.round(monthlyRevenue[key].oneweight       * 100) / 100;
    monthlyRevenue[key].total           = Math.round(
      (monthlyRevenue[key].onedose_new + monthlyRevenue[key].onedose_renewal + monthlyRevenue[key].oneweight) * 100
    ) / 100;
  }

  // Log summary
  console.log(`HubSpot pipeline loaded: ${dataRows.length} rows processed.`);
  console.log(`  Skipped (already installed): ${skippedInstalled}`);
  console.log(`  Skipped (no close date):     ${skippedNoCloseDate}`);
  console.log(`  Skipped (no amount):         ${skippedNoAmount}`);
  console.log(`  Skipped (unknown stage):     ${skippedUnknownStage}`);
  console.log(`  Skipped (unknown pipeline):  ${skippedUnknownPipeline}`);
  console.log(`  Skipped (OW renewal):        ${skippedOneWeightRenewal}`);
  console.log(`  Forecast months generated:   ${Object.keys(monthlyRevenue).length}`);

  if (warnings.length > 0) {
    console.warn(`\n  Data quality warnings (${warnings.length}):`);
    warnings.forEach(w => console.warn(`    ⚠ ${w}`));
  }

  return { monthlyRevenue, warnings };
}

module.exports = { readPipelineForecast, getFileBuffer };
