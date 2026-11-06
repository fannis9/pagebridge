#!/usr/bin/env node
/**
 * Page Bridge — MCP stdio server.
 *
 * Wraps the local bridge (127.0.0.1:8799) as MCP tools so every DSH session gets
 * `mcp__page-bridge__*` natively. The bridge is started on demand (detached) and
 * exits by itself when idle; nothing needs to be running beforehand.
 *
 * stdout carries JSON-RPC only — all diagnostics go to stderr.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, 'bridge.mjs');
const SHOTS = join(HERE, 'var', 'shots');
const PORT = Number(process.env.PAGE_BRIDGE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const DEFAULT_TIMEOUT_MS = 60_000;

const log = (...args) => console.error('[page-bridge-mcp]', ...args);

/* ------------------------------------------------------------ bridge control */

const TOKEN_FILE = process.env.PAGE_BRIDGE_TOKEN_FILE ?? join(HERE, 'var', 'bridge-token');
let tokenCache = null;
/**
 * 本地控制面的能力令牌（桥接首次启动时生成于 var/bridge-token）。
 * 回环端口不是信任边界：没有令牌的本地进程不该能驱动用户的浏览器。
 */
function bridgeToken(force = false) {
  if (tokenCache && !force) return tokenCache;
  try { tokenCache = readFileSync(TOKEN_FILE, 'utf8').trim() || tokenCache; } catch { /* 桥接还没起过 */ }
  return tokenCache;
}

async function bridgeAlive(timeoutMs = 900) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const token = bridgeToken(true);
    const res = await fetch(`${BASE}/status`, {
      signal: ctl.signal,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    clearTimeout(timer);
    if (res.status === 401) {
      log('桥接返回 401：能力令牌不匹配，可能有旧桥接进程占着端口');
      return true;
    }
    return res.status === 200;
  } catch {
    return false;
  }
}

let starting = null;
async function ensureBridge() {
  if (await bridgeAlive()) return false;
  if (starting) return starting;
  starting = (async () => {
    log('bridge not running, starting it…');
    const child = spawn(process.execPath, [BRIDGE, '--port', String(PORT)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await bridgeAlive()) { log('bridge ready'); return true; }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`桥接启动失败，请手动运行：node "${BRIDGE}" --port ${PORT}`);
  })().finally(() => { starting = null; });
  return starting;
}

async function request(path, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const token = bridgeToken();
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctl.signal,
      headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 最近一次命令是**哪个浏览器**接的。桥接在 /cmd 回包里带上了它，于是随后的自动快照可以固定到
 * 同一个浏览器——否则动作在 Chrome 执行、用户在等待期间切到 Edge，快照就会拍到另一台（评审第 10 条）。
 */
let lastServedBrowser = null;

/** Forward one command to the extension; wait for it to (re)connect if needed. */
async function cmd(name, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await ensureBridge();
  const { status, body } = await request('/cmd', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      args,
      browser: pinnedBrowser,
      // Let a sleeping service worker wake up instead of failing instantly.
      waitMs: Number(process.env.PAGE_BRIDGE_WAIT_MS ?? 30_000),
      timeoutMs,
    }),
  }, timeoutMs + 35_000);
  if (status !== 200 || !body?.ok) {
    const reason = body?.error ?? `桥接返回 HTTP ${status}`;
    throw new Error(/扩展未连接/.test(reason)
      ? `${reason}（Chrome 空闲时扩展 worker 会休眠，最多 30 秒后自动唤醒；点一下扩展图标或切换标签页可立即唤醒）`
      : reason);
  }
  if (body.browser) lastServedBrowser = body.browser;
  return body.result;
}

/* ---------------------------------------------------------------- formatting */

/**
 * Snapshot-after-action, borrowed from BrowserMCP's `ToolFactory(snapshot)` design:
 * every mutating tool answers with a status line plus a fresh ARIA snapshot, so the
 * model always reasons about the page as it is *now* (and gets fresh refs).
 */
