// Base44 Push Service
//
// Pushes all transformed financial data to Base44 using the REST API directly.
// (The @base44/sdk package is ESM-only; our project is CommonJS, so we call
// the same REST endpoints the SDK wraps.)
//
// Authentication: Bearer token from BASE44_API_KEY env var + X-App-Id header.
// Base URL: https://base44.app/api
//
// Push strategy: "delete all for company + replace" per entity type.
//   - Deletes all existing records for the company (by period_type where relevant)
//   - Bulk-creates the new records
//   This is safe for a scheduled middleware run and avoids duplicates.
//
// ForecastAssumptions: upserted once.
//   - Created with system defaults on first push.
//   - On subsequent pushes: system_defaults_json is updated (powers the
//     "revert to defaults" button), but client-edited fields are not touched.

const axios   = require('axios');
const storage = require('./storage');

const BASE_URL   = 'https://base44.app/api';
const CHUNK_SIZE = 200; // max records per bulk-create call

// Company name that will be created / looked up in Base44
const COMPANY_NAME = 'Hinckley Medical Inc. dba OneDose';

// ── HTTP client ───────────────────────────────────────────────────────────────

function makeClient(token) {
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-App-Id':      process.env.BASE44_APP_ID,
      'Content-Type':  'application/json',
    },
    timeout: 30_000,
  });
}

// Load the saved Base44 token (set by visiting /api/auth/base44 in the browser).
// If the token is expired (push returns 401/403), visit that URL again to refresh.
async function loadToken() {
  return storage.getBase44Token();
}

// Convenience wrappers that pull .data from axios responses
async function apiGet(http, path, params = {}) {
  const res = await http.get(path, { params });
  return res.data;
}
async function apiPost(http, path, body) {
  const res = await http.post(path, body);
  return res.data;
}
async function apiPut(http, path, body) {
  const res = await http.put(path, body);
  return res.data;
}
async function apiDelete(http, path, body) {
  const res = await http.delete(path, { data: body });
  return res.data;
}

// ── Entity helpers ────────────────────────────────────────────────────────────

const appId = () => process.env.BASE44_APP_ID;
const entityPath = name => `/apps/${appId()}/entities/${name}`;

// Filter records in Base44 by a query object
async function filter(http, entityName, query) {
  return apiGet(http, entityPath(entityName), { q: JSON.stringify(query) });
}

// Delete all records matching a query, then bulk-create replacements in chunks.
// Returns count of records created.
async function replaceAll(http, entityName, deleteQuery, records) {
  // Delete all matching existing records
  await apiDelete(http, entityPath(entityName), deleteQuery);

  if (records.length === 0) return 0;

  // Bulk-create in chunks with a delay between each to avoid Base44 rate limits
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    await sleep(300);
    const chunk = records.slice(i, i + CHUNK_SIZE);
    await apiPost(http, `${entityPath(entityName)}/bulk`, chunk);
  }

  return records.length;
}

// ── Company ───────────────────────────────────────────────────────────────────

// Finds the Hinckley Medical company record in Base44 or creates it.
// Returns the Base44 _id string.
async function findOrCreateCompany(http) {
  const existing = await filter(http, 'Company', { name: COMPANY_NAME });

  // Base44 may return an array directly or wrap it — handle both
  const existingList = Array.isArray(existing) ? existing : (existing?.items || existing?.data || []);
  console.log(`  Company lookup response:`, JSON.stringify(existingList).slice(0, 200));

  if (existingList.length > 0) {
    const id = existingList[0]._id || existingList[0].id;
    console.log(`  Company found in Base44: ${id}`);
    if (!id) throw new Error(`Company found but no _id/id field. Record: ${JSON.stringify(existingList[0])}`);
    return id;
  }

  const created = await apiPost(http, entityPath('Company'), {
    name:   COMPANY_NAME,
    stage:  'growth',
    status: 'active',
    notes:  'Medical device + software company. Products: OneDose (SaaS) and OneWeight (device).',
  });

  // Re-fetch immediately after create to get the real _id reliably
  const refetch = await filter(http, 'Company', { name: COMPANY_NAME });
  const refetchList = Array.isArray(refetch) ? refetch : (refetch?.items || refetch?.data || []);
  const id = refetchList[0]?._id || refetchList[0]?.id;
  if (!id) throw new Error(`Company created but could not retrieve its ID. Response: ${JSON.stringify(created)}`);

  console.log(`  Company created in Base44: ${id}`);
  return id;
}

