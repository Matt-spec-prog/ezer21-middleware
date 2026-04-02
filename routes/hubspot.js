// HubSpot Pipeline Upload Route
//
// Provides a simple web page where Matt can upload the HubSpot pipeline .xlsx export.
// On Vercel, the file is stored in Vercel Blob and the URL is saved to KV so the
// sync service can download it at run time.
//
// Usage:
//   1. Visit /api/hubspot/upload in your browser
//   2. Choose the .xlsx file exported from HubSpot
//   3. Click Upload
//   4. Run /api/sync/run to pull QBO + use the new pipeline data

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const storage = require('../services/storage');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB max

// ── GET /api/hubspot/upload — show upload form ────────────────────────────────
router.get('/upload', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Sales Pipeline Upload</title>
      <style>
        body { font-family: sans-serif; max-width: 500px; margin: 60px auto; padding: 0 20px; }
        h2   { color: #333; }
        input[type=file] { display: block; margin: 16px 0; }
        button { background: #0070f3; color: white; border: none; padding: 10px 24px; border-radius: 6px; font-size: 16px; cursor: pointer; }
        button:hover { background: #0060df; }
        p.note { color: #666; font-size: 14px; margin-top: 24px; }
      </style>
    </head>
    <body>
      <h2>Upload Sales Pipeline</h2>
      <p>Export your deals to <strong>.xlsx</strong>, then upload it here.<br>
         The file will be saved and used automatically on the next sync.</p>
      <form method="POST" action="/api/hubspot/upload" enctype="multipart/form-data">
        <input type="file" name="file" accept=".xlsx,.xls" required />
        <button type="submit">Upload</button>
      </form>
      <p class="note">After uploading, visit <a href="/api/sync/run">/api/sync/run</a> to trigger a full sync.</p>
    </body>
    </html>
  `);
});

// ── POST /api/hubspot/upload — receive and store the file ─────────────────────
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded. Please choose an .xlsx file.');
  }

  try {
    if (process.env.VERCEL === '1') {
      // On Vercel: store in Vercel Blob and save the URL to KV
      const { put } = require('@vercel/blob');
      const blob = await put('hubspot_pipeline.xlsx', req.file.buffer, {
        access:      'public',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      await storage.setHubspotBlobUrl(blob.url);
      console.log(`HubSpot pipeline uploaded to Vercel Blob: ${blob.url}`);

      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Upload Complete</title><style>body{font-family:sans-serif;max-width:500px;margin:60px auto;padding:0 20px;}</style></head>
        <body>
          <h2 style="color:green;">Upload Complete!</h2>
          <p>File stored successfully.</p>
          <p>Now <a href="/api/sync/run">run a full sync</a> to use the new data.</p>
        </body>
        </html>
      `);
    } else {
      // Local dev: overwrite the local file path
      const fs       = require('fs');
      const filePath = process.env.HUBSPOT_PIPELINE_FILE;
      if (!filePath) {
        return res.status(500).send('HUBSPOT_PIPELINE_FILE not set in .env');
      }
      fs.writeFileSync(filePath, req.file.buffer);
      console.log(`HubSpot pipeline saved locally to ${filePath}`);
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Upload Complete</title><style>body{font-family:sans-serif;max-width:500px;margin:60px auto;padding:0 20px;}</style></head>
        <body>
          <h2 style="color:green;">Upload Complete!</h2>
          <p>File saved locally. Now <a href="/api/sync/test">run /api/sync/test</a> to use the new data.</p>
        </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('HubSpot upload failed:', error.message);
    res.status(500).send(`Upload failed: ${error.message}`);
  }
});

module.exports = router;
