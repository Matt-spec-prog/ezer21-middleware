# Ezer21 Middleware — Build Progress

**Last updated:** 2026-04-14
**GitHub repo:** https://github.com/Matt-spec-prog/ezer21-middleware
**Client:** Hinckley Medical Inc. dba OneDose
**Base44 App ID:** 69af0abd25154e7bfda8378a
**Base44 Company ID:** 69cd6288f1b9adf4f7eeb809

---

## What This Is

A Node.js middleware service that:
1. Connects to QuickBooks Online via OAuth 2.0
2. Pulls P&L and Balance Sheet reports (Aug 2023 → present)
3. Transforms QBO data into Base44 entity records
4. Reads HubSpot pipeline deals and calculates a revenue forecast
5. Generates a full 12-month+ account-level forecast for every P&L line item
6. Pushes everything into the Base44 "Ezer Client Interface" app

---

## Files

```
ezer21-middleware/
├── index.js                  — Express server entry point (port 3000)
├── .env                      — All secrets and config (never committed)
├── .gitignore                — Excludes node_modules, .env, tokens.json,
│                               base44_token.json, raw data files
├── package.json              — Node.js dependencies
│
├── routes/
│   ├── auth.js               — QBO OAuth 2.0 (/api/auth/connect, /api/auth/callback)
│   │                           Base44 Google auth (/api/auth/base44, /api/auth/base44/callback)
│   │                           Exports: refreshAccessToken(), getBase44Token()
│   ├── sync.js               — Two endpoints:
│   │                           GET /api/sync/test  — pulls QBO, transforms, forecasts, saves locally
│   │                           GET /api/sync/push  — reads transformed_data.json, pushes to Base44
│   └── drilldown.js          — GET /api/drilldown?account=NAME&month=YYYY-MM
│                               Actual months: live QBO transactions + synced total comparison
│                               Forecast months: forecast rule explanation + stored value
│
└── services/
    ├── qbo.js                — QBO API calls: getProfitAndLoss, getBalanceSheet,
    │                           getPayrollSummary, parsePayrollSummary, getDateRange,
    │                           getTransactionsByAccount (GeneralLedger report)
    │                           Auto-refreshes expired access tokens
    ├── transform.js          — Converts raw QBO JSON → Base44 entity records
    │                           Produces: IncomeStatement, BalanceSheet,
    │                           MonthlyMetric, FinancialLineItem, ReportingPeriod
    ├── forecast.js           — Full account-level forecast engine
    │                           Revenue from HubSpot; every P&L account has its own rule
    │                           Produces: forecastLineItems, forecastIncomeStatements,
    │                           forecastRecords
    │                           Rolling lookback blends actuals + prior forecast months
    ├── hubspot.js            — Reads HubSpot pipeline .xlsx export
    │                           OneDose: amount × probability ÷ 12 (amortized)
    │                           OneWeight: amount × probability (recognized at close)
    │                           Logs all data quality warnings
    ├── base44.js             — Pushes all data to Base44 via REST API
    │                           Login via saved token (base44_token.json)
    │                           Replace-all strategy per entity type + period_type
    │                           Upserts ForecastAssumptions (create once, update defaults only)
    │                           archiveForecastAsPriorForecast() — locks past months on first
    │                           actuals arrival; refreshes future months (6-month window)
    ├── drilldown.js          — getForecastExplanation(accountName) — looks up FORECAST_RULES
    │                           map; returns rule, rule_description, rule_details for every
    │                           forecasted account; null for accounts with no forecast
    └── accountMap.js         — Maps logical forecast keys → exact QBO account names
                                SUBSCRIPTION_REVENUE = '4000 OneDose Software Revenue - New'
                                RENEWAL_REVENUE      = '4000 OneDose Software Revenue - Renewal'
```

---

## Environment Variables (.env)

```
QBO_CLIENT_ID           — QuickBooks app client ID
QBO_CLIENT_SECRET       — QuickBooks app client secret
QBO_REDIRECT_URI        — http://localhost:3000/api/auth/callback
QBO_ENVIRONMENT         — sandbox | production
BASE44_API_KEY          — 9577861c84694728a0531b29e0640b59
BASE44_APP_ID           — 69af0abd25154e7bfda8378a
BASE44_EMAIL            — matt@ezer21.com (kept for reference, not used for auth)
PORT                    — 3000
HUBSPOT_PIPELINE_FILE   — /Users/matthewtaylor/Desktop/Work/Ezer21/Hinckley Medical/hubspot_pipeline.xlsx
```

