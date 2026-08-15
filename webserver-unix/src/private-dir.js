/**
 * Unix socket parent directories on shared HPC login nodes must be owned by
 * this uid and mode 0700. `mkdirSync(..., { mode: 0o700 })` does not take
 * over an existing attacker-owned `/tmp/dsh-hub-<uid>`.
 */
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'

/**
 * Create `dir` if missing, then refuse a symlink, a non-directory, or a
 * directory owned by another uid. If this uid owns it but group/other bits
 * are set, chmod 0700 and re-check.
 * @param {string} dir
 */
export function ensurePrivateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertPrivateDirectory(dir)
  const info = lstatSync(dir)
  if ((info.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700)
    assertPrivateDirectory(dir)
    if ((lstatSync(dir).mode & 0o077) !== 0) {
      throw new Error(`套接字目录权限必须是 0700: ${dir}`)
    }
  }
}

/**
 * @param {string} dir
 */
function assertPrivateDirectory(dir) {
  const info = lstatSync(dir)
  if (info.isSymbolicLink()) {
    throw new Error(`套接字目录是符号链接: ${dir}`)
  }
  if (!info.isDirectory()) {
    throw new Error(`套接字目录不是目录: ${dir}`)
  }
  const uid = process.getuid?.()
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`套接字目录不属于当前用户: ${dir}`)
  }
}
