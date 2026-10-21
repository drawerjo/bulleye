// bulleye core: window, local file access, update checks and Windows "Open with" registration.
// Lives inside the updatable bundle, so changes here can ship as a small update.
const { app, BrowserWindow, protocol, net, ipcMain, Menu, nativeImage, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')

const REPO = process.env.BULLEYE_REPO || 'drawerjo/bulleye'
const API = process.env.BULLEYE_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`
const ASSET = 'bulleye-ui.asar' // the small update file attached to each GitHub release
const EXTS = ['.epub', '.mobi', '.azw', '.azw3', '.kf8', '.fb2', '.cbz']
const BOOK = /\.(epub|mobi|azw3?|azw|kf8|fb2|cbz)$/i
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
}

// Text of a .reg file that adds bulleye to Windows' "Open with" list for ebook files.
// Written for the current user only (HKEY_CURRENT_USER), so it needs no administrator rights.
function buildReg(exe) {
  const q = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const name = path.win32.basename(exe)
  const base = 'HKEY_CURRENT_USER\\Software\\Classes'
  const cmd = `"${exe}" "%1"`
  const L = ['Windows Registry Editor Version 5.00', '']
  L.push(`[${base}\\Applications\\${name}]`, '"FriendlyAppName"="bulleye"', '')
  L.push(`[${base}\\Applications\\${name}\\DefaultIcon]`, `@="${q(exe)},0"`, '')
  L.push(`[${base}\\Applications\\${name}\\shell\\open\\command]`, `@="${q(cmd)}"`, '')
  L.push(`[${base}\\Applications\\${name}\\SupportedTypes]`, ...EXTS.map(e => `"${e}"=""`), '')
  L.push(`[${base}\\bulleye.ebook]`, '@="Ebook"', '"FriendlyTypeName"="Ebook (bulleye)"', '')
  L.push(`[${base}\\bulleye.ebook\\DefaultIcon]`, `@="${q(exe)},0"`, '')
  L.push(`[${base}\\bulleye.ebook\\shell\\open\\command]`, `@="${q(cmd)}"`, '')
  for (const e of EXTS) L.push(`[${base}\\${e}\\OpenWithProgids]`, '"bulleye.ebook"=hex(0):', '')
  return L.join('\r\n')
}

// Linux: a desktop entry puts bulleye in the "Open with" list and the applications menu.
function registerLinux(force, root) {
  return new Promise(resolve => {
    try {
      const exe = process.execPath
      const dir = app.getPath('userData')
      const marker = path.join(dir, 'filetypes.json')
      try { const m = JSON.parse(fs.readFileSync(marker, 'utf8')); if (!force && m.exe === exe && m.v === 2) return resolve(true) } catch {}
      fs.mkdirSync(dir, { recursive: true })
      const icon = path.join(dir, 'bulleye.png')
      try { fs.writeFileSync(icon, fs.readFileSync(path.join(root, 'icon.png'))) } catch {}
      const launcher = fs.existsSync(path.join(path.dirname(exe), 'bulleye')) && path.basename(exe) !== 'bulleye' ? path.join(path.dirname(exe), 'bulleye') : exe
      const q = s => '"' + s.replace(/([\\"`$])/g, '\\$1') + '"'
      const apps = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications')
      fs.mkdirSync(apps, { recursive: true })
      const file = path.join(apps, 'bulleye.desktop')
      fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', 'Name=bulleye', 'Comment=Ebook reader for EPUB, MOBI and AZW3',
        `Exec=${q(launcher)} %f`, `Icon=${icon}`, 'Terminal=false', 'Categories=Office;Viewer;Education;', 'StartupWMClass=bulleye',
        'MimeType=application/epub+zip;application/x-mobipocket-ebook;application/vnd.amazon.ebook;application/vnd.amazon.mobi8-ebook;application/x-fictionbook+xml;application/vnd.comicbook+zip;', ''].join('\n'))
      fs.writeFileSync(marker, JSON.stringify({ exe, v: 2 }))
      execFile('update-desktop-database', [apps], () => resolve(true))
    } catch { resolve(false) }
  })
}

