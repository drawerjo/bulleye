// bulleye bootstrap. This small file never needs to change: it picks the newest screen-and-logic bundle
// (the one inside the program, or a newer one downloaded from GitHub) and starts it.
const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const ofs = require('original-fs') // plain file access: Electron's normal fs treats *.asar files as folders

const BUNDLED = path.join(__dirname, 'ui')
const BUNDLED_VERSION = require('./package.json').version
const updDir = () => path.join(app.getPath('userData'), 'updates')
const cmp = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d }
  return 0
}

function pickRoot() {
  const dir = updDir()
  let meta = null
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'ui.json'), 'utf8')) } catch {}
  try { // tidy old downloads
    for (const f of fs.readdirSync(dir)) if (/^ui-.*\.asar$/.test(f) && f !== meta?.file) { try { ofs.unlinkSync(path.join(dir, f)) } catch {} }
  } catch {}
  if (meta && cmp(meta.version, BUNDLED_VERSION) > 0) {
    const f = path.join(dir, meta.file || '')
    try { if (fs.existsSync(path.join(f, 'index.html')) && fs.existsSync(path.join(f, 'core.js'))) return { root: f, version: meta.version } } catch {}
  }
  return { root: BUNDLED, version: BUNDLED_VERSION }
}

const env = { bundledVersion: BUNDLED_VERSION, updDir, ofs, cmp, bundled: BUNDLED }
const picked = pickRoot()
try {
  require(path.join(picked.root, 'core.js')).start({ ...env, ...picked })
} catch (e) {
  if (picked.root === BUNDLED) throw e
  // a broken update must never stop bulleye from opening: forget it and use the built-in version
  try { ofs.unlinkSync(path.join(updDir(), 'ui.json')) } catch {}
  require(path.join(BUNDLED, 'core.js')).start({ ...env, root: BUNDLED, version: BUNDLED_VERSION })
}
