/* 单测：lib/rules.js
 * 跑法：node test/rules.mjs
 * 不依赖 ctx、不依赖磁盘（只在 tmp 下建临时文件）。
 */
import { strict as assert } from 'node:assert'
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  emptyRulesFile, newRuleId, normRule, normDetect,
  readRules, writeRules, addRule, updateRule, removeRule, setRuleStatus, bumpStats, healthCheck,
  RULE_STATUS, DETECT_KINDS,
} from '../lib/rules.js'

let passed = 0
function ok(cond, msg) { assert.ok(cond, msg); passed++; console.log('  ✓', msg) }
function eq(a, b, msg) { assert.deepStrictEqual(a, b, msg); passed++; console.log('  ✓', msg) }

console.log('[1] empty / id / normalization')
ok(emptyRulesFile().version === 1, 'emptyRulesFile.version=1')
ok(emptyRulesFile().rules.length === 0, 'empty rules[] 空')
ok(newRuleId('冗余删除').startsWith('r_'), 'newRuleId 以 r_ 开头')
ok(newRuleId('冗余删除').includes('冗余删除'), 'newRuleId 含 trigger slug')
ok(normRule(null) === null, 'normRule(null) → null')
ok(normRule({}) === null, 'normRule({}) 缺 trigger → null')
ok(normRule({ trigger: '' }) === null, 'normRule(空 trigger) → null')
ok(normRule({ trigger: 't' }) === null, 'normRule 缺 detect → null')

console.log('[2] detect kinds')
ok(normDetect({ kind: 'xxx' }) === null, '未知 kind → null')
ok(normDetect({ kind: 'regex', pattern: '' }) === null, 'regex 缺 pattern → null')
ok(normDetect({ kind: 'regex', pattern: '[' }) === null, 'regex pattern 不合法 → null')
eq(normDetect({ kind: 'regex', pattern: 'foo' }), { kind: 'regex', pattern: 'foo', flags: 'gm' }, 'regex 默认 flags=gm')
eq(normDetect({ kind: 'line_length', max: 80 }), { kind: 'line_length', max: 80 }, 'line_length ok')
ok(normDetect({ kind: 'line_length', max: 0 }) === null, 'line_length max=0 → null')
ok(normDetect({ kind: 'line_length', max: -5 }) === null, 'line_length 负数 → null')
eq(normDetect({ kind: 'manual' }), { kind: 'manual' }, 'manual 不需要别的字段')

console.log('[3] addRule / updateRule / removeRule')
let file = emptyRulesFile()
const r1 = addRule(file, { trigger: '行太长', suggest: '拆短', detect: { kind: 'line_length', max: 80 } })
ok(r1.rule && r1.rule.id, 'addRule 返回新规则 id')
ok(r1.file.rules.length === 1, 'addRule 后 rules.length=1')
file = r1.file
const r2 = addRule(file, { trigger: '标题太深', detect: { kind: 'heading_level', max: 3 } })
file = r2.file
ok(file.rules.length === 2, '连加两条')

const upd = updateRule(file, r1.rule.id, { suggest: '直接拆成两行' })
ok(upd.rule.suggest === '直接拆成两行', '更新 suggest 生效')
ok(upd.rule.id === r1.rule.id, 'updateRule 保留 id')
file = upd.file

const rm = removeRule(file, r2.rule.id)
ok(rm.removed.id === r2.rule.id, 'removeRule 返回被删条')
ok(rm.file.rules.length === 1, 'removeRule 后 length=1')
ok(removeRule(rm.file, 'r_nope').error, 'removeRule 不存在 id → error')
file = rm.file

const ss = setRuleStatus(file, r1.rule.id, 'active')
ok(ss.rule.status === 'active', 'setRuleStatus active 生效')
ok(ss.rule.lastReview, 'setRuleStatus 更新 lastReview')
ok(setRuleStatus(file, r1.rule.id, 'xxx').error, '非法 status → error')
file = ss.file

const bs = bumpStats(file, r1.rule.id, { hits: 1, accept: 1 })
ok(bs.rules[0].stats.hits === 1 && bs.rules[0].stats.accept === 1, 'bumpStats 加 1')
const bs2 = bumpStats(bs, r1.rule.id, { reject: 2 })
ok(bs2.rules[0].stats.reject === 2 && bs2.rules[0].stats.hits === 1, 'bumpStats 累加')

console.log('[4] healthCheck')
const bad = { ...file, rules: [{
  ...file.rules[0], status: 'active',
  stats: { hits: 10, accept: 2, reject: 7, edit: 1 },
  lastReview: new Date().toISOString(),
}] }
const findings = healthCheck(bad)
ok(findings.some((f) => f.action === 'demote'), '拒绝率 > 50% → 建议 demote')

const editHeavy = { ...file, rules: [{
  ...file.rules[0], status: 'active',
  stats: { hits: 20, accept: 10, reject: 2, edit: 8 },
  lastReview: new Date().toISOString(),
}] }
ok(healthCheck(editHeavy).some((f) => f.action === 'review'), '修改后接受占比高 → 建议 review')

const stale = { ...file, rules: [{
  ...file.rules[0], status: 'active',
  stats: { hits: 0, accept: 0, reject: 0, edit: 0 },
  createdAt: new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString(),
  lastReview: new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString(),
}] }
ok(healthCheck(stale).some((f) => f.action === 'deprecate'), '90 天未命中 → 建议 deprecate')

console.log('[5] readRules / writeRules 磁盘往返')
const tmp = path.join(os.tmpdir(), 'dsh-doc-review-rules-test-' + Date.now())
await fsp.mkdir(tmp, { recursive: true })
const rulesPath = path.join(tmp, 'rules.json')

eq((await readRules(rulesPath)).rules, [], '文件不存在 → 空库')
await writeRules(rulesPath, file)
ok(existsSync(rulesPath), 'writeRules 落盘')
const back = await readRules(rulesPath)
ok(back.rules.length === 1, '读回来 1 条')
ok(back.rules[0].trigger === '行太长', '读回来字段对')

// 坏文件处理
await fsp.writeFile(rulesPath, '{not json', 'utf8')
const corrupt = await readRules(rulesPath)
eq(corrupt.rules, [], '坏文件 → 空库返回')
const bakFiles = (await fsp.readdir(tmp)).filter((f) => f.includes('.corrupt-'))
ok(bakFiles.length > 0, '坏文件备份一份')

// 清理
try { await fsp.rm(tmp, { recursive: true, force: true }) } catch (_) {}

console.log('\n[rules.js] ' + passed + ' assertions passed')
