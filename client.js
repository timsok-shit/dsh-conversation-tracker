// dsh-conversation-tracker — DSH Web Conversation Navigator（对话追踪导航条）。
//
// 语义（严格约束）：
//   - 每一条 user message = 1 个导航节点；assistant message = 0 个节点。
//   - 节点直接来自当前 conversation 的完整 messages 数据（runtime Conversation
//     Snapshot），即 messages.filter(kind user/steering).map(node)——绝不依赖
//     DOM 扫描来数消息，绝不依赖 DOM index，绝不在 mount 时只初始化一次。
//   - 即使历史消息当前不在 DOM（虚拟化 / 分页未加载），Navigator 仍保留节点。
//   - 切换 conversation 时重新绑定当前会话的完整 user-message 节点，不混入
//     其他会话的消息。
//   - 定位依据是官方持久锚 key（data-chat-anchor-key = conversation node key），
//     禁止依赖 DOM index；DOM 只承担"节点 ↔ 已渲染行"的关联映射。
//
// 交互模型：
//   - 节点容器条默认紧凑收缩；查看（hover / focus / touch / 拖动）时展开，
//     结束查看后恢复收缩（只作用于容器层，节点圆点样式不变）。
//   - 节点在轨道内固定等距（仅由序号决定），与消息内容高度/对话间距无关；
//     滚动、流式回复增长、消息折叠都不会移动节点。
//   - 默认只显示节点（小圆点），永不常显文字。
//   - 仅 hover / focus / touch / drag 到某节点时，按需显示该节点的 preview
//     （卡片直接显示/隐藏，无形变中间态、无细线残留）。
//   - preview 完全本地生成（来源 = 用户原文的结构化 content blocks + 本地
//     markdown 控制符剥离），禁 AI 总结/改写/LLM。
//   - 点击节点 → 平滑滚动定位到对应 user message（放视口偏上、保留下文响应），
//     并同步 active 节点；跳转后短暂锁定 active，滚动途中不被 IO 抢占。
//   - 正常滚动 → IntersectionObserver 同步 active 节点（不在每个 scroll 事件
//     里重算整个 conversation）。
//   - 设置页/全屏模态层打开时整层隐藏（遮挡检测 + 模态信号），绝不显示在其之上。
//
// 数据链路（运行时 API，非 React 侧）：
//   ctx.sessions
//     .list.getSnapshot().current            → 当前会话 id
//     .binding(id).session                   → SessionFace（会话快照源）
//     .getSnapshot()                         → ConversationSnapshot
//        .chat.order + .chat.nodes.get(key)  → 全量节点（含 user/assistant/...）
//        .chat.nodes.values()                → 节点集合（无顺序保证，用 order）
//     .subscribe(fn)                         → 数据变化通知（新消息/分页/切换）
//   SessionFace 节点：kind='user'（seq 为稳定身份，无独立 messageId 字段）、
//   kind='steering'（带 messageId）。key == 渲染行的 data-chat-anchor-key。
//
// 性能：
//   - 节点位置 = 等距槽位（仅序号决定），与布局无关 → 滚动/流式不移动节点；
//     scroll 只切换 class，绝不重渲染节点。
//   - preview 单例卡片按需填充；节点零独立监听（事件全部委托在轨道上）。
//   - 数据快照在流式期间高频变化，但 user 节点签名（key+messageId）不变时只做
//     DOM 关联刷新（不重建 preview / 不重算文本），经 rAF 节流合并到单次 render。
//   - 拖动映射按等距序号 O(1) 计算；不逐帧做完整 DOM 查询。
//   - 无 DOM 元素（虚拟化窗口外）的节点保留在导航条，等距布局天然可用。
window.__ModuleLoader__.load({
  // id 必须与 package.json "name" 完全一致。
  id: 'dsh-conversation-tracker',
  factory: () => {
    var STYLE_ID = 'dsh-conversation-tracker-style'

    // ------------------------------------------------------------------
    // 样式：全部复用 DSW 主题变量，不引入独立设计系统。
    // ------------------------------------------------------------------
    var CSS = [
      '[data-dsh-conv-tracker], [data-dsh-conv-tracker] * { box-sizing: border-box; }',
      '[data-dsh-conv-tracker] { all: initial; position: fixed; z-index: 800; width: 0; height: 0;',
      '  font-family: var(--dsw-font-family, system-ui); color: var(--dsw-alias-label-primary);',
      '  -webkit-user-select: none; user-select: none; touch-action: none; }',
      /* 设置页 / 全屏模态层打开时：整层隐藏，绝不显示在其之上 */
      '[data-dsh-conv-tracker].dct-layer-hidden { display: none !important; }',

      /* 轨道：细长竖条，位于聊天区左侧沟槽；背景恒定极淡（hover 不突变、不形成细线观感） */
      '.dct-track { position: absolute; left: 100%; top: 0; bottom: 0; width: 14px;',
      '  margin-left: 10px; cursor: pointer; }',
      '.dct-track::before { content: ""; position: absolute; inset: 0 -4px; border-radius: 999px;',
      '  background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.18));',
      '  opacity: .55; transition: opacity .18s ease, background .18s ease; }',
      '.dct-track:hover::before { opacity: .9; }',
      '.dct-track.dct-dragging::before { opacity: 1;',
      '  box-shadow: 0 0 0 1px var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }',

      /* 容器状态：collapsed（默认，紧凑）→ expanded（查看时）；只作用于容器层，节点样式不变 */
      '[data-dsh-conv-tracker][data-dct-state="collapsed"] .dct-track::before { opacity: .3; }',
      '[data-dsh-conv-tracker][data-dct-state="collapsed"] .dct-node { opacity: .35; }',
      '[data-dsh-conv-tracker][data-dct-state="expanded"] .dct-track::before { opacity: .55; }',

      /* 节点：默认小圆点，不显示任何文字（视觉样式保持圆点，永不改胶囊） */
      '.dct-node { position: absolute; left: 50%; width: 7px; height: 7px; border-radius: 999px;',
      '  transform: translateX(-50%); background: var(--dsw-alias-state-business-primary, #6c8cff);',
      '  opacity: .55; transition: opacity .1s ease, transform .1s ease, box-shadow .1s ease; }',
      '.dct-node.dct-active { opacity: 1; transform: translateX(-50%) scale(1.4);',
      '  box-shadow: 0 0 0 3px var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.25)); }',
      '.dct-node.dct-hover, .dct-node.dct-target { opacity: 1; transform: translateX(-50%) scale(1.55);',
      '  box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1, rgba(255,255,255,.9)); }',
      /* 触摸命中区扩展（视觉不变，实际 touch target 足够大） */
      '.dct-node::after { content: ""; position: absolute; left: 50%; top: 50%; width: 24px; height: 24px;',
      '  transform: translate(-50%, -50%); }',

      /* 密集模式：大量节点时压缩视觉并降低非关键节点权重 */
      '.dct-track.dct-dense .dct-node { width: 3px; height: 3px; border-radius: 2px; opacity: .35; }',
      '.dct-track.dct-dense .dct-node.dct-active, .dct-track.dct-dense .dct-node.dct-hover,',
      '.dct-track.dct-dense .dct-node.dct-target { width: 8px; height: 8px; border-radius: 999px; opacity: 1; }',

      /* Preview 摘要卡片：显示/隐藏用 display + 轻量淡入/上移，绝无宽高形变、绝无细条中间态 */
      '.dct-pv { position: absolute; z-index: 20; display: none; width: min(320px, calc(100vw - 24px));',
      '  min-width: 160px; background: var(--dsw-specific-menu, #2c2c2e);',
      '  border: 1px solid var(--dsw-alias-border-inverted); border-radius: 12px;',
      '  box-shadow: var(--dsw-shadow-lv3); overflow: hidden;',
      '  pointer-events: none; animation: dct-pv-in .1s var(--ds-ease-in-out, ease); }',
      '@keyframes dct-pv-in { from { opacity: 0; transform: translateY(2px); }',
      '  to { opacity: 1; transform: none; } }',
      '.dct-pv-inner { padding: 8px 10px; font-size: 12px; line-height: 18px;',
      '  color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; word-break: break-word;',
      '  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }',
      '.dct-pv.dct-pv-empty .dct-pv-inner { -webkit-line-clamp: 1; color: var(--dsw-alias-label-tertiary); }',

      /* 触屏：无 hover，底色更淡；hit area 保持 */
      '@media (pointer: coarse) {',
      '  .dct-track { width: 16px; }',
      '  .dct-track::before { inset: 0 -3px; }',
      '}',
    ].join('\n')

    function injectCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      var tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------------
    // 状态
    // ------------------------------------------------------------------
    var state = {
      sessions: null,       // ctx.sessions（数据层入口）
      currentSessionId: null,
      session: null,        // SessionFace（ObservableSnapshot<ConversationSnapshot>）
      listUnsub: null,      // sessions.list 订阅（会话切换）
      sessionUnsub: null,   // 当前会话 snapshot 订阅（数据变化）
      lastDataSig: '',      // user 节点签名（避免流式期间无谓重建）
      scrollport: null,     // [data-conversation-scroll]
      rows: [],             // [{ id, key, messageId, index, el, top, previewText }]
      byId: {},             // id -> node
      domByKey: null,       // key -> row element（当前 DOM 关联）
      hostEl: null,
      trackEl: null,
      pvEl: null,
      pvBodyEl: null,
      activeNodeId: null,
      hoveredNodeId: null,
      previewNodeId: null,
      dragging: false,
      targetNodeId: null,
      dragMoved: false,
      dragPointerId: null,
      dense: false,
      rafPending: false,
      dragRafPending: false,
      hoverRafPending: false,
      activeLockUntil: 0,   // 程序滚动（点击/拖动定位）期间 IO 不改 active
      lastFlowHeight: 0,
      expanded: false,      // 容器展开状态（默认 false = 紧凑收缩）
      expandedByTouch: false, // 触屏下由指针按下/移动进入的展开，离开规则不同
      collapseTimer: null,  // 离开容器后的收缩定时器
      layerHidden: false,   // 设置页/全屏模态层打开时所处的隐藏态
      layerRafPending: false,
      layerTimer: null,     // 周期遮挡探测定时器
      io: null,
      ioMap: new Map(),     // row element -> nodeId
      dotMap: new Map(),    // nodeId -> dot element
      mutationObserver: null,
      resizeObserver: null,
      resizeObserverTarget: null,
      disposed: false,
    }

    // ------------------------------------------------------------------
    // 工具：本地文本处理（禁 AI）
    // ------------------------------------------------------------------
    function cleanLine(s) {
      return String(s)
        .replace(/\u200b|\u200c|\u200d|\ufeff/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
    }

    // 保留段落结构：折叠行内空白，并只保留单个空行，不再把整段压成一句。
    function cleanText(s) {
      var lines = String(s).split('\n')
      var out = []
      for (var i = 0; i < lines.length; i++) {
        var line = cleanLine(lines[i])
        if (line === '') {
          if (i > 0 && out.length > 0 && out[out.length - 1] !== '') out.push('')
        } else {
          out.push(line)
        }
      }
      while (out.length > 0 && out[out.length - 1] === '') out.pop()
      return out.join('\n')
    }

    // 剥离 markdown 控制符、保留实际文字（纯本地；不重排语序、不总结）。
    function stripMarkdown(s) {
      return String(s)
        .replace(/```[\s\S]*?```/g, ' ')            // 代码块整块（规则 3：不显示完整代码块）
        .replace(/`([^`\n]*)`/g, '$1')              // inline code 去反引号
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')   // 图片语法 → alt 文字
        .replace(/\[([^\]]*)\]\([^)]*\)/g, function (_, label) { return String(label || '').trim() !== '' ? label : '' })
        .replace(/^#{1,6}\s+/gm, '')                // 标题符
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // 粗体
        .replace(/(^|[\s*_])\*([^*\n]+)\*/g, '$1$2')     // 斜体
        .replace(/(^|[\s_])\_([^_\n]+)\_/g, '$1$2')
        .replace(/~~(.*?)~~/g, '$1')                // 删除线
        .replace(/^\s*>\s?/gm, '')                  // 引用符
        .replace(/^\s*[-+*]\s+/gm, '')              // 无序列表符
        .replace(/^\s*\d+[.)]\s+/gm, '')            // 有序列表符
    }

    // 结构化 ContentBlock[] → preview 文本（规则 1～10）
    // 注意：DSH 实际 content block 使用 `type` 字段（text/image/tool-call/...），
    // 同时兼容旧数据里的 `kind`。
    function previewFromContent(blocks) {
      if (typeof blocks === 'string') {
        var s = cleanText(stripMarkdown(blocks))
        return s !== '' ? s : '[无文本内容]'
      }
      var list = blocks || []
      var texts = []
      var imgCount = 0
      var otherCount = 0
      for (var i = 0; i < list.length; i++) {
        var b = list[i]
        if (!b) continue
        if (typeof b === 'string') {
          if (b.trim() !== '') texts.push(b)
          continue
        }
        var bt = b.type || b.kind || ''
        if (bt === 'text') {
          var txt = typeof b.text === 'string' ? b.text : ''
          if (txt === '' && typeof b.content === 'string') txt = b.content
          if (txt.trim() !== '') texts.push(txt)
        } else if (bt === 'image' || bt === 'image_url' || bt === 'img') {
          imgCount++
        } else if (bt === 'tool-call' || bt === 'tool_call' || bt === 'tool' ||
                   bt === 'tool-result' || bt === 'tool_result' ||
                   bt === 'attachment' || bt === 'file' || bt === 'other') {
          otherCount++
        }
      }
      var text = cleanText(stripMarkdown(texts.join('\n\n')))
      if (text !== '') {
        // 规则 10：文字存在 → 优先显示用户文字，必要时补充附件标识
        var prefix = ''
        if (imgCount > 0) prefix = '[图片] '
        else if (otherCount > 0) prefix = '[附件] '
        var combined = prefix + text
        return combined.length > 240 ? combined.slice(0, 240) + '…' : combined
      }
      if (imgCount > 0) return '[图片]'                       // 规则 4
      if (otherCount > 0) return '[附件]'                     // 规则 5（数据层无文件名时）
      return '[无文本内容]'                                    // 规则 9
    }

    // ------------------------------------------------------------------
    // 数据层：从当前 conversation 的完整 messages 数据构建节点
    // ------------------------------------------------------------------
    var USER_KINDS = { user: 1, steering: 1 }

    function dataSignature(rows) {
      var out = []
      for (var i = 0; i < rows.length; i++) out.push(rows[i].key + ':' + rows[i].messageId + ':' + rows[i].previewText.length)
      return out.join('|')
    }

    // 依据 ConversationSnapshot 构建导航节点（不依赖 DOM 计数；DOM 只做关联）
    function buildDataNodes(snapshot) {
      var chat = snapshot && snapshot.chat
      var order = chat && chat.order && chat.order.length ? chat.order : null
      var nodes = []
      if (chat && chat.nodes && order) {
        for (var i = 0; i < order.length; i++) {
          var vn = chat.nodes.get(order[i])
          if (!vn) continue
          if (!(vn.kind === 'user' || vn.kind === 'steering')) continue // assistant 等 → 0 节点
          if (vn.visibility === 'hidden') continue
          var data = vn.data || {}
          var messageId = data.messageId !== undefined && data.messageId !== null
            ? String(data.messageId)
            : String(data.seq !== undefined ? data.seq : (vn.anchorSeq !== undefined ? vn.anchorSeq : i))
          nodes.push({
            id: 'dct-' + vn.key,
            key: vn.key,
            messageId: messageId,
            index: nodes.length,
            el: null,
            top: 0,
            previewText: previewFromContent(data.content),
          })
        }
      }
      return nodes
    }

    // 从 sessions 服务解析当前会话的 SessionFace
    function resolveSession(sessions) {
      if (!sessions) return null
      var list = sessions.list
      var current
      try { current = list && list.getSnapshot ? list.getSnapshot().current : undefined } catch (_) { current = undefined }
      if (current === undefined || current === null) return null
      try {
        var binding = sessions.binding(current)
        if (binding && binding.session) return { id: current, session: binding.session }
      } catch (_) {}
      try {
        var scoped = sessions.scope(current)
        if (scoped) {
          var face = sessions.sessionOf(scoped)
          if (face) return { id: current, session: face }
        }
      } catch (_) {}
      return null
    }

    // 订阅当前会话快照（数据变化 → 重建节点）
    function subscribeCurrentSession() {
      if (state.sessionUnsub) { try { state.sessionUnsub() } catch (_) {} state.sessionUnsub = null }
      var resolved = resolveSession(state.sessions)
      state.currentSessionId = resolved ? resolved.id : null
      state.session = resolved ? resolved.session : null
      if (resolved && resolved.session && typeof resolved.session.subscribe === 'function') {
        state.sessionUnsub = resolved.session.subscribe(function () {
          scheduleLayout()
        })
      }
      // 强制按"完整数据"重建（切换会话必须重绑，旧节点清空）
      state.lastDataSig = ''
      scheduleLayout()
    }

    // 会话切换（conversation 变化 → 重新绑定，绝不混入其他会话消息）
    function onSessionChange() {
      subscribeCurrentSession()
    }

    function attachData(sessions) {
      if (!sessions || !sessions.list) return
      state.sessions = sessions
      if (typeof sessions.list.subscribe === 'function') {
        state.listUnsub = sessions.list.subscribe(onSessionChange)
      }
      subscribeCurrentSession()
    }

    function detachData() {
      if (state.sessionUnsub) { try { state.sessionUnsub() } catch (_) {} state.sessionUnsub = null }
      if (state.listUnsub) { try { state.listUnsub() } catch (_) {} state.listUnsub = null }
      state.sessions = null
      state.session = null
      state.currentSessionId = null
    }

    // ------------------------------------------------------------------
    // DOM 契约：滚动容器 + 消息行关联（不用于数消息，只用于节点↔行映射）
    // ------------------------------------------------------------------
    function collectDomRows(scrollport) {
      var map = new Map()
      if (!scrollport) return map
      var list = scrollport.querySelectorAll('[data-chat-anchor-key]')
      for (var i = 0; i < list.length; i++) {
        var key = list[i].getAttribute('data-chat-anchor-key')
        if (key !== '' && key !== null && !map.has(key)) map.set(key, list[i])
      }
      // focus-chat 视图回退（可选插件）：数据流挂 [data-focus-flow]
      if (map.size === 0) {
        var flow = scrollport.querySelector('[data-focus-flow]')
        if (flow !== null) {
          var fList = flow.querySelectorAll('[data-focus-anchor-key], [data-chat-anchor-key]')
          for (var j = 0; j < fList.length; j++) {
            var key2 = fList[j].getAttribute('data-focus-anchor-key') || fList[j].getAttribute('data-chat-anchor-key')
            if (key2 && !map.has(key2)) map.set(key2, fList[j])
          }
        }
      }
      return map
    }

    function resolveView() {
      var scrollports = document.querySelectorAll('[data-conversation-scroll]')
      var best = null
      for (var i = 0; i < scrollports.length; i++) {
        var sp = scrollports[i]
        if (sp.getBoundingClientRect().width === 0) continue
        best = sp
        break
      }
      return best || (scrollports.length > 0 ? scrollports[0] : null)
    }

    // 读取 AppFrame 的 grid 首列宽（侧边栏列）并返回其视口右缘。
    // 找不到时返回 null，调用方回退为"聊天区左缘 + 6px"。
    function getSidebarRightEdge() {
      var overlay = document.querySelector('[data-shell-overlay]')
      var frame = overlay ? overlay.parentElement : null
      if (!frame) return null
      var grid = ''
      try { grid = frame.style.gridTemplateColumns || getComputedStyle(frame).gridTemplateColumns || '' } catch (_) { grid = '' }
      var m = /^\s*(-?\d+(?:\.\d+)?)px/.exec(grid)
      if (!m) return null
      var w = parseFloat(m[1])
      if (!(w >= 0)) return null
      try {
        var r = frame.getBoundingClientRect()
        return r.left + w
      } catch (_) { return null }
    }

    // ------------------------------------------------------------------
    // UI 构建
    // ------------------------------------------------------------------
    function buildHost() {
      var host = document.createElement('div')
      host.setAttribute('data-dsh-conv-tracker', '')
      host.style.display = 'none'

      var track = document.createElement('div')
      track.className = 'dct-track'
      host.appendChild(track)

      var pv = document.createElement('div')
      pv.className = 'dct-pv'
      pv.style.display = 'none'
      var pvBody = document.createElement('div')
      pvBody.className = 'dct-pv-inner'
      pv.appendChild(pvBody)
      host.appendChild(pv)

      document.body.appendChild(host)

      state.hostEl = host
      state.trackEl = track
      state.pvEl = pv
      state.pvBodyEl = pvBody
      // 默认紧凑收缩（容器状态），节点样式不变
      host.setAttribute('data-dct-state', 'collapsed')

      track.addEventListener('pointerdown', onPointerDown)
      track.addEventListener('pointermove', onPointerMove)
      track.addEventListener('pointerup', onPointerUp)
      track.addEventListener('pointercancel', onPointerUp)
      track.addEventListener('pointerleave', onPointerLeave)
      track.addEventListener('pointerenter', onTrackEnter)
      track.addEventListener('focusin', onTrackFocusIn)
      track.addEventListener('focusout', onTrackFocusOut)
    }

    // ---- 容器展开/收缩（collapsed ↔ expanded）----
    function expandContainer() {
      clearCollapseTimer()
      if (state.expanded) return
      state.expanded = true
      if (state.hostEl) state.hostEl.setAttribute('data-dct-state', 'expanded')
    }

    function collapseContainer() {
      if (state.dragging) return // 拖动中不收缩
      if (!state.expanded) return
      state.expanded = false
      state.expandedByTouch = false
      if (state.hostEl) state.hostEl.setAttribute('data-dct-state', 'collapsed')
      // 收缩即视为"结束查看"：清理 hover 与摘要，恢复紧凑
      setHover(null)
    }

    function clearCollapseTimer() {
      if (state.collapseTimer) { clearTimeout(state.collapseTimer); state.collapseTimer = null }
    }

    function scheduleCollapse(delay) {
      clearCollapseTimer()
      if (state.dragging) return
      state.collapseTimer = setTimeout(function () {
        state.collapseTimer = null
        collapseContainer()
      }, delay || 220)
    }

    function onTrackEnter() {
      // 桌面悬停进入容器区域 → 展开
      if (window.matchMedia && window.matchMedia('(hover: hover)').matches) expandContainer()
    }

    // ------------------------------------------------------------------
    // 渲染：full（数据+DOM 全重建） / dom（仅 DOM 关联与位置刷新）
    // ------------------------------------------------------------------
    function scheduleLayout() {
      if (state.rafPending || state.disposed) return
      state.rafPending = true
      requestAnimationFrame(function () {
        state.rafPending = false
        if (state.disposed) return
        render('full')
      })
    }

    function scheduleDomSync() {
      if (state.rafPending || state.disposed) return
      state.rafPending = true
      requestAnimationFrame(function () {
        state.rafPending = false
        if (state.disposed) return
        render('dom')
      })
    }

    function render(mode) {
      var sp = resolveView()
      state.scrollport = sp
      ensureResizeObserver(sp)
      var host = state.hostEl

      // ---- 数据节点（数据层优先；异常时退 DOM 扫描兜底）----
      var dataNodes = null
      if (state.session) {
        try {
          var snap = state.session.getSnapshot()
          dataNodes = buildDataNodes(snap)
        } catch (_) { dataNodes = null }
      }
      if ((dataNodes === null || dataNodes.length === 0) && state.session !== null) {
        dataNodes = buildDataNodes(null) // 空会话：无 user 消息
      }

      // ---- DOM 关联 ----
      state.domByKey = collectDomRows(sp)

      if (mode === 'full') {
        var sig = dataNodes ? dataSignature(dataNodes) : ''
        if (sig === state.lastDataSig) mode = 'dom' // 数据未变 → 只刷 DOM 关联
        else state.lastDataSig = sig
      }

      if (dataNodes !== null) {
        // 节点数据来自当前会话快照
        var rows = dataNodes
        for (var i = 0; i < rows.length; i++) {
          rows[i].el = state.domByKey.get(rows[i].key) || null
        }
        state.rows = rows
      } else if (mode === 'full') {
        // 兜底：数据层不可用（无 ctx.sessions 的极端环境）→ DOM 扫描（不数消息，
        // 仅保底运行；正常 DSH 环境不会走到这里）
        state.rows = fallbackDomRows(sp)
        for (var f = 0; f < state.rows.length; f++) state.rows[f].el = state.rows[f].el || state.domByKey.get(state.rows[f].key) || null
      } else {
        state.rows = state.rows || []
      }

      var rows2 = state.rows
      state.byId = {}
      for (var b = 0; b < rows2.length; b++) state.byId[rows2[b].id] = rows2[b]

      if (!sp || rows2.length === 0) {
        host.style.display = 'none'
        hidePreview()
        state.ioMap = new Map()
        disconnectIo()
        return
      }

      var spRect = sp.getBoundingClientRect()
      // 轨道高度随节点数量自适应：节点少则短、节点多则长，封顶后间距自动压缩。
      // 每节点槽位 ≈ 紧凑间距 12px；上限 = 聊天可视区高度。
      var maxTrackH = Math.max(40, Math.min(sp.clientHeight - 24, window.innerHeight - 32))
      var SLOT_PX = 12
      var trackH = Math.min(maxTrackH, Math.max(40, rows2.length * SLOT_PX + 8))
      var trackTop = Math.max(8, spRect.top + Math.max(0, (sp.clientHeight - trackH) / 2))
      host.style.top = trackTop + 'px'
      host.style.height = trackH + 'px'
      host.style.display = 'block'

      // 水平定位：不再把轨道塞进侧边栏（旧逻辑 spRect.left-48 会压到侧边栏里）。
      // 优先取 AppFrame 的 grid 列宽算出侧边栏右缘，再把轨道放在聊天区内侧
      // 的 padding 沟槽里；这样默认轨道、展开卡片都不会与侧边栏重叠。
      var sidebarRight = getSidebarRightEdge()
      var left = Math.max(sidebarRight !== null ? sidebarRight + 6 : 6, spRect.left + 6)
      host.style.left = left + 'px'

      // 节点布局：固定等距（仅由序号决定），与消息内容高度/对话间距完全无关。
      // 节点列只表达"第 N 条 user message 的顺序"；滚动、流式回复增长、消息
      // 折叠都不会移动任何节点（"乱飘/长横条"的根源解除）。node.top 不再用于
      // 轨道布局；仅保留行级 DOM 关联（collectDomRows/el）供跳转与 active 同步。
      var contentH = Math.max(1, sp.scrollHeight)
      state.lastFlowHeight = contentH
      var n = Math.max(1, rows2.length)
      var dotY = function (v) { return (trackH * (v + 0.5)) / n }

      // 稀疏/密集视觉模式
      state.dense = rows2.length > 160
      if (state.dense) state.trackEl.classList.add('dct-dense')
      else state.trackEl.classList.remove('dct-dense')

      // 节点 diff 重建：数据未变时复用既有 dot（避免闪烁、保持 hover/焦点），
      // 等距位置由序号决定，数量不变时位置恒定，几乎不需要更新。
      var frag = document.createDocumentFragment()
      for (var v = 0; v < rows2.length; v++) {
        var nd = rows2[v]
        // 等距位置直接使用槽位公式（不截断，保持与 nodeAtClientY / nodeSlotY 一致，
        // 否则最后节点压边会与 hover/拖动映射错位）
        var topPx = dotY(v) + 'px'
        var prev = state.dotMap.get(nd.id)
        if (prev && prev.parentNode === state.trackEl) {
          if (prev.style.top !== topPx) prev.style.top = topPx
          frag.appendChild(prev)
          continue
        }
        var dot = document.createElement('div')
        dot.className = 'dct-node dct-user'
        dot.dataset.id = nd.id
        dot.setAttribute('tabindex', '0')
        dot.setAttribute('role', 'button')
        dot.setAttribute('aria-label', '第 ' + (v + 1) + ' 条提问：' + nd.previewText)
        dot.style.top = topPx
        frag.appendChild(dot)
      }
      // 移除不再存在的旧 dot（保留节点先 detach 再整体重挂，避免 textContent 全清）
      var keep = new Set()
      var fragKids = frag.children
      for (var kk = 0; kk < fragKids.length; kk++) keep.add(fragKids[kk])
      var oldKids = Array.prototype.slice.call(state.trackEl.children)
      for (var oo = 0; oo < oldKids.length; oo++) if (!keep.has(oldKids[oo])) oldKids[oo].remove()
      state.trackEl.appendChild(frag)

      state.dotMap = new Map()
      var dots = state.trackEl.children
      for (var d = 0; d < dots.length; d++) state.dotMap.set(dots[d].dataset.id, dots[d])

      // active / hover / target 恢复
      if (mode === 'full') {
        // 重建后：旧 active 若仍存在保留，否则重置
        if (state.activeNodeId && !state.byId[state.activeNodeId]) state.activeNodeId = null
      }
      applyNodeStates(true)

      // IntersectionObserver：只观察有 DOM 元素的行
      reconnectIo(sp, rows2)

      // 若 preview 正打开（hover/focus/drag 持续中）：节点消失则隐藏，否则保持
      // 现状（showPreview 对"同节点无变化"幂等返回，不重建卡片、不重放动画 →
      // 消除光标不动时的亮灭闪烁）
      if (state.previewNodeId && !state.dragging) {
        if (!state.byId[state.previewNodeId]) hidePreview()
        else showPreview(state.previewNodeId, dotOf(state.previewNodeId))
      }

      // 遮挡/设置层探测并入帧调度
      scheduleLayerCheck()
    }

    // 兜底：纯 DOM 扫描构造节点（仅在数据层完全不可用时）
    function fallbackDomRows(sp) {
      var rows = []
      var list = sp ? sp.querySelectorAll('[data-chat-flow-kind]') : []
      for (var i = 0; i < list.length; i++) {
        var el = list[i]
        if (el.hasAttribute('data-turn-tail')) continue
        var kind = el.getAttribute('data-chat-flow-kind')
        if (!Object.prototype.hasOwnProperty.call(USER_KINDS, kind)) continue
        var key = el.getAttribute('data-chat-anchor-key') || el.getAttribute('data-chat-flow-key') || ('fallback-' + i)
        rows.push({
          id: 'dct-' + key,
          key: key,
          messageId: key,
          index: rows.length,
          el: el,
          top: 0,
          previewText: extractPreviewDom(el),
        })
      }
      return rows
    }

    // DOM 兜底 preview（与 v0.2 相同规则；仅 fallback 路径使用）
    function extractPreviewDom(el) {
      var bubble = null
      var list = el.querySelectorAll('[class*="bubble"]')
      if (list.length > 0) bubble = list[list.length - 1]
      var imgs = el.querySelectorAll('img')
      var imgCount = 0
      for (var i = 0; i < imgs.length; i++) {
        if ((imgs[i].getAttribute('src') || '') !== '') imgCount++
      }
      var text = ''
      if (bubble) {
        var tmp = bubble.cloneNode(true)
        var codeEls = tmp.querySelectorAll('pre, code')
        for (var k = 0; k < codeEls.length; k++) (codeEls[k].parentNode || tmp).removeChild(codeEls[k])
        text = cleanText(stripMarkdown(tmp.textContent || ''))
      }
      if (text !== '') return imgCount > 0 ? '[图片] ' + text : text
      if (imgCount > 0) return '[图片]'
      return '[无文本内容]'
    }

    function applyNodeStates(force) {
      if (!state.trackEl) return
      var dots = state.trackEl.children
      for (var i = 0; i < dots.length; i++) {
        var dot = dots[i]
        var id = dot.dataset.id
        var cls = 'dct-node dct-user'
        if (id === state.activeNodeId) cls += ' dct-active'
        if (id === state.hoveredNodeId) cls += ' dct-hover'
        if (id === state.targetNodeId && state.dragging) cls += ' dct-target'
        if (force || dot.className !== cls) dot.className = cls
      }
    }

    // ------------------------------------------------------------------
    // IntersectionObserver：滚动同步 active 节点
    // ------------------------------------------------------------------
    function disconnectIo() {
      if (state.io) { state.io.disconnect(); state.io = null }
    }

    function reconnectIo(sp, rows) {
      disconnectIo()
      state.ioMap = new Map()
      if (typeof IntersectionObserver === 'undefined') return

      var observed = []
      for (var n = 0; n < rows.length; n++) {
        if (rows[n].el) {
          state.ioMap.set(rows[n].el, rows[n].id)
          observed.push(rows[n].el)
        }
      }
      if (observed.length === 0) return

      var io = new IntersectionObserver(function (entries) {
        if (state.disposed) return
        // 程序滚动定位期间（跳转后 ~700ms）不让 IO 覆盖用户目标 active
        if (Date.now() < state.activeLockUntil) return
        var bestId = null
        var bestOrder = Infinity
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i]
          if (!e.isIntersecting) continue
          var id = state.ioMap.get(e.target) || null
          if (!id) continue
          var node = state.byId[id]
          if (!node) continue
          if (node.index < bestOrder) { bestOrder = node.index; bestId = id }
        }
        if (bestId !== null && bestId !== state.activeNodeId) {
          state.activeNodeId = bestId
          applyNodeStates()
        }
      }, {
        root: sp,
        rootMargin: '-30% 0px -35% 0px',
        threshold: 0.01,
      })

      for (var m = 0; m < observed.length; m++) io.observe(observed[m])
      state.io = io

      // 初次建立时立即按当前可视区校正一次
      var first = pickVisibleNode()
      if (first !== null) {
        state.activeNodeId = first
        applyNodeStates()
      }
    }

    function pickVisibleNode() {
      if (!state.scrollport || state.rows.length === 0) return null
      var sp = state.scrollport
      var viewTop = sp.scrollTop + sp.clientHeight * 0.3
      var viewBottom = sp.scrollTop + sp.clientHeight * 0.65
      for (var i = 0; i < state.rows.length; i++) {
        var node = state.rows[i]
        if (!node.el) continue
        var r = node.el.getBoundingClientRect()
        var top = r.top - sp.getBoundingClientRect().top + sp.scrollTop
        var bottom = top + r.height
        if (bottom > viewTop && top < viewBottom) return node.id
      }
      var center = sp.scrollTop + sp.clientHeight / 2
      var best = null
      var bestD = Infinity
      for (var k = 0; k < state.rows.length; k++) {
        var rc = state.rows[k].el ? state.rows[k].el.getBoundingClientRect() : null
        if (!rc) continue
        var c = rc.top - sp.getBoundingClientRect().top + sp.scrollTop + rc.height / 2
        var d = Math.abs(c - center)
        if (d < bestD) { bestD = d; best = state.rows[k].id }
      }
      return best
    }

    // ------------------------------------------------------------------
    // Preview 摘要卡片：display 显隐 + 轻量淡入，无宽高形变、无细条中间态
    // ------------------------------------------------------------------
    // 节点在轨道内的等距位置（仅由序号决定，与消息内容高度/对话间距无关）
    function nodeSlotY(node) {
      var n = state.rows.length
      if (n === 0) return 0
      var trackH = Math.max(40, state.hostEl.offsetHeight)
      return trackH * (node.index + 0.5) / n
    }

    function showPreview(nodeId, anchorDot) {
      var node = state.byId[nodeId]
      if (!node) { hidePreview(); return }
      var pv = state.pvEl
      var body = state.pvBodyEl
      var text = node.previewText
      // 幂等：同一条 nodeId、已显示、文本未变 → 完全无变化，直接返回，
      // 不重建卡片、不重放淡入动画（消除光标不动时的亮灭闪烁）
      if (state.previewNodeId === nodeId && pv.style.display !== 'none' && body.textContent === text) return

      var firstOpen = state.previewNodeId !== nodeId
      state.previewNodeId = nodeId
      body.textContent = text
      pv.classList.toggle('dct-pv-empty', text === '[无文本内容]')
      if (firstOpen) pv.style.display = 'block' // 仅首次打开时播放一次动画

      var trackRect = state.trackEl.getBoundingClientRect()
      var hostRect = state.hostEl.getBoundingClientRect()
      // 锚点 = 该节点在轨道内的等距槽位（相对 host）
      var slotY = anchorDot ? parseFloat(anchorDot.style.top) : nodeSlotY(node)
      var dotCenterY = slotY + (anchorDot ? anchorDot.offsetHeight : 7) / 2

      // 向聊天区右侧展开；极窄时收缩卡片宽度，绝不横向溢出
      var rightSpace = window.innerWidth - trackRect.right - 8
      var pvW = Math.min(320, Math.max(120, rightSpace))
      if (pvW > rightSpace) pvW = Math.max(96, rightSpace)

      // 先显示以便测量高度（display 仅在首次打开时切换，不产生形变/重放）
      if (firstOpen) { pv.style.left = '0px'; pv.style.top = '0px' }
      var pvH = pv.offsetHeight || 60
      // 卡片贴近节点，但纵向范围限制在视口内（轨道很短时也不被裁）
      var top = Math.max(4 - hostRect.top, Math.min(dotCenterY - pvH / 2, window.innerHeight - pvH - 4 - hostRect.top))
      // 卡片左缘 = 轨道右缘 + 间距，不遮挡 tracker 组件自身
      var left = (trackRect.right - hostRect.left) + 4
      pv.style.left = left + 'px'
      pv.style.top = top + 'px'
      pv.style.width = pvW + 'px'
    }

    function hidePreview() {
      var pv = state.pvEl
      if (!pv) return
      state.previewNodeId = null
      if (state.pvBodyEl) state.pvBodyEl.textContent = '' // 清空文本，杜绝"旧摘要残留"
      pv.style.display = 'none'
      pv.classList.remove('dct-pv-empty')
    }

    // ------------------------------------------------------------------
    // 交互：hover / focus / drag / click（全部事件委托）
    // ------------------------------------------------------------------
    // 等距映射：轨道位置 → 序号 → 节点（与显示布局一致，不做内容坐标二分）
    function nodeAtClientY(clientY) {
      var trackRect = state.trackEl.getBoundingClientRect()
      var n = state.rows.length
      if (n === 0) return null
      var ratio = (clientY - trackRect.top) / Math.max(1, trackRect.height)
      var idx = Math.floor(ratio * n)
      if (idx < 0) idx = 0
      if (idx > n - 1) idx = n - 1
      return state.rows[idx]
    }

    function dotOf(nodeId) {
      return state.dotMap.get(nodeId) || null
    }

    function setHover(nodeId) {
      if (state.hoveredNodeId === nodeId) return
      state.hoveredNodeId = nodeId
      applyNodeStates()
      if (nodeId !== null) showPreview(nodeId, dotOf(nodeId))
      else if (!state.dragging) hidePreview()
    }

    function onPointerDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      if (!state.scrollport || state.rows.length === 0) return
      // 触屏/指针按下：容器进入查看态（展开）
      state.expandedByTouch = e.pointerType !== 'mouse'
      expandContainer()
      state.dragging = true
      state.dragMoved = false
      state.dragPointerId = e.pointerId
      state.trackEl.classList.add('dct-dragging')
      try { state.trackEl.setPointerCapture(e.pointerId) } catch (_) {}
      updateTarget(e.clientY)
      e.preventDefault()
    }

    function updateTarget(clientY) {
      var node = nodeAtClientY(clientY)
      if (!node) return
      state.targetNodeId = node.id
      applyNodeStates()
      showPreview(node.id, dotOf(node.id))
    }

    function onPointerMove(e) {
      if (!state.scrollport || state.rows.length === 0) return
      if (state.dragging) {
        if (state.dragPointerId !== null && state.dragPointerId !== e.pointerId) return
        var dx = e.movementX || 0
        var dy = e.movementY || 0
        if (Math.abs(dx) + Math.abs(dy) > 2) state.dragMoved = true
        if (state.dragRafPending) return
        state.dragRafPending = true
        var dy2 = e.clientY
        requestAnimationFrame(function () {
          state.dragRafPending = false
          if (!state.dragging || state.disposed) return
          updateTarget(dy2)
        })
        return
      }
      if (state.hoverRafPending) return
      var trackRect = state.trackEl.getBoundingClientRect()
      if (e.clientY < trackRect.top || e.clientY > trackRect.bottom) { setHover(null); return }
      state.hoverRafPending = true
      var y = e.clientY
      requestAnimationFrame(function () {
        state.hoverRafPending = false
        if (state.dragging || state.disposed) return
        var node = nodeAtClientY(y)
        if (node) setHover(node.id)
        else setHover(null)
      })
    }

    function onPointerUp(e) {
      if (!state.dragging) return
      if (state.dragPointerId !== null && state.dragPointerId !== e.pointerId) return
      var wasDrag = state.dragMoved
      var targetId = state.targetNodeId
      state.dragging = false
      state.dragPointerId = null
      state.targetNodeId = null
      state.trackEl.classList.remove('dct-dragging')
      try { state.trackEl.releasePointerCapture(e.pointerId) } catch (_) {}
      applyNodeStates()
      if (targetId) jumpTo(targetId, wasDrag)
      else hidePreview()
      // 触屏：手指抬起后延迟收缩（给阅读摘要留时间）；鼠标拖动完也恢复
      if (!state.expandedByTouch) scheduleCollapse(600)
      else scheduleCollapse(900)
    }

    function onPointerLeave() {
      if (!state.dragging) setHover(null)
      // 桌面指针离开容器 → 延迟收缩；触屏无 leave 语义，由 pointerup 定时处理
      if (!state.expandedByTouch && window.matchMedia && window.matchMedia('(hover: hover)').matches) {
        scheduleCollapse(300)
      }
    }

    function onTrackFocusIn(e) {
      var dot = e.target && e.target.closest ? e.target.closest('.dct-node') : null
      expandContainer()
      if (dot) setHover(dot.dataset.id)
    }

    function onTrackFocusOut() {
      if (!state.dragging) setHover(null)
      scheduleCollapse(220)
    }

    // ------------------------------------------------------------------
    // 点击/拖动定位：按 messageId/key 找到对应行，平滑滚动到视口偏上
    // ------------------------------------------------------------------
    function jumpTo(nodeId, fromDrag) {
      var node = state.byId[nodeId]
      if (!node || !state.scrollport) return
      var sp = state.scrollport
      var el = node.el
      // 目标行不在 DOM（虚拟化窗口外）：找当前已渲染的最近行，避免空跳
      if (!el) {
        var nearest = null
        var nearestD = Infinity
        for (var i = 0; i < state.rows.length; i++) {
          var cand = state.rows[i]
          if (!cand.el) continue
          var d = Math.abs(cand.index - node.index)
          if (d < nearestD) { nearestD = d; nearest = cand.el }
        }
        el = nearest
        if (!el) return
      }
      var spRect = sp.getBoundingClientRect()
      var rect = el.getBoundingClientRect()
      var flowTop = rect.top - spRect.top
      var targetTop = flowTop + sp.scrollTop - sp.clientHeight * 0.3
      var maxScroll = Math.max(0, sp.scrollHeight - sp.clientHeight)
      targetTop = Math.max(-8, Math.min(targetTop, maxScroll + 8))
      if (state.activeNodeId !== nodeId) {
        state.activeNodeId = nodeId
        applyNodeStates()
      }
      // 锁定 IO 对 active 的覆盖，直到平滑滚动完成（~700ms）
      state.activeLockUntil = Date.now() + 700
      try {
        sp.scrollTo({ top: targetTop, behavior: 'smooth' })
      } catch (_) {
        sp.scrollTop = targetTop
      }
      if (fromDrag) hidePreview()
    }

    // ------------------------------------------------------------------
    // 层级：设置页/全屏模态层打开时隐藏 tracker，绝不显示在其之上
    // ------------------------------------------------------------------
    function setLayerHidden(hidden) {
      if (state.layerHidden === hidden) return
      state.layerHidden = hidden
      if (state.hostEl) state.hostEl.classList.toggle('dct-layer-hidden', hidden)
      if (hidden) hidePreview()
    }

    function checkLayerCover() {
      var host = state.hostEl
      if (!host || host.style.display === 'none') return
      var trackRect = state.trackEl.getBoundingClientRect()
      if (trackRect.width <= 0 || trackRect.height <= 0) return
      var covered = false
      // 仅凭模态/设置层信号判定，且要求该层矩形**真正覆盖 tracker 所在区域**
      // 才隐藏。不再使用 elementsFromPoint 遮挡检测——轨道位于聊天区沟槽内，
      // 采样点常被聊天容器自身元素命中，会被误判为"被覆盖"而导致 tracker
      // 整层消失（历史回归）。宁可设置页上偶尔可见，也不允许 tracker 无故消失。
      var modal = null
      var probes = ['[role="dialog"][aria-modal="true"]', '[data-modal-root]', '[data-settings-root]', '[data-settings-page]']
      for (var pi = 0; pi < probes.length; pi++) {
        try {
          modal = document.querySelector(probes[pi])
          if (modal) break
        } catch (_) {}
      }
      if (modal) {
        try {
          var mr = modal.getBoundingClientRect()
          // 模态可见且与 tracker 矩形相交 → 认定遮挡
          if (mr.width > 4 && mr.height > 4 &&
              !(mr.right < trackRect.left || mr.left > trackRect.right ||
                mr.bottom < trackRect.top || mr.top > trackRect.bottom)) {
            covered = true
          }
        } catch (_) {}
      }
      setLayerHidden(covered)
    }

    function scheduleLayerCheck() {
      if (state.layerRafPending || state.disposed) return
      state.layerRafPending = true
      requestAnimationFrame(function () {
        state.layerRafPending = false
        if (state.disposed) return
        checkLayerCover()
      })
    }

    // ------------------------------------------------------------------
    // 事件监听（全局：尺寸 / DOM 变化；滚动同步交给 IntersectionObserver）
    // ------------------------------------------------------------------
    function ensureResizeObserver(sp) {
      if (typeof ResizeObserver === 'undefined') return
      if (state.resizeObserver) {
        if (state.resizeObserverTarget === sp) return
        state.resizeObserver.disconnect()
        state.resizeObserver = null
        state.resizeObserverTarget = null
      }
      if (!sp) return
      state.resizeObserverTarget = sp
      state.resizeObserver = new ResizeObserver(function () {
        if (state.disposed) return
        // 侧边栏拖宽/收起、聊天容器尺寸变化时立即重新定位，避免轨道压到侧边栏
        scheduleDomSync()
      })
      state.resizeObserver.observe(sp)
    }

    function startObservers() {
      window.addEventListener('resize', scheduleDomSync)

      var observer = new MutationObserver(function (records) {
        if (state.disposed) return
        var relevant = false
        for (var i = 0; i < records.length; i++) {
          var t = records[i].target
          if (t && t.nodeType === 1 && t.closest && t.closest('[data-dsh-conv-tracker], [data-dsh-conv-tracker] *')) continue
          relevant = true
          break
        }
        if (!relevant) return
        // DOM 变化（消息行增删/分页渲染）：只刷新 DOM 关联与位置，不重建 preview
        scheduleDomSync()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      state.mutationObserver = observer
    }

    // ------------------------------------------------------------------
    // apply
    // ------------------------------------------------------------------
    function apply(ctx) {
      injectCss()
      buildHost()
      startObservers()

      // 数据层：完整 messages → nodes；订阅会话切换与数据变化
      var sessions = ctx && (ctx.sessions || (ctx.get ? ctx.get('sessions') : undefined))
      if (sessions && sessions.list) {
        attachData(sessions)
      } else {
        // 数据层不可用：以 DOM 扫描兜底（仍保证后续 MutationObserver 刷新）
        scheduleLayout()
      }

      // 占位注册（满足注入器对 client 骨架的 slot 校验；渲染 null 无副作用）
      var slots = ctx && ctx.get ? ctx.get('slots') : undefined
      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'dsh-conversation-tracker-placeholder', order: 999, label: () => '' }, () => null))
      }

      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(
          () => () => {
            state.disposed = true
            detachData()
            disconnectIo()
            clearCollapseTimer()
            if (state.layerTimer) { clearInterval(state.layerTimer); state.layerTimer = null }
            if (state.mutationObserver) { state.mutationObserver.disconnect(); state.mutationObserver = null }
            if (state.resizeObserver) { state.resizeObserver.disconnect(); state.resizeObserver = null }
            state.resizeObserverTarget = null
            window.removeEventListener('resize', scheduleDomSync)
            var hosts = document.querySelectorAll('[data-dsh-conv-tracker]')
            for (var i = 0; i < hosts.length; i++) hosts[i].remove()
            var styles = document.querySelectorAll('#' + STYLE_ID)
            for (var j = 0; j < styles.length; j++) styles[j].remove()
          },
          'dsh-conversation-tracker: cleanup',
        )
      }

      // 等 DSH 挂载后重扫（延迟重放：会话/滚动容器可能稍后才出现）
      if (typeof window !== 'undefined') {
        window.addEventListener('load', function () { scheduleDomSync() })
        setTimeout(scheduleDomSync, 1000)
        setTimeout(scheduleDomSync, 3000)
        // 周期遮挡探测（设置页打开/关闭的兜底；帧调度 + 定时双重覆盖）
        state.layerTimer = setInterval(function () {
          if (state.disposed) return
          checkLayerCover()
        }, 900)
      }
    }

    return { apply, inject: ['slots', 'sessions'] }
  },
})