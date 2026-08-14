import { PASSWORD_ON_ARGV_ERROR } from './password.js'

export interface ConnectInvocation {
  hubUrl: string
  username?: string
  passwordFile?: string
  agentSecretFile?: string
  allowPlainHttp: boolean
  dshArgs: string[]
}

export function parseConnectArgs(argv: readonly string[]): ConnectInvocation {
  let hubUrl: string | undefined
  let username: string | undefined
  let passwordFile: string | undefined
  let agentSecretFile: string | undefined
  let allowPlainHttp = false
  const dshArgs: string[] = []
  let passthrough = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (passthrough) {
      dshArgs.push(token)
      continue
    }
    if (token === '--') {
      passthrough = true
      continue
    }
    if (token === '--user' || token === '-u') {
      username = nextValue(argv, index, token)
      index += 1
      continue
    }
    if (token.startsWith('--user=')) {
      username = token.slice('--user='.length)
      continue
    }
    if (token === '--password' || token === '-p' || token.startsWith('--password=')) {
      throw new Error(PASSWORD_ON_ARGV_ERROR)
    }
    if (token === '--agent-secret' || token.startsWith('--agent-secret=')) {
      throw new Error('--agent-secret is not supported; use a prompt, --agent-secret-file, or DSH_HUB_AGENT_SECRET')
    }
    if (token === '--password-file') {
      passwordFile = nextValue(argv, index, token)
      index += 1
      continue
    }
    if (token.startsWith('--password-file=')) {
      passwordFile = token.slice('--password-file='.length)
      continue
    }
    if (token === '--agent-secret-file') {
      agentSecretFile = nextValue(argv, index, token)
      index += 1
      continue
    }
    if (token.startsWith('--agent-secret-file=')) {
      agentSecretFile = token.slice('--agent-secret-file='.length)
      continue
    }
    if (token === '--allow-plain-http') {
      allowPlainHttp = true
      continue
    }
    if ((token === '-h' || token === '--help') && hubUrl === undefined && dshArgs.length === 0) {
      throw new HelpRequested()
    }
    if (!token.startsWith('-') && hubUrl === undefined) {
      hubUrl = token
      continue
    }
    dshArgs.push(token)
  }

  if (hubUrl === undefined) {
    throw new Error('usage: dsh-hub connect <url>')
  }
  return { hubUrl, username, passwordFile, agentSecretFile, allowPlainHttp, dshArgs }
}

export class HelpRequested extends Error {
  constructor() {
    super('help')
    this.name = 'HelpRequested'
  }
}

export function hasProfileSelection(dshArgs: readonly string[]): boolean {
  if (dshArgs[0] === 'web' || dshArgs[0] === 'plugin') return true
  for (const token of dshArgs) {
    if (token === '--profile' || token.startsWith('--profile=')) return true
  }
  return false
}

export function isDshOneShot(dshArgs: readonly string[]): boolean {
  if (dshArgs[0] === 'plugin') return true
  return dshArgs.some(token =>
    token === '--dump-config'
    || token === '--dump-default-config'
    || token === '-h'
    || token === '--help'
    || token === '-V'
    || token === '--version')
}

export function composeDshArgv(dshArgs: readonly string[], overlayPath: string): string[] {
  if (dshArgs[0] === 'plugin') return [...dshArgs]
  if (dshArgs[0] === 'web') {
    const inner = dshArgs.slice(1)
    if (inner.includes('--dump-default-config')) return [...dshArgs]
    return ['web', '--patch', overlayPath, ...inner]
  }
  const prefix: string[] = []
  if (!hasProfileSelection(dshArgs)) prefix.push('--profile', 'workstation')
  if (!dshArgs.includes('--dump-default-config')) prefix.push('--patch', overlayPath)
  return [...prefix, ...dshArgs]
}

function nextValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('-')) {
    throw new Error(`${flag} 后面需要一个值`)
  }
  return value
}
