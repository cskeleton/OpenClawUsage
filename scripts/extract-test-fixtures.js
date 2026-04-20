#!/usr/bin/env node
/**
 * 一次性工具：从本机 OpenClaw 抓取会话样本 & models.json，脱敏后落入 tests/fixtures/。
 * 用法：
 *   node scripts/extract-test-fixtures.js [--limit 8] [--dry-run]
 * 注意：此脚本只在开发者本机运行，不在 CI / 测试运行时被调用。
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const getFlag = (name, def) => {
  const idx = args.indexOf(name);
  if (idx === -1) return def;
  const v = args[idx + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const LIMIT = Number(getFlag('--limit', 8));
const DRY = !!getFlag('--dry-run', false);

const CONFIG_DIR = process.env.OPENCLAW_CONFIG_DIR || join(homedir(), '.openclaw');
const SESSIONS_SRC = join(CONFIG_DIR, 'agents', 'main', 'sessions');
const MODELS_SRC = join(CONFIG_DIR, 'agents', 'main', 'agent', 'models.json');
const SESSIONS_DST = join(REPO_ROOT, 'tests', 'fixtures', 'sessions-real');
const MODELS_DST = join(REPO_ROOT, 'tests', 'fixtures', 'models', 'models.real.json');
const MANIFEST = join(REPO_ROOT, 'tests', 'fixtures', 'MANIFEST.json');

const REDACTED_TEXT = '<REDACTED_TEXT>';

function redactMessage(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj.type !== 'message') return obj;

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

function redactJsonlLine(line) {
  if (!line.trim()) return line;
  try {
    const parsed = JSON.parse(line);
    return JSON.stringify(redactMessage(parsed));
  } catch {
    return '';
  }
}

function redactModelsJson(raw) {
  const out = JSON.parse(JSON.stringify(raw));
  const providers = out.providers || out.models?.providers;
  if (providers && typeof providers === 'object') {
    for (const p of Object.values(providers)) {
      if (!p || typeof p !== 'object') continue;
      for (const k of ['apiKey', 'apiSecret', 'token', 'authorization', 'headers']) {
        delete p[k];
      }
      if (p.baseUrl) p.baseUrl = 'https://example.invalid';
      if (p.endpoint) p.endpoint = 'https://example.invalid';
    }
  }
  return out;
}

function pickRepresentativeSessions(files) {
  const buckets = { active: [], reset: [], deleted: [], checkpoint: [] };
  for (const f of files) {
    if (f.includes('.checkpoint.')) buckets.checkpoint.push(f);
    else if (f.includes('.jsonl.reset.')) buckets.reset.push(f);
    else if (f.includes('.jsonl.deleted.')) buckets.deleted.push(f);
    else if (f.endsWith('.jsonl')) buckets.active.push(f);
  }
  const result = [
    ...buckets.active.slice(0, 3),
    ...buckets.reset.slice(0, 2),
    ...buckets.deleted.slice(0, 1),
    ...buckets.checkpoint.slice(0, 1),
  ];
  return result.slice(0, LIMIT);
}

function main() {
  if (!existsSync(SESSIONS_SRC)) {
    console.error(`未找到 sessions 目录：${SESSIONS_SRC}`);
    process.exit(1);
  }

  const files = readdirSync(SESSIONS_SRC);
  const picked = pickRepresentativeSessions(files);
  const manifest = { extractedAt: new Date().toISOString(), sessions: [] };

  if (!DRY) {
    rmSync(SESSIONS_DST, { recursive: true, force: true });
    mkdirSync(SESSIONS_DST, { recursive: true });
  }

  for (const name of picked) {
    const src = join(SESSIONS_SRC, name);
    const raw = readFileSync(src, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const redacted = lines.map(redactJsonlLine).filter(Boolean).join('\n') + '\n';
    const dst = join(SESSIONS_DST, name);
    if (!DRY) writeFileSync(dst, redacted, 'utf-8');
    manifest.sessions.push({ name, bytes: redacted.length, lineCount: lines.length });
  }

  if (existsSync(MODELS_SRC)) {
    const raw = JSON.parse(readFileSync(MODELS_SRC, 'utf-8'));
    const redacted = redactModelsJson(raw);
    if (!DRY) {
      mkdirSync(dirname(MODELS_DST), { recursive: true });
      writeFileSync(MODELS_DST, JSON.stringify(redacted, null, 2), 'utf-8');
    }
    manifest.modelsJson = { source: MODELS_SRC, redactedKeys: ['apiKey', 'apiSecret', 'token', 'authorization', 'headers'] };
  }

  if (!DRY) writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), 'utf-8');
  const prefix = DRY ? '[dry-run] ' : '';
  console.log(`${prefix}抽取了 ${picked.length} 个 sessions，models.json: ${existsSync(MODELS_SRC)}`);
}

main();
