import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const hubRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** One Hub plugin that the workstation overlay loads by package name. */
export interface HubPlugin {
  /** Overlay `name` and `/plugins/<name>/client.js` id; must stay a scoped package name. */
  name: string
  /** Package directory (contains `package.json`). */
  dir: string
}

export function hubPackageRoot(): string {
  return hubRoot
}

export function workstationOverlayPath(): string {
  return join(hubRoot, 'workstation.cordis.yml')
}

/**
 * Hub plugins inserted by `workstation.cordis.yml`.
 * Overlay `name` stays `@dsh-hub/*` so client-modules serves `/plugins/@dsh-hub/<pkg>/client.js`.
 * @returns the three packages connect must make resolvable from both the workstation profile and the dsh install.
 */
export function hubPlugins(): HubPlugin[] {
  return [
    { name: '@dsh-hub/webserver-unix', dir: join(hubRoot, 'webserver-unix') },
    { name: '@dsh-hub/logout', dir: join(hubRoot, 'logout') },
    { name: '@dsh-hub/preview', dir: join(hubRoot, 'preview') },
  ]
}

/**
 * `node_modules` directories from which a published `dsh` may resolve `@dsh-hub/*`.
 * Includes the workstation profile (config `baseUrl`), `$DSH_HOME/profiles`, the dsh
 * package's own `node_modules` (Loader `import()` parent when `internal` is missing
 * or `bareModuleBaseUrl` is the host), and the global `node_modules` beside
 * `@deepseek-ai/dsh`.
 * @param home - `$DSH_HOME`.
 * @param profileDir - `$DSH_HOME/profiles/workstation`.
 * @param dshRoot - directory of the `@deepseek-ai/dsh` package, or `undefined` when not found.
 * @returns absolute `node_modules` roots, in link order.
 */
export function hubPluginLinkRoots(home: string, profileDir: string, dshRoot: string | undefined): string[] {
  const roots = [
    join(profileDir, 'node_modules'),
    join(home, 'profiles', 'node_modules'),
  ]
  if (dshRoot === undefined) return roots
  roots.push(join(dshRoot, 'node_modules'))
  const scopeDir = dirname(dshRoot)
  const nodeModules = dirname(scopeDir)
  if (basename(scopeDir) === '@deepseek-ai' && basename(nodeModules) === 'node_modules') {
    roots.push(nodeModules)
  }
  return roots
}

/**
 * Symlink each Hub plugin into every resolution root a global `dsh` walks.
 * @param home - `$DSH_HOME`.
 * @param profileDir - `$DSH_HOME/profiles/workstation`.
 * @param dshRoot - directory of the `@deepseek-ai/dsh` package, or `undefined` when not found.
 */
export function ensureHubPluginLinks(home: string, profileDir: string, dshRoot: string | undefined): void {
  const plugins = hubPlugins()
  for (const root of hubPluginLinkRoots(home, profileDir, dshRoot)) {
    for (const plugin of plugins) {
      tryReplaceLink(join(root, ...plugin.name.split('/')), plugin.dir)
    }
  }
  const unix = plugins.find(plugin => plugin.name === '@dsh-hub/webserver-unix')
  if (unix !== undefined) linkPluginPeers(unix.dir)
}

export function setupWorkstationProfile(): string {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  const profileDir = join(home, 'profiles', 'workstation')
  mkdirSync(profileDir, { recursive: true })

  const plugins = hubPlugins()
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
  for (const plugin of plugins) {
    dependencies[plugin.name] = `file:${plugin.dir}`
  }
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

  const dshRoot = resolveDshPackageRoot()
  if (dshRoot === undefined && commandExists('dsh')) {
    throw new Error('found dsh on PATH but not the @deepseek-ai/dsh package to link @dsh-hub plugins into')
  }
  ensureHubPluginLinks(home, profileDir, dshRoot)
  if (commandExists('npm')) {
    const result = spawnSync('npm', ['install'], {
      cwd: profileDir,
      encoding: 'utf8',
      env: process.env,
    })
    if (result.status !== 0) {
      process.stderr.write(
        `dsh-hub: npm install in the workstation profile failed${result.stderr.length > 0 ? `:\n${result.stderr}` : '\n'}`,
      )
    }
  }
  ensureHubPluginLinks(home, profileDir, dshRoot)
  assertHubPluginsResolvable(profileDir, dshRoot)
  return profileDir
}

export function dshLaunchArgs(): string[] {
  const sourceBin = resolve(hubRoot, '../apps/cli/src/bin.ts')
  const repoInstalled = existsSync(resolve(hubRoot, '../node_modules'))
  if (existsSync(sourceBin) && repoInstalled) return [process.execPath, '--import', 'tsx/esm', sourceBin]
  if (commandExists('dsh')) return ['dsh']
  throw new Error('dsh not found')
}

/**
 * Prove `@dsh-hub/*` resolve from the profile and, when known, from the dsh package.
 * @param profileDir - workstation profile directory.
 * @param dshRoot - `@deepseek-ai/dsh` package directory, or `undefined` when not found.
 * @throws when a Hub plugin is not resolvable from a parent dsh will actually use.
 */
export function assertHubPluginsResolvable(profileDir: string, dshRoot: string | undefined): void {
  const parents = [join(profileDir, 'package.json')]
  if (dshRoot !== undefined) parents.push(join(dshRoot, 'package.json'))
  for (const plugin of hubPlugins()) {
    for (const parent of parents) {
      if (!existsSync(parent)) {
        throw new Error(`cannot resolve ${plugin.name}: missing ${parent}`)
      }
      try {
        createRequire(pathToFileURL(parent)).resolve(`${plugin.name}/package.json`)
      } catch {
        throw new Error(
          `cannot resolve ${plugin.name} from ${parent}; dsh-hub could not link it into that Node project`,
        )
      }
    }
  }
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
      // fall through to the repository checkout beside hub/
    }
  }
  const repo = resolve(hubRoot, '..')
  if (existsSync(join(repo, 'node_modules', '@deepseek-ai', 'cordis'))) return repo
  return undefined
}

function tryReplaceLink(link: string, target: string): void {
  try {
    replaceLink(link, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') return
    throw error
  }
}

function replaceLink(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true })
  try {
    const info = lstatSync(link)
    if (info.isDirectory() && !info.isSymbolicLink()) rmSync(link, { recursive: true, force: true })
    else unlinkSync(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  symlinkSync(target, link, 'junction')
}

function linkPluginPeers(pluginDir: string): void {
  const dshRoot = resolveDshPackageRoot()
  if (dshRoot === undefined) return
  for (const name of ['cordis', 'schemastery'] as const) {
    const target = join(dshRoot, 'node_modules', '@deepseek-ai', name)
    if (!existsSync(target)) continue
    tryReplaceLink(join(pluginDir, 'node_modules', '@deepseek-ai', name), target)
  }
}

function commandExists(name: string): boolean {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' })
  return probe.status === 0
}
