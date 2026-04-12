import { readFileSync, readdirSync, statSync, createReadStream } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';

export const SESSION_DIR = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');

/**
 * Determine session status and ID from filename
 */
export function parseSessionFile(filename) {
  const base = basename(filename);

  // Skip non-session files
  if (base === 'sessions.json' || base.endsWith('.json')) return null;
  if (base.startsWith('probe-')) return null;

  // Extract UUID from filename
  const uuidMatch = base.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (!uuidMatch) return null;

  const sessionId = uuidMatch[1];

  let status = 'active';
  let archivedAt = null;

  if (base.includes('.jsonl.reset.')) {
    status = 'reset';
    const tsMatch = base.match(/\.reset\.(.+)$/);
    if (tsMatch) archivedAt = tsMatch[1].replace(/-/g, ':').replace(/T/, 'T');
  } else if (base.includes('.jsonl.deleted.')) {
    status = 'deleted';
    const tsMatch = base.match(/\.deleted\.(.+)$/);
    if (tsMatch) archivedAt = tsMatch[1].replace(/-/g, ':').replace(/T/, 'T');
  } else if (!base.endsWith('.jsonl')) {
    return null; // Unknown format
  }

  return { sessionId, status, archivedAt, filename: base };
}

/**
 * Parse a single JSONL file and extract usage records
 */
export async function parseSessionJsonl(filepath) {
  const records = [];

  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: createReadStream(filepath, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);
        if (obj.type !== 'message') return;

        const msg = obj.message;
        if (!msg || !msg.usage) return;

        // Filter out OpenClaw internal messages (gateway-injected, delivery-mirror)
        if (msg.provider === 'openclaw') return;

        records.push({
          provider: msg.provider || 'unknown',
          model: msg.model || 'unknown',
          usage: {
            input: msg.usage.input || 0,
            output: msg.usage.output || 0,
            cacheRead: msg.usage.cacheRead || 0,
            cacheWrite: msg.usage.cacheWrite || 0,
            totalTokens: msg.usage.totalTokens || 0,
          },
          cost: {
            input: msg.usage.cost?.input || 0,
            output: msg.usage.cost?.output || 0,
            cacheRead: msg.usage.cost?.cacheRead || 0,
            cacheWrite: msg.usage.cost?.cacheWrite || 0,
            total: msg.usage.cost?.total || 0,
          },
          timestamp: obj.timestamp || null,
        });
      } catch {
        // Skip malformed lines
      }
    });

    rl.on('close', () => resolve(records));
    rl.on('error', reject);
  });
}

/**
 * Aggregate all session data
 */
export async function aggregateStats() {
  const files = readdirSync(SESSION_DIR);

  const summary = {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    totalRequests: 0,
    totalSessions: 0,
  };

  const byProvider = {};
  const byModel = {};
  const byDate = {};
  const sessions = [];

  for (const file of files) {
    const meta = parseSessionFile(file);
    if (!meta) continue;

    const filepath = join(SESSION_DIR, file);

    try {
       statSync(filepath);
    } catch {
      continue;
    }

    const records = await parseSessionJsonl(filepath);

    if (records.length === 0) continue;

    summary.totalSessions++;

    const sessionStats = {
      id: meta.sessionId,
      status: meta.status,
      archivedAt: meta.archivedAt,
      filename: meta.filename,
      providers: new Set(),
      models: new Set(),
      totalInput: 0,
      totalOutput: 0,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
      requestCount: records.length,
      firstTimestamp: null,
      lastTimestamp: null,
    };

    for (const rec of records) {
      // Update summary
      summary.totalInput += rec.usage.input;
      summary.totalOutput += rec.usage.output;
      summary.totalCacheRead += rec.usage.cacheRead;
      summary.totalCacheWrite += rec.usage.cacheWrite;
      summary.totalTokens += rec.usage.totalTokens;
      summary.totalCost += rec.cost.total;
      summary.totalRequests++;

      // Update session stats
      sessionStats.providers.add(rec.provider);
      sessionStats.models.add(rec.model);
      sessionStats.totalInput += rec.usage.input;
      sessionStats.totalOutput += rec.usage.output;
      sessionStats.totalCacheRead += rec.usage.cacheRead;
      sessionStats.totalCacheWrite += rec.usage.cacheWrite;
      sessionStats.totalTokens += rec.usage.totalTokens;
      sessionStats.totalCost += rec.cost.total;

      if (rec.timestamp) {
        if (!sessionStats.firstTimestamp || rec.timestamp < sessionStats.firstTimestamp) {
          sessionStats.firstTimestamp = rec.timestamp;
        }
        if (!sessionStats.lastTimestamp || rec.timestamp > sessionStats.lastTimestamp) {
          sessionStats.lastTimestamp = rec.timestamp;
        }
      }

      // By provider
      if (!byProvider[rec.provider]) {
        byProvider[rec.provider] = {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, totalCost: 0, requests: 0,
        };
      }
      const p = byProvider[rec.provider];
      p.input += rec.usage.input;
      p.output += rec.usage.output;
      p.cacheRead += rec.usage.cacheRead;
      p.cacheWrite += rec.usage.cacheWrite;
      p.totalTokens += rec.usage.totalTokens;
      p.totalCost += rec.cost.total;
      p.requests++;

      // By model
      const modelKey = `${rec.provider}/${rec.model}`;
      if (!byModel[modelKey]) {
        byModel[modelKey] = {
          provider: rec.provider, model: rec.model,
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, totalCost: 0, requests: 0,
        };
      }
      const m = byModel[modelKey];
      m.input += rec.usage.input;
      m.output += rec.usage.output;
      m.cacheRead += rec.usage.cacheRead;
      m.cacheWrite += rec.usage.cacheWrite;
      m.totalTokens += rec.usage.totalTokens;
      m.totalCost += rec.cost.total;
      m.requests++;

      // By date
      if (rec.timestamp) {
        const date = rec.timestamp.substring(0, 10);
        if (!byDate[date]) {
          byDate[date] = {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
            totalTokens: 0, totalCost: 0, requests: 0,
          };
        }
        const d = byDate[date];
        d.input += rec.usage.input;
        d.output += rec.usage.output;
        d.cacheRead += rec.usage.cacheRead;
        d.cacheWrite += rec.usage.cacheWrite;
        d.totalTokens += rec.usage.totalTokens;
        d.totalCost += rec.cost.total;
        d.requests++;
      }
    }

    sessions.push({
      ...sessionStats,
      providers: [...sessionStats.providers],
      models: [...sessionStats.models],
    });
  }

  sessions.sort((a, b) => {
    if (!a.lastTimestamp) return 1;
    if (!b.lastTimestamp) return -1;
    return b.lastTimestamp.localeCompare(a.lastTimestamp);
  });

  const sortedByDate = {};
  Object.keys(byDate).sort().forEach((k) => {
    sortedByDate[k] = byDate[k];
  });

  return {
    summary,
    byProvider,
    byModel,
    byDate: sortedByDate,
    sessions,
    generatedAt: new Date().toISOString(),
  };
}