// ── ForecastAssumptions ───────────────────────────────────────────────────────

// Hard-coded system defaults. These are the values the middleware calculated.
// Clients can override any field via the Base44 dashboard. The revert button
// restores values from system_defaults_json (which we keep up-to-date here).
function buildSystemDefaults() {
  return {
    commissions_rate:                        0.15,
    onedose_amortization_months:             12,
    discounts_lookback_months:               3,
    installation_training_lookback_months:   3,
    supplies_materials_lookback_months:      8,
    shipping_freight_lookback_months:        12,
    fte_count:                               14,
    engineer_count:                          3,
    workforce_mgmt_per_fte:                  178,
    professional_services_monthly:           8000,
    travel_monthly:                          15000,
    meals_monthly:                           4000,
    bank_charges_monthly:                    500,
    office_supplies_monthly:                 2000,
    general_advertising_monthly:             1000,
    tradeshow_yoy_growth_rate:               0.10,
    insurance_general_liability_annual:      1148.66,
    insurance_monthly_premium:               718.83,
    insurance_do_per_period:                 451,
    insurance_do_payment_months:             4,
    interest_rate_annual:                    0.025,
  };
}

// Read the current ForecastAssumptions from Base44 so the forecast engine can
// use whatever values the client has edited in the dashboard.
// Returns the assumptions object, or null if none exists yet.
async function readForecastAssumptions(http, companyId) {
  const existing = await filter(http, 'ForecastAssumptions', { company_id: companyId });
  const list = Array.isArray(existing) ? existing : (existing?.items || existing?.data || []);
  if (!list || list.length === 0) return null;
  return list[0];
}

// Upsert ForecastAssumptions:
//   - First push: creates record with all defaults.
//   - Subsequent pushes: updates system_defaults_json only (does not overwrite
//     client-edited fields). This keeps the "revert to defaults" button working.
async function upsertForecastAssumptions(http, companyId) {
  const defaults = buildSystemDefaults();
  const existing = await filter(http, 'ForecastAssumptions', { company_id: companyId });
  const existingList = Array.isArray(existing) ? existing : (existing?.items || existing?.data || []);

  if (!existingList || existingList.length === 0) {
    // First time — write all defaults
    await apiPost(http, entityPath('ForecastAssumptions'), {
      company_id:           companyId,
      last_updated:         new Date().toISOString(),
      is_client_overridden: false,
      system_defaults_json: JSON.stringify(defaults),
      ...defaults,
    });
    console.log('  ForecastAssumptions created with system defaults.');
  } else {
    // Already exists — update only system_defaults_json so revert still works
    const record = existingList[0];
    const recordId = record._id || record.id;
    await apiPut(http, `${entityPath('ForecastAssumptions')}/${recordId}`, {
      system_defaults_json: JSON.stringify(defaults),
      last_updated:         new Date().toISOString(),
    });
    console.log(`  ForecastAssumptions updated (system_defaults_json refreshed).`);
  }
}

// ── Prior forecast archiving ──────────────────────────────────────────────────
//
// Before overwriting forecast records, this function snapshots the existing
// forecast for any month that now has actuals. That snapshot (period_type:
// 'prior_forecast') is written once and never touched again — it represents
// what we predicted while that month was still in the future.
//
// The variance tab compares: actual vs prior_forecast.
//
// archiveForecastAsPriorForecast — two different behaviors depending on whether
// a month has actuals yet:
//
//   Future month (no actuals): prior_forecast is refreshed every sync.
//     This means if you change an assumption (e.g. add a hire), the prior_forecast
//     updates immediately so the variance tab always reflects your latest decisions.
//
//   Past month (actuals exist): prior_forecast is written once and locked forever.
//     This captures what you predicted before the books closed so the variance
//     tab shows a meaningful comparison against the actual result.
//
// forecastIncomeStatements and forecastLineItems come from allData (already remapped
// with the real company_id) and represent the new forecast about to be pushed.
//
// Helper: pause between API calls to avoid Base44 rate limits
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Helper: filter with high limit to avoid pagination issues on bulk reads
async function filterAll(http, entityName, query) {
  return apiGet(http, entityPath(entityName), { q: JSON.stringify(query), limit: 500 });
}

