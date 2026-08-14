#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = join(root, '../package.json')
const cli = join(root, '../src/cli.ts')
const tsx = createRequire(pkg).resolve('tsx/esm')
const child = spawn(process.execPath, ['--import', pathToFileURL(tsx).href, cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
})
child.on('exit', code => { process.exit(code ?? 0) })
