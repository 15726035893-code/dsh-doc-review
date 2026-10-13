/**
 * @caihua/dsh-doc-review — rules.json 规则库
 *
 * 一句话：rules.json 存从历次批注里提炼出来的「预审规则」，用户在 DSH 的 /doc-review 技能里用，
 *   触发 doc_change_propose 自动挂预审建议。规则库跟 doc-review 配置目录走（~/.dsh/doc-review/rules.json），
 *   不跟技能走——卸载/升级技能不影响已沉淀的规则。
 *
 * schema v1：
 *   { version:1, updatedAt:ISO, rules: Rule[] }
 *
 * Rule 字段（JSON 文件里直接可读，不藏黑话）：
 *   id         string   r_<timestamp>_<slug>
 *   trigger    string   什么情况下触发（人读说明）
 *   suggest    string   建议改成什么（人读说明）
 *   detect     object   启发式检测器，kind 决定字段：
 *                       - regex       { kind:'regex', pattern, flags? }
 *                       - line_length { kind:'line_length', max }  按单行字符数
 *                       - para_lines  { kind:'para_lines', max }   按连续非空段落行数
 *                       - heading_level{ kind:'heading_level', max }  标题层级深度
 *                       无法用启发式表达的规则留 detect.kind='manual'，由 agent 侧读 trigger 自判定
 *   note_tpl   string?  propose note 模板，{{suggest}} / {{trigger}} / {{excerpt}} 占位；留空自动生成
 *   status     string   candidate | active | deprecated
 *   stats      object   { hits, accept, reject, edit }
 *   sources    string[] 从哪几条历史批注提炼出来（commentId 列表，有则有）
 *   createdAt  ISO
 *   lastReview ISO?     上一次 review（自动降级或手动改动）
 *
 * 「人直接改」规范：数组字段末尾可带 ","；文件可追加顶层 _comment 字段放提醒。
 *   运行时 readRules() 容错：读不到就返回空库；格式坏了不崩，返回空库 + 把坏文件备份一份。
 */
import { promises as fsp } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'

export const RULES_SCHEMA_VERSION = 1
export const RULE_STATUS = /** @type {const} */ (['candidate', 'active', 'deprecated'])
export const DETECT_KINDS = /** @type {const} */ (['regex', 'line_length', 'para_lines', 'heading_level', 'manual'])

/** 新鲜库（空 rules，带版本号与注释引导） */
export function emptyRulesFile() {
  return {
    version: RULES_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    _comment: '预审规则库。rules[] 为空表示还没沉淀过规则——按正常批注累积反馈，再用 /doc-review 技能或 doc_review_mine_candidates 工具提炼。手动改本文件时 version 不要动。',
    rules: [],
  }
}

/** 稳定 id：时间戳 + 从 trigger 抽的 slug（去中英文空白、拼音首字母不做了，直接 ascii/数字） */
export function newRuleId(trigger) {
  const t = Date.now().toString(36)
  const slug = String(trigger || '')
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'rule'
  return 'r_' + t + '_' + slug
}

/** 规整单条 rule——未知字段保留，必填字段兜底 */
export function normRule(raw, nowIso) {
  if (!raw || typeof raw !== 'object') return null
  const now = nowIso || new Date().toISOString()
  const trigger = String(raw.trigger || '').trim()
  if (!trigger) return null
  const detect = normDetect(raw.detect)
  if (!detect) return null
  const status = RULE_STATUS.includes(raw.status) ? raw.status : 'candidate'
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {}
  const sources = Array.isArray(raw.sources) ? raw.sources.map(String) : []
  return {
    id: String(raw.id || newRuleId(trigger)),
    trigger,
    suggest: String(raw.suggest || '').trim(),
    detect,
    note_tpl: raw.note_tpl ? String(raw.note_tpl) : '',
    status,
    stats: {
      hits: Number(stats.hits) || 0,
      accept: Number(stats.accept) || 0,
      reject: Number(stats.reject) || 0,
      edit: Number(stats.edit) || 0,
    },
    sources,
    createdAt: String(raw.createdAt || now),
    lastReview: raw.lastReview ? String(raw.lastReview) : '',
  }
}

/** detect 字段的归一化。认不出就 null（整条规则扔掉），不默默吞 */
export function normDetect(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = String(raw.kind || '').trim()
  if (!DETECT_KINDS.includes(kind)) return null
  if (kind === 'regex') {
    const pattern = String(raw.pattern || '')
    if (!pattern) return null
    const flags = String(raw.flags || 'gm')
    try { new RegExp(pattern, flags) } catch (_) { return null }
    return { kind, pattern, flags }
  }
  if (kind === 'line_length' || kind === 'para_lines' || kind === 'heading_level') {
    const max = Number(raw.max)
    if (!(max > 0)) return null
    return { kind, max }
  }
  // manual：由 agent 读 trigger/suggest 自己判断
  return { kind: 'manual' }
}

