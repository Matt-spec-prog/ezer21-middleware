# Ezer21 Client Portal — Claude Code Project Briefing

## Who you're helping

Matt runs **Ezer21**, a fractional CFO firm serving startups from pre-revenue to ~$15M ARR. He provides bookkeeping, controller-level reporting, and CFO-level financial strategy. He is NOT a developer — walk him through every step in plain English. If something requires a terminal command, tell him exactly what to type.

## What we're building

A **middleware service** (Node.js) that:

1. Connects to a client's QuickBooks Online account via OAuth 2.0
2. Pulls their financial reports (P&L, Balance Sheet) from the QBO API
3. Transforms the QBO data into a structured format
4. Generates a financial forecast based on historical actuals
5. Pushes everything into a Base44 app (an existing no-code app that serves as the client dashboard)

The end result: Matt's clients log into the Base44 app and see an interactive dashboard with their actuals + editable forecast — no manual exports, no spreadsheets.

---

## What already exists

### Base44 App: "Ezer Client Interface"
- **App ID:** `69af0abd25154e7bfda8378a`
- Already has a full data model with these entity schemas:

**Company** — client record
- name, industry, stage (pre_seed through growth), fiscal_year_end, status, enabled_metrics, enabled_graphs

**IncomeStatement** — monthly P&L data
- company_id, year, month, period_type (actual/forecast)
- revenue, cost_of_revenue, gross_profit, operating_expenses
- salaries_wages, marketing_expense, rd_expense, general_admin
- depreciation_amortization, operating_income, interest_expense
- other_income_expense, income_before_tax, tax_expense, net_income, ebitda

**BalanceSheet** — monthly balance sheet
- company_id, year, month, period_type (actual/forecast)
- cash_and_equivalents, accounts_receivable, inventory, prepaid_expenses, total_current_assets
- property_equipment_net, intangible_assets, other_long_term_assets, total_assets
- accounts_payable, accrued_liabilities, short_term_debt, total_current_liabilities
- long_term_debt, other_long_term_liabilities, total_liabilities
- common_stock, retained_earnings, total_equity, total_liabilities_equity

**CashFlowStatement** — monthly cash flow
- company_id, year, month, period_type (actual/forecast)
- net_income, depreciation_amortization, changes_in_working_capital, operating_cash_flow
- capital_expenditures, other_investing, investing_cash_flow
- debt_proceeds, debt_repayments, equity_financing, financing_cash_flow
- net_change_in_cash, beginning_cash, ending_cash

**Forecast** — forward-looking projections
- company_id, year, month, scenario (base/upside/downside)
- revenue, total_expenses, net_income, operating_cash_flow
- ending_cash_balance, cash_burn, runway_months, key_assumptions

**FinancialLineItem** — granular line-level detail for drill-downs
- company_id, statement (income_statement/balance_sheet/cash_flow)
- account_name, year, month, period_type, value, sort_order, indent_level

**MonthlyMetric** — dashboard KPIs
- company_id, year, month, period_type
- cash_on_hand, monthly_burn, runway_months, revenue, net_income, mrr, net_operating_income

**KPIValue** — flexible KPI storage
- company_id, year, month, kpi_name, value, unit, period_type

**ReportingPeriod** — period metadata
- company_id, year, month, label, status (draft/final/reviewed), period_type

**CompanyUser** — maps users to companies
- company_id, user_email, role (client/readonly)

**ParsedStatement** — stores parsed statement data
- company_id, statement, data_url, month_count, first/last year/month

**UploadedReport** — file attachments
- company_id, title, description, file_url, file_type, year, month, report_type

**User** — app users
- role (admin/client/readonly)

### QuickBooks Setup
- Matt has a **QuickBooks Developer account** at developer.intuit.com
- He has created an app and has **development credentials** (Client ID and Client Secret)
- First client to connect: **Hinckley Medical Inc. dba OneDose** (NAICS 423450 — medical equipment wholesale)
- Redirect URI needs to be configured (set this during the OAuth setup step)

### Other accounts Matt has
- **GitHub** — newly created, no repos yet
- **Vercel** — does NOT have an account yet (will need to create one for deployment)

---

## Architecture

```
QuickBooks Online (Hinckley Medical's books)
        |
        | OAuth 2.0 + QBO Reporting API
        v
Middleware Service (Node.js on Vercel)
   - /api/auth/connect → starts OAuth flow
   - /api/auth/callback → receives tokens from QBO
   - /api/sync/[companyId] → pulls QBO data, transforms, generates forecast, pushes to Base44
        |
        | Base44 API (create/update entities)
        v
Base44 App (Ezer Client Interface)
   - Client logs in, sees dashboard with actuals + forecast
```

