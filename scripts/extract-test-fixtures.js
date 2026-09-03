#!/usr/bin/env node
/**
 * 一次性工具：从本机 OpenClaw SQLite 库抽取会话样本，脱敏后生成 tests/fixtures/db/openclaw-agent.sqlite。
 * 同时抽取 openclaw.json 的 models.providers 生成 models 目录 fixture。
 * 用法：
 *   node scripts/extract-test-fixtures.js [--limit 30]
 * 注意：此脚本只在开发者本机运行，不在 CI / 测试运行时被调用。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const getFlag = (name, def) => {
  const idx = args.indexOf(name);
  if (idx === -1) return def;
  const v = args[idx + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const LIMIT = Number(getFlag('--limit', 30));
const PER_SESSION_LIMIT = Number(getFlag('--per-session', 40));
const DRY = !!getFlag('--dry-run', false);

const CONFIG_DIR = process.env.OPENCLAW_CONFIG_DIR || join(homedir(), '.openclaw');
const DB_SRC = join(CONFIG_DIR, 'agents', 'main', 'agent', 'openclaw-agent.sqlite');
const OPENCLAW_JSON_SRC = join(CONFIG_DIR, 'openclaw.json');
const DB_DST = join(REPO_ROOT, 'tests', 'fixtures', 'db', 'openclaw-agent.sqlite');
const MODELS_DST = join(REPO_ROOT, 'tests', 'fixtures', 'models', 'models.real.json');
const MANIFEST = join(REPO_ROOT, 'tests', 'fixtures', 'MANIFEST.json');

const REDACTED_TEXT = '<REDACTED_TEXT>';
const REDACTED_PATH = '<REDACTED_PATH>';
const REDACTED_TOKEN = '<REDACTED_TOKEN>';

const PATH_RE = /^\/(Users|home)\/[^/]+(?:\/.*)?$/;
const TOKEN_RE = /\b(sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g;
const CRED_KEYS = new Set([
  'apiKey',
  'apiSecret',
  'token',
  'authorization',
  'authHeader',
  'bearerToken',
]);

function deepScrub(node) {
  if (node == null) return node;
  if (typeof node === 'string') {
    if (PATH_RE.test(node)) return REDACTED_PATH;
    return node.replace(TOKEN_RE, REDACTED_TOKEN);
  }
  if (Array.isArray(node)) return node.map(deepScrub);
  if (typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (CRED_KEYS.has(k)) continue;
      out[k] = deepScrub(v);
    }
    return out;
  }
  return node;
}

/**
 * message 事件只保留统计相关字段（role/provider/model/usage/timestamp），
 * content 整体替换为占位符；非 message 事件的自由文本字段（如 compaction 的
 * summary）同样脱敏，避免会话内容进入 fixture。
 */
function redactEvent(obj) {
  if (obj.type !== 'message') {
    const out = { ...obj };
    if (typeof out.summary === 'string') out.summary = REDACTED_TEXT;
    if (typeof out.text === 'string') out.text = REDACTED_TEXT;
    return out;
  }
  const msg = obj.message;
  if (!msg) return obj;
  return {
    ...obj,
    message: {
      role: msg.role,
      provider: msg.provider,
      model: msg.model,
      usage: msg.usage,
      content: typeof msg.content === 'string' ? REDACTED_TEXT : undefined,
    },
  };
}

function redactEventJson(eventJson) {
  try {
    const parsed = JSON.parse(eventJson);
    return JSON.stringify(deepScrub(redactEvent(parsed)));
  } catch {
    return null;
  }
}

/**
 * 归档 blob 与 transcript_events 同口径脱敏：按 encoding 解码 → 逐行 redactEventJson
 * （无法解析的行无法确认安全，直接丢弃）→ 以原 encoding 重新编码。
 * 返回新的 blob 与其 sha256（schema 中 archive_sha256 需与 blob 一致）。
 */