// Helper: strip Base44 internal fields before creating a copy of a record
function stripInternalFields(record) {
  const { id, _id, created_date, updated_date, created_by, created_by_id, is_sample, ...rest } = record;
  return rest;
}

async function archiveForecastAsPriorForecast(http, companyId, actualMonths, forecastIncomeStatements, forecastLineItems) {
  if (!forecastIncomeStatements || forecastIncomeStatements.length === 0) return;
  console.log('  Syncing prior_forecast records...');

  const actualMonthSet = new Set(actualMonths.map(({ year, month }) => `${year}-${month}`));

  // Only maintain prior_forecast for future months within the next 6 months.
  const sortedActuals = [...actualMonths].sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
  const lastActual = sortedActuals[sortedActuals.length - 1];
  const futureCutoff = lastActual ? (lastActual.year * 12 + lastActual.month + 6) : Infinity;

  const futureMonths = forecastIncomeStatements.filter(fis =>
    !actualMonthSet.has(`${fis.year}-${fis.month}`) &&
    (fis.year * 12 + fis.month) <= futureCutoff
  );

  // ── 1. Bulk read: all existing prior_forecast IS (1 API call) ─────────────
  await sleep(300);
  const existingPFRaw = await filterAll(http, 'IncomeStatement', { company_id: companyId, period_type: 'prior_forecast' });
  const existingPFList = Array.isArray(existingPFRaw) ? existingPFRaw : (existingPFRaw?.items || existingPFRaw?.data || []);
  const lockedMonthSet = new Set(existingPFList.map(r => `${r.year}-${r.month}`));

  // ── 2. Bulk read: all existing forecast IS (1 API call) ───────────────────
  await sleep(300);
  const allFcstRaw = await filterAll(http, 'IncomeStatement', { company_id: companyId, period_type: 'forecast' });
  const allFcstList = Array.isArray(allFcstRaw) ? allFcstRaw : (allFcstRaw?.items || allFcstRaw?.data || []);
  const fcstISByKey = Object.fromEntries(allFcstList.map(r => [`${r.year}-${r.month}`, r]));

  // ── 3. Lock past months that don't have prior_forecast yet ────────────────
  const newlyLocking = actualMonths.filter(({ year, month }) => !lockedMonthSet.has(`${year}-${month}`));

  if (newlyLocking.length > 0) {
    // Create prior_forecast IS records (bulk, 1-2 calls)
    const toCreateIS = newlyLocking
      .map(({ year, month }) => fcstISByKey[`${year}-${month}`])
      .filter(Boolean)
      .map(r => ({ ...stripInternalFields(r), period_type: 'prior_forecast' }));

    for (let i = 0; i < toCreateIS.length; i += CHUNK_SIZE) {
      await sleep(300);
      await apiPost(http, `${entityPath('IncomeStatement')}/bulk`, toCreateIS.slice(i, i + CHUNK_SIZE));
    }

    // Lock line items: read + write per newly-locking month (unavoidable — must read Base44 forecast LI)
    for (const { year, month } of newlyLocking) {
      await sleep(300);
      const liRaw = await filterAll(http, 'FinancialLineItem', { company_id: companyId, period_type: 'forecast', year, month });
      const liList = Array.isArray(liRaw) ? liRaw : (liRaw?.items || liRaw?.data || []);
      const priorLI = liList.map(r => ({ ...stripInternalFields(r), period_type: 'prior_forecast' }));
      for (let i = 0; i < priorLI.length; i += CHUNK_SIZE) {
        await sleep(300);
        await apiPost(http, `${entityPath('FinancialLineItem')}/bulk`, priorLI.slice(i, i + CHUNK_SIZE));
      }
      console.log(`    Locked prior_forecast for ${year}-${month} (${liList.length} line items)`);
    }
  }

  // ── 4. Refresh future months: delete all unlocked prior_forecast, bulk-create fresh ──
  if (futureMonths.length > 0) {
    // Delete existing future prior_forecast IS (per month — 6 calls max)
    for (const { year, month } of futureMonths) {
      await sleep(300);
      await apiDelete(http, entityPath('IncomeStatement'), { company_id: companyId, period_type: 'prior_forecast', year, month });
    }

    // Bulk create fresh future prior_forecast IS (1-2 calls)
    const futureIS = futureMonths.map(fis => ({ ...stripInternalFields(fis), period_type: 'prior_forecast' }));
    for (let i = 0; i < futureIS.length; i += CHUNK_SIZE) {
      await sleep(300);
      await apiPost(http, `${entityPath('IncomeStatement')}/bulk`, futureIS.slice(i, i + CHUNK_SIZE));
    }

    // Delete + recreate future prior_forecast LI (per month — 6 × 2 calls max)
    for (const { year, month } of futureMonths) {
      await sleep(300);
      await apiDelete(http, entityPath('FinancialLineItem'), { company_id: companyId, period_type: 'prior_forecast', year, month });
      const monthLI = forecastLineItems.filter(li => li.year === year && li.month === month);
      const priorLI = monthLI.map(r => ({ ...stripInternalFields(r), period_type: 'prior_forecast' }));
      for (let i = 0; i < priorLI.length; i += CHUNK_SIZE) {
        await sleep(300);
        await apiPost(http, `${entityPath('FinancialLineItem')}/bulk`, priorLI.slice(i, i + CHUNK_SIZE));
      }
    }
  }

  console.log(`  prior_forecast sync complete. Locked: ${newlyLocking.length} months, Refreshed: ${futureMonths.length} months.`);
}

