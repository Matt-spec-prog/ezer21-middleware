// Chat Routes — Phase 8
//
// Provides a natural-language interface for clients to modify their financial
// forecast. The LLM (Claude) translates plain-English instructions into
// structured ForecastOverride records, which are applied on the next sync.
//
// Endpoints:
//   POST /api/chat/interpret  — LLM translates message → proposed overrides
//   POST /api/chat/confirm    — Client confirms → overrides saved to Base44
//   POST /api/chat/revert     — Sets one override's status to "reverted"
//   GET  /api/chat/overrides  — Lists all overrides (active + reverted)

'use strict';

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { interpretForecastInstruction } = require('../services/llm');
const { makeClient, loadToken }        = require('../services/base44');

const APP_ID     = () => process.env.BASE44_APP_ID;
const COMPANY_ID = () => process.env.BASE44_COMPANY_ID || '69cd6288f1b9adf4f7eeb809';
const BASE_URL   = 'https://base44.app/api';

// ── Helpers ───────────────────────────────────────────────────────────────────

function entityPath(name) {
  return `/apps/${APP_ID()}/entities/${name}`;
}

async function filterEntity(http, entityName, query, limit = 500) {
  const res = await http.get(entityPath(entityName), {
    params: { q: JSON.stringify(query), limit },
  });
  const data = res.data;
  return Array.isArray(data) ? data : (data?.items || data?.data || []);
}

async function createEntity(http, entityName, record) {
  const res = await http.post(entityPath(entityName), record);
  return res.data;
}

async function updateEntity(http, entityName, id, fields) {
  const res = await http.put(`${entityPath(entityName)}/${id}`, fields);
  return res.data;
}

// ── Context builder ───────────────────────────────────────────────────────────
// Builds the context object passed to the LLM. Fetches:
//   1. Current ForecastAssumptions from Base44
//   2. Most recent actual month's FinancialLineItems from Base44
//   3. Active ForecastOverrides from Base44
//   4. Temporal context (actuals cutoff, forecast range) from the 5th-of-month rule

async function buildContext(http) {
  const companyId = COMPANY_ID();

  // ── Determine actuals cutoff (5th-of-month rule, same as sync.js) ─────────
  const now = new Date();
  const closedMonthEnd = now.getDate() < 5
    ? new Date(now.getFullYear(), now.getMonth() - 1, 0)
    : new Date(now.getFullYear(), now.getMonth(), 0);
  const actualsYear  = closedMonthEnd.getFullYear();
  const actualsMonth = closedMonthEnd.getMonth() + 1;
  const actualsThrough = `${actualsYear}-${String(actualsMonth).padStart(2, '0')}-01`;

  // Next month = first forecast month
  const forecastYear  = actualsMonth === 12 ? actualsYear + 1 : actualsYear;
  const forecastMonth = actualsMonth === 12 ? 1 : actualsMonth + 1;
  const forecastStart = `${forecastYear}-${String(forecastMonth).padStart(2, '0')}-01`;

  // Forecast runs ~12 months out
  const forecastEndYear  = forecastMonth + 11 > 12
    ? forecastYear + Math.floor((forecastMonth + 11 - 1) / 12)
    : forecastYear;
  const forecastEndMonth = ((forecastMonth + 11 - 1) % 12) + 1;
  const forecastEnd = `${forecastEndYear}-${String(forecastEndMonth).padStart(2, '0')}-01`;

  const MONTH_NAMES = ['January','February','March','April','May','June',
                       'July','August','September','October','November','December'];
  const lastActualPeriod = `${MONTH_NAMES[actualsMonth - 1]} ${actualsYear}`;
  const today = now.toISOString().split('T')[0];

  // ── Fetch from Base44 in parallel ─────────────────────────────────────────
  const [assumptionsList, recentLineItems, activeOverridesList] = await Promise.all([
    filterEntity(http, 'ForecastAssumptions', { company_id: companyId }),
    filterEntity(http, 'FinancialLineItem',   {
      company_id:  companyId,
      period_type: 'actual',
      year:        actualsYear,
      month:       actualsMonth,
    }),
    filterEntity(http, 'ForecastOverride', { company_id: companyId, status: 'active' }),
  ]);

  const currentAssumptions = assumptionsList[0] || null;

  // Collapse line items to { accountName: value }
  const recentActuals = {};
  for (const li of recentLineItems) {
    if (li.statement === 'income_statement') {
      recentActuals[li.account_name] = li.value;
    }
  }

  return {
    currentAssumptions,
    recentActuals,
    lastActualPeriod,
    actualsThrough,
    forecastStart,
    forecastEnd,
    activeOverrides: activeOverridesList,
    today,
  };
}

