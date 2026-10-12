/**
 * Selection-menu custom prompts (翻译 / 解读 …): pure helpers pulled straight out of lib/client.js.
 * 运行：node test/selection-prompts.mjs
 */
import { promises as fsp } from 'node:fs'

const src = await fsp.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')) } }

function grab(name) {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('client.js missing function: ' + name)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces: ' + name)
}

const defStart = src.indexOf('var DEFAULT_PROMPTS = [')
const defEnd = src.indexOf('\n    ]\n', defStart) + 6
const names = ['normalizePrompts', 'fillPrompt', 'joinDraft', 'loadPrompts', 'storePrompts', 'pillWidth']
const make = new Function('localStorage',
  "var PROMPTS_KEY = 'dsh-doc-review.prompts'\n" + src.slice(defStart, defEnd) + '\n' + names.map(grab).join('\n') +
  '\nreturn {DEFAULT_PROMPTS,' + names.join(',') + '}')

const mem = new Map()
const ls = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) }
const H = make(ls)

console.log('[1] defaults')
const d = H.normalizePrompts(null)
ok('default has 翻译 + 解读', d.map((p) => p.label).join(',') === '翻译,解读', JSON.stringify(d.map((p) => p.label)))
ok('defaults carry {{text}}', d.every((p) => p.template.includes('{{text}}')))
ok('defaults are copies (mutating does not leak)', (d[0].label = 'x', H.normalizePrompts(null)[0].label === '翻译'))
ok('non-array (corrupt) → defaults', H.normalizePrompts({ a: 1 }).length === 2)
ok('empty array is kept (user deleted all)', H.normalizePrompts([]).length === 0)

console.log('[2] normalize')
const n = H.normalizePrompts([
  { id: 'a', label: '  总结 ', template: '总结：{{text}}' },
  { id: 'a', label: '改写', template: '改写 {{text}}' },
  { id: 'b', label: '', template: 'x' },
  { id: 'c', label: '空', template: '   ' },
  null, 'str',
  { label: '超长超长超长超长超长超长超长超长超长', template: 't' },
])
ok('blank label / blank template / junk dropped', n.length === 3, JSON.stringify(n))
ok('label trimmed', n[0].label === '总结')
ok('duplicate id made unique', n[0].id !== n[1].id, n.map((p) => p.id).join(','))
ok('missing id generated', !!n[2].id)
ok('label capped at 16 chars', n[2].label.length === 16)
ok('list capped at 30', H.normalizePrompts(Array.from({ length: 50 }, (_, i) => ({ label: 'p' + i, template: 't' }))).length === 30)

console.log('[3] fillPrompt')
ok('{{text}} replaced', H.fillPrompt('翻译：{{text}}', 'hello') === '翻译：hello')
ok('every {{text}} replaced', H.fillPrompt('{{text}} / {{text}}', 'a') === 'a / a')
ok('no placeholder → appended quoted', H.fillPrompt('帮我解读一下  ', '一段话') === '帮我解读一下\n\n「一段话」', JSON.stringify(H.fillPrompt('帮我解读一下  ', '一段话')))
ok('$ in selection is literal (no regex replacement quirks)', H.fillPrompt('x {{text}}', "$& $1 $'") === "x $& $1 $'")
ok('default 翻译 contains the selection', H.fillPrompt(H.DEFAULT_PROMPTS[0].template, 'Selected words').includes('「Selected words」'))

console.log('[4] joinDraft')
ok('empty draft → just the prompt', H.joinDraft('', 'P') === 'P')
ok('null draft → just the prompt', H.joinDraft(null, 'P') === 'P')
ok('existing draft kept, blank line between', H.joinDraft('我先写的话\n\n', 'P') === '我先写的话\n\nP')
ok('annotation block in draft preserved', H.joinDraft('【批注 · 请逐条回应】…【批注结束】', 'P').startsWith('【批注 · 请逐条回应】…【批注结束】\n\nP'))

console.log('[5] persistence')
ok('nothing stored → defaults', H.loadPrompts().length === 2)
H.storePrompts([{ id: 'x', label: '总结', template: '{{text}}' }, { label: '', template: '' }])
ok('store cleans then saves', JSON.parse(mem.get('dsh-doc-review.prompts')).length === 1)
ok('load returns stored list', H.loadPrompts()[0].label === '总结')
mem.set('dsh-doc-review.prompts', '{not json')
ok('corrupt storage → defaults, no throw', H.loadPrompts().length === 2)
H.storePrompts([])
ok('empty list survives a round trip', H.loadPrompts().length === 0)

console.log('[6] pill width')
ok('wider with more prompts', H.pillWidth(['翻译', '解读']) > H.pillWidth([]))
// Calibrated against the rendered toolbar (Playwright, 13px host-menu type): 批注 复制 翻译 解读 润色 ⋯ = 309px.
const est = H.pillWidth(['翻译', '解读', '润色'])
ok('estimate tracks the rendered width (309px) within 12px, never short by more than 4', est >= 305 && est <= 321, est)

console.log('[7] wiring (static)')
ok('ChatAnnotator inserts via composerShell + setDraft', /function applyPrompt\(p\)[\s\S]{0,400}composerShell\(\)[\s\S]{0,300}setDraft\(joinDraft/.test(src))
ok('toolbar renders inline prompts', /inline\.map\(function \(p\)[\s\S]{0,300}applyPrompt\(p\)/.test(src))
ok('overflow menu offers 管理提示词', src.includes("'管理提示词…'"))
ok('manager saves through storePrompts', src.includes('setPrompts(storePrompts(rows))'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
