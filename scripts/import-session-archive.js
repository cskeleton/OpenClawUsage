#!/usr/bin/env node
/**
 * 把 OpenClaw 2026.8.2 存储迁移打包到 agents/＊/session-sqlite-import-archive/ 的
 * 历史会话 JSONL 导入统计（生成 source 快照，走既有的 imports 合并通道）。
 *
 * 背景：迁移把旧会话 JSONL 归档（文件名 `.imported-<ms>` 后缀），但只有部分会话
 * 进了新 SQLite 库；未被导入也不在最老 JSONL 时代冻结缓存里的会话会从统计中丢失。
 * 本脚本解析归档目录，跳过已在 SQLite/legacy 缓存中的会话，把剩余会话聚合为
 * 日级 bucket 快照写入 `cache/openclaw-usage/imports/archive-import.json`。
 * 需在 openclaw-usage-sync.json 的 imports.allowedSourceIds 中加入 "archive-import"。
 *
 * 用法：node scripts/import-session-archive.js [--config-dir <dir>] [--dry-run]
 * 幂等：每次全量重建快照文件；重复运行不会重复计数（贡献 id 稳定）。
 */
import { createReadStream, existsSync, readdirSync, readFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { writeTextFileAtomic } from '../json-atomic-write.js';
import { validateSourceSnapshot } from '../sync-snapshot.js';

const SOURCE_ID = 'archive-import';
const SOURCE_LABEL = 'session 归档导入';
const IMPORTS_SUBDIR = join('cache', 'openclaw-usage', 'imports');
const STATS_CACHE_FILE = join('cache', 'openclaw-usage', 'stats-v2.json');
const ARCHIVE_DIR_NAME = 'session-sqlite-import-archive';

// agent_main_<name>.<uuid>[-topic-<thread>].jsonl.imported-<ms>；trajectory 变体不匹配（.trajectory.jsonl）
// Matrix 线程会话在 uuid 后带 -topic- 后缀，属于 main agent 的真实会话，一并导入
const SESSION_FILE_RE = /\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-topic-[^/]*)?\.jsonl\.imported-(\d+)$/;

function parseArgs(argv) {
  const args = { configDir: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config-dir') args.configDir = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else throw new Error(`未知参数: ${argv[i]}`);
  }
  return args;
}

function resolveConfigDir(explicit) {
  return explicit
    || process.env.OPENCLAW_CONFIG_DIR
    || process.env.OPENCLAW_DIR
    || join(homedir(), '.openclaw');
}

/** 收集某 agent 当前 SQLite 库里的全部会话 id（库不存在则空集） */
function collectDbSessionIds(dbPath) {
  const ids = new Set();
  if (!existsSync(dbPath)) return ids;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return ids;
  }
  try {
    for (const r of db.prepare('select distinct session_id id from transcript_events').all()) ids.add(r.id);
  } catch { /* 表缺失 */ }
  try {
    for (const r of db.prepare('select distinct session_id id from session_transcript_archives').all()) ids.add(r.id);
  } catch { /* 表缺失 */ }
  try {
    for (const r of db.prepare('select id from session_windows').all()) ids.add(r.id);
  } catch { /* 表缺失 */ }
  db.close();
  return ids;
}

