import { writeFile, rename, unlink } from 'fs/promises';
import { dirname, join } from 'path';

/**
 * 原子写文本文件（tmp + rename）。进程崩溃/SIGTERM 不会留下截断的 0 字节目标文件——
 * 背景：2026-09-04 本机 ~/.openclaw/openclaw-usage-pricing.json 被中断的直写打成 0 字节，
 * 定价配置与 models.dev 快照等状态文件统一改走此路径。
 * @param {string} filePath - 目标路径（父目录须已存在）
 * @param {string} data - 完整文件内容
 * @returns {Promise<void>}
 */
export async function writeTextFileAtomic(filePath, data) {
  const tmpPath = join(
    dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    await writeFile(tmpPath, data, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (err) {
    try {
      await unlink(tmpPath);
    } catch {
      // 忽略清理失败
    }
    throw err;
  }
}
