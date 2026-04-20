import { readFileSync, readdirSync, copyFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(__dirname, '..', 'fixtures');

export function fixturePath(...parts) {
  return join(FIXTURES_ROOT, ...parts);
}

export function readFixtureJson(...parts) {
  return JSON.parse(readFileSync(fixturePath(...parts), 'utf-8'));
}

export function readFixtureText(...parts) {
  return readFileSync(fixturePath(...parts), 'utf-8');
}

/**
 * 把某个 fixtures 子目录下的全部文件拷贝到目标目录。
 * @returns {number} 拷贝的文件数
 */
export function copyFixtureDir(sourceSubdir, targetDir) {
  const src = fixturePath(sourceSubdir);
  if (!existsSync(src)) return 0;
  let n = 0;
  for (const name of readdirSync(src)) {
    copyFileSync(join(src, name), join(targetDir, name));
    n++;
  }
  return n;
}
