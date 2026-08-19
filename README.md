# dsh-conversation-tracker

DSH Web **Conversation Navigator（对话追踪导航条）**（纯 client 插件，v0.4）。

导航条用于**历史对话定位**：每一条 user message 对应一个导航节点，assistant
message 不创建节点。它不是 scrollbar、不是任务进度条、不是思维链、不是
agent workflow。

## 节点数据来源（v0.3：数据层驱动）

节点**直接来自当前 conversation 的完整 messages 数据**，即
`messages.filter(kind user/steering).map(message => node)`：

- 数据入口：`ctx.sessions.list.getSnapshot().current` → `ctx.sessions.binding(id).session`
  （SessionFace = ObservableSnapshot<ConversationSnapshot>）→
  `chat.order` + `chat.nodes.get(key)` 遍历全部节点。
- **不依赖 DOM 扫描来数消息、不依赖 DOM index、不在 mount 时只初始化一次**：
  `session.subscribe()` 实时推送（新消息 1→1 节点、5→5、8→8…）；
  `sessions.list.subscribe()` 监听会话切换并重绑当前会话节点（不混入其他会话）。
- 即使历史消息当前不在 DOM（虚拟化 / 历史分页未加载），Navigator 仍保留对应
  节点（位置按已渲染行线性插值）。
- DOM 只承担「节点 ↔ 已渲染行」的关联映射：数据层节点的 `key` 即渲染行的
  `data-chat-anchor-key`（官方持久锚，非 DOM index），用于跳转 / active 同步。
- `messageId` 绑定真实消息身份：`steering` 节点用其 `messageId`；`user` 节点
  用其持久事件序号 `seq`（数据层 user 节点无独立 messageId 字段，seq 即其
  稳定 ID）。

## 交互模型

- **容器收缩/展开**：节点容器条默认**紧凑收缩**（横向占用最小）；用户查看
  （hover / focus / touch / 拖动）时容器展开并显示节点与摘要，结束查看后
  恢复收缩。收缩/展开只作用于容器条层，**节点圆点样式不变**。
- **节点固定等距**：节点在轨道内**等距分布**（仅由序号决定），与消息内容高度、
  对话间距完全无关；滚动、流式回复增长、消息折叠都不会移动节点。节点列只
  表达"第 N 条 user message 的顺序"。
- **默认只显示节点**：一列小圆点（稀疏）/ 细条（密集），永不常显文字。
- **Preview 按需显示**：只有用户主动 hover / focus / touch / drag 到某节点时，
  才显示该节点的摘要卡片（直接显示/隐藏 + 轻量淡入，**无胶囊形变、无细线
  残留**）。默认不显示任何节点文字。
- **Preview 内容 = 用户原文**：完全本地生成（结构化 content blocks 的 text
  拼接 + 本地 markdown 控制符剥离）。**禁止 AI 总结、LLM 调用、自动标题、
  语义改写、语序重排。** 处理规则（与需求一致）：
  1. 提取用户实际输入内容（text blocks 原文；兼容 DSH 的 `type` 字段与旧
     `kind` 字段，图片/附件按 block 类型计数）；
  2. 去除 markdown 控制符保留实际文字（本地 `stripMarkdown`：代码块整块、反引号、
     图片/链接语法、标题/列表/引用符、粗斜体标记等，不重排语序）；
  3. 不显示完整代码块；
  4. 仅图片 → `[图片]`；
  5. 仅附件（tool-call/other 块）→ `[附件]`；
  6. URL 经括号语法时保留链接文字且视觉限宽（`overflow-wrap:anywhere`）；
  7. Emoji 保留；
  8. 空消息 → `[无文本内容]`；
  9. 文字 + 附件同时存在 → 优先用户文字，必要时前置 `[图片] `/`[附件] ` 标识。
- **点击节点**：按 messageId/key 找到对应 user message 的已渲染行（未渲染时
  回退最近行），平滑滚动把目标消息放到视口上部约 30% 处（不贴顶，保留下方
  该轮响应上下文），并立即更新 active 节点；跳转后 ~700ms 锁定 active，
  滚动途中不被 IO 抢占。
- **正常滚动**：`IntersectionObserver`（root = 滚动容器，rootMargin 中部带）
  自动同步 active 节点；**不在每个 scroll 事件里重算整个 conversation**。
