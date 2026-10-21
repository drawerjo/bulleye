import { makeBook } from './lib/view.js'
import { Overlayer } from './lib/overlayer.js'
import { icon } from './icons.js'
import { NOTES } from './whatsnew.js'

const $ = id => document.getElementById(id)
const store = {
  get(k, d) { try { const v = localStorage.getItem('pw:' + k); return v ? JSON.parse(v) : d } catch { return d } },
  set(k, v) { try { localStorage.setItem('pw:' + k, JSON.stringify(v)) } catch {} },
}
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms) } }
const BOOKRE = /\.(epub|mobi|azw3?|azw|kf8|fb2|cbz)$/i

// true when this browser already holds bulleye data (so an update, not a first install)
const hadData = (() => { try { return localStorage.getItem('pw:prefs') != null || localStorage.getItem('pw:recent') != null } catch { return false } })()
const THEMES = ['dark', 'light', 'sepia', 'black']
const prefs = Object.assign({ zoom: 100, flow: 'scrolled', spread: 1, theme: 'dark', start: 'title', accent: 'bronze', customAccent: '#d9a066', autoSpeed: 3, usage: true, ttsRate: 1, ttsVoice: '', hlColor: 'yellow' }, store.get('prefs', {}))
if (!THEMES.includes(prefs.theme)) prefs.theme = 'dark'
const savePrefs = () => store.set('prefs', prefs)

// ---------- storage ----------
// Web version: a copy of each opened book is kept in this browser (IndexedDB).
const idb = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((res, rej) => {
      const r = indexedDB.open('pagewise', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('books')
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    }))
  },
  async tx(mode, fn) {
    const db = await this.open()
    return new Promise((res, rej) => {
      const t = db.transaction('books', mode), req = fn(t.objectStore('books'))
      t.oncomplete = () => res(req?.result); t.onerror = t.onabort = () => rej(t.error)
    })
  },
  put(key, val) { return this.tx('readwrite', s => s.put(val, key)) },
  get(key) { return this.tx('readonly', s => s.get(key)) },
  del(key) { return this.tx('readwrite', s => s.delete(key)) },
}
// Cover pictures live in their own small database so a big library never fills the settings store.
const covers = new Map()
const coverDb = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((res, rej) => {
      const r = indexedDB.open('bulleye-meta', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('covers')
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    }))
  },
  async run(mode, fn) {
    const db = await this.open()
    return new Promise((res, rej) => {
      const t = db.transaction('covers', mode), req = fn(t.objectStore('covers'))
      t.oncomplete = () => res(req?.result); t.onerror = t.onabort = () => rej(t.error)
    })
  },
  async loadAll() {
    const db = await this.open()
    await new Promise(res => {
      const t = db.transaction('covers', 'readonly'), req = t.objectStore('covers').openCursor()
      req.onsuccess = () => { const c = req.result; if (c) { covers.set(c.key, c.value); c.continue() } }
      t.oncomplete = res; t.onerror = t.onabort = res
    })
  },
}
const setCover = (key, url) => { covers.set(key, url); coverDb.run('readwrite', s => s.put(url, key)).catch(() => {}) }
const dropCover = key => { covers.delete(key); coverDb.run('readwrite', s => s.delete(key)).catch(() => {}) }
try {
  await coverDb.loadAll()
  // covers used to be kept in the settings store; move them over
  for (const k of Object.keys(localStorage)) if (k.startsWith('pw:cover:')) {
    try { setCover(k.slice(9), JSON.parse(localStorage.getItem(k))); localStorage.removeItem(k) } catch {}
  }
} catch (e) { console.warn(e) }

let recent = store.get('recent', [])
const recentList = () => recent
const persistRecent = debounce(() => store.set('recent', recent), 700)
const flushRecent = () => store.set('recent', recent)
addEventListener('pagehide', flushRecent)
document.addEventListener('visibilitychange', () => { if (document.hidden) flushRecent() })

let view = null, curFile = null, currentPath = '', bookKey = null, bookName = '', total = 0, page = 0, bookmarks = [], notes = [], highlights = []
let opening = false

// ---------- helpers ----------
const toast = (msg, ms = 1800) => {
  const t = $('toast'); t.textContent = msg; t.classList.add('show')
  clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove('show'), ms)
}
const label = x => typeof x === 'string' ? x : (x && Object.values(x)[0]) || ''

// ---------- colours ----------
// Bronze is the original look. The other eight sit evenly around the colour wheel.
const ACCENTS = [
  { id: 'bronze', name: 'Bronze (default)', dark: '#d9a066', light: '#a9692b', linkDark: '#e0b184', linkLight: '#8f5420' },
  { id: 'red', name: 'Red', dark: '#ef6b6b', light: '#c62f2f' },
  { id: 'orange', name: 'Orange', dark: '#f39a45', light: '#c4580a' },
  { id: 'yellow', name: 'Yellow', dark: '#e8c443', light: '#92720a' },
  { id: 'green', name: 'Green', dark: '#66c47a', light: '#2a8444' },
  { id: 'cyan', name: 'Cyan', dark: '#4ec9d6', light: '#0b7f8d' },
  { id: 'blue', name: 'Blue', dark: '#6aa3f2', light: '#2563c9' },
  { id: 'purple', name: 'Purple', dark: '#a98af0', light: '#6a3fc9' },
  { id: 'magenta', name: 'Magenta', dark: '#e56cc2', light: '#b0238a' },
]
const lum = hex => { const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2] }
const isDark = () => prefs.theme === 'dark' || prefs.theme === 'black'
const PAGE = { dark: { bg: '#1a1b1e', fg: '#d8d6d2' }, light: { bg: '#ffffff', fg: '#1b1b1b' }, sepia: { bg: '#f4ecd8', fg: '#4a3a2a' }, black: { bg: '#000000', fg: '#cfcdc8' } }
const accent = () => {
  const dark = isDark()
  if (prefs.accent === 'custom' && /^#[0-9a-f]{6}$/i.test(prefs.customAccent)) {
    const c = prefs.customAccent
    return { main: c, link: c }
  }
  const a = ACCENTS.find(x => x.id === prefs.accent) || ACCENTS[0]
  return { main: dark ? a.dark : a.light, link: dark ? (a.linkDark || a.dark) : (a.linkLight || a.light) }
}
const applyAccent = () => {
  const { main } = accent()
  const st = document.documentElement.style
  st.setProperty('--accent', main); st.setProperty('--accent-soft', main + (isDark() ? '26' : '1f'))
  st.setProperty('--on-accent', lum(main) > 0.42 ? '#1b1308' : '#ffffff')
}

const bookCSS = () => {
  const dark = isDark(), { main, link } = accent(), pg = PAGE[prefs.theme]
  return `
    html { color-scheme: ${dark ? 'dark' : 'light'}; background: ${pg.bg}; color: ${pg.fg}; }
    body { font-size: ${prefs.zoom}% !important; }
    a:link { color: ${link}; }
    p, li, blockquote, dd { line-height: 1.6; }
    ::selection { background: ${main}59; }
  `
}

const applyTheme = () => {
  document.documentElement.dataset.theme = prefs.theme
  applyAccent()
  const bg = PAGE[prefs.theme].bg
  if (view) view.style.background = bg
  view?.renderer?.setStyles?.(bookCSS())
  redrawNotes(); fillSelColors()
  syncSettings()
}

const isScroller = () => view?.renderer?.localName === 'foliate-scroller'
const applyLayout = () => {
  const r = view?.renderer
  if (!r || opening) return
  const scrolled = prefs.flow === 'scrolled'
  // switching between continuous scrolling and page turning swaps the reading engine
  if (!view.isFixedLayout && isScroller() !== scrolled) { reopen(); return }
  if (isScroller()) {
    r.setAttribute('max-inline-size', '760px')
    r.setAttribute('margin', '36px')
  } else if (r.localName === 'foliate-paginator') {
    r.setAttribute('flow', 'paginated')
    r.setAttribute('animated', '')
    const cols = prefs.spread === 2 ? 2 : 1
    r.setAttribute('max-column-count', String(cols))
    const w = $('stage').clientWidth || 1200
    r.setAttribute('max-inline-size', (cols === 2 ? Math.max(260, Math.min(620, Math.floor(w / 2) - 10)) : 760) + 'px')
    r.setAttribute('gap', cols === 2 ? '6%' : '5%')
    r.setAttribute('margin', '36px')
  }
  const cols = !scrolled && prefs.spread === 2 ? 2 : 1
  $('flowUse').setAttribute('href', scrolled ? '#i-gallery-vertical' : '#i-gallery-horizontal')
  $('flowBtn').title = scrolled ? 'Scrolling. Click to turn pages instead' : 'Turning pages. Click to scroll instead'
  $('flowBtn').classList.toggle('on', scrolled)
  $('spreadUse').setAttribute('href', cols === 2 ? '#i-book-open' : '#i-file')
  $('spreadBtn').title = cols === 2 ? 'Two pages. Click for one page' : 'One page. Click to show two pages side by side'
  $('spreadBtn').classList.toggle('on', cols === 2)
  syncSettings()
}

const applyZoom = () => {
  $('zoomLabel').textContent = prefs.zoom + '%'
  view?.renderer?.setStyles?.(bookCSS())
  syncSettings()
}

// ---------- library page ----------
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const who = a => Array.isArray(a) ? a.map(who).filter(Boolean).join(', ') : typeof a === 'string' ? a : a?.name ? label(a.name) : ''
const hue = t => { let h = 0; for (const c of String(t)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360 }
const initials = t => String(t).replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?'
const pctOf = b => Math.max(0, Math.min(100, Math.round((b.fraction ?? (b.total ? b.page / b.total : 0)) * 100)))
const fmtSize = n => !n ? '–' : n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'
const fmtOpened = t => {
  if (!t) return 'Not opened yet'
  const d = new Date(t), now = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86400000)
  if (diff === 0) return 'Today, ' + time
  if (diff === 1) return 'Yesterday, ' + time
  return d.toLocaleDateString('en-GB', d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })
}
const coverHTML = b => {
  const c = covers.get(b.key)
  if (c) return `<img class="cover" alt="" src="${c}">`
  const h = hue(b.name)
  return `<div class="cover"><div class="ph" style="background:linear-gradient(145deg,hsl(${h} 36% 36%),hsl(${(h + 45) % 360} 40% 22%))">${esc(initials(b.name))}</div></div>`
}
let libFilter = 'all', libMode = store.get('libmode', 'list'), libQuery = ''

