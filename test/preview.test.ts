import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, collectPreviewRoots, handlePreview, isInsideRoot } from '../preview/src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-hub-preview-'))
after(() => { rmSync(dir, { recursive: true, force: true }) })

test('classify previewable vs blocked extensions', () => {
  assert.equal(classify('/tmp/a.ts'), 'text')
  assert.equal(classify('/tmp/Photo.PNG'), 'image')
  assert.equal(classify('/tmp/paper.PDF'), 'pdf')
  assert.equal(classify('/tmp/table.csv'), 'blocked')
  assert.equal(classify('/tmp/adata.h5ad'), 'blocked')
  assert.equal(classify('/tmp/obj.rds'), 'blocked')
  assert.equal(classify('/tmp/noext'), 'unknown')
  assert.equal(classify('/tmp/Dockerfile'), 'text')
  assert.equal(classify('/tmp/LICENSE'), 'text')
  assert.equal(classify('/tmp/note.diff'), 'text')
})

test('isInsideRoot rejects a prefix sibling, not only `..`', () => {
  assert.equal(isInsideRoot('/tmp/ws/file.ts', '/tmp/ws'), true)
  assert.equal(isInsideRoot('/tmp/ws-evil/file.ts', '/tmp/ws'), false)
  assert.equal(isInsideRoot('/tmp/ws', '/tmp/ws'), true)
})

async function listen(roots: string[] = [dir]): Promise<{ origin: string, close: () => Promise<void> }> {
  const server = createServer((req, res) => { void handlePreview(req, res, { roots }) })
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => { resolve() })
    server.once('error', reject)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise(resolve => { server.close(() => { resolve() }) }),
  }
}

test('preview serves small text and rejects csv', async () => {
  const code = join(dir, 'main.rs')
  const table = join(dir, 'big.csv')
  writeFileSync(code, 'fn main() {}\n')
  writeFileSync(table, 'a,b\n1,2\n')
  const { origin, close } = await listen()
  try {
    const ok = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(code)}`)
    assert.equal(ok.status, 200)
    assert.match(ok.headers.get('content-type') ?? '', /text\/plain/)
    assert.equal(await ok.text(), 'fn main() {}\n')

    const blocked = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(table)}`)
    assert.equal(blocked.status, 415)

    const missing = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(join(dir, 'nope.ts'))}`)
    assert.equal(missing.status, 404)

    const missingRelative = await fetch(`${origin}/hub/preview?path=no-such-preview-file-xyz.ts`)
    assert.equal(missingRelative.status, 404)

    const named = join(dir, 'Dockerfile')
    writeFileSync(named, 'FROM scratch\n')
    const docker = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(named)}`)
    assert.equal(docker.status, 200)

    const binary = join(dir, 'fake.ts')
    writeFileSync(binary, Buffer.from([0x00, 0x61, 0x62]))
    const sniffed = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(binary)}`)
    assert.equal(sniffed.status, 415)

    const unicode = join(dir, '说明.md')
    writeFileSync(unicode, '# hi\n')
    const md = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(unicode)}`)
    assert.equal(md.status, 200)
    assert.match(md.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/)

    const svgPath = join(dir, 'icon.svg')
    writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n')
    const svg = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(svgPath)}`)
    assert.equal(svg.status, 200)
    assert.match(svg.headers.get('content-type') ?? '', /text\/plain/)
    assert.match(svg.headers.get('content-disposition') ?? '', /^attachment;/)
    assert.equal(svg.headers.get('content-security-policy'), "default-src 'none'")
    assert.equal(svg.headers.get('x-content-type-options'), 'nosniff')
  } finally {
    await close()
  }
})

test('preview refuses paths outside roots, including symlink escape', async () => {
  const ws = join(dir, 'ws')
  const evil = join(dir, 'ws-evil')
  mkdirSync(ws)
  mkdirSync(evil)
  writeFileSync(join(ws, 'ok.ts'), 'inside\n')
  writeFileSync(join(evil, 'secret.ts'), 'outside\n')
  symlinkSync(join(evil, 'secret.ts'), join(ws, 'link.ts'))
  const { origin, close } = await listen([ws])
  try {
    const ok = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(join(ws, 'ok.ts'))}`)
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), 'inside\n')

    const abs = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(join(evil, 'secret.ts'))}`)
    assert.equal(abs.status, 403)
    assert.equal(await abs.text(), 'path not allowed')

    const linked = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(join(ws, 'link.ts'))}`)
    assert.equal(linked.status, 403)
  } finally {
    await close()
  }
})

test('preview serves a second registered workspace root', async () => {
  const first = join(dir, 'first-ws')
  const second = join(dir, 'second-ws')
  mkdirSync(first)
  mkdirSync(second)
  writeFileSync(join(second, 'other.ts'), 'second\n')
  const { origin, close } = await listen([first, second])
  try {
    const ok = await fetch(`${origin}/hub/preview?path=${encodeURIComponent(join(second, 'other.ts'))}`)
    assert.equal(ok.status, 200)
    assert.equal(await ok.text(), 'second\n')
  } finally {
    await close()
  }
})

test('collectPreviewRoots includes cwd and workspace paths', () => {
  const cwd = process.cwd()
  const roots = collectPreviewRoots({
    workspaceRegistry: {
      list: () => [{ path: '/tmp/extra-ws' }, { path: cwd }, { path: '' }, {}],
    },
  })
  assert.equal(roots[0], cwd)
  assert.ok(roots.includes('/tmp/extra-ws'))
  assert.ok(roots.includes(cwd))
})
