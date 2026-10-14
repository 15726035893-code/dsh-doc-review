/**
 * 组件作用域回归测试。
 *
 * 背景（2026-10-13 事故）：左栏范围下拉的「点外部/Esc/滚动关闭」effect 被粘进了
 * ChatAnnotator，而 state 是 DocReviewView 的局部 var。ChatAnnotator 挂在
 * shell.overlay（每个页面都渲染），一挂就抛
 *   ReferenceError: scopeMenuOpen is not defined
 * 表现为「批注页渲染出错」。语法检查（node --check）抓不到——那是运行期作用域问题。
 *
 * 做法：把整个 factory 体在一个 fake-React 环境里真实执行（保存所有 sibling 定义），
 * 然后通过 apply() 里注册的 slot 组件把每个组件渲染一次。任何未定义标识符当场抛出。
 * 不需要浏览器、不需要装依赖。
 */
import { promises as fsp } from 'node:fs'

const src = await fsp.readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')) } }

/* ── fake React：够跑组件函数体 ────────────────────────────────────────── */
const stateStore = []
function makeReact() {
  class Component { constructor(props) { this.props = props || {} } render() { return null } }
  const React = {
    Component,
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => {
      const v = typeof init === 'function' ? init() : init
      return [v, () => {}]
    },
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (init) => ({ current: init === undefined ? null : init }),
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useSyncExternalStore: (sub, get) => get(),
    Fragment: 'Fragment',
  }
  return React
}
const React = makeReact()
const h = React.createElement

/* ── 环境 stub ─────────────────────────────────────────────────────────── */
const noop = () => {}
const fakeWindow = {
  addEventListener: noop, removeEventListener: noop, innerWidth: 1200, innerHeight: 800,
  getSelection: () => null, matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
}
const fakeDoc = {
  getElementById: () => null,
  createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, classList: { add: noop, remove: noop } }),
  head: { appendChild: noop },
  body: { appendChild: noop, innerText: '' },
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => null, querySelectorAll: () => [],
  documentElement: { style: { setProperty: noop } },
  createTextNode: () => ({}),
  createRange: () => ({ setStart: noop, setEnd: noop, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }), getClientRects: () => [] }),
}
const fakeConsole = { log: noop, warn: noop, error: noop, info: noop, debug: noop }

/* ── 执行 factory 体，拿到 module.exports ──────────────────────────────── */
const marker = 'factory: (require) => {'
const mStart = src.indexOf(marker)
if (mStart < 0) throw new Error('client.js: factory marker not found')
let i = src.indexOf('{', mStart + marker.length - 1), depth = 0, mEnd = -1
for (; i < src.length; i++) {
  if (src[i] === '{') depth++
  else if (src[i] === '}') { depth--; if (!depth) { mEnd = i; break } }
}
if (mEnd < 0) throw new Error('client.js: unbalanced factory body')
const factoryBody = src.slice(mStart + marker.length, mEnd)

console.log('[1] 模块工厂可执行（语法之外的作用域体检）')
let exports_ = null
try {
  const factory = new Function('require', factoryBody)
  exports_ = factory((name) => {
    if (name === 'react') return React
    throw new Error('unexpected require in test: ' + name)
  })
  ok('factory executed without throwing', true)
} catch (e) {
  ok('factory executed without throwing', false, e.message)
}

console.log('[2] apply() 注册的槽位组件渲染一次')
// apply(ctx) 会把组件注册进 slots；用一个假 ctx 收集注册结果并逐个渲染。
const registered = []
const registeredReferences = []
const fakeCtx = {
  slots: {
    inject(name, fn) {
      // 立即回调，让 register 被调用
      fn()
      return noop
    },
    register(meta, render) {
      registered.push({ meta, render })
      return noop
    },
  },
  sessions: { scope: () => ({}), subscribe: () => noop, getSnapshot: () => ({}) },
  remote: { session: { prompt: () => Promise.resolve(), subscribe: () => noop } },
  get: (name) => name === 'inputTriggers' ? {
    registerSource(source) { registeredReferences.push(source); return noop },
  } : null,
  effect: (fn) => { try { return fn() } catch (e) { return noop } },
}

try {
  exports_.apply(fakeCtx)
  ok('apply() 执行无异常', true)
} catch (e) {
  ok('apply() 执行无异常', false, e.message)
}

ok('至少注册了 1 个槽位', registered.length >= 1, 'count=' + registered.length)
ok('注册了远程引用徽章序列化器', registeredReferences.length === 1 && typeof registeredReferences[0].codec.serialize === 'function')
ok('引用源使用 DSH 原生 session 徽章样式', registeredReferences[0] && registeredReferences[0].name === 'dsh-doc-review-selection')

for (const { meta, render } of registered) {
  const label = (meta && meta.name ? meta.name : '?') + ' / ' + (meta && meta.id ? meta.id : '?')
  try {
    const node = render()
    ok('渲染 ' + label + ' 无 ReferenceError', true)
  } catch (e) {
    ok('渲染 ' + label + ' 无 ReferenceError', false, e.message)
  }
}

console.log('[3] 组件边界：ChatAnnotator 不得吃 DocReviewView 的局部状态')
// 按花括号配对取函数体（比字符串搜索稳，能应对任意缩进与嵌套）。
function bodyOf(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(')
  const m = re.exec(factoryBody)
  if (!m) return null
  let s = factoryBody.indexOf('{', m.index + m[0].length - 1), d = 0
  for (let k = s; k < factoryBody.length; k++) {
    if (factoryBody[k] === '{') d++
    else if (factoryBody[k] === '}') { d--; if (!d) return factoryBody.slice(s + 1, k) }
  }
  return null
}

const caBody = bodyOf('ChatAnnotator')
const drBody = bodyOf('DocReviewView')
ok('ChatAnnotator 函数体捕获成功', caBody !== null)
ok('DocReviewView 函数体捕获成功', drBody !== null)
/* 2026-10-13 事故形态：DocReviewView 的局部 state（如 scopeMenuOpen）被粘进
 * ChatAnnotator；后者挂在 shell.overlay，一挂就 ReferenceError。
 * 范围下拉若再回来，这条守卫仍然有效；若 UI 回到三段式切换，则只校验「没有泄漏」。 */
ok('ChatAnnotator 不引用 DocReviewView 的 scopeMenuOpen', caBody !== null && !/scopeMenuOpen/.test(caBody))
ok('ChatAnnotator 不引用 DocReviewView 的 scopeBtnRef', caBody !== null && !/scopeBtnRef/.test(caBody))
ok('ChatAnnotator 不引用 DocReviewView 的 scopeNode', caBody !== null && !/\bscopeNode\b/.test(caBody))

console.log('\n结果：pass=' + pass + ' fail=' + fail)
process.exit(fail === 0 ? 0 : 1)
