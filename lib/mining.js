/**
 * @caihua/dsh-doc-review — mining.js
 *
 * 两件事：
 *   ① scanWithRules(text, rules) —— 对一篇文档正文跑启发式规则，返回「待 propose 的改动候选」
 *      输出的 span 直接可以喂给 proposeChange 工具（quote / line / note / after）。
 *   ② mineCandidates(history, opts) —— 把跨项目批注历史里反复出现的模式聚类成「候选规则」
 *      输出可以直接丢回 /doc-review 技能让用户决定是否入库。
 *
 * 两个函数都是纯逻辑，不碰磁盘不读 ctx，方便单测。
 */

/* ────────────────────────────── 启发式扫描 ────────────────────────────── */

/**
 * @param {string} text 文档正文
 * @param {Array} rules rules.json 里 status==='active' 的规则
 * @returns {Array<{ruleId, line, quote, suggest, note, kind:'replace'|'delete'}>}
 */
export function scanWithRules(text, rules) {
  const out = []
  const src = String(text || '')
  if (!src || !Array.isArray(rules) || !rules.length) return out
  const lines = src.split('\n')
  // 行起始 offset 预算：index -> offset
  const lineStart = new Array(lines.length)
  { let off = 0; for (let i = 0; i < lines.length; i++) { lineStart[i] = off; off += lines[i].length + 1 } }

  for (const rule of rules) {
    if (!rule || !rule.detect) continue
    const d = rule.detect
    if (d.kind === 'regex') scanRegex(src, lineStart, rule, out)
    else if (d.kind === 'line_length') scanLineLength(lines, lineStart, rule, out)
    else if (d.kind === 'para_lines') scanParaLines(lines, lineStart, rule, out)
    else if (d.kind === 'heading_level') scanHeadingLevel(lines, lineStart, rule, out)
    // manual：启发式扫不出，交给 agent
  }

  // 去重：同一 ruleId + 同一行 + 同一 quote 只保留一次
  const seen = new Set()
  return out.filter((s) => {
    const key = s.ruleId + '|' + s.line + '|' + s.quote.slice(0, 60)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function noteOf(rule, excerpt) {
  const tpl = rule.note_tpl || '[rule:' + rule.id + '] ' + (rule.suggest || rule.trigger)
  return tpl
    .replace(/\{\{\s*suggest\s*\}\}/g, rule.suggest || '')
    .replace(/\{\{\s*trigger\s*\}\}/g, rule.trigger || '')
    .replace(/\{\{\s*excerpt\s*\}\}/g, String(excerpt || '').slice(0, 80))
}

function scanRegex(src, lineStart, rule, out) {
  let re
  try { re = new RegExp(rule.detect.pattern, rule.detect.flags || 'gm') } catch (_) { return }
  if (!re.global) {
    // 没写 g 的话就只找第一个，补上
    try { re = new RegExp(rule.detect.pattern, (rule.detect.flags || '') + 'g') } catch (_) { return }
  }
  let m
  let guard = 0
  while ((m = re.exec(src)) && guard++ < 2000) {
    const idx = m.index
    const quote = m[0]
    if (!quote) { re.lastIndex++; continue }
    const line = lineAt(lineStart, idx)
    out.push({
      ruleId: rule.id, line, quote,
      suggest: rule.suggest || '', note: noteOf(rule, quote), kind: 'replace',
    })
  }
}

function scanLineLength(lines, lineStart, rule, out) {
  const max = rule.detect.max
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]
    if (L.length <= max) continue
    // 跳过代码块、表格、分割线等非散文行（启发式弱化误报）
    if (/^(\s*```|\s*\||\s*---|\s*\* \* \*)/.test(L)) continue
    out.push({
      ruleId: rule.id, line: i + 1, quote: L,
      suggest: rule.suggest || '把这一行拆短', note: noteOf(rule, L), kind: 'replace',
    })
  }
}

function scanParaLines(lines, lineStart, rule, out) {
  const max = rule.detect.max
  let bufStart = -1
  let bufLines = []
  const flush = () => {
    if (bufLines.length > max && bufStart >= 0) {
      const quote = bufLines.join('\n')
      out.push({
        ruleId: rule.id, line: bufStart + 1, quote,
        suggest: rule.suggest || '把这段拆成几段', note: noteOf(rule, quote), kind: 'replace',
      })
    }
    bufStart = -1; bufLines = []
  }
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]
    if (!L.trim() || /^\s*(#|>|-|\*|\d+\.|```|\|)/.test(L)) { flush(); continue }
    if (bufStart < 0) bufStart = i
    bufLines.push(L)
  }
  flush()
}

function scanHeadingLevel(lines, lineStart, rule, out) {
  const max = rule.detect.max
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i])
    if (!m) continue
    const level = m[1].length
    if (level <= max) continue
    out.push({
      ruleId: rule.id, line: i + 1, quote: lines[i],
      suggest: rule.suggest || '标题层级太深，考虑拉到更浅的层级', note: noteOf(rule, lines[i]), kind: 'replace',
    })
  }
}

