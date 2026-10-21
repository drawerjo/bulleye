// Builds the full desktop app. Usage: node package-app.mjs win32   or   node package-app.mjs linux
import packager from '@electron/packager'
import path from 'path'
import { fileURLToPath } from 'url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const platform = process.argv[2] || 'win32'
const win = platform === 'win32'
await packager({
  dir: root, out: path.join(root, win ? 'build-win' : 'build-linux'), platform, arch: 'x64',
  electronVersion: '33.4.11', asar: true, name: 'bulleye', executableName: win ? 'bulleye' : 'bulleye-app',
  prune: true, overwrite: true, ignore: [/^\/build/, /^\/out/, /^\/stage-app/],
  ...(win ? { icon: path.join(root, 'build', 'icon.ico') } : {}),
})
console.log('done')
