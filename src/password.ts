import { readFileSync, statSync } from 'node:fs'
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process'

const PASSWORD_ENV = 'DSH_HUB_PASSWORD'
const AGENT_SECRET_ENV = 'DSH_HUB_AGENT_SECRET'

export const PASSWORD_ON_ARGV_ERROR = '--password is not supported; use a prompt, --password-file, or DSH_HUB_PASSWORD'

export async function resolvePassword(passwordFile?: string): Promise<string> {
  return resolveSecret({ file: passwordFile, env: PASSWORD_ENV, prompt: '密码' })
}

export async function resolveAgentSecret(secretFile?: string): Promise<string> {
  return resolveSecret({ file: secretFile, env: AGENT_SECRET_ENV, prompt: 'Agent 密钥' })
}

/**
 * Plaintext for `dsh-hub hash`. Does not read `DSH_HUB_PASSWORD` or `DSH_HUB_AGENT_SECRET`.
 * @param passwordFile - optional mode-`0600` file of the value to hash.
 * @returns the plaintext to hash.
 */
export async function resolveHashPlaintext(passwordFile?: string): Promise<string> {
  if (passwordFile !== undefined) return readPasswordFile(passwordFile)
  return askSecret('要哈希的明文', 'pass --password-file (hash does not read DSH_HUB_PASSWORD)')
}

export function readPasswordFile(path: string): string {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o044) !== 0) {
    throw new Error(`${path}: mode ${mode.toString(8)} is readable by others (use 0600)`)
  }
  const text = readFileSync(path, 'utf8').replace(/\r?\n$/, '')
  if (text.length === 0) throw new Error(`${path}: empty password file`)
  return text
}

async function resolveSecret(options: { file?: string; env: string; prompt: string }): Promise<string> {
  if (options.file !== undefined) return readPasswordFile(options.file)
  const fromEnv = process.env[options.env]
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return askSecret(options.prompt, `set ${options.env} or pass a secret file`)
}

async function askSecret(label: string, noTtyHint: string): Promise<string> {
  if (!stdinStream.isTTY) {
    throw new Error(`no TTY; ${noTtyHint}`)
  }
  stdoutStream.write(`${label}: `)
  const previous = stdinStream.isRaw
  stdinStream.setRawMode(true)
  stdinStream.resume()
  const chars: string[] = []
  try {
    for await (const chunk of stdinStream) {
      const text = Buffer.from(chunk as Buffer).toString('utf8')
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          stdoutStream.write('\n')
          const secret = chars.join('')
          if (secret.length === 0) throw new Error('empty password')
          return secret
        }
        if (char === '\u0003') {
          stdoutStream.write('\n')
          throw new Error('cancelled')
        }
        if (char === '\u007f' || char === '\b') {
          chars.pop()
          continue
        }
        if (char >= ' ') chars.push(char)
      }
    }
    throw new Error('empty password')
  } finally {
    stdinStream.setRawMode(previous)
    stdinStream.pause()
  }
}