const stateOf = b => { const p = pctOf(b); return p >= 98 ? 'finished' : p >= 1 ? 'reading' : 'new' }
const SORTS = { opened: 'Last opened', title: 'Title', author: 'Author', added: 'Date added' }
let libSort = Object.assign({ by: 'opened', rev: false }, store.get('libsort', {}))
if (!SORTS[libSort.by]) libSort.by = 'opened'
const nameCmp = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' })
const sorter = () => {
  const { by, rev } = libSort
  const base = by === 'title' ? nameCmp
    : by === 'author' ? (a, b) => (!a.author - !b.author) || String(a.author || '').localeCompare(String(b.author || ''), undefined, { sensitivity: 'base' }) || nameCmp(a, b)
    : by === 'added' ? (a, b) => (b.added || 0) - (a.added || 0) || nameCmp(a, b)
    : (a, b) => (b.opened || 0) - (a.opened || 0) || (b.added || 0) - (a.added || 0) || nameCmp(a, b)
  return rev ? (a, b) => base(b, a) : base
}

function renderLibrary() {
  const all = recentList().slice()
  const counts = { all: all.length, reading: 0, finished: 0, new: 0 }
  for (const b of all) counts[stateOf(b)]++
  for (const k in counts) $('c-' + k).textContent = counts[k] || ''
  for (const btn of $('nav').querySelectorAll('button')) btn.classList.toggle('on', btn.dataset.f === libFilter)

  const wrap = $('libwrap')
  if (!all.length) {
    wrap.innerHTML = `<div class="emptylib"><h2>Your library is empty</h2>
      <p>Add an EPUB (Electronic Publication), MOBI (Mobipocket) or AZW3 (Amazon Kindle Format 8) book, or add a whole folder of them. bulleye remembers where you stopped. You can also drop a book anywhere on this page.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center"><button class="btn-primary" data-act="add">${icon('plus')}Add book</button>
      <button class="btn-ghost" data-act="folder">${icon('folder-plus')}Add folder</button></div></div>`
    return
  }
  const q = libQuery.trim().toLowerCase()
  const list = all.filter(b => (libFilter === 'all' || stateOf(b) === libFilter) &&
    (!q || (b.name + ' ' + (b.author || '')).toLowerCase().includes(q))).sort(sorter())

  let html = `<div class="hello"><h1>Library</h1><span class="muted">${all.length} ${all.length === 1 ? 'book' : 'books'}</span></div>`
  const latest = all.reduce((m, b) => b.opened > (m?.opened || 0) ? b : m, null)
  if (!q && libFilter === 'all' && latest) {
    const b = latest, p = pctOf(b), done = p >= 98
    html += `<section class="hero" aria-label="Most recent book">
      <div data-open="${esc(b.key)}" style="cursor:pointer">${coverHTML(b)}</div>
      <div class="info">
        <span class="eyebrow">${done ? 'Last read' : 'Continue reading'}</span>
        <h2>${esc(b.name)}</h2>
        ${b.author ? `<span class="by">${esc(b.author)}</span>` : ''}
        <div class="meter"><div class="bar${done ? ' done' : ''}"><i style="width:${p}%"></i></div><span>${p}%${b.total ? ` · Page ${b.page} of ${b.total}` : ''}</span></div>
        <div class="actions"><button class="btn-primary" data-open="${esc(b.key)}">${icon('book-open')}${done ? 'Read again' : 'Continue reading'}</button>
        <span class="facts">${[b.ext, fmtSize(b.size), 'Opened ' + fmtOpened(b.opened)].filter(x => x && x !== '–').join(' · ')}</span></div>
      </div></section>`
  }
  html += `<section><div class="sectionhead"><h3>${libFilter === 'all' ? 'All books' : { reading: 'In progress', finished: 'Finished', new: 'Not started' }[libFilter]}</h3>
    <div class="rt"><select class="sortsel" data-sort aria-label="Sort books">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${libSort.by === k ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <button class="ib" data-rev title="${libSort.rev ? 'Reversed order. Click to flip back' : 'Click to reverse the order'}" aria-label="Reverse order" style="margin-right:8px">${icon(libSort.rev ? 'arrow-up-wide-narrow' : 'arrow-down-narrow-wide')}</button>
    <div class="seg" role="group" aria-label="View"><button data-mode="list" class="${libMode === 'list' ? 'on' : ''}" title="List" aria-label="List view">${icon('list')}</button><button data-mode="grid" class="${libMode === 'grid' ? 'on' : ''}" title="Grid" aria-label="Grid view">${icon('layout-grid')}</button></div></div></div>`
  if (!list.length) html += `<div class="nomatch">No books match${q ? ` “${esc(libQuery)}”` : ' this filter'}.</div>`
  else if (libMode === 'grid') {
    html += '<div class="grid">' + list.map(b => `<div class="card" tabindex="0" data-open="${esc(b.key)}">${coverHTML(b)}
      <b>${esc(b.name)}</b><div class="bar${pctOf(b) >= 98 ? ' done' : ''}"><i style="width:${pctOf(b)}%"></i></div>
      <small>${pctOf(b)}% · ${fmtOpened(b.opened)}</small>
      <button class="ib rowx" data-del="${esc(b.key)}" title="Remove from library" aria-label="Remove ${esc(b.name)} from library">${icon('trash-2')}</button></div>`).join('') + '</div>'
  } else {
    html += `<table class="books"><thead><tr><th>Name</th><th>Progress</th><th class="hide-s">Opened</th><th class="hide-s">Size</th><th></th></tr></thead><tbody>` +
      list.map(b => `<tr tabindex="0" data-open="${esc(b.key)}"><td><div class="namecell">${coverHTML(b)}<div class="t"><b>${esc(b.name)}</b><small>${esc([b.ext, b.author].filter(Boolean).join(' · '))}</small></div></div></td>
        <td><div class="pcell"><div class="bar${pctOf(b) >= 98 ? ' done' : ''}"><i style="width:${pctOf(b)}%"></i></div><span>${pctOf(b)}%</span></div></td>
        <td class="muted hide-s">${fmtOpened(b.opened)}</td><td class="muted hide-s">${fmtSize(b.size)}</td>
        <td style="width:44px;text-align:right"><button class="ib rowx" data-del="${esc(b.key)}" title="Remove from library" aria-label="Remove ${esc(b.name)} from library">${icon('trash-2')}</button></td></tr>`).join('') + '</tbody></table>'
  }
  wrap.innerHTML = html + '</section>'
}

async function removeBook(key) {
  try { await idb.del(key) } catch {}
  recent = recent.filter(y => y.key !== key); flushRecent()
  dropCover(key)
  try { for (const k of ['pos:', 'bm:', 'notes:', 'hl:']) localStorage.removeItem('pw:' + k + key) } catch {}
  renderLibrary(); toast('Removed from library')
}

$('libwrap').addEventListener('click', e => {
  const del = e.target.closest('[data-del]'); if (del) { e.stopPropagation(); removeBook(del.dataset.del); return }
  const open = e.target.closest('[data-open]'); if (open) { openFromLibrary(open.dataset.open); return }
  if (e.target.closest('[data-rev]')) { libSort.rev = !libSort.rev; store.set('libsort', libSort); renderLibrary(); return }
  const mode = e.target.closest('[data-mode]'); if (mode) { libMode = mode.dataset.mode; store.set('libmode', libMode); renderLibrary(); return }
  if (e.target.closest('[data-act="add"]')) $('file').click()
  if (e.target.closest('[data-act="folder"]')) addFolder()
})
$('libwrap').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('[data-open]')) openFromLibrary(e.target.dataset.open)
})
$('libwrap').addEventListener('change', e => {
  const sel = e.target.closest('[data-sort]'); if (!sel) return
  libSort.by = sel.value; libSort.rev = false; store.set('libsort', libSort); renderLibrary()
})
$('nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-f]'); if (!b) return
  libFilter = b.dataset.f; renderLibrary()
})
$('q').addEventListener('input', e => { libQuery = e.target.value; renderLibrary() })

let session = { opened: 0, size: 0, author: '', ext: '' }
const rememberRecent = fraction => {
  const old = recent.find(b => b.key === bookKey)
  recent = recent.filter(b => b.key !== bookKey)
  recent.unshift({ key: bookKey, name: bookName, author: session.author, ext: session.ext, size: session.size, opened: session.opened,
    added: old?.added || session.opened, page, total, fraction, path: currentPath })
  if (recent.length > 3000) recent.length = 3000
  persistRecent()
}
async function coverDataURL(book) {
  try {
    const blob = await book.getCover?.()
    if (!blob) return null
    const bmp = await createImageBitmap(blob)
    const w = 180, h = Math.round(bmp.height * w / bmp.width)
    const c = document.createElement('canvas'); c.width = w; c.height = h
    c.getContext('2d').drawImage(bmp, 0, 0, w, h)
    return c.toDataURL('image/jpeg', 0.72)
  } catch { return null }
}
async function saveCover(book, key) {
  const url = await coverDataURL(book)
  if (url) setCover(key, url)
}

