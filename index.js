// Ezer21 Middleware — Main Server
// This is the entry point. It starts the Express web server and connects all routes.
//
// Local dev: node index.js  → starts on http://localhost:3000
// Vercel:    this file is imported as a serverless function — app.listen() is skipped

require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

// Routes
const authRoutes    = require('./routes/auth');
const syncRoutes    = require('./routes/sync');
const hubspotRoutes = require('./routes/hubspot');
const legalRoutes   = require('./routes/legal');
app.use('/api/auth',    authRoutes);
app.use('/api/sync',    syncRoutes);
app.use('/api/hubspot', hubspotRoutes);
app.use('/',            legalRoutes);

// Health check
app.get('/', (req, res) => {
  res.send(`
    <html>
    <head><title>Ezer21 Middleware</title><style>body{font-family:sans-serif;max-width:600px;margin:60px auto;padding:0 20px;}</style></head>
    <body>
      <h2>Ezer21 Middleware</h2>
      <p>Running. Available endpoints:</p>
      <ul>
        <li><a href="/api/auth/connect">Connect QuickBooks</a></li>
        <li><a href="/api/auth/base44">Connect Base44</a></li>
        <li><a href="/api/hubspot/upload">Upload Sales Pipeline</a></li>
        <li><a href="/api/sync/run">Run Full Sync (pull + push)</a></li>
        <li>/api/sync/test — pull QBO only (local dev)</li>
        <li>/api/sync/push — push to Base44 only (local dev)</li>
      </ul>
    </body>
    </html>
  `);
});

// Only start the HTTP server when running locally.
// On Vercel, the platform handles the server — calling listen() would error.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

// Export the app for Vercel's serverless function handler
module.exports = app;
