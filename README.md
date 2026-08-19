# dsh-conversation-tracker

DSH Web **Conversation Navigator** (pure client plugin, v0.4).

The navigator rail is for **locating past messages in a conversation**: every `user` message maps to one navigator node, while `assistant` messages create no node. It is not a scrollbar, not a task progress bar, not a chain of thought, and not an agent workflow.

## Node Data Source (v0.3: data-layer driven)

Nodes come **directly from the current conversation's complete messages data**, i.e. `messages.filter(kind user/steering).map(message => node)`:

- Data entry point: `ctx.sessions.list.getSnapshot().current` → `ctx.sessions.binding(id).session` (SessionFace = ObservableSnapshot<ConversationSnapshot>) → `chat.order` + `chat.nodes.get(key)` to walk every node.
- **Does not rely on DOM scanning to count messages, does not rely on DOM index, and does not initialize only once at mount**: `session.subscribe()` pushes updates in real time; `sessions.list.subscribe()` listens for session switches and rebinds the current session's nodes (never mixing in other sessions).
- Even when historical messages are not currently in the DOM (virtualization / history pagination not yet loaded), the Navigator keeps the corresponding nodes (positions linearly interpolated from rendered rows).
- The DOM only carries the "node ↔ rendered row" mapping: a data-layer node's `key` equals the rendered row's `data-chat-anchor-key` (the official persistent anchor, not a DOM index), used for jumping / active syncing.
- `messageId` binds the real message identity: `steering` nodes use their `messageId`; `user` nodes use their persistent event sequence `seq` (data-layer user nodes have no separate messageId field; `seq` is their stable ID).

## Interaction Model

- **Container collapse / expand**: the node rail is **compactly collapsed** by default (minimal horizontal footprint); on user inspection (hover / focus / touch / drag) the rail expands and shows nodes plus summaries, and re-collapses when inspection ends. Collapse / expand only affects the container layer — **node dot style stays unchanged**.
- **Fixed equal spacing**: nodes are **equally spaced** in the rail (determined solely by ordinal), entirely independent of message content height or conversation spacing; scrolling, streaming reply growth, and message folding never move any node. The node column only expresses "the order of the N-th user message."
- **Nodes-only default**: a column of small dots (sparse) / thin bars (dense), with no always-visible text.
- **Preview on demand**: only when the user actively hovers / focuses / touches / drags to a node is that node's summary card shown (direct show/hide + lightweight fade-in, **no capsule deformation, no thin-line residue**). No node text is shown by default.
- **Preview content = original user text**: entirely locally generated (structured content blocks' text concatenation + local markdown control-character stripping). **No AI summarization, no LLM calls, no auto-titles, no semantic rewriting, no reordering.** Processing rules:
  1. Extract the user's actual input content (text blocks original text; compatible with DSH's `type` field and the legacy `kind` field; images/attachments counted by block type);
  2. Strip markdown control characters while preserving the actual text (local `stripMarkdown`: code blocks wholesale, backticks, image/link syntax, heading/list/quote markers, bold/italic markers, etc., without reordering);
  3. Do not display full code blocks;
  4. Images only → `[图片]`;
  5. Attachments only (tool-call/other blocks) → `[附件]`;
  6. URLs in bracket syntax preserve link text with visual width capping (`overflow-wrap: anywhere`);
  7. Emoji preserved;
  8. Empty message → `[无文本内容]`;
  9. Text + attachments coexist → prefer user text, optionally prefixed with `[图片]` / `[附件]`.
