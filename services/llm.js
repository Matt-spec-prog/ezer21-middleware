// LLM Interpretation Service — Phase 8
//
// Translates plain-English forecast instructions into structured ForecastOverride
// objects using Claude. Called by routes/chat.js.
//
// This service is stateless — each call is independent. Context (assumptions,
// recent actuals, active overrides) is fetched fresh by the route and passed in.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-20250514';

// ── Chart of accounts reference (for the system prompt) ───────────────────────
const CHART_OF_ACCOUNTS = `
| Account | Forecast Rule |
|---------|---------------|
| 4000 OneDose Software Revenue - New | HubSpot onedose_new pipeline |
| 4000 OneDose Software Revenue - Renewal | HubSpot onedose_renewal pipeline |
| 4100 OneWeight Product Sales | HubSpot oneweight pipeline |
| 4300 Installation & Training | Rolling 3-month avg % of gross revenue |
| 4200 Discounts | Rolling 3-month avg % of gross revenue (negative) |
| 5000 Supplies & Materials | Rolling 8-month avg % of OneWeight revenue |
| 5500 Shipping, Freight & Delivery | Rolling 12-month avg % of OneWeight revenue |
| 5600 Cloud Hosting & Data Storage | Last actual % of revenue, held constant |
| 6001 Wages | Last actual month value, straight-lined flat |
| 6002 Benefits | Last actual month value, straight-lined flat |
| 6003 Employer Taxes | Last actual month value, straight-lined flat |
| 6004 Commissions | commissions_rate × (OneDose new + renewal + OneWeight revenue) |
| 6010 Workforce Management | workforce_mgmt_per_fte × fte_count |
| 6100 Professional Services | professional_services_monthly flat |
| 6200 Software & IT | Last actual, straight-lined |
| 6300 Travel | travel_monthly flat |
| 6400 Meals | meals_monthly flat |
| 6500 Insurance | ~$927/month (GL/12 + monthly + D&O/4) |
| 6600 Bank Charges | bank_charges_monthly flat |
| 6700 Office Supplies | office_supplies_monthly flat |
| 6710 Office Rent & Utilities | Last actual, straight-lined |
| 6801 General Advertising | general_advertising_monthly flat |
| 6802 Professional Services - Marketing | Last actual, straight-lined |
| 6803 Tradeshows & Memberships | Prior year same month × (1 + tradeshow_yoy_growth_rate) |
| 8000 Interest Income | Running cash × (interest_rate_annual / 12) |
| 7000 Depreciation | Last actual, straight-lined |
| 7100 Interest | Last actual, straight-lined |
`.trim();

