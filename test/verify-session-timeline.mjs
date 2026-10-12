/** 按「转写里的出现顺序」列出某会话碰过的文档（找出会话最后产出的那篇） */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { decodeSessionFrames, findSessionFiles } from '../lib/impl.js'

const sid = process.argv[2]
const hit = await findSessionFiles(sid)
if (!hit) { console.log('找不到会话 ' + sid); process.exit(1) }
console.log('会话 =', sid, '| 转写文件 ' + hit.files.length + ' 份:', hit.files.map((f) => f.name).join(', '))
let text = ''
for (const f of hit.files) text += (decodeSessionFrames(await fsp.readFile(f.fp)) || '')
const recs = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)

const evs = []
for (const r of recs) {
  if (r.type !== 'tool/call' || !r.data) continue
  const name = String(r.data.name || '')
  const s = typeof r.data.arguments === 'string' ? r.data.arguments : JSON.stringify(r.data.arguments || {})
  const paths = []
  const re = /"file_path"\s*:\s*"([^"]+)"/g
  let m
  while ((m = re.exec(s))) paths.push(m[1].replace(/\\\\/g, '\\'))
  // pwsh / write 等参数里出现的绝对 md
  const re2 = /([A-Za-z]:\\\\[^"'\r\n,)\]}]{2,200}?\.(?:md|markdown))/g
  while ((m = re2.exec(s))) paths.push(m[1].replace(/\\\\/g, '\\'))
  for (const p of paths) {
    if (!/\.(md|markdown)$/i.test(p)) continue
    if (/node_modules|\.dsh\\profiles/.test(p)) continue
    evs.push({ t: r.time, turn: r.data.turn, step: r.data.step, name, p })
  }
}
console.log('会话 =', sid)
console.log('转写里带 md 路径的工具调用 =', evs.length, '次\n')
console.log('按转写顺序（只列 杭州动物园 相关 + 最后 10 条）:')
const zooEvs = evs.filter((e) => /杭州动物园/.test(e.p))
for (const e of zooEvs) {
  console.log('  ' + new Date(e.t).toLocaleString('zh-CN') + '  turn' + e.turn + ' ' + e.name.padEnd(10) + ' ' + e.p.replace(/^C:\\业务\\/, ''))
}
console.log('\n最后 10 条（任意路径）:')
for (const e of evs.slice(-10)) {
  console.log('  ' + new Date(e.t).toLocaleString('zh-CN') + '  turn' + e.turn + ' ' + e.name.padEnd(10) + ' ' + e.p.replace(/^C:\\业务\\/, ''))
}
