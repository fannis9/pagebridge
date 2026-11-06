# pagebridge（DSH 插件）

把**用户真人正在浏览的 Chrome 标签页**变成每个 DSH 会话都能直接调用的工具：
`mcp__page-bridge__*`（22 个）。

和内置的 `mcp__playwright-mcp__*`（DSH 自己开的隔离浏览器）互补——这一套操作的是**你本人的浏览器**，
登录态、标签页、你正在看的页面都在。

## 组成

| 部分 | 位置 | 作用 |
|---|---|---|
| Chrome 扩展 | `../extension/` | 反向连到本地桥接，按需读取/操作当前标签页；可一键停用 |
| 桥接进程 | `../bridge.mjs` | 连接枢纽：native messaging（首选，Chrome 拉起）+ WebSocket（回退）+ HTTP（给 CLI/MCP）；记录标签页事件 |
| MCP 服务端 | `../mcp-server.mjs` | 把桥接包成 22 个 MCP 工具；**按需拉起桥接**，闲置自动退出 |
| 本插件 | 本目录 | 用 profile patch 挂载 `@deepseek-ai/dsh-mcp-client` 指向 MCP 服务端 |

## 工具清单（22 个）

`page_status` `page_use_browser` `page_open` `page_snapshot` `page_state` `page_text` `page_tabs`
`page_events` `page_eval` `page_click` `page_type` `page_key` `page_select` `page_scroll` `page_highlight`
`page_screenshot` `page_navigate` `page_close` `bridge_stop`

`page_snapshot` 返回 Playwright 风格 ARIA 树，交互元素带 `[ref=eN]`；可用 `selector` 只抓某棵子树。
`page_text` 支持 selector 并读取目标子树中的 open shadow root；`page_html` 有节点和字符硬上限；
`page_count` / `page_wait` 分别用于统计和等待 DOM 目标。
（大页面提速降噪）。`page_click`/`page_type`/`page_select` 可直接用 `ref`（如 `e12`），且这五个变更类
工具**执行后会自动附带一份新快照**（可 `PAGE_BRIDGE_SNAPSHOT=0` 关闭）。
`page_screenshot` 同时返回图片与落盘路径，但**要求浏览器窗口在前台**（后台窗口立刻报错；
只想读内容请用 `page_snapshot`/`page_text`）。`page_open` 用来打开新标签页（`active=false` 后台打开）。

⚠️ **两种权限模式**：
- 默认（窄）：必须在扩展里**共享标签页**（点扩展图标 →「共享当前标签页」），只能操作那一个页面；
- **完全接管**：在弹窗里打开开关后，可操作**任意标签页**、自由 `page_open`；黑名单仍在生效。
  这个开关**只能由用户在弹窗里打开**，Agent 无法自己提权。

⚠️ **Chrome 和 Edge 同时开着时**：tabId 是各浏览器自己的编号，先用 `page_use_browser {browser:"edge"}`
固定目标再操作（`page_status` 会显示 `browsers` 与 `effectiveBrowser`）。不固定时优先发给窗口在前台的那个。

⚠️ **使用前必须在扩展里共享标签页**（点扩展图标 →「共享当前标签页」）：默认不共享任何页面，
且共享只作用于那一个标签页 + 它的域名。返回 "尚未共享标签页" 时照提示操作即可；
`page_status` 会告诉你当前共享了什么、策略是什么、以及浏览器侧用的是哪种传输（native / ws）。

## 安装

**方式 A：本地 link 安装**（推荐，可随 `plugin_manager` 管理）

```powershell
dsh plugin --profile desktop add link:<仓库路径>\dsh-plugin
```

**方式 B：直接把这行加进 profile 的 `cordis.patch.yml`**（见本目录 `cordis.patch.yml` 的 insert 段）

任一方式之后：新会话即拥有 `mcp__page-bridge__*`；已经打开的旧会话不会补挂。

## 验证

```powershell
# 1) 桥接是否可达（会自动拉起）
node page.mjs status

# 2) 在新会话里让模型调用 page_state，应返回你当前标签页的标题/URL/正文
```

## 卸载

- link 安装：`dsh plugin --profile desktop remove pagebridge`
- 手写行：删掉 profile `cordis.patch.yml` 里的 `page-bridge-mcp` insert 段
- Chrome 扩展：`chrome://extensions` 里移除即可（不影响其它功能）
