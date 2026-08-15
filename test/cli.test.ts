import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { main } from '../src/cli.ts'
import { isBcryptHash, verifySecret } from '../src/hash.ts'

const hubRoot = fileURLToPath(new URL('..', import.meta.url))
const cli = join(hubRoot, 'src/cli.ts')
const tsx = createRequire(join(hubRoot, 'package.json')).resolve('tsx/esm')

test('hash CLI hashes the file and ignores DSH_HUB_PASSWORD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-hash-'))
  const file = join(dir, 'secret')
  writeFileSync(file, 'from-file', { mode: 0o600 })
  const previous = process.env.DSH_HUB_PASSWORD
  process.env.DSH_HUB_PASSWORD = 'from-env'
  let out = ''
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += String(chunk)
    return true
  }) as typeof process.stdout.write
  try {
    await main(['hash', '--password-file', file])
    await assert.rejects(() => main(['hash']), /password-file/)
  } finally {
    process.stdout.write = write
    if (previous === undefined) delete process.env.DSH_HUB_PASSWORD
    else process.env.DSH_HUB_PASSWORD = previous
    rmSync(dir, { recursive: true, force: true })
  }
  const hash = out.trim()
  assert.equal(isBcryptHash(hash), true)
  assert.equal(verifySecret('from-file', hash), true)
  assert.equal(verifySecret('from-env', hash), false)
})

test('first serve prints DSH_HUB_AGENT_SECRET once and later serve does not', { timeout: 25_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-serve-'))
  const configPath = join(dir, 'hub.yaml')
  const passwordFile = join(dir, 'password')
  writeFileSync(passwordFile, 'alice-secret', { mode: 0o600 })
  const first = spawnServe(dir, [
    '--user', 'alice',
    '--password-file', passwordFile,
    '--config', configPath,
    '--port', '0',
  ])
  try {
    const firstOut = await collectUntil(first, /listen: /, 12_000)
    const match = /^DSH_HUB_AGENT_SECRET=(\S+)$/m.exec(firstOut)
    assert.ok(match?.[1])
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    first.kill('SIGTERM')
    await waitExit(first)

    const second = spawnServe(dir, ['--config', configPath, '--port', '0'])
    try {
      const secondOut = await collectUntil(second, /listen: /, 8_000)
      assert.doesNotMatch(secondOut, /DSH_HUB_AGENT_SECRET=/)
    } finally {
      second.kill('SIGTERM')
      await waitExit(second)
    }
  } finally {
    first.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

function spawnServe(cwd: string, args: string[]): ChildProcess {
  return spawn(process.execPath, ['--import', pathToFileURL(tsx).href, cli, 'serve', ...args], {
    cwd,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function collectUntil(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  let out = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout waiting for ${pattern.source}; got:\n${out}`))
    }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      out += chunk.toString('utf8')
      if (pattern.test(out)) {
        clearTimeout(timer)
        resolve(out)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (pattern.test(out)) return
      clearTimeout(timer)
      reject(new Error(`exited ${String(code ?? signal)}; got:\n${out}`))
    })
  })
}

function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    child.once('exit', () => { resolve() })
  })
}
