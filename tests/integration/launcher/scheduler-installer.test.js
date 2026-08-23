import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

const TEST_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const SCHEDULER = join(TEST_DIR, 'scripts/install-sync-scheduler.sh');
const SYSTEMD = join(TEST_DIR, 'scripts/install-systemd-user-service.sh');
const disposables = [];

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'ocu-sync-home-'));
  const fakeBin = join(home, 'bin');
  const managerLog = join(home, 'manager-calls.log');
  mkdirSync(fakeBin, { recursive: true });
  for (const command of ['launchctl', 'systemctl']) {
    const path = join(fakeBin, command);
    writeFileSync(path, `#!/usr/bin/env bash
printf '%s ' '${command}' >> "$FAKE_MANAGER_LOG"
printf '%s\\n' "$*" >> "$FAKE_MANAGER_LOG"
exit 0
`);
    chmodSync(path, 0o700);
  }
  const analyzerPath = join(fakeBin, 'systemd-analyze');
  writeFileSync(analyzerPath, `#!/usr/bin/env bash
printf '%s ' 'systemd-analyze' >> "$FAKE_MANAGER_LOG"
printf '%s\\n' "$*" >> "$FAKE_MANAGER_LOG"
if [[ "$1" == "verify" ]]; then
  target=''
  for target in "$@"; do :; done
  if grep -Eq '^WorkingDirectory="' "$target"; then
    exit 1
  fi
  case "$target" in
    *.service|*.timer) exit 0 ;;
    *) exit 1 ;;
  esac
fi
exit 0
`);
  chmodSync(analyzerPath, 0o700);
  disposables.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function run(script, home, args = []) {
  return execFileSync('bash', [script, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      PATH: `${join(home, 'bin')}:${process.env.PATH || ''}`,
      FAKE_MANAGER_LOG: join(home, 'manager-calls.log'),
    },
  });
}

function managerCalls(home) {
  return readFileSync(join(home, 'manager-calls.log'), 'utf8');
}

function systemdVerifyTargets(home) {
  return managerCalls(home)
    .split('\n')
    .filter((line) => line.startsWith('systemd-analyze verify '))
    .map((line) => line.slice('systemd-analyze verify '.length));
}

afterEach(() => {
  while (disposables.length) disposables.pop()();
});

