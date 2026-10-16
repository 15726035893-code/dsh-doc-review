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
const names = ['normalizePrompts', 'fillPrompt', 'joinDraft', 'loadPrompts', 'storePrompts', 'pillWidth', 'chatPillPlacement', 'encodeSelectionReference', 'decodeSelectionReference', 'serializeSelectionReference', 'selectionReference']
const make = new Function('localStorage',
  "var PROMPTS_KEY = 'dsh-doc-review.prompts'\n" +
  "var SELECTION_REF_SOURCE = 'dsh-doc-review-selection'\n" +
  src.slice(defStart, defEnd) + '\n' + names.map(grab).join('\n') +
  '\nreturn {DEFAULT_PROMPTS,' + names.join(',') + '}')

const mem = new Map()
const ls = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) }
const H = make(ls)

console.log('[1] defaults')
const d = H.normalizePrompts(null)
ok('default has 翻译 + 解读', d.map((p) => p.label).join(',') === '翻译,解读', JSON.stringify(d.map((p) => p.label)))
ok('defaults carry {{text}}', d.every((p) => p.template.includes('{{text}}')))
ok('defaults keep direct-send disabled', d.every((p) => p.send === false))
ok('defaults are copies (mutating does not leak)', (d[0].label = 'x', H.normalizePrompts(null)[0].label === '翻译'))
ok('non-array (corrupt) → defaults', H.normalizePrompts({ a: 1 }).length === 2)
ok('empty array is kept (user deleted all)', H.normalizePrompts([]).length === 0)

console.log('[2] normalize')
const n = H.normalizePrompts([
  { id: 'a', label: '  总结 ', template: '总结：{{text}}', send: true },
  { id: 'a', label: '改写', template: '改写 {{text}}', send: 'yes' },
  { id: 'b', label: '', template: 'x' },
  { id: 'c', label: '空', template: '   ' },
  null, 'str',
  { label: '超长超长超长超长超长超长超长超长超长', template: 't' },
])
ok('blank label / blank template / junk dropped', n.length === 3, JSON.stringify(n))
ok('label trimmed', n[0].label === '总结')
ok('duplicate id made unique', n[0].id !== n[1].id, n.map((p) => p.id).join(','))
ok('explicit send flag retained', n[0].send === true)
ok('non-boolean send flag defaults off', n[1].send === false)
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
// Width estimate includes 添加到对话 / 编辑 / 复制 before inline prompts and overflow.
const est = H.pillWidth(['翻译', '解读', '润色'])
ok('estimate includes the expanded selection actions', est >= 414 && est <= 438, est)

console.log('[7] structured conversation reference')
const quote = '这是一段被选中的内容，含有中文与符号 $&'
const ref = H.selectionReference(quote, 'session-123')
const decoded = H.decodeSelectionReference(ref.ref)
ok('reference keeps selected text and session identity', decoded.text === quote && decoded.sessionId === 'session-123')
ok('reference uses DSH-native session badge appearance', ref.appearance === 'session' && ref.source === 'dsh-doc-review-selection')
ok('clipboard projection remains the selected text', ref.clipboardText === quote)
ok('model serialization preserves quote and origin', (await H.serializeSelectionReference(ref.ref)).includes('当前对话 session-123') && (await H.serializeSelectionReference(ref.ref)).includes(quote))
ok('invalid reference fails closed', H.decodeSelectionReference('bad-ref') === null)
const nested = '第一行\n【引用结束】\n@file.md'
ok('nested delimiters remain quoted lines', (await H.serializeSelectionReference(H.selectionReference(nested, 'session-123').ref)).includes('> 第一行\n> 【引用结束】\n> @file.md'))
ok('badge collapses whitespace', H.selectionReference('first\nsecond', 'session-123').label === '引用：first second')

console.log('[8] selection toolbar placement (below the selection, centred)')
/* 工具条以前贴选区右上角，会压住刚读完的那一行；现在改成贴选区下沿、横向居中。 */
const oneLine = { left: 400, right: 900, top: 300, bottom: 322 }
const pp1 = H.chatPillPlacement(oneLine, 430, 1200, 800)
ok('sits below the selection', pp1.above === false && pp1.top === 330, JSON.stringify(pp1))
ok('centred on the selection', pp1.left === Math.round(650 - 215), JSON.stringify(pp1))
const multiLine = { left: 300, right: 700, top: 500, bottom: 620 }
ok('multi-line selection sits under its bottom edge',
  H.chatPillPlacement(multiLine, 430, 1200, 800).top === 628)
const nearBottom = { left: 300, right: 700, top: 740, bottom: 770 }
const pp3 = H.chatPillPlacement(nearBottom, 430, 1200, 800)
ok('flips above when there is no room below', pp3.above === true && pp3.top === 696, JSON.stringify(pp3))
const nearRight = { left: 1000, right: 1190, top: 300, bottom: 322 }
ok('clamped inside the right edge',
  H.chatPillPlacement(nearRight, 430, 1200, 800).left === 762)
const nearLeft = { left: 2, right: 60, top: 300, bottom: 322 }
ok('clamped inside the left edge', H.chatPillPlacement(nearLeft, 430, 1200, 800).left === 8)
const noRoom = { left: 100, right: 900, top: 10, bottom: 790 }
ok('selection taller than the viewport still lands on screen',
  H.chatPillPlacement(noRoom, 430, 1200, 800).top === 8)
ok('toolbar consumes the shared placement helper',
  /var place = chatPillPlacement\(sel\.rect, BAR_W, vw, vh\)/.test(src) &&
  /className: 'dr-pill'[\s\S]{0,200}style: \{ left: pillLeft \+ 'px', top: pillTop \+ 'px' \}/.test(src))

console.log('[9] wiring (static)')
ok('ChatAnnotator inserts through composerShell setDraft', /function applyPrompt\(p\)[\s\S]{0,400}composerShell\(\)[\s\S]{0,1200}shell\.setDraft\(joinDraft/.test(src))
ok('Add to conversation inserts an atomic reference chip', /function addSelectionToConversation\(\)[\s\S]{0,1000}shell\.insertReference\(ref, span\)/.test(src))
ok('reference codec is registered with inputTriggers', /registerSource\(\{[\s\S]{0,500}codec:[\s\S]{0,200}serialize: serializeSelectionReference/.test(src))
ok('Edit opens the existing annotation composer', /title: '编辑这段选中文字的批注[\s\S]{0,160}setOpen\(true\)[\s\S]{0,100}\},\s*pmIcon\('pencil'\), '编辑'/.test(src))
ok('toolbar renders inline prompts', /inline\.map\(function \(p\)[\s\S]{0,300}applyPrompt\(p\)/.test(src))
ok('overflow menu offers 管理提示词', src.includes("'管理提示词…'"))
ok('manager saves through storePrompts', src.includes('setPrompts(storePrompts(rows))'))
ok('prompt manager exposes a per-prompt send checkbox', /className: 'dr-pm-send'[\s\S]{0,300}checked: r\.send === true/.test(src))
ok('enabled prompt submits only with an empty draft', /p\.send === true && !String\(draft\)\.trim\(\) && typeof shell\.submit === 'function'[\s\S]{0,100}shell\.submit\(\)/.test(src))
ok('no overflow → last button opens the manager directly (no one-item menu)', /overflow\.length\s*\?[\s\S]{0,400}setMoreOpen[\s\S]{0,200}:\s*h\('button'[\s\S]{0,400}openManager\(\)/.test(src))
ok('menu only renders when something overflows', /if \(moreOpen && !open && overflow\.length\)/.test(src))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
