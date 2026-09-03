import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 创建一次性测试工作区，结构如下：
 *   <root>/config/agents/main/agent/
 *   <root>/config/agents/main/sessions/
 *   <root>/workspace/
 * 并注入 OPENCLAW_CONFIG_DIR / OPENCLAW_DIR。
 *
 * 会话数据源为 config/agents/main/agent/openclaw-agent.sqlite；
 * copyFixtureDb() 从 tests/fixtures/db 拷贝真实脱敏样本，
 * 或用 execSql() 以 SQL 脚本从零构建。
 *
 * 所有写入操作为同步，便于断言立即生效。
 */
export async function createTmpWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-usage-test-'));
  const configDir = join(root, 'config');
  const agentDir = join(configDir, 'agents', 'main', 'agent');
  const sessionsDir = join(configDir, 'agents', 'main', 'sessions');
  const workspaceDir = join(root, 'workspace');

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  process.env.OPENCLAW_CONFIG_DIR = configDir;
  process.env.OPENCLAW_DIR = workspaceDir;

  const dbPath = join(agentDir, 'openclaw-agent.sqlite');

  return {
    root,
    configDir,
    agentDir,
    sessionsDir,
    workspaceDir,
    dbPath,
    /** 将真实脱敏样本库拷入工作区 */
    copyFixtureDb(fixturePath) {
      copyFileSync(fixturePath, dbPath);
    },
    /** 以 SQL 脚本从零构建（自动建最小 schema） */
    execSql(script) {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS transcript_events (
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            event_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (session_id, seq)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS session_windows (
            session_id TEXT NOT NULL PRIMARY KEY,
            session_key TEXT NOT NULL,
            status TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            transcript_updated_at INTEGER
          ) STRICT;
          CREATE TABLE IF NOT EXISTS session_transcript_archives (
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
        db.exec(script);
      } finally {
        db.close();
      }
    },
    writeModelsJson(json) {
      writeFileSync(join(configDir, 'openclaw.json'), JSON.stringify(json, null, 2), 'utf-8');
    },
    writePricingConfig(json) {
      writeFileSync(
        join(workspaceDir, 'openclaw-usage-pricing.json'),
        JSON.stringify(json, null, 2),
        'utf-8'
      );
    },
    async cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