function registerTypes(force, root) {
  if (process.platform === 'linux' && app.isPackaged) return registerLinux(force, root)
  return new Promise(resolve => {
    if (process.platform !== 'win32' || !app.isPackaged) return resolve(false)
    const exe = process.execPath
    const dir = app.getPath('userData')
    const marker = path.join(dir, 'filetypes.json')
    try { const m = JSON.parse(fs.readFileSync(marker, 'utf8')); if (!force && m.exe === exe && m.v === 1) return resolve(true) } catch {}
    try {
      const file = path.join(dir, 'bulleye-filetypes.reg')
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(buildReg(exe) + '\r\n', 'utf16le')]))
      execFile('reg', ['import', file], { windowsHide: true }, err => {
        if (err) return resolve(false)
        try { fs.writeFileSync(marker, JSON.stringify({ exe, v: 1 })) } catch {}
        resolve(true)
      })
    } catch { resolve(false) }
  })
}

// Finds every ebook inside a folder (and the folders within it). Nothing is opened or copied.
async function scanFolder(root, limit = 5000) {
  const found = []
  const skip = /^(node_modules|\$recycle\.bin|system volume information|\.git)$/i
  const todo = [[root, 0]]
  while (todo.length && found.length < limit) {
    const [dir, depth] = todo.pop()
    let items
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const it of items) {
      const full = path.join(dir, it.name)
      if (it.isDirectory()) { if (depth < 8 && !skip.test(it.name) && !it.name.startsWith('.')) todo.push([full, depth + 1]) }
      else if (it.isFile() && BOOK.test(it.name)) {
        try { found.push({ path: full, size: (await fs.promises.stat(full)).size }) } catch {}
        if (found.length >= limit) break
      }
    }
  }
  found.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
  return found
}