describe('sync scheduler installers', () => {
  it('installs a repeatable Linux user timer with no persistent catch-up storm', () => {
    const home = tempHome();
    run(SCHEDULER, home, ['--platform', 'linux', '--interval-minutes', '15']);
    const unitDir = join(home, '.config', 'systemd', 'user');
    const timer = readFileSync(join(unitDir, 'openclaw-usage-sync.timer'), 'utf8');
    expect(timer).toContain('OnUnitActiveSec=15min');
    expect(timer).toContain('Persistent=false');
    expect(timer).toContain('openclaw-usage-sync.service');
    expect(readFileSync(join(unitDir, 'openclaw-usage-sync.service'), 'utf8')).toContain(
      join(TEST_DIR, 'scripts/openclaw-usage-cli.js')
    );
    expect(readFileSync(join(unitDir, 'openclaw-usage-sync.service'), 'utf8')).toContain('sync --scheduled');
    expect(readFileSync(join(unitDir, 'openclaw-usage-sync.service'), 'utf8')).not.toMatch(/@(?:REPO_ROOT|NODE_PATH)@/);
    expect(managerCalls(home)).toMatch(/systemctl --user daemon-reload/);
    expect(managerCalls(home)).toMatch(/systemctl --user enable --now openclaw-usage-sync\.timer/);
    expect(systemdVerifyTargets(home)).toHaveLength(2);
    expect(systemdVerifyTargets(home).map((target) => target.slice(target.lastIndexOf('.') + 1)).sort()).toEqual([
      'service',
      'timer',
    ]);
  });

  it('installs an absolute-path macOS LaunchAgent and is idempotent', () => {
    const home = tempHome();
    const configDir = join(home, 'config & <sync>');
    run(SCHEDULER, home, ['--platform', 'darwin', '--interval-minutes', '60', '--config-dir', configDir]);
    const plist = join(home, 'Library', 'LaunchAgents', 'com.openclaw.usage.sync.plist');
    expect(existsSync(plist)).toBe(true);
    const content = readFileSync(plist, 'utf8');
    expect(content).toContain('<integer>3600</integer>');
    expect(content).toContain(join(TEST_DIR, 'scripts/openclaw-usage-cli.js'));
    expect(content).toContain('<string>sync</string>');
    expect(content).toContain('<string>--scheduled</string>');
    expect(content).toContain('<key>EnvironmentVariables</key>');
    expect(content).toContain('<key>OPENCLAW_CONFIG_DIR</key><string>/');
    expect(content).toContain('config &amp; &lt;sync&gt;');
    expect(content).not.toContain(configDir);
    run(SCHEDULER, home, ['--platform', 'darwin', '--interval-minutes', '60']);
    expect(statSync(plist).mode & 0o777).toBe(0o600);
    expect(managerCalls(home)).toMatch(/launchctl unload .*com\.openclaw\.usage\.sync\.plist/);
    expect(managerCalls(home)).toMatch(/launchctl load .*com\.openclaw\.usage\.sync\.plist/);
  });

  it('escapes repository paths in both generated formats', () => {
    const home = tempHome();
    const repoAlias = join(home, 'repo & <sync>');
    symlinkSync(TEST_DIR, repoAlias, 'dir');
    run(SCHEDULER, home, ['--platform', 'darwin', '--repo-root', repoAlias, '--interval-minutes', '60']);
    const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'com.openclaw.usage.sync.plist'), 'utf8');
    expect(plist).toContain('repo &amp; &lt;sync&gt;');
    expect(plist).not.toContain(repoAlias);

    run(SCHEDULER, home, ['--platform', 'linux', '--repo-root', repoAlias, '--interval-minutes', '15']);
    const service = readFileSync(join(home, '.config', 'systemd', 'user', 'openclaw-usage-sync.service'), 'utf8');
    expect(service).toContain(`WorkingDirectory=${repoAlias.replaceAll(' ', '\\x20')}`);
    expect(service).not.toContain('WorkingDirectory="');
    expect(service).toContain('repo & <sync>');
    expect(service).toContain('ExecStart="');
  });

  it('escapes systemd scalar paths without changing token quoting', () => {
    const home = tempHome();
    const repoAlias = join(home, "repo %\\ '\"");
    symlinkSync(TEST_DIR, repoAlias, 'dir');
    const fakeNode = join(home, 'bin', 'node');
    writeFileSync(fakeNode, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(fakeNode, 0o700);
    run(SCHEDULER, home, ['--platform', 'linux', '--repo-root', repoAlias, '--interval-minutes', '15']);
    const service = readFileSync(join(home, '.config', 'systemd', 'user', 'openclaw-usage-sync.service'), 'utf8');
    const expectedWorkingDirectory = repoAlias
      .replaceAll('\\', '\\\\')
      .replaceAll(' ', '\\x20')
      .replaceAll("'", '\\x27')
      .replaceAll('"', '\\x22')
      .replaceAll('%', '%%');
    expect(service).toContain(`WorkingDirectory=${expectedWorkingDirectory}`);
    expect(service).not.toContain('WorkingDirectory="');
    expect(service).toContain('ExecStart="');
  });

  it('installs a Web service template with safe defaults and an environment override', () => {
    const home = tempHome();
    run(SYSTEMD, home, ['--host', '0.0.0.0', '--port', '3001']);
    const service = readFileSync(join(home, '.config', 'systemd', 'user', 'openclaw-usage.service'), 'utf8');
    expect(service).toContain('Environment=OPENCLAW_USAGE_HOST="0.0.0.0"');
    expect(service).toContain('Environment=OPENCLAW_USAGE_PORT="3001"');
    expect(service).toContain('EnvironmentFile=-%h/.config/openclaw-usage/environment');
    expect(service).toContain(join(TEST_DIR, 'server.js'));
    expect(service).not.toMatch(/@(?:REPO_ROOT|NODE_PATH)@/);
    expect(service).not.toMatch(/password|private.?key|token|credential/i);
    expect(systemdVerifyTargets(home)).toHaveLength(3);
    expect(systemdVerifyTargets(home).map((target) => target.slice(target.lastIndexOf('.') + 1)).sort()).toEqual([
      'service',
      'service',
      'timer',
    ]);
  });

  it('fails closed for invalid hosts and control-character config paths without writing units', () => {
    const home = tempHome();
    const unitDir = join(home, '.config', 'systemd', 'user');
    expect(() => run(SYSTEMD, home, ['--host', 'localhost'])).toThrow();
    expect(existsSync(join(unitDir, 'openclaw-usage.service'))).toBe(false);
    expect(() => run(SYSTEMD, home, ['--host', '0.0.0.0;touch /tmp/pwned'])).toThrow();
    expect(existsSync(join(unitDir, 'openclaw-usage-sync.timer'))).toBe(false);
    expect(() => run(SYSTEMD, home, ['--config-dir', `${home}/config\nwith-control`])).toThrow();
    expect(existsSync(unitDir)).toBe(false);
  });

  it('does not overwrite existing units when later validation fails', () => {
    const home = tempHome();
    run(SYSTEMD, home, ['--host', '127.0.0.1']);
    const unit = join(home, '.config', 'systemd', 'user', 'openclaw-usage.service');
    const before = readFileSync(unit, 'utf8');
    expect(() => run(SYSTEMD, home, ['--host', '127.0.0.1\n'])).toThrow();
    expect(readFileSync(unit, 'utf8')).toBe(before);
  });
});