// ---------- adding a whole folder ----------
// Only reads each book's title, author, cover and length. Nothing is opened.
let folderCancel = false
async function importBooks(items) {
  folderCancel = false
  const dlg = $('folderDlg')
  $('folderMsg').textContent = `Found ${items.length} ${items.length === 1 ? 'book' : 'books'}`
  $('folderBar').style.width = '0%'; $('folderSub').textContent = ''
  dlg.showModal()
  let added = 0, had = 0, failed = 0, i = 0
  for (const it of items) {
    if (folderCancel) break
    i++
    const name = it.name, key = `${name}|${it.size}`
    $('folderMsg').textContent = `Adding ${i} of ${items.length}`
    $('folderSub').textContent = name
    $('folderBar').style.width = Math.round((i - 1) / items.length * 100) + '%'
    await new Promise(r => setTimeout(r, 0))
    const known = recent.find(b => b.key === key)
    if (known) { had++; if (it.path && !known.path) known.path = it.path; continue }
    try {
      const file = it.file || new File([await window.bulleye.read(it.path)], name)
      const book = await makeBook(file)
      const meta = book.metadata
      const sizes = (book.sections || []).map(s => s && s.linear !== 'no' && s.size > 0 ? s.size : 0)
      const pages = Math.max(1, Math.ceil(sizes.reduce((a, b) => a + b, 0) / 1500))
      const cover = await coverDataURL(book)
      if (cover) setCover(key, cover)
      if (!window.bulleye && !it.path) await idb.put(key, { name, type: file.type, blob: file, added: Date.now() })
      recent.push({ key, name: label(meta?.title) || name.replace(/\.[^.]+$/, ''), author: who(meta?.author), ext: (name.split('.').pop() || '').toUpperCase(),
        size: it.size, opened: 0, added: Date.now(), page: 0, total: pages, fraction: 0, path: it.path || '' })
      added++
    } catch (e) { console.warn(name, e); failed++ }
    if (i % 8 === 0) { flushRecent(); renderLibrary() }
  }
  flushRecent(); dlg.close(); renderLibrary()
  const parts = [`Added ${added} ${added === 1 ? 'book' : 'books'}`]
  if (had) parts.push(`${had} already in your library`)
  if (failed) parts.push(`${failed} could not be read`)
  if (folderCancel) parts.push('stopped early')
  toast(parts.join(' · '), 5000)
}
async function addFolder() {
  if (window.bulleye?.pickFolder) {
    const r = await window.bulleye.pickFolder()
    if (!r) return
    if (!r.files.length) return toast('No ebooks were found in that folder.', 4000)
    return importBooks(r.files.map(f => ({ path: f.path, size: f.size, name: f.path.split(/[\\/]/).pop() })))
  }
  $('folderInput').click()
}
$('folderBtn').onclick = addFolder
$('folderCancel').onclick = () => { folderCancel = true }
$('folderDlg').addEventListener('cancel', e => { e.preventDefault(); folderCancel = true })
$('folderInput').onchange = e => {
  const files = [...e.target.files].filter(f => BOOKRE.test(f.name)); e.target.value = ''
  if (!files.length) return toast('No ebooks were found in that folder.', 4000)
  importBooks(files.map(f => ({ file: f, name: f.name, size: f.size })))
}

// Desktop app: open a book straight from its place on disk (no copy needed)
async function openPath(p) {
  const buf = await window.bulleye.read(p)
  const name = p.split(/[\\/]/).pop()
  await openFile(new File([buf], name), { path: p, fromLibrary: true })
}
async function openFromLibrary(key) {
  const rec = recentList().find(b => b.key === key)
  if (window.bulleye && rec?.path) {
    try { return await openPath(rec.path) } catch (err) {
      console.error(err); toast('Could not find this book where it was saved. Add it again from its new location.'); return
    }
  }
  try {
    const rec = await idb.get(key)
    if (!rec) throw new Error('missing')
    await openFile(new File([rec.blob], rec.name, { type: rec.type }), { fromLibrary: true })
  } catch (err) {
    console.error(err)
    toast('This book is no longer stored here. Choose the file again to add it back.')
    $('file').click()
  }
}
const setView = v => { document.body.dataset.view = v }
const showLibrary = () => {
  stopAuto(); stopTTS(); hidePop(); flushRecent(); resetSearch()
  if (view) { view.close?.(); view.remove(); view = null }
  curFile = null
  setView('library')
  document.title = 'bulleye'
  $('bookTitle').textContent = ''
  $('side').classList.remove('show'); $('sideBtn').classList.remove('on')
  renderLibrary()
}

// ---------- opening ----------
// "Chapter one": the book's own marker if it has one, otherwise the first contents entry that
// looks like a chapter, otherwise the first entry that is not front matter.
const FRONT = /^(cover|title|half.?title|copyright|contents|table of contents|dedication|epigraph|foreword|preface|acknowledg|about|also by|praise|introduction|prologue|map|list of|note)/i
function chapterOneTarget() {
  const bm = (view.book.landmarks || []).find(l => /bodymatter|text/i.test([].concat(l.type || []).join(' ')))
  if (bm?.href) return bm.href
  const flat = []; const walk = l => { for (const it of l || []) { flat.push(it); walk(it.subitems) } }; walk(view.book.toc)
  const lbl = it => label(it.label).trim()
  const hit = flat.find(it => /^(chapter|part|book|section)?\s*(1|one|i)\b[.:\s-]*/i.test(lbl(it)) && !FRONT.test(lbl(it)))
    || flat.find(it => /^chapter\b/i.test(lbl(it)))
    || flat.find(it => lbl(it) && !FRONT.test(lbl(it)))
  return hit?.href || null
}
const firstReadable = () => Math.max(0, view.book.sections.findIndex(s => s && s.linear !== 'no' && s.load))
const openFile = async (file, opts = {}) => {
  if (!file) return
  opening = true
  currentPath = opts.path || (window.bulleye ? window.bulleye.pathOf(file) : '')
  try {
    const wantAuto = pendingAuto
    stopAuto(); stopTTS(); hidePop(); pendingAuto = wantAuto
    resetSearch(); pace.last = null
    if (view) { view.close?.(); view.remove(); view = null }
    curFile = file
    bookKey = `${file.name}|${file.size}`
    bookName = file.name.replace(/\.[^.]+$/, '')
    view = document.createElement('foliate-view')
    view.addEventListener('wheel', onWheel, { passive: true })   // wheel over the page margins
    $('stage').append(view)
    await view.open(file, { continuous: prefs.flow === 'scrolled' })
    setView('reader')
    if (!opts.fromLibrary && !window.bulleye) {
      idb.put(bookKey, { name: file.name, type: file.type, blob: file, added: Date.now() })
        .catch(() => toast('Could not store a copy of this book, so you will need to choose it again next time.'))
    }

    const meta = view.book.metadata
    bookName = label(meta?.title) || bookName
    session = { opened: Date.now(), size: file.size, author: who(meta?.author), ext: (file.name.split('.').pop() || '').toUpperCase() }
    if (!covers.get(bookKey)) saveCover(view.book, bookKey).catch(() => {})
    $('bookTitle').textContent = bookName
    document.title = bookName + ' – bulleye'

    view.addEventListener('load', e => hookDoc(e.detail.doc))
    view.addEventListener('relocate', onRelocate)
    view.addEventListener('create-overlay', e => drawNotesFor(e.detail.index))
    view.addEventListener('draw-annotation', e => {
      const h = highlights.find(x => x.cfi === e.detail.annotation.value)
      e.detail.draw(Overlayer.highlight, { color: h ? hlHex(h.color) : accent().main })
    })
    view.addEventListener('show-annotation', e => {
      const h = highlights.find(x => x.cfi === e.detail.value), n = notes.find(x => x.cfi === e.detail.value)
      const doc = e.detail.range?.startContainer?.ownerDocument
      if (h && doc) showBar(doc, e.detail.range, h)
      else if (n) editNote(n)
    })
    view.renderer.addEventListener?.('autoend', () => { stopAuto(); toast('You reached the end of the book.') })
    opening = false
    applyLayout(); applyTheme(); applyZoom()

    bookmarks = store.get('bm:' + bookKey, [])
    notes = store.get('notes:' + bookKey, [])
    highlights = store.get('hl:' + bookKey, [])
    buildToc(view.book.toc || [])
    renderBookmarks(); renderNotes(); renderHighlights()

    const saved = store.get('pos:' + bookKey, null)
    const resolved = saved?.cfi ? view.resolveNavigation(saved.cfi) : null
    if (resolved) await view.init({ lastLocation: saved.cfi })
    else if (prefs.start === 'chapter') { const h = chapterOneTarget(); if (h) await view.goTo(h); else await view.init({ showTextStart: true }) }
    else await view.goTo(firstReadable())
    if (resolved && !opts.reopen) toast(`Resumed at page ${saved.page}`)
    if (pendingAuto) { pendingAuto = false; startAuto() }
  } catch (err) {
    console.error(err)
    opening = false
    if (view) { view.remove(); view = null }
    setView('library'); renderLibrary()
    toast('Could not open this file. It may be protected by DRM or damaged.')
  }
}
// same book, other reading engine (scrolling <-> page turning); keeps your place
const reopen = () => {
  if (!curFile || opening) return
  const wasAuto = !!auto.on
  pendingAuto = pendingAuto || (wasAuto && prefs.flow === 'scrolled')
  return openFile(curFile, { path: currentPath, fromLibrary: true, reopen: true })
}

// ---------- progress / page numbers ----------
// A "page" is a fixed-size slice of the book text (about 1,500 characters), so the total
// page count never changes with zoom, window size, or one/two-page layout.
function onRelocate({ detail }) {
  const { location, tocItem, fraction, cfi } = detail
  total = location.total
  page = Math.min(location.current + 1, total)
  $('pageNum').value = page
  $('pageTotal').textContent = '/ ' + total
  trackPace()
  const left = timeLeft()
  $('percent').textContent = Math.round(fraction * 100) + '% read' + (left ? ' · ' + left + ' left' : '')
  $('chapter').textContent = label(tocItem?.label) || ''
  store.set('pos:' + bookKey, { cfi, page, total })
  rememberRecent(fraction)
  markCurrentToc(tocItem?.href)
  hidePop()
}

