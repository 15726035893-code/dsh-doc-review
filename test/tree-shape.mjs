// 树形状自证：目录前缀必须建出真正的层级（父目录包着子目录），
// 而不是每个 dir 起一个平级节点——那正是上一版看着像树、实际是列表的原因。
import { promises as fsp } from 'node:fs'
const src = await fsp.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')) } }

function grab(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('client.js missing ' + name)
  let i = src.indexOf('{', start), d = 0
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) return src.slice(start, i + 1) } }
}
// buildTree 用到 dirOfDoc，两个一起抽出来跑。
const H = new Function(grab('dirOfDoc') + '\n' + grab('buildTree') + '\nreturn { dirOfDoc, buildTree }')()
const ROOT = '/Users/douba/Projects/demo'
const doc = (rel) => ({ path: ROOT + '/' + rel, name: rel.split('/').pop() })
const docs = [
  doc('README.md'),
  doc('docs/a.md'),
  doc('docs/sub/b.md'),
  doc('docs/sub/deep/c.md'),
  doc('lib/d.md'),
]

const tree = H.buildTree(docs, ROOT)
console.log('  根层文件:', tree.files.map(f => f.name).join(',') || '(无)')
console.log('  根层目录:', [...tree.dirs.keys()].join(',') || '(无)')

ok('根目录的文件留在根上（不该被缩进成某目录的子项）', tree.files.map(f => f.name).join() === 'README.md')
ok('根层只有 docs 与 lib 两个目录', [...tree.dirs.keys()].sort().join() === 'docs,lib')
const d = tree.dirs.get('docs')
ok('docs 有自己的文件 a.md', d.files.map(f => f.name).join() === 'a.md')
ok('** docs 的 sub 是 docs 的子节点（不是平级）', [...d.dirs.keys()].join() === 'sub')
ok('docs/sub 的深度是 2', d.dirs.get('sub').depth === 2)
ok('** docs/sub/deep 嵌在 sub 之下（三层）', [...d.dirs.get('sub').dirs.keys()].join() === 'deep')
ok('deep 的深度是 3', d.dirs.get('sub').dirs.get('deep').depth === 3)
ok('deep 里有 c.md', d.dirs.get('sub').dirs.get('deep').files.map(f => f.name).join() === 'c.md')
ok('lib 与 docs 平级、各自独立', tree.dirs.get('lib').files.map(f => f.name).join() === 'd.md')
ok('相对路径算不出来时不炸（root 不匹配）', H.buildTree([{ path: '/tmp/x/a.md', name: 'a.md' }], ROOT).files.length === 1)

console.log(fail ? `\n中间结果：pass=${pass} fail=${fail}` : `\n嵌套用例全部通过 (${pass})`)

// ── 铺开顺序与缩进 ──────────────────────────────────────────────────────────
// flattenTree 决定渲染顺序；顺序错了「刚改过的 README」会被整棵子目录树推到下面。
// 缩进规则：目录 depth*12，文件 depth*12+12（文件永远比所属目录深一格）。
const flatSrc = (() => {
  const start = src.indexOf('function flattenTree(')
  let i = src.indexOf('{', start), d = 0
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (!d) return src.slice(start, i + 1) } }
})()
const flat = new Function('collapsed', flatSrc + '\nreturn flattenTree')({})
const rows = flat(H.buildTree(docs, ROOT), [])
const seq = rows.map((r) => (r.kind === 'dir' ? r.node.name + '/' : r.doc.name))
console.log('  铺开顺序:', seq.join('  '))

ok('文件在本层目录之前（README 不该被目录树推到末尾）', seq[0] === 'README.md')
ok('docs 的直属文件 a.md 在子目录 sub/ 之前', seq.indexOf('a.md') < seq.indexOf('sub/'))
ok('deep/ 出现在 c.md 之前', seq.indexOf('deep/') < seq.indexOf('c.md'))
ok('lib/ 与 docs/ 平级，排在 docs/ 子树之后', seq.indexOf('lib/') > seq.indexOf('c.md'))

const indentOf = (r) => (r.kind === 'file' ? r.depth * 12 + 12 : r.depth * 12)
let bad = 0
for (const r of rows) {
  if (r.kind !== 'file') continue
  const owner = rows.slice(0, rows.indexOf(r)).reverse().find((x) => x.kind === 'dir' && x.node.dir === (r.node.dir || ''))
  if (owner && indentOf(r) <= indentOf(owner)) { bad++; console.log('  FAIL ' + r.doc.name + ' 未比所属目录更深') }
}
ok('每个文件都比它所属的目录缩进更深', bad === 0)
ok('根目录文件与根目录本身同级（12px，不额外偏移）', indentOf(rows[0]) === 12)