- **Click a node**: locate the corresponding `user` message's rendered row by messageId/key (fallback to nearest row if not rendered), smooth-scroll to place the target message at ~30% from the top of the viewport (not flush top, preserving the reply context below), and immediately update the active node; lock active for ~700ms after jumping so IO cannot steal the highlight.
- **Normal scrolling**: `IntersectionObserver` (root = scroll container, rootMargin mid-band) automatically syncs the active node; **does not re-scan the entire conversation on every scroll event**.
- **Drag navigation**: pointerdown capture → real-time node mapping by equal-spacing ordinal during drag with live preview (no release needed), fast traversal of many nodes; release to position at the target message. Click = drag without displacement.
- **Settings page / modal layer**: when settings (or any fullscreen modal layer) is open, the tracker hides entirely (overlay detection + modal-signal dual check), **never appearing above the settings interface**; restores on close.
- **Mobile touch**: pointer events unify over touch; touch-down expands the container, dragging gives real-time preview, touch-end collapses after a delay and positions. Visual nodes are small but each carries a 24px hit area (`::after`), ensuring ease of use.
- **Keyboard accessible**: nodes are Tab-focusable (focus expands container and shows preview, blur re-collapses).

## State (fully localized, no cascading chat-page rerenders)

`activeNodeId`, `hoveredNodeId` (includes focusedNodeId semantics), `previewNodeId`, `dragging`, `targetNodeId` — all are internal module state of this plugin, affecting only its own DOM.

## Node Model

```
node = { id, key, messageId, index, el, top, previewText }
```

- `id`: unique navigator node ID (`dct-<key>`).
- `key`: data-layer node key == rendered row `data-chat-anchor-key` (official persistent anchor).
- `messageId`: real message identity (steering.messageId / user.seq stringified).
- `index`: ordinal of that user message in the current conversation (matches message order).
- `el`: rendered row element (null when outside virtualization window; node still retained).
- `previewText`: locally generated original-text plain preview.
- One user message = one node; adjacent short messages ("ok / why? / continue / yes") each remain independent.

## Many Nodes / Long Conversations

- Nodes are lightweight (single `div`, no independent event listeners; all events delegated on the rail).
- Node position = **equal-spacing slot** (determined solely by ordinal, independent of layout) → scrolling/streaming never moves nodes; scroll only toggles classes and never re-renders nodes; layout rebuilds only on data/structure changes, throttled via `requestAnimationFrame` (diff reuses existing nodes).
- Data snapshots change rapidly during streaming, but when the user node signature (key+messageId) is unchanged, only DOM-association refresh is performed (`render('dom')`), without rebuilding preview / recomputing text.
- Drag/hover mapping is O(1) by equal-spacing ordinal; `dotMap` cache avoids per-frame DOM queries.
- Preview singleton card is filled on demand (display show/hide, no thin-bar intermediate state).
- When nodes > 160, dense mode activates (nodes compress to thin bars, non-critical weights reduced), without breaking order or positioning.
- Compatible with message virtualization / pagination / dynamic append / session switching / node deletion.

## DOM Contract (consistent with the official conversation client)

```
Scroll container  → [data-conversation-scroll]
Message row       → [data-chat-flow-kind] + [data-chat-anchor-key] + [data-chat-flow-key]
Node key          → rendered row data-chat-anchor-key (== Conversation node key)
focus-chat fallback → [data-focus-flow] / [data-focus-anchor-key]
flowTop(row) = row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
```

## Technical Notes

- Pure client plugin: `dsh.client.platform: "web"`, `window.__ModuleLoader__.load` injection, **not placed in bundles**; `inject: ['slots', 'sessions']`.
- Pure DOM self-rendering, zero build, no `@deepseek-ai` value imports (bundle purity gate compliant).
- Only injects UI, only reads DOM, never touches session data files; data reads go through public runtime API.
- Styles entirely reuse DSW theme variables (`--dsw-*`), automatic light/dark adaptation, no independent design system.
- In extreme environments where the data layer is unavailable, it automatically falls back to DOM-scan baseline.

## Layout

`Sidebar | Navigator | Main Chat`: the navigator is a `position: fixed` overlay at the document root (layout root / viewport layer), **not a Sidebar child**, not clipped by Sidebar's overflow / transform / contain. Horizontal positioning reads the sidebar column width directly from AppFrame's grid `gridTemplateColumns`: the rail is placed at the sidebar's right edge plus 6px inward padding groove into the chat area, **not overlapping the sidebar in its default state**; when Sidebar width / collapse state changes, ResizeObserver automatically follows. Preview is also an absolute overlay, defaulting to expanding toward the right side of the chat area: it does not change rail dimensions or push the chat / sidebar, so anchors are stable and there is no layout jump.