// ---------- reading time left ----------
// Learns how many seconds you spend on a counted page (1,500 characters). Nothing is shown until a few pages are read.
let paceSamples = store.get('pace', []).filter(x => x > 0).slice(-40)
const pace = { last: null, t: 0, key: null }
function trackPace() {
  const now = performance.now()
  if (pace.last != null && pace.key === bookKey && page !== pace.last) {
    const d = page - pace.last, secs = (now - pace.t) / 1000
    if (d >= 1 && d <= 2 && !auto.on && !tts.on && !document.hidden && secs / d >= 5 && secs / d <= 300) {
      paceSamples.push(secs / d); if (paceSamples.length > 40) paceSamples.shift(); store.set('pace', paceSamples)
    }
  }
  if (pace.last == null || pace.key !== bookKey || page !== pace.last) { pace.last = page; pace.t = now }
  pace.key = bookKey
}
function timeLeft() {
  if (paceSamples.length < 5 || !total) return ''
  const sorted = paceSamples.slice().sort((a, b) => a - b), med = sorted[sorted.length >> 1]
  const mins = Math.round((total - page) * med / 60)
  if (mins < 1) return 'less than a minute'
  if (mins < 60) return 'about ' + mins + ' min'
  const h = Math.floor(mins / 60), m = Math.round((mins % 60) / 5) * 5
  return 'about ' + (m === 60 ? (h + 1) + ' h' : h + ' h' + (m ? ' ' + m + ' min' : ''))
}

const goPage = async n => {
  n = Math.max(1, Math.min(total, n | 0))
  // same arithmetic the engine uses for page numbers: one page = 1500 units of book text
  const sizes = view.book.sections.map(s => s && s.linear !== 'no' && s.size > 0 ? s.size : 0)
  const sizeTotal = sizes.reduce((a, b) => a + b, 0)
  await view.goToFraction(Math.min(0.99999, ((n - 1) * 1500 + 750) / sizeTotal))
}

// ---------- sidebar ----------
let tab = 'toc'
const setTab = t => {
  tab = t
  for (const [id, k] of [['tabToc', 'toc'], ['tabFind', 'find'], ['tabBm', 'bm'], ['tabHl', 'hl'], ['tabNotes', 'notes']]) $(id).classList.toggle('on', t === k)
  $('sideBody').replaceChildren({ toc: tocEl, find: findEl, bm: bmEl, hl: hlEl, notes: notesEl }[t])
}
const openSide = t => {
  $('side').classList.add('show'); $('sideBtn').classList.add('on'); setTab(t)
}
const tocEl = document.createElement('div'); tocEl.className = 'toc'
const bmEl = document.createElement('div')
const notesEl = document.createElement('div')
const hlEl = document.createElement('div')
const findEl = document.createElement('div')
function buildToc(items) {
  tocEl.replaceChildren()
  if (!items.length) { tocEl.innerHTML = '<div class="empty">This book has no table of contents.</div>'; return }
  const add = (list, depth) => {
    for (const it of list) {
      const a = document.createElement('a')
      a.textContent = label(it.label).trim() || '(untitled)'
      a.style.marginLeft = depth * 14 + 'px'
      a.dataset.href = it.href
      a.onclick = () => view.goTo(it.href)
      tocEl.append(a)
      if (it.subitems?.length) add(it.subitems, depth + 1)
    }
  }
  add(items, 0)
  setTab(tab)
}
function markCurrentToc(href) {
  for (const a of tocEl.querySelectorAll('a')) {
    const on = a.dataset.href === href
    a.style.background = on ? 'var(--hover)' : ''
    a.style.fontWeight = on ? '600' : ''
  }
}
function renderBookmarks() {
  bmEl.replaceChildren()
  if (!bookmarks.length) { bmEl.innerHTML = '<div class="empty">No bookmarks yet. Press the bookmark button (or Ctrl+D) to mark your place.</div>'; return }
  for (const b of bookmarks) {
    const row = document.createElement('div'); row.className = 'bm'
    const txt = document.createElement('span'); txt.innerHTML = `Page ${b.page}<br><small></small>`
    txt.querySelector('small').textContent = b.chapter || ''
    const x = document.createElement('button'); x.className = 'x'; x.innerHTML = icon('x', 'sm'); x.title = 'Delete bookmark'
    x.onclick = e => { e.stopPropagation(); bookmarks = bookmarks.filter(y => y !== b); store.set('bm:' + bookKey, bookmarks); renderBookmarks() }
    row.onclick = () => view.goTo(b.cfi)
    row.append(txt, x); bmEl.append(row)
  }
}
const addBookmark = () => {
  const loc = view?.lastLocation; if (!loc) return
  bookmarks.push({ cfi: loc.cfi, page, chapter: label(loc.tocItem?.label), t: Date.now() })
  bookmarks.sort((a, b) => a.page - b.page)
  store.set('bm:' + bookKey, bookmarks); renderBookmarks()
  toast(`Bookmarked page ${page}`)
}

// ---------- notes ----------
// A note belongs to a stretch of text. The text is highlighted; click it to read or change the note.
const saveNotes = () => store.set('notes:' + bookKey, notes)
const noteIndex = n => { if (n.index == null) { try { n.index = view.resolveNavigation(n.cfi)?.index ?? -1 } catch { n.index = -1 } } return n.index }
function drawNotesFor(index) { for (const n of [...notes, ...highlights]) if (noteIndex(n) === index) view.addAnnotation({ value: n.cfi }).catch(() => {}) }
function redrawNotes() { if (view) for (const n of [...notes, ...highlights]) view.addAnnotation({ value: n.cfi }).catch(() => {}) }
function renderNotes() {
  notesEl.replaceChildren()
  if (!notes.length) { notesEl.innerHTML = '<div class="empty">No notes yet. Select some text and press “Add note”, or press the note button (Ctrl+M) to attach a note to the text on screen.</div>'; return }
  for (const n of notes.slice().sort((a, b) => a.page - b.page || a.t - b.t)) {
    const row = document.createElement('div'); row.className = 'note'
    row.innerHTML = `<div class="q"></div><div class="t"></div><small><span></span><span><button class="x" data-e title="Edit note" aria-label="Edit note">${icon('pencil', 'sm')}</button><button class="x" data-d title="Delete note" aria-label="Delete note">${icon('trash-2', 'sm')}</button></span></small>`
    row.querySelector('.q').textContent = n.quote || ''
    row.querySelector('.t').textContent = n.text || ''
    row.querySelector('small span').textContent = `Page ${n.page}${n.chapter ? ' · ' + n.chapter : ''}`
    row.onclick = e => {
      if (e.target.closest('[data-d]')) { e.stopPropagation(); deleteNote(n); return }
      if (e.target.closest('[data-e]')) { e.stopPropagation(); editNote(n); return }
      view.goTo(n.cfi)
    }
    notesEl.append(row)
  }
}
function deleteNote(n) {
  notes = notes.filter(x => x !== n); saveNotes(); renderNotes()
  view?.deleteAnnotation({ value: n.cfi })?.catch?.(() => {})
  toast('Note deleted')
}
// where on the page (in counted pages) a stretch of text sits
function pageOfRange(doc, index, range) {
  try {
    if (isScroller()) {
      const sizes = view.book.sections.map(s => s && s.linear !== 'no' && s.size > 0 ? s.size : 0)
      const h = doc.documentElement.getBoundingClientRect().height || 1
      const r = range.getBoundingClientRect()
      const before = sizes.slice(0, index).reduce((a, b) => a + b, 0)
      return Math.min(total, Math.floor((before + Math.max(0, Math.min(1, r.top / h)) * sizes[index]) / 1500) + 1)
    }
  } catch {}
  return page
}
let editing = null
function openNoteDialog(n) {
  editing = n
  $('noteHead').textContent = n.id ? 'Edit note' : 'New note'
  $('noteQuote').textContent = n.quote || ''
  $('noteText').value = n.text || ''
  $('noteDel').style.display = n.id ? '' : 'none'
  $('noteDlg').showModal()
  $('noteText').focus()
}
const editNote = n => openNoteDialog(n)
function newNoteFrom(doc, range) {
  const found = view.renderer.getContents().find(c => c.doc === doc)
  if (!found) return
  const index = found.index
  const quote = range.toString().replace(/\s+/g, ' ').trim().slice(0, 400)
  const cfi = view.getCFI(index, range)
  const existing = notes.find(x => x.cfi === cfi)
  if (existing) return openNoteDialog(existing)
  openNoteDialog({ cfi, index, quote, text: '', page: pageOfRange(doc, index, range), chapter: label(view.lastLocation?.tocItem?.label), t: Date.now(), isNew: true })
}
$('noteSave').onclick = () => {
  const n = editing; if (!n) return
  n.text = $('noteText').value.trim()
  if (!n.text && n.isNew) { $('noteDlg').close(); return toast('Write something first, or cancel.') }
  if (n.isNew) { delete n.isNew; n.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6); notes.push(n); view.addAnnotation({ value: n.cfi }).catch(() => {}) }
  saveNotes(); renderNotes(); $('noteDlg').close()
  toast('Note saved')
  if (!$('side').classList.contains('show')) { /* keep the page uncluttered */ }
}
$('noteDel').onclick = () => { const n = editing; $('noteDlg').close(); if (n?.id) deleteNote(n) }
$('noteCancel').onclick = $('noteClose').onclick = () => $('noteDlg').close()
$('noteDlg').addEventListener('close', () => { editing = null; for (const c of view?.renderer?.getContents?.() ?? []) c.doc.defaultView?.getSelection()?.removeAllRanges() })
$('noteText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('noteSave').click() })

// the first few words that are on screen, for "add a note here"
function visibleStart(range) {
  try {
    const doc = range.startContainer.ownerDocument
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    for (let node = w.nextNode(); node; node = w.nextNode()) {
      if (!node.nodeValue.trim()) continue
      if (range.comparePoint(node, node.nodeValue.length) < 0) continue
      const r = doc.createRange()
      const from = range.comparePoint(node, 0) < 0 ? range.startOffset : 0
      r.setStart(node, from); r.setEnd(node, Math.min(node.nodeValue.length, from + 120))
      if (r.toString().trim()) return r
    }
  } catch {}
  return null
}
function addNoteHere() {
  if (!view) return
  for (const c of view.renderer.getContents()) {
    const sel = c.doc.getSelection()
    if (sel && !sel.isCollapsed && sel.rangeCount) return newNoteFrom(c.doc, sel.getRangeAt(0))
  }
  const range = view.lastLocation?.range
  const r = range && visibleStart(range)
  if (!r) return toast('Could not find text here to attach a note to.')
  newNoteFrom(r.startContainer.ownerDocument, r)
}
// ---------- highlighter ----------
const HLC = [{ id: 'yellow', name: 'Yellow', c: '#f2cc3c' }, { id: 'green', name: 'Green', c: '#4fc96f' }, { id: 'blue', name: 'Blue', c: '#5aa2f5' }, { id: 'pink', name: 'Pink', c: '#ee6fb4' }]
const hlHex = id => (HLC.find(x => x.id === id) || HLC[0]).c
const saveHighlights = () => store.set('hl:' + bookKey, highlights)
function renderHighlights() {
  hlEl.replaceChildren()
  if (!highlights.length) { hlEl.innerHTML = '<div class="empty">No highlights yet. Select some text and choose a colour, or press Ctrl+H to highlight it.</div>'; return }
  for (const h of highlights.slice().sort((a, b) => a.page - b.page || a.t - b.t)) {
    const row = document.createElement('div'); row.className = 'note'
    row.innerHTML = `<div class="q hl"></div><small><span></span><span><button class="x" data-d title="Remove highlight" aria-label="Remove highlight">${icon('trash-2', 'sm')}</button></span></small>`
    row.querySelector('.q').style.setProperty('--hc', hlHex(h.color))
    row.querySelector('.q').textContent = h.quote || ''
    row.querySelector('small span').innerHTML = `<i class="hldot" style="--hc:${hlHex(h.color)}"></i>`
    row.querySelector('small span').append(`Page ${h.page}${h.chapter ? ' · ' + h.chapter : ''}`)
    row.onclick = e => {
      if (e.target.closest('[data-d]')) { e.stopPropagation(); removeHighlight(h); return }
      view.goTo(h.cfi)
    }
    hlEl.append(row)
  }
}
function addHighlight(doc, range, color) {
  const found = view.renderer.getContents().find(c => c.doc === doc); if (!found) return
  const cfi = view.getCFI(found.index, range)
  let h = highlights.find(x => x.cfi === cfi)
  if (h) h.color = color
  else {
    h = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), cfi, index: found.index, color, page: pageOfRange(doc, found.index, range),
      quote: range.toString().replace(/\s+/g, ' ').trim().slice(0, 400), chapter: label(view.lastLocation?.tocItem?.label), t: Date.now() }
    highlights.push(h)
  }
  prefs.hlColor = color; savePrefs()
  saveHighlights(); renderHighlights()
  view.addAnnotation({ value: cfi }).catch(() => {})
}
function removeHighlight(h) {
  highlights = highlights.filter(x => x !== h); saveHighlights(); renderHighlights()
  view?.deleteAnnotation({ value: h.cfi })?.then?.(() => { if (notes.some(n => n.cfi === h.cfi)) view.addAnnotation({ value: h.cfi }).catch(() => {}) })?.catch?.(() => {})
  toast('Highlight removed')
}
function highlightSelection() {
  if (!view) return
  for (const c of view.renderer.getContents()) {
    const sel = c.doc.getSelection()
    if (sel && !sel.isCollapsed && sel.rangeCount && sel.toString().trim()) {
      addHighlight(c.doc, sel.getRangeAt(0), prefs.hlColor); sel.removeAllRanges(); hidePop(); return
    }
  }
  toast('Select some text first, then press Highlight.')
}
$('hlBtn').onclick = highlightSelection