/** 最老 JSONL 时代冻结在持久缓存里的 legacy 会话 id */
function collectLegacySessionIds(configDir) {
  const ids = new Set();
  try {
    const cache = JSON.parse(readFileSync(join(configDir, STATS_CACHE_FILE), 'utf-8'));
    for (const [key, file] of Object.entries(cache.files || {})) {
      if (key.startsWith('legacy:') && file.session?.id) ids.add(file.session.id);
    }
  } catch { /* 缓存缺失或损坏 */ }
  return ids;
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function isZeroUsage(u) {
  return !u.input && !u.output && !u.cacheRead && !u.cacheWrite && !u.totalTokens;
}

/**
 * 解析单个归档 JSONL，聚合为 { buckets, firstTimestamp, lastTimestamp, records }。
 * 解析口径与旧 JSONL 扫描器（SQLite 迁移前的 aggregator.js）一致：
 * type==='message'、message.usage 存在、provider!=='openclaw'（内部镜像过滤）。
 */
async function parseArchivedSession(filepath) {
  const buckets = new Map();
  let firstTimestamp = null;
  let lastTimestamp = null;
  let records = 0;

  const rl = createInterface({
    input: createReadStream(filepath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'message') continue;
    const msg = obj.message;
    if (!msg || !msg.usage) continue;
    if (msg.provider === 'openclaw') continue;

    const usage = {
      input: msg.usage.input || 0,
      output: msg.usage.output || 0,
      cacheRead: msg.usage.cacheRead || 0,
      cacheWrite: msg.usage.cacheWrite || 0,
      totalTokens: msg.usage.totalTokens || 0,
    };
    if (isZeroUsage(usage)) continue;
    const cost = {
      input: msg.usage.cost?.input || 0,
      output: msg.usage.cost?.output || 0,
      cacheRead: msg.usage.cost?.cacheRead || 0,
      cacheWrite: msg.usage.cost?.cacheWrite || 0,
      total: msg.usage.cost?.total || 0,
    };
    const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null;
    const date = timestamp ? timestamp.slice(0, 10) : null; // UTC 日，与 legacy 桶语义一致
    if (timestamp) {
      if (!firstTimestamp || timestamp < firstTimestamp) firstTimestamp = timestamp;
      if (!lastTimestamp || timestamp > lastTimestamp) lastTimestamp = timestamp;
    }

    const provider = typeof msg.provider === 'string' ? msg.provider : 'unknown';
    const model = typeof msg.model === 'string' ? msg.model : 'unknown';
    const key = `${date}|${provider}|${model}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        date,
        provider,
        model,
        usage: emptyUsage(),
        openclawCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        requests: 0,
      };
      buckets.set(key, bucket);
    }
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) bucket.usage[f] += usage[f];
    for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) bucket.openclawCost[f] += cost[f];
    bucket.requests++;
    records++;
  }
  return { buckets: [...buckets.values()], firstTimestamp, lastTimestamp, records };
}

/**
 * 构建归档导入快照（不落盘）。
 * @param {{ configDir: string }} options
 * @returns {Promise<{ snapshot: object, stats: { agents: number, archivedSessions: number, skippedKnown: number, imported: number, empty: number } }>}
 */
export async function buildArchiveSnapshot({ configDir }) {
  const agentsDir = join(configDir, 'agents');
  const legacyIds = collectLegacySessionIds(configDir);
  const stats = { agents: 0, archivedSessions: 0, skippedKnown: 0, imported: 0, empty: 0 };
  const contributions = [];

  for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const archiveDir = join(agentsDir, agent.name, ARCHIVE_DIR_NAME);
    if (!existsSync(archiveDir)) continue;
    stats.agents++;
    const dbIds = collectDbSessionIds(join(agentsDir, agent.name, 'agent', 'openclaw-agent.sqlite'));

    for (const file of readdirSync(archiveDir)) {
      const m = file.match(SESSION_FILE_RE);
      if (!m) continue;
      const [, sessionId, importedMs] = m;
      stats.archivedSessions++;
      if (dbIds.has(sessionId) || legacyIds.has(sessionId)) {
        stats.skippedKnown++;
        continue;
      }
      const parsed = await parseArchivedSession(join(archiveDir, file));
      if (!parsed.records) {
        stats.empty++;
        continue;
      }
      contributions.push({
        contributionId: createHash('sha256')
          .update(`archive-import\0${agent.name}\0${sessionId}`)
          .digest('hex'),
        session: {
          id: sessionId,
          status: 'done',
          archivedAt: new Date(Number(importedMs)).toISOString(),
        },
        firstTimestamp: parsed.firstTimestamp,
        lastTimestamp: parsed.lastTimestamp,
        buckets: parsed.buckets,
        hasRecords: true,
      });
      stats.imported++;
    }
  }

  const snapshot = {
    version: 1,
    kind: 'openclaw-usage-source-contributions',
    scope: 'local-only',
    source: { id: SOURCE_ID, label: SOURCE_LABEL },
    revision: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    contributions,
  };
  // 自检：过一遍与加载侧相同的校验（伪造仅授权本 source 的 syncConfig）
  validateSourceSnapshot(snapshot, { imports: { allowedSourceIds: [SOURCE_ID] } });
  return { snapshot, stats };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configDir = resolveConfigDir(args.configDir);
  const { snapshot, stats } = await buildArchiveSnapshot({ configDir });
  const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  console.log(`configDir: ${configDir}`);
  console.log(`agents: ${stats.agents} | 归档会话: ${stats.archivedSessions} | 已知跳过: ${stats.skippedKnown} | 无用量跳过: ${stats.empty} | 导入: ${stats.imported}`);
  console.log(`快照大小: ${(bytes / 1024).toFixed(1)} KiB`);
  if (args.dryRun) {
    console.log('dry-run，未写入。');
    return;
  }
  const importDir = join(configDir, IMPORTS_SUBDIR);
  await mkdir(importDir, { recursive: true });
  const target = join(importDir, `${SOURCE_ID}.json`);
  await writeTextFileAtomic(target, JSON.stringify(snapshot));
  console.log(`已写入 ${target}`);
  console.log(`请确认 openclaw-usage-sync.json 的 imports.allowedSourceIds 包含 "${SOURCE_ID}"；下次统计请求自动合并。`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('导入失败:', err?.message || err);
    process.exit(1);
  });
}
