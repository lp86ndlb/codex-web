#!/usr/bin/env node
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = process.argv[2] && resolve(process.argv[2]), target = resolve(root, 'bridge/dist')
if (!source || source === target || target.startsWith(source + sep) || source.startsWith(target + sep)) {
  throw new Error('请指定与 bridge/dist 分开的、已验证兼容性的前端构建目录。')
}
const html = await readFile(resolve(source, 'index.html'), 'utf8')
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)(?:[?#][^"]*)?"/g)].map(match => match[1])
if (!assets.some(asset => asset.endsWith('.js'))) throw new Error('构建目录没有可用的 JavaScript 入口。')
for (const asset of assets) await access(resolve(source, '.' + asset))
await mkdir(target, { recursive: true })
// Keep old hashed chunks for already-open tabs and their lazy imports. Publish
// the new entry last, so readers never see an index whose assets are missing.
for (const entry of await readdir(source)) {
  if (entry !== 'index.html') await cp(resolve(source, entry), resolve(target, entry), { recursive: true })
}
const temporary = resolve(target, `.index-${process.pid}.tmp`)
try {
  await writeFile(temporary, html)
  await rename(temporary, resolve(target, 'index.html'))
} finally { await rm(temporary, { force: true }) }
console.log(JSON.stringify({ published: target, assets, serverRestarted: false }))