---

## Build order (step by step)

### Phase 1: Project setup
1. Create a new directory: `ezer21-middleware`
2. Initialize a Node.js project: `npm init -y`
3. Install dependencies: express, axios, dotenv, node-cron (optional, for scheduled syncs)
4. Create a `.env` file for secrets (QBO Client ID, Client Secret, Base44 API key)
5. Create `.gitignore` (node_modules, .env)
6. Initialize git, create GitHub repo, push

### Phase 2: QuickBooks OAuth
1. Build the OAuth 2.0 flow:
   - `/api/auth/connect` — redirects to Intuit's authorization URL
   - `/api/auth/callback` — receives the auth code, exchanges for access + refresh tokens
   - Store tokens securely (start with a simple JSON file or env vars; upgrade to a database later)
2. The QBO OAuth endpoints:
   - Authorization: `https://appcenter.intuit.com/connect/oauth2`
   - Token exchange: `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`
   - Scopes needed: `com.intuit.quickbooks.accounting`
3. Set the Redirect URI in the Intuit Developer Portal to match the callback URL

### Phase 3: Pull QBO Reports
1. Use stored tokens to call the QBO Reporting API:
   - `GET /v3/company/{realmId}/reports/ProfitAndLoss?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&summarize_column_by=Month`
   - `GET /v3/company/{realmId}/reports/BalanceSheet?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&summarize_column_by=Month`
2. Handle token refresh (access tokens expire every ~60 min; use refresh token to get new ones)
3. Parse the QBO report JSON format (nested Rows/ColData structure)

### Phase 4: Transform QBO data → Base44 schema
1. Map QBO P&L rows to IncomeStatement entity fields:
   - "Total Income" → revenue
   - "Total COGS" → cost_of_revenue
   - "Gross Profit" → gross_profit
   - Break out operating expenses by category where possible
   - "Net Income" → net_income
2. Map QBO Balance Sheet rows to BalanceSheet entity fields
3. Create FinancialLineItem records for every line in the QBO reports (for drill-down)
4. Calculate MonthlyMetric values (cash_on_hand, monthly_burn, runway_months, etc.)

### Phase 5: Generate forecast
1. Take the last 6-12 months of actuals
2. Apply simple trend-based projections:
   - Revenue: growth rate based on recent trend
   - Expenses: as percentage of revenue or flat trend
   - Cash: project forward based on burn rate
3. Generate 12 months of forecast IncomeStatement and Forecast records with period_type="forecast"
4. Include key_assumptions text explaining the logic
5. The forecast should be editable by the client in the Base44 dashboard (this is handled on the Base44 side)

### Phase 6: Push to Base44
1. Use the Base44 API to create/update entity records
2. API endpoint: Base44 entities API (check Base44 docs for the REST API URL)
3. Push: IncomeStatement, BalanceSheet, FinancialLineItem, MonthlyMetric, Forecast, ReportingPeriod records
4. Set period_type="actual" for QBO data, period_type="forecast" for projections
5. Upsert logic: check if a record exists for that company+year+month before creating duplicates

### Phase 7: Deploy
1. Create a Vercel account (vercel.com — sign up with GitHub)
2. Connect the GitHub repo to Vercel
3. Add environment variables in Vercel dashboard (QBO credentials, Base44 API key)
4. Deploy
5. Update the Redirect URI in the Intuit Developer Portal to the Vercel URL
6. Test the full flow: connect → pull → transform → forecast → push → view in Base44

---

## Important notes

- **Do NOT modify anything in QuickBooks** — Matt's clients' books are sacred. This is read-only.
- **Start with development/sandbox mode** in QBO, then switch to production keys when ready for real data.
- The first client to test with is **Hinckley Medical**. Once this works, it should be repeatable for any QBO-connected client.
- Matt wants the forecast to be **editable by the client** in the Base44 dashboard. The middleware generates the initial forecast; the Base44 app handles the editing UI.
- Future enhancement: drill-down into line items (hiring plan, vendor spend, etc.). Don't build this now, but design the data model to support it (FinancialLineItem entity is already there for this).
- Keep the code simple and well-commented. Matt may need to maintain this or hand it to a developer later.

---

## How to start the Claude Code session

Paste this entire document into Claude Code (or save it as a file and reference it). Then say:

> "Read this briefing and help me build Phase 1 and Phase 2. Walk me through every step — I'm not a developer. Tell me exactly what to type in my terminal."

Take it one phase at a time. Don't try to build everything at once.