- **拖动导航**：pointerdown 捕获 → 拖动中按等距序号实时映射节点并更新 preview
  （无需松手），可快速跨越大量节点；松手定位到目标消息。点击 = 未位移的拖动。
- **设置页/模态层级**：打开设置页面（或任何全屏模态层）时，tracker 整层隐藏
  （遮挡检测 + 模态信号双重判定），**绝不显示在设置界面之上**；关闭后恢复。
- **移动端 touch**：pointer 事件统一覆盖 touch；touch 按下展开容器、拖动实时
  preview、结束触摸后延迟收缩并定位。视觉节点小，但每个节点带 24px 命中区
  （`::after`），保证易操作。
- **键盘可达**：节点可 Tab 聚焦（focus 展开容器并显示 preview，blur 后收缩）。

## 状态（全部局部化，不连带重渲染聊天页面）

`activeNodeId`、`hoveredNodeId`（含 focusedNodeId 语义）、`previewNodeId`、
`dragging`、`targetNodeId` —— 都是插件内部模块状态，只作用于本插件 DOM。

## 节点模型

```
node = { id, key, messageId, index, el, top, previewText }
```

- `id`：导航节点唯一 ID（`dct-<key>`）。
- `key`：数据层节点 key == 渲染行 `data-chat-anchor-key`（官方持久锚）。
- `messageId`：真实消息身份（steering.messageId / user.seq 字符串化）。
- `index`：该 user message 在当前 conversation 中的顺序（与消息顺序一致）。
- `el`：已渲染行元素（虚拟化窗口外为 null，节点仍保留）。
- `previewText`：本地生成的原文纯文本预览。
- 一 user message = 一节点，相邻短消息（"可以 / 为什么？ / 继续 / 好"）各自独立。

## 大量节点 / 长对话

- 节点轻量（单个 `div`，无独立事件监听，事件全部委托在轨道上）。
- 节点位置 = **等距槽位**（仅由序号决定，与布局无关）→ 滚动/流式不移动节点；
  scroll 只切换 class，绝不重渲染节点；布局只在数据/结构变化时经
  `requestAnimationFrame` 节流重建（diff 复用既有节点）。
- 数据快照在流式期间高频变化，但 user 节点签名（key+messageId）不变时只做
  DOM 关联刷新（`render('dom')`），不重建 preview / 不重算文本。
- 拖动/悬停映射按等距序号 O(1) 计算，`dotMap` 缓存避免逐帧 DOM 查询。
- preview 单例卡片按需填充（display 显隐，无细条中间态）。
- 节点 > 160 时进入密集模式（节点压缩为细条、削弱非关键权重），不破坏顺序与定位。
- 兼容消息虚拟化 / 分页加载 / 动态追加 / 切换会话 / 节点删除。

## DOM 契约（与官方 conversation 客户端一致）

```
滚动容器  → [data-conversation-scroll]
消息行    → [data-chat-flow-kind] + [data-chat-anchor-key] + [data-chat-flow-key]
节点 key  → 渲染行 data-chat-anchor-key（== Conversation node key）
focus-chat 视图回退 → [data-focus-flow] / [data-focus-anchor-key]
flowTop(row) = row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
```

## 技术要点

- 纯客户端插件：`dsh.client.platform: "web"`，`window.__ModuleLoader__.load`
  注入，**不进 bundles**；`inject: ['slots', 'sessions']`。
- 纯 DOM 自渲染，零构建，无 `@deepseek-ai` 值导入（bundle purity gate 合规）。
- 只注入 UI、只读 DOM、不碰会话数据文件；数据读取走公开 runtime API。
- 样式全部复用 DSW 主题变量（`--dsw-*`），深浅色自动适配，无独立设计系统。
- 数据层不可用的极端环境自动退回 DOM 扫描兜底（保底运行）。

## 布局

`Sidebar | Navigator | Main Chat`：导航条是 `position: fixed` 于文档根（layout
root / viewport 层）的独立 overlay，**不是 Sidebar 子节点**，不会被 Sidebar 的
overflow / transform / contain 裁剪。水平定位直接从 AppFrame 的 grid
`gridTemplateColumns` 读取侧边栏列宽：轨道放在侧边栏右缘再往聊天区内侧
6px 的 padding 沟槽里，**默认态不与侧边栏重叠**；Sidebar 宽度/收起状态变化时
通过 ResizeObserver 自动跟随。Preview 形变同样是 absolute overlay，并默认向聊天区右侧展开：
不会改变轨道尺寸，也不会把聊天区/侧边栏顶开，因此锚点稳定、无布局跳动。

