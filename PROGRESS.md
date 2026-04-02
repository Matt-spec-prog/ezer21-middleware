# Ezer21 Middleware — Build Progress

**Last updated:** 2026-04-01
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
│   └── sync.js               — Two endpoints:
│                               GET /api/sync/test  — pulls QBO, transforms, forecasts, saves locally
│                               GET /api/sync/push  — reads transformed_data.json, pushes to Base44
│
└── services/
    ├── qbo.js                — QBO API calls: getProfitAndLoss, getBalanceSheet,
    │                           getPayrollSummary, parsePayrollSummary, getDateRange
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
    └── accountMap.js         — Maps logical forecast keys → exact QBO account names
                                !! UPDATE AFTER QBO PRODUCTION CONNECTED !!
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

---

## Key Decisions Made

- **TriNet payroll**: Hinckley uses TriNet, not QBO Payroll. PayrollSummary pull
  is in the code but returns null. Wages/benefits/taxes straightline from last actual P&L month.
- **OneWeight revenue account**: 4100 (not 4050 as initially assumed)
- **OneDose renewal**: flows to 4000 in QBO actuals; split into New/Renewal
  in forecast line items for HubSpot breakdown visibility
- **accountMap.js SUBSCRIPTION_REVENUE**: maps to '4000 OneDose Software Revenue'
  (no suffix) to match real QBO account name for actual lookback in forecast engine
- **Base44 auth on Vercel**: Google OAuth redirect rejected ezer21-middleware.vercel.app
  domain. Workaround: manual token entry at /api/auth/base44/manual using token
  from local base44_token.json (valid until late April 2026)
- **SDK not used**: @base44/sdk is ESM-only; our project is CommonJS.
  We call the Base44 REST API directly via axios.
- **Actuals cutoff**: sync caps end date at 2 months ago (last day) so partially-
  closed months never appear as actuals. Client hits Sync Now when month closes.
- **Assumptions → forecast**: ForecastAssumptions record is read from Base44
  before each sync run and merged over defaults, so client edits take effect
  on the next sync without any code change.
- **Vercel Blob private store**: Blob store created as private rejected public
  access. Fixed by storing HubSpot xlsx as base64 string in KV instead.

---

## Immediate Next Steps

1. **Matt:** When March books close — client hits Sync Now to pull March actuals
   and see first real variance (March actual vs March forecast)
2. **Matt:** Upload updated HubSpot pipeline file at /api/hubspot/upload after
   each pipeline refresh, then hit Sync Now
3. **Both:** Verify Base44 Assumptions page — client can edit any assumption and
   hit Sync Now to see updated forecast numbers
4. **Matt:** Re-authenticate Base44 token before late April 2026 expiry by
   visiting /api/auth/base44/manual and pasting a fresh token

---

## Future Features (Defined, Not Yet Built)

- **Hiring plan** — client adds new hires with start date + salary; forecast
  layers incremental payroll costs on top of straightlined actuals
- **Forecast drill-down** — click any forecast line item to see plain-English
  explanation of how the number was calculated + link to relevant assumption
- **Prior forecast archiving** — period_type: 'prior_forecast' for variance analysis
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