---

## Authentication Notes

### QuickBooks
- Visit /api/auth/connect → approves in browser → tokens saved to tokens.json
- Access token auto-refreshes every 55 min using refresh token
- Sandbox: connected to fake landscaping company
- Production: pending Intuit developer questionnaire approval

### Base44
- Visit /api/auth/base44 → redirects to Base44 Google login → token saved to base44_token.json
- Token lasts ~4 weeks. When expired, visit /api/auth/base44 again to refresh.
- base44_token.json is gitignored (never committed)
- Token seeded from MCP preview URL on first run (valid through late April 2026)

---

## How to Run a Full Sync

```
node index.js
open http://localhost:3000/api/sync/test    ← pull QBO + generate forecast
open http://localhost:3000/api/sync/push    ← push everything to Base44
```

---

## Phases Complete

### Phase 1 — Project Setup ✅
- Node.js project initialized, dependencies installed, GitHub repo created

### Phase 2 — QuickBooks OAuth ✅
- /api/auth/connect → /api/auth/callback → tokens.json
- Auto token refresh on expiry

### Phase 3 — Pull QBO Reports ✅
- P&L and Balance Sheet pulled from QBO API
- Date range: 2023-08-01 → today
- PayrollSummary pull added (getPayrollSummary / parsePayrollSummary)
  - Hinckley uses TriNet (not QBO Payroll) → returns null → fallback to last actual

### Phase 4 — Transform QBO Data → Base44 Schema ✅
- Produces per-month records: IncomeStatement, BalanceSheet, MonthlyMetric,
  FinancialLineItem, ReportingPeriod
- Sandbox test: 33 months, 116 line items

