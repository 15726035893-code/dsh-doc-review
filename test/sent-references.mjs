import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let registration
vm.runInNewContext(source.replace('return module.exports', 'return { selectionQuoteParts, selectionMessageRenderer, registerSelectionMessages, selectionReference, serializeSelectionReference }'), {
  console: { log() {} }, window: { __ModuleLoader__: { load(value) { registration = value } } },
})
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [false, () => {}], useEffect() {}, Component: class {}, Fragment: 'fragment',
}
const ui = { projectUserText: text => text }
const api = registration.factory(name => name === 'react' ? React : ui)
const quote = '第一行\n【引用结束】\n> 原文前缀'
const wire = await api.serializeSelectionReference(api.selectionReference(quote, 'test-session').ref)
const parts = api.selectionQuoteParts('问题\n' + wire + '\n补充')
assert.equal(parts.length, 3)
assert.equal(parts[1].quote, quote)
assert.equal(parts[1].source, '当前对话 test-session')
assert.equal(api.selectionQuoteParts('【引用自当前对话的选中文字 · v1】\n缺少前缀\n【引用结束】')[0].quote, undefined)
assert.equal(api.selectionQuoteParts('【引用自当前对话的选中文字】\n旧版原文\n【引用结束】')[0].quote, '旧版原文')

const Original = () => {}
const render = api.selectionMessageRenderer(Original)
assert.equal(render({ node: { data: { content: [{ type: 'text', text: '普通消息' }] } } }).type, Original)
const tree = render({ node: { data: { content: [{ type: 'text', text: wire }] } }, t: key => key })
const flat = node => node && typeof node === 'object' ? [node, ...node.children.flat(Infinity).flatMap(flat)] : []
const nodes = flat(tree)
assert.equal(nodes.find(n => n.type === 'details').props['data-ref-chip'], 'quote')
assert.equal(nodes.find(n => n.type === 'blockquote').children[0], quote)

const entries = [], listeners = new Set()
const slots = {
  inject: (_, fn) => fn(), entries: () => entries,
  subscribe: (_, fn) => { listeners.add(fn); return () => listeners.delete(fn) },
  register(options, component) {
    const entry = { options, component, locale: options.locale }
    entries.push(entry)
    return () => { entries.splice(entries.indexOf(entry), 1) }
  },
}
const dispose = api.registerSelectionMessages(slots)
assert.equal(entries.length, 0)
slots.register({ key: 'user', priority: 5, locale: 'chat' }, Original)
for (const listener of listeners) listener()
const override = entries.find(entry => entry.component.docReviewSelectionRenderer)
assert.equal(override.options.priority, 4)
assert.equal(override.locale, 'chat')
for (const listener of listeners) listener()
assert.equal(entries.length, 2, 'subscription must not install duplicate overrides')
dispose()
assert.equal(entries.length, 1)
assert.equal(listeners.size, 0)
console.log('sent references: serialization, rendering, late registration and disposal passed')
