// Legal pages — Privacy Policy and Terms of Use (EULA)
// Served at /privacy and /terms
// These URLs are provided to Intuit during the QuickBooks production app review.

const express = require('express');
const router  = express.Router();

const STYLE = `
  <style>
    body { font-family: sans-serif; max-width: 760px; margin: 60px auto; padding: 0 24px; color: #222; line-height: 1.7; }
    h1   { font-size: 24px; margin-bottom: 4px; }
    h2   { font-size: 17px; margin-top: 32px; }
    p, li { font-size: 15px; }
    .meta { color: #666; font-size: 14px; margin-bottom: 40px; }
    a    { color: #0070f3; }
  </style>
`;

// ── GET /privacy ──────────────────────────────────────────────────────────────
router.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>Privacy Policy — Ezer21</title>${STYLE}</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="meta">Ezer21 LLC &nbsp;·&nbsp; Last updated: April 2026</p>

  <h2>1. Who We Are</h2>
  <p>Ezer21 LLC ("Ezer21," "we," "us") provides fractional CFO services and financial reporting tools
     to business clients. This policy applies to the Ezer21 financial reporting middleware (the "Service"),
     which integrates with QuickBooks Online and Base44 on behalf of authorized clients.</p>

  <h2>2. What Data We Access</h2>
  <p>The Service connects to QuickBooks Online using OAuth 2.0 and reads the following data on behalf
     of the authorized client company:</p>
  <ul>
    <li>Profit &amp; Loss reports</li>
    <li>Balance Sheet reports</li>
    <li>Payroll Summary reports (where available)</li>
  </ul>
  <p>The Service also processes sales pipeline data provided directly by the client
     in order to generate revenue forecasts.</p>

  <h2>3. How We Use the Data</h2>
  <p>Data accessed through QuickBooks Online and provided by the client is used exclusively to:</p>
  <ul>
    <li>Generate financial statements and forecasts for the client company</li>
    <li>Populate the client's private financial dashboard (hosted on Base44)</li>
  </ul>
  <p>We do not use client financial data for any other purpose, including advertising, benchmarking,
     or sale to third parties.</p>

  <h2>4. Who Can See the Data</h2>
  <p>Financial data is accessible only to:</p>
  <ul>
    <li>The authorized representatives of the client company whose QuickBooks account is connected</li>
    <li>Ezer21 personnel providing CFO services to that client</li>
  </ul>
  <p>Data is never shared with, sold to, or made accessible to any other party.</p>

  <h2>5. How Data Is Stored</h2>
  <p>OAuth tokens required to access QuickBooks Online are stored securely using Vercel KV
     (an encrypted key-value store). Financial report data is processed in memory and pushed
     to the client's private Base44 dashboard. No raw QuickBooks data is stored permanently
     in our systems.</p>

  <h2>6. Data Retention</h2>
  <p>OAuth tokens are retained only as long as the client's QuickBooks connection is active.
     Disconnecting from the Service removes the stored tokens.</p>

  <h2>7. Security</h2>
  <p>The Service uses HTTPS for all data transmission. API credentials are stored as encrypted
     environment variables and are never hardcoded or exposed in browser logs. Access to the
     Service is restricted to authorized personnel only.</p>

  <h2>8. Your Rights</h2>
  <p>Clients may request deletion of their data or revoke QuickBooks access at any time by
     contacting us at the address below or by revoking app access directly within QuickBooks Online
     (Settings → Authorized Apps).</p>

  <h2>9. Changes to This Policy</h2>
  <p>We may update this policy periodically. Continued use of the Service after changes constitutes
     acceptance of the updated policy.</p>

  <h2>10. Contact</h2>
  <p>Questions about this policy? Contact us at:<br>
     <strong>Ezer21 LLC</strong><br>
     <a href="mailto:matt@ezer21.com">matt@ezer21.com</a></p>
</body>
</html>`);
});

// ── GET /terms ────────────────────────────────────────────────────────────────
router.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>Terms of Use — Ezer21</title>${STYLE}</head>
<body>
  <h1>Terms of Use</h1>
  <p class="meta">Ezer21 LLC &nbsp;·&nbsp; Last updated: April 2026</p>

  <h2>1. Acceptance</h2>
  <p>By accessing or using the Ezer21 financial reporting middleware (the "Service"), you agree
     to these Terms of Use. If you do not agree, do not use the Service.</p>

  <h2>2. Description of the Service</h2>
  <p>The Service is a private financial reporting tool that connects to QuickBooks Online via
     the Intuit OAuth 2.0 API, reads Profit &amp; Loss, Balance Sheet, and Payroll Summary data,
     generates financial forecasts, and delivers results to a client-specific Base44 dashboard.
     The Service is operated by Ezer21 LLC on behalf of authorized business clients.</p>

  <h2>3. Authorized Use</h2>
  <p>The Service is a private, internal tool. Access is limited to:</p>
  <ul>
    <li>Ezer21 LLC personnel</li>
    <li>Authorized representatives of client companies that have engaged Ezer21 for CFO services</li>
  </ul>
  <p>Unauthorized access or use is strictly prohibited.</p>

  <h2>4. QuickBooks Integration</h2>
  <p>By connecting your QuickBooks Online account to the Service, you authorize Ezer21 to access
     your financial data as described in our <a href="/privacy">Privacy Policy</a>. You may revoke
     this access at any time through QuickBooks Online (Settings → Authorized Apps).</p>

  <h2>5. Data Accuracy</h2>
  <p>The Service reads and processes data as provided by QuickBooks Online and by the client. Ezer21
     is not responsible for inaccuracies in source data or for financial decisions made based on
     the reports and forecasts generated by the Service.</p>

  <h2>6. Disclaimer of Warranties</h2>
  <p>The Service is provided "as is" without warranties of any kind, express or implied, including
     but not limited to warranties of merchantability, fitness for a particular purpose, or
     non-infringement.</p>

  <h2>7. Limitation of Liability</h2>
  <p>To the maximum extent permitted by law, Ezer21 LLC shall not be liable for any indirect,
     incidental, special, or consequential damages arising from your use of the Service.</p>

  <h2>8. Governing Law</h2>
  <p>These Terms are governed by the laws of the State of Minnesota, without regard to conflict
     of law principles.</p>

  <h2>9. Changes to These Terms</h2>
  <p>We may update these Terms from time to time. Continued use of the Service after changes
     constitutes acceptance of the updated Terms.</p>

  <h2>10. Contact</h2>
  <p>Questions about these Terms? Contact us at:<br>
     <strong>Ezer21 LLC</strong><br>
     <a href="mailto:matt@ezer21.com">matt@ezer21.com</a></p>
</body>
</html>`);
});

module.exports = router;
