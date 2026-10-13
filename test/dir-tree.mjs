// dirOfDoc 的独立自证：目录树全靠它，算错就是把文件归错文件夹。
import { promises as fsp } from 'node:fs'
const src = await fsp.readFile('/Users/douba/Projects/dsh-doc-review/lib/client.js', 'utf8')
const start = src.indexOf('function dirOfDoc(')
if (start < 0) throw new Error('client.js missing dirOfDoc')
let i = src.indexOf('{', start), depth = 0, end = -1
for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i + 1; break } } }
const fn = new Function(src.slice(start, end) + '\nreturn dirOfDoc')()
const R = '/Users/douba/Projects/demo'
let pass = 0, fail = 0
const ok = (n, got, want) => { const g = JSON.stringify(got); if (g === JSON.stringify(want)) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + ' got ' + g + ' want ' + JSON.stringify(want)) } }
const d = (p) => ({ path: p })

ok('根里的文件', fn(d(R + '/README.md'), R), '')
ok('一层目录', fn(d(R + '/docs/a.md'), R), 'docs')
ok('两层目录', fn(d(R + '/docs/sub/a.md'), R), 'docs/sub')
ok('大小写不敏感', fn(d('/users/DOUBA/Projects/demo/docs/a.md'), R), 'docs')
ok('尾部斜杠的根', fn(d(R + '/docs/a.md'), R + '/'), 'docs')
ok('windows 反斜杠', fn(d('\\Users\\douba\\Projects\\demo\\docs\\a.md'), R), 'docs')
ok('根之外 -> null', fn(d('/tmp/outside/a.md'), R), null)
ok('同名前缀不算命中', fn(d(R + '-other/a.md'), R), null)
ok('空根 -> null', fn(d(R + '/a.md'), ''), null)
ok('根自身不是目录', fn(d(R + '/a.md'), R), '')
console.log(fail ? `\n中间结果：pass=${pass} fail=${fail}` : `\n路径用例全部通过 (${pass})`)

// ── 图标表自证 ──────────────────────────────────────────────────────────────
// pmIcon 对未知名字是 `PM_ICON[name].map` ⇒ TypeError，整个面板白屏。
// 名字只有字符串这一层，拼错了不会有任何提示，所以逐个核一遍。
const used = [...src.matchAll(/pmIcon\(\s*'([a-zA-Z]+)'/g)].map((m) => m[1])
const mapBody = src.slice(src.indexOf('var PM_ICON = {'), src.indexOf('function pmIcon('))
const defined = new Set([...mapBody.matchAll(/^\s+([a-zA-Z]+):\s*\[/gm)].map((m) => m[1]))
const missing = [...new Set(used)].filter((n) => !defined.has(n))
if (missing.length) { fail++; console.log('  FAIL 用到的图标没有定义: ' + missing.join(', ')) }
else { pass++; console.log('  ok   全部 ' + new Set(used).size + ' 个引用到的图标都已定义') }
const unused = [...defined].filter((n) => !used.includes(n))
for (const n of unused) console.log('  note 定义了但没用到: ' + n)
console.log(fail ? '' : '')
process.exit(fail ? 1 : 0)
console.log(fail ? `\n结果：pass=${pass} fail=${fail}` : `\n全部通过 (${pass})`)
process.exit(fail ? 1 : 0)