### Phase 5 — HubSpot Pipeline Forecast ✅
- Reads hubspot_pipeline.xlsx (1,958 rows)
- Deal stage probabilities: Closed won 100% → Low chance 10%
- OneDose new + renewal: amount × prob ÷ 12, spread 12 months from close date
- OneWeight: amount × prob, recognized in close month
- OneWeight Renewal: excluded (product doesn't renew)
- Exclusion: deals where column E (install date) is filled → bookkeeper handles
- Generates 76 forecast months

### Phase 5 (continued) — Account-Level Forecast Logic ✅
All rules coded in services/forecast.js. Account names in services/accountMap.js.

**Hinckley chart of accounts and forecast rules:**

| Account | Rule |
|---------|------|
| 4000 OneDose Software Revenue - New | HubSpot onedose_new pipeline |
| 4000 OneDose Software Revenue - Renewal | HubSpot onedose_renewal pipeline |
| 4100 OneWeight Product Sales | HubSpot oneweight pipeline |
| 4300 Installation & Training | Rolling 3-month avg % of gross revenue |
| 4200 Discounts | Rolling 3-month avg % of gross revenue (negative) |
| 4110, 4120 | Skipped |
| 5000 Supplies & Materials | Rolling 8-month avg % of OneWeight revenue |
| 5500 Shipping, Freight & Delivery | Rolling 12-month avg % of OneWeight revenue |
| 5600 Cloud Hosting & Data Storage | Last actual % of revenue, held constant |
| 5100, 5200, 5300 | No forecast |
| 6001 Wages | Last actual month, flat (TriNet — no PayrollSummary) |
| 6002 Benefits | Last actual month, flat |
| 6003 Employer Taxes | Last actual month, flat |
| 6004 Commissions | 15% × (OneDose + OneWeight revenue) |
| 6006, 6009 | No forecast |
| 6010 Workforce Management | $178 × fte_count (default 14) |
| 6100 Professional Services | $8,000/month |
| 6200 Software & IT | Last actual, straight-lined |
| 6300 Travel | $15,000/month |
| 6400 Meals | $4,000/month |
| 6500 Insurance | GL/12 + monthly + D&O/4 = ~$927/month |
| 6600 Bank Charges | $500/month |
| 6700 Office Supplies | $2,000/month |
| 6710 Office Rent & Utilities | Last actual, straight-lined |
| 6801 General Advertising | $1,000/month |
| 6802 Professional Services - Marketing | Last actual, straight-lined |
| 6803 Tradeshows & Memberships | Prior year same month × 1.10 |
| 6900 R&D | No forecast |
| 8000 Interest Income | Running cash × (2.5% ÷ 12) |
| 7000 Depreciation | Last actual, straight-lined |
| 7100 Interest | Last actual, straight-lined |
| 8100, Clearing, Reconciliation | No forecast |

Rolling lookback: Month 1 uses last N actuals. Month 2 uses last (N-1) actuals +
month 1 forecast. Rolls forward through all forecast months.

### Phase 6 — Push to Base44 ✅
- services/base44.js — REST API client (axios, no SDK due to ESM/CJS conflict)
- services/accountMap.js — QBO account name mapping (needs update after production connect)
- GET /api/auth/base44 → Google login → saves token to base44_token.json
- GET /api/sync/push → reads transformed_data.json → pushes to Base44
- Pushes: Company, ReportingPeriod (actuals + forecasts), IncomeStatement
  (actuals + forecasts), BalanceSheet, MonthlyMetric, FinancialLineItem
  (actuals + forecasts), Forecast, ForecastAssumptions
- Strategy: delete by company_id + period_type, then bulk-create replacements
- ForecastAssumptions: created with defaults on first push; subsequent pushes
  update system_defaults_json only (preserves client edits)
- Sandbox test successful: 33 actual months + 76 forecast months pushed ✅
- Base44 Company ID: 69cd6288f1b9adf4f7eeb809

### Phase 6 (continued) — Base44 UI ✅
- Rebuilt from scratch — removed all Excel workbook parser / upload logic
- Pages:
  - **Financials** — month selector, full P&L with QBO section structure
    (Income → COGS → Gross Profit → OpEx → Operating Income → Other → Net Income)
  - **Forecast** — same P&L structure for forecast months, date range selector,
    combined actuals+forecast timeline view (actuals white, forecast shaded)
  - **Variance** — auto-shows most recent month with both actual and forecast data
  - **Assumptions** — editable ForecastAssumptions form, Save + Revert to Defaults
- All account names match Hinckley's exact QBO chart of accounts including numbers
- Actuals are read-only; only Assumptions page allows editing
- Sync Now button in header triggers live QBO pull without leaving the dashboard
- Date range: Aug 2023 → Dec 2027

### Phase 7 — Vercel Deployment ✅
- Deployed to: https://ezer21-middleware.vercel.app
- Token storage: Vercel KV (Upstash Redis) — replaces local tokens.json files
- Pipeline file storage: base64 in KV — upload via /api/hubspot/upload
- CORS enabled for Sync Now button cross-origin calls from Base44
- Monthly cron: 5th of each month at 8am UTC → auto-runs /api/sync/run
- Legal pages: /privacy and /terms (used for Intuit production app review)
- Manual Base44 token entry: /api/auth/base44/manual (for Vercel deployments)
- QBO production connected: Realm ID 9130357035627136 (Hinckley Medical)
- Intuit developer questionnaire approved same day ✅
- First real sync: 31 actual months (Aug 2023–Feb 2026) + 76 forecast months

### Phase 7 (continued) — Bug Fixes and Forecast Corrections ✅

**accountMap.js double-counting bug fixed:**
- SUBSCRIPTION_REVENUE and RENEWAL_REVENUE were both mapped to `'4000 OneDose Software Revenue'`
  (same string). sumAccounts() iterated REVENUE_ACCOUNTS twice with the same key → OneDose
  new revenue doubled, renewal revenue lost entirely. Fixed by giving each a distinct name:
  - `SUBSCRIPTION_REVENUE: '4000 OneDose Software Revenue - New'`
  - `RENEWAL_REVENUE: '4000 OneDose Software Revenue - Renewal'`
- These keys are used only for HubSpot pipeline values (never for actual lookback), so safe to rename.
- Also added FORECAST_ONLY_ACCOUNTS Set in routes/drilldown.js to gracefully handle drill-down
  requests on these split accounts for actual months.

**Actuals cutoff changed:**
- Was: 2 months ago (hardcoded lag). Changed to: last day of last month.
- Matt (not the middleware) controls when the books are closed. Sync Now should pull through
  the end of last month every time.

**Forecast intermediate calculations fixed:**
- Gross Profit, Operating Income, and Net Income subtotals on the Forecast page were wrong.
- Root cause: UI was summing raw FinancialLineItem records instead of reading IncomeStatement
  entity fields. QBO categorizes some accounts differently in summary vs. detail, causing a ~$1,451
  gap between summed line items and QBO's own subtotals.
- Fix: Base44 UI now reads subtotals from IncomeStatement entity fields (same as it does for
  actuals on the Financials page).

**Financials page default month fixed:**
- Page was defaulting to February instead of March.
- Root cause: Base44 query hit IncomeStatement (has both actual + forecast records) → picked up
  March forecast IS. Fixed by querying ReportingPeriod (period_type='actual') for the default
  month selector — only actual months exist there.

**Financials page Total Income fixed:**
- Total Income was summing 6xxx FinancialLineItems ($295,768) instead of reading
  IncomeStatement.operating_expenses ($294,317) — $1,451 discrepancy.
- Fixed by directing Base44 to copy data-fetching logic from the Forecast page actuals view.

**Vercel function timeout increased:**
- vercel.json maxDuration: 60 → 300 seconds (prior_forecast archiving adds ~90s to sync).

### Phase 7 (continued) — Prior Forecast Archiving ✅

New `archiveForecastAsPriorForecast()` function in services/base44.js. Called at the start of
`pushToBase44()` before any replaceAll steps.

**Two behaviors:**
- **Past months** (month has actuals): lock once — write prior_forecast IS + LI records the
  first time actuals arrive, never update them again. Variance tab always shows the original
  forecast at time of booking.
- **Future months** (within 6-month window): refresh every sync — delete + recreate prior_forecast
  IS + LI so assumption changes flow through to the variance view.

**Implementation:**
- 2 bulk reads upfront (all existing prior_forecast IS, all current forecast IS in one call each)
  to minimize API round-trips.
- 300ms sleep between every write operation to avoid Base44 429 rate limits.
- Only processes the next 6 future months (not all 76) to keep sync time reasonable.

**Base44 rate limit fixes (two rounds):**
- Round 1: 200ms delay between months but ~5 rapid calls within each month. With 76 months =
  300+ rapid calls → 429s. Fixed by limiting future months to 6-month window.
- Round 2: Still hitting 429 on FinancialLineItem/bulk. Fixed by restructuring to bulk reads
  upfront + 300ms sleep before EVERY write.

### Phase 7 (continued) — Balance Sheet Page ✅

No middleware changes needed — QBO balance sheet data was already being pulled and stored:
- BalanceSheet entity: monthly summary totals (Total Assets, Total Liabilities, Total Equity)
- FinancialLineItem: statement='balance_sheet', 39 line items per month

March 2026 confirmed balanced: Total Assets = Total L+E = $1,515,307.58

Base44 UI changes (prompted separately):
- **Current Month page**: added balance sheet summary section (Total Assets, Total L+E, Cash)
- **Balance Sheet page**: full historical balance sheet with all line items, same structure as P&L

### Phase 7.5 — Transaction Drill-Down ✅

New endpoint: `GET /api/drilldown?account=ACCOUNT_NAME&month=YYYY-MM[&statement=balance_sheet]`

**For actual P&L months:**
- Calls `getTransactionsByAccount()` → QBO GeneralLedger report, finds account section by name
- Fetches synced total from Base44 FinancialLineItem for comparison
- Returns: live_total, synced_total, has_variance, variance_message, transactions[]
- Each transaction: date, type, doc_number, vendor_or_entity, memo, amount

**For balance sheet accounts** (`statement=balance_sheet`):
- Same QBO GeneralLedger call; returns synced_balance (ending balance) + transaction_net (monthly activity)
- No variance warning — ending balance and monthly activity are different measures by design

**For forecast months:**
- Returns FORECAST_RULES explanation: rule, rule_description, rule_details
- Fetches stored forecast value from Base44 FinancialLineItem
- Every forecasted account has a plain-English rule_description

**Error handling:**
- QBO auth expired (401/403) → instructs to re-authenticate
- QBO rate limit (429) → try again message
- Forecast-only split accounts (OneDose - New, OneDose - Renewal) → explanatory message
- No forecast rule → `error: 'no_forecast'` message
- Account not found → graceful `account_not_found` response

**QBO GeneralLedger implementation notes (several bugs fixed before working):**
- `TransactionList` report's `account` param filters by bank/cash account side, not expense
  category — returns all company transactions regardless of account. Switched to `GeneralLedger`.
- QBO GL does not support `account` filter param — passing it causes 400. Fetch full month GL,
  find section by name.
- GL response structure: Section rows per account, each containing a "Beginning Balance" row,
  transaction Data rows, and a "Total" row. Date column at index 0 contains "Beginning Balance"
  for the header row — must filter by `/^\d{4}-\d{2}-\d{2}$/` to skip non-transaction rows.
- GL has single `subt_nat_amount` column (ColTitle "Amount") — no separate debit/credit columns.
  Positive = debit (expense/asset increase), negative = credit.
- Blank section headers in the GL (QBO placeholder sections) must be skipped — every string
  `.includes("")` so a blank header would falsely match any account search.
- Matching logic: exact name match first (`header === accountName`), then try stripping the
  leading account number (`header === accountNameNoNum`). Recurse into parent group sections.

**Files added/modified:**
- `services/qbo.js` — `getTransactionsByAccount()` using GeneralLedger
- `services/drilldown.js` — new; `getForecastExplanation()` with full FORECAST_RULES map
- `routes/drilldown.js` — new; GET /api/drilldown handler with balance_sheet support
- `index.js` — registered `/api/drilldown` route

### Phase 7c — Cash Flow Statement ✅

New `services/cashflow.js` — generates the indirect method cash flow statement from existing
P&L and Balance Sheet data. No new QBO API calls — purely derived.

**Entity:** `CashFlowRecord` (new — distinct from pre-existing `CashFlowStatement` which had wrong schema)

**Fields pushed per month:**
- `net_income` — from actual QBO IncomeStatement (or forecast IS for future months)
- Asset changes: AR, inventory, other current assets, fixed assets, other assets
- Liability changes: AP, credit cards, interest payable, deferred revenue, OneWeight warranty, other current liabilities
- Financing: long-term debt, APIC stock options, opening balance equity (+ CS/SAFE residual)
- Totals: net_cash_operating, net_cash_financing, net_cash_change
- Verification: actual_cash_change (from BS), cash_variance

**Account classification (all using BalanceSheet summary fields, not FLI prefix matching):**
- Fixed assets: `property_equipment_net` = QBO FixedAssets group (1510/1520/1590) ✓
- Credit cards: `accrued_liabilities` = QBO CreditCards group (2410/2420/2430/2440) ✓
- Long-term debt: `long_term_debt` = QBO LongTermLiabilities (Loans, CN-1 through CN-14) ✓
- CS-/SAFE- accounts: in QBO Equity group → captured via equity residual (see below)
- FLI prefix lookups for named lines: '1200' inventory, '2010' interest payable,
  '2100' deferred revenue, '2200' OneWeight warranty, '3400' APIC ✓
- OCA: derived as `total_current_assets - cash - AR` (field `other_current_assets`
  was never stored in BalanceSheet entity — backed out from totals) ✓

**CS/SAFE equity residual fix:**
CS- (Convertible Securities) and SAFE- accounts are classified by QBO in the Equity group,
not LongTermLiabilities. They appear in `total_equity` delta but not `long_term_debt` delta.
Fix: `equity_residual = total_equity_delta − net_income − ΔAPIC − ΔOBE_FLI`
This algebraically isolates CS/SAFE cash inflows and folds them into `opening_balance_equity_change`.

**Bugs fixed during build:**

1. **Forecast IS overwriting actual IS in isMap**: HubSpot deal close dates fall in already-closed
   months (e.g. Sep 2024), so `forecastIncomeStatements` contains entries for those months.
   Since the forecast array came AFTER actual in the concatenated input, forecast net_income values
   were overwriting actual QBO values. The CashFlow net_income diverged from IncomeStatement for
   all months after the first HubSpot deal close date (~Aug 2024).
   Fix: actuals always win — `if (!isMap[key] || is.period_type === 'actual') isMap[key] = is`

2. **OCA always zero**: `other_current_assets` is computed in transform.js but not stored in the
   BalanceSheet entity record. So `cBS?.other_current_assets` was always undefined → 0, causing
   inventory_change and other_current_assets_change to silently cancel each other.
   Fix: `oca_total = total_current_assets - cash_and_equivalents - accounts_receivable`

**Cash flow results (actual months):**
- 30 of 31 months reconcile to exactly $0 variance vs actual cash change on Balance Sheet
- January 2026: $21,750 variance — expected year-end retained earnings sweep (QBO journal entry
  reclassifies Net Income → Retained Earnings, a non-cash equity reclassification)

**Base44 UI:** Cash Flow tab added with single-month and timeline views. Actual months white,
forecast months shaded. Clickable account rows drill down to `/api/drilldown?statement=balance_sheet`.
Fonts and styling match Financials/Forecast pages exactly.

**sync.js changes:** `generateCashFlowStatements` called after forecast, passing combined
actual+forecast IS and FLI arrays. `cashFlowStatements` count included in all endpoint responses.

**base44.js changes:** `CashFlowRecord` pushed in two `replaceAll` passes (actual, then forecast).

### Phase 7d — 5th-of-Month Actuals Rule ✅

Enforced in both `routes/sync.js` and `services/cashflow.js`:
- **Before the 5th**: last month's books may not be finalized → QBO pull caps at end of 2 months ago
- **On/after the 5th**: last month is closed → QBO pull caps at end of last month (prior behavior)

This prevents a sync on (e.g.) April 2 from pulling March data as "actual" before the books close.
The monthly cron already runs on the 5th at 8am UTC, so it naturally satisfies this rule.

Both `customEnd` in sync.js and `isActualMonth()` in cashflow.js use identical logic:
```javascript
const closedMonthEnd = now.getDate() < 5
  ? new Date(now.getFullYear(), now.getMonth() - 1, 0)  // end of 2 months ago
  : new Date(now.getFullYear(), now.getMonth(), 0);     // end of last month
```

### Phase 7.5b — Base44 UI Drill-Down Panel ✅

Base44 app updated via MCP tool:
- Every individual account row on Financials, Forecast, and Variance pages is clickable
  (subtle hover highlight + pointer cursor)
- Section headers and computed subtotals (Gross Profit, Net Income, Total Assets, etc.)
  remain non-clickable
- Slide-out panel opens on click:
  - **Actual months**: transaction table (date, type, doc#, vendor, memo, amount) + amber
    variance banner if QBO total differs from last sync
  - **Forecast months**: forecast value + plain-English rule explanation + collapsible rule details
  - **Balance sheet accounts**: same transaction table + ending balance vs. monthly activity note
- Variance page: clickable indicators on both actual and forecast value cells
- Loading spinner while middleware fetches from QBO (1-3 seconds for live calls)
- User-friendly error messages for auth expired, account not found, network errors

---

## Key Decisions Made

- **TriNet payroll**: Hinckley uses TriNet, not QBO Payroll. PayrollSummary pull
  is in the code but returns null. Wages/benefits/taxes straightline from last actual P&L month.
- **OneWeight revenue account**: 4100 (not 4050 as initially assumed)
- **OneDose revenue split**: QBO has one account `4000 OneDose Software Revenue` for both new
  and renewal. Forecast splits it into New (`- New`) and Renewal (`- Renewal`) for HubSpot
  pipeline visibility. Actual lookback for rolling averages uses the parent QBO account name.
- **accountMap.js SUBSCRIPTION_REVENUE / RENEWAL_REVENUE**: must use distinct strings ending in
  ` - New` and ` - Renewal` to prevent sumAccounts() double-counting. These keys are only used
  for HubSpot pipeline values, not for QBO actual lookback.
- **FORECAST_ONLY_ACCOUNTS**: the New/Renewal split accounts don't exist in QBO. Drill-down
  requests for these in actual months return an explanatory message, not a QBO error.
- **Base44 auth on Vercel**: Google OAuth redirect rejected ezer21-middleware.vercel.app
  domain. Workaround: manual token entry at /api/auth/base44/manual using token
  from local base44_token.json (valid until late April 2026)
- **SDK not used**: @base44/sdk is ESM-only; our project is CommonJS.
  We call the Base44 REST API directly via axios.
- **Actuals cutoff (5th-of-month rule)**: sync caps end date based on day of month. Before the
  5th: cap at end of 2 months ago (last month's books not final). On/after the 5th: cap at end of
  last month. The cron runs on the 5th at 8am UTC so it always satisfies this rule naturally.
- **Cash flow uses BS summary fields, not FLI prefix matching**: BalanceSheet SUMMARY entity
  aggregates accounts into QBO group totals. Using `bsDelta('property_equipment_net')` captures
  all fixed assets (1510/1520/1590) correctly; using FLI prefix '1500' would miss them.
- **CS/SAFE in QBO Equity, not LongTermLiabilities**: equity residual formula isolates CS/SAFE
  cash inflows that would otherwise be invisible to the cash flow statement.
- **`other_current_assets` not stored in BalanceSheet entity**: transform.js computes it from QBO
  but doesn't include it in the record push. OCA is backed out from `total_current_assets - cash - AR`.
- **Forecast IS overwrites actual IS in cash flow**: when HubSpot deals have close dates in
  already-closed months, `forecastIncomeStatements` contains forecast entries for those months.
  isMap must give priority to actual IS records to prevent forecast net_income from appearing in
  the cash flow statement for months that have real QBO data.
- **Assumptions → forecast**: ForecastAssumptions record is read from Base44 before each sync
  run and merged over defaults, so client edits take effect on the next sync without code change.
- **Prior forecast locking**: future months refresh on every sync (assumption changes flow
  through); past months lock permanently once actuals arrive. 6-month window for future months
  prevents processing all 76 forecast months on every sync.
- **Subtotals from IncomeStatement, not summed**: Gross Profit, Operating Income, Net Income
  shown in UI must come from IncomeStatement entity fields — not summed from FinancialLineItem
  records. QBO summary-level and detail-level totals diverge by ~$1,451/month.
- **Vercel Blob private store**: Blob store created as private rejected public
  access. Fixed by storing HubSpot xlsx as base64 string in KV instead.
- **Vercel maxDuration**: increased from 60s to 300s to accommodate prior_forecast archiving
  (~90s added to full sync).
- **QBO drill-down uses GeneralLedger, not TransactionList**: TransactionList `account` param
  filters by the bank account side of transactions — all P&L accounts share the same checking
  account so every drill-down returned the entire company ledger. GeneralLedger organises by
  account section and returns only entries posted to the requested account.
- **GL section matching**: GL sections have blank placeholder headers that falsely match any
  string (`.includes("")` = always true). Must skip blank headers and use exact name match only.
- **GL row filtering**: GL sections contain "Beginning Balance" and "Total" rows alongside
  real transactions. Filter by `/^\d{4}-\d{2}-\d{2}$/` on the date column to skip non-transactions.

---

## Immediate Next Steps

1. **Matt:** Re-authenticate Base44 token before late April 2026 expiry by visiting
   /api/auth/base44/manual and pasting a fresh token
2. **Matt:** Upload updated HubSpot pipeline file at /api/hubspot/upload after each pipeline
   refresh, then hit Sync Now
3. **Monthly routine:** Hit Sync Now on/after the 5th of each month to pull prior month actuals
   and update the variance comparison (actual vs prior_forecast)

---

## Future Features (Defined, Not Yet Built)

- **Hiring plan** — client adds new hires with start date + salary; forecast
  layers incremental payroll costs on top of straightlined actuals
- **Drill-down overrides** — `overrides_applied` array in forecast drill-down is currently
  always empty; will be populated when Phase 8 (LLM override layer) is built
- **Budget vs. actual** comparison view
- **KPI metrics dashboard:**
  - MoM Growth Rates (rolling 3, rolling 12, OD MRR GR, 5-month CAGR)
  - Revenue Mix Ratio by product line
  - Gross Margin by product line
  - CAC breakdown
  - NRR / NDR for OneDose
  - Discount as % of applicable sales
  - Operating metrics (headcount, rev/FTE, rev/developer)
- **HubSpot API live connection** (replace .xlsx export)
- **Drill-down by vendor** for rent, marketing PS, insurance
- **Multi-client support** (currently built for Hinckley Medical only)