// small bar that appears next to selected text (or a clicked highlight)
let popSel = null, barAt = 0
const hidePop = () => { $('notepop').classList.remove('show'); popSel = null }
function fillSelColors(cur) {
  $('selColors').innerHTML = HLC.map(c => `<button type="button" class="c${cur === c.id ? ' cur' : ''}" data-c="${c.id}" style="--hc:${c.c}" title="Highlight ${c.name.toLowerCase()}" aria-label="Highlight ${c.name.toLowerCase()}"></button>`).join('')
}
function showBar(doc, range, h) {
  const fr = doc.defaultView.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const rects = [...range.getClientRects()].filter(r => r.width > 0)
  const last = rects[rects.length - 1]; if (!last) return hidePop()
  popSel = { doc, range: range.cloneRange(), h }; barAt = performance.now()
  fillSelColors(h?.color)
  const pop = $('notepop')
  pop.querySelector('[data-a="remove"]').hidden = !h
  pop.querySelector('[data-a="define"]').hidden = !!h
  pop.querySelector('[data-a="read"]').hidden = !!h
  pop.classList.add('show')
  const x = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, fr.left + last.right - pop.offsetWidth / 2))
  const y = Math.max(60, Math.min(innerHeight - 48, fr.top + last.bottom + 8))
  pop.style.left = x + 'px'; pop.style.top = y + 'px'
}
function checkSelection(doc) {
  if (!view) return
  const sel = doc.getSelection()
  if (!sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) {
    if (popSel?.h && performance.now() - barAt < 500) return    // the click that just opened a highlight's bar
    return hidePop()
  }
  showBar(doc, sel.getRangeAt(0), null)
}
$('notepop').addEventListener('mousedown', e => e.preventDefault())
document.addEventListener('mousedown', e => { if (!e.target.closest?.('#notepop')) hidePop() })
$('notepop').onclick = e => {
  const b = e.target.closest('button'); if (!b || !popSel) return
  const s = popSel; hidePop()
  if (b.dataset.c) {
    if (s.h) { s.h.color = b.dataset.c; saveHighlights(); renderHighlights(); view.addAnnotation({ value: s.h.cfi }).catch(() => {}); prefs.hlColor = b.dataset.c; savePrefs() }
    else { addHighlight(s.doc, s.range, b.dataset.c); s.doc.getSelection()?.removeAllRanges() }
    return
  }
  const a = b.dataset.a
  if (a === 'note') newNoteFrom(s.doc, s.range)
  else if (a === 'define') lookup(s.range.toString())
  else if (a === 'read') startTTS(s.range)
  else if (a === 'remove' && s.h) removeHighlight(s.h)
}

// ---------- search inside the book ----------
findEl.innerHTML = `<label class="searchbox">${icon('search', 'sm')}<input type="search" placeholder="Search in this book" autocomplete="off" aria-label="Search in this book"></label><div class="sstat"></div><div class="hits"></div>`
const findInput = findEl.querySelector('input'), findStat = findEl.querySelector('.sstat'), findHits = findEl.querySelector('.hits')
let searchToken = 0
const MAXHITS = 500
function resetSearch() {
  searchToken++; findInput.value = ''; findStat.textContent = ''; findHits.replaceChildren()
  try { view?.clearSearch?.() } catch {}
}
async function runSearch(q) {
  const token = ++searchToken
  findHits.replaceChildren(); try { view?.clearSearch?.() } catch {}
  q = q.trim()
  if (!view) return
  if (q.length < 2) { findStat.textContent = q ? 'Type at least 2 letters' : ''; return }
  findStat.textContent = 'Searching…'
  let count = 0
  try {
    for await (const r of view.search({ query: q, drawOptions: { color: accent().main, width: 2 } })) {
      if (token !== searchToken) return
      if (r === 'done') break
      if (r.progress != null) { findStat.textContent = `Searching… ${Math.round(r.progress * 100)}%`; continue }
      if (!r.subitems) continue
      const head = document.createElement('div'); head.className = 'shead'; head.textContent = r.label || 'Book'
      findHits.append(head)
      for (const it of r.subitems) {
        const b = document.createElement('button'); b.className = 'hit'; b.type = 'button'
        const m = document.createElement('b'); m.textContent = it.excerpt.match
        b.append(it.excerpt.pre, m, it.excerpt.post)
        b.onclick = () => view.goTo(it.cfi)
        findHits.append(b); count++
      }
      if (count >= MAXHITS) break
    }
  } catch (e) { console.warn(e) }
  if (token !== searchToken) return
  findStat.textContent = count ? `${count >= MAXHITS ? count + '+' : count} ${count === 1 ? 'match' : 'matches'}` : 'No matches'
}
findInput.addEventListener('input', debounce(() => runSearch(findInput.value), 350))
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(findInput.value) }
  else if (e.key === 'Escape') { e.preventDefault(); resetSearch() }
})
function openFind() {
  if (!view) return
  openSide('find'); findInput.focus(); findInput.select()
}
$('findBtn').onclick = openFind

