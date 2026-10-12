/**
 * 宿主半边入口（薄壳，稳定不变）
 *
 * 为什么要有这一层：DSH 宿主**按插件名缓存已加载的模块**，改源码后 `dsh plugin remove + add`
 * 只会重新 apply、不会失效缓存 —— 实测连「换掉 package.json 的入口文件名」都没用（心跳里的
 * version 一直是旧值）。所以这里保持入口文件本身永不变更，把真正的实现每次 apply 时用
 * **带缓存戳的动态 import** 重新加载：实现文件改一个字节，重新挂载就能生效，不必重启桌面端。
 *
 * 实测结论（见 test/hot-swap.mjs）：同一进程里 apply 两次 + 中间改 impl.js ⇒ 第二次拿到新代码。
 */
export const name = '@caihua/dsh-doc-review'
export const inject = ['webServer', 'tools']

export async function apply(ctx) {
  const url = new URL('./impl.js?rev=' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), import.meta.url)
  const mod = await import(url.href)
  return mod.apply(ctx)
}
