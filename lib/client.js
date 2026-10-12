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
      // 正文是否保留已处理批注的锚点（默认保留：这是我们的差异化，别的产品解决后就找不回了）
      var showDonePair = useState(true)
      var showDone = showDonePair[0], setShowDone = showDonePair[1]

      var comments = (doc && doc.review && doc.review.comments) ? doc.review.comments : []
      var pending = comments.filter(function (c) { return c.status === 'pending' })
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
        persist(comments.filter(function (c) { return c.id !== id }), true)
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

      /* 行号 → 批注序号映射（高亮已批注段落） */
      var byLine = useMemo(function () {
        var map = {}
        comments.forEach(function (c, i) {
          if (!c.lineStart || c.anchored === false) return
          if (!showDone && (c.status || 'pending') !== 'pending') return
          for (var l = c.lineStart; l <= (c.lineEnd || c.lineStart); l++) {
            if (!map[l]) map[l] = []
            map[l].push(i)
          }
        })
        return map
      }, [doc && doc.path, comments, showDone])

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
            h('button', {
              className: 'dr-btn dr-btn-ghost',
              title: showDone
                ? '当前：正文里保留已处理批注的锚点（行业里 Google Docs/Confluence 解决后就找不回了，我们留着）。点一下只看待处理。'
                : '当前：正文只标记待处理批注。点一下把已处理的锚点也显示出来（可召回当时的意见与结论）。',
              onClick: function () { setShowDone(!showDone) },
            }, showDone ? '含已处理' : '只看待处理'),
            h('button', { className: 'dr-btn dr-btn-ghost', onClick: function () { if (doc) void openDoc(doc.path) } }, '刷新正文'),
            h('button', { className: 'dr-btn', disabled: !pending.length, onClick: sendToAgent, title: '把待处理批注发给当前会话的 AI，让它直接改' }, '交给 AI 改稿 (' + pending.length + ')'),
            h('button', { className: 'dr-btn dr-btn-ghost', onClick: function () { copyToClipboard(buildAgentPrompt()); setMsg('指令已复制。') } }, '复制指令')),
          err ? h('div', { className: 'dr-error' }, err) : null,
          msg ? h('div', { className: 'dr-msg', onClick: function () { setMsg('') } }, msg) : null,
          doc
            ? h('div', { className: 'dr-doc-scroll', ref: docRef, onMouseUp: onMouseUp },
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
              }))
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
          h('div', { className: 'dr-notes-scroll' },
            comments.length === 0 ? h('div', { className: 'dr-hint' }, '还没有批注。在中间正文里划词，然后写意见。') : null,
            comments.map(function (c, i) {
              var head = c.lineStart ? ('L' + c.lineStart + (c.lineEnd && c.lineEnd !== c.lineStart ? '–L' + c.lineEnd : '')) : '全文'
              return h('div', { key: c.id, className: 'dr-card dr-card-' + c.status },
                h('div', { className: 'dr-card-head' },
                  h('span', { className: 'dr-card-no' }, '#' + (i + 1)),
                  h('span', { className: 'dr-card-loc', onClick: function () { scrollToLine(c.lineStart) } }, head),
                  c.anchored === false ? h('span', { className: 'dr-status dr-status-orphan', title: '这段原文在文档里已经找不到（被改掉或删掉）。批注按规范保留不删，请人工确认。' }, '已失锚') : null,
                  h('span', { className: 'dr-spacer' }),
                  h('span', { className: 'dr-status dr-status-' + c.status }, c.status === 'pending' ? '待处理' : (c.status === 'resolved' ? '已处理' : '不改'))),
                c.quote ? h('div', { className: 'dr-card-quote', title: c.quote }, c.quote) : null,
                h('textarea', {
                  className: 'dr-textarea', rows: 3, value: c.note, placeholder: '写你的修改意见…',
                  onChange: function (e) { var v = e.target.value; setDoc(function (cur) { return cur ? Object.assign({}, cur, { review: Object.assign({}, cur.review, { comments: cur.review.comments.map(function (x) { return x.id === c.id ? Object.assign({}, x, { note: v }) : x }) }) }) : cur }) },
                  onBlur: function (e) { patchComment(c.id, { note: e.target.value }, true) },
                }),
                c.reply ? h('div', { className: 'dr-card-reply' }, 'AI：' + c.reply) : null,
                h('div', { className: 'dr-card-actions' },
                  c.status === 'pending'
                    ? h('button', { className: 'dr-btn dr-btn-mini', onClick: function () { patchComment(c.id, { status: 'resolved', resolvedAt: nowStamp() }, true) } }, '标为已处理')
                    : h('button', { className: 'dr-btn dr-btn-mini', onClick: function () { patchComment(c.id, { status: 'pending', resolvedAt: null }, true) } }, '退回待处理'),
                  h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { copyToClipboard('[' + c.id + '] ' + head + '\n原文：' + c.quote + '\n意见：' + c.note) } }, '复制'),
                  h('span', { className: 'dr-spacer' }),
                  h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', title: '删除', onClick: function () { removeComment(c.id) } }, '✕')))
            })),
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
            placeholder: '这条要怎么改？（Ctrl+Enter 保存）',
            onChange: function (e) { setDraft(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitSelection(); if (e.key === 'Escape') setSel(null) },
          }),
          h('div', { className: 'dr-float-actions' },
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', onClick: commitSelection }, '保存批注'),
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { setSel(null) } }, '取消')))
          : null)
    }

    function scrollToLine(ls) {
      if (!ls) return
      try {
        var els = document.querySelectorAll('.dr-block[data-ls]')
        for (var i = 0; i < els.length; i++) {
          var s = Number(els[i].getAttribute('data-ls')), e = Number(els[i].getAttribute('data-le'))
          if (ls >= s && ls <= e) { els[i].scrollIntoView({ block: 'center', behavior: 'smooth' }); return }
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
        '.dr-root{display:flex;gap:10px;padding:12px;box-sizing:border-box;min-height:600px;height:100%;font-size:13px;line-height:1.65;color:var(--dsw-alias-text-primary,#1b1b1b)}',
        '.dr-col{display:flex;flex-direction:column;min-height:0}',
        '.dr-col-docs{width:230px;flex:0 0 230px;gap:6px}',
        '.dr-col-doc{flex:1 1 auto;min-width:0;gap:6px}',
        '.dr-col-notes{width:330px;flex:0 0 330px;gap:6px}',
        '.dr-row{display:flex;align-items:center;gap:6px}',
        '.dr-spacer{flex:1 1 auto}',
        '.dr-hint{font-size:11px;opacity:.55;word-break:break-all}',
        '.dr-input{width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:inherit;font-size:12px}',
        '.dr-input-mini{width:72px}',
        '.dr-btn{padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08));color:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
        '.dr-btn:disabled{opacity:.42;cursor:default}',
        '.dr-btn-ghost{background:transparent}',
        '.dr-btn-on{background:rgba(64,120,255,.16);border-color:rgba(64,120,255,.45)}',
        '.dr-btn-mini{padding:2px 7px;font-size:11px}',
        '.dr-list{flex:1 1 auto;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:8px;min-height:120px}',
        '.dr-item{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.12));cursor:pointer}',
        '.dr-item:hover{background:var(--dsw-alias-bg-l2,rgba(127,127,127,.08))}',
        '.dr-item-on{background:var(--dsw-alias-bg-l2,rgba(64,120,255,.12))}',
        '.dr-item-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dr-item-sub{display:flex;gap:6px;font-size:10px;opacity:.6;align-items:center}',
        '.dr-badge-pending{color:#c9721a;font-weight:600}',
        '.dr-badge-session{color:#1d6b3a;font-weight:600}',
        // ★ 浮层是自带背景的小面板，文字色必须自己定死：主题里 --dsw-alias-text-primary 可能是浅色
        //   （blue-fantasy 就是浅色），一配上白底就成了白字白底。这里不再引用主题的文字变量。
        '.dr-pill{position:fixed;z-index:10000;padding:3px 10px;border-radius:999px;border:1px solid #1d4ed8;background:#2563eb;color:#fff;font-size:11px;font-family:inherit;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.28)}',
        '.dr-pill:hover{background:#1d4ed8}',
        '.dr-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:56px;z-index:10001;background:rgba(24,24,26,.94);color:#fff;font-size:12px;padding:7px 14px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.3);max-width:70vw}',
        '.dr-snote{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));padding:6px 8px;cursor:default}',
        '.dr-snote-q{font-size:11px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dr-snote-n{font-size:12px;margin-top:2px;word-break:break-word}',
        '.dr-snote-bar{display:flex;gap:6px;align-items:center;margin-top:3px}',
        '.dr-snote.on .dr-snote-n{text-decoration:line-through;opacity:.55}',
        '.dr-badge-project{color:#4a5fa8;font-weight:600}',
        '.dr-group{font-size:10px;opacity:.55;padding:6px 8px 2px;letter-spacing:.3px}',
        '.dr-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
        '.dr-title{font-weight:600;max-width:38%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dr-chip{font-size:11px;padding:1px 7px;border-radius:10px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.1))}',
        '.dr-chip-hi{background:rgba(255,168,0,.22);color:#8a5200;font-weight:600}',
        '.dr-chip-warn{background:rgba(255,80,80,.18);color:#a02020}',
        '.dr-doc-scroll{flex:1 1 auto;overflow:auto;padding:8px 18px 60px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:10px}',
        '.dr-block{position:relative;border-radius:6px;padding:1px 4px}',
        '.dr-block-pending{outline:1px dashed rgba(37,99,235,.55);outline-offset:1px}',
        // 建议模式：待审改动（红=原文、绿=拟改），颜色在两套主题下都要看得清，所以取中亮度色
        '.dr-props{border:1px solid rgba(37,99,235,.4);background:rgba(37,99,235,.07);border-radius:8px;padding:7px 8px;margin-bottom:8px;display:flex;flex-direction:column;gap:6px}',
        '.dr-props-head{display:flex;gap:6px;align-items:center}',
        '.dr-prop{border-top:1px solid rgba(127,127,127,.2);padding-top:5px;font-size:12px;display:flex;flex-direction:column;gap:3px}',
        '.dr-prop-loc{font-size:10px;opacity:.7}',
        '.dr-prop-old{background:rgba(220,38,38,.14);color:#ef4444;text-decoration:line-through;border-radius:4px;padding:1px 4px;word-break:break-word}',
        '.dr-prop-new{background:rgba(22,163,74,.16);color:#22c55e;border-radius:4px;padding:1px 4px;word-break:break-word}',
        '.dr-prop-bar{display:flex;gap:6px;align-items:center;margin-top:2px}',
        '.dr-inline-prop{margin:3px 0 5px 8px;padding:4px 7px;border-left:3px solid rgba(37,99,235,.65);background:rgba(37,99,235,.07);border-radius:0 6px 6px 0;font-size:12px;display:flex;flex-direction:column;gap:3px}',
        '.dr-inline-prop-t{display:flex;gap:4px;flex-wrap:wrap;align-items:baseline}',
        '.dr-block-hl{background:rgba(255,196,0,.13)}',
        '.dr-mark{position:absolute;right:2px;top:2px;font-size:10px;color:#b26b00;background:rgba(255,255,255,.75);border-radius:8px;padding:0 5px}',
        // 已处理批注的锚点：淡绿 + 虚线，仍留在正文里可召回（不当"消失的历史"）
        '.dr-mark-done{color:#15803d;background:rgba(22,163,74,.16);border-radius:8px;padding:0 3px;border-bottom:1px dashed rgba(22,163,74,.55)}',
        '.dr-h{font-weight:650;margin:.75em 0 .35em}',
        '.dr-h1{font-size:1.5em}.dr-h2{font-size:1.3em}.dr-h3{font-size:1.14em}.dr-h4,.dr-h5,.dr-h6{font-size:1em}',
        '.dr-p{margin:.42em 0}',
        '.dr-ul{margin:.35em 0 .35em 1.2em;padding:0}',
        '.dr-quote{margin:.45em 0;padding:.2em .8em;border-left:3px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));opacity:.85}',
        '.dr-pre{margin:.5em 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.1));overflow:auto;font-size:12px}',
        '.dr-table{border-collapse:collapse;margin:.5em 0;font-size:12px}',
        '.dr-table th,.dr-table td{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));padding:3px 7px;text-align:left}',
        '.dr-hr{border:0;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));margin:1em 0}',
        '.dr-empty{flex:1 1 auto;display:flex;align-items:center;justify-content:center;opacity:.5;padding:40px;text-align:center}',
        '.dr-notes-scroll{flex:1 1 auto;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:2px}',
        '.dr-card{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:9px;padding:7px 8px;display:flex;flex-direction:column;gap:5px}',
        '.dr-card-resolved{opacity:.6}',
        '.dr-card-wontfix{opacity:.45}',
        '.dr-card-head{display:flex;align-items:center;gap:6px;font-size:11px}',
        '.dr-card-no{font-weight:700}',
        '.dr-card-loc{cursor:pointer;text-decoration:underline dotted;opacity:.8}',
        '.dr-status{font-size:10px;padding:1px 6px;border-radius:8px;background:var(--dsw-alias-bg-l2,rgba(127,127,127,.12))}',
        '.dr-status-pending{background:rgba(255,168,0,.22);color:#8a5200}',
        '.dr-status-resolved{background:rgba(80,190,120,.22);color:#1d6b3a}',
        '.dr-status-orphan{background:rgba(230,70,70,.2);color:#a02020}',
        '.dr-card-quote{font-size:11px;opacity:.75;max-height:56px;overflow:hidden;border-left:2px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));padding-left:6px;white-space:pre-wrap}',
        '.dr-card-reply{font-size:11px;color:#1d6b3a;background:rgba(80,190,120,.12);border-radius:6px;padding:3px 6px}',
        '.dr-card-actions{display:flex;align-items:center;gap:5px}',
        '.dr-textarea{width:100%;box-sizing:border-box;padding:5px 7px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:inherit;font-size:12px;font-family:inherit;resize:vertical}',
        '.dr-global{margin-top:auto}',
        '.dr-error{color:#c0392b;font-size:12px}',
        '.dr-msg{font-size:12px;color:#1d6b3a;background:rgba(80,190,120,.13);border-radius:6px;padding:4px 8px;cursor:pointer}',
        '.dr-float{position:fixed;z-index:9999;width:280px;box-sizing:border-box;background:#fff;border:1px solid rgba(0,0,0,.16);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.24);padding:8px;display:flex;flex-direction:column;gap:6px;color:#1b1b1b}',
        '.dr-float-head{display:flex;gap:6px;align-items:baseline;min-width:0}',
        '.dr-float-quote{font-size:10px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}',
        '.dr-float-loc{font-size:10px;color:#6b7280;flex:none}',
        '.dr-float .dr-btn{background:#f3f4f6;color:#1b1b1b;border:1px solid rgba(0,0,0,.14)}',
        '.dr-float .dr-btn-primary{background:#2563eb;color:#fff;border:1px solid #1d4ed8}',
        '::highlight(dr-pending){background:rgba(255,196,0,.45);}',
        '.dr-float-input{width:100%;box-sizing:border-box;border:1px solid rgba(0,0,0,.18);border-radius:7px;padding:5px 7px;font-size:12px;font-family:inherit;background:#fff;color:#1b1b1b;resize:vertical}',
        '.dr-float-input::placeholder{color:#9aa0a6}',
        '.dr-float-actions{display:flex;gap:6px;justify-content:flex-end}',
        '.dr-boundary{padding:24px;color:#c0392b;font-size:12px;overflow:auto}',
      ].join('\n')
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = css
      document.head.appendChild(el)
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

      var selTextRef = useRef('')

      useEffect(function () {
        function onUp() {
          var q = readSelection()
          if (!q) return
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

      if (!sel) return toast ? h('div', { className: 'dr-toast' }, toast) : null

      var vw = window.innerWidth || 1200
      var vh = window.innerHeight || 800
      var pillLeft = Math.min(Math.max(sel.rect.right + 6, 8), Math.max(8, vw - 76))
      var pillTop = Math.min(Math.max(sel.rect.top - 4, 8), Math.max(8, vh - 32))

      var pillNode = h('button', {
        className: 'dr-pill', style: { left: pillLeft + 'px', top: pillTop + 'px' },
        title: '给选中的这段写批注（“' + sel.text.replace(/\s+/g, ' ').slice(0, 40) + '”）。快捷键 Ctrl+Shift+M；保存后会直接写进聊天输入框',
        onMouseDown: function (e) { e.preventDefault(); setOpen(true) },
      }, '批注')

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
            placeholder: '对这段有什么意见？（Ctrl+Enter 保存）',
            onChange: function (e) { setDraft(e.target.value) },
            onKeyDown: function (e) {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
              if (e.key === 'Escape') { setOpen(false); setSel(null) }
            },
          }),
          h('div', { className: 'dr-float-actions' },
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-primary', onClick: save }, '保存批注'),
            h('button', { className: 'dr-btn dr-btn-mini dr-btn-ghost', onClick: function () { setOpen(false); setSel(null) } }, '取消')))
      }

      return h('div', null, pillNode, composer, toast ? h('div', { className: 'dr-toast' }, toast) : null)
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