## Directory Structure

```
dsh-conversation-tracker/
├── package.json   # dsh.client.platform: "web"; exports ./client
├── index.js       # host-side empty apply (loader entry placeholder)
├── client.js      # Conversation Navigator full UI logic (pure DOM self-rendering)
└── README.md
```

## Installation

```bash
dsh plugin --profile web add github:timsok-shit/dsh-conversation-tracker
```

## Uninstall

```bash
dsh plugin --profile web remove dsh-conversation-tracker
```

## Configuration

Pure client DOM plugin with no configurable external items; tunable constants are collected at the top / local constant area of `client.js`:

| Name | Location | Default | Description |
| --- | --- | --- | --- |
| `SLOT_PX` | `render()` | `12` | Equal-spacing slot distance per node (rail adapts = `N×SLOT_PX+8`, capped at viewport height) |
| `maxTrackH` lower bound | `render()` | `40` | Minimum rail height |
| `activeLockUntil` duration | `jumpTo()` | `700` ms | Lock active during programmatic scrolling to prevent IO from stealing highlight |
| Collapse delay | `scheduleCollapse` | `220` / touch `900` ms | Buffer before re-collapsing after leaving the container |
| Preview width cap | `showPreview()` | `320` px | Maximum summary card width |
| Layer probe | `checkLayerCover()` | 900 ms interval | Hide when modal signal overlaps tracker |

## API

Externally exposed (ModuleLoader contract, `inject: ['slots', 'sessions']`):

- `apply(ctx)`: plugin entry. `ctx.sessions` is the data-layer entry (`list.getSnapshot().current` → `binding(id).session` → `getSnapshot()` reads ConversationSnapshot); `ctx.get('slots')` for shell.overlay placeholder registration. Side effects: inject `#dsh-conversation-tracker-style` styles, mount `[data-dsh-conv-tracker]` container on `body`, subscribe to session snapshots and list, start MutationObserver / ResizeObserver / periodic layer probe.
- `inject`: declares dependency on `slots` and `sessions` services.
- Internal (not exported): `collectDomRows` (row association), `buildDataNodes` (data → nodes), `render(mode)` (`full`/`dom`), `showPreview` / `hidePreview`, `jumpTo`, `checkLayerCover`, etc., all only read/write this plugin's DOM and read-only session snapshots, with no external side effects.

## Maintenance

- After changing `client.js`: `node --check` for syntax → refresh GUI page to re-inject client-modules → verify per "Acceptance".
- Data source: nodes come from runtime `ConversationSnapshot` (read-only); **never write session data files**.
- Known note: rail adapts height to node count; layer detection is based on modal-signal intersection check (does not rely on `elementsFromPoint`, avoiding chat-area groove mis-detection causing tracker disappearance).
- Performance contract: nodes equal-spaced (ordinal-determined) → scrolling/streaming never moves nodes; preview card is idempotent for the same node (no rebuild, no animation replay).

## Acceptance

1. Open a session with multiple Q&A turns: a navigator rail appears, node count = total user messages for that session (including history, including messages not in DOM), assistant messages produce no nodes.
2. Nodes are shown by default only; hovering / focusing / touching a node shows that node's original-text preview; moving away hides it.
3. Preview displays the user's original text (no AI summarization signs); image messages `[图片]`, attachments `[附件]`, empty messages `[无文本内容]`.
4. Clicking a node smooth-scrolls to the corresponding question; the message is at the top of the viewport with reply context visible below; active node is synchronously highlighted.
5. During normal scrolling the active node automatically follows the current reading position (highlight moves along the node column).
6. Press-and-hold to drag the navigator: real-time preview of the target question, release to position; fast traversal of many nodes without lag.
7. Sending a new message: node count increments by 1 in real time; switching to another session: node count becomes that session's user-message count, without mixing in the previous session.
8. Long conversations (hundreds of nodes and above) scroll / drag smoothly; nodes enter dense mode and remain positionable.
9. Light and dark themes both display correctly, without affecting existing interface, text selection, or scrolling.