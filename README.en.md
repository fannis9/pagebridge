**English** | [简体中文](README.md)

# Page Bridge — turn the pages you browse into AI's hands

[![tests](https://github.com/fannis9/pagebridge/actions/workflows/tests.yml/badge.svg)](https://github.com/fannis9/pagebridge/actions/workflows/tests.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

No restarting the browser, no switching profiles, no resorting to a debugging port: install one extension,
and it hands **the tab you are currently looking at** to the local DSH Agent on demand.

<img src="docs/popup-preview.png" alt="Extension popup: connection status, the tab being shared, the full-takeover toggle, domain policy" width="340">

<sub>Extension popup (regenerable with `dev/make-popup-preview.mjs`): connection status goes over native
messaging; "Share current tab" is the entry point for narrow mode, while "Full takeover" opens up to any tab.</sub>

```
   你的 Chrome（照常用，登录态都在）
        │  WebSocket  ws://127.0.0.1:8799/ws   （扩展主动外连，所以不需要任何端口/权限）
        ▼
   bridge.mjs  ←──HTTP──  page.mjs（我在 pwsh 里调用的命令行）
        │
        └─ var/events.jsonl：滚动记录你在看什么（标题+URL+时间）
```

- Extension: `extension/` (MV3, `tabs` + `scripting` + `<all_urls>`; includes 16/32/48/128 icons and a popup toggle)
- Icons: `make-icons.py` (generated with Pillow; 16/32 use a simplified glyph so they stay legible at small sizes)
- Bridge: `bridge.mjs` (zero dependencies, ships its own implementations of both WebSocket and native messaging framing; exits automatically when idle)
- Registration tool: `register-host.mjs` (register/inspect/uninstall the native host at user level, reversible)
- Command line: `page.mjs` (starts the bridge on demand)
- MCP server: `mcp-server.mjs` (wraps the bridge into 22 MCP tools)
- DSH plugin: `dsh-plugin/` (profile bundle, so new sessions come with `mcp__page-bridge__*`)
- Self-check/debugging: `mock-extension.mjs` (fake extension, verifies the whole link without a browser), `smoke-mcp.mjs` (MCP-layer smoke test), `dev/`:
  - `snapshot-probe.mjs` snapshot algorithm probe (runs the same piece of code as in the extension inside a real Chromium)
  - `smoke-snapshot.mjs` snapshot pipeline smoke test (brings its own bridge + fake extension, separate port 8798)
  - `grant-policy-test.mjs` permission policy unit tests (26 assertions, including suffix-spoofing cases)
  - `native-framing-test.mjs` native messaging framing tests (pipes simulate Chrome, covering both host and relay)
  - `sw-load-test.mjs` loads the service worker with a fake `chrome` API (checks module-level crashes + 5 transport state machine scenarios)
  - `chrome-extension-state.mjs` / `chrome-storage-scan.mjs` Chrome-side extension state and storage diagnostics
  - `extension-id-test.mjs` computes the extension ID with the Chromium algorithm, and compares the two native manifests for Chrome/Edge
  - `make-popup-preview.mjs` re-renders `docs/popup-preview.png` (a fake `chrome` API feeds it state, headless screenshot)
  - `key-dispatch-test.mjs` synthetic key tests (real browser; verifies keyCode/which and the "Enter submits" path, including a counterexample)
  - `bridge-auth-test.mjs` capability token and relay fail-closed (**no browser needed, runs in CI**)
  - `bridge-queue-test.mjs` per-tab queue / instance routing / WS frame limit (**no browser needed, runs in CI**)
  - `target-resolve-test.mjs` execution-layer target re-verification: hidden / rewritten / signature deleted / node removed (real browser)
  - `native-e2e-test.mjs` real-browser end-to-end (⚠️ official Chrome 137+ and Edge 154 both removed
    `--load-extension`, so it will simply SKIP; requires Chromium / Chrome for Testing)
- Runtime artifacts: `var/` (`events.jsonl` trail, `shots/` screenshots) — **safe to clear at any time**
- Documentation assets: `docs/popup-preview.png` (popup render preview)

### Idle wake-up (important)

Chrome puts the MV3 extension's service worker to sleep, and the bridge/DSH side **cannot wake it up on its
own** — it can only wait: a tab switch/load (immediate), a click on the extension icon (immediate), or the
once-every-30-seconds alarm (30 seconds at worst).
So after a long time without touching the browser, the first call may wait anywhere from a few seconds to half
a minute; `page.mjs` and the MCP tools have already built this wait into their defaults, and on timeout they
still give an actionable hint. **If Chrome is not running, it definitely cannot connect** (this is the most
common reason for "no response").

## One-time installation (about 30 seconds)

**You do not need to keep the bridge running manually**; both forms can start themselves:

- With the native host registered: **Chrome starts the bridge on demand and keeps it alive** (recommended; the browser side needs no listening port);
- Without registration: `page.mjs` / the MCP tools first probe `127.0.0.1:8799`, and if it is not there they **start it themselves**
  (detached from the current process, hidden window, no console), and it exits automatically after 30 minutes idle.

1. Open `chrome://extensions` in Chrome → turn on **Developer mode** in the top right → **Load unpacked** →
   select this repository's `extension` directory.
2. (Recommended) Register the native host so the extension prefers native messaging:
   ```powershell
   node register-host.mjs register    # 用户级、免管理员
   node register-host.mjs unregister  # 随时撤销（扩展自动回退 WS）
   ```
3. **After changing extension code**, click **↻** once in `chrome://extensions` to reload (this is the step most easily forgotten).
4. Click the extension icon in the toolbar: with the native host registered it shows a green dot + "Connected (native messaging, no local port)".
5. **The WebSocket-only case** (native host not registered): the local control plane requires a **capability token**, so first run
   `node page.mjs token` to get the token, paste it into the "WS capability token" field in the popup and save — only then will it show
   "Connected (WebSocket fallback)". Before you paste it, the extension explicitly says "WS fallback needs a capability token" and does not fail silently.
   (This is exactly why step 2 recommends registering the native host: over native, the token is delivered automatically through a channel
   authenticated by Chrome, so you do not need to worry about it.)
6. Finally, choose one of the two ways to open up the scope: click **"Share current tab"** (opens up only this one page) or turn on
   **"Full browser takeover"** (any tab, the badge turns red `ALL`).

After that the extension keeps the connection alive on its own (20-second heartbeat + a once-a-minute reconnect fallback, with the reconnect interval capped at 5 seconds; switching/loading tabs also wakes it up).

## Lazy install: let your own agent install it for you

Don't want to follow the steps above one by one? **Send the paragraph below to the agent you are currently using**
(DSH, Claude Code, Cursor, any one of them will do), and it will do everything it can on its own:

> Please install Page Bridge for me: clone https://github.com/fannis9/pagebridge into any local directory, then
> ① in that directory run `node register-host.mjs register` to register the native messaging host (user level, no administrator needed);
> ② configure a stdio server for my MCP client, with the command `node <absolute path of that directory>/mcp-server.mjs`, named `page-bridge`;
> ③ run the repository's self-check scripts (`node dev/grant-policy-test.mjs`, `node dev/sw-load-test.mjs`,
> `node dev/native-framing-test.mjs`) to confirm nothing was broken by the install; ④ finally tell me which few things I need to click manually in the browser.

**Division of labor** (so you don't wait for something it cannot do):

| Who does it | What |
|---|---|
| 🤖 the agent can do it fully automatically | Clone/download · register the native host (both the path and the extension ID are derived automatically, **you don't need to change the ID even if you move directories**) · write the MCP client config · run the self-checks · undo (`register-host.mjs unregister`) |
| 👤 only you can click | ① `chrome://extensions` (on Edge it is `edge://extensions`) → Developer mode → **Load unpacked** → select the `extension/` directory ← **a protected page, no browser automation can inject into it**; ② click the extension icon → **Share current tab** or **Full browser takeover** |

<sub>The same goes for non-DSH clients — step ② is just mounting `mcp-server.mjs` as a standard stdio MCP server;
the profile bundle in `dsh-plugin/` is a ready-made configuration specific to DSH (it includes a `cordis.patch.yml` example, with placeholders left for the paths).</sub>

When you need to control the bridge manually:

```powershell
node page.mjs stop                 # 立刻停掉（下次用会再自动拉起）
node page.mjs status --no-autostart   # 只看状态，不自动拉起
node bridge.mjs --port 8799 --idle-exit 0   # 手动常驻（0 = 不自动退出）
```

## Command-line quick reference

```powershell
node page.mjs status                 # 连接状态
node page.mjs tabs                   # 所有标签页
node page.mjs state                  # 当前页：标题/URL/选中文本/标题结构/表单/滚动/正文
node page.mjs text --max 40000       # 整页纯文本
node page.mjs html --max 60000       # 原始 HTML
node page.mjs eval "document.title"  # 执行任意 JS（--world MAIN 可读页面变量）
node page.mjs click "text=登录"       # 按 CSS 选择器或 text= 文本点击
node page.mjs type "#q" "关键词"      # 输入（--submit 顺带回车提交）
node page.mjs key Enter "#q"          # 合成按键（带 keyCode；支持 Backspace/ArrowDown 等，--repeat N）
node page.mjs token                   # 打印本地控制面能力令牌（纯 WS 模式要粘进扩展弹窗）
node page.mjs text --tail 3000        # 只取正文末尾（读对话页最新回复很方便）
node page.mjs type "#q" --file a.md   # 长文本从文件读，避开 shell 引号与命令行长度限制
node page.mjs select "#city" "杭州"
node page.mjs scroll "#price"        # 或 --by 800
node page.mjs highlight "#total"     # 在页面上高亮某元素 2.5 秒（你能看见）
node page.mjs shot E:\dsh\screenshots\shot.png   # 可见区域截图
node page.mjs activate 1741125239        # 切到某个标签页
node page.mjs close 1741125240           # 关掉某个标签页
node page.mjs events --limit 30          # 你最近看了哪些页面
node page.mjs wait "#result"         # 等元素出现
```

Common options: `--tab <id>` (specify a tab, default is the currently active page), `--wait <ms>` (wait for the extension to connect),
`--timeout <ms>`, `--json`; token-related: `--token <value>` / `--token-file <path>` (environment variables `PAGE_BRIDGE_TOKEN` /
`PAGE_BRIDGE_TOKEN_FILE`) — when running a second bridge on the same machine you must give them different token files, otherwise the two instances will 401 each other.

## Transport: native messaging (preferred) + WebSocket (fallback)

The extension has two ways to connect to the bridge, switchable in the popup: **Auto (native preferred)** / native messaging only / WebSocket only.

| | native messaging (preferred) | WebSocket (fallback) |
|---|---|---|
| Who initiates the connection | **Chrome launches the bridge process** and holds the pipe | The extension actively connects to `ws://127.0.0.1:8799/ws` |
| Does the browser side need a listening port | **No** | Yes (loopback only) |
| After the worker is put to sleep by Chrome | Chrome is responsible for restarting the host, the extension just reconnects | Wait for tab events / the 30-second alarm to wake it up |
| Dependency | The native host has been registered (one command below) | None |
| Logs | Go to stderr (stdout only allows protocol frames) | Go to stdout |

In `--native` mode, if the bridge finds the port already occupied by an on-demand bridge, it **automatically degrades into a relay**
(bidirectional forwarding between native ⇄ WebSocket), so there is always only one port and one dispatch path;
if no bridge is running at that moment, **the native host launched by Chrome becomes the bridge itself** (host mode,
`/status` shows `native: true` and clients show `via: native`). Both forms have been verified in practice.

Register / inspect / uninstall (**user level, no administrator, fully reversible**):

```powershell
node register-host.mjs status
node register-host.mjs register      # 写启动脚本 + 清单 + HKCU 注册表
node register-host.mjs unregister    # 撤销（扩展自动回退到 WS）
```

On Windows it writes `%APPDATA%\Google\Chrome\NativeMessagingHosts\com.pagebridge.host.json` and
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pagebridge.host` (the same applies to Edge),
and `allowed_origins` allows only your extension ID. The framing format (4-byte little-endian length prefix + JSON) is verified by
`dev/native-framing-test.mjs` simulating Chrome over pipes, covering both the host and relay paths.

Troubleshooting whether native is really in effect (no browser needed):

```powershell
node dev\sw-load-test.mjs          # service worker 加载 + 传输状态机
node dev\chrome-extension-state.mjs # Chrome 眼里这个扩展是什么状态
# 是否由 Chrome 拉起：找一个父进程是 chrome.exe 的 bridge.mjs --native
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'bridge.mjs' -and $_.CommandLine -match '--native' }
```

## Does Edge work? Yes, and no extra registration is needed

Edge is Chromium, and this extension uses only standard MV3 APIs (`scripting` / `storage` / `alarms` / `nativeMessaging` / `tabs`),
so **the same extension directory can be loaded directly in Edge**. Three key points:

**1. The extension ID is the same in Chrome and Edge.** Chromium's unpacked extension ID is determined entirely by the **absolute path**:

```
id = mapToAtoP( hex( SHA256( pathBytes )[0..15] ) )   # pathBytes：Windows = 路径的 UTF-16LE 编码
```

The same `extension` directory → both sides get `hoiepnbhhkgaakggccoppmknbalamojh`
(this algorithm was verified by reverse-engineering a real profile). So writing a single ID in `allowed_origins` works for both:

```powershell
node dev\extension-id-test.mjs   # 现场算出 ID 并比对 Chrome/Edge 两份清单
```

**2. The native host is registered twice from the start.** `register-host.mjs` defaults to `--browser both`, writing both
`%APPDATA%\Google\Chrome\NativeMessagingHosts\` and `%APPDATA%\Microsoft\Edge\NativeMessagingHosts\`,
plus the corresponding two `HKCU` registry keys. So clicking the icon in Edge should directly show
"Connected (native messaging, no local port)".

**3. The two browsers can be used at the same time**, but note that **tabId is each browser's own numbering**. To avoid mixing them up, the bridge picks its target by a three-layer rule:

1. **Explicit pinning** (recommended): `page_use_browser {browser:"edge"}`, after which all commands go to Edge; pass an empty string to unpin.
   You should pin before cross-browser operations, otherwise an id obtained from `page_tabs` may not exist in the other browser (it reports "tab not found").
2. **The one whose window is in the foreground**: the extension reports `focused` on each 20-second heartbeat, and the bridge prefers it — whichever browser you are looking at is the one.
3. **The one with the most recent "substantive action"**: note that **a heartbeat does not count as an action** (otherwise the two browsers'
   heartbeats would refresh alternately and the target would jump back and forth — a problem I hit in real testing and fixed).

`page_status` tells you: `browsers` (which ones are connected), `effectiveBrowser` (whom commands currently go to), each client's
`focused` and `lastActive`, and `pinnedBrowser` (whether pinning has ever been done).

Loading in Edge (exactly the same as Chrome):

```
edge://extensions → 左下角打开「开发人员模式」→「加载解压缩的扩展」
→ 选 extension → 点工具栏扩展图标 → 「共享当前标签页」或「完全接管浏览器」
```

If you **copy the extension to another directory** and then load it, the path changes → the ID changes too. In that case re-run
`node register-host.mjs register` (it automatically scans the IDs already installed in the various Chrome/Edge profiles and writes them all into
`allowed_origins`), or add it explicitly: `--extension-id <that ID>`.

## Full takeover (open up the scope with one click)

Narrow mode (the default) can only operate the one tab you shared manually. To let it **freely operate the entire browser**, turn on
**"Full browser takeover"** in the popup (the badge turns red `ALL`):

| | Narrow mode (default) | Full takeover |
|---|---|---|
| Operable tabs | Only the one that was shared | **Any tab** (defaults to the currently active page, can be specified with `tabId`) |
| What `page_tabs` returns | Only the shared one | All tabs |
| Opening a new tab | Requires sharing first | ✅ `page_open` opens it directly (can open in the background, `active=false`) |
| Navigate / close / activate | Only the shared tab | Any tab |
| Allowlist | In effect | Skipped |
| **Denylist** | In effect | **Still in effect** (domains never to touch are a hard safeguard) |
| Background browsing event recording | Only the shared tab | Only the shared tab (full takeover is not a reason to secretly record your browsing trail) |
| Badge | `ON` | `ALL` (red) |

Three security design decisions:

1. **The switch can only be flipped by you in the popup** — the bridge side has **no** corresponding command, so the Agent cannot escalate its own privileges
   (there is a unit-test assertion: sending `setFullAccess` to the bridge returns `unknown command`);
2. **The denylist still applies under full takeover**, and it is re-validated every time a command is issued;
3. Full takeover is **persistent** — it survives closing the browser and opening it again, so the badge stays red to remind you (you can turn it off in the popup at any time).

## Sharing and permissions (per-tab authorization + domain allow/deny lists)

By default **nothing is shared**: even after the extension is installed and even connected, DSH cannot read any page until you **explicitly share a tab**.
This is a layer of protection modeled on BrowserMCP's per-tab "Connect" and mcp-chrome's permission-based access control.

How to turn it on: **click the extension icon → "Share current tab"**. After that:

| Rule | Behavior |
|---|---|
| Scope | Only that **one** tab can be read and operated on; `page_tabs` returns only it, and other tabs do not even give up their titles |
| Bound domain | Sharing binds "tab + origin"; once the tab navigates to **another site**, the sharing is automatically cancelled with a notification (you need to share again) |
| Closing the tab | Sharing is automatically cancelled |
| Browser restart | The sharing record lives in `storage.session`, so it is gone as soon as the browser closes (you need to share again next time) |
| Denylist | A matching domain is never shared (`example.com` blocks its subdomains along with it) |
| Allowlist | **Left empty = everything except the denylist is allowed**; once filled in it becomes **deny by default**, and only matching domains can be shared |
| Backstop | Re-validated once on every command issued (not just at the moment of sharing), so policy changes take effect immediately |

You can change both lists in the popup at any time (one entry per line, `*.example.com` wildcards supported), and the current sharing is re-validated immediately after the change.
Badge meanings: `ON` shared and connected · `···` shared but the bridge is not connected · `·` connected but not shared · empty, the master switch is off.

When nothing is shared, any tool returns an actionable hint: *"No tab shared yet: click the extension icon on the browser toolbar → "Share current tab""*.
The policy parser has unit tests: `node dev/grant-policy-test.mjs` (26 assertions, including cases like the suffix spoof `example.com.evil.com`).

## Snapshot and ref (borrowed from BrowserMCP)

`page.mjs snapshot` / the MCP `page_snapshot` produces a **Playwright-style ARIA accessibility tree**,
with interactive elements carrying `[ref=eN]`:

```yaml
- main
  - heading "探索未至之境" [level=1]
  - form
    - textbox "问点什么，一起探索" [ref=e6]
    - button "深度思考" [ref=e7]
  - link "API 开放平台" [ref=e11] [url=https://platform.deepseek.com/]
```

- **A ref can be used directly as a target**: `page_click {ref:"e6"}`, `page_type {ref:"e6", text:"…"}`,
  equivalent to `selector: "@e6"` (also accepts `e6` / `ref=e6`). The ref is written onto the DOM's `data-dsh-ref`.
- **Refs are stable (they do not drift across snapshots)**: the same element keeps the same number across multiple snapshots, only newly appearing elements get new numbers,
  and once an element disappears its ref naturally becomes invalid. This way, when "clicking A then clicking B", nodes newly inserted in between **will not**
  shift all the later refs out of place.
  (Early versions renumbered on every snapshot — in real testing that genuinely made people click the wrong thing, and this change came from feedback in a real test on a quiz page. If an element's
  ref happens not to appear in the latest snapshot, that means it is currently invisible; don't force a click with a stale ref.)
- **Mutating tools return a snapshot automatically**: after `page_click` / `page_type` / `page_select` / `page_scroll` /
  `page_navigate` execute, the latest snapshot (including new refs) is attached, so the model does not have to capture it manually again.
  This matches BrowserMCP's `ToolFactory(snapshot)` design; it can be turned off with environment variables:
  `PAGE_BRIDGE_SNAPSHOT=0` (disable), `PAGE_BRIDGE_SETTLE_MS=500` (milliseconds to wait after an action, default 250).
- **You can capture just one region**: `page_snapshot {selector:"#user-repositories-list"}` (CLI: `snapshot --selector form`)
  returns only the subtree matched by that CSS selector — on giant pages like GitHub this can cut the noise from several hundred nodes down to a dozen or so.
  If the selector does not exist it reports an explicit error, and does not silently return the whole page.
- **Long text/HTML also supports subtree reads**: `page_text {selector:"#target"}` reads that subtree and pierces through the open shadow roots inside it;
  `page_html` also supports `selector`, and returns `truncated` under a dual hard limit of `max` characters and `maxNodes`, so that serializing a whole page does not stall.
  The CLI equivalents are `text --selector ...`, `html --selector ... --max-nodes ...`.
- **Filling in cheap DOM tools**: `page_count` counts composed/shadow DOM nodes, and `page_wait` waits for a selector/ref/text= to appear.
- **Can see through "invisible containers"**: snapshots, `selector`, `text=`, and `count` all walk into these containers instead of clipping the whole subtree away:
  1. **open shadow root** (web components; incidentally, translation-type extensions also inject shadow roots into pages);
  2. **`display: contents`**: its own `getBoundingClientRect()` is 0×0, but child nodes lay out normally —
     GitHub's dialogs hide inside `<dialog-helper>`, and tripping over this produces "the dialog is clearly on screen, yet the snapshot has nothing in it";
  3. **a `visibility: hidden` ancestor plus descendants that turn it back with `visibility: visible`** (CSS allows it, `display:none` does not).
  4. **closed `<details>`**: only `<summary>` is rendered. Chromium hides the content through the **slot mechanism** — the hidden nodes' computed styles are still normal and their `rect` still has size, so it can only be judged semantically; otherwise collapsed answers/explanations get read out (which I discovered when using my own quiz page as a target).

  Counterexamples retained: content inside `display: none` / `opacity: 0` / `aria-hidden` is still correctly excluded;
  and moreover **an element that is itself invisible is not assigned a ref** — otherwise the model would get a ref pointing at an "invisible button" (for example the hidden
  "Delete this repository" confirmation button), and clicking it would still trigger.
  Self-check: the fixture in `dev/snapshot-probe.mjs` builds all four kinds of container **and two counterexamples** (see the "invisible container self-check" in the output).
- **Screenshots require the window to be in the foreground**: `page_screenshot` first checks whether the target window is focused/minimized, and if it is not in the foreground it errors out **immediately**
  (`captureVisibleTab` hangs on background windows); the MCP-side timeout is also tightened to 15 seconds. If you only need to read content, do not use screenshots.
- **Synthetic keys carry real `keyCode`/`which`**: `page_key {key:"Enter"}` (CLI: `key Enter [selector]`) supports
  Enter / Backspace / Delete / Escape / Tab / arrow keys / Home / End / PageUp·Down / a single character, and can `repeat`.
  Why this is needed: a `KeyboardEvent` carrying only `key` has `keyCode` of **0**, while React and design systems (GitHub's Primer
  being one) often branch on `keyCode`, so "press Enter to submit the token" **silently fails** — exactly the pitfall I hit when adding topics.
  `type --submit` also switches to this key dispatch when there is no `<form>`.
  Real-browser self-check: `dev/key-dispatch-test.mjs` (including a **counterexample**: the old approach dispatching Enter should fail to submit).
- **Do not mix up `--submit` and `page_key Enter`**: when the target is a **real form** (login, search), use `type --submit`
  (it goes through `form.requestSubmit()`); when it is merely "some component wants Enter pressed" (such as Primer's token input,
  or a quiz page's fill-in-the-blank check), use **`page_key Enter`** — because if the input is inside a `<form>`, `--submit`
  **triggers a submission of the whole form** (a quiz page would hand in the paper right away, for example); don't bet on the page's own `preventDefault`.
- The snapshot algorithm lives in the extension (the `#region aria-snapshot` block of `extension/background.js`), self-contained so it can be injected;
  `dev/snapshot-probe.mjs` extracts this same piece of code and runs it in a real Chromium, so you can verify immediately when you change the algorithm:
  ```powershell
  node dev\snapshot-probe.mjs                     # 内置夹具
  node dev\snapshot-probe.mjs --url https://x.com --refs
  node dev\snapshot-probe.mjs --selector form     # 只抓某棵子树
  ```
- ⚠️ **Watch out for isolation when running the self-check scripts**: both `mock-extension.mjs` and the real extension connect to the bridge with the `chrome-extension` identity,
  and the bridge sends commands to **whichever connected first** — with the real extension open, a smoke script may operate your real browser (I hit this once:
  a `page_click {ref:"e5"}` in a test really opened a link on your page).
  Now `smoke-mcp.mjs` / `dev/smoke-snapshot.mjs` **bring their own bridge + fake extension and run by default on the separate port 8798**,
  fully isolated from the real extension's 8799 (`--port` can change it); when starting a mock manually, remember to pass `--port 8798` and start a separate bridge.
- Design source: [BrowserMCP/mcp](https://github.com/BrowserMCP/mcp) (`src/tools/snapshot.ts`,
  `src/utils/aria-snapshot.ts`: `captureAriaSnapshot` after an action, outputting URL/Title/fenced yaml).

Two known boundaries (both already turned into **explicit errors** in the code, no more silent failures):

- **`eval` runs in the `MAIN` world by default**. On pages with a strict CSP, the isolated world (ISOLATED) **silently refuses eval**
  (returns null, the code does not execute) — so the default was changed to MAIN; if eval is disabled in some world, it returns
  `__evalUnavailable` together with a hint, instead of pretending to succeed. Reading page JS variables also requires MAIN.
- **`shot` requires the target Chrome window to be visible and focused**, otherwise `captureVisibleTab` hangs for a long time. Now, if it has not returned within 8 seconds,
  it errors out and suggests bringing the window to the foreground. When you only need page content, `state`/`text` are more reliable.

## Contribution sources and license (acknowledgements)

This project **does not copy any third-party source files**: the algorithms and implementations are all written in this repository, but several components'
**design ideas, output formats, and registration conventions** were modeled on the two open-source projects below. Listed item by item per feature:

| This repository's feature / location | Source | What exactly was borrowed | License |
|---|---|---|---|
| Mutating tools automatically attach a snapshot after execution (`snapshotAfter` in `mcp-server.mjs`) | [BrowserMCP/mcp](https://github.com/BrowserMCP/mcp) `src/tools/snapshot.ts` | Every mutating tool (click/drag/hover/type/select) captures an ARIA snapshot after execution and attaches it to the result | Apache-2.0 |
| The layout of the snapshot output (`- Page URL` / `- Page Title` / fenced yaml) | Same as above, `src/utils/aria-snapshot.ts` | The output format was copied verbatim (a very short formatting convention) | Apache-2.0 |
| The snapshot toggle | Same as above (its `ToolFactory(snapshot: boolean)`) | A toggle decides whether a snapshot is attached → this project's `PAGE_BRIDGE_SNAPSHOT` / `PAGE_BRIDGE_SETTLE_MS` | Apache-2.0 |
| `[ref=eN]` reference-based addressing | Same as above (its extension side + `ClickTool`'s `{element, ref}`); the format follows [Playwright](https://playwright.dev/)'s `ariaSnapshot()` | Only the interaction model of "snapshots carry refs, and operations use refs instead of guessing selectors" was borrowed; **the ARIA tree algorithm, the DOM marker (`data-dsh-ref`), and ref resolution are all implemented by this project itself** | Apache-2.0 |
| The single-tab "Connect" authorization model | Same as above, `src/context.ts` | Serves only one explicitly connected tab at a time | Apache-2.0 |
| The style of actionable hints when "not connected" | Same as above, `noConnectionMessage` | Error messages should tell the user directly what to click | Apache-2.0 |
| Screenshots returned as MCP image content | Same as above, `src/tools/custom.ts` | The return shape `{ type: 'image', data, mimeType }` | Apache-2.0 |
| The data shape of tool definitions | Same as above, `src/tools/tool.ts` | `{ schema: {name, description, inputSchema}, handle }` → this project's `{ name, description, inputSchema, run }` | Apache-2.0 |
| The native messaging registration approach (user level, no administrator) | [mcp-chrome](https://github.com/hangwin/mcp-chrome) `app/native-server/install.md` | The Windows manifest goes in `%APPDATA%\<Vendor>\NativeMessagingHosts\`, the registry key in `HKCU\Software\<Vendor>\NativeMessagingHosts\`, the manifest `path` points at a **launcher script** (its `run_host.bat`), and `allowed_origins` restricts the extension ID | MIT |
| The shape of the registration CLI | Same as above | Follows the organization of its `register` / `doctor` / `fix-permissions`; this project simplifies it to `register` / `status` / `unregister` and does user level only | MIT |
| The concept of permission-based access control | Same as above (permission-based access control in its architecture document) | → this project turns it into three layers: "per-tab sharing + domain allow/deny lists + full takeover" | MIT |

**The parts this project wrote itself**:

- `bridge.mjs`: zero-dependency WebSocket frame encoding/decoding **+** native messaging frame encoding/decoding; `--native` has two forms
  (when the port is free it **acts as the bridge itself**, and when the port is taken by an on-demand bridge it **automatically degrades into a relay**);
- `extension/`: the ARIA snapshot algorithm (role / accessible name / state properties / transparent containers / structural roles / truncation), `data-dsh-ref` resolution,
  the permission policy matcher (including **suffix-spoofing protection** for things like `example.com.evil.com`), the sharing and full-takeover models,
  the native→WebSocket automatic fallback state machine, and reporting events only for authorized tabs;
- `register-host.mjs`: a user-level registrar that can be undone with one command;
- the tool layer of `mcp-server.mjs`, the `page.mjs` CLI, and the DSH integration in `dsh-plugin/`;
- all the tests and diagnostic tools under `dev/` (snapshot probe, permission unit tests, native framing tests, service worker tests with a fake `chrome`,
  Chrome extension state/storage diagnostics) — these are this project's own verification means.

**License notes**: **this project itself is licensed under [MIT](LICENSE)** (Copyright © 2026 fannis9).
The referenced BrowserMCP and Playwright are Apache-2.0, and mcp-chrome is MIT; this project only borrows designs and
does not excerpt their source code, so no copy of their source is bundled; if their code is to be directly excerpted in the future, the copyright notice and NOTICE must be retained per the corresponding license.
(Also: the `@playwright/mcp` provider bundled with DSH supplies the 24 `mcp__playwright-mcp__*` tools,
which are **two independent pathways** from Page Bridge and outside this project's scope.)

## Security model (tightened after an external code review)

An external code review was done once ([original conclusions and item-by-item verification](docs/external-review.md)), and the conclusion was "the architecture does not need to be overturned, but the security model needs to be tightened again". Nine changes were made accordingly, and two more (10, 11) were added over the following two rounds:

1. **The local control plane requires a token**: `127.0.0.1` is not a trust boundary (any process on the machine can connect to a loopback port). On first start the bridge generates
   `var/bridge-token`, and from then on **every HTTP and WS handshake must present** it (`Authorization: Bearer <token>`;
   for WS it is `?token=`, because browsers cannot add custom headers in a WS handshake). The token is delivered to the extension only over a **trusted channel**:
   the native channel launched by Chrome (`allowed_origins` guarantees only this extension can start the host), or a WS whose handshake already presented the token.
   When the port has been taken over by someone else, the native host only establishes a relay through a one-time challenge-response: it does not put the capability token into the relay URL,
   and it will not accept a forged `101` WebSocket server; if the proof fails it closes, and it never hands over the channel authenticated by Chrome.
   `node page.mjs token` prints the token; WS-only mode requires pasting it once in the popup.
2. **Privileged settings are accepted only from the popup**: `setFullAccess` / `setPolicy` / `setEnabled` / `share` / `unshare` /
   `setTransport` / `setWsToken` / `push` all verify that `sender.url` is `popup.html`, no longer relying on the convention that "only the popup calls these for now";
   a rejection is recorded as a `privileged-rejected` event (visible via `page.mjs events`).
3. **Execution-layer target re-verification (closing TOCTOU)**: every action acting on an element (click / type / select / key) re-verifies before execution —
   the element is still in the document, is still visible now, and the ref's signature (role + text, written into `data-dsh-sig` at snapshot time) still matches the snapshot;
   if the signature was deleted by the page it is treated as a **failure** (fail closed). Thus the promise "invisible means no ref" extends from render time to action time.
4. **Narrow authorization = origin-level delegation**: sharing a tab equals sharing that **origin**, not "this tab can go anywhere".
   - `navigate` across origins is **rejected up front** (same-origin SPA routing still works as usual), and denylisted targets are always rejected;
   - `open` under narrow authorization allows only the same origin;
   - **`eval` in the MAIN world is disabled under narrow authorization** (it is an arbitrary-JS capability, and `location.href = ...` / `window.open(...)`
     would bypass the two rules above); when needed, use `--world ISOLATED`, or turn on "Full takeover" first.
5. **Post-action revocation**: up-front interception can only control the `navigate` / `open` we send ourselves; clicking a link, submitting a form, or pressing Enter can all
   make the page navigate on its own. So after `click` / `type` / `key` / `select` execute, it waits a moment and reads the tab once more — if it crossed origins or landed on
   the denylist, the sharing is **revoked immediately**, and the current URL is returned to the caller along with it (the result carries `grantAlive` / `note`).
6. **Commands on the same tab are serialized**: the bridge queues by `(browser, tab)`, avoiding a mismatch between the execution order of "click A → type B → snapshot → click C"
   and the order the model sees; different tabs do not block each other. Automatic snapshots are pinned to **the browser that just took that order**
   (the `/cmd` response carries `browser`), preventing the action from happening in Chrome while the snapshot is taken in Edge.
7. **Multiple profiles of the same browser can be told apart**: the hello carries each profile's `instance` id, and `/status` shows it;
   `page_use_browser` supports exact addressing with `chrome@<instance prefix>` (writing just `chrome` still matches by ID prefix).
   The same `/status` also gives **`extensionVersion`** (the extension version actually in effect right now) —
   so "did that reload just now take effect or not" becomes a question one field can answer, with no need to reverse-engineer it from the `since` timestamp plus probing commands.
8. **WS / native single-frame limit of 8 MB**: frames claiming an oversized length are disconnected immediately instead of being buffered without bound (a local DoS);
   WebSocket client frames must also be masked, and fragmentation and reserved bits are rejected.
9. **Runtime logs are bounded**: `events.jsonl` is capped at 5 MB by default, and once exceeded the newest history at the tail of the file is kept before recording continues; URLs written to disk have query/hash
   removed, so that search terms or one-time tokens are not written into the log long-term. The limit can be adjusted with `--max-log-bytes` or `PAGE_BRIDGE_MAX_LOG_BYTES`.
10. **Fail-closed and diagnosable when the policy module is missing**: if `policy.js` did not load successfully, `lastError` explicitly says
    "policy.js not loaded…" (visible in the popup), and it **will not attempt to establish a connection**; any later call gets this explicit error,
    instead of a vague `Cannot read properties of undefined`.
11. **The relay challenge endpoint itself also requires a token**: no arbitrary process on the machine can squeeze out a legitimate relay's pending nonce by requesting repeatedly;
    the token appears only in the **loopback request header** (not in the relay URL, not in the WS handshake), and if the server-side proof does not verify it closes without forwarding a single byte.

**Semantic boundary (stated clearly to avoid misunderstanding)**: the domain denylist constrains **the agent's operations**, not "the page will never send a request" —
a `page_click` landing on a link, or the page's own form submit, can both produce a navigation. Achieving the latter would require browser-level network policy, which is a separate layer of engineering
and is not done for now (this judgment also comes from the review itself).

## Self-checks and CI

These self-checks **do not need a browser**, so they run directly on GitHub Actions ([`.github/workflows/tests.yml`](.github/workflows/tests.yml)):

| Script | Coverage |
|---|---|
| `dev/grant-policy-test.mjs` | 26 permission-policy assertions (including the `example.com.evil.com` suffix spoof) |
| `dev/sw-load-test.mjs` | Loads the service worker with a fake `chrome` API: multiple scenarios + privilege-escalation guard (sender allowlist) + origin isolation + bootstrap race (1b) + `policy.js` load failure (1c) |
| `dev/bridge-auth-test.mjs` | Local control plane capability token: HTTP/WS authentication, relay fail-closed, challenge endpoint resistance to nonce flooding |
| `dev/bridge-queue-test.mjs` | per-tab command queue, instance routing, WS frame limit |
| `dev/native-framing-test.mjs` | native messaging frame round-trip: host mode + relay mode |
| `dev/extension-id-test.mjs` | Chromium extension ID derivation, Chrome/Edge consistency |
| `dev/smoke-snapshot.mjs` / `smoke-mcp.mjs` | MCP-layer smoke (brings its own bridge + fake extension, isolated port) |

Locally you can run 4 scripts in one go with `npm run test:browser:fixtures`: snapshot probe, target re-verification, synthetic keys, and **preview image generation**
(the last one doubles as a guard for "is any script broken" — it once silently rotted because a refactor missed an `import`); this group prefers the
`playwright-core` bundled with DSH, and also accepts a local install in the project root. The real Edge native E2E can be run with `npm run test:browser:native`.
GitHub Actions also has a manually triggered [`.github/workflows/browser-e2e.yml`](.github/workflows/browser-e2e.yml):
it installs the Playwright runtime on a Windows runner, registers the Edge native host, and then runs this group of tests; the reason it is not folded into every PR
is that different branded Chromium builds vary a lot in their support for `--load-extension`.

## Privacy boundary

- Page **content** is read only at the instant it is called for; the body text is not continuously scraped in the background;
- **In narrow mode, unshared tabs are completely invisible**: only the one you clicked "Share current tab" on can be read/operated;
  turning on "Full takeover" extends the scope to all tabs (this is your explicit authorization), but the denylist still applies;
- In the background only events of **authorized tabs** (title/URL/time) are recorded to `var/events.jsonl`, without body text; URLs written to disk have query/hash stripped,
  and even with full takeover on your browsing trail is not recorded silently; if you don't want it, you can delete that file or stop the bridge;
- All traffic stays on `127.0.0.1` and does not go out to the network; the bridge listens only on the loopback address;
- The extension cannot inject into protected pages such as `chrome://` and the Chrome Web Store, and reports an explicit error.

## Troubleshooting

| Symptom | Handling |
|---|---|
| `浏览器扩展未连接…` | Click the extension icon → "Reconnect", or switch tabs once; confirm the bridge is running and the port matches (8799) |
| `Cannot access contents of the page` | The page is protected (chrome://, extension store, some PDF readers), which is expected |
| `eval` fails on strict-CSP sites | When switching to `--world MAIN` makes things worse instead, go through DOM routes such as `click`/`text`/`state` |
| One click opened two tabs | Fixed (the old click dispatched both a synthetic click and `el.click()`). After changing background.js you need to click ↻ once in `chrome://extensions` to reload the extension |
| Port occupied (a bridge is already running) | **Usually nothing to do**: the native host will automatically degrade into a **relay** via a one-time challenge-response, forwarding frames to the bridge that holds the port; if the other side cannot produce the token it **fails closed** (logs and exits), and never hands over the channel authenticated by Chrome |
| Want to run two bridges at once | `bridge.mjs --port 8800 --token-file var/token-8800`, and make the extension use the same address and token (the `WS_BASE` in `extension/background.js` + pasting the matching token in the popup); after the change, click ↻ once in `chrome://extensions` |
| Stops working after a DSH restart | The bridge is a DSH background task and ends along with it; just re-run step 1 (it can also be made to start on boot) |
| Extension won't connect / MCP tools vanish after a DSH upgrade | Run `node dev/doctor.mjs` first. It checks the two **hardcoded** node paths (the native-host launcher and the MCP launch command in the profile), whether the extension version matches the repo manifest, and whether the plugin SDK version changed; `--fix` rewrites the launcher to the system node and re-registers. These failures are **silent** (the MCP row sets `failOnStartupError: false`), so running it after an upgrade is the cheap move |

## DSH plugin (automatically available in new conversations)

`dsh-plugin/` is a profile bundle that mounts this bridge as **MCP tools**, so **every session** comes with
`mcp__page-bridge__*` (**22 of them**) without having to explain the path first:

| Tool | Purpose |
|---|---|
| `page_snapshot` | **ARIA snapshot + `[ref=eN]`**: the most commonly used way to "see clearly what is on the page right now"; mutating tools attach one automatically after execution |
| `page_state` / `page_text` / `page_html` / `page_count` / `page_wait` | Page summary / subtree full text / bounded HTML / node count / wait for element |
| `page_tabs` / `page_events` | Tabs / browsing trail |
| `page_click` / `page_type` / `page_key` / `page_select` / `page_scroll` / `page_highlight` | Operate the page (`page_key` sends real keystrokes with `keyCode`; highlighting flashes once on your screen) |
| `page_eval` / `page_navigate` / `page_open` / `page_close` / `page_screenshot` | Run JS / navigate / open a new tab / close a tab / screenshot |
| `page_use_browser` / `page_status` / `bridge_stop` | Pin the target when there are multiple browsers / connection status / stop the bridge (it restarts automatically next time) |

How to install (**choose one of the two, do not install both**, `serverName: page-bridge` must be unique):

```powershell
# A. link 安装（可被 plugin_manager 管理）
dsh plugin --profile desktop add link:<仓库路径>\dsh-plugin

# B. 已经生效的等价做法：把 dsh-plugin/cordis.patch.yml 的 insert 段
#    复制进 profile 的 cordis.patch.yml（当前 desktop profile 就是这么挂的）
```

## Works with other agents and editors too (not just DSH)

This project is **not DSH-specific**: the extension is plain MV3, the bridge and the CLI have **zero dependencies**,
and the MCP server speaks **standard MCP** (stdio, `initialize` / `tools/list` / `tools/call`). So any MCP client,
and any agent that can run a command, can drive it:

| What you use | How to connect |
|---|---|
| **Any MCP client** (Claude Code / Claude Desktop, Cursor, Cline, Zed…) | Add an `mcpServers` entry to its own config (below) |
| **Any agent that can run a shell** | Call the CLI directly: `node page.mjs state`, `node page.mjs click "@e12"` |
| **Your own client** | `POST http://127.0.0.1:8799/cmd` (with `Authorization: Bearer <token>`) or `ws://127.0.0.1:8799/ws?token=…` |

MCP config (the location and exact field names differ per client — follow its docs; some also want `"type": "stdio"`):

```json
{
  "mcpServers": {
    "page-bridge": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["E:\\dsh\\page-bridge\\mcp-server.mjs"]
    }
  }
}
```

Three things to know:

- **Capability token**: every client needs it (`node page.mjs token`) — processes under the same Windows user can read
  `var/bridge-token`, other users cannot; that is the design boundary;
- **The native host registration is per browser**, not per DSH: other agents get that benefit for free;
- **Tool name prefixes change**: `mcp__page-bridge__*` is DSH's naming convention; other clients display their own
  prefix, with identical functionality.

`dsh-plugin/` is the only DSH-specific part (the Cordis profile patch format); other clients do not need it.

## Optional upgrades

- When you need **real input events/network and console**, you can add `chrome.debugger` (CDP): it gives access to `Input.*` and
  `Network.*` events, at the cost of a "This browser is being debugged" bar appearing at the top of Chrome, and being mutually exclusive with DevTools.