function lineAt(lineStart, offset) {
  // 二分：lineStart 升序
  let lo = 0, hi = lineStart.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStart[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/* ────────────────────────────── 共性提炼 ────────────────────────────── */

/**
 * 把一组历史批注聚类，找出「反复出现的意见模式」，产出候选规则。
 *
 * 简版思路（不走 LLM）：
 *   1. 对每条批注的 note 文本做中文分词的粗暴近似：抽 2-gram 关键词 + 关键名词
 *   2. 把 note 关键词相似度 > 阈值 的批注聚一组
 *   3. 组内 ≥ minHits 条 && 来自 ≥ 2 篇不同文档的，产出一个候选规则（kind=manual，由用户/agent 决定要不要用启发式表达）
 *
 * 产出的候选规则是 rules.js schema 要求的 raw 形式（可直接丢给 addRule），
 * detect 兜底 { kind:'manual' }——想变 regex / line_length 让用户或 agent 自己填。
 *
 * @param {Array<{id, note, quote, selectedText, docPath, status}>} history 批注历史
 * @param {{minHits?: number, minDocs?: number, maxCandidates?: number}} opts
 * @returns {Array<{trigger, suggest, detect, sources, _evidence}>}
 */
export function mineCandidates(history, opts) {
  const minHits = (opts && opts.minHits) || 3
  const minDocs = (opts && opts.minDocs) || 2
  const maxCandidates = (opts && opts.maxCandidates) || 20
  const items = (history || []).filter((h) => h && h.note)
  if (items.length < minHits) return []

  // 1. 关键词向量化
  const vecs = items.map((h) => ({ item: h, keys: extractKeys(h.note) }))
  const used = new Array(vecs.length).fill(false)
  const groups = []
  for (let i = 0; i < vecs.length; i++) {
    if (used[i]) continue
    const base = vecs[i]
    const g = [base]
    used[i] = true
    for (let j = i + 1; j < vecs.length; j++) {
      if (used[j]) continue
      // 相似度判定：jaccard ≥ 0.2，或共享 keys 数 ≥ 2（兜底：短句被 stopword 吞后 jaccard 偏低）
      const shared = sharedKeys(base.keys, vecs[j].keys)
      if (jaccard(base.keys, vecs[j].keys) >= 0.2 || shared >= 2) {
        g.push(vecs[j]); used[j] = true
      }
    }
    if (g.length >= minHits) {
      const docs = new Set(g.map((x) => x.item.docPath || ''))
      if (docs.size >= minDocs) groups.push(g)
    }
  }
  // 2. 按组大小排
  groups.sort((a, b) => b.length - a.length)
  const candidates = []
  for (const g of groups.slice(0, maxCandidates)) {
    const notes = g.map((x) => x.item.note)
    const trigger = inferTrigger(notes)
    const suggest = inferSuggest(notes)
    candidates.push({
      trigger,
      suggest,
      detect: { kind: 'manual' },
      sources: g.map((x) => x.item.id).filter(Boolean),
      _evidence: {
        hits: g.length,
        docs: Array.from(new Set(g.map((x) => x.item.docPath || ''))).filter(Boolean),
        samples: notes.slice(0, 3),
      },
    })
  }
  return candidates
}

/**
 * 粗暴提关键词：
 *  - 去标点
 *  - 中文按 2-gram
 *  - 英文按单词
 *  - 过滤 stopwords
 */
export function extractKeys(text) {
  const s = String(text || '').toLowerCase().replace(/[，。！？、；：""''（）【】《》,.!?;:()\[\]{}<>]/g, ' ')
  const keys = new Set()
  // 英文词
  for (const w of s.split(/\s+/)) {
    if (!w) continue
    if (/^[a-z0-9][a-z0-9\-_]{1,}$/.test(w) && !STOP_EN.has(w)) keys.add(w)
  }
  // 中文：2-gram + 高信息 1-gram
  const cnOnly = s.replace(/[^\u4e00-\u9fa5]/g, '')
  for (let i = 0; i < cnOnly.length - 1; i++) {
    const g = cnOnly.slice(i, i + 2)
    if (!STOP_CN_PAIRS.has(g)) keys.add(g)
  }
  // 1-gram：只收评审常见"信息字"（避免 noise 泛滥）
  for (const ch of cnOnly) {
    if (HIGH_INFO_CN_CHARS.has(ch)) keys.add('_' + ch)   // 前缀区分 2-gram
  }
  return keys
}

const STOP_EN = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'are', 'was', 'be', 'in', 'on', 'at', 'for', 'with', 'by', 'this', 'that', 'it', 'as'])
const STOP_CN_PAIRS = new Set(['的的', '了了', '是是', '这里', '那里', '可以', '需要', '一下', '一个', '不要'])
/** 评审意见里带信息量的字：描述问题性质或改法方向。遇到就加入 keys，让「太长/过长/长了」能通过"长"字共享聚类 */
const HIGH_INFO_CN_CHARS = new Set([
  '长', '短', '多', '少', '深', '浅', '乱', '散', '冗', '余', '糙', '细', '粗',
  '拆', '合', '并', '分', '删', '改', '补', '加', '减', '移', '调', '换',
  '错', '误', '漏', '重', '复', '简', '繁', '清', '糊', '模', '歧', '义',
  '标', '题', '段', '句', '词', '行', '节', '章', '层', '级',
])

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const k of a) if (b.has(k)) inter++
  return inter / (a.size + b.size - inter)
}

export function sharedKeys(a, b) {
  if (!a.size || !b.size) return 0
  let n = 0
  for (const k of a) if (b.has(k)) n++
  return n
}

/** 从一组意见里提炼"统一说法"：取最高频的 2 个关键词拼成提示语 */
export function inferTrigger(notes) {
  const freq = new Map()
  for (const n of notes) for (const k of extractKeys(n)) freq.set(k, (freq.get(k) || 0) + 1)
  const top = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0])
  if (!top.length) return (notes[0] || '').slice(0, 40)
  return '出现「' + top.join(' / ') + '」相关内容'
}

export function inferSuggest(notes) {
  // 取最短的一条意见作为建议语（最短的往往最直给）
  const sorted = notes.slice().sort((a, b) => a.length - b.length)
  return (sorted[0] || '').slice(0, 80)
}