function redactArchiveBlob(blob, encoding) {
  const buf = Buffer.from(blob);
  const text = encoding === 'zstd' ? zstdDecompressSync(buf).toString('utf-8') : buf.toString('utf-8');
  const lines = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const redacted = redactEventJson(line);
    if (redacted === null) continue;
    lines.push(redacted);
  }
  const out = Buffer.from(lines.length ? lines.join('\n') + '\n' : '', 'utf-8');
  const reencoded = encoding === 'zstd' ? zstdCompressSync(out) : out;
  return { blob: reencoded, sha256: createHash('sha256').update(reencoded).digest('hex') };
}

/**
 * 生成后自检：扫描 fixture 库中全部 event_json 与解码后的归档 blob，
 * 命中本机路径 / token 模式即非零退出，防止未脱敏内容入库。
 */
function verifyFixtureSanitized(dbPath) {
  const PATH_LEAK_RE = /\/(Users|home)\/[^/\s"']+/;
  const TOKEN_LEAK_RE = new RegExp(TOKEN_RE.source);
  const leaks = [];
  const scanText = (where, text) => {
    const pathHit = text.match(PATH_LEAK_RE);
    const tokenHit = text.match(TOKEN_LEAK_RE);
    if (pathHit || tokenHit) leaks.push(`${where}: ${(pathHit || tokenHit)[0]}`);
  };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    for (const r of db.prepare('SELECT session_id, seq, event_json FROM transcript_events').all()) {
      scanText(`transcript_events ${r.session_id}#${r.seq}`, r.event_json);
    }
    for (const r of db.prepare('SELECT session_id, generation, encoding, archive_blob FROM session_transcript_archives').all()) {
      const buf = Buffer.from(r.archive_blob);
      const text = r.encoding === 'zstd' ? zstdDecompressSync(buf).toString('utf-8') : buf.toString('utf-8');
      scanText(`archive ${r.session_id}@${r.generation}`, text);
    }
  } finally {
    db.close();
  }
  if (leaks.length) {
    console.error(`脱敏自检失败，fixture 库含 ${leaks.length} 处泄漏：`);
    for (const l of leaks.slice(0, 10)) console.error(`  ${l}`);
    process.exit(1);
  }
}

function redactModelsConfig(raw) {
  const out = { models: { providers: {} } };
  const providers = raw?.models?.providers || raw?.providers || {};
  for (const [name, p] of Object.entries(providers)) {
    if (!p || typeof p !== 'object') continue;
    const clean = { ...p };
    for (const k of ['apiKey', 'apiSecret', 'token', 'authorization', 'headers']) delete clean[k];
    if (clean.baseUrl) clean.baseUrl = 'https://example.invalid';
    if (clean.endpoint) clean.endpoint = 'https://example.invalid';
    out.models.providers[name] = clean;
  }
  return deepScrub(out);
}

