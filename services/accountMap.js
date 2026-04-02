// Account Name Mapping
//
// Maps logical forecast keys to the exact account names as they appear in
// QuickBooks Online (i.e. what shows up in financialLineItems.account_name).
//
// These names match Hinckley Medical's actual QBO chart of accounts.
// If QBO ever renames an account, update the string here — the forecast
// logic doesn't need to change.

module.exports = {
  // ── Revenue ──────────────────────────────────────────────────────────────────
  // OneDose new and renewal are split in the forecast (driven by HubSpot pipeline
  // type) but both flow to 4000 in actual QBO books. These distinct names allow
  // them to be stored as separate line items and summed correctly in the forecast.
  // The " - New" / " - Renewal" labels appear in the forecast dashboard only.
  // Actual lookback uses actualRevenueIdx (from IncomeStatement.revenue), not these keys,
  // so changing these names does not break any historical data lookback.
  SUBSCRIPTION_REVENUE:    '4000 OneDose Software Revenue - New',
  RENEWAL_REVENUE:         '4000 OneDose Software Revenue - Renewal',
  // OneWeight actual lookups use this name (must match QBO exactly)
  ONEWEIGHT_REVENUE:       '4100 OneWeight Product Sales',
  DISCOUNTS:               '4200 Discounts',
  INSTALLATION_TRAINING:   '4300 Installation & Training',
  // 4110 OneWeight Annual Service Plan Revenue — skipped (no forecast)
  // 4120 OneWeight Shipping                   — skipped (no forecast)
  // Uncategorized Income                       — skipped (no forecast)

  // ── COGS ──────────────────────────────────────────────────────────────────────
  SUPPLIES_MATERIALS:      '5000 Supplies & Materials',
  SHIPPING_FREIGHT:        '5500 Shipping, Freight & Delivery',
  CLOUD_HOSTING:           '5600 Cloud Hosting & Data Storage',
  // 5100 Cost of Labor    — no forecast
  // 5200 Warranty & Repairs — no forecast
  // 5300 Inventory Loss   — no forecast

  // ── Payroll ───────────────────────────────────────────────────────────────────
  // Hinckley uses TriNet (not QBO Payroll). Wages/benefits/taxes are
  // straightlined from the most recent actual month in the P&L.
  WAGES:                   '6001 Wages',
  BENEFITS:                '6002 Benefits',
  EMPLOYER_TAXES:          '6003 Employer Taxes',
  // 6006 Bonus Payments        — no forecast
  // 6009 Stock Option Compensation — no forecast

  // ── Operating expenses ────────────────────────────────────────────────────────
  COMMISSIONS:             '6004 Commissions',
  WORKFORCE_MGMT:          '6010 Workforce Management',
  PROFESSIONAL_SERVICES:   '6100 Professional Services',
  SOFTWARE_IT:             '6200 Software & IT',
  TRAVEL:                  '6300 Travel',
  MEALS:                   '6400 Meals',
  INSURANCE:               '6500 Insurance',
  BANK_CHARGES:            '6600 Bank Charges',
  OFFICE_SUPPLIES:         '6700 Office Supplies',
  RENT_UTILITIES:          '6710 Office Rent & Utilities',
  GENERAL_ADVERTISING:     '6801 General Advertising',
  MARKETING_PS:            '6802 Professional Services - Marketing',
  TRADESHOWS:              '6803 Tradeshows & Memberships',
  // 6900 Research & Development — no forecast

  // ── Other income / below-the-line ─────────────────────────────────────────────
  INTEREST_INCOME:         '8000 Interest Income',
  DEPRECIATION:            '7000 Depreciation',
  INTEREST_EXPENSE:        '7100 Interest',
  // 8100 Other Income          — no forecast
  // Clearing - Reimbursements  — no forecast
  // Reconciliation Discrepancies — no forecast
};