// ── Main push function ────────────────────────────────────────────────────────

// Pushes all data produced by sync.js to Base44.
// allData = { incomeStatements, balanceSheets, monthlyMetrics, financialLineItems,
//             reportingPeriods, forecastIncomeStatements, forecastRecords }
// sourceCompanyId = the placeholder used in transform.js (e.g. 'test-company')
async function pushToBase44(allData) {
  console.log('\nPushing data to Base44...');

  const token = await loadToken();
  const http  = makeClient(token);

  // Step 1: Find or create the company record
  const companyId = await findOrCreateCompany(http);
  if (!companyId) throw new Error('Could not get a valid company ID from Base44.');

  // Step 2: Remap company_id from placeholder to real Base44 company ID
  const remap = arr => arr.map(r => {
    const out = { ...r, company_id: companyId };
    // Strip internal _pipeline_ fields — not in Base44 schema
    Object.keys(out).forEach(k => { if (k.startsWith('_')) delete out[k]; });
    return out;
  });

  // Step 3: Build forecast ReportingPeriod records (not produced by transform.js)
  const forecastPeriods = (allData.forecastIncomeStatements || []).map(m => ({
    company_id:  companyId,
    year:        m.year,
    month:       m.month,
    label:       monthLabel(m.year, m.month),
    period_type: 'forecast',
    status:      'draft',
  }));

  // Step 4: Sync prior_forecast records before overwriting any forecast data.
  //   - Future months: prior_forecast refreshed with latest forecast (reflects current decisions)
  //   - Past months (have actuals): prior_forecast locked on first occurrence, never changed again
  const actualMonthsForArchive = (allData.incomeStatements || [])
    .map(is => ({ year: is.year, month: is.month }));
  await archiveForecastAsPriorForecast(
    http, companyId,
    actualMonthsForArchive,
    remap(allData.forecastIncomeStatements || []),
    remap(allData.forecastLineItems || [])
  );

  const results = {};

  // ── ReportingPeriods ──────────────────────────────────────────────────────
  console.log('  Pushing ReportingPeriods...');
  const actualPeriods = remap(allData.reportingPeriods || []);
  results.reportingPeriodsActual = await replaceAll(
    http, 'ReportingPeriod',
    { company_id: companyId, period_type: 'actual' },
    actualPeriods
  );
  results.reportingPeriodsForecast = await replaceAll(
    http, 'ReportingPeriod',
    { company_id: companyId, period_type: 'forecast' },
    forecastPeriods
  );

  // ── IncomeStatements (actuals) ────────────────────────────────────────────
  console.log('  Pushing IncomeStatements (actuals)...');
  results.incomeStatementsActual = await replaceAll(
    http, 'IncomeStatement',
    { company_id: companyId, period_type: 'actual' },
    remap(allData.incomeStatements || [])
  );

  // ── IncomeStatements (forecasts) ──────────────────────────────────────────
  console.log('  Pushing IncomeStatements (forecasts)...');
  results.incomeStatementsForecast = await replaceAll(
    http, 'IncomeStatement',
    { company_id: companyId, period_type: 'forecast' },
    remap(allData.forecastIncomeStatements || [])
  );

  // ── BalanceSheets (actuals) ───────────────────────────────────────────────
  console.log('  Pushing BalanceSheets (actuals)...');
  results.balanceSheets = await replaceAll(
    http, 'BalanceSheet',
    { company_id: companyId, period_type: 'actual' },
    remap(allData.balanceSheets || [])
  );

  // ── BalanceSheets (forecasts) ─────────────────────────────────────────────
  console.log('  Pushing BalanceSheets (forecasts)...');
  results.balanceSheetsForecast = await replaceAll(
    http, 'BalanceSheet',
    { company_id: companyId, period_type: 'forecast' },
    remap(allData.forecastBalanceSheets || [])
  );

  // ── MonthlyMetrics ────────────────────────────────────────────────────────
  console.log('  Pushing MonthlyMetrics...');
  results.monthlyMetrics = await replaceAll(
    http, 'MonthlyMetric',
    { company_id: companyId, period_type: 'actual' },
    remap(allData.monthlyMetrics || [])
  );

  // ── FinancialLineItems (actuals) ──────────────────────────────────────────
  console.log('  Pushing FinancialLineItems (actuals)...');
  results.financialLineItems = await replaceAll(
    http, 'FinancialLineItem',
    { company_id: companyId, period_type: 'actual' },
    remap(allData.financialLineItems || [])
  );

  // ── FinancialLineItems (forecast) ─────────────────────────────────────────
  console.log('  Pushing FinancialLineItems (forecast)...');
  results.forecastLineItems = await replaceAll(
    http, 'FinancialLineItem',
    { company_id: companyId, period_type: 'forecast' },
    remap(allData.forecastLineItems || [])
  );

  // ── Forecast records ──────────────────────────────────────────────────────
  console.log('  Pushing Forecast records...');
  results.forecastRecords = await replaceAll(
    http, 'Forecast',
    { company_id: companyId },
    remap(allData.forecastRecords || [])
  );

  // ── CashFlowRecords (actuals) ─────────────────────────────────────────────
  console.log('  Pushing CashFlowRecords (actuals)...');
  const actualCashFlow = remap((allData.cashFlowStatements || []).filter(r => r.period_type === 'actual'));
  results.cashFlowStatementsActual = await replaceAll(
    http, 'CashFlowRecord',
    { company_id: companyId, period_type: 'actual' },
    actualCashFlow
  );

  // ── CashFlowRecords (forecast) ────────────────────────────────────────────
  console.log('  Pushing CashFlowRecords (forecast)...');
  const forecastCashFlow = remap((allData.cashFlowStatements || []).filter(r => r.period_type === 'forecast'));
  results.cashFlowStatementsForecast = await replaceAll(
    http, 'CashFlowRecord',
    { company_id: companyId, period_type: 'forecast' },
    forecastCashFlow
  );

  // ── ForecastAssumptions ───────────────────────────────────────────────────
  console.log('  Upserting ForecastAssumptions...');
  await upsertForecastAssumptions(http, companyId);

  console.log('\nBase44 push complete.');
  console.log(`  Company ID: ${companyId}`);
  Object.entries(results).forEach(([k, v]) => console.log(`  ${k}: ${v} records`));

  return { companyId, ...results };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function monthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

module.exports = { pushToBase44, readForecastAssumptions, makeClient, loadToken };