// ── Build the system prompt ────────────────────────────────────────────────────
function buildSystemPrompt(context) {
  const {
    currentAssumptions,
    recentActuals,      // { accountName: value } for last actual month
    lastActualPeriod,   // e.g. "March 2026"
    actualsThrough,     // "YYYY-MM-01" — last closed month
    forecastStart,      // "YYYY-MM-01" — first forecast month
    forecastEnd,        // "YYYY-MM-01" — last forecast month
    activeOverrides,
    today,
  } = context;

  const assumptionLines = currentAssumptions
    ? Object.entries(currentAssumptions)
        .filter(([k]) => !['_id', 'id', 'company_id', 'created_date', 'updated_date',
                            'created_by', 'created_by_id', 'is_sample',
                            'system_defaults_json', 'is_client_overridden', 'last_updated'].includes(k))
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n')
    : '  (not available — using defaults)';

  const actualLines = recentActuals && Object.keys(recentActuals).length > 0
    ? Object.entries(recentActuals)
        .map(([k, v]) => `  ${k}: $${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)
        .join('\n')
    : '  (not available)';

  const overrideLines = activeOverrides && activeOverrides.length > 0
    ? activeOverrides.map(ov =>
        `  - [${ov.override_id.slice(0, 8)}] ${ov.account_name}: ${ov.override_type} ` +
        `(${ov.amount != null ? '$' + ov.amount : ov.percentage + '%'}) ` +
        `from ${ov.start_date} to ${ov.end_date || 'indefinite'} — ${ov.description}`
      ).join('\n')
    : '  (none)';

  return `You are a financial forecast assistant for Hinckley Medical Inc. (OneDose / OneWeight medical device company).
Your job is to translate natural-language forecast change requests into structured override records that will modify the financial forecast.

TODAY: ${today}
LAST CLOSED ACTUAL MONTH: ${lastActualPeriod} (${actualsThrough})
FORECAST RANGE: ${forecastStart} through ${forecastEnd}
IMPORTANT: Overrides may ONLY apply to forecast months (${forecastStart} and later). Never apply to actuals.

=== CHART OF ACCOUNTS AND FORECAST RULES ===
${CHART_OF_ACCOUNTS}

=== CURRENT FORECAST ASSUMPTIONS ===
${assumptionLines}

=== MOST RECENT ACTUAL MONTH (${lastActualPeriod}) ===
${actualLines}

=== CURRENTLY ACTIVE OVERRIDES ===
${overrideLines}

=== OVERRIDE TYPES ===
- set: Replace the forecast engine's calculated value with a fixed dollar amount
- increment: Add a fixed dollar amount on top of what the forecast engine calculates
- percentage_change: Multiply the forecast engine's value by (1 + percentage/100). Use negative percentages for cuts.
- formula_change: Change a formula parameter. Currently only supported for: 6004 Commissions (percentage = new commission rate as a number, e.g. 20 for 20%)

=== COMPOUND EFFECTS ===
When the client mentions hiring someone, you MUST create overrides for ALL affected accounts:
  1. 6001 Wages — increment by (annual_salary / 12)
  2. 6002 Benefits — increment proportionally using the benefits-to-wages ratio from the most recent actual month
  3. 6003 Employer Taxes — increment proportionally using the employer-taxes-to-wages ratio from the most recent actual month
  4. 6010 Workforce Management — increment by workforce_mgmt_per_fte (currently ${currentAssumptions?.workforce_mgmt_per_fte || 178}) per new hire
  Note: 6004 Commissions is formula-driven and auto-adjusts — only override it if the instruction specifically changes the commission rate.

=== TEMPORAL LOGIC ===
- "next month" = the first day of the month after ${today.slice(0, 7)} as YYYY-MM-01
- "next quarter" = first day of the next calendar quarter after ${today.slice(0, 7)}
- "starting in [month name]" = find the next occurrence of that month as YYYY-MM-01
- "for N months" = start_date to start_date + N months - 1 month
- "for Q3" = 2026-07-01 through 2026-09-01
- "for Q4" = 2026-10-01 through 2026-12-01
- All dates must be the first of the month: YYYY-MM-01
- end_date of null means the override runs indefinitely through the end of the forecast

=== RESPONSE FORMAT ===
You MUST respond with ONLY valid JSON inside triple-backtick json fences. No other text.

If the instruction is clear:
\`\`\`json
{
  "status": "proposed",
  "overrides": [
    {
      "account_name": "exact account name from chart above",
      "override_type": "set | increment | percentage_change | formula_change",
      "amount": 4166.67,
      "percentage": null,
      "start_date": "2026-06-01",
      "end_date": null,
      "description": "Plain-English explanation shown to the client",
      "affects_accounts": ["6001 Wages", "6002 Benefits"]
    }
  ],
  "summary": "One or two sentences summarizing what changes will be made and the estimated monthly financial impact."
}
\`\`\`

If the instruction is ambiguous and you need clarification before proceeding:
\`\`\`json
{
  "status": "clarification_needed",
  "clarification_question": "Specific question to ask the client",
  "overrides": [],
  "summary": ""
}
\`\`\`

Rules:
- amount must be a positive number for expenses (the sign is determined by override_type and the account's normal sign)
- For increment on an expense account, a positive amount INCREASES the expense
- For increment on a revenue account, a positive amount INCREASES revenue
- percentage for percentage_change: -10 means "reduce by 10%", +10 means "increase by 10%"
- affects_accounts should list all account names this override is part of (for compound overrides, list all related accounts on every override record)
- Every override needs a clear, client-facing description
- Do not propose overrides for accounts with "no forecast" in the chart above
- Do not create duplicate overrides if an identical active override already exists for the same account and date range`;
}

// ── Parse LLM response ─────────────────────────────────────────────────────────
function parseLLMResponse(text) {
  // Extract JSON from ```json ... ``` fences
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }
  // Fallback: try parsing the whole text as JSON
  return JSON.parse(text.trim());
}

// ── Main export ────────────────────────────────────────────────────────────────
//
// message  — the client's plain-English instruction
// context  — {
//   currentAssumptions,   ForecastAssumptions record from Base44
//   recentActuals,        { accountName: value } for last actual month
//   lastActualPeriod,     e.g. "March 2026"
//   actualsThrough,       "YYYY-MM-01"
//   forecastStart,        "YYYY-MM-01"
//   forecastEnd,          "YYYY-MM-01"
//   activeOverrides,      array of active ForecastOverride records
//   today,                "YYYY-MM-DD"
// }
//
// Returns: { status, overrides, summary, clarification_question }
async function interpretForecastInstruction(message, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set.');

  const client = new Anthropic({ apiKey });

  const systemPrompt = buildSystemPrompt(context);

  const response = await client.messages.create({
    model:      MODEL,
    max_tokens: 2048,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: message }],
  });

  const text = response.content[0]?.text;
  if (!text) throw new Error('LLM returned empty response.');

  let parsed;
  try {
    parsed = parseLLMResponse(text);
  } catch (e) {
    throw new Error(`LLM response was not valid JSON. Raw response: ${text.slice(0, 500)}`);
  }

  // Validate structure
  if (!parsed.status) throw new Error('LLM response missing "status" field.');
  if (!Array.isArray(parsed.overrides)) parsed.overrides = [];

  return {
    status:                 parsed.status,
    overrides:              parsed.overrides,
    summary:                parsed.summary || '',
    clarification_question: parsed.clarification_question || null,
  };
}

module.exports = { interpretForecastInstruction };
