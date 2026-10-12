/**
 * 热替换机制的自证测试：宿主按插件名缓存模块，所以入口做成薄壳 + 带缓存戳的动态 import。
 * 这里模拟真实场景：同一进程内 apply 两次，中间改掉 impl.js，第二次必须拿到新代码。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const WORK = path.join(os.homedir(), 'dsh-plugins', '_hotswap-root', 'lib')
await fsp.rm(path.dirname(WORK), { recursive: true, force: true })
await fsp.mkdir(WORK, { recursive: true })

// 把真入口 + 一份假的 impl 拷进临时目录（不动真 lib/）
const realLib = new URL('../lib/', import.meta.url)
await fsp.copyFile(new URL('index.js', realLib), path.join(WORK, 'index.js'))

const fakeImpl = (tag) => `export const inject = ['webServer','tools']
export async function apply(ctx) {
  globalThis.__hotswapTag = ${JSON.stringify(tag)}
  return { tag: ${JSON.stringify(tag)} }
}
`
await fsp.writeFile(path.join(WORK, 'impl.js'), fakeImpl('v1'), 'utf8')

const entryUrl = pathToFileURL(path.join(WORK, 'index.js')).href
const entry = await import(entryUrl)
const ctx = { webServer: { register: () => () => {} }, tools: { register: () => () => {} }, effect: () => () => {} }

let pass = 0, fail = 0
const ok = (n, c, x) => { if (c) { pass++; console.log('  ok   ' + n) } else { fail++; console.log('  FAIL ' + n + (x ? ' :: ' + x : '')) } }

const r1 = await entry.apply(ctx)
ok('第一次 apply 拿到 v1', r1 && r1.tag === 'v1', JSON.stringify(r1))

await fsp.writeFile(path.join(WORK, 'impl.js'), fakeImpl('v2'), 'utf8')
const r2 = await entry.apply(ctx)
ok('改掉 impl.js 后再次 apply 拿到 v2（缓存被戳穿）', r2 && r2.tag === 'v2', JSON.stringify(r2))

// 对照：不带缓存戳的静态 import 会拿到旧模块（说明这个机制确实必要）
await fsp.writeFile(path.join(WORK, 'plain.js'), 'export const tag = "p1"\n', 'utf8')
const p1 = await import(pathToFileURL(path.join(WORK, 'plain.js')).href)
await fsp.writeFile(path.join(WORK, 'plain.js'), 'export const tag = "p2"\n', 'utf8')
const p2 = await import(pathToFileURL(path.join(WORK, 'plain.js')).href)
ok('对照：静态 URL 复用旧模块（p1 仍是 p1）', p1.tag === 'p1' && p2.tag === 'p1', p1.tag + '/' + p2.tag)

console.log('\n结果：pass=' + pass + ' fail=' + fail)
process.exitCode = fail ? 1 : 0
