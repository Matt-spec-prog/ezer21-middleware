// Ezer21 Middleware — Main Server
// This is the entry point. It starts the Express web server and connects all routes.

require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

// Routes
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);

// Health check — visit http://localhost:3000 to confirm the server is running
app.get('/', (req, res) => {
  res.send('Ezer21 Middleware is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
