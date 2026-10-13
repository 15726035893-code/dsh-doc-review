/**
 * 回归测试：ensureStyle() 必须能在浏览器半边真的跑起来，并把样式挂上 head。
 *
 * 为什么单独有这个测试：样式是内联在 client.js 里的模板串，改版时很容易
 * 「声明改了、使用处漏了」。这种错误 node --check 抓不到（语法合法），
 * 只对源码文本做正则的样式纪律检查也抓不到（不执行函数）。唯一可靠的办法
 * 是把这个函数抠出来真跑一遍。
 *
 * 真出过的事故：971f9cc 把 `var css = [...]` 改成 `var DR_STYLESHEET = ...`，
 * 但注入那行仍是 `el.textContent = css` —— css 这个标识符已不存在，注入时抛
 * ReferenceError，整页拿不到任何样式。缓存、主题、抽取顺序都排查过了，
 * 真因就是这一行。
 */
import { promises as fsp } from 'node:fs'

const src = await fsp.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')) } }

console.log('[1] ensureStyle 可被抠出')
const from = src.indexOf('function ensureStyle()')
const to = src.indexOf('/* ────────── 选中文字')
ok('找得到 ensureStyle 边界', from > 0 && to > from, `from=${from} to=${to}`)
const body = src.slice(from, to)

console.log('[2] 静态检查：不再引用裸标识符 css')
ok('注入那行用的是 DR_STYLESHEET', /el\.textContent = DR_STYLESHEET\b/.test(body))
ok('没有 `el.textContent = css`', !/el\.textContent = css\b/.test(body))
ok('没有 `var css = ` 这类残留声明', !/var\s+css\s*=/.test(body))
ok('css 标识符没有残留', !/\bcss\b/.test(body.replace(/DR_STYLESHEET/g, '')))

console.log('[3] 真执行一遍')
const HL_NAMES = ['HL_ANCHOR', 'HL_ANCHOR_ACTIVE', 'HL_ANCHOR_ACTIVE_BG', 'HL_MARK_BG', 'HL_ANCHOR_INK', 'HL_AVATAR_INK']
const HL_VALUES = ['#FCDE7E', '#FFC60A', 'rgba(255,198,10,0.25)', '#FFF1C2', '#7A5C00', '#FFFFFF']
const appended = []
const fakeDoc = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: (el) => appended.push(el) },
}
let threw = null
try {
  const decls = HL_NAMES.map((n, i) => `var ${n} = ${JSON.stringify(HL_VALUES[i])}`).join(';')
  const fnBody = body.replace(/^function ensureStyle\(\)\s*\{/, '').replace(/\}\s*$/, '')
  new Function('document', 'STYLE_ID', `${decls}; function ensureStyle(){${fnBody}} ensureStyle()`)(fakeDoc, 'dsh-doc-review-style')
} catch (e) {
  threw = e
}
ok('执行 ensureStyle 不抛错', !threw, threw && threw.message)
ok('样式元素已挂到 head', appended.length === 1, `appended=${appended.length}`)

const css = appended[0] ? String(appended[0].textContent || '') : ''
console.log('[4] 注入的样式内容')
ok('内容非空且成规模', css.length > 5000, `len=${css.length}`)
ok('含关键选择器', ['.dr-root', '.dr-col-docs', '.dr-list', '.dr-card'].every((s) => css.includes(s)))
ok('曾缺失的 .dr-snotes 有规则', css.includes('.dr-snotes{'))
ok('六处高亮色已插值', !css.includes('${'), css.includes('${') ? '仍有未插值占位符' : '')
ok('花括号配平',
  (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length,
  `${(css.match(/\{/g) || []).length} vs ${(css.match(/\}/g) || []).length}`)
ok('字号只用三档 + markdown em',
  (() => {
    const sizes = [...css.matchAll(/font-size:([^;}]+)/g)].map((m) => m[1].trim())
    const allowed = new Set(['13px', '12px', '11px', '1.5em', '1.3em', '1.14em', '1em', '.92em'])
    return sizes.every((s) => allowed.has(s) || s.startsWith('var(--dsh-content-font-size'))
  })())

console.log('\n结果：pass=' + pass + ' fail=' + fail)
process.exitCode = fail ? 1 : 0