## 目录结构

```
dsh-conversation-tracker/
├── package.json   # dsh.client.platform: "web"；exports ./client
├── index.js       # host 侧空 apply（loader entry 占位）
├── client.js      # Conversation Navigator 全部 UI 逻辑（纯 DOM 自渲染）
└── README.md
```

## 安装

```bash
dsh plugin --profile web add github:timsok-shit/dsh-conversation-tracker
```

## 卸载

```bash
dsh plugin --profile web remove dsh-conversation-tracker
```

## 配置项

纯客户端 DOM 插件，无可配置外部项；可调常量收敛在 `client.js` 顶部/局部常量区：

| 名称 | 位置 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `SLOT_PX` | `render()` | `12` | 每个节点的等距槽位间距（轨道随节点数 = `N×SLOT_PX+8` 自适应，封顶为可视区高度） |
| `maxTrackH` 下限 | `render()` | `40` | 轨道最小高度 |
| `activeLockUntil` 时长 | `jumpTo()` | `700` ms | 程序滚动期间锁定 active，防止 IO 抢占高亮 |
| 收缩延时 | `scheduleCollapse` | `220` / 触屏 `900` ms | 离开容器后恢复收缩的缓冲 |
| preview 宽度上限 | `showPreview()` | `320` px | 摘要卡片最大宽度 |
| 层级探测 | `checkLayerCover()` | 900 ms 周期 | 模态信号覆盖 tracker 时隐藏 |

## 接口说明

对外暴露（ModuleLoader 契约，`inject: ['slots', 'sessions']`）：

- `apply(ctx)`：插件入口。`ctx.sessions` 为数据层入口（`list.getSnapshot().current` →
  `binding(id).session` → `getSnapshot()` 读 ConversationSnapshot）；`ctx.get('slots')`
  用于 shell.overlay 占位注册。副作用：注入 `#dsh-conversation-tracker-style` 样式、
  在 `body` 挂载 `[data-dsh-conv-tracker]` 容器、订阅会话快照与列表、启动
  MutationObserver / ResizeObserver / 周期层级探测。
- `inject`：声明依赖 `slots` 与 `sessions` 服务。
- 内部（未导出）：`collectDomRows`（行关联）、`buildDataNodes`（数据→节点）、
  `render(mode)`（`full`/`dom`）、`showPreview` / `hidePreview`、`jumpTo`、
  `checkLayerCover` 等，均只读写本插件 DOM 与只读会话快照，无对外副作用。

## 维护说明

- 每次改动 `client.js` 后：`node --check` 过语法 → 刷新 GUI 页面让 client-modules
  重新注入 → 按「验收」逐项核对。
- 数据源：节点来自运行时 `ConversationSnapshot`（只读）；**绝不写会话数据文件**。
- 已知注意：轨道会随节点数自适应高度；层级基于模态信号相交判定（不依赖
  `elementsFromPoint`，避免聊天区沟槽误判导致 tracker 消失）。
- 性能约定：节点等距（序号决定）→ 滚动/流式不移动节点；预览卡片对同节点
  幂等（不重建、不重放动画）。

## 验收

1. 打开含多轮问答的会话：右侧（现为左侧）出现导航条，节点数 = 该会话
   user message 总数（含历史、含不在 DOM 的消息），assistant 消息不产生节点。
2. 默认只显示节点；hover / focus / 触摸节点显示该节点原文 preview，移开即隐藏。
3. preview 显示的是用户原文（无 AI 总结迹象）；图片消息 `[图片]`、附件 `[附件]`、
   空消息 `[无文本内容]`。
4. 点击节点平滑滚动到对应提问，消息位于视口上部，下方可见该轮回复上下文；
   active 节点同步高亮。
5. 正常滚动时 active 节点自动跟随当前阅读位置（高亮在节点列上移动）。
6. 按住拖动导航条：实时 preview 目标提问，松手定位；快速划过大量节点不卡顿。
7. 发送新消息：节点实时 +1；切换到另一个会话：节点变为该会话的 user 消息数，
   不混入上一个会话。
8. 长对话（数百节点以上）滚动/拖动流畅，节点进入密集模式后仍可定位。
9. 深浅色主题均正常，不影响现有界面、文字选中与滚动。