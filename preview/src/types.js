export const TEXT_MAX = 1_000_000
export const IMAGE_MAX = 12 * 1024 * 1024
export const PDF_MAX = 16 * 1024 * 1024

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const PDF = new Set(['pdf'])
const NAMED_TEXT = new Set([
  'dockerfile', 'makefile', 'gnumakefile',
  'license', 'licence', 'readme',
  'jenkinsfile', 'vagrantfile', 'procfile', 'gemfile', 'brewfile',
])
const TEXT = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts',
  'py', 'pyi', 'rs', 'go', 'java', 'kt', 'kts', 'scala',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'cs',
  'rb', 'php', 'swift', 'm', 'mm',
  'sh', 'bash', 'zsh', 'fish',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'xml', 'html', 'htm', 'css', 'scss', 'less',
  'md', 'markdown', 'mdx', 'rst',
  'txt', 'text', 'log', 'diff', 'patch',
  'sql', 'graphql', 'gql',
  'vue', 'svelte', 'lua',
  'proto', 'thrift',
  'ipynb',
  'dockerfile', 'makefile', 'mk', 'cmake',
  'gitignore', 'editorconfig', 'env',
  'r',
])
const BLOCKED = new Set([
  'csv', 'tsv', 'psv',
  'h5ad', 'h5', 'hdf5', 'hdf',
  'rds', 'rdata', 'rda',
  'parquet', 'feather', 'arrow', 'ipc',
  'xlsx', 'xlsm', 'xls', 'ods',
  'sqlite', 'sqlite3', 'db', 'db3',
  'nc', 'netcdf', 'zarr',
  'sav', 'dta', 'sas7bdat',
  'pkl', 'pickle', 'joblib',
  'npy', 'npz',
  'bam', 'sam', 'cram', 'vcf', 'bcf', 'bigwig', 'bw', 'bigbed', 'bed',
  'fasta', 'fa', 'fq', 'fastq',
  'tar', 'gz', 'tgz', 'zip', '7z', 'rar', 'bz2', 'xz', 'zst',
  'wasm', 'bin', 'exe', 'so', 'dylib', 'dll', 'o', 'a',
])

export function extensionOf(filePath) {
  const base = filePath.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function classify(filePath) {
  const base = (filePath.split(/[/\\]/).pop() ?? '').toLowerCase()
  if (NAMED_TEXT.has(base)) return 'text'
  const ext = extensionOf(filePath)
  if (ext === '') return 'unknown'
  if (BLOCKED.has(ext)) return 'blocked'
  if (IMAGE.has(ext)) return 'image'
  if (PDF.has(ext)) return 'pdf'
  if (TEXT.has(ext)) return 'text'
  return 'unknown'
}

export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8000)
  for (let i = 0; i < n; i += 1) {
    if (bytes[i] === 0) return true
  }
  return false
}

export function contentDisposition(name, download = false) {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replaceAll(/["\\]/g, '_')
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function maxBytesFor(kind) {
  if (kind === 'image') return IMAGE_MAX
  if (kind === 'pdf') return PDF_MAX
  if (kind === 'text') return TEXT_MAX
  return 0
}

export function contentTypeFor(filePath, kind) {
  const ext = extensionOf(filePath)
  if (kind === 'pdf') return 'application/pdf'
  if (kind === 'image') {
    if (ext === 'svg') return 'text/plain; charset=utf-8'
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'png') return 'image/png'
    if (ext === 'gif') return 'image/gif'
    if (ext === 'webp') return 'image/webp'
    if (ext === 'bmp') return 'image/bmp'
    if (ext === 'ico') return 'image/x-icon'
    if (ext === 'avif') return 'image/avif'
    return 'application/octet-stream'
  }
  return 'text/plain; charset=utf-8'
}
