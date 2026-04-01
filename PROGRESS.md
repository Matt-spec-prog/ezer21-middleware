# Ezer21 Middleware — Build Progress

**Last updated:** 2026-04-01
**GitHub repo:** https://github.com/Matt-spec-prog/ezer21-middleware
**Client:** Hinckley Medical Inc. dba OneDose
**Base44 App ID:** 69af0abd25154e7bfda8378a

---

## What This Is

A Node.js middleware service that:
1. Connects to QuickBooks Online via OAuth 2.0
2. Pulls P&L and Balance Sheet reports (Aug 2023 → present)
3. Transforms QBO data into Base44 entity records
4. Reads HubSpot pipeline deals and calculates a revenue forecast
5. Generates a full 12-month+ forecast for every P&L line item
6. Pushes everything into the Base44 "Ezer Client Interface" app

---

## Files

```
ezer21-middleware/
├── index.js                  — Express server entry point (port 3000)
├── .env                      — All secrets and config (never committed)
├── .gitignore                — Excludes node_modules, .env, tokens.json, raw data files
├── package.json              — Node.js dependencies
│
├── routes/
│   ├── auth.js               — QBO OAuth 2.0 flow (/api/auth/connect, /api/auth/callback)
│   │                           Also exports refreshAccessToken() helper
│   └── sync.js               — Sync trigger (/api/sync/test)
│                               Pulls QBO → transforms → forecasts → saves locally
│
└── services/
    ├── qbo.js                — QBO API calls (getProfitAndLoss, getBalanceSheet)
    │                           Auto-refreshes expired access tokens
    ├── transform.js          — Converts raw QBO JSON → Base44 entity records
    │                           Produces: IncomeStatement, BalanceSheet,
    │                           MonthlyMetric, FinancialLineItem, ReportingPeriod
    ├── forecast.js           — Generates 12-month forecast
    │                           Revenue from HubSpot; expenses from trailing actuals
    │                           Produces: forecastIncomeStatements, forecastRecords
    └── hubspot.js            — Reads HubSpot pipeline .xlsx export
                                OneDose: amount × probability ÷ 12 (amortized)
                                OneWeight: amount × probability (recognized at close)
                                Logs all data quality warnings
```

---

## Environment Variables (.env)

```
QBO_CLIENT_ID           — QuickBooks app client ID (currently sandbox)
QBO_CLIENT_SECRET       — QuickBooks app client secret (currently sandbox)
QBO_REDIRECT_URI        — http://localhost:3000/api/auth/callback
QBO_ENVIRONMENT         — sandbox (change to production when approved)
BASE44_API_KEY          — NOT YET FILLED IN — needed for Phase 6
BASE44_APP_ID           — 69af0abd25154e7bfda8378a
PORT                    — 3000
HUBSPOT_PIPELINE_FILE   — /Users/matthewtaylor/Desktop/Work/Ezer21/Hinckley Medical/hubspot_pipeline.xlsx
```

---

## Phases Complete

### Phase 1 — Project Setup ✅
- Node.js project initialized
- Dependencies installed: express, axios, dotenv, xlsx
- .env and .gitignore created
- Git initialized, GitHub repo created and pushed

### Phase 2 — QuickBooks OAuth ✅
- /api/auth/connect → redirects to Intuit authorization page
- /api/auth/callback → exchanges code for tokens, saves to tokens.json
- Auto token refresh when access token expires (~60 min)
- Successfully connected to QBO sandbox

### Phase 3 — Pull QBO Reports ✅
- Pulls P&L and Balance Sheet from QBO API
- Date range: 2023-08-01 → today
- Saves raw JSON to raw_reports.json (not committed)
- Currently pointed at QBO sandbox (fake landscaping company)
- QBO production access application submitted (Intuit review pending)

### Phase 4 — Transform QBO Data → Base44 Schema ✅
- Maps QBO group rows to Base44 entity fields
- Produces per-month records for:
  - 32 IncomeStatement records
  - 32 BalanceSheet records
  - 32 MonthlyMetric records
  - 102 FinancialLineItem records (drill-down detail)
  - 32 ReportingPeriod records
