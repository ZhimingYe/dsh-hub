window.__ModuleLoader__.load({
  id: '@dsh-hub/preview',
  factory: (require) => {
    const module = { exports: {} }
    const inject = ['workspaces', 'locale']

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

    const zh = {
      close: '关闭',
      copy: '复制',
      copied: '已复制',
      openTab: '新标签打开',
      loading: '加载中…',
      empty: '空文件',
      lines: '{count} 行',
      blocked: '表格和大型数据文件不支持在线预览',
      unknown: '无法预览此文件',
      tooLarge: '文件过大，无法预览',
      failed: '无法打开此文件',
    }
    const en = {
      close: 'Close',
      copy: 'Copy',
      copied: 'Copied',
      openTab: 'Open in new tab',
      loading: 'Loading…',
      empty: 'Empty file',
      lines: '{count} lines',
      blocked: 'Spreadsheets and large data files cannot be previewed',
      unknown: 'This file cannot be previewed',
      tooLarge: 'File is too large to preview',
      failed: 'Could not open this file',
    }

    function extensionOf(filePath) {
      const base = filePath.split(/[/\\]/).pop() ?? ''
      const dot = base.lastIndexOf('.')
      if (dot <= 0 || dot === base.length - 1) return ''
      return base.slice(dot + 1).toLowerCase()
    }

    function classify(filePath) {
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

    function basename(filePath) {
      return filePath.split(/[/\\]/).pop() || filePath
    }

    function previewUrl(filePath) {
      return `/hub/preview?path=${encodeURIComponent(filePath)}`
    }

    function isFolderHint(filePath) {
      if (filePath === '' || filePath === '.' || filePath === '..') return true
      return /[/\\]$/.test(filePath)
    }

    function compact() {
      return window.matchMedia('(max-width: 640px)').matches
    }

    function css(el, styles) {
      Object.assign(el.style, styles)
    }

    function pill(label) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = label
      css(btn, {
        flex: 'none',
        height: '32px',
        padding: '0 12px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
        borderRadius: '16px',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
      })
      return btn
    }

    let t = (key) => zh[key] ?? key
    let layer
    let objectUrl
    let generation = 0
    let abort
    let unbindText
    let lockedY = 0
    let previousFocus

    function revoke() {
      if (objectUrl !== undefined) {
        URL.revokeObjectURL(objectUrl)
        objectUrl = undefined
      }
    }

    function unlockScroll() {
      document.body.style.position = ''
      document.body.style.top = ''
      document.body.style.width = ''
      document.body.style.overflow = ''
      window.scrollTo(0, lockedY)
    }

    function lockScroll() {
      lockedY = window.scrollY
      document.body.style.position = 'fixed'
      document.body.style.top = `-${String(lockedY)}px`
      document.body.style.width = '100%'
      document.body.style.overflow = 'hidden'
    }

    function disposeLayer() {
      abort?.abort()
      abort = undefined
      unbindText?.()
      unbindText = undefined
      revoke()
      if (layer !== undefined) {
        layer.remove()
        layer = undefined
      }
      unlockScroll()
      document.removeEventListener('keydown', onKey)
    }

    function closePreview() {
      generation += 1
      disposeLayer()
      previousFocus?.focus?.()
      previousFocus = undefined
    }

    function onKey(event) {
      if (event.key === 'Escape') closePreview()
    }

    let noticeTimer
    function notice(text) {
      document.getElementById('dsh-hub-preview-toast')?.remove()
      const el = document.createElement('div')
      el.id = 'dsh-hub-preview-toast'
      el.textContent = text
      el.setAttribute('role', 'status')
      css(el, {
        position: 'fixed',
        left: '50%',
        bottom: 'max(24px, env(safe-area-inset-bottom))',
        transform: 'translateX(-50%)',
        zIndex: '3000',
        maxWidth: 'min(90vw, 28rem)',
        padding: '8px 14px',
        borderRadius: '14px',
        background: 'var(--dsw-alias-toast-bg, #353638)',
        color: 'var(--dsw-alias-label-primary-inverted, #fff)',
        font: '14px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
        boxShadow: '0 8px 24px rgba(0,0,0,.2)',
      })
      document.body.appendChild(el)
      clearTimeout(noticeTimer)
      noticeTimer = setTimeout(() => { el.remove() }, 2400)
    }

    function statusFrom(response) {
      if (response.status === 415) return t('unknown')
      if (response.status === 413) return t('tooLarge')
      return t('failed')
    }

    function shell(title, path) {
      disposeLayer()
      previousFocus = document.activeElement
      lockScroll()
      document.addEventListener('keydown', onKey)
      const narrow = compact()
      layer = document.createElement('div')
      css(layer, {
        position: 'fixed',
        inset: '0',
        zIndex: '2000',
        display: 'flex',
        alignItems: narrow ? 'stretch' : 'center',
        justifyContent: 'center',
        padding: narrow ? '0' : '24px',
      })
      const mask = document.createElement('div')
      mask.setAttribute('aria-hidden', 'true')
      css(mask, {
        position: 'absolute',
        inset: '0',
        background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,.24))',
        backdropFilter: 'var(--dsw-mask-blur, blur(8px))',
      })
      mask.addEventListener('click', closePreview)
      const panel = document.createElement('div')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-modal', 'true')
      panel.setAttribute('aria-label', title)
      css(panel, {
        position: 'relative',
        zIndex: '1',
        display: 'flex',
        flexDirection: 'column',
        width: narrow ? '100%' : 'min(920px, calc(100vw - 32px))',
        height: narrow ? '100dvh' : 'min(860px, calc(100vh - 32px))',
        maxHeight: narrow ? 'none' : 'calc(100dvh - 32px)',
        borderRadius: narrow ? '0' : '24px',
        overflow: 'hidden',
        background: 'var(--dsw-alias-bg-layer-2, #fff)',
        color: 'var(--dsw-alias-label-primary, #0f1115)',
        boxShadow: narrow ? 'none' : 'var(--dsw-shadow-lv3, 0 16px 48px rgba(15,17,21,.16))',
        font: '14px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
      })
      const bar = document.createElement('div')
      css(bar, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        flex: 'none',
        minHeight: '48px',
        padding: '8px 12px',
        paddingTop: narrow ? 'max(8px, env(safe-area-inset-top))' : '8px',
        borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.1))',
      })
      const name = document.createElement('div')
      name.textContent = title
      name.title = path
      css(name, {
        flex: '1',
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontWeight: '500',
      })
      const actions = document.createElement('div')
      css(actions, { display: 'flex', gap: '8px', flex: 'none' })
      const close = pill(t('close'))
      close.addEventListener('click', closePreview)
      actions.append(close)
      bar.append(name, actions)
      const body = document.createElement('div')
      css(body, {
        flex: '1',
        minHeight: '0',
        overflow: 'auto',
        WebkitOverflowScrolling: 'touch',
        display: 'flex',
        flexDirection: 'column',
      })
      panel.append(bar, body)
      layer.append(mask, panel)
      document.body.appendChild(layer)
      close.focus()
      return { body, actions, close }
    }

    function loadingEl() {
      const el = document.createElement('div')
      el.textContent = t('loading')
      css(el, {
        margin: 'auto',
        color: 'var(--dsw-alias-label-secondary, #61666b)',
      })
      return el
    }

    const LINE_PX = 20
    const PAD_PX = 16
    const OVERSCAN = 50
    const MAX_COLS = 2000

    function clipLine(line) {
      if (line.length <= MAX_COLS) return line
      return `${line.slice(0, MAX_COLS)}…`
    }

    function mountTextView(viewport, text) {
      const lines = text.split(/\r\n|\n|\r/)
      const display = lines.map(clipLine)
      css(viewport, {
        display: 'block',
        overflow: 'auto',
        WebkitOverflowScrolling: 'touch',
      })
      const inner = document.createElement('div')
      css(inner, {
        position: 'relative',
        height: `${String(PAD_PX * 2 + display.length * LINE_PX)}px`,
      })
      const windowEl = document.createElement('pre')
      css(windowEl, {
        position: 'absolute',
        left: '0',
        right: '0',
        margin: '0',
        padding: `0 ${String(PAD_PX)}px`,
        whiteSpace: 'pre',
        tabSize: '4',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '13px',
        lineHeight: `${String(LINE_PX)}px`,
      })
      inner.append(windowEl)
      viewport.append(inner)

      let ticking = false
      const paint = () => {
        const top = viewport.scrollTop
        const height = viewport.clientHeight || 1
        const first = Math.max(0, Math.floor((top - PAD_PX) / LINE_PX) - OVERSCAN)
        const last = Math.min(display.length, Math.ceil((top + height - PAD_PX) / LINE_PX) + OVERSCAN)
        windowEl.style.top = `${String(PAD_PX + first * LINE_PX)}px`
        windowEl.textContent = display.slice(first, last).join('\n')
      }
      const onScroll = () => {
        if (ticking) return
        ticking = true
        requestAnimationFrame(() => {
          ticking = false
          paint()
        })
      }
      viewport.addEventListener('scroll', onScroll, { passive: true })
      window.addEventListener('resize', onScroll)
      unbindText = () => {
        viewport.removeEventListener('scroll', onScroll)
        window.removeEventListener('resize', onScroll)
      }
      paint()
      return display.length
    }

    async function showPreview(filePath, kind) {
      const id = generation + 1
      generation = id
      const title = basename(filePath)
      const url = previewUrl(filePath)
      const { body, actions } = shell(title, filePath)
      const loading = loadingEl()
      body.append(loading)

      abort = new AbortController()
      let response
      try {
        response = await fetch(url, { credentials: 'same-origin', signal: abort.signal })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (id !== generation) return
        closePreview()
        notice(t('failed'))
        return
      }
      if (id !== generation) return
      if (!response.ok) {
        closePreview()
        notice(statusFrom(response))
        return
      }
      const media = response.headers.get('content-type') ?? ''
      if (media.includes('text/html')) {
        closePreview()
        notice(t('failed'))
        return
      }

      if (kind === 'image' || kind === 'pdf') {
        const svg = extensionOf(filePath) === 'svg'
        if (!svg) {
          const extra = pill(t('openTab'))
          extra.addEventListener('click', () => { window.open(url, '_blank', 'noopener') })
          actions.insertBefore(extra, actions.firstChild)
        }
      }

      if (kind === 'text') {
        const text = await response.text()
        if (id !== generation) return
        loading.remove()
        const extra = pill(t('copy'))
        extra.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(text)
            notice(t('copied'))
          } catch {
            notice(t('failed'))
          }
        })
        actions.insertBefore(extra, actions.firstChild)
        if (text.length === 0) {
          extra.remove()
          const empty = document.createElement('div')
          empty.textContent = t('empty')
          css(empty, { margin: 'auto', color: 'var(--dsw-alias-label-secondary, #61666b)' })
          body.append(empty)
          return
        }
        const count = mountTextView(body, text)
        const meta = document.createElement('div')
        meta.textContent = t('lines', { count: String(count) })
        css(meta, {
          flex: 'none',
          color: 'var(--dsw-alias-label-secondary, #61666b)',
          fontSize: '12px',
          lineHeight: '18px',
        })
        actions.parentElement?.insertBefore(meta, actions)
        return
      }

      const bytes = await response.arrayBuffer()
      if (id !== generation) return
      revoke()
      const svg = extensionOf(filePath) === 'svg'
      const blobType = svg ? 'image/svg+xml' : (response.headers.get('content-type') ?? 'application/octet-stream')
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: blobType }))
      loading.remove()

      if (kind === 'image') {
        const img = document.createElement('img')
        img.alt = title
        img.src = objectUrl
        css(img, {
          display: 'block',
          maxWidth: '100%',
          maxHeight: '100%',
          width: 'auto',
          height: 'auto',
          margin: 'auto',
          objectFit: 'contain',
        })
        body.style.alignItems = 'center'
        body.style.justifyContent = 'center'
        body.append(img)
        return
      }

      const frame = document.createElement('iframe')
      frame.title = title
      frame.src = objectUrl
      css(frame, {
        display: 'block',
        width: '100%',
        height: '100%',
        border: '0',
        background: 'var(--dsw-static-neutral-bluish-750, #43454a)',
      })
      body.append(frame)
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('hub-preview', { zh, en }), 'hub-preview: dictionaries')
      t = ctx.locale.bind('hub-preview')
      const workspaces = ctx.workspaces
      const previous = workspaces.openPath.bind(workspaces)
      workspaces.openPath = async (path) => {
        if (typeof path !== 'string' || isFolderHint(path)) return
        const kind = classify(path)
        if (kind === 'blocked') {
          notice(t('blocked'))
          return
        }
        if (kind === 'unknown') {
          notice(t('unknown'))
          return
        }
        try {
          await showPreview(path, kind)
        } catch {
          notice(t('failed'))
        }
      }
      ctx.effect(() => () => {
        workspaces.openPath = previous
        closePreview()
      }, 'hub-preview: openPath')
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
