/* @caihua/dsh-doc-review — 浏览器半边（手写 __ModuleLoader__ bundle，零构建）
 *
 * 注册面：conversation.view ——「批注」会话页，与「对话轨迹」「上下文」并列。
 * 交互：左边选文档 → 中间渲染正文（划词）→ 右边写意见；意见落盘到
 *       <文档目录>/.dsh-review/<文件名>.review.json，Agent 用 doc_review_* 工具读写。
 * 一键「交给 AI 改稿」：直接往当前会话排队一条消息（ctx.remote.session.prompt）。
 */
console.log('[dsh-doc-review] client v0.7.1')
window.__ModuleLoader__.load({
  id: '@caihua/dsh-doc-review',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef
    var useMemo = React.useMemo

    var STYLE_ID = 'dsh-doc-review-style'

    // 文档范围：相关（默认）＝本会话产出的文档 + 本项目其它会话碰过的文档；工作区＝会话 cwd 全量；全库＝配置 roots
    var SCOPE_LABEL = { related: '相关', session: '本会话', workspace: '工作区', vault: '全库' }
    var SCOPE_TITLE = {
      related: '当前：先列本会话产出/编辑过的文档，再列本项目其它会话碰过的文档（不是文件夹全量）。点一下切到「工作区」',
      workspace: '当前：这个会话工作目录下的全部 md。点一下切到「全库」',
      vault: '当前：配置根目录的全库。点一下切回「相关」',
    }
    var SCOPE_ORDER = ['related', 'workspace', 'vault']

    var API = {
      hello: '/api/dsh-doc-review/hello',
      state: '/api/dsh-doc-review/state',
      docs: '/api/dsh-doc-review/docs',
      doc: '/api/dsh-doc-review/doc',
      save: '/api/dsh-doc-review/save',
      snotes: '/api/dsh-doc-review/snotes',
      snote: '/api/dsh-doc-review/snote',
      props: '/api/dsh-doc-review/props',
      prop: '/api/dsh-doc-review/prop',
    }

    // apply 作用域内的宿主服务（组件通过闭包读取，重挂不丢）
    var sessions = null
    var remoteFace = null
    var convFace = null            // conversation 服务（输入框 facade），拿不到就优雅降级
    var ctxRef = null              // apply 时的 ctx：用于惰性重取 conversation（该服务可能后注册）

    /* ── 会话批注 → 聊天输入框（攒批发送）──────────────────────────────
     * 用户在对话里划词写批注，保存后直接追加到当前会话的输入框草稿里，攒够多条一次发出。
     * 依据：GitHub pending review 的官方理由就是"防止 AI 在你没写完之前按单条开工"；
     * Claude Artifacts 也是"多处攒批 + 一次应用"。
     * 输入框 facade：ctx.get('conversation').input.for(sessions.scope(sessionId))，
     * 有 state.getSnapshot().draft / setDraft(text) / focus()。
     * 用 ctx.get(...) 而不是声明依赖：拿不到就只落盘、不碰输入框，绝不让插件挂掉
     * （v0.5.0 那次客户端条目 failed 导致 web boot 崩溃的教训）。 */
    var ANNO_HEAD = '【批注 · 请逐条回应】'
    var ANNO_TAIL = '【批注结束】'

    function composerShell() {
      try {
        // 惰性重取：conversation 可能比本插件晚注册，apply 时拿到 null 不等于一直没有
        if (!convFace && ctxRef) {
          try { convFace = (typeof ctxRef.get === 'function') ? (ctxRef.get('conversation') || null) : (ctxRef.conversation || null) } catch (_) { convFace = null }
        }
        if (!convFace || !convFace.input || !sessions || !sessions.scope) return null
        var sid = currentSessionId()
        if (!sid) return null
        var scoped = sessions.scope(sid)
        if (scoped === undefined || scoped === null) return null
        return convFace.input.for(scoped)
      } catch (_) { return null }
    }

    /** 正文角标的悬浮说明：已处理的要把"当时的意见 + 结论"一起带出来。
     *  依据：Google Docs / Confluence / Dropbox 的已解决评论一律离开正文、只能去 history 找，
     *  是 9 家文档产品的共同缺陷；我们保留锚点，就要让人一眼看出它是已处理、并召回原因。 */
    function markTitle(c, n) {
      var pend = (c.status || 'pending') === 'pending'
      if (pend) return '#' + n + ' ' + (c.note || '')
      return '#' + n + ' 已处理 · 当时的意见：' + (c.note || '') + (c.reply ? ' · 结论：' + c.reply : '')
    }

    /** 把草稿里已有的批注块摘掉，只留用户自己写的话 */
    function stripAnnoBlock(text) {
      var s = String(text == null ? '' : text)
      var i = s.indexOf(ANNO_HEAD)
      if (i < 0) return s
      var j = s.indexOf(ANNO_TAIL, i)
      var end = j < 0 ? s.length : j + ANNO_TAIL.length
      var before = s.slice(0, i).replace(/[\s\u3000]+$/, '')
      var after = s.slice(end).replace(/^[\s\u3000]+/, '')
      if (before && after) return before + '\n\n' + after
      return before || after
    }

    /** 按当前待处理批注重建批注块（每次保存都整体重算，不会越攒越乱）。
     *  2026-10-12 修：**已经随消息发出过的批注不再进块**（sent_at）。
     *  修前的问题：块只按 status 过滤，而批注要等 AI 调 session_note_resolve 才会变 resolved；
     *  AI 没结清时，你每写一条新的，块里就把前面所有没结清的都带上——"上一次批注的内容又回来了"。 */
    function buildAnnoBlock(notes) {
      var list = (notes || []).filter(function (n) { return (n.status || 'pending') === 'pending' && !n.sent_at })
      if (!list.length) return ''
      var L = [ANNO_HEAD + '共 ' + list.length + ' 条（我对着上面的对话内容写的）']
      list.forEach(function (n, i) {
        L.push((i + 1) + '. 原文：「' + String(n.quote || '').replace(/\s+/g, ' ').slice(0, 120) + '」')
        L.push('   意见：' + String(n.note || '').replace(/\s+/g, ' ').slice(0, 200))
      })
      L.push(ANNO_TAIL)
      return L.join('\n')
    }

    /** 把批注块同步进输入框草稿；返回 'ok' | 'empty' | 'command' | 'unavailable'
     *  已发送过的批注（sent_at / 已处理）不会出现在块里；用户自己的文字原样保留在块下方。 */
    function syncDraftToComposer(notes) {
      var shell = composerShell()
      if (!shell || !shell.state || !shell.setDraft) return 'unavailable'
      try {
        var draft = (shell.state.getSnapshot() || {}).draft || ''
        var mine = stripAnnoBlock(draft)
        if (/^\s*\//.test(mine)) return 'command'      // 斜杠命令不拼块，否则命令失效
        var block = buildAnnoBlock(notes)
        if (!block) { shell.setDraft(mine); stopWatchingDraft(); return 'empty' }
        shell.setDraft(block + (mine ? '\n\n' + mine : ''))
        watchDraftSent((notes || []).filter(function (n) {
          return (n.status || 'pending') === 'pending' && !n.sent_at
        }).map(function (n) { return n.id }))
        try { if (typeof shell.focus === 'function') shell.focus() } catch (_) {}
        return 'ok'
      } catch (_) { return 'unavailable' }
    }

    /* 用户把消息发出去以后，块就从输入框里消失了。这里盯着草稿：
     * 块一旦不在草稿里（回车发送、点发送按钮、或手动删掉整块），就把这批批注标成 sent_at，
     * 于是下一条批注的块里不会再带上它们。纯客户端探测，不依赖拦截回车，各种发送路径都能覆盖。 */
    var blockIdsRef = []
    var draftWatchTimer = null

    function stopWatchingDraft() {
      blockIdsRef = []
      if (draftWatchTimer) { clearInterval(draftWatchTimer); draftWatchTimer = null }
    }

    function watchDraftSent(ids) {
      blockIdsRef = ids || []
      if (draftWatchTimer || !blockIdsRef.length) return
      draftWatchTimer = setInterval(function () {
        var shell = null
        try { shell = composerShell() } catch (_) { shell = null }
        if (!shell || !shell.state) return
        var draft = ''
        try { draft = (shell.state.getSnapshot() || {}).draft || '' } catch (_) { return }
        if (draft.indexOf(ANNO_HEAD) >= 0) return          // 块还在输入框里，没发出去
        var ids2 = blockIdsRef.slice()
        stopWatchingDraft()
        var sid = currentSessionId()
        if (!sid || !ids2.length) return
        apiPost(API.snote, { sessionId: sid, action: 'sent', ids: ids2 }).then(function () {
          try { window.dispatchEvent(new CustomEvent('dsh-doc-review:snotes')) } catch (e) {}
        }).catch(function () {})
      }, 1500)
    }

    /* 当前会话 id：apply 与各组件共用。
     * 2026-10-11 修 v0.5.0 启动崩溃：这个函数原先只定义在 DocReviewView 内部，
     * apply 里 `apiPost(API.hello, { sessionId: currentSessionId() })` 够不到它，
     * 抛 ReferenceError ⇒ 客户端条目 failed ⇒ 整个 web boot 失败（DSH 连崩三次后
     * 用安全模式重写了 profile 配置）。提到 factory 作用域后两处都能用。 */
    function currentSessionId() {
      try {
        if (!sessions || !sessions.list) return ''
        var snap = sessions.list.getSnapshot()
        if (!snap) return ''
        if (snap.current) return String(snap.current)
        var ids = (snap.ids && snap.ids.length) ? snap.ids : Object.keys(snap.byId || {})
        var best = '', bestAt = -1
        for (var i = 0; i < ids.length; i++) {
          var row = snap.byId && snap.byId[ids[i]]
          if (!row || !row.retainedBy || !(row.retainedBy.mainView > 0)) continue
          var at = Number(row.updatedAt) || 0
          if (at > bestAt) { bestAt = at; best = String(ids[i]) }
        }
        return best
      } catch (e) { return '' }
    }

    /* ────────────────────────── 基础工具 ────────────────────────── */

    function apiGet(u, params) {
      var qs = ''
      if (params) {
        var parts = []
        Object.keys(params).forEach(function (k) {
          if (params[k] !== undefined && params[k] !== null && params[k] !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
        })
        if (parts.length) qs = '?' + parts.join('&')
      }
      return fetch(u + qs, { credentials: 'same-origin' }).then(function (r) { return r.json() })
    }

    function apiPost(u, body) {
      return fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json() })
    }

    function uuid() {
      try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID() } catch (e) {}
      return 'dr-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }

    function tz() {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined } catch (e) { return undefined }
    }

    function dirnameOf(p) {
      var i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
      return i < 0 ? '' : p.slice(0, i)
    }

    function basenameOf(p) {
      var i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
      return i < 0 ? p : p.slice(i + 1)
    }

    function reviewPathOf(p) {
      return dirnameOf(p) + '\\.dsh-review\\' + basenameOf(p) + '.review.json'
    }

    function nowStamp() {
      var d = new Date()
      var p = function (n) { return String(n).padStart(2, '0') }
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }

    /** 划词弹框的落点：默认贴选区**上方**（下沿离选区上沿 GAP），上方不够放才落到下方；
     *  横向与选区左沿对齐并夹在视口内。核心诉求是绝不压住选中的文字。
     *  抽成纯函数是为了能被烟测直接断言（界面没法自动点）。 */
    function floatPlacement(rect, vw, vh) {
      var BOX_W = 280, GAP = 10, NEED_ABOVE = 170
      var left = Math.min(Math.max(rect.left, 8), Math.max(8, vw - BOX_W - 8))
      if (rect.top > NEED_ABOVE) {
        return { above: true, left: left, bottom: Math.max(8, vh - rect.top + GAP), top: null }
      }
      return { above: false, left: left, top: Math.min(rect.bottom + GAP, Math.max(8, vh - 140)), bottom: null }
    }

    /** 列表里显示相对时间：今天 16:20 / 昨天 09:05 / 08-29 14:00 / 2026-05-11 */
    function relTime(ms) {
      if (!ms) return ''
      var d = new Date(ms), now = new Date()
      var p = function (n) { return String(n).padStart(2, '0') }
      var hm = p(d.getHours()) + ':' + p(d.getMinutes())
      var same = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() }
      if (same(d, now)) return '今天 ' + hm
      if (same(d, new Date(now.getTime() - 86400000))) return '昨天 ' + hm
      if (d.getFullYear() === now.getFullYear()) return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hm
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }

    function newId() { return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6) }

    /* ─────────────── Feishu-style comment helpers (pure; covered by test/client-helpers.mjs) ─────────────── */

    /** Platform sniff: Mac shows ⌘, everything else Ctrl. */
    function isMacPlatform(nav) {
      if (!nav) return false
      var p = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || ''
      return /mac|iphone|ipad|ipod/i.test(String(p))
    }

    /** 'Mod+Shift+M' → '⇧⌘M' on Mac (Apple modifier order), 'Ctrl+Shift+M' elsewhere. */
    function shortcutLabel(combo, mac) {
      var parts = String(combo || '').split('+').filter(Boolean)
      var key = parts.pop() || ''
      var mods = parts.map(function (m) { return m.toLowerCase() })
      if (!mac) {
        var names = { mod: 'Ctrl', ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' }
        return mods.map(function (m) { return names[m] || m }).concat([key]).join('+')
      }
      var sym = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' }
      var out = ''
      ;['ctrl', 'alt', 'shift', 'mod'].forEach(function (m) { if (mods.indexOf(m) >= 0) out += sym[m] })
      return out + key
    }

    /** Drop every whitespace char, remembering where each kept char came from. */
    function squeeze(s) {
      var out = '', map = []
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i)
        if (/\s/.test(ch)) continue
        out += ch; map.push(i)
      }
      return { text: out, map: map }
    }

    /** Quote written against Markdown source (agent tools) → the text the reader actually sees. */
    function plainQuote(q) {
      return String(q || '')
        .replace(/^\s*(#{1,6}|>|[-*+]|\d{1,3}[.)])\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*|__|`/g, '')
    }

    /** Find a saved quote inside rendered text: exact → whitespace-insensitive → Markdown-stripped.
     *  Returns { start, end } offsets into `text`, or null (the anchor is lost; never guess). */
    function locateQuote(text, quote) {
      text = String(text || ''); quote = String(quote || '')
      if (!text || !quote.trim()) return null
      var i = text.indexOf(quote)
      if (i >= 0) return { start: i, end: i + quote.length }
      var t = squeeze(text)
      var tries = [quote, plainQuote(quote)]
      for (var k = 0; k < tries.length; k++) {
        var q = squeeze(tries[k]).text
        if (!q) continue
        var j = t.text.indexOf(q)
        if (j >= 0) return { start: t.map[j], end: t.map[j + q.length - 1] + 1 }
      }
      return null
    }

    /** Flat text offset → { index, offset } across consecutive text-node lengths.
     *  preferEnd keeps an offset sitting on a node boundary inside the earlier node (Range end). */
    function offsetInNodes(lengths, offset, preferEnd) {
      if (!lengths || !lengths.length) return null
      var acc = 0
      for (var i = 0; i < lengths.length; i++) {
        var len = lengths[i]
        if (offset < acc + len || (preferEnd && offset === acc + len)) return { index: i, offset: offset - acc }
        acc += len
      }
      return { index: lengths.length - 1, offset: lengths[lengths.length - 1] }
    }

    /** Scroll delta that moves an item (viewport top + height) to `want`, kept inside [viewTop, viewBottom].
     *  Positive = scroll down. Used to line a card up with its anchor and vice versa. */
    function alignDelta(itemTop, itemHeight, want, viewTop, viewBottom) {
      var pad = 8
      var room = Math.max(0, viewBottom - viewTop - 2 * pad)
      var target = Math.max(viewTop + pad, Math.min(want, viewBottom - pad - Math.min(itemHeight, room)))
      return itemTop - target
    }

    /** Reply thread of a comment; legacy single `reply` only shows when `replies` is empty. */
    function threadOf(c) {
      var list = (c && Array.isArray(c.replies))
        ? c.replies.filter(function (r) { return r && String(r.text || '').trim() })
        : []
      if (list.length) return list
      if (c && c.reply) return [{ id: 'r_' + (c.id || 'x') + '_legacy', author: 'AI', role: 'agent', text: String(c.reply), createdAt: c.resolvedAt || '' }]
      return []
    }

    /** 'YYYY-MM-DD HH:mm' (nowStamp) or ISO → relTime; unparsable strings pass through. */
    function whenText(s) {
      if (!s) return ''
      var ms = typeof s === 'number' ? s : Date.parse(String(s).replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2'))
      return (isFinite(ms) && ms > 0) ? relTime(ms) : String(s)
    }

    var IS_MAC = isMacPlatform(typeof navigator !== 'undefined' ? navigator : null)
    function kbd(combo) { return shortcutLabel(combo, IS_MAC) }

    function reducedMotion() {
      try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch (e) { return false }
    }
    function scrollBehavior() { return reducedMotion() ? 'auto' : 'smooth' }

    function hlSupported() {
      return typeof Highlight !== 'undefined' && !!(window.CSS && CSS.highlights)
    }

    /* Text nodes of rendered blocks overlapping source lines [ls, le] (ls = 0 → whole doc).
       Inline proposal boxes are UI, not document text, so they are skipped. */
    function blockTextNodes(root, ls, le) {
      var out = []
      if (!root) return out
      var blocks = root.querySelectorAll('.dr-block[data-ls]')
      for (var i = 0; i < blocks.length; i++) {
        var s = Number(blocks[i].getAttribute('data-ls')), e = Number(blocks[i].getAttribute('data-le'))
        if (ls && (e < ls || s > le)) continue
        var w = document.createTreeWalker(blocks[i], NodeFilter.SHOW_TEXT, null)
        var n
        while ((n = w.nextNode())) {
          if (!n.nodeValue) continue
          var p = n.parentNode
          if (p && p.closest && p.closest('.dr-inline-prop')) continue
          out.push(n)
        }
      }
      return out
    }

    /** DOM Range covering exactly the quoted characters (lines first, then whole doc); null when lost. */
    function rangeForQuote(root, c) {
      if (!root || !c || !c.quote || c.anchored === false) return null
      var ls = Number(c.lineStart) || 0, le = Number(c.lineEnd) || ls
      var scopes = ls ? [[ls, le], [0, 0]] : [[0, 0]]
      for (var k = 0; k < scopes.length; k++) {
        var nodes = blockTextNodes(root, scopes[k][0], scopes[k][1])
        if (!nodes.length) continue
        var text = '', lens = []
        for (var i = 0; i < nodes.length; i++) { text += nodes[i].nodeValue; lens.push(nodes[i].nodeValue.length) }
        var hit = locateQuote(text, c.quote)
        if (!hit) continue
        var a = offsetInNodes(lens, hit.start, false), b = offsetInNodes(lens, hit.end, true)
        if (!a || !b) continue
        var r = document.createRange()
        r.setStart(nodes[a.index], a.offset)
        r.setEnd(nodes[b.index], b.offset)
        return r
      }
      return null
    }

    /* ────────────────────── 失锚重定位（锚点永远打在 .md 源文本上） ──────────────────────
     * 照 MRSF §7.4 四步：精确匹配 → 多命中按旧行号就近消歧 → 空白归一化再匹配 → 都失败标 orphan
     * 但**绝不静默删除**批注。重锚只改行列与 anchored 标记，selected_text（quote）永不改。
     */

    function offsetToLine(content, offset) {
      var n = 1
      var lim = Math.min(Math.max(offset, 0), content.length)
      for (var i = 0; i < lim; i++) if (content.charCodeAt(i) === 10) n++
      return n
    }

    function findAll(content, needle, cap) {
      var out = []
      if (!needle) return out
      var i = content.indexOf(needle)
      while (i >= 0 && out.length < cap) { out.push(i); i = content.indexOf(needle, i + 1) }
      return out
    }

    function nearestHit(hits, text, nearLine) {
      if (hits.length < 2 || !nearLine) return hits[0]
      var best = hits[0], bestD = Infinity
      for (var i = 0; i < hits.length; i++) {
        var d = Math.abs(offsetToLine(text, hits[i]) - nearLine)
        if (d < bestD) { bestD = d; best = hits[i] }
      }
      return best
    }

    function findAnchorLines(content, needle, nearLine) {
      if (!content || !needle) return null
      var hits = findAll(content, needle, 40)
      if (!hits.length) {
        // 空白归一化（Markdown 重排 / 换行调整后走到这里）
        var norm = '', map = [], prevSpace = false
        for (var k = 0; k < content.length; k++) {
          var ch = content.charAt(k)
          if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            if (!prevSpace) { norm += ' '; map.push(k); prevSpace = true }
            continue
          }
          norm += ch; map.push(k); prevSpace = false
        }
        var nn = String(needle).replace(/\s+/g, ' ').trim()
        if (!nn) return null
        var h2 = findAll(norm, nn, 40)
        if (!h2.length) return null
        var q = nearestHit(h2, norm, nearLine)
        return { start: offsetToLine(content, map[q]), end: offsetToLine(content, map[Math.min(q + nn.length - 1, map.length - 1)]) }
      }
      var p = nearestHit(hits, content, nearLine)
      return { start: offsetToLine(content, p), end: offsetToLine(content, p + needle.length - 1) }
    }

    function reanchorAll(comments, content) {
      if (!comments || !comments.length) return comments || []
      return comments.map(function (c) {
        var quote = c.quote || ''
        if (!quote) return c
        var hit = findAnchorLines(content, quote, Number(c.lineStart) || 0)
        if (!hit) return Object.assign({}, c, { anchored: false })
        return Object.assign({}, c, { lineStart: hit.start, lineEnd: hit.end, anchored: true })
      })
    }

    /* ────────────────────────── 极简 Markdown 渲染（带源码行号） ──────────────────────────
     * 每个块都带 data-ls / data-le（1 基行号），划词时用来把选区映射回源码行。
     * 只覆盖方案文档常用语法：标题 / 段落 / 列表 / 表格 / 引用 / 代码块 / 分割线 / 行内强调。
     */

    function parseBlocks(src) {
      var lines = String(src || '').split(/\r?\n/)
      var blocks = []
      var i = 0
      while (i < lines.length) {
        var raw = lines[i]
        if (!raw.trim()) { i++; continue }
        var start = i
        var b = null
        var fence = raw.match(/^\s*(```|~~~)(.*)$/)
        if (fence) {
          var marker = fence[1]
          var j = i + 1
          var closeRe = new RegExp('^\\s*' + marker + '\\s*$')
          while (j < lines.length && !closeRe.test(lines[j])) j++
          b = { type: 'code', text: lines.slice(i + 1, j).join('\n'), lang: (fence[2] || '').trim() }
          i = Math.min(j + 1, lines.length)
        } else if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(raw)) {
          b = { type: 'hr' }
          i++
        } else {
          var hm = raw.match(/^(#{1,6})\s+(.*)$/)
          if (hm) {
            b = { type: 'h', level: hm[1].length, text: hm[2] }
            i++
          } else if (/^\s*>/.test(raw)) {
            var qb = []
            var q = i
            while (q < lines.length && /^\s*>/.test(lines[q])) { qb.push(lines[q].replace(/^\s*>\s?/, '')); q++ }
            b = { type: 'quote', text: qb.join('\n') }
            i = q
          } else if (/^\s*([-*+]|\d{1,3}[.)])\s+/.test(raw)) {
            var items = []
            var k = i
            while (k < lines.length) {
              var lm = lines[k].match(/^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/)
              if (lm) { items.push({ text: lm[2], ordered: /\d/.test(lm[1]) }); k++; continue }
              if (items.length && lines[k].trim() && /^\s{2,}\S/.test(lines[k])) { items[items.length - 1].text += ' ' + lines[k].trim(); k++; continue }
              break
            }
            b = { type: 'list', items: items }
            i = k
          } else if (raw.indexOf('|') >= 0 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
            var rows = []
            var r = i
            while (r < lines.length && lines[r].indexOf('|') >= 0) { rows.push(lines[r]); r++ }
            b = { type: 'table', rows: rows }
            i = r
          } else {
            var pb = [raw]
            var p2 = i + 1
            while (p2 < lines.length && lines[p2].trim() &&
              !/^(#{1,6}\s|\s*>|\s*([-*+]|\d{1,3}[.)])\s)/.test(lines[p2]) &&
              !/^\s*(```|~~~)/.test(lines[p2])) { pb.push(lines[p2]); p2++ }
            b = { type: 'p', text: pb.join('\n') }
            i = p2
          }
        }
        b.ls = start + 1
        b.le = i
        blocks.push(b)
      }
      return blocks
    }

    function renderInline(text, keyPrefix) {
      var out = []
      var parts = String(text).split(/(`[^`]+`)/)
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i]
        if (/^`[^`]+`$/.test(p)) { out.push(h('code', { key: keyPrefix + '-c' + i }, p.slice(1, -1))); continue }
        var re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)]+\))/g
        var last = 0, m, n = 0
        while ((m = re.exec(p))) {
          if (m.index > last) out.push(p.slice(last, m.index))
          var tok = m[0]
          if (tok.slice(0, 2) === '**' || tok.slice(0, 2) === '__') out.push(h('strong', { key: keyPrefix + '-' + i + '-b' + (n++) }, tok.slice(2, -2)))
          else if (tok.charAt(0) === '[') {
            var mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
            out.push(h('a', { key: keyPrefix + '-' + i + '-a' + (n++), href: mm[2], target: '_blank', rel: 'noreferrer' }, mm[1]))
          } else out.push(h('em', { key: keyPrefix + '-' + i + '-i' + (n++) }, tok.slice(1, -1)))
          last = re.lastIndex
        }
        if (last < p.length) out.push(p.slice(last))
      }
      return out
    }

    function renderBlockBody(b, key) {
      if (b.type === 'h') return h('div', { className: 'dr-h dr-h' + b.level }, renderInline(b.text, key))
      if (b.type === 'hr') return h('hr', { className: 'dr-hr' })
      if (b.type === 'code') return h('pre', { className: 'dr-pre' }, h('code', null, b.text))
      if (b.type === 'quote') return h('blockquote', { className: 'dr-quote' }, renderInline(b.text, key))
      if (b.type === 'list') {
        var ordered = b.items.length && b.items[0].ordered
        return h(ordered ? 'ol' : 'ul', { className: 'dr-ul' }, b.items.map(function (it, i) { return h('li', { key: key + '-li' + i }, renderInline(it.text, key + '-li' + i)) }))
      }
      if (b.type === 'table') {
        var grid = b.rows.map(function (row) {
          return row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim() })
        })
        var head = grid[0] || []
        var body = grid.slice(1).filter(function (row) { return !row.every(function (c) { return /^:?-{2,}:?$/.test(c) || c === '' }) })
        return h('table', { className: 'dr-table' },
          h('thead', null, h('tr', null, head.map(function (c, i) { return h('th', { key: 'th' + i }, renderInline(c, key + '-th' + i)) }))),
          h('tbody', null, body.map(function (row, ri) {
            return h('tr', { key: 'tr' + ri }, row.map(function (c, ci) { return h('td', { key: 'td' + ci }, renderInline(c, key + '-td' + ri + '-' + ci)) }))
          })))
      }
      return h('p', { className: 'dr-p' }, renderInline(b.text, key))
    }

    /* ────────────────────────── 视图 ────────────────────────── */

    function DocReviewView() {
      var docPair = useState(null)          // { path, name, content, mtimeMs, hash, review }
      var doc = docPair[0], setDoc = docPair[1]
      var docsPair = useState([])
      var docs = docsPair[0], setDocs = docsPair[1]
      var collPair = useState(true)         // 左栏折叠
      var collapsed = collPair[0], setCollapsed = collPair[1]
      var errPair = useState('')
      var err = errPair[0], setErr = errPair[1]
      var msgPair = useState('')
      var msg = msgPair[0], setMsg = msgPair[1]
      var savePair = useState('')
      var saveState = savePair[0], setSaveState = savePair[1]
      var rootPair = useState('')
      var root = rootPair[0], setRoot = rootPair[1]
      var authorPair = useState('')
      var author = authorPair[0], setAuthor = authorPair[1]
      var qPair = useState('')
      var q = qPair[0], setQ = qPair[1]
      // 左栏排序：recent＝最近产出（默认）｜pending＝待处理优先。本机偏好，落 localStorage。
      var sortPair = useState(function () {
        try { return localStorage.getItem('dsh-doc-review.sort') === 'pending' ? 'pending' : 'recent' } catch (e) { return 'recent' }
      })
      var sortMode = sortPair[0], setSortMode = sortPair[1]
      var metaPair = useState(null)
      var meta = metaPair[0], setMeta = metaPair[1]
      var scopePair = useState(function () {
        try {
          var v = localStorage.getItem('dsh-doc-review.scope')
          if (v === 'session') return 'related'          // 旧值迁移
          return (v === 'workspace' || v === 'vault' || v === 'related') ? v : 'related'
        } catch (e) { return 'related' }
      })
      var scope = scopePair[0], setScope = scopePair[1]
      var loadingPair = useState(false)
      var loading = loadingPair[0], setLoading = loadingPair[1]
      var selPair = useState(null)          // { quote, ls, le, x, y }
      var sel = selPair[0], setSel = selPair[1]
      var draftPair = useState('')
      var draft = draftPair[0], setDraft = draftPair[1]
      var globalPair = useState('')
      var globalNote = globalPair[0], setGlobalNote = globalPair[1]
      var manualPair = useState('')
      var manual = manualPair[0], setManual = manualPair[1]
      var docRef = useRef(null)
      var saveTimer = useRef(null)
      var loadSeq = useRef(0)
      var snotePair = useState([])          // 本会话批注（在对话消息上划词写的）
      var snotes = snotePair[0], setSnotes = snotePair[1]
      var propPair = useState([])           // 待审改动提案（建议模式）
      var props = propPair[0], setProps = propPair[1]
      var rejectPair = useState('')
      var rejectReason = rejectPair[0], setRejectReason = rejectPair[1]
      // Feishu-style comment state: active card / resolved fold / in-place edit / reply drafts / rail markers
      var activePair = useState(null)
      var activeId = activePair[0], setActiveId = activePair[1]
      var foldPair = useState(false)
      var showResolved = foldPair[0], setShowResolved = foldPair[1]
      var editPair = useState(null)         // { id, text }
      var editing = editPair[0], setEditing = editPair[1]
      var replyPair = useState({})          // { [commentId]: draft }
      var replyDrafts = replyPair[0], setReplyDrafts = replyPair[1]
      var markerPair = useState([])         // [{ id, top (0..1), n }]
      var markers = markerPair[0], setMarkers = markerPair[1]
      var notesRef = useRef(null)
      var rangesRef = useRef({})            // commentId -> live DOM Range of its quote
      var activeRef = useRef(null)
      var hoverRef = useRef(null)
      var flashRef = useRef(null)
      var flashTimer = useRef(null)
      var hoverRaf = useRef(0)
      activeRef.current = activeId

      var comments = (doc && doc.review && doc.review.comments) ? doc.review.comments : []
      var pending = comments.filter(function (c) { return c.status === 'pending' })
      var resolvedCount = comments.length - pending.length
      var snotePending = snotes.filter(function (n) { return (n.status || 'pending') === 'pending' })
      var propPending = props.filter(function (c) { return (c.status || 'pending') === 'pending' })
      function pendingSpanFor(b) {
        for (var i = 0; i < propPending.length; i++) {
          var c = propPending[i]
          var ls = Number(c.line) || 0
          if (!ls) continue
          var le = ls + String(c.quote || '').split('\n').length - 1
          if (b.le >= ls && b.ls <= le) return c
        }
        return null
      }

      useEffect(function () { void boot() }, [])

      // 本会话批注：进页面拉一次，浮层里保存后再拉一次（自定义事件）
      useEffect(function () {
        void loadSnotes()
        var onNew = function () { void loadSnotes() }
        window.addEventListener('dsh-doc-review:snotes', onNew)
        return function () { window.removeEventListener('dsh-doc-review:snotes', onNew) }
      }, [])

      function loadSnotes() {
        var sid = currentSessionId()
        if (!sid) return Promise.resolve()
        return apiGet(API.snotes, { sessionId: sid }).then(function (r) {
          if (r && r.ok) setSnotes(r.notes || [])
        }).catch(function () {})
      }

      /** 把还没标「已发出」的待处理批注一次标掉：它们不再进批注块（仍在清单里，可退回） */
      function markAllSent() {
        var sid = currentSessionId()
        if (!sid) return
        var ids = snotes.filter(function (n) {
          return (n.status || 'pending') === 'pending' && !n.sent_at
        }).map(function (n) { return n.id })
        if (!ids.length) return
        apiPost(API.snote, { sessionId: sid, action: 'sent', ids: ids }).then(function (r) {
          if (r && r.ok) { setSnotes(r.notes || []); syncDraftToComposer(r.notes || []); setMsg('已把 ' + ids.length + ' 条标为「已发出」，不会再进批注块') }
        }).catch(function () {})
      }

      function snoteAction(id, action) {
        var sid = currentSessionId()
        if (!sid) return
        apiPost(API.snote, { sessionId: sid, id: id, action: action }).then(function (r) {
          if (r && r.ok) { setSnotes(r.notes || []); syncDraftToComposer(r.notes || []) }
        }).catch(function () {})
      }

      /* ── 建议模式：待审改动提案 ── */
      function loadProps() {
        if (!doc || !doc.path) { setProps([]); return Promise.resolve() }
        return apiGet(API.props, { path: doc.path, sessionId: currentSessionId() }).then(function (r) {
          if (r && r.ok) setProps(r.changes || [])
        }).catch(function () {})
      }

      function propDecide(action, ids) {
        if (!doc || !doc.path) return
        var isAccept = action === 'accept'
        apiPost(API.prop, {
          path: doc.path, action: action, ids: ids || [],
          reason: isAccept ? '' : rejectReason, sessionId: currentSessionId(),
        }).then(function (r) {
          if (!r || !r.ok) { setErr('处理待审改动失败：' + ((r && r.error) || '未知')); return }
          setRejectReason('')
          if (isAccept) {
            setMsg('已接受 ' + (r.accepted || 0) + ' 条改动并写入文档' + ((r.missed && r.missed.length) ? '；' + r.missed.length + ' 条原文对不上、没写' : ''))
            void loadProps()
            void openDoc(doc.path)
          } else {
            setMsg('已拒绝 ' + (r.rejected || 0) + ' 条改动（文件没动）')
            void loadProps()
          }
        }).catch(function (e) { setErr('处理失败：' + ((e && e.message) || e)) })
      }

      function sendSnotesToAgent() {
        var todo = snotes.filter(function (n) { return (n.status || 'pending') === 'pending' })
        if (!todo.length) return
        var lines = ['我在对话里给你留了 ' + todo.length + ' 条批注（不是文档批注，是针对我们刚才对话内容的意见），请逐条回应/修正：', '']
        todo.forEach(function (n, i) {
          lines.push('[' + (i + 1) + '] 我说的原文：' + String(n.quote || '').replace(/\s+/g, ' ').slice(0, 300))
          lines.push('    我的意见：' + (n.note || ''))
          lines.push('    （id: ' + n.id + '）')
          lines.push('')
        })
        lines.push('处理完请调用 session_note_resolve 把这 ' + todo.length + ' 条标为已处理，并回填一句你改了什么。')
        var prompt = lines.join('\n')
        var sid = currentSessionId()
        if (!remoteFace || !remoteFace.session || typeof remoteFace.session.prompt !== 'function' || !sid) {
          copyToClipboard(prompt)
          setMsg('拿不到会话或 remote 面，指令已复制到剪贴板。')
          return
        }
        remoteFace.session.prompt({
          requestId: uuid(), sessionId: sid, mode: 'queue',
          content: [{ type: 'text', text: prompt }], clientTimeZone: tz(),
        }).then(function () {
          setMsg('已把 ' + todo.length + ' 条会话批注发给 AI。')
        }).catch(function (e) {
          copyToClipboard(prompt)
          setMsg('发送失败（' + ((e && e.message) || e) + '），已复制到剪贴板。')
        })
      }

      useEffect(function () {
        var onScroll = function () { if (sel) setSel(null) }
        window.addEventListener('scroll', onScroll, true)
        return function () { window.removeEventListener('scroll', onScroll, true) }
      }, [sel])

      // 弹框关掉（保存 / 取消 / 滚走）就把选区高亮撤掉
      useEffect(function () { if (!sel) dropHighlight() }, [sel])

      // 打开哪篇文档，就拉哪篇的待审改动提案
      useEffect(function () { void loadProps() }, [doc && doc.path])

      // Ctrl/Cmd+Shift+M：把焦点送回批注框（对齐 Notion 与 Google Docs 的"给选中内容加评论"快捷键）
      useEffect(function () {
        function onKey(e) {
          if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return
          if (String(e.key || '').toLowerCase() !== 'm') return
          var ta = document.querySelector('.dr-float-input')
          if (!ta) return
          e.preventDefault()
          try { ta.focus() } catch (_) {}
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [])

      function boot() {
        apiPost(API.hello, {}).catch(function () {})
        apiGet(API.state).then(function (st) {
          if (!st || !st.ok) { setErr('宿主半边没应答：' + JSON.stringify(st)); return }
          if (st.author) setAuthor(st.author)
          var ws = st.roots && st.roots[0] ? st.roots[0] : ''
          setRoot(ws)
          void loadDocs(ws, '')
          if (st.lastDoc) void openDoc(st.lastDoc)
        }).catch(function (e) { setErr('读取插件状态失败：' + e.message) })
      }

      function loadDocs(ws, keyword, force) {
        setLoading(true)
        return apiGet(API.docs, { ws: ws, q: keyword, refresh: force ? '1' : '', scope: scope, sessionId: currentSessionId() }).then(function (d) {
          setLoading(false)
          if (!d || !d.ok) { setErr((d && d.error) || '列文档失败'); return }
          setDocs(d.docs || [])
          setMeta({
            total: d.total || 0, scanned: d.scanned || 0, scanMs: d.scanMs || 0,
            scopeUsed: d.scopeUsed || scope, fallback: !!d.fallback, reason: d.reason || '',
            cwd: d.cwd || '', root: d.root || '',
          })
        }).catch(function (e) { setLoading(false); setErr('列文档失败：' + e.message) })
      }

      function openDoc(p) {
        var my = ++loadSeq.current
        setErr('')
        setMsg('')
        setSel(null)
        return apiGet(API.doc, { path: p, sessionId: currentSessionId() }).then(function (d) {
          if (my !== loadSeq.current) return
          if (!d || !d.ok) { setErr((d && d.error) || ('打开失败：' + p)); return }
          var before = (d.review && d.review.comments) || []
          var after = reanchorAll(before, d.content)
          if (d.review) d.review.comments = after
          setDoc(d)
          var changed = after.some(function (c, i) {
            var o = before[i] || {}
            return Number(o.lineStart) !== Number(c.lineStart) || Number(o.lineEnd) !== Number(c.lineEnd) || (o.anchored === false) !== (c.anchored === false)
          })
          if (changed) persistAnchors(d.path, after)
        }).catch(function (e) { setErr('打开文档失败：' + e.message) })
      }

      /** 写回批注（整体覆盖 + 防抖 500ms） */
      function persist(nextComments, immediate) {
        if (!doc) return
        setDoc(function (cur) { return cur ? Object.assign({}, cur, { review: Object.assign({}, cur.review, { comments: nextComments }) }) : cur })
        fireSave(doc.path, nextComments, immediate)
      }

      /** 重锚结果落盘：打开文档那一刻跑一次（只在行列/失锚状态真的变了时才调） */
      function persistAnchors(docPath, nextComments) {
        setDoc(function (cur) { return (cur && cur.path === docPath) ? Object.assign({}, cur, { review: Object.assign({}, cur.review, { comments: nextComments }) }) : cur })
        fireSave(docPath, nextComments, true)
      }

      function fireSave(docPath, nextComments, immediate) {
        setSaveState('保存中…')
        var snapshot = { path: docPath, comments: nextComments, sessionId: currentSessionId() }
        var fire = function () {
          apiPost(API.save, snapshot).then(function (r) {
            if (!r || !r.ok) { setSaveState('保存失败'); setErr((r && r.error) || '保存失败'); return }
            setSaveState('已保存 ' + nowStamp().slice(11))
            setDoc(function (cur) { return (cur && cur.path === r.review.doc) ? Object.assign({}, cur, { review: r.review, hash: r.hash, mtimeMs: r.mtimeMs }) : cur })
            void loadDocs(root, q)
          }).catch(function (e) { setSaveState('保存失败'); setErr('保存失败：' + e.message) })
        }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        if (immediate) fire()
        else saveTimer.current = setTimeout(fire, 500)
      }

      function addComment(quote, ls, le, note) {
        var c = {
          id: newId(), createdAt: nowStamp(), updatedAt: nowStamp(), author: author,
          lineStart: ls || 0, lineEnd: le || ls || 0, quote: quote || '', note: note || '',
          status: 'pending', reply: '', resolvedAt: null,
        }
        persist(comments.concat([c]), true)
        return c
      }

      function patchComment(id, patch, immediate) {
        persist(comments.map(function (c) { return c.id === id ? Object.assign({}, c, patch, { updatedAt: nowStamp() }) : c }), immediate)
      }

      function removeComment(id) {
        if (activeRef.current === id) setActiveId(null)
        persist(comments.filter(function (c) { return c.id !== id }), true)
      }

      /* ── Reply thread / in-place edit ── */
      function addReply(c) {
        var text = String(replyDrafts[c.id] || '').trim()
        if (!text) return
        // Seed with the visible thread so a legacy single `reply` is not hidden by the first new reply.
        var base = threadOf(c).slice()
        var r = { id: 'r_' + newId().slice(2), author: author || '我', role: 'user', text: text, createdAt: nowStamp() }
        patchComment(c.id, { replies: base.concat([r]) }, true)
        setReplyDrafts(function (cur) { var n = Object.assign({}, cur); delete n[c.id]; return n })
      }

      function saveEdit() {
        if (!editing) return
        var text = String(editing.text || '').trim()
        if (!text) return
        patchComment(editing.id, { note: text }, true)
        setEditing(null)
      }

      /* ── Anchors: precise highlight, hover, flash, rail markers ── */
      function paintAnchors() {
        if (!hlSupported()) return
        try {
          var base = [], hot = []
          var map = rangesRef.current
          var fl = flashRef.current
          Object.keys(map).forEach(function (id) {
            var r = map[id]
            if (fl && fl.id === id) { (fl.on ? hot : base).push(r); return }
            if (id === activeRef.current || id === hoverRef.current) hot.push(r)
            else base.push(r)
          })
          var hb = new Highlight(); base.forEach(function (r) { hb.add(r) })
          var hh = new Highlight(); hot.forEach(function (r) { hh.add(r) })
          hh.priority = 1
          CSS.highlights.set('dr-anchor', hb)
          CSS.highlights.set('dr-anchor-active', hh)
        } catch (e) {}
      }

      function clearAnchors() {
        try { if (window.CSS && CSS.highlights) { CSS.highlights.delete('dr-anchor'); CSS.highlights.delete('dr-anchor-active') } } catch (e) {}
      }

      function measureMarkers() {
        var sc = docRef.current
        if (!sc) { setMarkers(function (cur) { return cur.length ? [] : cur }); return }
        var top0 = sc.getBoundingClientRect().top - sc.scrollTop
        var H = Math.max(1, sc.scrollHeight)
        var next = []
        comments.forEach(function (c, i) {
          var r = rangesRef.current[c.id]
          if (!r) return
          var rc = r.getBoundingClientRect()
          if (!rc || (!rc.width && !rc.height)) return
          next.push({ id: c.id, n: i + 1, top: Math.min(1, Math.max(0, (rc.top - top0) / H)), title: markTitle(c, i + 1) })
        })
        setMarkers(function (cur) {
          var same = cur.length === next.length && cur.every(function (m, k) { return m.id === next[k].id && Math.abs(m.top - next[k].top) < 0.002 && m.title === next[k].title })
          return same ? cur : next
        })
      }

      // Rebuild quote ranges after every content/comment change (pending + anchored only).
      useEffect(function () {
        var root = docRef.current
        var map = {}
        if (root) {
          comments.forEach(function (c) {
            if ((c.status || 'pending') !== 'pending' || c.anchored === false) return
            var r = null
            try { r = rangeForQuote(root, c) } catch (e) { r = null }
            if (r) map[c.id] = r
          })
        }
        rangesRef.current = map
        paintAnchors()
        measureMarkers()
      }, [doc && doc.path, doc && doc.content, comments, propPending.length])

      useEffect(function () { paintAnchors() }, [activeId])

      // Keep rail markers honest when the column resizes (window resize, sidebar fold).
      useEffect(function () {
        var sc = docRef.current
        if (!sc || typeof ResizeObserver === 'undefined') return undefined
        var ro = new ResizeObserver(function () { measureMarkers() })
        ro.observe(sc)
        return function () { ro.disconnect() }
      }, [doc && doc.path, comments])

      useEffect(function () {
        return function () {
          clearAnchors()
          if (flashTimer.current) clearTimeout(flashTimer.current)
          if (hoverRaf.current) cancelAnimationFrame(hoverRaf.current)
        }
      }, [])

      function hitAnchor(x, y) {
        var map = rangesRef.current
        var ids = Object.keys(map)
        if (activeRef.current && map[activeRef.current]) ids.unshift(activeRef.current)
        for (var i = 0; i < ids.length; i++) {
          var rects = map[ids[i]].getClientRects()
          for (var k = 0; k < rects.length; k++) {
            var b = rects[k]
            if (x >= b.left - 1 && x <= b.right + 1 && y >= b.top - 1 && y <= b.bottom + 1) return ids[i]
          }
        }
        return null
      }

      function setHover(id) {
        if (hoverRef.current === id) return
        hoverRef.current = id
        var sc = docRef.current
        if (sc) sc.classList.toggle('dr-doc-hot', !!id && !!rangesRef.current[id])
        paintAnchors()
      }

      function onDocMouseMove(e) {
        var x = e.clientX, y = e.clientY
        if (hoverRaf.current) return
        hoverRaf.current = requestAnimationFrame(function () {
          hoverRaf.current = 0
          setHover(hitAnchor(x, y))
        })
      }

      function onDocClick(e) {
        var s = window.getSelection && window.getSelection()
        if (s && !s.isCollapsed) return               // a drag-select, not a click
        if (e.target && e.target.closest && e.target.closest('button,a,.dr-inline-prop')) return
        var id = hitAnchor(e.clientX, e.clientY)
        if (id) activate(id, 'doc')
        else if (activeRef.current) setActiveId(null)
      }

      function flashAnchor(id) {
        if (flashTimer.current) clearTimeout(flashTimer.current)
        flashRef.current = null
        if (reducedMotion() || !rangesRef.current[id]) { paintAnchors(); return }
        var steps = [false, true, false, true]
        var i = 0
        var tick = function () {
          if (i >= steps.length) { flashRef.current = null; flashTimer.current = null; paintAnchors(); return }
          flashRef.current = { id: id, on: steps[i++] }
          paintAnchors()
          flashTimer.current = setTimeout(tick, 150)
        }
        flashTimer.current = setTimeout(tick, 220)    // let the smooth scroll land first
      }

      /** Activate a comment from the doc body, its card, or the rail; align card and anchor (best effort). */
      function activate(id, from) {
        setActiveId(id)
        activeRef.current = id
        paintAnchors()
        var c = null
        for (var k = 0; k < comments.length; k++) if (comments[k].id === id) c = comments[k]
        if (c && (c.status || 'pending') !== 'pending') setShowResolved(true)
        requestAnimationFrame(function () {
          try {
            var sc = docRef.current, ns = notesRef.current
            var card = ns ? ns.querySelector('[data-cid="' + id + '"]') : null
            var range = rangesRef.current[id]
            var behavior = scrollBehavior()
            if (!range) {
              if (from !== 'doc' && c && c.anchored !== false) scrollToLine(c.lineStart)
              if (card && from !== 'card') card.scrollIntoView({ block: 'nearest', behavior: behavior })
              return
            }
            var a = range.getBoundingClientRect()
            var D = sc.getBoundingClientRect()
            var cr = card ? card.getBoundingClientRect() : null
            var N = ns ? ns.getBoundingClientRect() : null
            var anchorTop = a.top
            if (from !== 'doc') {
              var want = (from === 'card' && cr) ? cr.top : D.top + D.height / 3
              var dd = alignDelta(a.top, a.height, want, D.top, D.bottom)
              if (Math.abs(dd) > 1) sc.scrollBy({ top: dd, behavior: behavior })
              anchorTop = a.top - dd
              flashAnchor(id)
            }
            if (from !== 'card' && cr && N) {
              var cd = alignDelta(cr.top, cr.height, anchorTop, N.top, N.bottom)
              if (Math.abs(cd) > 1) ns.scrollBy({ top: cd, behavior: behavior })
            }
          } catch (e) {}
        })
      }

      /* 划词 → 记录选区并映射源码行 */
      function onMouseUp() {
        try {
          var s = window.getSelection()
          if (!s || s.isCollapsed) { setSel(null); return }
          var text = String(s.toString() || '').trim()
          if (!text) { setSel(null); return }
          var range = s.getRangeAt(0)
          var el1 = blockOf(range.startContainer)
          var el2 = blockOf(range.endContainer) || el1
          if (!el1) { setSel(null); return }
          var ls = Number(el1.getAttribute('data-ls')) || 0
          var le = Number((el2 || el1).getAttribute('data-le')) || ls
          var rect = range.getBoundingClientRect()
          tapHighlight(range)
          var place = floatPlacement(rect, window.innerWidth || 900, window.innerHeight || 700)
          setSel({
            quote: text.length > 1200 ? text.slice(0, 1200) : text,
            ls: ls, le: le, left: place.left, above: place.above, top: place.top, bottom: place.bottom,
          })
          setDraft('')
        } catch (e) { setSel(null) }
      }

      function blockOf(node) {
        var el = node && node.nodeType === 3 ? node.parentNode : node
        while (el && el.getAttribute) {
          if (el.getAttribute('data-ls') !== null) return el
          el = el.parentNode
        }
        return null
      }

      /* 待批注的选区高亮：弹框抢走焦点后浏览器原生选区会变淡，用 CSS Custom Highlight 把它钉住，
         这样"我到底选了哪段"始终看得见（Chrome 105+，拿不到就静默跳过）。 */
      var HL_NAME = 'dr-pending'
      function tapHighlight(range) {
        try {
          if (typeof Highlight === 'undefined' || !window.CSS || !CSS.highlights) return
          CSS.highlights.set(HL_NAME, new Highlight(range.cloneRange()))
        } catch (e) {}
      }
      function dropHighlight() {
        try { if (window.CSS && CSS.highlights) CSS.highlights.delete(HL_NAME) } catch (e) {}
      }

      function commitSelection() {
        if (!sel || !draft.trim()) return
        addComment(sel.quote, sel.ls, sel.le, draft.trim())
        setSel(null)
        setDraft('')
      }

      function buildAgentPrompt() {
        if (!doc) return ''
        var L = []
        L.push('请按批注改这份文档：' + doc.path)
        L.push('批注文件：' + reviewPathOf(doc.path) + '（也可调用 doc_review_list 工具，doc 传上面的路径）')
        L.push('待处理批注 ' + pending.length + ' 条：')
        pending.forEach(function (c, i) {
          var head = c.lineStart ? ('L' + c.lineStart + (c.lineEnd && c.lineEnd !== c.lineStart ? '–L' + c.lineEnd : '')) : '全文'
          L.push((i + 1) + '. [' + c.id + '] ' + head + ' 意见：' + (c.note || '（空）'))
          if (c.quote) L.push('   原文：' + c.quote.replace(/\s+/g, ' ').slice(0, 140))
        })
        if (globalNote.trim()) L.push('整篇意见：' + globalNote.trim())
        L.push('要求：只改批注指向的位置，其余内容不动，保持一次成型的写法；改完调用 doc_review_resolve 把对应 id 标记为已处理，reply 里一句话说明改了什么。')
        return L.join('\n')
      }

      function currentSessionId() {
        try {
          if (!sessions || !sessions.list) return ''
          var snap = sessions.list.getSnapshot()
          if (!snap) return ''
          if (snap.current) return String(snap.current)
          var ids = (snap.ids && snap.ids.length) ? snap.ids : Object.keys(snap.byId || {})
          var best = '', bestAt = -1
          for (var i = 0; i < ids.length; i++) {
            var row = snap.byId && snap.byId[ids[i]]
            if (!row || !row.retainedBy || !(row.retainedBy.mainView > 0)) continue
            var at = Number(row.updatedAt) || 0
            if (at > bestAt) { bestAt = at; best = String(ids[i]) }
          }
          return best
        } catch (e) { return '' }
      }

      function sendToAgent() {
        var prompt = buildAgentPrompt()
        if (!prompt) return
        var sid = currentSessionId()
        if (!remoteFace || !remoteFace.session || typeof remoteFace.session.prompt !== 'function' || !sid) {
          copyToClipboard(prompt)
          setMsg('当前会话 id 或 remote 面不可用，已把指令复制到剪贴板，粘到输入框发送即可。')
          return
        }
        remoteFace.session.prompt({
          requestId: uuid(), sessionId: sid, mode: 'queue',
          content: [{ type: 'text', text: prompt }], clientTimeZone: tz(),
        }).then(function () {
          setMsg('已发给 AI（' + pending.length + ' 条批注）。切到对话页看它逐条改，改完这里会自动变「已处理」。')
        }).catch(function (e) {
          copyToClipboard(prompt)
          setMsg('发送失败（' + ((e && e.message) || e) + '），已复制到剪贴板。')
        })
      }

      function copyToClipboard(text) {
        try { navigator.clipboard.writeText(text) } catch (e) {}
      }

      /* Line → pending comment index. Only used as a fallback block tint when the
         CSS Custom Highlight API is missing; resolved / lost anchors never tint. */
      var HL_OK = hlSupported()
      var byLine = useMemo(function () {
        var map = {}
        if (HL_OK) return map
        comments.forEach(function (c, i) {
          if (!c.lineStart || c.anchored === false) return
          if ((c.status || 'pending') !== 'pending') return
          for (var l = c.lineStart; l <= (c.lineEnd || c.lineStart); l++) {
            if (!map[l]) map[l] = []
            map[l].push(i)
          }
        })
        return map
      }, [doc && doc.path, comments, HL_OK])

      /** 左栏可见顺序：默认最近产出在前；切到「待处理」时待处理条数优先，再看时间 */
      var visibleDocs = useMemo(function () {
        // 分层优先：本会话产出的文档永远排在前面，本项目其它会话碰过的排后面；层内才按时间/待处理排。
        // 层内时间用 host 给的 seenMs（会话里最后一次动它的时间）优先，没有才用文件 mtime。
        var rank = function (d) { return d.tier === 'project' ? 1 : 0 }
        // 第一层用「会话里最后一次动它的时间」，第二层用文件改动时间——与显示的、与 host 的口径一致
        var when = function (d) { return d.tier === 'project' ? d.mtimeMs : (d.seenMs || d.mtimeMs) }
        var arr = docs.slice()
        arr.sort(function (a, b) {
          var r = rank(a) - rank(b)
          if (r) return r
          if (sortMode === 'pending') return ((b.pending || 0) - (a.pending || 0)) || (when(b) - when(a))
          return when(b) - when(a)
        })
        return arr
      }, [docs, sortMode])

      var tierCounts = useMemo(function () {
        var s = 0, p = 0
        visibleDocs.forEach(function (d) { if (d.tier === 'project') p++; else s++ })
        return { session: s, project: p }
      }, [visibleDocs])

      var blocks = useMemo(function () { return doc ? parseBlocks(doc.content) : [] }, [doc && doc.path, doc && doc.content])

      function marksFor(b) {
        var set = []
        for (var l = b.ls; l <= b.le; l++) {
          var arr = byLine[l]
          if (!arr) continue
          for (var i = 0; i < arr.length; i++) if (set.indexOf(arr[i]) < 0) set.push(arr[i])
        }
        return set
      }

      function stopKeys(e) { return !!(e.nativeEvent && e.nativeEvent.isComposing) }

      function renderCard(c, i) {
        var head = c.lineStart ? ('L' + c.lineStart + (c.lineEnd && c.lineEnd !== c.lineStart ? '–L' + c.lineEnd : '')) : '全文'
        var st = c.status || 'pending'
        var isEditing = editing && editing.id === c.id
        var mine = !c.author || !author || c.author === author
        var thread = threadOf(c)
        var rd = replyDrafts[c.id] || ''
        return h('div', {
          key: c.id, 'data-cid': c.id,
          className: 'dr-card dr-card-' + st + (activeId === c.id ? ' dr-card-active' : ''),
          onClick: function (e) {
            if (e.target && e.target.closest && e.target.closest('button,input,textarea,a')) return
            activate(c.id, 'card')
          },
        },
          h('div', { className: 'dr-card-head' },
            h('span', { className: 'dr-card-no' }, '#' + (i + 1)),
            h('span', { className: 'dr-card-loc' }, head),
            c.author ? h('span', { className: 'dr-card-author' }, c.author) : null,
            c.anchored === false ? h('span', { className: 'dr-status dr-status-orphan', title: '这段原文在文档里已经找不到（被改掉或删掉）。批注按规范保留不删，请人工确认。' }, '已失锚') : null,
            h('span', { className: 'dr-spacer' }),
            h('span', { className: 'dr-status dr-status-' + st }, st === 'pending' ? '待处理' : (st === 'resolved' ? '已处理' : '不改'))),
          c.quote ? h('div', { className: 'dr-card-quote', title: c.quote }, c.quote) : null,
          isEditing
            ? h('div', { className: 'dr-edit' },
              h('textarea', {
                className: 'dr-textarea', rows: 3, autoFocus: true, value: editing.text,
                placeholder: '修改意见（' + kbd('Mod+Enter') + ' 保存）',
                onChange: function (e) { setEditing({ id: c.id, text: e.target.value }) },
                onKeyDown: function (e) {
                  if (stopKeys(e)) return
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit() }
                  if (e.key === 'Escape') setEditing(null)
                },
              }),
              h('div', { className: 'dr-card-actions' },
                h('span', { className: 'dr-spacer' }),
                h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { setEditing(null) } }, '取消'),
                h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', disabled: !String(editing.text || '').trim(), title: kbd('Mod+Enter'), onClick: saveEdit }, '保存')))
            : h('div', { className: 'dr-card-note' }, c.note || h('span', { className: 'dr-hint' }, '（未写意见）')),
          thread.length ? h('div', { className: 'dr-thread' },
            thread.map(function (r) {
              var ai = r.role === 'agent'
              return h('div', { key: r.id, className: 'dr-reply' + (ai ? ' dr-reply-ai' : '') },
                h('div', { className: 'dr-reply-head' },
                  ai ? h('span', { className: 'dr-reply-tag' }, 'AI') : null,
                  h('span', { className: 'dr-reply-who' }, ai ? (r.author && r.author !== 'AI' ? r.author : '') : (r.author || '我')),
                  h('span', { className: 'dr-hint' }, whenText(r.createdAt))),
                h('div', { className: 'dr-reply-text' }, r.text))
            })) : null,
          h('input', {
            className: 'dr-input dr-reply-input', value: rd,
            placeholder: '回复…（回车发送）', title: '回车或 ' + kbd('Mod+Enter') + ' 发送',
            onChange: function (e) { var v = e.target.value; setReplyDrafts(function (cur) { var n = Object.assign({}, cur); n[c.id] = v; return n }) },
            onKeyDown: function (e) {
              if (stopKeys(e)) return
              if (e.key === 'Enter') { e.preventDefault(); addReply(c) }
              if (e.key === 'Escape') setReplyDrafts(function (cur) { var n = Object.assign({}, cur); delete n[c.id]; return n })
            },
          }),
          h('div', { className: 'dr-card-actions' },
            st === 'pending'
              ? h('button', { className: 'dr-btn dr-btn-mini', onClick: function () { patchComment(c.id, { status: 'resolved', resolvedAt: nowStamp() }, true) } }, '标为已处理')
              : h('button', { className: 'dr-btn dr-btn-mini', onClick: function () { patchComment(c.id, { status: 'pending', resolvedAt: null }, true) } }, '退回待处理'),
            (mine && !isEditing) ? h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { setEditing({ id: c.id, text: c.note || '' }) } }, '编辑') : null,
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { copyToClipboard('[' + c.id + '] ' + head + '\n原文：' + c.quote + '\n意见：' + c.note); setMsg('已复制。') } }, '复制'),
            h('span', { className: 'dr-spacer' }),
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', title: '删除', 'aria-label': '删除', onClick: function () { removeComment(c.id) } }, '✕')))
      }

      var stale = doc && doc.review && doc.review.docHash && doc.hash && doc.review.docHash !== doc.hash

      return h('div', { className: 'dr-root' },
        /* 左：文档列表 */
        h('div', { className: 'dr-col dr-col-docs' },
          h('div', { className: 'dr-row' },
            h('strong', null, '批注'),
            h('span', { className: 'dr-spacer' }),
            h('button', {
              className: 'dr-btn dr-btn-mini dr-btn-on',
              title: SCOPE_TITLE[scope],
              onClick: function () {
                var to = SCOPE_ORDER[(SCOPE_ORDER.indexOf(scope) + 1) % SCOPE_ORDER.length]
                setScope(to)
                try { localStorage.setItem('dsh-doc-review.scope', to) } catch (eS) {}
                void loadDocs(root, q, true)
              },
            }, SCOPE_LABEL[scope]),
            h('button', {
              className: 'dr-btn dr-btn-mini' + (sortMode === 'pending' ? '' : ' dr-btn-on'),
              title: sortMode === 'recent' ? '当前：按最近产出排序。点一下改成「待处理优先」' : '当前：待处理优先。点一下改成「按最近产出」',
              onClick: function () {
                var to = sortMode === 'recent' ? 'pending' : 'recent'
                setSortMode(to)
                try { localStorage.setItem('dsh-doc-review.sort', to) } catch (eS) {}
              },
            }, sortMode === 'recent' ? '最新' : '待处理'),
            h('button', { className: 'dr-btn dr-btn-ghost', title: '重扫并刷新列表', onClick: function () { void loadDocs(root, q, true) } }, '⟳')),
          h('input', {
            className: 'dr-input', placeholder: '搜索文档名…', value: q,
            onChange: function (e) { setQ(e.target.value); void loadDocs(root, e.target.value) },
          }),
          h('div', { className: 'dr-hint', title: (meta && meta.cwd) || root },
            (meta
              ? (SCOPE_LABEL[meta.scopeUsed] || '') + ' · ' + (meta.total == null ? (visibleDocs.length || 0) : meta.total) + ' 篇'
                + (meta.scopeUsed === 'related' && (meta.tier1 || meta.tier2)
                  ? '（本会话 ' + (meta.tier1 || 0) + ' · 本项目 ' + (meta.tier2 || 0) + '）' : '')
                + (meta.searched === 'project' ? '（搜索：项目文件夹全量）' : '')
                + (meta.fallback ? '（' + (meta.reason || '自动放宽到工作区') + '）' : '')
                + (meta.scanMs ? ' · 扫描 ' + (meta.scanMs / 1000).toFixed(1) + 's' : '')
              : (root || '（未配置根目录）'))),
          (snotes.length ? h('div', { className: 'dr-snotes' },
            h('div', { className: 'dr-snotes-head' },
              h('strong', null, '本会话批注 (' + snotePending.length + ')'),
              h('span', { className: 'dr-spacer' }),
              (snotePending.filter(function (n) { return !n.sent_at }).length > 1
                ? h('button', {
                  className: 'dr-btn dr-btn-mini dr-btn-ghost',
                  title: '把还没标记「已发出」的批注一次标掉——它们不会再出现在批注块里（仍在清单里，随时可退回）',
                  onClick: markAllSent,
                }, '都标为已发出')
                : null),
              h('button', {
                className: 'dr-btn dr-btn-mini', disabled: !snotePending.length,
                title: '把「本会话批注」这一批发给当前会话的 AI（针对对话内容的意见，不是文档）',
                onClick: sendSnotesToAgent,
              }, '交给 AI')),
            snotes.slice().reverse().map(function (n) {
              var done = (n.status || 'pending') !== 'pending'
              return h('div', { key: n.id, className: 'dr-snote' + (done ? ' on' : '') },
                h('div', { className: 'dr-snote-q', title: n.quote }, '「' + String(n.quote || '').replace(/\s+/g, ' ').slice(0, 46) + '」'),
                h('div', { className: 'dr-snote-n' }, n.note),
                h('div', { className: 'dr-snote-bar' },
                  h('span', { className: 'dr-hint' }, relTime(Date.parse(n.createdAt) || 0) || ''),
                  n.sent_at ? h('span', { className: 'dr-hint', title: '已经随消息发给 AI 了（不会再出现在批注块里）；等它回应后会自动变成已处理' }, '已发出') : null,
                  n.reply ? h('span', { className: 'dr-hint', title: n.reply }, '已回填') : null,
                  h('span', { className: 'dr-spacer' }),
                  h('button', {
                    className: 'dr-btn dr-btn-mini dr-btn-ghost',
                    onClick: function () { snoteAction(n.id, done ? 'reopen' : 'resolve') },
                  }, done ? '退回' : '已处理'),
                  h('button', {
                    className: 'dr-btn dr-btn-mini dr-btn-ghost', title: '删除这条会话批注',
                    onClick: function () { snoteAction(n.id, 'delete') },
                  }, '×')))
            })) : h('div', { className: 'dr-hint', style: { padding: '6px 8px' } },
              '在对话里选中一段文字，旁边会出现「批注」按钮——给 AI 的话直接在那写，不占用输入框。')),
          h('div', { className: 'dr-list' },
            loading ? h('div', { className: 'dr-hint' }, '读取中…') : null,
            (!loading && !visibleDocs.length) ? h('div', { className: 'dr-hint', style: { padding: '10px' } },
              scope === 'related' ? '这个会话和同项目其它会话都还没碰过文档。' : '没有匹配的文档。',
              h('button', {
                className: 'dr-btn dr-btn-mini', style: { marginLeft: '6px' },
                onClick: function () {
                  var to = scope === 'vault' ? 'related' : (scope === 'related' ? 'workspace' : 'vault')
                  setScope(to)
                  try { localStorage.setItem('dsh-doc-review.scope', to) } catch (eS) {}
                  void loadDocs(root, q, true)
                },
              }, scope === 'related' ? '看工作区' : (scope === 'workspace' ? '看全库' : '回到相关'))) : null,
            visibleDocs.map(function (d, i) {
              var prev = i > 0 ? visibleDocs[i - 1] : null
              var head = null
              if (d.tier === 'session' && (!prev || prev.tier !== 'session')) {
                head = h('div', { className: 'dr-group' }, '本会话产出 / 编辑（' + tierCounts.session + '）')
              } else if (d.tier === 'project' && (!prev || prev.tier !== 'project')) {
                head = h('div', { className: 'dr-group' }, '本项目其它会话碰过（' + tierCounts.project + '）')
              }
              var item = h('div', {
                key: d.path,
                className: 'dr-item' + (doc && doc.path === d.path ? ' dr-item-on' : ''),
                title: d.path
                  + (d.fromSessions ? '（来自 ' + d.fromSessions + ' 个会话）' : '')
                  + (d.seenMs ? '\n会话最后动它：' + new Date(d.seenMs).toLocaleString('zh-CN') : '')
                  + '\n文件修改时间：' + new Date(d.mtimeMs).toLocaleString('zh-CN'),
                onClick: function () { void openDoc(d.path) },
                role: 'button', tabIndex: 0,
                onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openDoc(d.path) } },
              },
                h('div', { className: 'dr-item-name' }, d.name),
                h('div', { className: 'dr-item-sub' },
                  // 第一层显示「会话里最后一次动它的时间」，与排序口径一致；其余显示文件改动时间
                  h('span', { title: d.tier === 'project' ? '文件修改时间' : '会话最后一次操作时间' },
                    relTime(d.tier === 'project' ? d.mtimeMs : (d.seenMs || d.mtimeMs)) || d.updatedAt || ''),
                  d.pending ? h('span', { className: 'dr-badge-pending' }, '待处理 ' + d.pending) : null,
                  d.tier === 'project'
                    ? h('span', { className: 'dr-badge-project', title: '本项目其它会话' + (d.via === 'write' || d.via === 'edit' ? '产出/编辑过' : '碰过') }, '本项目')
                    : ((d.via === 'write' || d.via === 'edit')
                      ? h('span', { className: 'dr-badge-session', title: '本会话' + (d.via === 'write' ? '新建/改写' : '编辑') + ' ' + (d.hits || 1) + ' 次' }, d.via === 'write' ? '产出' : '编辑')
                      : (d.via === 'read' ? h('span', { className: 'dr-hint' }, '读过') : null)),
                  d.total ? h('span', { className: 'dr-hint' }, '批注 ' + d.total) : null),
              )
              return head ? h(React.Fragment, { key: d.path }, head, item) : item
            })),
          h('div', { className: 'dr-row' },
            h('input', {
              className: 'dr-input', placeholder: '粘贴文档绝对路径后回车', value: manual,
              onChange: function (e) { setManual(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter' && manual.trim()) void openDoc(manual.trim()) },
            }))),

        /* 中：正文 */
        h('div', { className: 'dr-col dr-col-doc' },
          h('div', { className: 'dr-toolbar' },
            h('div', { className: 'dr-title', title: doc ? doc.path : '' }, doc ? doc.name : '选一份文档'),
            doc ? h('span', { className: 'dr-chip' + (pending.length ? ' dr-chip-hi' : '') }, '待处理 ' + pending.length + ' / 共 ' + comments.length) : null,
            stale ? h('span', { className: 'dr-chip dr-chip-warn', title: '文档在批注之后被改过，行号可能偏移；quote 仍可定位' }, '文档已改动') : null,
            saveState ? h('span', { className: 'dr-hint' }, saveState) : null,
            h('span', { className: 'dr-spacer' }),
            h('button', { className: 'dr-btn dr-btn-ghost', onClick: function () { if (doc) void openDoc(doc.path) } }, '刷新正文'),
            h('button', { className: 'dr-btn', disabled: !pending.length, onClick: sendToAgent, title: '把待处理批注发给当前会话的 AI，让它直接改' }, '交给 AI 改稿 (' + pending.length + ')'),
            h('button', { className: 'dr-btn dr-btn-ghost', onClick: function () { copyToClipboard(buildAgentPrompt()); setMsg('指令已复制。') } }, '复制指令')),
          err ? h('div', { className: 'dr-error' }, err) : null,
          msg ? h('div', { className: 'dr-msg', onClick: function () { setMsg('') } }, msg) : null,
          doc
            ? h('div', { className: 'dr-doc-wrap' },
              h('div', {
                className: 'dr-doc-scroll', ref: docRef, onMouseUp: onMouseUp, onClick: onDocClick,
                onMouseMove: onDocMouseMove, onMouseLeave: function () { setHover(null) },
              },
              blocks.map(function (b, i) {
                var marks = marksFor(b)
                var pen = pendingSpanFor(b)
                return h('div', {
                  key: 'b' + i,
                  className: 'dr-block' + (marks.length ? ' dr-block-hl' : '') + (pen ? ' dr-block-pending' : ''),
                  'data-ls': b.ls, 'data-le': b.le,
                },
                  marks.length ? h('span', {
                    className: 'dr-mark',
                    title: marks.map(function (m) { return markTitle(comments[m], m + 1) }).join('\n'),
                  },
                    marks.map(function (m, k) {
                      var done = (comments[m].status || 'pending') !== 'pending'
                      return h('span', { key: 'mk' + m, className: done ? 'dr-mark-done' : null },
                        (done ? '✓' : '#') + (m + 1) + (k < marks.length - 1 ? ' ' : ''))
                    })) : null,
                  renderBlockBody(b, 'b' + i),
                  pen ? h('div', { className: 'dr-inline-prop' },
                    h('div', { className: 'dr-inline-prop-t' },
                      '拟' + (pen.kind === 'delete' ? '删除' : '改为') + '：',
                      pen.kind === 'delete'
                        ? h('span', { className: 'dr-prop-old' }, String(pen.quote || '').replace(/\s+/g, ' ').slice(0, 140))
                        : h('span', { className: 'dr-prop-new' }, String(pen.after || '').replace(/\s+/g, ' ').slice(0, 160))),
                    pen.note ? h('div', { className: 'dr-hint' }, pen.note) : null,
                    h('div', { className: 'dr-prop-bar' },
                      h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', onClick: function (e) { e.stopPropagation(); propDecide('accept', [pen.id]) } }, '接受'),
                      h('button', { className: 'dr-btn dr-btn-mini', onClick: function (e) { e.stopPropagation(); propDecide('reject', [pen.id]) } }, '拒绝'),
                      h('span', { className: 'dr-hint' }, '接受后才写入文件'))) : null)
              })),
              markers.length ? h('div', { className: 'dr-rail', 'aria-label': '批注位置' },
                markers.map(function (m) {
                  return h('button', {
                    key: m.id, type: 'button',
                    className: 'dr-rail-dot' + (m.id === activeId ? ' on' : ''),
                    style: { top: 'calc(' + (m.top * 100).toFixed(2) + '% - 3px)' },
                    title: m.title, 'aria-label': '跳到批注 #' + m.n,
                    onClick: function () { activate(m.id, 'rail') },
                  })
                })) : null)
            : h('div', { className: 'dr-empty' }, '左边选一份文档，或把绝对路径粘到下面输入框。选中正文里的任意文字即可写批注。')),

        /* 右：批注 */
        h('div', { className: 'dr-col dr-col-notes' },
          (propPending.length ? h('div', { className: 'dr-props' },
            h('div', { className: 'dr-props-head' },
              h('strong', null, '待审改动 (' + propPending.length + ')'),
              h('span', { className: 'dr-spacer' }),
              h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', title: '全部接受并写入文件', onClick: function () { propDecide('accept') } }, '全部接受'),
              h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', title: '全部拒绝（文件不动）', onClick: function () { propDecide('reject') } }, '全部拒绝')),
            h('input', {
              className: 'dr-input', placeholder: '拒绝原因（可选，会记下来给 AI 下次参考）',
              value: rejectReason, onChange: function (e) { setRejectReason(e.target.value) },
            }),
            propPending.map(function (c) {
              return h('div', { key: c.id, className: 'dr-prop' },
                h('div', { className: 'dr-prop-loc' }, 'L' + (c.line || '?') + (c.kind === 'delete' ? ' · 删除' : ' · 替换') + (c.applied_how ? ' · ' + c.applied_how : '')),
                h('div', { className: 'dr-prop-old' }, String(c.quote || '').slice(0, 160)),
                c.kind === 'delete' ? null : h('div', { className: 'dr-prop-new' }, String(c.after || '').slice(0, 200)),
                c.note ? h('div', { className: 'dr-hint' }, c.note) : null,
                h('div', { className: 'dr-prop-bar' },
                  h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', onClick: function () { propDecide('accept', [c.id]) } }, '接受'),
                  h('button', { className: 'dr-btn dr-btn-mini', onClick: function () { propDecide('reject', [c.id]) } }, '拒绝')))
            })) : null),
          h('div', { className: 'dr-row' },
            h('strong', null, '批注清单'),
            h('span', { className: 'dr-spacer' }),
            h('input', {
              className: 'dr-input dr-input-mini', value: author, title: '署名',
              onChange: function (e) { setAuthor(e.target.value) },
            })),
          h('div', { className: 'dr-notes-scroll', ref: notesRef },
            comments.length === 0 ? h('div', { className: 'dr-hint' }, '还没有批注。在中间正文里划词，然后写意见。') : null,
            (comments.length && !pending.length) ? h('div', { className: 'dr-hint' }, '没有待处理的批注。') : null,
            comments.map(function (c, i) { return (c.status || 'pending') === 'pending' ? renderCard(c, i) : null }),
            resolvedCount ? h('button', {
              type: 'button', className: 'dr-fold', 'aria-expanded': showResolved,
              onClick: function () { setShowResolved(!showResolved) },
            }, h('span', { className: 'dr-fold-caret' + (showResolved ? ' on' : '') }, '›'), '已解决 (' + resolvedCount + ')') : null,
            (resolvedCount && showResolved)
              ? comments.map(function (c, i) { return (c.status || 'pending') !== 'pending' ? renderCard(c, i) : null })
              : null),
          h('div', { className: 'dr-global' },
            h('textarea', {
              className: 'dr-textarea', rows: 3, value: globalNote,
              placeholder: '整篇级的意见（不指向具体段落时写这里，会一并带给 AI）',
              onChange: function (e) { setGlobalNote(e.target.value) },
            }))),

        /* 划词浮动框：默认贴选区上方，上方放不下才放下方（绝不覆盖选中的文字） */
        sel ? h('div', {
          className: 'dr-float',
          style: sel.above
            ? { left: sel.left + 'px', bottom: sel.bottom + 'px' }
            : { left: sel.left + 'px', top: sel.top + 'px' },
        },
          h('div', { className: 'dr-float-head' },
            h('span', { className: 'dr-float-loc' }, 'L' + sel.ls + (sel.le !== sel.ls ? '–L' + sel.le : '')),
            h('span', { className: 'dr-float-quote', title: sel.quote }, '「' + String(sel.quote).replace(/\s+/g, ' ').slice(0, 28) + (sel.quote.length > 28 ? '…' : '') + '」')),
          h('textarea', {
            className: 'dr-float-input', rows: 3, autoFocus: true, value: draft,
            placeholder: '这条要怎么改？（' + kbd('Mod+Enter') + ' 保存）',
            onChange: function (e) { setDraft(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitSelection(); if (e.key === 'Escape') setSel(null) },
          }),
          h('div', { className: 'dr-float-actions' },
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', title: kbd('Mod+Enter'), onClick: commitSelection }, '保存批注'),
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', title: 'Esc', onClick: function () { setSel(null) } }, '取消')))
          : null)
    }

    function scrollToLine(ls) {
      if (!ls) return
      try {
        var els = document.querySelectorAll('.dr-block[data-ls]')
        for (var i = 0; i < els.length; i++) {
          var s = Number(els[i].getAttribute('data-ls')), e = Number(els[i].getAttribute('data-le'))
          if (ls >= s && ls <= e) { els[i].scrollIntoView({ block: 'center', behavior: scrollBehavior() }); return }
        }
      } catch (err) {}
    }

    /** 错误边界：本页渲染抛错不能把宿主槽位整页带崩 */
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null } }
      static getDerivedStateFromError(e) { return { err: e } }
      render() {
        if (this.state.err) {
          return h('div', { className: 'dr-boundary' },
            h('strong', null, '批注页渲染出错'),
            h('pre', null, String((this.state.err && this.state.err.stack) || this.state.err)))
        }
        return this.props.children
      }
    }

    /* ────────────────────────── 样式 ────────────────────────── */

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      var css = [
        // Theme: only host tokens (dsh-client-ui-theme) so light / dark / custom themes all follow the host.
        // Text and its own background always come from paired tokens, never a hard-coded colour.
        '.dr-root{--dr-fg:var(--dsw-alias-label-primary);--dr-fg2:var(--dsw-alias-label-secondary);--dr-fg3:var(--dsw-alias-label-tertiary);--dr-line:var(--dsw-alias-border-l2);--dr-line-strong:var(--dsw-alias-border-l3);--dr-fill:var(--dsw-alias-interactive-bg-hover);--dr-accent:var(--dsw-alias-state-business-primary);--dr-accent-bg:var(--dsw-alias-state-business-tertiary);--dr-warn:var(--dsw-alias-state-warn-label);--dr-warn-bg:var(--dsw-alias-state-warn-tertiary);--dr-ok:var(--dsw-alias-state-success-primary);--dr-ok-bg:var(--dsw-alias-state-success-tertiary);--dr-err:var(--dsw-alias-state-error-primary);--dr-warn-fg:color-mix(in srgb,var(--dr-warn) 62%,var(--dr-fg));--dr-ok-fg:color-mix(in srgb,var(--dr-ok) 58%,var(--dr-fg));display:flex;gap:10px;padding:12px;box-sizing:border-box;min-height:600px;height:100%;font-size:13px;line-height:1.65;color:var(--dr-fg);background:var(--dsw-alias-bg-base)}',
        '.dr-col{display:flex;flex-direction:column;min-height:0}',
        '.dr-col-docs{width:230px;flex:0 0 230px;gap:6px}',
        '.dr-col-doc{flex:1 1 auto;min-width:0;gap:6px}',
        '.dr-col-notes{width:330px;flex:0 0 330px;gap:6px}',
        '.dr-row{display:flex;align-items:center;gap:6px}',
        '.dr-spacer{flex:1 1 auto}',
        '.dr-hint{font-size:11px;color:var(--dr-fg3);word-break:break-all}',
        '.dr-input{width:100%;box-sizing:border-box;height:28px;padding:0 8px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dr-fg);font-size:12px;outline:none}',
        '.dr-input:focus{border-color:var(--dr-accent)}',
        '.dr-input::placeholder,.dr-textarea::placeholder{color:var(--dsw-alias-label-dimmed)}',
        '.dr-input-mini{width:72px}',
        '.dr-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dr-line-strong);background:transparent;color:var(--dr-fg);font-size:12px;line-height:18px;font-family:inherit;cursor:pointer;white-space:nowrap}',
        '.dr-btn:hover:not(:disabled){background:var(--dr-fill)}',
        '.dr-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
        '.dr-btn:focus-visible{outline:2px solid var(--dr-accent);outline-offset:1px}',
        '.dr-item:focus-visible{outline:2px solid var(--dr-accent);outline-offset:-2px}',
        '.dr-btn:disabled{opacity:.4;cursor:not-allowed}',
        '.dr-btn-ghost{border-color:transparent}',
        '.dr-btn-on{background:var(--dr-accent-bg);border-color:transparent;color:var(--dr-accent)}',
        '.dr-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
        '.dr-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
        '.dr-btn-mini{height:24px;padding:0 8px;font-size:11px}',
        '.dr-list{flex:1 1 auto;overflow:auto;border:0.5px solid var(--dr-line);border-radius:var(--dsw-radius-lg);min-height:120px;background:var(--dsw-alias-bg-layer-1)}',
        '.dr-item{padding:6px 8px;border-bottom:0.5px solid var(--dr-line);cursor:pointer}',
        '.dr-item:hover{background:var(--dr-fill)}',
        '.dr-item-on{background:var(--dr-accent-bg)}',
        '.dr-item-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dr-item-sub{display:flex;gap:6px;font-size:10px;color:var(--dr-fg3);align-items:center}',
        '.dr-badge-pending{color:var(--dr-warn-fg);font-weight:600}',
        '.dr-badge-session{color:var(--dr-ok-fg);font-weight:600}',
        '.dr-badge-project{color:var(--dr-accent);font-weight:600}',
        // Floating surfaces (selection pill / composer / toast) live outside .dr-root, so they set
        // their own paired fg/bg tokens like the host Menu and HoverCard primitives do.
        '.dr-pill{position:fixed;z-index:10000;box-sizing:border-box;display:inline-flex;align-items:center;gap:0;height:28px;padding:2px;border:0;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;font-family:inherit;user-select:none;width:max-content;white-space:nowrap}',
        '.dr-pill-btn{display:inline-flex;align-items:center;flex:none;white-space:nowrap;gap:4px;height:24px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;cursor:pointer}',
        '.dr-pill-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dr-pill-btn:active{background:var(--dsw-alias-interactive-bg-active)}',
        '.dr-pill-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
        '.dr-pill-sep{width:0.5px;height:14px;background:var(--dsw-alias-border-l3);flex:none}',
        '.dr-pill svg{width:14px;height:14px;color:var(--dsw-alias-label-secondary)}',
        '.dr-pill-more{padding:0 6px}',
        '.dr-pill-btn-on{background:var(--dsw-alias-interactive-bg-active)}',
        '.dr-menu{position:fixed;z-index:10001;box-sizing:border-box;width:180px;max-height:60vh;overflow:auto;display:flex;flex-direction:column;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px;user-select:none}',
        '.dr-menu-item{display:block;width:100%;box-sizing:border-box;text-align:left;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:none}',
        '.dr-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.dr-menu-item:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}',
        '.dr-menu-item-dim{color:var(--dsw-alias-label-secondary)}',
        '.dr-menu-sep{height:0.5px;margin:4px 2px;background:var(--dsw-alias-border-l3);flex:none}',
        '.dr-pm-backdrop{position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent)}',
        '.dr-pm{box-sizing:border-box;width:min(520px,calc(100vw - 32px));max-height:min(640px,calc(100vh - 32px));display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);font-size:12px;line-height:18px}',
        '.dr-pm-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
        '.dr-pm-title{font-size:14px;font-weight:600}',
        '.dr-pm-sub,.dr-pm-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}',
        '.dr-pm-list{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px}',
        '.dr-pm-row{display:flex;flex-direction:column;gap:4px;padding:8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}',
        '.dr-pm-row-top{display:flex;align-items:center;gap:4px}',
        '.dr-pm-label{width:160px;flex:none;color:var(--dsw-alias-label-primary)}',
        '.dr-pm-empty{padding:16px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
        '.dr-pm-warn{font-size:11px;color:var(--dsw-alias-state-warn-label)}',
        '.dr-pm-actions{display:flex;align-items:center;gap:6px}',
        '.dr-pm .dr-btn{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
        '.dr-pm .dr-btn-ghost{border-color:transparent}',
        '.dr-pm .dr-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
        '.dr-pm .dr-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}',
        '.dr-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:56px;z-index:10001;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);font-size:12px;padding:7px 14px;border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-shadow-lv2);max-width:70vw}',
        '.dr-snote{border-bottom:0.5px solid var(--dr-line);padding:6px 8px;cursor:default}',
        '.dr-snote-q{font-size:11px;color:var(--dr-fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dr-snote-n{font-size:12px;margin-top:2px;word-break:break-word}',
        '.dr-snote-bar{display:flex;gap:6px;align-items:center;margin-top:3px}',
        '.dr-snote.on .dr-snote-n{text-decoration:line-through;color:var(--dr-fg3)}',
        '.dr-group{font-size:10px;color:var(--dr-fg3);padding:6px 8px 2px;letter-spacing:.3px}',
        '.dr-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.dr-title{font-weight:600;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dr-chip{font-size:11px;padding:1px 7px;border-radius:10px;background:var(--dr-fill);color:var(--dr-fg2)}',
        '.dr-chip-hi{background:var(--dr-warn-bg);color:var(--dr-warn-fg);font-weight:600}',
        '.dr-chip-warn{background:color-mix(in srgb,var(--dr-err) 16%,transparent);color:var(--dr-err)}',
        '.dr-doc-wrap{flex:1 1 auto;min-height:0;display:flex;gap:3px}',
        '.dr-doc-scroll{flex:1 1 auto;min-width:0;overflow:auto;padding:8px 18px 60px;border:0.5px solid var(--dr-line);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
        '.dr-doc-hot{cursor:pointer}',
        // Scrollbar-side rail: one dot per pending anchor, positioned by its share of scrollHeight.
        '.dr-rail{position:relative;flex:0 0 8px;margin:6px 0}',
        '.dr-rail-dot{position:absolute;left:1px;width:6px;height:6px;padding:0;border:0;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 70%,transparent);cursor:pointer}',
        '.dr-rail-dot:hover,.dr-rail-dot.on{background:var(--dsw-alias-state-warn-primary)}',
        '.dr-rail-dot:focus-visible{outline:2px solid var(--dr-accent);outline-offset:1px}',
        '.dr-rail-dot::after{content:"";position:absolute;inset:-5px}',
        '::highlight(dr-anchor){background-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 22%,transparent)}',
        '::highlight(dr-anchor-active){background-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 46%,transparent)}',
        '.dr-block{position:relative;border-radius:6px;padding:1px 4px}',
        '.dr-block-pending{outline:1px dashed color-mix(in srgb,var(--dr-accent) 60%,transparent);outline-offset:1px}',
        '.dr-props{border:0.5px solid color-mix(in srgb,var(--dr-accent) 45%,transparent);background:color-mix(in srgb,var(--dr-accent) 8%,transparent);border-radius:var(--dsw-radius-md);padding:7px 8px;margin-bottom:8px;display:flex;flex-direction:column;gap:6px}',
        '.dr-props-head{display:flex;gap:6px;align-items:center}',
        '.dr-prop{border-top:0.5px solid var(--dr-line);padding-top:5px;font-size:12px;display:flex;flex-direction:column;gap:3px}',
        '.dr-prop-loc{font-size:10px;color:var(--dr-fg3)}',
        '.dr-prop-old{background:var(--dsw-alias-file-diff-deleted-bg,color-mix(in srgb,var(--dr-err) 14%,transparent));color:var(--dsw-alias-file-diff-deleted-marker,var(--dr-err));text-decoration:line-through;border-radius:var(--dsw-radius-xs,4px);padding:1px 4px;word-break:break-word}',
        '.dr-prop-new{background:var(--dsw-alias-file-diff-added-bg,color-mix(in srgb,var(--dr-ok) 16%,transparent));color:var(--dsw-alias-file-diff-added-marker,var(--dr-ok));border-radius:4px;padding:1px 4px;word-break:break-word}',
        '.dr-prop-bar{display:flex;gap:6px;align-items:center;margin-top:2px}',
        '.dr-inline-prop{margin:3px 0 5px 8px;padding:4px 7px;border-left:3px solid color-mix(in srgb,var(--dr-accent) 70%,transparent);background:color-mix(in srgb,var(--dr-accent) 8%,transparent);border-radius:0 6px 6px 0;font-size:12px;display:flex;flex-direction:column;gap:3px}',
        '.dr-inline-prop-t{display:flex;gap:4px;flex-wrap:wrap;align-items:baseline}',
        '.dr-block-hl{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}',
        '.dr-mark{float:right;position:static;margin-left:6px;font-size:10px;line-height:16px;color:var(--dr-warn-fg);background:var(--dr-warn-bg);border-radius:999px;padding:0 6px}',
        '.dr-mark-done{color:var(--dr-ok);background:color-mix(in srgb,var(--dr-ok) 16%,transparent);border-radius:8px;padding:0 3px;border-bottom:1px dashed color-mix(in srgb,var(--dr-ok) 55%,transparent)}',
        '.dr-h{font-weight:650;margin:.75em 0 .35em}',
        '.dr-h1{font-size:1.5em}.dr-h2{font-size:1.3em}.dr-h3{font-size:1.14em}.dr-h4,.dr-h5,.dr-h6{font-size:1em}',
        '.dr-p{margin:.42em 0}',
        '.dr-ul{margin:.35em 0 .35em 1.2em;padding:0}',
        '.dr-quote{margin:.45em 0;padding:.2em .8em;border-left:3px solid var(--dr-line-strong);color:var(--dr-fg2)}',
        '.dr-pre{margin:.5em 0;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block,var(--dr-fill));overflow:auto;font-size:12px}',
        '.dr-root code{background:var(--dsw-alias-markdown-inline-code,var(--dr-fill));border-radius:4px;padding:0 4px}',
        '.dr-root a{color:var(--dsw-alias-link)}',
        '.dr-table{border-collapse:collapse;margin:.5em 0;font-size:12px}',
        '.dr-table th,.dr-table td{border:0.5px solid var(--dr-line-strong);padding:3px 7px;text-align:left}',
        '.dr-hr{border:0;border-top:0.5px solid var(--dr-line);margin:1em 0}',
        '.dr-empty{flex:1 1 auto;display:flex;align-items:center;justify-content:center;color:var(--dr-fg3);padding:40px;text-align:center}',
        '.dr-notes-scroll{flex:1 1 auto;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px}',
        '.dr-card{border:0.5px solid var(--dr-line);border-radius:var(--dsw-radius-lg);padding:7px 8px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1)}',
        '.dr-card{cursor:default;transition:border-color .12s ease}',
        '.dr-card-active{border-color:var(--dr-accent);box-shadow:0 0 0 0.5px var(--dr-accent)}',
        '.dr-card-resolved .dr-card-note,.dr-card-resolved .dr-card-quote,.dr-card-wontfix .dr-card-note,.dr-card-wontfix .dr-card-quote{color:var(--dr-fg3)}',
                        '.dr-card-author{color:var(--dr-fg3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px}',
        '.dr-card-note{font-size:12px;white-space:pre-wrap;word-break:break-word}',
        '.dr-edit{display:flex;flex-direction:column;gap:5px}',
        '.dr-thread{display:flex;flex-direction:column;gap:6px;border-top:0.5px solid var(--dr-line);padding-top:6px}',
        '.dr-reply{display:flex;flex-direction:column;gap:1px;font-size:12px}',
        '.dr-reply-head{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--dr-fg2)}',
        '.dr-reply-tag{font-size:10px;line-height:14px;padding:0 4px;border-radius:4px;background:var(--dr-accent-bg);color:var(--dr-accent);font-weight:600}',
        '.dr-reply-text{white-space:pre-wrap;word-break:break-word}',
        '.dr-reply-input{height:26px}',
        '.dr-fold{display:flex;align-items:center;gap:4px;margin-top:4px;padding:4px 2px;border:0;background:transparent;color:var(--dr-fg2);font:inherit;font-size:12px;cursor:pointer;text-align:left}',
        '.dr-fold:hover{color:var(--dr-fg)}',
        '.dr-fold:focus-visible{outline:2px solid var(--dr-accent);outline-offset:1px;border-radius:4px}',
        '.dr-fold-caret{display:inline-block;width:10px;transition:transform .12s ease}',
        '.dr-fold-caret.on{transform:rotate(90deg)}',
        '@media (prefers-reduced-motion: reduce){.dr-card,.dr-fold-caret{transition:none}}',
        '.dr-card-head{display:flex;align-items:center;gap:6px;font-size:11px}',
        '.dr-card-no{font-weight:700}',
        '.dr-card-loc{cursor:pointer;text-decoration:underline dotted;color:var(--dr-fg2)}',
        '.dr-status{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--dr-fill);color:var(--dr-fg2)}',
        '.dr-status-pending{background:var(--dr-warn-bg);color:var(--dr-warn-fg)}',
        '.dr-status-resolved{background:var(--dr-ok-bg);color:var(--dr-ok-fg)}',
        '.dr-status-orphan{background:color-mix(in srgb,var(--dr-err) 16%,transparent);color:var(--dr-err)}',
        '.dr-card-quote{font-size:11px;color:var(--dr-fg2);max-height:56px;overflow:hidden;border-left:2px solid var(--dr-line-strong);padding-left:6px;white-space:pre-wrap}',
        '.dr-card-actions{display:flex;align-items:center;gap:5px}',
        '.dr-textarea{width:100%;box-sizing:border-box;padding:5px 7px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dr-fg);font-size:12px;font-family:inherit;resize:vertical;outline:none}',
        '.dr-textarea:focus{border-color:var(--dr-accent)}',
        '.dr-global{margin-top:auto}',
        '.dr-error{color:var(--dr-err);font-size:12px}',
        '.dr-msg{font-size:12px;color:var(--dr-ok-fg);background:var(--dr-ok-bg);border-radius:6px;padding:4px 8px;cursor:pointer}',
        '.dr-float{position:fixed;z-index:9999;width:280px;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:0;border-radius:var(--dsw-radius-lg);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);padding:8px;display:flex;flex-direction:column;gap:6px}',
        '.dr-float-head{display:flex;gap:6px;align-items:baseline;min-width:0}',
        '.dr-float-quote{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
        '.dr-float-loc{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}',
        '.dr-float .dr-btn{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}',
        '.dr-float .dr-btn-ghost{border-color:transparent}',
        '.dr-float .dr-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}',
        '::highlight(dr-pending){background:var(--dsw-alias-bg-document-selection,color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent))}',
        '.dr-float-input{width:100%;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);padding:5px 7px;font-size:12px;font-family:inherit;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);resize:vertical;outline:none}',
        '.dr-float-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
        '.dr-float-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
        '.dr-float-actions{display:flex;gap:6px;justify-content:flex-end}',
        '.dr-boundary{padding:24px;color:var(--dsw-alias-state-error-primary);font-size:12px;overflow:auto}',
      ].join('\n')
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = css
      document.head.appendChild(el)
    }

    /* ────────── 选中文字 → 自定义提示词（翻译 / 解读 …）──────────
     * 划词小菜单里除了「批注 / 复制」，还列出用户自己配置的提示词；点一下就把
     * 「提示词 + 选中文字」插进当前会话的聊天输入框（先只插入、不自动发送）。
     * 提示词是本机偏好，存 localStorage；{{text}} 代表选中的文字，模板里没写就附在末尾。 */
    var PROMPTS_KEY = 'dsh-doc-review.prompts'
    var PROMPTS_INLINE = 3
    var DEFAULT_PROMPTS = [
      { id: 'p_translate', label: '翻译', template: '把下面这段翻译成中文；如果原文已经是中文，就翻译成英文。只给译文。\n\n「{{text}}」' },
      { id: 'p_explain', label: '解读', template: '帮我再解读一下这段：讲清它在说什么、为什么这么说，必要时举个例子。\n\n「{{text}}」' },
    ]

    /** Clean a stored prompt list: drop blank rows, trim labels, de-duplicate ids, cap the count.
     *  Anything that is not an array means "never configured" → defaults. An empty array is kept. */
    function normalizePrompts(raw) {
      if (!Array.isArray(raw)) return DEFAULT_PROMPTS.map(function (p) { return { id: p.id, label: p.label, template: p.template } })
      var seen = {}, out = []
      for (var i = 0; i < raw.length && out.length < 30; i++) {
        var p = raw[i]
        if (!p || typeof p !== 'object') continue
        var label = String(p.label || '').trim().slice(0, 16)
        var template = String(p.template || '')
        if (!label || !template.trim()) continue
        var id = String(p.id || '') || ('p_' + i)
        while (seen[id]) id = id + '_'
        seen[id] = true
        out.push({ id: id, label: label, template: template })
      }
      return out
    }

    /** Template + selection → the text inserted into the chat box. */
    function fillPrompt(template, text) {
      var t = String(template || ''), s = String(text || '')
      if (t.indexOf('{{text}}') >= 0) return t.split('{{text}}').join(s)
      t = t.replace(/\s+$/, '')
      return t ? t + '\n\n「' + s + '」' : s
    }

    /** Append to whatever the user already typed (annotation block included), one blank line apart. */
    function joinDraft(draft, text) {
      var d = String(draft == null ? '' : draft).replace(/\s+$/, '')
      return d ? d + '\n\n' + text : String(text)
    }

    function loadPrompts() {
      try {
        var s = localStorage.getItem(PROMPTS_KEY)
        return normalizePrompts(s == null ? null : JSON.parse(s))
      } catch (e) { return normalizePrompts(null) }
    }

    function storePrompts(list) {
      var clean = normalizePrompts(list)
      try { localStorage.setItem(PROMPTS_KEY, JSON.stringify(clean)) } catch (e) {}
      return clean
    }

    /** Rough pill width so the toolbar can be clamped inside the viewport before it renders. */
    function pillWidth(labels) {
      var w = 4 + 2 * 58 + 1                                  // padding + 批注 / 复制 (icon+text) + separator
      for (var i = 0; i < labels.length; i++) w += 16 + String(labels[i]).length * 12
      return w + (labels.length ? 1 : 0) + 28                  // separator + ⋯
    }

    /** 提示词管理：增删改、排序、恢复默认。保存后立即出现在划词菜单里。 */
    function PromptManager(props) {
      var rowsPair = useState(function () { return props.prompts.map(function (p) { return { id: p.id, label: p.label, template: p.template } }) })
      var rows = rowsPair[0], setRows = rowsPair[1]

      useEffect(function () {
        function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); props.onClose() } }
        document.addEventListener('keydown', onKey, true)
        return function () { document.removeEventListener('keydown', onKey, true) }
      }, [])

      function patch(i, k, v) {
        setRows(rows.map(function (r, j) { if (j !== i) return r; var n = { id: r.id, label: r.label, template: r.template }; n[k] = v; return n }))
      }
      function move(i, d) {
        var j = i + d
        if (j < 0 || j >= rows.length) return
        var next = rows.slice(); var t = next[i]; next[i] = next[j]; next[j] = t
        setRows(next)
      }
      function remove(i) { setRows(rows.filter(function (_, j) { return j !== i })) }
      function add() { setRows(rows.concat([{ id: 'p_' + Date.now().toString(36), label: '', template: '{{text}}' }])) }

      var dropped = rows.filter(function (r) { return !String(r.label).trim() || !String(r.template).trim() }).length

      return h('div', { className: 'dr-pm-backdrop', onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose() } },
        h('div', { className: 'dr-pm', role: 'dialog', 'aria-modal': true, 'aria-label': '划词提示词' },
          h('div', { className: 'dr-pm-head' },
            h('span', { className: 'dr-pm-title' }, '划词提示词'),
            h('span', { className: 'dr-pm-sub' }, '选中文字后出现在小菜单里，点一下插入聊天输入框')),
          h('div', { className: 'dr-pm-hint' }, '用 {{text}} 代表选中的文字；模板里不写，就自动附在末尾。前 ' + PROMPTS_INLINE + ' 个直接显示在菜单上，其余收进「⋯」。'),
          h('div', { className: 'dr-pm-list' },
            rows.length ? rows.map(function (r, i) {
              return h('div', { key: r.id, className: 'dr-pm-row' },
                h('div', { className: 'dr-pm-row-top' },
                  h('input', {
                    className: 'dr-input dr-pm-label', value: r.label, maxLength: 16, placeholder: '菜单名，如「翻译」',
                    'aria-label': '菜单名', onChange: function (e) { patch(i, 'label', e.target.value) },
                  }),
                  h('span', { className: 'dr-spacer' }),
                  h('button', { type: 'button', className: 'dr-btn dr-btn-mini dr-btn-ghost', disabled: i === 0, title: '上移', 'aria-label': '上移', onClick: function () { move(i, -1) } }, '↑'),
                  h('button', { type: 'button', className: 'dr-btn dr-btn-mini dr-btn-ghost', disabled: i === rows.length - 1, title: '下移', 'aria-label': '下移', onClick: function () { move(i, 1) } }, '↓'),
                  h('button', { type: 'button', className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { remove(i) } }, '删除')),
                h('textarea', {
                  className: 'dr-float-input dr-pm-tpl', rows: 3, value: r.template, placeholder: '提示词内容，{{text}} 处换成选中的文字',
                  'aria-label': '提示词内容', onChange: function (e) { patch(i, 'template', e.target.value) },
                }))
            }) : h('div', { className: 'dr-pm-empty' }, '还没有提示词。点「新增」加一个，或「恢复默认」。')),
          dropped ? h('div', { className: 'dr-pm-warn' }, dropped + ' 条缺名字或内容，保存时会被忽略') : null,
          h('div', { className: 'dr-pm-actions' },
            h('button', { type: 'button', className: 'dr-btn dr-btn-mini', onClick: add }, '新增'),
            h('button', { type: 'button', className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { setRows(normalizePrompts(null)) } }, '恢复默认'),
            h('span', { className: 'dr-spacer' }),
            h('button', { type: 'button', className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: props.onClose }, '取消'),
            h('button', { type: 'button', className: 'dr-btn dr-btn-mini dr-btn-primary', onClick: function () { props.onSave(rows) } }, '保存'))))
    }

    /* ────────── 会话批注：在对话消息上划词写意见（全局浮层，和文档批注同款用法）──────────
     * 文档视口内由 DocReviewView 自己处理；视口外（也就是正常对话界面）由这里接管：
     * 划词 → 选区旁出现一个小「批注」按钮 → 点开写意见 → 存到该会话的批注文件。
     * 不在划词时直接弹输入框，是为了不干扰你选中文字复制。 */
    function inDocView(node) {
      try {
        var el = node && node.nodeType === 3 ? node.parentNode : node
        while (el && el.classList) {
          if (el.classList.contains('dr-root')) return true
          el = el.parentNode
        }
      } catch (e) {}
      return false
    }

    function readSelection() {
      try {
        var s = window.getSelection()
        if (!s || s.isCollapsed) return null
        var text = String(s.toString() || '').trim()
        if (text.length < 2) return null
        var range = s.getRangeAt(0)
        var r = range.getBoundingClientRect()
        if (!r || (!r.width && !r.height)) return null
        var prefix = ''
        try {
          var probe = range.cloneRange()
          probe.setStart(range.startContainer, Math.max(0, (range.startOffset || 0) - 40))
          prefix = String(probe.toString() || '').slice(-40)
        } catch (e0) {}
        return {
          text: text.length > 2000 ? text.slice(0, 2000) : text,
          prefix: prefix,
          node: range.startContainer,
          rect: { left: r.left, top: r.top, bottom: r.bottom, right: r.right, width: r.width, height: r.height },
        }
      } catch (e) { return null }
    }

    function ChatAnnotator() {
      var selPair = useState(null)
      var sel = selPair[0], setSel = selPair[1]
      var openPair = useState(false)
      var open = openPair[0], setOpen = openPair[1]
      var draftPair = useState('')
      var draft = draftPair[0], setDraft = draftPair[1]
      var toastPair = useState('')
      var toast = toastPair[0], setToast = toastPair[1]

      var promptsPair = useState(loadPrompts)
      var prompts = promptsPair[0], setPrompts = promptsPair[1]
      var morePair = useState(false)
      var moreOpen = morePair[0], setMoreOpen = morePair[1]
      var pmPair = useState(false)
      var pmOpen = pmPair[0], setPmOpen = pmPair[1]

      var selTextRef = useRef('')
      var openRef = useRef(false)
      openRef.current = open || pmOpen
      var pmRef = useRef(false)
      pmRef.current = pmOpen

      // Selection gone → the overflow menu goes with it.
      useEffect(function () { if (!sel) setMoreOpen(false) }, [sel])

      function applyPrompt(p) {
        if (!sel) return
        var text = fillPrompt(p.template, sel.text)
        var shell = composerShell()
        var done = false
        if (shell && shell.state && typeof shell.setDraft === 'function') {
          try {
            var draft = (shell.state.getSnapshot() || {}).draft || ''
            shell.setDraft(joinDraft(draft, text))
            try { if (typeof shell.focus === 'function') shell.focus() } catch (_) {}
            done = true
          } catch (_) { done = false }
        }
        setSel(null); setMoreOpen(false); selTextRef.current = ''
        try { var ws = window.getSelection(); if (ws) ws.removeAllRanges() } catch (_) {}
        if (done) { setToast('已插入输入框：' + p.label + ' · 确认后回车发送'); return }
        // No chat box reachable (e.g. no active session): fall back to the clipboard so nothing is lost.
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              function () { setToast('没找到聊天输入框，已把「' + p.label + '」提示词复制到剪贴板') },
              function () { setToast('没找到聊天输入框，插入失败') })
            return
          }
        } catch (_) {}
        setToast('没找到聊天输入框，插入失败')
      }

      function openManager() {
        setMoreOpen(false); setSel(null); selTextRef.current = ''
        setPmOpen(true)
      }

      var managerNode = pmOpen ? h(PromptManager, {
        prompts: prompts,
        onClose: function () { setPmOpen(false) },
        onSave: function (rows) { setPrompts(storePrompts(rows)); setPmOpen(false); setToast('提示词已保存') },
      }) : null

      useEffect(function () {
        // The pill belongs to a live selection: once the selection collapses (click elsewhere,
        // Esc, keyboard) or the page scrolls, drop it. An open composer keeps its own lifetime
        // because focusing its textarea collapses the page selection.
        function onSelChange() {
          if (openRef.current) return
          var s = window.getSelection()
          if (!s || s.isCollapsed || String(s.toString() || '').trim().length < 2) setSel(null)
        }
        function onScroll() { if (!openRef.current) setSel(null) }
        document.addEventListener('selectionchange', onSelChange)
        window.addEventListener('scroll', onScroll, true)
        return function () {
          document.removeEventListener('selectionchange', onSelChange)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [])

      useEffect(function () {
        function onUp(e) {
          if (pmRef.current) return                      // 提示词管理窗里的划选不算划词
          // A click on our own toolbar / menu is not a new selection: the button already acted on mousedown.
          try { if (e && e.target && e.target.closest && e.target.closest('.dr-pill,.dr-menu')) return } catch (_) {}
          var q = readSelection()
          if (!q) { if (!openRef.current) setSel(null); return }
          if (inDocView(q.node)) { setSel(null); setOpen(false); selTextRef.current = ''; return }   // 文档视口里走它自己的流程
          // 换了另一段文字就把上一段没保存的意见清掉，免得"上一条批注又出现在框里"
          if (selTextRef.current !== q.text) { setDraft(''); selTextRef.current = q.text }
          setSel(q)
          setOpen(false)
        }
        document.addEventListener('mouseup', onUp, true)
        return function () { document.removeEventListener('mouseup', onUp, true) }
      }, [])

      useEffect(function () {
        if (!sel) return undefined
        function onKey(e) {
          if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return
          if (String(e.key || '').toLowerCase() !== 'm') return
          e.preventDefault()
          setOpen(true)
          setTimeout(function () {
            var ta = document.querySelector('.dr-float-input')
            if (ta) { try { ta.focus() } catch (_) {} }
          }, 0)
        }
        document.addEventListener('keydown', onKey)
        return function () { document.removeEventListener('keydown', onKey) }
      }, [sel])

      useEffect(function () {
        if (!toast) return
        var t = setTimeout(function () { setToast('') }, 4200)
        return function () { clearTimeout(t) }
      }, [toast])

      function save() {
        if (!sel || !draft.trim()) return
        var sid = currentSessionId()
        if (!sid) { setToast('拿不到会话 id，无法保存'); return }
        apiPost(API.snote, { sessionId: sid, quote: sel.text, prefix: sel.prefix, note: draft.trim() }).then(function (r) {
          if (!r || !r.ok) { setToast('保存失败：' + ((r && r.error) || '未知错误')); return }
          var how = syncDraftToComposer(r.notes || [])
          var n = (r.notes || []).filter(function (x) { return (x.status || 'pending') === 'pending' }).length
          if (how === 'ok') setToast('已写进输入框（第 ' + n + ' 条）· 继续划词加批注，攒够了一次发送')
          else if (how === 'command') setToast('输入框里是命令，没动它 · 批注已存在清单（待处理 ' + (r.pending || 0) + '）')
          else setToast('已记 1 条会话批注（待处理 ' + (r.pending || 0) + '）· 回「批注」页可查看或交给 AI')
          setSel(null); setOpen(false); setDraft(''); selTextRef.current = ''
          try { window.dispatchEvent(new CustomEvent('dsh-doc-review:snotes')) } catch (e) {}
        }).catch(function (e) { setToast('保存失败：' + ((e && e.message) || e)) })
      }

      var toastNode = toast ? h('div', { className: 'dr-toast', role: 'status' }, toast) : null
      if (!sel) return (managerNode || toastNode) ? h('div', null, managerNode, toastNode) : null

      var vw = window.innerWidth || 1200
      var vh = window.innerHeight || 800
      var inline = prompts.slice(0, PROMPTS_INLINE)
      var overflow = prompts.slice(PROMPTS_INLINE)
      var BAR_W = pillWidth(inline.map(function (p) { return p.label }))
      var pillLeft = Math.min(Math.max(sel.rect.right + 6, 8), Math.max(8, vw - BAR_W - 8))
      var pillTop = Math.min(Math.max(sel.rect.top - 4, 8), Math.max(8, vh - 36))
      var svgProps = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }

      function copySel() {
        var text = sel.text
        var done = function () { setToast('已复制'); setSel(null); selTextRef.current = '' }
        var fail = function () { setToast('复制失败') }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail)
          else fail()
        } catch (e) { fail() }
      }

      // Small toolbar next to the selection: comment + copy. mousedown preventDefault keeps the selection.
      var pillNode = open ? null : h('div', {
        className: 'dr-pill', role: 'toolbar', 'aria-label': '选中文字',
        style: { left: pillLeft + 'px', top: pillTop + 'px' },
        onMouseDown: function (e) { e.preventDefault() },
      },
        h('button', {
          type: 'button', className: 'dr-pill-btn',
          title: '给选中的这段写批注（' + kbd('Mod+Shift+M') + '），保存后写进聊天输入框',
          onMouseDown: function (e) { e.preventDefault(); setOpen(true) },
        },
          h('svg', svgProps, h('path', { d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' })),
          '批注'),
        h('span', { className: 'dr-pill-sep', 'aria-hidden': true }),
        h('button', {
          type: 'button', className: 'dr-pill-btn', title: '复制选中文字',
          onMouseDown: function (e) { e.preventDefault(); copySel() },
        },
          h('svg', svgProps,
            h('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2 }),
            h('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' })),
          '复制'),
        inline.length ? h('span', { className: 'dr-pill-sep', 'aria-hidden': true }) : null,
        inline.map(function (p) {
          return h('button', {
            key: p.id, type: 'button', className: 'dr-pill-btn',
            title: '把「' + p.label + '」提示词连同选中文字插入聊天输入框',
            onMouseDown: function (e) { e.preventDefault(); applyPrompt(p) },
          }, p.label)
        }),
        h('button', {
          type: 'button', className: 'dr-pill-btn dr-pill-more' + (moreOpen ? ' dr-pill-btn-on' : ''),
          title: '更多提示词 / 管理提示词', 'aria-label': '更多', 'aria-haspopup': 'menu', 'aria-expanded': moreOpen,
          onMouseDown: function (e) { e.preventDefault(); setMoreOpen(!moreOpen) },
        },
          h('svg', svgProps,
            h('circle', { cx: 5, cy: 12, r: 1 }), h('circle', { cx: 12, cy: 12, r: 1 }), h('circle', { cx: 19, cy: 12, r: 1 }))))

      var moreNode = null
      if (moreOpen && !open) {
        var MENU_W = 180
        var menuLeft = Math.min(Math.max(pillLeft + BAR_W - MENU_W, 8), Math.max(8, vw - MENU_W - 8))
        var menuRows = overflow.length + 1
        var below = pillTop + 32
        var menuStyle = (below + menuRows * 28 + 16 > vh)
          ? { left: menuLeft + 'px', bottom: Math.max(8, vh - pillTop + 4) + 'px' }
          : { left: menuLeft + 'px', top: below + 'px' }
        moreNode = h('div', { className: 'dr-menu', role: 'menu', style: menuStyle, onMouseDown: function (e) { e.preventDefault() } },
          overflow.map(function (p) {
            return h('button', {
              key: p.id, type: 'button', role: 'menuitem', className: 'dr-menu-item', title: p.template,
              onMouseDown: function (e) { e.preventDefault(); applyPrompt(p) },
            }, p.label)
          }),
          overflow.length ? h('div', { className: 'dr-menu-sep', role: 'separator' }) : null,
          h('button', {
            type: 'button', role: 'menuitem', className: 'dr-menu-item dr-menu-item-dim',
            onMouseDown: function (e) { e.preventDefault(); openManager() },
          }, prompts.length ? '管理提示词…' : '添加提示词…'))
      }

      var composer = null
      if (open) {
        var place = floatPlacement(sel.rect, vw, vh)
        composer = h('div', {
          className: 'dr-float',
          style: place.above ? { left: place.left + 'px', bottom: place.bottom + 'px' } : { left: place.left + 'px', top: place.top + 'px' },
        },
          h('div', { className: 'dr-float-head' },
            h('span', { className: 'dr-float-loc' }, '会话批注'),
            h('span', { className: 'dr-float-quote', title: sel.text }, '「' + sel.text.replace(/\s+/g, ' ').slice(0, 28) + (sel.text.length > 28 ? '…' : '') + '」')),
          h('textarea', {
            className: 'dr-float-input', rows: 3, autoFocus: true, value: draft,
            placeholder: '对这段有什么意见？（' + kbd('Mod+Enter') + ' 保存）',
            onChange: function (e) { setDraft(e.target.value) },
            onKeyDown: function (e) {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
              if (e.key === 'Escape') { setOpen(false); setSel(null) }
            },
          }),
          h('div', { className: 'dr-float-actions' },
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', title: kbd('Mod+Enter'), onClick: save }, '保存批注'),
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { setOpen(false); setSel(null) } }, '取消')))
      }

      return h('div', null, pillNode, moreNode, composer, managerNode, toastNode)
    }

    /* ────────────────────────── 插件入口 ────────────────────────── */

    function apply(ctx) {
      try { ensureStyle() } catch (e) { console.warn('[dsh-doc-review] style inject failed', e) }
      ctx.effect(function () {
        return function () { var el = document.getElementById(STYLE_ID); if (el) el.remove() }
      }, 'dsh-doc-review: styles')

      var slots = ctx.slots
      if (!slots) { console.warn('[dsh-doc-review] slots service unavailable'); return }
      sessions = ctx.sessions || null
      try { remoteFace = ctx.remote || null } catch (e) { remoteFace = null }
      ctxRef = ctx || null
      // 输入框 facade（可选）：拿到就支持"批注直接写进聊天输入框"，拿不到就只落盘。
      // 这里取不到不算失败——composerShell() 每次用之前会惰性重取一次。
      try {
        convFace = (typeof ctx.get === 'function') ? (ctx.get('conversation') || null) : (ctx.conversation || null)
      } catch (e) { convFace = null }
      if (!convFace) console.log('[dsh-doc-review] conversation 服务此刻不可用：稍后保存批注时会再试一次')

      apiPost(API.hello, { sessionId: currentSessionId() }).catch(function () {})

      var disposers = []
      try {
        disposers.push(slots.inject('conversation.view', function () {
          return slots.register(
            { name: 'conversation.view', id: 'dsh-doc-review-view', order: 82, label: function () { return '批注' } },
            function () { return h(Boundary, null, h(DocReviewView)) },
          )
        }))
      } catch (e) {
        console.warn('[dsh-doc-review] slot registration failed', e)
      }
      // 对话界面上的划词批注（全局浮层，独立于「批注」页）
      try {
        disposers.push(slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'dsh-doc-review-annotator', order: 82 },
            function () { return h(Boundary, null, h(ChatAnnotator)) },
          )
        }))
      } catch (e) {
        console.warn('[dsh-doc-review] overlay slot registration failed', e)
      }
      ctx.effect(function () {
        return function () { for (var i = 0; i < disposers.length; i++) { try { disposers[i]() } catch (e) {} } }
      }, 'dsh-doc-review: slots')

      console.log('[dsh-doc-review] client ready: conversation.view = 批注')
    }

    exports.inject = ['slots', 'sessions', 'remote', 'remote.session']
    exports.apply = apply
    return module.exports
  },
})
