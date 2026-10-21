// Makes out/bulleye-ui.asar (the self-update file) and out/app.asar. Run from the build folder: node pack.mjs
import asar from '@electron/asar'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'out'); fs.mkdirSync(out, { recursive: true })
await asar.createPackage(path.join(root, 'ui'), path.join(out, 'bulleye-ui.asar'))
const tmp = path.join(root, 'stage-app'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp)
for (const f of ['main.js', 'package.json']) fs.copyFileSync(path.join(root, f), path.join(tmp, f))
fs.cpSync(path.join(root, 'ui'), path.join(tmp, 'ui'), { recursive: true })
await asar.createPackage(tmp, path.join(out, 'app.asar'))
fs.rmSync(tmp, { recursive: true, force: true })
console.log('done: out/bulleye-ui.asar and out/app.asar')
