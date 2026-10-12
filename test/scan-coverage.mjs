/** 定位「全库扫描只找到 7960 篇、实际 24582 篇」的原因 */
import { getConfig, scanDocs } from '../lib/impl.js'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

const cfg = await getConfig()
console.log('运行配置 =', JSON.stringify(cfg))

const t0 = Date.now()
const docs = await scanDocs('C:\\业务', cfg)
console.log('插件 scanDocs 结果 =', docs.length, '篇，耗时', Date.now() - t0, 'ms')

// 独立对照：同一套跳过规则，但不设深度/数量上限，并且统计每一层
const SKIP = new Set(['node_modules', '.git', '.obsidian', '.venv', 'venv', '__pycache__', 'ppt-master', '_参考资料文本缓存', '_删除备份_20260927', '_工具遗留', '_doctools'])
let count = 0, dirs = 0
const depthHist = {}
async function walk(dir, depth) {
  dirs++
  depthHist[depth] = (depthHist[depth] || 0) + 1
  let entries = []
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      if (SKIP.has(e.name)) continue
      await walk(path.join(dir, e.name), depth + 1)
    } else if (/\.(md|markdown|txt)$/i.test(e.name)) count++
  }
}
await walk('C:\\业务', 0)
console.log('独立全量遍历 =', count, '篇，目录数', dirs)
console.log('目录深度分布 =', Object.entries(depthHist).sort((a, b) => a[0] - b[0]).map(([k, v]) => k + ':' + v).join(' '))

// 插件结果里最大的深度是多少（判断是不是被 maxDepth 截断）
const md = docs.map((d) => d.rel.split('/').length - 1)
console.log('插件结果里的最大相对深度 =', Math.max(...md), '（maxDepth 配置 =', cfg.maxDepth, '）')
