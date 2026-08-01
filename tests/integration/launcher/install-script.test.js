import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  statSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const INSTALLER = join(REPO_ROOT, 'scripts/install-local-launcher.sh');

const disposables = [];

/** 用独立 HOME 运行安装脚本，避免污染真实 ~/bin */
function runInstaller(home, args = []) {
  return execFileSync('bash', [INSTALLER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
  });
}

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'ocu-home-'));
  disposables.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

afterEach(() => {
  while (disposables.length) disposables.pop()();
});

describe('install-local-launcher.sh', () => {
  it('installs an executable wrapper pointing at this repository', () => {
    const home = makeHome();
    const out = runInstaller(home);

    const target = join(home, 'bin', 'openclaw-usage');
    expect(existsSync(target)).toBe(true);
    expect(out).toContain(target);

    const content = readFileSync(target, 'utf-8');
    expect(content).toContain('# openclaw-usage-local-launcher');
    expect(content).toContain(join(REPO_ROOT, 'scripts/openclaw-usage-cli.js'));
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it('stages the temp file inside the target dir so rename stays atomic', () => {
    const home = makeHome();
    const binDir = join(home, 'bin');

    // 目标目录与 $TMPDIR 分处不同文件系统时，mv 会退化为复制+删除；
    // 因此临时文件必须建在目标目录内，并在安装后被 rename 消耗掉。
    runInstaller(home);
    const entries = readdirSync(binDir);
    expect(entries).toEqual(['openclaw-usage']);
    expect(entries.some((n) => n.startsWith('.openclaw-usage.'))).toBe(false);
  });

  it('refuses to overwrite a foreign file without --force', () => {
    const home = makeHome();
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    const target = join(binDir, 'openclaw-usage');
    writeFileSync(target, '#!/bin/sh\necho other tool\n', 'utf-8');

    expect(() => runInstaller(home)).toThrow();
    expect(readFileSync(target, 'utf-8')).toContain('other tool');
    // 失败路径也不得留下临时文件
    expect(readdirSync(binDir)).toEqual(['openclaw-usage']);

    runInstaller(home, ['--force']);
    expect(readFileSync(target, 'utf-8')).toContain('# openclaw-usage-local-launcher');
    expect(readdirSync(binDir)).toEqual(['openclaw-usage']);
  });
});
