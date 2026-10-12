/** 用真会话转写验一遍：本会话到底能抽出哪些文档（不改任何东西） */
import { sessionTouchedDocs, findSessionFile } from '../lib/impl.js'

const sid = process.argv[2]
if (!sid) { console.log('用法: node test/verify-real-session.mjs <sessionId>'); process.exit(1) }

const t0 = Date.now()
const file = await findSessionFile(sid)
console.log('会话文件 =', file ? file.fp : '（没找到）')

const s = await sessionTouchedDocs(sid, true)
console.log('cwd =', s.cwd || '（无）')
console.log('命中文档 =', s.docs.length, '| 耗时', Date.now() - t0, 'ms', '| 备注:', s.reason || '-')
console.log('')
for (const d of s.docs) {
  console.log('  [' + (d.via || '?') + ' ×' + d.hits + ']  ' + new Date(d.mtimeMs).toLocaleString('zh-CN') + '  ' + d.path)
}