// ---------- read aloud ----------
// Uses the voices already installed on the computer (the browser's speech synthesis).
const synth = window.speechSynthesis
const tts = { on: false, paused: false, doc: null, index: -1, sents: [], map: [], text: '', i: 0, token: 0 }
const RATES = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5]
const BLOCK = 'p,div,h1,h2,h3,h4,h5,h6,li,blockquote,tr,td,th,section,article,pre,dd,dt,figcaption,aside,header,footer'
const sleep = ms => new Promise(r => setTimeout(r, ms))
let voicesWaited = false
function fillVoices() {
  const sel = $('ttsVoice')
  const lang = String(view?.language?.canonical || navigator.language || 'en').toLowerCase().split('-')[0]
  const vs = synth ? [...synth.getVoices()] : []
  const mine = v => v.lang.toLowerCase().startsWith(lang)
  vs.sort((a, b) => (mine(b) - mine(a)) || a.name.localeCompare(b.name))
  sel.innerHTML = vs.map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name.replace(/^Microsoft /, '').replace(/ - .*$/, ''))}</option>`).join('')
  const pick = vs.find(v => v.voiceURI === prefs.ttsVoice) || vs.find(v => mine(v) && v.default) || vs.find(mine) || vs.find(v => v.default) || vs[0]
  if (pick) sel.value = pick.voiceURI
  sel.hidden = !vs.length
  $('ttsMsg').hidden = vs.length > 0
  $('ttsMsg').textContent = voicesWaited ? 'No voices were found on this computer.' : 'Looking for voices…'
}
if (synth) synth.addEventListener?.('voiceschanged', fillVoices)
function paintTTS() {
  $('ttsbar').classList.toggle('show', tts.on)
  $('ttsBtn').classList.toggle('on', tts.on)
  $('ttsPlayUse').setAttribute('href', tts.paused ? '#i-play' : '#i-pause')
  $('ttsRate').textContent = prefs.ttsRate + 'x'
}
function buildSentences(doc) {
  const map = []; let text = '', prevBlock = null
  const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: n => { const p = n.parentElement; return !p || /^(script|style|noscript|title|rt|rp)$/i.test(p.tagName) || p.closest('[hidden]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT },
  })
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const blk = n.parentElement.closest(BLOCK) || doc.body
    if (prevBlock && blk !== prevBlock) text += '\n'
    prevBlock = blk
    map.push({ node: n, from: text.length }); text += n.nodeValue
  }
  const seg = new Intl.Segmenter(view?.language?.canonical || 'en', { granularity: 'sentence' })
  const sents = []
  for (const { segment, index } of seg.segment(text)) {
    let a = index, b = index + segment.length
    while (a < b && /\s/.test(text[a])) a++
    while (b > a && /\s/.test(text[b - 1])) b--
    if (!/[\p{L}\p{N}]/u.test(text.slice(a, b))) continue
    while (b - a > 350) {   // very long sentences are spoken in pieces
      let cut = text.lastIndexOf(' ', a + 300); if (cut <= a + 100) cut = a + 300
      sents.push({ a, b: cut }); a = cut + 1
    }
    sents.push({ a, b })
  }
  for (const x of sents) x.text = text.slice(x.a, x.b).replace(/\s+/g, ' ')
  return { map, text, sents }
}
function locate(map, pos, end) {
  let lo = 0, hi = map.length - 1, k = 0
  while (lo <= hi) { const m = (lo + hi) >> 1; if (map[m].from <= pos) { k = m; lo = m + 1 } else hi = m - 1 }
  const e = map[k]; return [e.node, Math.max(0, Math.min(e.node.nodeValue.length, pos - e.from))]
}
const sentRange = s => {
  const r = tts.doc.createRange()
  const [n1, o1] = locate(tts.map, s.a), [n2, o2] = locate(tts.map, s.b - 1)
  r.setStart(n1, o1); r.setEnd(n2, Math.min(n2.nodeValue.length, o2 + 1)); return r
}
function loadSentences(doc, index, startRange) {
  const b = buildSentences(doc)
  Object.assign(tts, { doc, index, sents: b.sents, map: b.map, text: b.text, i: 0 })
  if (startRange) {
    const e = b.map.find(m => m.node === startRange.startContainer)
    if (e) { const pos = e.from + startRange.startOffset; const k = b.sents.findIndex(x => x.b > pos); tts.i = k < 0 ? 0 : k }
  }
}
function clearMark() {
  try { tts.doc && view?.renderer?.getContents?.().find(c => c.doc === tts.doc)?.overlayer?.remove('tts') } catch {}
}
function mark(s) {
  try {
    clearMark()
    const range = sentRange(s)
    view.renderer.getContents().find(c => c.doc === tts.doc)?.overlayer?.add('tts', range, Overlayer.highlight, { color: accent().main })
    const fr = tts.doc.defaultView.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 }
    const r = range.getBoundingClientRect(), st = $('stage').getBoundingClientRect()
    const top = fr.top + r.top, bottom = fr.top + r.bottom, left = fr.left + r.left
    if (!(top >= st.top + 30 && bottom <= st.bottom - 90 && left >= st.left - 2 && left <= st.right - 20)) view.renderer.scrollToAnchor(range)
  } catch (e) { console.warn(e) }
}
function speakCurrent() {
  const t = ++tts.token
  const s = tts.sents[tts.i]
  if (!s) return nextChapter()
  mark(s)
  const u = new SpeechSynthesisUtterance(s.text)
  const v = synth.getVoices().find(x => x.voiceURI === $('ttsVoice').value)
  if (v) { try { u.voice = v } catch {} u.lang = v.lang }
  u.rate = prefs.ttsRate
  u.onend = () => { if (t === tts.token && tts.on && !tts.paused) { tts.i++; speakCurrent() } }
  u.onerror = e => { if (t === tts.token && e.error !== 'interrupted' && e.error !== 'canceled') { toast('Read aloud stopped (' + e.error + ').', 4000); stopTTS() } }
  synth.speak(u)
}
async function nextChapter() {
  const t = tts.token
  const secs = view.book.sections
  let j = tts.index + 1
  while (j < secs.length && !(secs[j] && secs[j].linear !== 'no' && secs[j].size > 0)) j++
  if (j >= secs.length) { toast('Finished reading the book aloud.'); return stopTTS() }
  await view.renderer.goTo({ index: j })
  let doc = null
  for (let k = 0; k < 50 && !doc; k++) { doc = view.renderer.getContents().find(c => c.index === j)?.doc; if (!doc) await sleep(100) }
  if (t !== tts.token || !tts.on) return
  if (!doc) { toast('Read aloud stopped.'); return stopTTS() }
  loadSentences(doc, j)
  speakCurrent()
}
const ttsJump = () => { tts.token++; synth.cancel(); setTimeout(() => { if (tts.on && !tts.paused) speakCurrent() }, 40) }
async function startTTS(from) {
  if (!view) return
  if (!synth) return toast('Read aloud is not available on this computer.', 4000)
  stopAuto()
  fillVoices()
  if (!voicesWaited) setTimeout(() => { voicesWaited = true; fillVoices() }, 1500)
  const range = from || (view.lastLocation?.range && visibleStart(view.lastLocation.range))
  if (!range) return toast('Could not find text to read here.')
  const doc = range.startContainer.ownerDocument
  const found = view.renderer.getContents().find(c => c.doc === doc)
  if (!found) return
  tts.token++; synth.cancel()
  tts.on = true; tts.paused = false
  loadSentences(doc, found.index, range)
  paintTTS()
  setTimeout(() => { if (tts.on && !tts.paused) speakCurrent() }, 40)
}
function stopTTS() {
  if (!tts.on) { paintTTS(); return }
  tts.on = false; tts.paused = false; tts.token++
  try { synth?.cancel() } catch {}
  clearMark(); paintTTS()
}
$('ttsBtn').onclick = () => tts.on ? stopTTS() : startTTS()
$('ttsStop').onclick = stopTTS
$('ttsPlay').onclick = () => {
  if (!tts.on) return
  tts.paused = !tts.paused
  if (tts.paused) { tts.token++; synth.cancel() } else speakCurrent()
  paintTTS()
}
$('ttsPrev').onclick = () => { if (!tts.on) return; tts.i = Math.max(0, tts.i - 1); tts.paused = false; paintTTS(); ttsJump() }
$('ttsNext').onclick = () => { if (!tts.on) return; tts.i++; tts.paused = false; paintTTS(); ttsJump() }
const setRate = d => {
  const k = Math.max(0, Math.min(RATES.length - 1, RATES.indexOf(prefs.ttsRate) + d))
  prefs.ttsRate = RATES[k]; savePrefs(); paintTTS(); if (tts.on && !tts.paused) ttsJump()
}
$('ttsSlow').onclick = () => setRate(-1)
$('ttsFast').onclick = () => setRate(1)
$('ttsVoice').onchange = e => { prefs.ttsVoice = e.target.value; savePrefs(); if (tts.on && !tts.paused) ttsJump() }
if (!RATES.includes(prefs.ttsRate)) prefs.ttsRate = 1

// ---------- dictionary ----------
// Looks a word up online. Two free services are tried in turn, so one being down does not stop it:
// the Free Dictionary API (dictionaryapi.dev), then Wiktionary (Wikimedia). Nothing is stored in the app.
const DICT_LANGS = ['en', 'es', 'fr', 'de', 'it', 'pt-BR', 'ru', 'tr', 'ja', 'ko', 'ar', 'hi']
const plain = html => { try { return new DOMParser().parseFromString(String(html), 'text/html').body.textContent.replace(/\s+/g, ' ').trim() } catch { return String(html) } }
// the desktop app asks its own process to fetch (no browser restrictions); the web page fetches directly
async function getJson(url) {
  if (window.bulleye?.fetchJson) return window.bulleye.fetchJson(url)
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000)
  try {
    const r = await fetch(url, { signal: ctl.signal })
    return { status: r.status, data: r.ok ? await r.json().catch(() => null) : null }
  } catch (e) { return { status: 0, error: e?.name === 'AbortError' ? 'timed out' : 'no connection' } } finally { clearTimeout(timer) }
}
const DICT_PROVIDERS = [
  { name: 'Free Dictionary API (dictionaryapi.dev)',
    urls: (w, l) => [`https://api.dictionaryapi.dev/api/v2/entries/${l}/${encodeURIComponent(w)}`],
    parse: data => {
      if (!Array.isArray(data) || !data.length) return null
      const byPos = new Map()
      for (const e of data) for (const m of e.meanings || []) {
        const list = byPos.get(m.partOfSpeech) || []; list.push(...(m.definitions || []).map(d => ({ definition: d.definition, example: d.example }))); byPos.set(m.partOfSpeech, list)
      }
      const groups = [...byPos].filter(([, d]) => d.length)
      return groups.length ? { phonetic: data.map(e => e.phonetic || e.phonetics?.find(x => x.text)?.text).find(Boolean) || '', groups } : null
    } },
  { name: 'Wiktionary (Wikimedia)',
    urls: (w, l) => { const lang = l.split('-')[0], cap = w[0].toUpperCase() + w.slice(1); return [...new Set([w, cap])].map(x => `https://${lang}.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(x)}`) },
    parse: (data, l) => {
      if (!data || typeof data !== 'object') return null
      const sec = data[l.split('-')[0]] || data.en
      if (!Array.isArray(sec)) return null
      const groups = sec.map(x => [x.partOfSpeech, (x.definitions || []).map(d => ({ definition: plain(d.definition), example: plain((d.examples || d.parsedExamples?.map(p => p.example) || [])[0] || '') })).filter(d => d.definition)]).filter(([, d]) => d.length)
      return groups.length ? { phonetic: '', groups } : null
    } },
]
async function fetchDefinition(word, lang) {
  const problems = []
  for (const p of DICT_PROVIDERS) {
    let sawError = null
    for (const url of p.urls(word, lang)) {
      const r = await getJson(url)
      if (r.status >= 200 && r.status < 300) {
        const parsed = p.parse(r.data, lang)
        if (parsed) return { status: 'ok', ...parsed, source: p.name }
      } else if (r.status !== 404) sawError = r.error || `error ${r.status}`
    }
    if (sawError) problems.push(`${p.name.split(' (')[0]}: ${sawError}`)
  }
  return problems.length ? { status: 'error', problems } : { status: 'none' }
}
async function lookup(text) {
  const word = (String(text).match(/[\p{L}][\p{L}'’-]*/u) || [''])[0].replace(/’/g, "'").toLowerCase()
  if (!word) return toast('Select a word first.')
  const body = $('defBody')
  const show = html => { body.innerHTML = `<div><span class="defword"></span><span class="defph"></span></div>${html}`; body.querySelector('.defword').textContent = word }
  show('<p class="muted">Looking up…</p>'); if (!$('defDlg').open) $('defDlg').showModal()
  if (navigator.onLine === false) return show('<p>You are offline. The dictionary needs an internet connection. Try again when you are back online.</p>')
  const base = String(view?.language?.canonical || 'en').split('-')[0]
  const lang = DICT_LANGS.includes(base) ? base : 'en'
  const r = await fetchDefinition(word, lang)
  if (r.status === 'error') {
    show('<p>Could not reach the dictionary services. Check your internet connection and try again.</p><div class="defsrc"></div>')
    body.querySelector('.defsrc').textContent = 'Details: ' + r.problems.join(' · ')
    return
  }
  if (r.status === 'none') return show('<p>No definition was found for this word. Try the base form of the word, for example “run” instead of “running”.</p>')
  const frag = document.createElement('div')
  for (const [pos, defs] of r.groups.slice(0, 5)) {
    const h = document.createElement('div'); h.className = 'defpos'; h.textContent = pos || 'definition'
    const ol = document.createElement('ol')
    for (const d of defs.slice(0, 3)) {
      const li = document.createElement('li'); li.append(d.definition || '')
      if (d.example) { const em = document.createElement('em'); em.textContent = '“' + d.example + '”'; li.append(em) }
      ol.append(li)
    }
    frag.append(h, ol)
  }
  show('')
  body.querySelector('.defph').textContent = r.phonetic
  body.append(frag)
  const src = document.createElement('div'); src.className = 'defsrc'; src.textContent = 'Source: ' + r.source + '.'
  body.append(src)
}
$('defClose').onclick = () => $('defDlg').close()
$('defDlg').addEventListener('click', e => { if (e.target === $('defDlg')) $('defDlg').close() })

// ---------- what's new ----------
const cmpv = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d }
  return 0
}
function openNews(versions) {
  const vs = versions.filter(v => NOTES[v]); if (!vs.length) return
  $('newsTitle').textContent = vs.length === 1 ? `What’s new in bulleye ${vs[0]}` : 'What’s new in bulleye'
  $('newsBody').innerHTML = vs.map(v => (vs.length > 1 ? `<div class="newshead">bulleye ${v}</div>` : '') +
    `<ul class="newslist">${NOTES[v].items.map(([ic, t, d]) => `<li>${icon(ic)}<div><b>${esc(t)}</b><small>${esc(d)}</small></div></li>`).join('')}</ul>`).join('')
  if (!$('newsDlg').open) $('newsDlg').showModal()
}
const newsVersions = () => Object.keys(NOTES).sort((a, b) => cmpv(b, a))
function checkNews(version) {
  const seen = store.get('seen', null)
  store.set('seen', version)
  let show = []
  if (seen == null) { if (hadData) show = [version] }                 // an existing user's first start on a version that has this pop-up
  else if (cmpv(version, seen) > 0) show = newsVersions().filter(k => cmpv(k, seen) > 0 && cmpv(k, version) <= 0)
  if (show.length) setTimeout(() => { if (!document.querySelector('dialog[open]')) openNews(show) }, 900)
}
$('newsClose').onclick = $('newsOk').onclick = () => $('newsDlg').close()
$('newsBtn').onclick = () => { $('settings').close(); openNews([currentVersion && NOTES[currentVersion] ? currentVersion : newsVersions()[0]]) }
let currentVersion = ''

// ---------- anonymous usage count ----------
// Once a day: a random number made on this computer, the bulleye version, and Windows / Linux / web.
// Nothing else is sent: no name, no files, no IP address is kept. It can be turned off in Settings.
const STATS_URL = 'https://bulleye-stats.thejosephgodfrey.workers.dev'
async function pingUsage() {
  if (!STATS_URL || prefs.usage === false) return
  const day = new Date().toISOString().slice(0, 10)
  if (store.get('pinged', '') === day) return
  let id = store.get('iid', '')
  if (!/^[a-f0-9]{32}$/.test(id)) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join(''); store.set('iid', id)
  }
  let info = null; try { info = await window.bulleye?.getInfo?.() } catch {}
  const v = info?.version || newsVersions()[0], p = info?.platform || 'web'
  try {
    const r = await fetch(STATS_URL + '/ping', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ id, v, p }) })
    if (r.ok) store.set('pinged', day)
  } catch {}
}
setTimeout(pingUsage, 6000)