// ── POST /api/chat/interpret ──────────────────────────────────────────────────
// Fetch context, send to LLM, return proposed overrides.
// Does NOT save anything to Base44 — client must call /confirm to commit.
router.post('/interpret', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, error: 'message is required.' });
    }

    const token   = await loadToken();
    const http    = makeClient(token);
    const context = await buildContext(http);

    const result = await interpretForecastInstruction(message.trim(), context);

    // Generate a message_id for this conversation turn (not persisted).
    // Client passes it back on /confirm so we can associate the original message.
    const message_id = crypto.randomUUID();

    res.json({
      success:    true,
      message_id,
      status:     result.status,
      summary:    result.summary,
      overrides:  result.overrides,
      clarification_question: result.clarification_question || null,
      context_used: {
        last_actual_period: context.lastActualPeriod,
        actuals_through:    context.actualsThrough,
        forecast_start:     context.forecastStart,
        active_override_count: context.activeOverrides.length,
      },
    });
  } catch (err) {
    console.error('[chat/interpret] Error:', err.message);
    const detail = err.response
      ? { status: err.response.status, data: err.response.data }
      : null;
    res.status(500).json({ success: false, error: err.message, detail });
  }
});

// ── POST /api/chat/confirm ────────────────────────────────────────────────────
// Client has reviewed the proposed overrides and confirms them.
// Saves each override as a ForecastOverride record in Base44.
// The next sync will pick them up and apply them to the forecast.
router.post('/confirm', async (req, res) => {
  try {
    const { message_id, overrides, source_message } = req.body;
    if (!Array.isArray(overrides) || overrides.length === 0) {
      return res.status(400).json({ success: false, error: 'overrides array is required and must be non-empty.' });
    }

    const token     = await loadToken();
    const http      = makeClient(token);
    const companyId = COMPANY_ID();
    const now       = new Date().toISOString();

    const saved = [];
    for (const ov of overrides) {
      if (!ov.account_name || !ov.override_type || !ov.start_date) {
        return res.status(400).json({
          success: false,
          error: `Override missing required fields (account_name, override_type, start_date). Got: ${JSON.stringify(ov)}`,
        });
      }

      const record = {
        company_id:      companyId,
        override_id:     crypto.randomUUID(),
        account_name:    ov.account_name,
        override_type:   ov.override_type,
        amount:          ov.amount != null ? Number(ov.amount) : null,
        percentage:      ov.percentage != null ? Number(ov.percentage) : null,
        start_date:      ov.start_date,
        end_date:        ov.end_date || null,
        description:     ov.description || '',
        source_message:  source_message || ov.source_message || '',
        status:          'active',
        created_at:      now,
        affects_accounts: Array.isArray(ov.affects_accounts)
          ? JSON.stringify(ov.affects_accounts)
          : (ov.affects_accounts || JSON.stringify([ov.account_name])),
      };

      await createEntity(http, 'ForecastOverride', record);
      saved.push(record);
    }

    console.log(`[chat/confirm] Saved ${saved.length} override(s) for message_id=${message_id}`);

    res.json({
      success: true,
      message: `${saved.length} override(s) saved. They will be applied on the next sync.`,
      saved_overrides: saved.map(r => ({
        override_id:  r.override_id,
        account_name: r.account_name,
        override_type: r.override_type,
        description:  r.description,
        start_date:   r.start_date,
        end_date:     r.end_date,
      })),
    });
  } catch (err) {
    console.error('[chat/confirm] Error:', err.message);
    const detail = err.response
      ? { status: err.response.status, data: err.response.data }
      : null;
    res.status(500).json({ success: false, error: err.message, detail });
  }
});

// ── POST /api/chat/revert ─────────────────────────────────────────────────────
// Sets a ForecastOverride's status to "reverted".
// The next sync will skip this override when building the forecast.
router.post('/revert', async (req, res) => {
  try {
    const { override_id } = req.body;
    if (!override_id) {
      return res.status(400).json({ success: false, error: 'override_id is required.' });
    }

    const token     = await loadToken();
    const http      = makeClient(token);
    const companyId = COMPANY_ID();

    // Find the override record by override_id
    const list = await filterEntity(http, 'ForecastOverride', {
      company_id:  companyId,
      override_id,
    });

    if (list.length === 0) {
      return res.status(404).json({ success: false, error: `No override found with override_id: ${override_id}` });
    }

    const record   = list[0];
    const recordId = record._id || record.id;

    await updateEntity(http, 'ForecastOverride', recordId, { status: 'reverted' });

    console.log(`[chat/revert] Reverted override ${override_id} (${record.account_name})`);

    res.json({
      success: true,
      message: `Override reverted. It will no longer affect the forecast on next sync.`,
      override_id,
      account_name: record.account_name,
      description:  record.description,
    });
  } catch (err) {
    console.error('[chat/revert] Error:', err.message);
    const detail = err.response
      ? { status: err.response.status, data: err.response.data }
      : null;
    res.status(500).json({ success: false, error: err.message, detail });
  }
});

// ── GET /api/chat/overrides ───────────────────────────────────────────────────
// Lists all ForecastOverride records for this company, newest first.
// Includes both active and reverted (client needs full history).
router.get('/overrides', async (req, res) => {
  try {
    const token     = await loadToken();
    const http      = makeClient(token);
    const companyId = COMPANY_ID();

    const list = await filterEntity(http, 'ForecastOverride', { company_id: companyId });

    // Sort newest first
    list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      success:  true,
      count:    list.length,
      overrides: list,
    });
  } catch (err) {
    console.error('[chat/overrides] Error:', err.message);
    const detail = err.response
      ? { status: err.response.status, data: err.response.data }
      : null;
    res.status(500).json({ success: false, error: err.message, detail });
  }
});

module.exports = router;