function start(ctx) {
  const { ofs, cmp, updDir } = ctx
  const bookArg = argv => argv.slice(1).find(a => BOOK.test(a) && fs.existsSync(a))
  let current = { root: ctx.root, version: ctx.version }
  let win = null
  let pending = bookArg(process.argv) || null
  let updateReady = null
  let checking = null

  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ])

  // Returns 'downloaded', 'latest' or 'error'.
  async function checkForUpdate() {
    try {
      const r = await net.fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bulleye' } })
      if (!r.ok) return { status: 'error' }
      const rel = await r.json()
      const latest = String(rel.tag_name || '').replace(/^v/i, '')
      if (!/^\d+(\.\d+){0,3}$/.test(latest) || cmp(latest, current.version) <= 0 || (updateReady && cmp(latest, updateReady) <= 0)) return { status: 'latest' }
      const asset = (rel.assets || []).find(a => a.name === ASSET)
      if (!asset) return { status: 'latest' }
      const dl = await net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'bulleye' } })
      if (!dl.ok) return { status: 'error' }
      const buf = Buffer.from(await dl.arrayBuffer())
      if (asset.size && buf.length !== asset.size) return { status: 'error' }
      fs.mkdirSync(updDir(), { recursive: true })
      const file = `ui-${latest}.asar`
      const full = path.join(updDir(), file)
      ofs.writeFileSync(full, buf)
      if (!fs.existsSync(path.join(full, 'index.html')) || !fs.existsSync(path.join(full, 'core.js'))) { try { ofs.unlinkSync(full) } catch {} ; return { status: 'error' } }
      fs.writeFileSync(path.join(updDir(), 'ui.json'), JSON.stringify({ version: latest, file }))
      updateReady = latest
      if (win) win.webContents.send('update-ready', latest)
      return { status: 'downloaded', version: latest }
    } catch (e) {
      if (process.env.BULLEYE_DEBUG) console.error('update check failed:', e)
      return { status: 'error' }
    }
  }
  const checkOnce = () => checking || (checking = checkForUpdate().finally(() => { checking = null }))

  ipcMain.handle('read-file', (_e, p) => fs.readFileSync(p))
  ipcMain.handle('take-pending', () => { const p = pending; pending = null; return p })
  ipcMain.handle('app-info', () => ({ version: current.version, update: updateReady, platform: process.platform }))
  ipcMain.handle('check-update', () => checkOnce())
  ipcMain.handle('register-types', () => registerTypes(true, current.root))
  // opens a few known links (the maker's pages and the GitHub releases) in the normal browser
  ipcMain.handle('open-external', (_e, url) => {
    let u; try { u = new URL(String(url)) } catch { return false }
    const ok = u.protocol === 'https:' && (['www.instagram.com', 'instagram.com', 't.me'].includes(u.hostname) || (u.hostname === 'github.com' && u.pathname.startsWith('/drawerjo/')))
    if (ok) shell.openExternal(u.href)
    return ok
  })
  // fetches a web address for the dictionary (only the dictionary services are allowed)
  ipcMain.handle('fetch-json', async (_e, url) => {
    let u; try { u = new URL(String(url)) } catch { return { status: 0, error: 'bad address' } }
    const okHost = u.protocol === 'https:' && (u.hostname === 'api.dictionaryapi.dev' || /^[a-z-]{2,8}\.wiktionary\.org$/.test(u.hostname))
    if (!okHost && !(process.env.BULLEYE_TEST_FETCH && u.hostname === '127.0.0.1')) return { status: 0, error: 'not allowed' }
    try {
      const r = await net.fetch(u.href, { headers: { 'User-Agent': 'bulleye (ebook reader)', Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      let data = null; if (r.ok) { try { data = await r.json() } catch {} }
      return { status: r.status, data }
    } catch (e) { return { status: 0, error: /timeout|abort/i.test(String(e)) ? 'timed out' : 'no connection' } }
  })
  ipcMain.handle('pick-folder', async () => {
    let folder = process.env.BULLEYE_TEST_FOLDER   // lets automated tests skip the folder picker
    if (!folder) {
      const r = await dialog.showOpenDialog(win, { title: 'Choose a folder of books', properties: ['openDirectory'] })
      if (r.canceled || !r.filePaths[0]) return null
      folder = r.filePaths[0]
    }
    return { folder, files: await scanFolder(folder) }
  })

  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  app.on('second-instance', (_e, argv) => {
    const f = bookArg(argv)
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    if (f) win.webContents.send('open-path', f)
  })

  function createWindow() {
    let icon
    try { icon = nativeImage.createFromBuffer(fs.readFileSync(path.join(current.root, 'icon.png'))) } catch {}
    win = new BrowserWindow({
      width: 1280, height: 860, minWidth: 640, minHeight: 480,
      title: 'bulleye', backgroundColor: '#16171a', autoHideMenuBar: true, icon,
      webPreferences: { preload: path.join(current.root, 'preload.js'), contextIsolation: false, nodeIntegration: false, spellcheck: false },
    })
    win.webContents.setVisualZoomLevelLimits(1, 1)
    win.loadURL('app://bulleye/index.html')
    win.on('closed', () => { win = null })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', e => e.preventDefault())
    win.webContents.once('did-finish-load', () => setTimeout(checkOnce, 3000))
  }

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    protocol.handle('app', async req => {
      let p = decodeURIComponent(new URL(req.url).pathname)
      if (p === '/' || p === '') p = '/index.html'
      const file = path.normalize(path.join(current.root, p))
      if (!file.startsWith(current.root)) return new Response('Forbidden', { status: 403 })
      try {
        const data = await fs.promises.readFile(file)
        return new Response(data, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } })
      } catch { return new Response('Not found', { status: 404 }) }
    })
    createWindow()
    registerTypes(false, current.root) // makes bulleye show up in "Open with" (Windows and Linux, once per install location)
  })
  app.on('window-all-closed', () => app.quit())
}

module.exports = { start, buildReg }
