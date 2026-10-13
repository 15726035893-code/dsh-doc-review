/* 单测：lib/mining.js
 * 跑法：node test/mining.mjs
 * 纯函数逻辑，不碰 ctx 不碰磁盘。
 */
import { strict as assert } from 'node:assert'
import { scanWithRules, mineCandidates, extractKeys, jaccard, inferTrigger, inferSuggest } from '../lib/mining.js'

let passed = 0
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log('  ✓', msg) }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; console.log('  ✓', msg) }

console.log('[1] scanWithRules — regex')
const text1 = `这是第一行。
这里有 TODO 需要跟进。
正常段落。
再一个 TODO 在这里。`
const r1 = scanWithRules(text1, [{ id: 'r1', trigger: 'TODO', suggest: '去掉', detect: { kind: 'regex', pattern: 'TODO', flags: 'g' } }])
ok(r1.length === 2, 'TODO 命中 2 次')
ok(r1[0].line === 2 && r1[1].line === 4, '行号对')
ok(r1[0].quote === 'TODO' && r1[0].ruleId === 'r1', 'quote 和 ruleId 对')
ok(r1[0].note.includes('[rule:r1]'), '默认 note 带 rule id')
ok(r1[0].kind === 'replace', 'kind=replace')

console.log('[2] scanWithRules — line_length')
const text2 = 'short\n' + 'x'.repeat(100) + '\nalso short'
const r2 = scanWithRules(text2, [{ id: 'r2', trigger: '行太长', detect: { kind: 'line_length', max: 50 } }])
ok(r2.length === 1 && r2[0].line === 2, 'line_length 命中第 2 行')

console.log('[3] scanWithRules — para_lines（连续非空散文行）')
const text3 = '标题\n\n这段很短。\n\n这是段落第一行\n这是段落第二行\n这是段落第三行\n这是段落第四行\n这是段落第五行\n\n结尾'
const r3 = scanWithRules(text3, [{ id: 'r3', trigger: '段落太长', detect: { kind: 'para_lines', max: 3 } }])
ok(r3.length === 1, 'para_lines 命中 1 段')
ok(r3[0].quote.split('\n').length === 5, '命中段的 quote 有 5 行')

console.log('[4] scanWithRules — heading_level')
const text4 = '# h1\n## h2\n### h3\n#### h4\n##### h5'
const r4 = scanWithRules(text4, [{ id: 'r4', trigger: '层级太深', detect: { kind: 'heading_level', max: 3 } }])
ok(r4.length === 2, 'heading_level 命中 h4+h5')
ok(r4[0].line === 4 && r4[1].line === 5, '行号对')

console.log('[5] scanWithRules — note_tpl 占位')
const r5 = scanWithRules(text1, [{ id: 'r5', trigger: 'T', suggest: 'S', note_tpl: '[{{trigger}}] {{suggest}}:{{excerpt}}', detect: { kind: 'regex', pattern: 'TODO', flags: 'g' } }])
ok(r5[0].note.includes('[T] S:TODO'), 'note_tpl 填充生效')

console.log('[6] scanWithRules — manual 跳过')
const r6 = scanWithRules(text1, [{ id: 'r6', trigger: '手动', detect: { kind: 'manual' } }])
eq(r6, [], 'manual 规则不走启发式')

console.log('[7] scanWithRules — 多规则去重')
const r7 = scanWithRules(text1, [
  { id: 'rA', trigger: 'A', detect: { kind: 'regex', pattern: 'TODO', flags: 'g' } },
  { id: 'rA', trigger: 'A', detect: { kind: 'regex', pattern: 'TODO', flags: 'g' } },   // 同 id 同行同 quote
])
ok(r7.length === 2, '同 ruleId 两次扫描结果去重为 2（原本 4）')

console.log('[8] extractKeys / jaccard')
const k1 = extractKeys('这段太长，建议拆开')
const k2 = extractKeys('这段太长，考虑拆分')
ok(k1.size > 0, 'extractKeys 产出非空')
ok(jaccard(k1, k2) > 0, 'jaccard 相似度 > 0')
ok(jaccard(extractKeys('完全不同的话题'), extractKeys('TypeScript 泛型')) === 0, '无交集 → jaccard=0')

console.log('[9] mineCandidates — 需要达到 minHits + minDocs')
const history = [
  { id: 'c1', note: '这段太长，拆开', docPath: '/a.md' },
  { id: 'c2', note: '这段过长，建议拆分', docPath: '/b.md' },
  { id: 'c3', note: '这段太长了，拆短', docPath: '/c.md' },
  { id: 'c4', note: '另一个话题完全不同的事', docPath: '/a.md' },
  { id: 'c5', note: '又一个无关的事情', docPath: '/b.md' },
]
const cands = mineCandidates(history, { minHits: 3, minDocs: 2 })
ok(cands.length >= 1, 'mineCandidates 挖到至少 1 个候选')
ok(cands[0]._evidence.hits >= 3, '候选命中 >=3')
ok(cands[0]._evidence.docs.length >= 2, '候选分布 >=2 篇文档')
ok(cands[0].detect.kind === 'manual', '默认 detect=manual')
ok(cands[0].sources.length >= 3, 'sources 包含来源 commentId')

console.log('[10] mineCandidates — 不够 minHits 不产出')
const sparse = mineCandidates([
  { id: 'c1', note: '太长拆开', docPath: '/a.md' },
  { id: 'c2', note: '完全无关', docPath: '/b.md' },
], { minHits: 3 })
eq(sparse, [], '只有 2 条相似 note → 空')

console.log('[11] mineCandidates — 同文档多次不算 minDocs')
const sameDoc = mineCandidates([
  { id: 'c1', note: '太长拆开', docPath: '/a.md' },
  { id: 'c2', note: '太长拆开', docPath: '/a.md' },
  { id: 'c3', note: '太长拆开', docPath: '/a.md' },
], { minHits: 3, minDocs: 2 })
eq(sameDoc, [], 'minDocs=2 但只有 1 篇 → 空')

console.log('[12] inferTrigger / inferSuggest')
const t = inferTrigger(['这段太长', '这段太长', '这段过长'])
ok(t.includes('出现'), 'inferTrigger 产出带「出现」关键词样式')
ok(inferSuggest(['一句很长的建议措辞这里', '短']) === '短', 'inferSuggest 取最短')

console.log('\n[mining.js] ' + passed + ' assertions passed')
