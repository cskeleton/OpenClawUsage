import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { getOpenClawConfigDir } from './openclaw-config.js';
import { buildContributionFromRecords } from './stats-contribution.js';

/**
 * OpenClaw 2026.8.2+ 会话数据源：只读访问 agents/main/agent/openclaw-agent.sqlite。
 * 取代旧版对 sessions/*.jsonl 的目录扫描。
 */

/** 数据库不存在/不可读时的统一错误码语义由调用方（stats-service）处理 */
export function getSqlitePath() {
  return join(getOpenClawConfigDir(), 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
}

/**
 * 以只读模式打开数据库；不存在时返回 { exists: false }。
 * WAL 活跃写场景下 node:sqlite 的同步语句串行执行，跨语句快照一致性
 * 由 manifest 身份四元组在下一轮增量中兜底。
 * @returns {{ exists: boolean, db?: DatabaseSync, identity?: object }}
 */
export function openSqliteReadOnly() {
  const path = getSqlitePath();
  let st;
  try {
    st = statSync(path);
  } catch {
    return { exists: false };
  }
  if (!st.isFile()) return { exists: false };
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    let schemaVersion = 0;
    try {
      schemaVersion = db.prepare('PRAGMA schema_version').get()?.schema_version ?? 0;
    } catch {
      schemaVersion = 0;
    }
    return {
      exists: true,
      db,
      identity: { dev: st.dev, ino: st.ino, schemaVersion },
    };
  } catch {
    return { exists: false };
  }
}

/**
 * 从 transcript_events 行的 event_json 提取与定价无关的原始用量记录
 * （口径与旧 JSONL 解析完全一致：type=message、有 usage、过滤 openclaw 内部镜像）。
 * @param {string} eventJson
 * @returns {object|null} record
 */
export function extractUsageRecord(eventJson) {
  let obj;
  try {
    obj = JSON.parse(eventJson);
  } catch {
    return null;
  }
  if (obj.type !== 'message') return null;

  const msg = obj.message;
  if (!msg || !msg.usage) return null;
  if (msg.provider === 'openclaw') return null;

  return {
    provider: msg.provider || 'unknown',
    model: msg.model || 'unknown',
    usage: {
      input: msg.usage.input || 0,
      output: msg.usage.output || 0,
      cacheRead: msg.usage.cacheRead || 0,
      cacheWrite: msg.usage.cacheWrite || 0,
      totalTokens: msg.usage.totalTokens || 0,
    },
    openclawCost: {
      input: msg.usage.cost?.input || 0,
      output: msg.usage.cost?.output || 0,
      cacheRead: msg.usage.cost?.cacheRead || 0,
      cacheWrite: msg.usage.cost?.cacheWrite || 0,
      total: msg.usage.cost?.total || 0,
    },
    timestamp: obj.timestamp || null,
  };
}

/**
 * 会话展示状态统一映射为前端/sync 白名单值。
 * SQLite 的 done/failed/killed/timeout 是终态而非删除；running 是唯一进行态。
 * @param {string|null} windowStatus
 * @returns {'active'|'done'}
 */
function mapSessionStatus(windowStatus) {
  if (windowStatus === 'running') return 'active';
  if (windowStatus) return 'done';
  return 'active';
}

/**
 * 扫描活跃会话与归档的身份清单（新 manifest）。
 * 身份四元组 (events, maxSeq, lastCreatedAt, watermark) 任一变化即视为变更。
 * 两个查询均带 ORDER BY：manifest 经 JSON.stringify 比较（stats-cache-store.manifestsEqual），
 * 行序不稳定会产生假阴性触发空增量刷新。
 * 注意：sessions 与 archives 是两条独立语句，无跨语句快照——reset 归档若落在
 * 两查询之间，当轮会同时产出 `sqlite:` 与 `sqlite-archive:` 两份贡献（瞬态双计），
 * 下一轮扫描自愈。
 * @returns {{
 *   exists: boolean,
 *   identity?: object,
 *   sessions: Record<string, { events: number, maxSeq: number, lastCreatedAt: number, watermark: number }>,
 *   archives: Record<string, { generation: string, reason: string, encoding: string, createdAt: number }>
 * }}
 */
export function scanSqliteManifest() {
  const opened = openSqliteReadOnly();
  if (!opened.exists) {
    return { exists: false, sessions: {}, archives: {} };
  }
  const { db, identity } = opened;
  try {
    // 表缺失（0 字节/无 schema 的 db，或升级中途）时降级为空 manifest，
    // 与归档查询的兜底一致，避免穿透成 /api/stats 500。
    let sessions = Object.create(null);
    try {
      const sessionRows = db.prepare(`
        SELECT e.session_id AS session_id,
               COUNT(*) AS events,
               MAX(e.seq) AS maxSeq,
               MAX(e.created_at) AS lastCreatedAt,
               MAX(w.transcript_updated_at) AS watermark
        FROM transcript_events e
        LEFT JOIN session_windows w ON w.session_id = e.session_id
        GROUP BY e.session_id
        ORDER BY e.session_id
      `).all();

      for (const row of sessionRows) {
        sessions[row.session_id] = {
          events: row.events,
          maxSeq: row.maxSeq ?? 0,
          lastCreatedAt: row.lastCreatedAt ?? 0,
          watermark: row.watermark ?? 0,
        };
      }
    } catch {
      sessions = Object.create(null);
    }

    let archives = Object.create(null);
    try {
      const archiveRows = db.prepare(`
        SELECT session_id, generation, reason, encoding, created_at AS createdAt
        FROM session_transcript_archives
        ORDER BY session_id, generation
      `).all();
      archives = Object.create(null);
      for (const row of archiveRows) {
        archives[`${row.session_id}@${row.generation}`] = {
          generation: row.generation,
          reason: row.reason,
          encoding: row.encoding,
          createdAt: row.createdAt,
        };
      }
    } catch {
      archives = Object.create(null);
    }

    return { exists: true, identity, sessions, archives };
  } finally {
    db.close();
  }
}