// ---------- auto scroll ----------
// Gentle automatic scrolling, in scroll mode. Speed 1 is a slow reading pace; 10 is quick skimming.
const SPEEDS = [6, 9, 13, 19, 27, 38, 54, 76, 108, 152]   // pixels per second
const auto = { on: false, paused: false }
let pendingAuto = false
const speedPx = () => SPEEDS[Math.max(1, Math.min(10, prefs.autoSpeed)) - 1]
function paintAuto() {
  $('autobar').classList.toggle('show', auto.on)
  $('autoBtn').classList.toggle('on', auto.on)
  $('autoUse').setAttribute('href', auto.on && !auto.paused ? '#i-pause' : '#i-play')
  $('autoPlayUse').setAttribute('href', auto.paused ? '#i-play' : '#i-pause')
  $('autoLabel').textContent = 'Speed ' + prefs.autoSpeed
  $('autoBtn').title = auto.on ? 'Auto scroll is on. Click to stop' : 'Auto scroll'
}
function startAuto() {
  if (!view) return
  stopTTS()
  if (prefs.flow !== 'scrolled' || !isScroller()) {
    // auto scroll needs the scrolling layout
    pendingAuto = true; prefs.flow = 'scrolled'; savePrefs(); applyLayout()
    if (!opening && isScroller()) { pendingAuto = false; return startAuto() }
    return
  }
  auto.on = true; auto.paused = false
  view.renderer.startAuto(speedPx())
  paintAuto()
}
function stopAuto() {
  if (!auto.on && !pendingAuto) { paintAuto(); return }
  pendingAuto = false
  auto.on = false; auto.paused = false
  try { view?.renderer?.stopAuto?.() } catch {}
  paintAuto()
}
function pauseAuto() {
  if (!auto.on) return
  auto.paused = !auto.paused
  if (auto.paused) view.renderer.stopAuto(); else view.renderer.startAuto(speedPx())
  paintAuto()
}
function setSpeed(d) {
  prefs.autoSpeed = Math.max(1, Math.min(10, prefs.autoSpeed + d)); savePrefs()
  if (auto.on && !auto.paused) view.renderer.setAutoSpeed(speedPx())
  paintAuto()
}
$('autoBtn').onclick = () => auto.on ? stopAuto() : startAuto()
$('autoPlay').onclick = pauseAuto
$('autoSlow').onclick = () => setSpeed(-1)
$('autoFast').onclick = () => setSpeed(1)
$('autoStop').onclick = stopAuto

