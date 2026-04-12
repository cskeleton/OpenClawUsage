import express from 'express';
import cors from 'cors';
import { aggregateStats, SESSION_DIR } from './aggregator.js';

const app = express();
const PORT = 3001;

app.use(cors());

// Cache to avoid re-scanning on every request
let cachedStats = null;
let cacheTime = 0;
const CACHE_TTL = 30_000; // 30 seconds

app.get('/api/stats', async (req, res) => {
  try {
    const now = Date.now();
    if (!cachedStats || now - cacheTime > CACHE_TTL) {
      cachedStats = await aggregateStats();
      cacheTime = now;
    }
    res.json(cachedStats);
  } catch (err) {
    console.error('Error aggregating stats:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    cachedStats = await aggregateStats();
    cacheTime = Date.now();
    res.json({ ok: true, generatedAt: cachedStats.generatedAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`OpenClaw Usage API running at http://localhost:${PORT}`);
  console.log(`Scanning sessions from: ${SESSION_DIR}`);
});
