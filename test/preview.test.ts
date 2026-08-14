import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, handlePreview } from '../preview/src/index.js'

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

async function listen(): Promise<{ origin: string, close: () => Promise<void> }> {
  const server = createServer((req, res) => { void handlePreview(req, res) })
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