const SNAPSHOT_AFTER_ACTION = process.env.PAGE_BRIDGE_SNAPSHOT !== '0';
const SNAPSHOT_SETTLE_MS = Number(process.env.PAGE_BRIDGE_SETTLE_MS ?? 250);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * When Chrome and Edge both have the extension, the bridge would otherwise pick a target
 * per call (tab ids are per-browser, so that silently mixes them up). `page_use_browser`
 * pins one for this MCP session; the bridge also prefers the focused window on its own.
 */
let pinnedBrowser = null;

/** Render one snapshot result the way BrowserMCP does: URL / Title / fenced yaml. */
function snapshotBlock(snap, status = '') {
  const head = status ? `${status}\n` : '';
  if (!snap?.yaml) return `${head}(快照不可用：页面可能正在导航)`;
  return [
    head,
    `- Page URL: ${snap.url}`,
    `- Page Title: ${snap.title}`,
    '- Page Snapshot',
    '```yaml',
    snap.yaml,
    '```',
    '',
  ].join('\n');
}

/**
 * Take a fresh snapshot; never let snapshotting fail an otherwise successful action.
 * A just-navigated page is often still rendering, so a degenerate snapshot (almost no
 * nodes) is retried once with a longer settle instead of being returned as the answer.
 */
async function snapshotAfter(status, options = {}) {
  if (!SNAPSHOT_AFTER_ACTION) return status;
  const settleMs = Number(options.settleMs ?? SNAPSHOT_SETTLE_MS);
  const minNodes = Number(options.minNodes ?? 3);
  // Targeting matters when an action created a *background* tab.
  const tabArgs = options.tabId === undefined ? {} : { tabId: options.tabId };
  // 固定浏览器：优先用"这一单是谁执行的"，其次用会话里 pin 的那个。
  // 不固定的话，用户在动作与快照之间切窗口，快照就可能拍到另一台浏览器（评审第 10 条）。
  const browser = options.browser ?? lastServedBrowser ?? pinnedBrowser ?? undefined;
  const snapArgs = browser ? { ...tabArgs, browser } : tabArgs;
  let snap = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await sleep(attempt === 0 ? settleMs : Math.max(settleMs, 900));
    try {
      snap = await cmd('snapshot', snapArgs, 30_000);
    } catch (error) {
      if (attempt === 1) return `${status}\n(快照失败：${String(error?.message ?? error)})`;
      snap = null;
      continue;
    }
    if (snap && (snap.nodes >= minNodes || snap.refs > 0)) break;
  }
  const thin = snap && snap.nodes < minNodes ? '\n(注意：快照节点很少，页面可能仍在渲染，可稍后再调 page_snapshot)' : '';
  return `${snapshotBlock(snap, status)}${thin}`;
}

/** Accept either a CSS selector / text= target, or a snapshot ref (@e12 / e12 / ref=e12). */
function targetOf(args, fallbackName = 'selector') {
  const ref = args?.ref;
  if (ref !== undefined && ref !== null && String(ref).trim() !== '') {
    const clean = String(ref).trim().replace(/^@/, '').replace(/^ref=/, '');
    return `@${clean}`;
  }
  const selector = args?.[fallbackName];
  if (typeof selector !== 'string' || selector.trim() === '') throw new Error('需要 selector 或 ref 参数');
  return selector;
}