// 折叠：一个目录折起来，它整棵子树都不出现。
const folded = flat(H.buildTree(docs, ROOT), []).length
const withFold = new Function('collapsed', flatSrc + '\nreturn flattenTree')({ 'docs': 1 })
const foldedRows = withFold(H.buildTree(docs, ROOT), [])
const foldedSeq = foldedRows.map((r) => (r.kind === 'dir' ? r.node.name + '/' : r.doc.name))
console.log('  折叠 docs 后:', foldedSeq.join('  '))
ok('折叠 docs 隐藏它全部后代（a.md / sub/ / deep/ / b.md / c.md 都不在）',
  ['a.md', 'sub/', 'deep/', 'b.md', 'c.md'].every((n) => !foldedSeq.includes(n)))
ok('折叠 docs 不隐藏同级的 lib/ 与根文件', foldedSeq.includes('lib/') && foldedSeq.includes('README.md'))
ok('折叠确实减少了行数', foldedRows.length < folded)


// ── 树根＝文件的最近公共祖先 ────────────────────────────────────────────────
// 宿主配的工作区常是 ~/Projects（甚至 ~）。直接拿它当根，树的顶层就会多出一个
// 永远只有一个孩子的节点——「Projects」下只挂着项目名。那不是文件夹，是路径前缀。
// 期望：列出的文件都在同一个项目里时，根就是那个项目，前缀那一层不该出现。
const implSrc = await fsp.readFile(new URL('../lib/impl.js', import.meta.url), 'utf8')
const cStart = implSrc.indexOf('const commonRoot = (docs, fallback)')
let ci = implSrc.indexOf('{', cStart), cd = 0, cEnd = -1
for (; ci < implSrc.length; ci++) { if (implSrc[ci] === '{') cd++; else if (implSrc[ci] === '}') { cd--; if (!cd) { cEnd = ci + 1; break } } }
const commonRoot = new Function(implSrc.slice(cStart, cEnd) + '\nreturn commonRoot')()
const P = (r) => '/Users/douba/Projects/' + r
const F = (...ps) => ps.map((p) => ({ path: p }))
const FALLBACK = '/Users/douba/Projects'

const roots = [
  ['同一项目内 -> 根就是项目', F(P('app/README.md'), P('app/docs/a.md')), P('app')],
  ['同一子目录 -> 收得更紧', F(P('app/lib/a.md'), P('app/lib/b.md')), P('app/lib')],
  ['跨项目 -> 回到 Projects', F(P('a/x.md'), P('b/y.md')), FALLBACK],
  ['单个文件 -> 它自己的目录', F('/Users/douba/.dsh/x.md'), '/Users/douba/.dsh'],
  ['空列表 -> 用回退根', F(), FALLBACK],
]
for (const [name, docs, want] of roots) ok(name, commonRoot(docs, FALLBACK) === want, commonRoot(docs, FALLBACK))

// 关键回归：根一旦收到项目上，客户端算出的层级里就不该再出现 'Projects'。
const treeAtProject = H.buildTree(F(P('app/README.md'), P('app/docs/a.md')), P('app'))
const seenDirs = []
const collect = (n) => { n.dirs.forEach((c, k) => { seenDirs.push(k); collect(c) }) }
collect(treeAtProject)
console.log('  根=' + P('app') + ' 时的目录:', seenDirs.join(',') || '(无)')
ok('** 树里不再出现 Projects 这一层', !seenDirs.includes('Projects'))
ok('项目根下的 docs 直接是第一层', seenDirs.includes('docs'))
// 用带 name 的对象：上面 F() 造的是 {path}，名字取不到会误判成失败。
const named = (rel) => ({ path: P(rel), name: rel.split('/').pop() })
const treeNamed = H.buildTree([named('app/README.md'), named('app/docs/a.md')], P('app'))
ok('根上的 README.md 属于根，不被塞进任何目录', treeNamed.files.map((f) => f.name).join() === 'README.md')

console.log(fail ? `\n结果：pass=${pass} fail=${fail}` : `\n全部通过 (${pass})`)
process.exit(fail ? 1 : 0)
