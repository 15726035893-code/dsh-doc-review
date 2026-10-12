/** 拿真会话 + 真项目数据跑一遍「相关」分层，看看用户实际会看到什么（只读） */
import { listDocsByScope, getConfig } from '../lib/impl.js'

const sid = process.argv[2]
if (!sid) { console.log('用法: node test/verify-related.mjs <sessionId>'); process.exit(1) }

const cfg = await getConfig()
console.log('配置 =', JSON.stringify(cfg))

const t0 = Date.now()
const out = await listDocsByScope({ scope: 'related', sessionId: sid, q: '', force: true }, cfg)
console.log('耗时', Date.now() - t0, 'ms | scopeUsed=' + out.scopeUsed, '| 本会话 tier1=' + out.tier1, '| 本项目 tier2=' + out.tier2, '| cwd=' + out.cwd)
console.log('')
for (const d of out.docs) {
  const tag = d.tier === 'project' ? '[本项目]' : '[本会话]'
  const short = d.path.replace(/^C:\\业务\\/, '')
  console.log('  ' + tag, new Date(d.mtimeMs).toLocaleString('zh-CN'), ('via=' + (d.via || '?')).padEnd(10), short)
}
// 同一路径是否被重复列出（真去重验证）
const dup = {}
for (const d of out.docs) { const k = d.path.toLowerCase(); dup[k] = (dup[k] || 0) + 1 }
const repeated = Object.entries(dup).filter(([, n]) => n > 1)
console.log('\n重复路径数 =', repeated.length, repeated.slice(0, 5))
