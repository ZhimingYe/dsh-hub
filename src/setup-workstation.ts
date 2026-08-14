import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const hubRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function hubPackageRoot(): string {
  return hubRoot
}

export function workstationOverlayPath(): string {
  return join(hubRoot, 'workstation.cordis.yml')
}

export function setupWorkstationProfile(): string {
  const pluginDir = join(hubRoot, 'webserver-unix')
  const logoutDir = join(hubRoot, 'logout')
  const previewDir = join(hubRoot, 'preview')
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  const profileDir = join(home, 'profiles', 'workstation')
  mkdirSync(profileDir, { recursive: true })

  const manifestPath = join(profileDir, 'package.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    : {
      name: 'dsh-profile-workstation',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }
  const dependencies = (manifest.dependencies ?? {}) as Record<string, string>
  dependencies['@dsh-hub/webserver-unix'] = `file:${pluginDir}`
  dependencies['@dsh-hub/logout'] = `file:${logoutDir}`
  dependencies['@dsh-hub/preview'] = `file:${previewDir}`
  manifest.dependencies = dependencies
  const dsh = (manifest.dsh ?? {}) as { profile?: { bundles?: string[] } }
  dsh.profile = dsh.profile ?? {}
  if (!Array.isArray(dsh.profile.bundles) || dsh.profile.bundles.length === 0) {
    dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  }
  manifest.dsh = dsh
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)

  const workspacePath = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(workspacePath)) {
    writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  }
  const profilePatch = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(profilePatch)) writeFileSync(profilePatch, '[]\n')
  linkHubPlugin(home, '@dsh-hub/webserver-unix', pluginDir)
  linkHubPlugin(home, '@dsh-hub/logout', logoutDir)
  linkHubPlugin(home, '@dsh-hub/preview', previewDir)
  linkPluginPeers(pluginDir)

  const installer = commandExists('pnpm') ? ['pnpm', 'install'] : ['npm', 'install']
  const result = spawnSync(installer[0], installer.slice(1), {
    cwd: profileDir,
    stdio: 'ignore',
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error('npm install failed in the workstation profile')
  }
  return profileDir
}

export function dshLaunchArgs(): string[] {
  const sourceBin = resolve(hubRoot, '../apps/cli/src/bin.ts')
  const repoInstalled = existsSync(resolve(hubRoot, '../node_modules'))
  if (existsSync(sourceBin) && repoInstalled) return [process.execPath, '--import', 'tsx/esm', sourceBin]
  if (commandExists('dsh')) return ['dsh']
  throw new Error('dsh not found')
}

function resolveDshPackageRoot(): string | undefined {
  if (commandExists('dsh')) {
    try {
      const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
      const bin = which.stdout.trim().split(/\r?\n/)[0]
      if (bin !== undefined && bin.length > 0) {
        let dir = dirname(realpathSync(bin))
        for (let i = 0; i < 6; i += 1) {
          const pkgPath = join(dir, 'package.json')
          if (existsSync(pkgPath)) {
            const name = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }).name
            if (name === '@deepseek-ai/dsh') return dir
          }
          const parent = dirname(dir)
          if (parent === dir) break
          dir = parent
        }
      }
    } catch {
      // fall through
    }
  }
  const repo = resolve(hubRoot, '..')
  if (existsSync(join(repo, 'node_modules', '@deepseek-ai', 'cordis'))) return repo
  return undefined
}

function replaceLink(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true })
  try {
    if (lstatSync(link).isSymbolicLink() || existsSync(link)) unlinkSync(link)
  } catch {
    // missing
  }
  symlinkSync(target, link, 'junction')
}

function linkPluginPeers(pluginDir: string): void {
  const dshRoot = resolveDshPackageRoot()
  if (dshRoot === undefined) return
  for (const name of ['cordis', 'schemastery'] as const) {
    const target = join(dshRoot, 'node_modules', '@deepseek-ai', name)
    if (!existsSync(target)) continue
    replaceLink(join(pluginDir, 'node_modules', '@deepseek-ai', name), target)
  }
}

function linkHubPlugin(home: string, name: string, pluginDir: string): void {
  replaceLink(join(home, 'profiles', 'node_modules', ...name.split('/')), pluginDir)
}

function commandExists(name: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' })
  return probe.status === 0
}