- Saves transformed_data.json locally (not committed)

### Phase 5 — HubSpot Pipeline Forecast ✅ (partial)
- Reads hubspot_pipeline.xlsx (1,958 rows)
- Applies deal stage probabilities:
  - Closed won: 100%, Verbal commit: 90%, Pending: 70%
  - High chance: 60%, Close <30 / Close <30 days: 55%
  - Close 30-90 days: 40%, Quote built: 30%
  - Close 90+ days: 25%, Qualified deal: 20%
  - Low chance: 10%, Closed lost: 0%
- OneDose Pipeline + OneDose Renewal: amount × prob ÷ 12, spread 12 months
- OneWeight Pipeline: amount × prob, recognized in close month
- OneWeight Renewal: excluded with warning (product doesn't renew)
- Excludes deals where column E (billing start/install date) is filled
- Currently generates 76 forecast months
- Data quality: 539 already installed, 29 no amount, 3 OW renewal anomalies
- Expense ratios currently use trailing actuals (COGS 7.3%, OpEx 46.9%)
- **Forecast logic for individual P&L accounts NOT YET BUILT** (see below)

---

## Base44 Entity Schemas

All 13 original entities exist plus 1 new one created this session:

**ForecastAssumptions** (newly created) — stores all editable forecast inputs:
- commissions_rate (0.15)
- onedose_amortization_months (12)
- discounts_lookback_months (3)
- installation_training_lookback_months (3)
- supplies_materials_lookback_months (8)
- shipping_freight_lookback_months (12)
- fte_count (14), engineer_count (3)
- workforce_mgmt_per_fte ($178)
- professional_services_monthly ($8,000)
- travel_monthly ($15,000), meals_monthly ($4,000)
- bank_charges_monthly ($500), office_supplies_monthly ($2,000)
- general_advertising_monthly ($1,000)
- tradeshow_yoy_growth_rate (0.10)
- insurance_general_liability_annual ($1,148.66)
- insurance_monthly_premium ($718.83)
- insurance_do_per_period ($451, every 4 months)
- interest_rate_annual (0.025)
- Override fields for: software IT, rent/utilities, marketing PS,
  depreciation, interest expense, cloud hosting %
- JSON fields for additional vendors: insurance, software, rent, marketing PS
- system_defaults_json (for revert-to-defaults feature)
- is_client_overridden (flag)

---

## What's Left to Build

### Phase 5 (continued) — Complete Forecast Logic ✅
All account-level forecast logic is now coded in `services/forecast.js`.
Account names are mapped in `services/accountMap.js` — **update this file
once QBO production is connected** (run /api/sync/test, inspect
`transformed_data.json → financialLineItems`, match account_names).

Rules coded:

**Revenue:**
- 4200 Discounts → rolling 3-month avg % of total revenue (negative)
- 4300 Installation & Training → rolling 3-month avg % of total revenue
- 4110 Annual Service Plan Revenue → skip for now
- 4120 OneWeight Shipping Revenue → skip for now
- Uncategorized Income → zero

**COGS:**
- 5000 Supplies & Materials → rolling 8-month % of OneWeight sales
- 5500 Shipping, Freight & Delivery → rolling 12-month % of OneWeight sales
- 5600 Cloud Hosting → prior month % of revenue, held constant
- 5100 Cost of Labor → no forecast
- 5200 Warranty & Repairs → no forecast
- 5300 Inventory Loss → no forecast

**Expenses:**
- 6001 Wages → QBO PayrollSummary, most recent month, flat
- 6002 Benefits → QBO PayrollSummary, most recent month, flat
- 6003 Employer Taxes → QBO PayrollSummary, most recent month, flat
- 6004 Commissions → 15% × (OneDose + OneWeight revenue)
- 6006 Bonus → no forecast
- 6009 Stock Options → no forecast (pending clarity)
- 6010 Workforce Mgmt → $178 × 14 FTEs = $2,492/month
- 6100 Professional Services → $8,000/month (client-editable)
- 6200 Software & IT → straightline last actual month
- 6300 Travel → $15,000/month
- 6400 Meals → $4,000/month
- 6500 Insurance → $95.72 (GL/12) + $718.83 + $112.75 (D&O/4) = ~$927.30/month
- 6600 Bank Charges → $500/month
- 6700 Office Supplies → $2,000/month
- 6710 Rent & Utilities → straightline last actual month
- 6801 General Advertising → $1,000/month
- 6802 PS - Marketing → straightline last actual month
- 6803 Tradeshows → prior year same month × 1.10 (10% YoY growth)
- 6900 R&D → no forecast for now

**Other:**
- 8000 Interest Income → cash balance × (0.025 ÷ 12)
- 8100 Other Income → no forecast
- 7000 Depreciation → straightline last actual month
- 7100 Interest Expense → straightline last actual month
- Clearing / Reconciliation → no forecast

**Rolling logic:** Month 1 uses last N actuals. Month 2 uses last (N-1) actuals + month 1 forecast. Rolls forward from there.

### Phase 5 (continued) — QBO PayrollSummary
- Add /api/sync/test-payroll endpoint
- Pull PayrollSummary report from QBO
- Extract wages, benefits, employer taxes by employee
- Verify: 14 FTEs, 3 engineers
- Hold flat as monthly payroll run rate

### Phase 6 — Push to Base44 ✅
- `services/base44.js` built — calls Base44 REST API directly (axios)
- `services/accountMap.js` built — maps logical account keys to QBO names
- New endpoint: GET /api/sync/push — reads transformed_data.json, pushes all entities
- Pushes: Company, ReportingPeriod, IncomeStatement (actuals + forecasts),
  BalanceSheet, MonthlyMetric, FinancialLineItem (actuals + forecasts),
  Forecast, ForecastAssumptions
- Replace-all strategy: deletes by company+period_type, then bulk-creates
- ForecastAssumptions: create on first push, update system_defaults_json only on subsequent runs
- **Blocked on QBO production** — sandbox data uses different account names

### Phase 6 (continued) — Account Name Mapping
- Build a mapping file: QBO account names → Base44 fields
- Currently using sandbox account names (landscaping company)
- Will be updated once QBO production credentials approved
- Hinckley Medical chart of accounts defined (see forecast logic above)

### Phase 7 — Deploy to Vercel
- Create Vercel account (sign up with GitHub)
- Connect GitHub repo to Vercel
- Add all environment variables in Vercel dashboard
- Deploy
- Update QBO redirect URI to Vercel URL
- Add monthly cron job (runs on the 5th of each month after books close)

### Future Features (Defined, Not Yet Built)
- Prior forecast archiving → period_type: 'prior_forecast' for variance analysis
- Budget vs. actual comparison view
- Revert-to-defaults button (resets ForecastAssumptions to system_defaults_json)
- KPI metrics dashboard:
  - MoM Growth Rates (rolling 3, rolling 12, OD MRR GR, 5-month CAGR)
  - Revenue Mix Ratio by product line
  - Gross Margin by product line
  - CAC breakdown
  - NRR / NDR for OneDose
  - Discount as % of applicable sales
  - Operating metrics (headcount, rev/FTE, rev/developer)
- HubSpot API live connection (replace .xlsx export)
- Drill-down by vendor for rent, marketing PS, insurance
- Multi-client support (currently built for Hinckley Medical only)

---

## Immediate Next Steps

1. **Matt:** Complete Intuit developer questionnaire → get QBO production access
2. **Matt:** Once approved, re-connect OAuth for Hinckley's real QBO company
3. **Both:** Run /api/sync/test with real QBO → inspect transformed_data.json → update services/accountMap.js with real account names
4. **Both:** Run /api/sync/push → verify data appears correctly in Base44
5. **Claude:** Build PayrollSummary pull (wages, benefits, taxes by employee — most recent month flat)
6. **Phase 7:** Vercel deployment + cron job
