/**
 * 会话批注 → 聊天输入框（攒批发送）逻辑测试。
 * 直接从 lib/client.js 抽源码跑，不依赖浏览器：
 * - buildAnnoBlock：只装待处理批注，条数正确
 * - syncDraftToComposer：用户自己的文字必须原样保留在批注块下方
 * - 多次保存 = 重建而不是叠加（不会攒出两个批注块）
 * - 斜杠命令草稿不动（拼块会让命令失效）
 * - 批注清空后把用户文字还原、不残留空块
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'

const clientPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'lib', 'client.js')
const src = await fsp.readFile(clientPath, 'utf8')

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')) } }

function grab(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('client.js 里找不到函数：' + name)
  let i = src.indexOf('{', start), depth = 0, end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break } }
  }
  if (end < 0) throw new Error('函数花括号不配对：' + name)
  return src.slice(start, end)
}
const headM = src.match(/var ANNO_HEAD = '([^']*)'/)
const tailM = src.match(/var ANNO_TAIL = '([^']*)'/)
if (!headM || !tailM) { console.log('FAIL 找不到批注块哨兵常量'); process.exit(1) }

const sandbox = `
var ANNO_HEAD = ${JSON.stringify(headM[1])}, ANNO_TAIL = ${JSON.stringify(tailM[1])}
var convFace = null, ctxRef = null, sessions = null, __sid = 'sess-1'
var addressed = null, draftWatchTimer = null, blockIdsRef = []
var __posted = []
var API = { snote: '/api/dsh-doc-review/snote' }
var window = { dispatchEvent: function () {} }
function CustomEvent (t) { this.type = t }
function currentSessionId () { return __sid }
function apiPost (url, body) { __posted.push({ url: url, body: body }); return Promise.resolve({ ok: true, notes: [] }) }
${grab('stripAnnoBlock')}
${grab('markTitle')}
${grab('buildAnnoBlock')}
${grab('composerShell')}
${grab('stopWatchingDraft')}
${grab('watchDraftSent')}
${grab('syncDraftToComposer')}
module.exports = {
  buildAnnoBlock: buildAnnoBlock,
  syncDraftToComposer: syncDraftToComposer,
  strip: stripAnnoBlock,
  markTitle: markTitle,
  stopWatch: stopWatchingDraft,
  posted: function () { return __posted.slice() },
  clearPosted: function () { __posted.length = 0 },
  useFakeShell: function () {
    var st = { draft: '' }
    var shell = {
      state: { getSnapshot: function () { return { draft: st.draft } } },
      setDraft: function (t) { st.draft = t; shell.__writes++ },
      focus: function () { shell.__focused++ },
      __writes: 0, __focused: 0,
    }
    convFace = { input: { for: function () { return shell } } }
    sessions = { scope: function (id) { return id ? { id: id } : undefined } }
    return { get draft () { return st.draft }, shell: shell }
  },
  noShell: function () { convFace = null; sessions = null },
}
`
const mod = { exports: {} }
new Function('module', 'require', sandbox)(mod, () => { throw new Error('no require') })
const api = mod.exports

console.log('\n[1] 批注块内容')
const notes = [
  { id: 's_1', quote: '这句话的结论下早了', note: '再查一下数据', status: 'pending' },
  { id: 's_2', quote: '毛利按含税算', note: '改成不含税', status: 'pending' },
  { id: 's_3', quote: '已经处理过的', note: '不该出现', status: 'resolved' },
]
const block = api.buildAnnoBlock(notes)
ok('只装待处理的（2 条）', block.includes('共 2 条'), block.split('\n')[0])
ok('已处理的批注不进块', !block.includes('不该出现'), '')
ok('带原文与意见', block.includes('这句话的结论下早了') && block.includes('再查一下数据'), '')
ok('首尾都有哨兵', block.startsWith(headM[1]) && block.trim().endsWith(tailM[1]), '')

console.log('\n[2] 写进输入框：用户自己的文字必须保留')
const t1 = api.useFakeShell()
let r = api.syncDraftToComposer(notes)
ok('返回 ok', r === 'ok', r)
ok('块已写入草稿', t1.draft.startsWith(headM[1]), t1.draft.slice(0, 30))
ok('聚焦到输入框（省一次点击）', t1.shell.__focused === 1, String(t1.shell.__focused))

// 用户接着在输入框里写自己的问题，然后再保存第 3 条批注
const t2 = api.useFakeShell()
api.syncDraftToComposer(notes)
const withQ = t2.draft + '\n\n请把第三段的数字再核一遍'
t2.shell.setDraft(withQ)
const more = notes.concat([{ id: 's_4', quote: '第三个数字不对', note: '核对 2026Q3', status: 'pending' }])
r = api.syncDraftToComposer(more)
ok('再保存一条后仍是 ok', r === 'ok', r)
ok('★ 只有一个批注块（重建不是叠加）', t2.draft.split(headM[1]).length - 1 === 1, '块数=' + (t2.draft.split(headM[1]).length - 1))
ok('★ 条数更新为 3', t2.draft.includes('共 3 条'), t2.draft.split('\n')[0])
ok('★ 用户自己的问题原样保留在块下方', t2.draft.includes('请把第三段的数字再核一遍'), t2.draft.slice(-60))
ok('用户文字在块之后（顺序对）', t2.draft.indexOf('请把第三段的数字再核一遍') > t2.draft.indexOf(tailM[1]), '')

console.log('\n[3] 边界')
const t3 = api.useFakeShell()
t3.shell.setDraft('/goal 换个目标')
r = api.syncDraftToComposer(notes)
ok('斜杠命令草稿不动它', r === 'command' && t3.draft === '/goal 换个目标', r + ' | ' + t3.draft)
const t4 = api.useFakeShell()
api.syncDraftToComposer(notes)
t4.shell.setDraft(api.strip(t4.draft) + '\n\n我的问题')
r = api.syncDraftToComposer(notes.map((n) => ({ ...n, status: 'resolved' })))
ok('批注全处理后块被摘掉', r === 'empty' && !t4.draft.includes(headM[1]), r + ' | ' + JSON.stringify(t4.draft))
ok('摘掉后用户文字还在', t4.draft.includes('我的问题'), t4.draft)
api.noShell()
ok('拿不到输入框 facade 时优雅降级', api.syncDraftToComposer(notes) === 'unavailable', '')

console.log('\n[4] 正文角标说明：已处理要能召回当时的意见与结论')
ok('待处理角标只显示意见', api.markTitle({ status: 'pending', note: '口径写清楚' }, 3) === '#3 口径写清楚', api.markTitle({ status: 'pending', note: '口径写清楚' }, 3))
const done = api.markTitle({ status: 'resolved', note: '时点要写 Q3', reply: '已改到 Q3 末' }, 7)
ok('已处理角标带「已处理」标记', done.indexOf('#7 已处理') === 0, done)
ok('已处理角标带上当时的意见', done.includes('时点要写 Q3'), done)
ok('已处理角标带上结论', done.includes('结论：已改到 Q3 末'), done)
ok('没有结论时不留空标签', !api.markTitle({ status: 'resolved', note: 'x' }, 1).includes('结论：'), api.markTitle({ status: 'resolved', note: 'x' }, 1))

console.log('\n[5] 已发出的批注不再回到块里（2026-10-12 修的 bug）')
const mixed = [
  { id: 's_a', quote: '早上发过的那条', note: '别再带进来', status: 'pending', sent_at: '2026-10-12T09:20:00+08:00' },
  { id: 's_b', quote: '新写的这条', note: '应该出现', status: 'pending' },
  { id: 's_c', quote: '已处理的', note: '不该出现', status: 'resolved' },
]
const block2 = api.buildAnnoBlock(mixed)
ok('★ 已发出的不进块', !block2.includes('早上发过的那条'), block2)
ok('★ 新写的进块', block2.includes('新写的这条'), block2)
ok('条数只算新写的', block2.includes('共 1 条'), block2.split('\n')[0])
ok('全部已发出时返回空块', api.buildAnnoBlock([{ id: 'x', quote: 'q', note: 'n', status: 'pending', sent_at: 'x' }]) === '', '')
const t5 = api.useFakeShell()
api.syncDraftToComposer(mixed)
ok('写进输入框的块只含未发出的那条', t5.draft.includes('新写的这条') && !t5.draft.includes('早上发过的那条'), t5.draft.split('\n').slice(0, 4).join(' | '))

console.log('\n[6] 发出后自动标记：块从输入框消失 → 把这批标成已发出')
const t6 = api.useFakeShell()
api.clearPosted()
api.syncDraftToComposer([{ id: 's_z9', quote: 'q', note: 'n', status: 'pending' }])
ok('写块后开始盯着草稿', typeof api.stopWatch === 'function', '')
t6.shell.setDraft('')                      // 模拟：用户回车发出（或清空输入框）
await new Promise(function (r) { setTimeout(r, 1800) })
const posted6 = api.posted()
ok('★ 块消失后自动调了 sent 标记', posted6.some(function (p) { return p.body && p.body.action === 'sent' && (p.body.ids || []).indexOf('s_z9') >= 0 }), JSON.stringify(posted6))
api.stopWatch()

console.log('\n结果：pass=' + pass + ' fail=' + fail)
process.exitCode = fail ? 1 : 0