/** 从磁盘读；文件不存在/坏了返回空库 */
export async function readRules(filePath) {
  if (!existsSync(filePath)) return emptyRulesFile()
  let raw
  try { raw = JSON.parse(await fsp.readFile(filePath, 'utf8')) } catch (e) {
    // 文件坏了——备份原文件，返回空库继续跑（不让用户的 agent 全瘫）
    try { await fsp.copyFile(filePath, filePath + '.corrupt-' + Date.now() + '.bak') } catch (_) {}
    return { ...emptyRulesFile(), _comment: '上一版 rules.json 解析失败，已备份；现在用的是空库。' }
  }
  if (!raw || typeof raw !== 'object') return emptyRulesFile()
  const now = new Date().toISOString()
  const rules = Array.isArray(raw.rules) ? raw.rules.map((r) => normRule(r, now)).filter(Boolean) : []
  return {
    version: Number(raw.version) || RULES_SCHEMA_VERSION,
    updatedAt: String(raw.updatedAt || now),
    _comment: raw._comment ? String(raw._comment) : emptyRulesFile()._comment,
    rules,
  }
}

/** 原子写：先写 .tmp 再 rename */
export async function writeRules(filePath, file) {
  const out = {
    version: Number(file.version) || RULES_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    _comment: file._comment || emptyRulesFile()._comment,
    rules: (file.rules || []).map((r) => normRule(r)).filter(Boolean),
  }
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now()
  await fsp.writeFile(tmp, JSON.stringify(out, null, 2), 'utf8')
  await fsp.rename(tmp, filePath)
  return out
}

/** 增 / 改 / 删 的高阶函数（纯），返回新 file 对象，调用方自行 writeRules */
export function addRule(file, rawRule) {
  const r = normRule(rawRule)
  if (!r) return { file, rule: null, error: 'rule 格式不合法（trigger 必填、detect.kind 必须被认识）' }
  const dup = (file.rules || []).some((x) => x.id === r.id)
  if (dup) r.id = newRuleId(r.trigger)
  return { file: { ...file, rules: [...(file.rules || []), r] }, rule: r }
}

export function updateRule(file, id, patch) {
  const list = file.rules || []
  let hit = null
  const next = list.map((r) => {
    if (r.id !== id) return r
    const merged = { ...r, ...patch, id: r.id, createdAt: r.createdAt, stats: { ...r.stats, ...(patch.stats || {}) } }
    hit = normRule(merged)
    return hit || r
  })
  if (!hit) return { file, rule: null, error: '找不到规则：' + id }
  return { file: { ...file, rules: next }, rule: hit }
}

export function removeRule(file, id) {
  const list = file.rules || []
  const idx = list.findIndex((r) => r.id === id)
  if (idx < 0) return { file, removed: null, error: '找不到规则：' + id }
  return { file: { ...file, rules: list.filter((_, i) => i !== idx) }, removed: list[idx] }
}

export function setRuleStatus(file, id, status) {
  if (!RULE_STATUS.includes(status)) return { file, error: 'status 必须是 ' + RULE_STATUS.join(' / ') }
  return updateRule(file, id, { status, lastReview: new Date().toISOString() })
}

/** 回算 stats 的闭包：给定一条规则 + 决策事件列表，叠加 accept/reject/edit 计数 */
export function bumpStats(file, id, delta) {
  const list = file.rules || []
  const next = list.map((r) => {
    if (r.id !== id) return r
    const s = r.stats || {}
    return { ...r, stats: {
      hits: (s.hits || 0) + (delta.hits || 0),
      accept: (s.accept || 0) + (delta.accept || 0),
      reject: (s.reject || 0) + (delta.reject || 0),
      edit: (s.edit || 0) + (delta.edit || 0),
    } }
  })
  return { ...file, rules: next }
}

/** 自动健康检查：输入 file，返回建议动作列表（不直接改） */
export function healthCheck(file) {
  const now = Date.now()
  const DAY = 24 * 3600 * 1000
  const findings = []
  for (const r of file.rules || []) {
    const s = r.stats || {}
    const hits = s.hits || 0
    if (r.status === 'active' && hits > 5 && (s.reject || 0) / hits > 0.5) {
      findings.push({ ruleId: r.id, action: 'demote', reason: '拒绝率 > 50%（' + s.reject + '/' + hits + '），建议降回 candidate 让用户确认' })
    }
    if (r.status === 'active' && hits > 10 && (s.edit || 0) / hits > 0.3) {
      findings.push({ ruleId: r.id, action: 'review', reason: '修改后接受比例 > 30%，建议细化规则或加例外' })
    }
    if (r.status === 'active' && r.lastReview && (now - Date.parse(r.lastReview || r.createdAt)) > 90 * DAY && hits === 0) {
      findings.push({ ruleId: r.id, action: 'deprecate', reason: '90 天未命中，建议停用' })
    }
  }
  return findings
}
