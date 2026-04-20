import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * 创建一次性测试工作区，结构如下：
 *   <root>/config/agents/main/sessions/
 *   <root>/config/agents/main/agent/
 *   <root>/workspace/
 * 并注入 OPENCLAW_CONFIG_DIR / OPENCLAW_DIR。
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

  return {
    root,
    configDir,
    agentDir,
    sessionsDir,
    workspaceDir,
    writeSession(name, content) {
      writeFileSync(join(sessionsDir, name), content, 'utf-8');
    },
    writeModelsJson(json) {
      writeFileSync(join(agentDir, 'models.json'), JSON.stringify(json, null, 2), 'utf-8');
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
