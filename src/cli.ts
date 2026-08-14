import { existsSync, writeFileSync, chmodSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as stdinStream, stdout as stdoutStream } from 'node:process'
import { spawn, type ChildProcess } from 'node:child_process'
import { parseArgs } from 'node:util'
import { HubServer } from './server.js'
import { HubAgent } from './agent.js'
import { assertBindPolicy, isLoopbackBind, loadHubConfig, renderHubConfig } from './config.js'
import { agentUrlFromHub, internalSocketPath, requireSecureHubUrl } from './paths.js'
import { dshLaunchArgs, setupWorkstationProfile, workstationOverlayPath } from './setup-workstation.js'
import { HelpRequested, composeDshArgv, isDshOneShot, parseConnectArgs } from './connect-args.js'
import { resolveAgentSecret, resolvePassword } from './password.js'

const HELP = `dsh-hub

  dsh-hub serve [--user NAME] [--config PATH] [--port N] [--password-file PATH] [--allow-plain-http]
  dsh-hub connect <url> [--user NAME] [--password-file PATH] [--agent-secret-file PATH] [--allow-plain-http] [dsh-args...]

Password: prompt, --password-file, or DSH_HUB_PASSWORD.
Agent secret: prompt, --agent-secret-file, or DSH_HUB_AGENT_SECRET.
Extra connect arguments are forwarded to dsh.
`

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0]
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (command === 'serve') {
    await serve(argv.slice(1))
    return
  }
  if (command === 'connect') {
    try {
      await connect(argv.slice(1))
    } catch (error) {
      if (error instanceof HelpRequested) {
        process.stdout.write(HELP)
        return
      }
      throw error
    }
    return
  }
  throw new Error(`未知命令 ${command}\n\n${HELP}`)
}

async function serve(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      user: { type: 'string', short: 'u' },
      passwordFile: { type: 'string' },
      config: { type: 'string', short: 'c' },
      'allow-plain-http': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  const configPath = resolve(values.config ?? 'hub.yaml')
  if (!existsSync(configPath)) {
    const port = values.port !== undefined ? Number(values.port) : 8787
    const username = values.user ?? await ask('用户名')
    const password = await resolvePassword(values.passwordFile)
    if (username.length === 0 || password.length === 0) throw new Error('username and password required')
    const agentSecret = randomBytes(32).toString('base64url')
    writeFileSync(configPath, renderHubConfig({ port, username, password, agentSecret }))
    chmodSync(configPath, 0o600)
    console.log(`wrote ${configPath}`)
  }
  const config = loadHubConfig(configPath)
  if (values.port !== undefined) config.port = Number(values.port)
  if (values['allow-plain-http'] === true) config.allowPlainHttp = true
  assertBindPolicy(config)
  const hub = new HubServer({ config })
  const port = await hub.listen()
  console.log(`config: ${configPath}`)
  console.log(`listen: http://127.0.0.1:${String(port)}`)
  if (!isLoopbackBind(config.host)) {
    console.warn('warning: allowPlainHttp binds without TLS; passwords and cookies travel in cleartext')
  }
  console.log(`connect: dsh-hub connect http://<host>:${String(port)} --user ${config.users[0]?.username ?? 'USER'}`)
  console.log('agent secret: hub.yaml agentSecret (HPC: DSH_HUB_AGENT_SECRET or --agent-secret-file)')
}

async function connect(argv: string[]): Promise<void> {
  const invocation = parseConnectArgs(argv)
  const socketPath = internalSocketPath()
  process.env.DSH_UNIX_SOCKET = socketPath
  console.log('preparing workstation')
  setupWorkstationProfile()

  const forwarded = composeDshArgv(invocation.dshArgs, workstationOverlayPath())
  const launch = [...dshLaunchArgs(), ...forwarded]
  const child = spawn(launch[0], launch.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, DSH_UNIX_SOCKET: socketPath },
  })

  if (isDshOneShot(invocation.dshArgs)) {
    const code = await waitChild(child)
    process.exit(code)
  }

  const username = invocation.username ?? await ask('用户名')
  const password = await resolvePassword(invocation.passwordFile)
  const agentSecret = await resolveAgentSecret(invocation.agentSecretFile)
  if (username.length === 0 || password.length === 0) throw new Error('username and password required')
  requireSecureHubUrl(invocation.hubUrl, invocation.allowPlainHttp)

  const agent = new HubAgent({
    hubUrl: agentUrlFromHub(invocation.hubUrl),
    username,
    password,
    agentSecret,
    socketPath,
  })

  const stop = async (): Promise<void> => {
    await agent.stop()
    stopChild(child)
  }
  process.on('SIGINT', () => { void stop().then(() => process.exit(130)) })
  process.on('SIGTERM', () => { void stop().then(() => process.exit(0)) })
  child.on('exit', code => {
    void agent.stop().then(() => process.exit(code ?? 1))
  })

  console.log('connecting')
  await waitForSocket(socketPath, 60_000, child)
  await agent.runForever()
}

async function waitForSocket(path: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const start = Date.now()
  while (!existsSync(path)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('dsh exited')
    }
    if (Date.now() - start > timeoutMs) {
      stopChild(child)
      throw new Error('dsh start timed out')
    }
    await new Promise(resolve => { setTimeout(resolve, 250) })
  }
}

function waitChild(child: ChildProcess): Promise<number> {
  return new Promise(resolve => {
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal === 'SIGINT' ? 130 : 1))
    })
  })
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
}

async function ask(label: string): Promise<string> {
  if (!stdinStream.isTTY) throw new Error(`no TTY for ${label}; pass --user`)
  const rl = createInterface({ input: stdinStream, output: stdoutStream })
  try {
    return (await rl.question(`${label}: `)).trim()
  } finally {
    rl.close()
  }
}

const invoked = process.argv[1] !== undefined && (
  process.argv[1].endsWith('cli.ts')
  || process.argv[1].endsWith('cli.js')
  || process.argv[1].endsWith('dsh-hub')
)
if (invoked) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
