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

  // Bulk-create in chunks
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
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

// Upsert ForecastAssumptions:
//   - First push: creates record with all defaults.
//   - Subsequent pushes: updates system_defaults_json only (does not overwrite
//     client-edited fields). This keeps the "revert to defaults" button working.
async function upsertForecastAssumptions(http, companyId) {
  const defaults = buildSystemDefaults();
  const existing = await filter(http, 'ForecastAssumptions', { company_id: companyId });

  if (!existing || existing.length === 0) {
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
    const record = existing[0];
    await apiPut(http, `${entityPath('ForecastAssumptions')}/${record._id}`, {
      system_defaults_json: JSON.stringify(defaults),
      last_updated:         new Date().toISOString(),
    });
    console.log(`  ForecastAssumptions updated (system_defaults_json refreshed).`);
  }
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

  // ── BalanceSheets ─────────────────────────────────────────────────────────
  console.log('  Pushing BalanceSheets...');
  results.balanceSheets = await replaceAll(
    http, 'BalanceSheet',
    { company_id: companyId, period_type: 'actual' },
    remap(allData.balanceSheets || [])
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

module.exports = { pushToBase44 };
