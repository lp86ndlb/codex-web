import fs from 'node:fs'
import TOML from '../../bridge/node_modules/@iarna/toml/toml.js'

const [file, raw] = process.argv.slice(2)
const pairs = JSON.parse(raw).sort((a, b) => b[0].length - a[0].length)
const text = value => {
  const pair = pairs.find(([source]) => value === source || value.startsWith(source + '/'))
  return pair ? pair[1] + value.slice(pair[0].length) : value
}
const rewrite = value => typeof value === 'string' ? text(value) : Array.isArray(value) ? value.map(rewrite)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), rewrite(item)])) : value
fs.writeFileSync(file, TOML.stringify(rewrite(TOML.parse(fs.readFileSync(file, 'utf8')))), { mode: 0o600 })