/**
 * 构建单个活跃会话的贡献（全量解析该会话事件）。
 * @param {DatabaseSync} db
 * @param {string} sessionId
 * @returns {object} contribution
 */
function buildActiveContribution(db, sessionId) {
  const rows = db.prepare(
    'SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq'
  ).all(sessionId);

  const windowRow = db.prepare(
    'SELECT status FROM session_windows WHERE session_id = ?'
  ).get(sessionId);

  const records = [];
  for (const row of rows) {
    const rec = extractUsageRecord(row.event_json);
    if (rec) records.push(rec);
  }

  return buildContributionFromRecords(
    { id: sessionId, status: mapSessionStatus(windowRow?.status ?? null), archivedAt: null },
    records
  );
}

/**
 * 构建单个归档会话的贡献（解压 zstd/identity blob 并按原 JSONL 口径解析）。
 * @param {DatabaseSync} db
 * @param {string} sessionId
 * @param {string} generation
 * @param {string} reason
 * @param {string} encoding
 * @returns {object} contribution
 */
function buildArchiveContribution(db, sessionId, generation, reason, encoding) {
  const row = db.prepare(
    'SELECT archive_blob FROM session_transcript_archives WHERE session_id = ? AND generation = ?'
  ).get(sessionId, generation);
  if (!row) {
    throw new Error(`归档 ${sessionId}@${generation} 在解析期间消失`);
  }

  let text;
  const blob = Buffer.from(row.archive_blob);
  if (encoding === 'zstd') {
    text = zstdDecompressSync(blob).toString('utf-8');
  } else {
    text = blob.toString('utf-8');
  }

  const records = [];
  let archivedAt = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const rec = extractUsageRecord(line);
    if (rec) {
      records.push(rec);
      if (!archivedAt && rec.timestamp) archivedAt = rec.timestamp;
    }
  }

  const status = reason === 'deleted' ? 'deleted' : 'reset';
  return buildContributionFromRecords(
    { id: sessionId, status, archivedAt },
    records
  );
}

/**
 * 供 stats-service 调用的统一入口：按 manifest 变更集构建/更新贡献。
 * 返回的 map 与旧版 files map 同构（键为贡献键）。
 * @param {{ added: string[], changed: string[], removed: string[] }} sessionDiff
 * @param {{ added: string[], changed: string[], removed: string[] }} archiveDiff
 * @returns {Promise<{ contributions: Record<string, object> }>}
 */
export async function buildSqliteContributions(sessionDiff, archiveDiff) {
  const opened = openSqliteReadOnly();
  if (!opened.exists) {
    throw new Error('openclaw-agent.sqlite 不可读');
  }
  const { db } = opened;
  const contributions = Object.create(null);
  try {
    for (const sessionId of [...sessionDiff.added, ...sessionDiff.changed]) {
      contributions[`sqlite:${sessionId}`] = buildActiveContribution(db, sessionId);
    }
    for (const key of [...archiveDiff.added, ...archiveDiff.changed]) {
      // 单个归档损坏（zstd 解压失败、解析期间行消失等）不应拖垮整轮刷新：
      // 跳过该键即可——manifest 仍含该键，下轮增量会自动重试，天然自愈。
      try {
        const [sessionId, generation] = splitArchiveKey(key);
        const meta = { sessionId, generation };
        // reason/encoding 从 manifest 携带不可靠（diff 只给键），这里重新查询
        const row = db.prepare(
          'SELECT reason, encoding FROM session_transcript_archives WHERE session_id = ? AND generation = ?'
        ).get(meta.sessionId, meta.generation);
        if (!row) continue;
        contributions[`sqlite-archive:${key}`] = buildArchiveContribution(
          db,
          meta.sessionId,
          meta.generation,
          row.reason,
          row.encoding
        );
      } catch (err) {
        console.warn(`归档 ${key} 解析失败，本轮跳过（下轮增量自动重试）：${err.message}`);
      }
    }
  } finally {
    db.close();
  }
  return { contributions };
}

/**
 * `sessionId@generation` → [sessionId, generation]（generation 为 32 位 hex，
 * 不含 @，直接以最后一个 @ 切分）
 */
function splitArchiveKey(key) {
  const idx = key.lastIndexOf('@');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

/**
 * 列出数据库中全部会话 id（活跃 + 归档），供冻结历史迁移做防重合过滤。
 * @returns {Set<string>|null} 数据库不可读时返回 null
 */
export function listSqliteSessionIds() {
  const opened = openSqliteReadOnly();
  if (!opened.exists) return null;
  const { db } = opened;
  try {
    const ids = new Set();
    try {
      for (const r of db.prepare('SELECT DISTINCT session_id AS id FROM transcript_events').all()) {
        ids.add(r.id);
      }
    } catch {
      // 主表缺失（无 schema 的 db）时仅保留归档侧 id
    }
    try {
      for (const r of db.prepare('SELECT DISTINCT session_id AS id FROM session_transcript_archives').all()) {
        ids.add(r.id);
      }
    } catch {
      // 归档表缺失时忽略
    }
    return ids;
  } finally {
    db.close();
  }
}

/**
 * 供诊断/测试：判断数据库文件是否存在（不打开连接）
 */
export function sqliteFileExists() {
  return existsSync(getSqlitePath());
}