function stateText(state) {
  if (!state || typeof state !== 'object') return JSON.stringify(state, null, 2);
  const lines = [`# ${state.title ?? ''}`, state.url ?? ''];
  if (state.lang) lines.push(`lang: ${state.lang}`);
  if (state.selection) lines.push('', '[选中的文本]', state.selection);
  if (state.headings?.length) {
    lines.push('', '[标题结构]');
    for (const h of state.headings) lines.push(`${'  '.repeat(Math.max(0, (h.level ?? 1) - 1))}h${h.level} ${h.text}`);
  }
  if (state.forms?.length) {
    lines.push('', '[可交互元素]');
    for (const f of state.forms) {
      lines.push(`  <${f.tag}${f.type ? ` type=${f.type}` : ''}${f.id ? ` #${f.id}` : ''}> ${f.label ?? f.text ?? f.placeholder ?? ''}`.trimEnd());
    }
  }
  if (state.scroll) lines.push('', `[滚动] y=${state.scroll.y} / 文档高 ${state.scroll.height}，视口 ${state.scroll.viewport}`);
  lines.push('', '[正文]', state.text ?? '');
  return lines.join('\n');
}

const json = (value) => JSON.stringify(value, null, 2);

/* -------------------------------------------------------------------- tools */

const tools = [
  {
    name: 'page_status',
    description: '查看浏览器扩展与本地桥接的连接状态：连接了哪些浏览器（chrome/edge）、当前命令会发给谁、'
      + '共享了哪个标签页、是否已「完全接管」、传输方式（native / ws）、域名策略。'
      + '其他工具报“尚未共享”或“找不到标签页”时先调它确认；多浏览器时可用 page_use_browser 固定目标。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      await ensureBridge();
      const { body } = await request('/status');
      let grant = null;
      if (body?.extensionConnected) {
        try { grant = await cmd('grant', {}, 10_000); } catch (error) { grant = { error: String(error?.message ?? error) }; }
      }
      return json({ ...body, pinnedBrowser, grant });
    },
  },
  {
    name: 'page_use_browser',
    description: '当 Chrome 和 Edge 同时开着扩展时，用它把后续命令固定到某一个浏览器。'
      + 'tabId 是各浏览器自己的编号，所以跨浏览器操作前应该先固定目标；传空字符串可取消固定，'
      + '回到「谁在前台就用谁」的默认行为。',
    inputSchema: {
      type: 'object',
      properties: { browser: { type: 'string', description: 'chrome / edge / firefox…；传空字符串取消固定' } },
      additionalProperties: false,
    },
    async run(args) {
      const wanted = String(args.browser ?? '').trim().toLowerCase();
      const before = pinnedBrowser;
      pinnedBrowser = wanted === '' ? null : wanted;
      let browsers = [];
      try {
        const { body } = await request('/status');
        browsers = body?.browsers ?? [];
      } catch { /* bridge may be down; the pin still applies */ }
      return json({
        pinned: pinnedBrowser,
        previous: before,
        connectedBrowsers: browsers,
        note: pinnedBrowser
          ? `后续命令固定发给 ${pinnedBrowser}`
          : '已取消固定：桥接会优先用窗口在前台的那个浏览器',
      });
    },
  },
  {
    name: 'page_open',
    description: '打开一个新标签页（并可自动读回它的 ARIA 快照）。需要在扩展弹窗里打开「完全接管」，'
      + '或已共享一个标签页。active=false 时在后台打开，不打断用户当前操作。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的地址，默认 about:blank' },
        active: { type: 'boolean', description: '是否切到该标签页，默认 true；false = 后台打开' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const res = await cmd('open', { url: args.url, active: args.active }, 30_000);
      const status = `Opened ${res?.url ?? args.url} → tab ${res?.tabId}${res?.active ? '' : ' (后台)'}`;
      // Snapshot the tab we just created, which may not be the active one.
      return snapshotAfter(status, { tabId: res?.tabId, settleMs: 1200, minNodes: 5 });
    },
  },
  {
    name: 'page_snapshot',
    description: '抓取当前页面的 ARIA 无障碍快照（Playwright 风格 YAML，交互元素带 [ref=eN]）。'
      + '比截图省 token、比纯文本保留结构；拿到 ref 后可直接用 page_click 的 ref 参数点击，'
      + '不用自己写选择器。所有变更类工具执行后都会自动附带一份新快照。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '指定标签页 id（默认：当前活动标签页）' },
        selector: { type: 'string', description: '只抓该 CSS 选择器命中的子树（页面很大时很有用，如 #user-repositories-list）' },
        maxNodes: { type: 'number', description: '最多输出节点数，默认 500' },
        maxDepth: { type: 'number', description: '最大深度，默认 14' },
        maxName: { type: 'number', description: '节点名称/文本最大字符数，默认 120' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const snap = await cmd('snapshot', {
        tabId: args.tabId,
        selector: args.selector,
        maxNodes: args.maxNodes,
        maxDepth: args.maxDepth,
        maxName: args.maxName,
      }, 30_000);
      if (snap?.ok === false) throw new Error(snap.reason ?? '快照失败');
      return snapshotBlock(snap);
    },
  },
  {
    name: 'page_state',
    description: '读取用户当前正在浏览的标签页：标题、URL、选中的文本、标题结构、表单、滚动位置和正文。回答关于“这个页面”的问题时先用它。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '指定标签页 id（默认：当前活动标签页）' },
        maxText: { type: 'number', description: '正文最大字符数，默认 12000' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const state = await cmd('state', { tabId: args.tabId, maxText: args.maxText });
      return stateText(state);
    },
  },
  {
    name: 'page_text',
    description: '读取当前页面的纯文本（比 page_state 更长，适合通读长文/条款）。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        selector: { type: 'string', description: '只读取该 CSS/ref/text= 子树，且包含其中的 open shadow root 文本' },
        max: { type: 'number', description: '最大字符数，默认 20000' },
      },
      additionalProperties: false,
    },
    async run(args) { return json(await cmd('text', { tabId: args.tabId, selector: args.selector, max: args.max })); },
  },
  {
    name: 'page_html',
    description: '读取当前页面或指定子树的有界 HTML（包含 open shadow root），超出节点/字节上限会返回 truncated=true。',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number' },
        selector: { type: 'string', description: '只序列化该 CSS/ref/text= 子树' },
        max: { type: 'number', description: '最大字符数，默认 2000000，上限 2000000' },
        maxNodes: { type: 'number', description: '最大节点数，默认 5000，上限 20000' },
      },
      additionalProperties: false,
    },
    async run(args) { return json(await cmd('html', { tabId: args.tabId, selector: args.selector, max: args.max, maxNodes: args.maxNodes })); },
  },
  {
    name: 'page_count',
    description: '统计当前页面或指定 CSS 选择器在 composed/shadow DOM 中匹配的节点数。',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' }, selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    },
    async run(args) { return json(await cmd('count', { tabId: args.tabId, selector: args.selector })); },
  },
  {
    name: 'page_wait',
    description: '等待当前页面出现匹配 selector/ref/text= 的元素。',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' }, selector: { type: 'string' }, timeout: { type: 'number', description: '超时毫秒，默认 15000' } },
      required: ['selector'],
      additionalProperties: false,
    },
    async run(args) {
      const deadline = Date.now() + Math.max(0, Math.min(Number(args.timeout ?? 15_000) || 15_000, 120_000));
      for (;;) {
        const result = await cmd('wait', { tabId: args.tabId, selector: args.selector }, 10_000);
        if (result?.ok) return json(result);
        if (Date.now() >= deadline) return json({ ok: false, selector: args.selector, timeout: true });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },
  },
  {
    name: 'page_tabs',
    description: '列出用户所有打开的标签页（id、标题、URL、是否活动）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const tabs = await cmd('tabs');
      return json(tabs);
    },
  },
  {
    name: 'page_events',
    description: '用户的浏览轨迹：最近的标签页切换/加载/关闭事件（标题+URL+时间）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回条数，默认 30' } },
      additionalProperties: false,
    },
    async run(args) {
      await ensureBridge();
      const { body } = await request(`/events?limit=${Number(args.limit ?? 30)}`);
      return json(body);
    },
  },
  {
    name: 'page_eval',
    description: '在当前页面执行一段 JavaScript 并返回结果（默认 MAIN 世界；读页面 JS 变量需要 MAIN）。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '要执行的 JS 表达式或语句，例如 "document.title"' },
        tabId: { type: 'number' },
        world: { type: 'string', enum: ['MAIN', 'ISOLATED'], description: '默认 MAIN' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    async run(args) { return json(await cmd('eval', { code: args.code, tabId: args.tabId, world: args.world })); },
  },
  {
    name: 'page_click',
    description: '点击用户当前页面上的元素。目标可以是 CSS 选择器、text=可见文本，或快照里的 ref（如 e12 / @e12）。'
      + '执行后自动返回一份新的 ARIA 快照。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器，或 text=精确/包含的可见文本' },
        ref: { type: 'string', description: '快照里的元素引用，如 e12（与 selector 二选一，推荐）' },
        tabId: { type: 'number' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const target = targetOf(args);
      const res = await cmd('click', { selector: target, tabId: args.tabId });
      return snapshotAfter(`Clicked ${target} → ${res?.ok ? 'ok' : json(res)}`);
    },
  },
  {
    name: 'page_key',
    description: '发送一次按键（Enter / Backspace / Delete / Escape / Tab / ArrowUp|Down|Left|Right / Home / End / PageUp|Down / 单个字符）。'
      + '带真实的 keyCode/which，所以对「必须按回车才提交」的 React 组件（如 GitHub 的 Primer 输入框）有效。'
      + '不传 selector 时发给当前焦点元素。执行后自动返回新快照。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '键名，如 Enter、Backspace、ArrowDown；单个字符也可以（如 a）' },
        selector: { type: 'string', description: '目标元素（CSS 或 text=）；省略则发给当前焦点元素' },
        ref: { type: 'string', description: '快照里的元素引用，如 e12' },
        repeat: { type: 'number', description: '重复次数，默认 1（上限 20）' },
        tabId: { type: 'number' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    async run(args) {
      const target = (args.ref || args.selector) ? targetOf(args) : undefined;
      const res = await cmd('key', { key: args.key, selector: target, repeat: args.repeat, tabId: args.tabId });
      return snapshotAfter(`Pressed ${args.key}${target ? ` on ${target}` : ''} → ${res?.ok ? 'ok' : json(res)}`);
    },
  },
  {
    name: 'page_type',
    description: '在输入框/文本域中填写内容（派发 input+change 事件，兼容 React）。目标可用 selector 或快照 ref。'
      + '执行后自动返回新快照。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        ref: { type: 'string', description: '快照里的元素引用，如 e12' },
        text: { type: 'string' },
        submit: { type: 'boolean', description: '填完后提交表单（或按回车）' },
        tabId: { type: 'number' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async run(args) {
      const target = targetOf(args);
      const res = await cmd('type', { selector: target, text: args.text, submit: args.submit, tabId: args.tabId });
      return snapshotAfter(`Typed "${args.text}" into ${target} → ${res?.ok ? 'ok' : json(res)}`);
    },
  },
  {
    name: 'page_select',
    description: '选择下拉框（select）中的某个选项值。目标可用 selector 或快照 ref。执行后自动返回新快照。',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        ref: { type: 'string' },
        value: { type: 'string' },
        tabId: { type: 'number' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    async run(args) {
      const target = targetOf(args);
      const res = await cmd('select', { selector: target, value: args.value, tabId: args.tabId });
      return snapshotAfter(`Selected "${args.value}" in ${target} → ${res?.ok ? 'ok' : json(res)}`);
    },
  },
  {
    name: 'page_scroll',
    description: '滚动页面：给出 selector/ref 则滚动到该元素，否则按 by 像素向下滚动。执行后自动返回新快照。',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, ref: { type: 'string' }, by: { type: 'number' }, tabId: { type: 'number' } },
      additionalProperties: false,
    },
    async run(args) {
      const target = (args.ref || args.selector) ? targetOf(args) : undefined;
      const res = await cmd('scroll', { selector: target, by: args.by, tabId: args.tabId });
      return snapshotAfter(`Scrolled ${target ?? `by ${args.by ?? 800}px`} → ${res?.ok ? 'ok' : json(res)}`);
    },
  },
  {
    name: 'page_highlight',
    description: '在用户屏幕上高亮某个元素约 2.5 秒（用来告诉用户“我说的是这里”）。目标可用 selector 或快照 ref。',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, ref: { type: 'string' }, tabId: { type: 'number' } },
      additionalProperties: false,
    },
    async run(args) { return json(await cmd('highlight', { selector: targetOf(args), tabId: args.tabId })); },
  },
  {
    name: 'page_screenshot',
    description: '截取当前可见区域并返回图片（同时落盘保存）。⚠️ 需要目标浏览器窗口在**前台且未最小化**，'
      + '否则会立刻报错（截图 API 在后台窗口上会卡住）；只想读内容用 page_snapshot / page_text 更快更稳。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '保存路径，默认写入 page-bridge/var/shots/' }, tabId: { type: 'number' } },
      additionalProperties: false,
    },
    async run(args) {
      // The extension pre-checks window focus and answers fast; keep the ceiling low so a
      // background window can never turn into a 30s stall.
      const res = await cmd('shot', { tabId: args.tabId }, 15_000);
      const base64 = String(res?.dataUrl ?? '').replace(/^data:image\/\w+;base64,/, '');
      if (!base64) throw new Error('扩展没有返回截图数据');
      const target = resolve(args.path ?? join(SHOTS, `shot-${Date.now()}.png`));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(base64, 'base64'));
      // Text + image: the model sees the picture, and the path survives routes without image support.
      return {
        content: [
          { type: 'text', text: `已截图并保存：${target}\n页面：${res.title ?? ''} ${res.url ?? ''}`.trim() },
          { type: 'image', data: base64, mimeType: 'image/png' },
        ],
      };
    },
  },
  {
    name: 'page_navigate',
    description: '让用户当前（或指定）标签页跳转到某个 URL。执行后自动返回新快照。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, tabId: { type: 'number' } },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args) {
      const res = await cmd('navigate', { url: args.url, tabId: args.tabId }, 45_000);
      // Navigation needs longer: the document is usually still rendering right after.
      return snapshotAfter(`Navigated to ${args.url} → ${res?.ok ? 'ok' : json(res)}`, { settleMs: 1200, minNodes: 5 });
    },
  },
  {
    name: 'page_close',
    description: '关闭指定标签页。',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId'],
      additionalProperties: false,
    },
    async run(args) { return json(await cmd('close', { tabId: args.tabId })); },
  },
  {
    name: 'bridge_stop',
    description: '停止本地桥接进程（下次用到时会自动重启）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      if (!(await bridgeAlive())) return '桥接本来就没在运行';
      const { body } = await request('/shutdown', { method: 'POST' });
      return json(body);
    },
  },
];

/* ---------------------------------------------------------------- MCP loop */

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return; // notification

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pagebridge', version: '0.2.0' },
      });
      return;

    case 'ping':
      reply(id, {});
      return;

    case 'tools/list':
      reply(id, {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
      return;

    case 'tools/call': {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) {
        reply(id, { content: [{ type: 'text', text: `未知工具：${params?.name}` }], isError: true });
        return;
      }
      try {
        const out = await tool.run(params?.arguments ?? {});
        // Tools may return a plain string, or an MCP content array (e.g. screenshot → text + image).
        const content = out && typeof out === 'object' && Array.isArray(out.content)
          ? out.content
          : [{ type: 'text', text: String(out) }];
        reply(id, { content });
      } catch (error) {
        const message2 = String(error?.message ?? error);
        log('tool failed:', tool.name, message2);
        reply(id, { content: [{ type: 'text', text: `错误：${message2}` }], isError: true });
      }
      return;
    }

    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { log('ignoring non-JSON line'); continue; }
    void handle(message).catch((error) => log('handler error', error));
  }
});
process.stdin.on('end', () => process.exit(0));
log(`ready (bridge on ${BASE}, ${tools.length} tools)`);
