/**
 * Reply-thread host test: mounts the real plugin against a throwaway dir and checks
 * MRSF round-trip, legacy x_reply migration, resolve-appends, doc_review_reply,
 * reply entries never surfacing as top-level comments, and edit/updatedAt semantics.
 * Run: node test/thread.mjs
 */
import { EventEmitter } from 'node:events'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Never touch the real ~/.dsh/doc-review: redirect plugin home + sessions into a temp dir
const TMP_ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-doc-review-thread-'))
const TEST_HOME = path.join(TMP_ROOT, '_plugin-home')
process.env.DSH_DOC_REVIEW_HOME = TEST_HOME
process.env.DSH_DOC_REVIEW_SESSIONS = path.join(TMP_ROOT, '_sessions')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')) }
}

function makeRes() {
  const res = { code: 0, body: '' }
  res.writeHead = (c) => { res.code = c }
  res.end = (b) => { if (b) res.body += Buffer.isBuffer(b) ? b.toString('utf8') : String(b) }
  res.json = () => { try { return JSON.parse(res.body) } catch (_) { return null } }
  return res
}
function makeGet(url) {
  return { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' }, headers: {}, on() {}, destroy() {} }
}
function makePost(url, body) {
  const req = new EventEmitter()
  Object.assign(req, { method: 'POST', url, socket: { remoteAddress: '127.0.0.1' }, headers: {}, destroy() {} })
  setTimeout(() => { req.emit('data', Buffer.from(JSON.stringify(body || {}), 'utf8')); req.emit('end') }, 0)
  return req
}

async function main() {
  const docPath = path.join(TMP_ROOT, 'thread-doc.md')
  await fsp.writeFile(docPath, '# T\n\nfirst line here.\n\nsecond line here.\n', 'utf8')
  await fsp.mkdir(TEST_HOME, { recursive: true })
  await fsp.writeFile(path.join(TEST_HOME, 'config.json'), JSON.stringify({ roots: [TMP_ROOT], maxDocs: 100, author: 'tester' }), 'utf8')
  const reviewJson = path.join(TMP_ROOT, '.dsh-review', 'thread-doc.md.review.json')

  const { apply } = await import('../lib/index.js')
  const routes = [], tools = []
  await apply({
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    tools: { register: (t) => { tools.push(t); return () => {} } },
    effect: () => () => {},
  })
  const route = (p) => routes.find((r) => r.path === p)
  const tool = (n) => tools.find((t) => t.name === n)
  const save = async (comments) => {
    const res = makeRes()
    await route('/api/dsh-doc-review/save').handler(makePost('/api/dsh-doc-review/save', { path: docPath, comments }), res)
    return res
  }
  const readDoc = async () => {
    const res = makeRes()
    await route('/api/dsh-doc-review/doc').handler(makeGet('/api/dsh-doc-review/doc?path=' + encodeURIComponent(docPath)), res)
    return res.json()
  }
  const disk = async () => JSON.parse(await fsp.readFile(reviewJson, 'utf8'))

  console.log('\n[1] tool registered')
  ok('doc_review_reply registered', !!tool('doc_review_reply'), tools.map((t) => t.name).join(','))

  console.log('\n[2] MRSF round-trip')
  const r1 = { id: 'r_u1', author: 'tester', role: 'user', text: 'why Q2?', createdAt: '2026-10-01 10:00' }
  const r2 = { id: 'r_a1', author: 'AI', role: 'agent', text: 'because budget closes in Q2', createdAt: '2026-10-01T10:05:00+08:00' }
  let res = await save([
    // replies deliberately out of order: host must sort ascending
    { id: 'c1', lineStart: 3, lineEnd: 3, quote: 'first line here.', note: 'n1', status: 'pending', replies: [r2, r1] },
    { id: 'c2', lineStart: 5, lineEnd: 5, quote: 'second line here.', note: 'n2', status: 'pending' },
  ])
  ok('save ok', res.code === 200 && res.json().ok, res.body.slice(0, 200))
  let d = await disk()
  const replyRows = d.comments.filter((m) => m.reply_to)
  ok('disk: 2 top + 2 reply entries', d.comments.length === 4 && replyRows.length === 2, JSON.stringify(d.comments.map((m) => [m.id, m.reply_to])))
  ok('disk: reply rows carry reply_to/text/author/timestamp/x_role',
    replyRows.every((m) => m.reply_to === 'c1' && m.text && m.author && m.timestamp && (m.x_role === 'user' || m.x_role === 'agent')),
    JSON.stringify(replyRows))
  ok('disk: parent reply_to is null', d.comments.find((m) => m.id === 'c1').reply_to === null)
  ok('disk: x_reply = last agent reply only', d.comments.find((m) => m.id === 'c1').x_reply === r2.text)
  let j = await readDoc()
  ok('read: only top-level comments', j.review.comments.length === 2 && j.review.comments.every((c) => c.id === 'c1' || c.id === 'c2'), JSON.stringify(j.review.comments.map((c) => c.id)))
  let c1 = j.review.comments.find((c) => c.id === 'c1')
  ok('read: replies folded & sorted ascending', c1.replies.map((r) => r.id).join(',') === 'r_u1,r_a1', JSON.stringify(c1.replies))
  ok('read: roles preserved', c1.replies[0].role === 'user' && c1.replies[1].role === 'agent')
  ok('read: reply compat = last agent text', c1.reply === r2.text)
  ok('read: c2 has empty replies array', Array.isArray(j.review.comments.find((c) => c.id === 'c2').replies) && j.review.comments.find((c) => c.id === 'c2').replies.length === 0)

  console.log('\n[3] reply entries never leak to top level')
  // Client echoing MRSF reply rows in save must not create extra top-level comments
  res = await save(d.comments.map((m) => (m.reply_to ? m : { ...m, replies: undefined })).map((m) => {
    if (m.reply_to) return m
    const cur = j.review.comments.find((c) => c.id === m.id)
    return { ...cur }
  }))
  j = await readDoc()
  ok('save with echoed reply rows keeps 2 top-level', j.review.comments.length === 2, JSON.stringify(j.review.comments.map((c) => c.id)))
  const docsRes = makeRes()
  await route('/api/dsh-doc-review/docs').handler(makeGet('/api/dsh-doc-review/docs?scope=workspace&ws=' + encodeURIComponent(TMP_ROOT)), docsRes)
  const docRow = (docsRes.json().docs || []).find((x) => x.path === docPath)
  ok('/docs total counts only top-level', docRow && docRow.total === 2 && docRow.pending === 2, JSON.stringify(docRow))
  let listText = await tool('doc_review_list').execute({ doc: docPath })
  ok('list: pending 2 / total 2', listText.includes('待处理 2 条 / 共 2 条'), listText.slice(0, 200))
  ok('list: reply ids not listed as comments', !listText.includes('【r_u1】') && !listText.includes('【r_a1】'), listText)
  ok('list: thread lines tagged user/agent', listText.includes('[user]') && listText.includes('[agent]') && listText.includes('why Q2?'), listText)
  const allList = await tool('doc_review_list').execute({})
  ok('scan list: still 2 comments', allList.includes('待处理 2 条 / 共 2 条'), allList.slice(0, 200))

  console.log('\n[4] doc_review_reply appends without status change')
  let out = await tool('doc_review_reply').execute({ doc: docPath, id: 'c2', text: 'need the source for this figure?' })
  ok('reply tool ok', /追加 1 条回复/.test(out), out)
  j = await readDoc()
  let c2 = j.review.comments.find((c) => c.id === 'c2')
  ok('c2 still pending', c2.status === 'pending')
  ok('c2 has 1 agent reply', c2.replies.length === 1 && c2.replies[0].role === 'agent' && c2.replies[0].text === 'need the source for this figure?', JSON.stringify(c2.replies))
  ok('c2.reply compat updated', c2.reply === 'need the source for this figure?')
  out = await tool('doc_review_reply').execute({ doc: docPath, id: 'nope', text: 'x' })
  ok('unknown id is reported, not written', /找不到批注/.test(out), out)
  out = await tool('doc_review_reply').execute({ doc: docPath, id: 'c2', text: '   ' })
  ok('empty text rejected', /不能为空/.test(out), out)

  console.log('\n[5] resolve appends instead of overwriting')
  out = await tool('doc_review_resolve').execute({ doc: docPath, ids: ['c1'], reply: 'moved to Q2 end' })
  ok('resolve 1', /已标记 1 条/.test(out), out)
  j = await readDoc()
  c1 = j.review.comments.find((c) => c.id === 'c1')
  ok('c1 resolved', c1.status === 'resolved')
  ok('c1 thread grew to 3, old agent reply kept', c1.replies.length === 3 && c1.replies[1].text === r2.text && c1.replies[2].text === 'moved to Q2 end' && c1.replies[2].role === 'agent', JSON.stringify(c1.replies))
  ok('c1.reply = newest agent reply', c1.reply === 'moved to Q2 end')
  c2 = j.review.comments.find((c) => c.id === 'c2')
  ok('resolve with ids does not touch other threads', c2.replies.length === 1 && c2.status === 'pending')
  // reply on a resolved comment keeps it resolved
  await tool('doc_review_reply').execute({ doc: docPath, id: 'c1', text: 'follow-up note' })
  j = await readDoc()
  c1 = j.review.comments.find((c) => c.id === 'c1')
  ok('reply keeps resolved status', c1.status === 'resolved' && c1.replies.length === 4)
  const resolvedList = await tool('doc_review_list').execute({ doc: docPath, status: 'resolved' })
  ok('list status=resolved shows thread', resolvedList.includes('【c1】') && resolvedList.includes('follow-up note'), resolvedList)

  console.log('\n[6] legacy x_reply migration')
  await fsp.writeFile(reviewJson, JSON.stringify({
    mrsf: '1.0', document: docPath, comments: [{
      id: 'old1', author: 'x', timestamp: '2026-01-01T00:00:00+08:00', text: 'legacy note', resolved: true,
      line: 3, end_line: 3, selected_text: 'first line here.', anchored_text: 'first line here.', reply_to: null,
      x_status: 'resolved', x_reply: 'legacy answer', x_resolved_at: '2026-01-02T00:00:00+08:00',
      x_created_at: '2026-01-01T00:00:00+08:00', x_updated_at: '2026-01-02T00:00:00+08:00',
    }],
  }), 'utf8')
  j = await readDoc()
  let o = j.review.comments[0]
  ok('legacy: one agent reply', o.replies.length === 1 && o.replies[0].role === 'agent' && o.replies[0].text === 'legacy answer', JSON.stringify(o.replies))
  ok('legacy: stable derived id', o.replies[0].id === 'r_old1_legacy')
  const again = (await readDoc()).review.comments[0]
  ok('legacy: id stable across reads', again.replies[0].id === o.replies[0].id)
  ok('legacy: reply compat kept', o.reply === 'legacy answer')
  await tool('doc_review_reply').execute({ doc: docPath, id: 'old1', text: 'new answer' })
  d = await disk()
  ok('legacy: after write, thread on disk as reply_to rows', d.comments.filter((m) => m.reply_to === 'old1').map((m) => m.id).join(',') === 'r_old1_legacy,' + d.comments.filter((m) => m.reply_to === 'old1')[1].id, JSON.stringify(d.comments))
  j = await readDoc()
  o = j.review.comments[0]
  ok('legacy: no duplicated legacy reply after migration', o.replies.length === 2 && o.replies.filter((r) => r.text === 'legacy answer').length === 1, JSON.stringify(o.replies))

  console.log('\n[7] edit via save: updatedAt + thread ownership')
  // Unchanged note: updatedAt must not move (doc_review_reply above bumped it; capture current)
  const before = o.updatedAt
  await save([{ ...o }])
  j = await readDoc()
  ok('same note => updatedAt unchanged', j.review.comments[0].updatedAt === before, before + ' vs ' + j.review.comments[0].updatedAt)
  // Force an old stamp on disk, then edit the note
  d = await disk()
  d.comments[0].x_updated_at = '2020-01-01T00:00:00+08:00'
  await fsp.writeFile(reviewJson, JSON.stringify(d), 'utf8')
  o = (await readDoc()).review.comments[0]
  await save([{ ...o, note: 'legacy note (edited)' }])
  j = await readDoc()
  ok('note changed => updatedAt refreshed', j.review.comments[0].updatedAt !== '2020-01-01T00:00:00+08:00' && j.review.comments[0].note === 'legacy note (edited)', j.review.comments[0].updatedAt)
  ok('edit keeps thread', j.review.comments[0].replies.length === 2)
  // Old client: no `replies` field => host keeps existing thread
  const { replies: _drop, ...noReplies } = j.review.comments[0]
  await save([{ ...noReplies, reply: '' }])
  j = await readDoc()
  ok('save without replies keeps thread', j.review.comments[0].replies.length === 2, JSON.stringify(j.review.comments[0].replies))
  // New client: explicit replies array overwrites the thread (e.g. deleting a reply)
  await save([{ ...j.review.comments[0], replies: [j.review.comments[0].replies[0]] }])
  j = await readDoc()
  ok('explicit replies overwrite thread', j.review.comments[0].replies.length === 1 && j.review.comments[0].replies[0].id === 'r_old1_legacy', JSON.stringify(j.review.comments[0].replies))
  await save([{ ...j.review.comments[0], replies: [] }])
  j = await readDoc()
  ok('explicit empty replies clears thread (no legacy resurrection)', j.review.comments[0].replies.length === 0 && j.review.comments[0].reply === '', JSON.stringify(j.review.comments[0]))
  d = await disk()
  ok('cleared thread: no reply rows, empty x_reply', d.comments.length === 1 && d.comments[0].x_reply === '', JSON.stringify(d.comments))

  console.log('\nresult: pass=' + pass + ' fail=' + fail)
  console.log('(temp dir = ' + TMP_ROOT + ', ~/.dsh/doc-review untouched)')
  await fsp.rm(TMP_ROOT, { recursive: true, force: true })
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error('thread test crashed:', e); process.exitCode = 1 })