function main() {
  if (!existsSync(DB_SRC)) {
    console.error(`未找到 SQLite 数据库：${DB_SRC}`);
    process.exit(1);
  }

  const src = new DatabaseSync(DB_SRC, { readOnly: true });

  // 选样：usage 事件最多的会话优先（保证多 provider/model 覆盖），
  // 加一个显式命名的非 UUID 会话；归档表全量带走（通常个位数）。
  const sessionStats = src.prepare(`
    SELECT e.session_id AS id, COUNT(*) AS events,
           SUM(CASE WHEN json_type(e.event_json, '$.message.usage') = 'object' THEN 1 ELSE 0 END) AS usageEvents
    FROM transcript_events e
    GROUP BY e.session_id
    ORDER BY usageEvents DESC
  `).all();
  const picked = sessionStats.slice(0, LIMIT).map((r) => r.id);
  const named = sessionStats.find(
    (r) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.id)
  );
  if (named && !picked.includes(named.id)) picked.push(named.id);
  const pickedSet = new Set(picked);

  const archives = src.prepare(
    'SELECT session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at, published_at FROM session_transcript_archives'
  ).all();

  const manifest = { extractedAt: new Date().toISOString(), sessions: [], archives: [] };

  if (!DRY) {
    rmSync(dirname(DB_DST), { recursive: true, force: true });
    mkdirSync(dirname(DB_DST), { recursive: true });
  }

  const dst = DRY ? null : new DatabaseSync(DB_DST);
  if (dst) {
    dst.exec(`
      CREATE TABLE transcript_events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) STRICT;
      CREATE TABLE session_windows (
        session_id TEXT NOT NULL PRIMARY KEY,
        session_key TEXT NOT NULL,
        status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        transcript_updated_at INTEGER
      ) STRICT;
      CREATE TABLE session_nodes (
        session_key TEXT NOT NULL PRIMARY KEY,
        current_session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT,
        archived_at INTEGER
      ) STRICT;
      CREATE TABLE session_transcript_archives (
        session_id TEXT NOT NULL,
        generation TEXT NOT NULL,
        session_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        encoding TEXT NOT NULL,
        archive_blob BLOB NOT NULL,
        archive_sha256 TEXT NOT NULL,
        archive_name TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        published_at INTEGER,
        PRIMARY KEY (session_id, generation)
      ) STRICT;
    `);

    const insertEvent = dst.prepare(
      'INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)'
    );
    const insertWindow = dst.prepare(
      'INSERT INTO session_windows (session_id, session_key, status, created_at, updated_at, transcript_updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertArchive = dst.prepare(
      `INSERT INTO session_transcript_archives
       (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const id of picked) {
      const events = src.prepare(
        'SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq LIMIT ?'
      ).all(id, PER_SESSION_LIMIT);
      let kept = 0;
      for (const ev of events) {
        const redacted = redactEventJson(ev.event_json);
        if (redacted === null) continue;
        insertEvent.run(id, ev.seq, redacted, ev.created_at);
        kept++;
      }
      const w = src.prepare(
        'SELECT session_key, status, created_at, updated_at, transcript_updated_at FROM session_windows WHERE session_id = ?'
      ).get(id);
      if (w) {
        insertWindow.run(id, w.session_key, w.status, w.created_at, w.updated_at, w.transcript_updated_at);
      }
      manifest.sessions.push({ id, events: kept });
    }

    for (const a of archives) {
      let redactedArchive;
      try {
        redactedArchive = redactArchiveBlob(a.archive_blob, a.encoding);
      } catch (err) {
        console.warn(`归档 ${a.session_id}@${a.generation} 解码失败，已跳过：${err.message}`);
        continue;
      }
      insertArchive.run(
        a.session_id, a.generation, a.session_key, a.reason, a.encoding,
        redactedArchive.blob, redactedArchive.sha256, a.archive_name, a.created_at, a.published_at
      );
      manifest.archives.push({ sessionId: a.session_id, generation: a.generation, reason: a.reason });
    }
    dst.close();
    verifyFixtureSanitized(DB_DST);
  }

  src.close();

  if (existsSync(OPENCLAW_JSON_SRC)) {
    const raw = JSON.parse(readFileSync(OPENCLAW_JSON_SRC, 'utf-8'));
    const redacted = redactModelsConfig(raw);
    if (!DRY) {
      mkdirSync(dirname(MODELS_DST), { recursive: true });
      writeFileSync(MODELS_DST, JSON.stringify(redacted, null, 2), 'utf-8');
    }
    const HOME = homedir();
    const sourceDisplay = OPENCLAW_JSON_SRC.startsWith(HOME)
      ? '~' + OPENCLAW_JSON_SRC.slice(HOME.length)
      : REDACTED_PATH;
    manifest.models = {
      source: sourceDisplay,
      shape: 'openclaw.json models.providers',
      redactedKeys: ['apiKey', 'apiSecret', 'token', 'authorization', 'headers'],
    };
  }

  if (!DRY) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf-8');
  const prefix = DRY ? '[dry-run] ' : '';
  console.log(
    `${prefix}抽取了 ${picked.length} 个会话（含非 UUID 样本 ${named ? 1 : 0} 个）与 ${archives.length} 条归档；models 目录: ${existsSync(OPENCLAW_JSON_SRC)}`
  );
}

main();