// ---------- keyboard and wheel ----------
// Page-by-page mode: the wheel drags the page along with your finger, then settles on a whole page.
let wheelAcc = 0, wheelTimer = 0, wheelLockUntil = 0
function onWheel(e) {
  if (!view || e.ctrlKey || isScroller()) return        // continuous scrolling is handled by the browser itself
  const r = view.renderer
  if (!r?.snap || performance.now() < wheelLockUntil) return
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
  if (!d) return
  const dir = d > 0 ? 1 : -1
  // at the first or last page of a chapter, a push goes straight to the neighbouring chapter
  if (!wheelAcc && ((dir > 0 && r.page >= r.pages - 2) || (dir < 0 && r.page <= 1))) {
    wheelLockUntil = performance.now() + 450
    dir > 0 ? view.goRight() : view.goLeft()
    return
  }
  wheelAcc += d
  try { r.scrollBy(d, 0) } catch {}
  clearTimeout(wheelTimer)
  wheelTimer = setTimeout(() => {
    const a = wheelAcc; wheelAcc = 0
    wheelLockUntil = performance.now() + 380
    try { r.snap(Math.abs(a) < 6 ? 0 : Math.sign(a) * 0.6, 0) } catch {}
  }, 90)
}
function hookDoc(doc) {
  doc.addEventListener('keydown', onKey)
  doc.addEventListener('wheel', onWheel, { passive: true })
  doc.addEventListener('mouseup', () => setTimeout(() => checkSelection(doc), 10))
  doc.addEventListener('keyup', e => { if (e.shiftKey || e.key === 'Shift') checkSelection(doc) })
  doc.addEventListener('mousedown', hidePop)
}
const turn = dir => {
  if (!view) return
  dir > 0 ? view.next() : view.prev()
}
function onKey(e) {
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); $('file').click(); return }
  if (view && !opening && ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return }
  if (!view || opening) return
  const t = e.target
  if (t?.matches?.('input, textarea, select') || document.querySelector('dialog[open]')) return
  if ((e.key === ' ' || e.key === 'Enter') && t?.closest?.('button, a')) return
  if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoom(10) }
  else if (ctrl && e.key === '-') { e.preventDefault(); zoom(-10) }
  else if (ctrl && e.key === '0') { e.preventDefault(); prefs.zoom = 100; savePrefs(); applyZoom() }
  else if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); addBookmark() }
  else if (ctrl && e.key.toLowerCase() === 'm') { e.preventDefault(); addNoteHere() }
  else if (ctrl && e.key.toLowerCase() === 'h') { e.preventDefault(); highlightSelection() }
  else if (e.key === 'F4') { e.preventDefault(); $('sideBtn').click() }
  else if (e.key === 'Escape' && auto.on) { e.preventDefault(); stopAuto() }
  else if (e.key === ' ' && auto.on && !e.shiftKey) { e.preventDefault(); pauseAuto() }
  else if (e.key === 'Escape' && tts.on) { e.preventDefault(); stopTTS() }
  else if (e.key === ' ' && tts.on && !e.shiftKey) { e.preventDefault(); $('ttsPlay').click() }
  else if (!ctrl && !e.altKey && !e.shiftKey && ['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) { e.preventDefault(); turn(1) }
  else if (!ctrl && !e.altKey && !e.shiftKey && ['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); turn(-1) }
  else if (!ctrl && !e.altKey && e.key === ' ') { e.preventDefault(); turn(e.shiftKey ? -1 : 1) }
}
document.addEventListener('keydown', e => { if (e.target.id !== 'pageNum') onKey(e) })
// Ctrl + mouse wheel zoom (like Acrobat)
document.addEventListener('wheel', e => { if (e.ctrlKey && view) { e.preventDefault(); zoom(e.deltaY < 0 ? 10 : -10) } }, { passive: false })

const zoom = d => { prefs.zoom = Math.max(50, Math.min(300, prefs.zoom + d)); savePrefs(); applyZoom() }

// ---------- wiring ----------
$('openBtn').onclick = () => $('file').click()
$('file').onchange = e => { openFile(e.target.files[0]); e.target.value = '' }
$('sideBtn').onclick = () => { $('side').classList.toggle('show'); $('sideBtn').classList.toggle('on', $('side').classList.contains('show')); setTab(tab) }
$('tabToc').onclick = () => setTab('toc'); $('tabBm').onclick = () => setTab('bm'); $('tabNotes').onclick = () => setTab('notes'); $('tabHl').onclick = () => setTab('hl'); $('tabFind').onclick = () => openFind()
$('prevBtn').onclick = () => turn(-1)
$('nextBtn').onclick = () => turn(1)
$('zoomIn').onclick = () => zoom(10); $('zoomOut').onclick = () => zoom(-10)
$('flowBtn').onclick = () => { stopAuto(); prefs.flow = prefs.flow === 'scrolled' ? 'paginated' : 'scrolled'; savePrefs(); applyLayout() }
$('spreadBtn').onclick = () => {
  stopAuto()
  if (prefs.flow === 'scrolled') { prefs.flow = 'paginated'; prefs.spread = 2; toast('Two-page view: use the wheel, arrow keys or ◀ ▶ to turn pages') }
  else prefs.spread = prefs.spread === 2 ? 1 : 2
  savePrefs(); applyLayout()
}
addEventListener('resize', debounce(() => applyLayout(), 120))
$('bmBtn').onclick = addBookmark
$('noteBtn').onclick = addNoteHere
$('themeBtn').onclick = () => { prefs.theme = THEMES[(THEMES.indexOf(prefs.theme) + 1) % THEMES.length]; savePrefs(); applyTheme(); toast(({ dark: 'Dark', light: 'Light', sepia: 'Sepia', black: 'Black' })[prefs.theme] + ' theme') }
$('pageNum').addEventListener('keydown', e => { if (e.key === 'Enter') { goPage(parseInt(e.target.value)); e.target.blur() } })
$('pageNum').addEventListener('focus', e => e.target.select())

const lm = $('libmain')
for (const ev of ['dragenter', 'dragover']) addEventListener(ev, e => { e.preventDefault(); lm.classList.add('drag') })
for (const ev of ['dragleave', 'drop']) addEventListener(ev, e => { e.preventDefault(); lm.classList.remove('drag') })
addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f && BOOKRE.test(f.name)) openFile(f) })

// clicking a toolbar button should not steal the keyboard (Space and arrows keep turning pages)
document.addEventListener('mousedown', e => { if (e.target.closest?.('.toolbar button, .autobar button, #notepop')) e.preventDefault() })
$('libBtn').onclick = showLibrary
document.documentElement.dataset.theme = prefs.theme; applyAccent()
setView('library'); renderLibrary()
{ // bulleye always starts on the library page. Only a book Windows asked us to open (Open with) is opened straight away.
  if (window.bulleye) {
    window.bulleye.onOpen(p => openPath(p).catch(() => toast('Could not open that file.')))
    window.bulleye.takePending().then(p => { if (p) openPath(p).catch(() => toast('Could not open that file.')) })
  }
}
// ---------- settings ----------
$('setZoom').innerHTML = [70, 80, 90, 100, 110, 125, 150, 175, 200, 250].map(z => `<option value="${z}">${z}%</option>`).join('')
$('setAccent').innerHTML = ACCENTS.map(a => `<button class="sw" role="radio" data-v="${a.id}" title="${a.name}" aria-label="${a.name}" style="--c:${a.dark}"></button>`).join('') +
  `<label class="sw custom" title="Pick your own colour" role="radio" data-v="custom"><input type="color" id="setCustom" aria-label="Pick your own colour"></label>`
function syncSettings() {
  for (const b of $('setTheme').children) b.classList.toggle('on', b.dataset.v === prefs.theme)
  for (const b of $('setFlow').children) b.classList.toggle('on', b.dataset.v === prefs.flow)
  for (const b of $('setStart').children) b.classList.toggle('on', b.dataset.v === prefs.start)
  for (const b of $('setAccent').children) b.setAttribute('aria-checked', String(b.dataset.v === prefs.accent))
  $('setCustom').value = /^#[0-9a-f]{6}$/i.test(prefs.customAccent) ? prefs.customAccent : '#d9a066'
  const z = String(prefs.zoom)
  if (![...$('setZoom').options].some(o => o.value === z)) $('setZoom').add(new Option(z + '%', z))
  $('setZoom').value = z
}
$('settingsBtn').onclick = () => { syncSettings(); $('settings').showModal() }
$('settingsClose').onclick = () => $('settings').close()
$('settings').addEventListener('click', e => { if (e.target === $('settings')) $('settings').close() })
$('setTheme').onclick = e => { const v = e.target.closest('button')?.dataset.v; if (v) { prefs.theme = v; savePrefs(); applyTheme() } }
$('setFlow').onclick = e => { const v = e.target.closest('button')?.dataset.v; if (v) { stopAuto(); prefs.flow = v; savePrefs(); applyLayout(); syncSettings() } }
$('setStart').onclick = e => { const v = e.target.closest('button')?.dataset.v; if (v) { prefs.start = v; savePrefs(); syncSettings() } }
$('setZoom').onchange = e => { prefs.zoom = +e.target.value; savePrefs(); applyZoom() }
$('setAccent').addEventListener('click', e => {
  const b = e.target.closest('.sw'); if (!b || b.dataset.v === 'custom') return
  prefs.accent = b.dataset.v; savePrefs(); applyTheme()
})
$('setCustom').addEventListener('input', e => { prefs.accent = 'custom'; prefs.customAccent = e.target.value; savePrefs(); applyTheme() })
syncSettings()

const deskBox = document.querySelector('.desktop-only')
if (!window.bulleye) deskBox.style.display = 'none'
else {
  const showVer = info => {
    currentVersion = info.version
    $('ver').textContent = `bulleye ${info.version}` + (info.update ? ` · update ${info.update} is ready` : '')
    $('verText').firstChild.textContent = `bulleye ${info.version}`
    $('verSmall').textContent = info.update ? `Update ${info.update} is ready. Close and reopen bulleye to use it.` : 'Updates download by themselves when bulleye starts.'
  }
  window.bulleye.getInfo?.().then(info => { showVer(info); checkNews(info.version) })
  window.bulleye.onUpdateReady?.(v => { toast(`bulleye ${v} was downloaded. Close and reopen bulleye to use it.`, 9000); window.bulleye.getInfo().then(showVer) })
  $('regBtn').onclick = async () => {
    if (!window.bulleye.registerTypes) return toast('This needs a newer version of bulleye.', 4000)
    const ok = await window.bulleye.registerTypes()
    toast(ok ? 'Done. bulleye is now in the Open with list for ebook files.' : 'This is not available on this computer.', 4500)
  }
  $('updBtn').onclick = async () => {
    if (!window.bulleye.checkUpdate) return toast('This needs a newer version of bulleye.', 4000)
    $('updBtn').disabled = true
    const r = await window.bulleye.checkUpdate().catch(() => ({ status: 'error' }))
    $('updBtn').disabled = false
    toast(r.status === 'downloaded' ? `bulleye ${r.version} was downloaded. Close and reopen bulleye to use it.`
      : r.status === 'latest' ? 'You have the latest version.' : 'Could not reach the update page. Check your internet and try again.', 5000)
    window.bulleye.getInfo().then(showVer)
  }
}
// links to other websites open in the normal browser
document.addEventListener('click', e => {
  const a = e.target.closest?.('a[data-ext]'); if (!a || !window.bulleye?.openExternal) return
  e.preventDefault(); window.bulleye.openExternal(a.href)
})
setTab('toc')
paintAuto()
globalThis.__pw = { openFile, get view() { return view }, prefs, get notes() { return notes }, get highlights() { return highlights }, importBooks, lookup, DICT_PROVIDERS, get tts() { return tts }, get paceSamples() { return paceSamples }, set paceSamples(v) { paceSamples = v }, openNews, checkNews }
