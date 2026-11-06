#!/usr/bin/env node
/**
 * sw-load-test.mjs — load the extension service worker in Node with a fake `chrome` API.
 *
 * Catches the class of bug that is invisible to `node --check`: a module-level crash
 * (TDZ / undefined reference) that makes Chrome's service worker die instantly. It also
 * drives the real transport state machine without a browser:
 *
 *   1. the module evaluates at all,
 *   2. a healthy native host becomes the active transport (hello sent eagerly — waiting
 *      for the host to speak first deadlocked both sides),
 *   3. commands are refused while no tab is shared,
 *   4. a host that never answers → probe timeout → WebSocket fallback,
 *   5. a host that dies after working → native is retried (not silently downgraded).
 *
 *   node dev/sw-load-test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', 'extension');
const SOURCE = readFileSync(join(HERE, '..', 'extension', 'background.js'), 'utf8');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ fake platform */

const makeEvent = () => {
  const listeners = [];
  return {
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener: (fn) => listeners.includes(fn),
    fire: (...args) => [...listeners].forEach((fn) => fn(...args)),
    count: () => listeners.length,
  };
};

function makePlatform({ storageDelay = 0 } = {}) {
  const local = new Map([['enabled', true], ['transport', 'auto']]);
  const session = new Map();

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.listeners = {};
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = FakeWebSocket.CLOSED; this.emit('close', {}); }
    emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
    open() { this.readyState = FakeWebSocket.OPEN; this.emit('open', {}); }
    message(obj) { this.emit('message', { data: JSON.stringify(obj) }); }
  }

  const chrome = {
    calls: [],
    ports: [],
    badge: '',
    tabUrl: 'https://example.com/',
    storage: {
      local: {
        get: async (defaults) => {
          if (storageDelay) await new Promise((resolve) => setTimeout(resolve, storageDelay));
          return Object.fromEntries(Object.entries(defaults ?? {}).map(([k, v]) => [k, local.has(k) ? local.get(k) : v]));
        },
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) local.set(k, v); },
      },
      session: {
        get: async (defaults) => Object.fromEntries(Object.entries(defaults ?? {}).map(([k, v]) => [k, session.has(k) ? session.get(k) : v])),
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) { if (v === null) session.delete(k); else session.set(k, v); } },
      },
    },
    action: { setBadgeText: ({ text }) => { chrome.badge = text; }, setBadgeBackgroundColor: () => {} },
    tabs: {
      query: async () => [{ id: 11, windowId: 1, active: true, url: chrome.tabUrl, title: 'Example' }],
      get: async (id) => ({ id, windowId: 1, active: true, url: chrome.tabUrl, title: 'Example', status: 'complete' }),
      update: async (id, props) => {
      chrome.calls.push({ fn: 'tabs.update', id, url: props?.url });
      return { id, windowId: 1, url: props?.url ?? chrome.tabUrl, active: true, status: 'complete' };
    },
      create: async ({ url, active }) => {
        chrome.calls.push({ fn: 'tabs.create', url, active });
        return { id: 99, windowId: 1, url, title: '', active: active !== false };
      },
      remove: async () => {},
      captureVisibleTab: async () => 'data:image/png;base64,AAAA',
      onActivated: makeEvent(),
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
      onCreated: makeEvent(),
    },
    windows: { update: async () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    alarms: { create: () => {}, onAlarm: makeEvent() },
    runtime: {
      lastError: null,
      id: 'abcdefghijklmnopabcdefghijklmnop',
      getURL: (p) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
      getManifest: () => ({ version: '0.0.0-test' }),
      onMessage: makeEvent(),
      onStartup: makeEvent(),
      onInstalled: makeEvent(),
      connectNative: (name) => {
        chrome.calls.push({ fn: 'connectNative', name });
        const port = {
          name,
          sent: [],
          onMessage: makeEvent(),
          onDisconnect: makeEvent(),
          postMessage(msg) { this.sent.push(msg); },
          disconnect() { this.disconnected = true; this.onDisconnect.fire(); },
          emitMessage(msg) { this.onMessage.fire(msg); },
          die(reason) { chrome.runtime.lastError = reason ? { message: reason } : null; this.onDisconnect.fire(); chrome.runtime.lastError = null; },
        };
        chrome.ports.push(port);
        return port;
      },
    },
  };
  return { chrome, FakeWebSocket };
}

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

/** popup 的身份；另一个模拟"注入脚本所在页面"的来源，用来验证提权守卫 */
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const POPUP_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` };
const ISOLATED_SENDER = { id: EXT_ID, url: 'https://example.com/' };
const EDGE_UA = `${CHROME_UA} Edg/154.0.4258.48`;

/** Load background.js in a fresh context with a fake platform. */
async function loadWorker({ userAgent = CHROME_UA, storageDelay = 0, skipPolicy = false, triggerEarlyActivation = false } = {}) {
  const { chrome, FakeWebSocket } = makePlatform({ storageDelay });
  const context = vm.createContext({
    chrome,
    // A service worker always has navigator; the extension uses its UA to tell Chrome from
    // Edge (same directory → same extension ID, so the bridge cannot tell otherwise).
    navigator: { userAgent },
    // A service worker has WebCrypto; the extension uses it to mint a per-profile instance id.
    crypto: globalThis.crypto,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    WebSocket: FakeWebSocket,
    URL, URLSearchParams, Date, Math, JSON, Promise, Error, String, Number, Boolean,
    Array, Object, RegExp, Set, Map, Buffer, structuredClone,
  });
  context.globalThis = context;
  context.importScripts = (...paths) => {
    if (skipPolicy) return;
    for (const path of paths) {
      const source = readFileSync(join(EXTENSION_DIR, path), 'utf8');
      vm.runInContext(source, context, { filename: path });
    }
  };
  let loadError = null;
  try {
    vm.runInContext(SOURCE, context, { filename: 'background.js' });
  } catch (error) {
    loadError = error;
  }
  if (triggerEarlyActivation) chrome.tabs.onActivated.fire({ tabId: 11 });
  await sleep(250);   // let the bootstrap promise resolve
  const status = () => new Promise((resolve) => {
    let answered = false;
    chrome.runtime.onMessage.fire({ kind: 'status' }, {}, (reply) => { answered = true; resolve(reply); });
    setTimeout(() => { if (!answered) resolve(null); }, 250);
  });
  return { chrome, FakeWebSocket, status, loadError, context };
}

/* ------------------------------------------------------------------- test 1 */

console.log('--- 1. service worker 加载 ---');
const worker = await loadWorker();
check('模块级求值不抛异常', !worker.loadError, String(worker.loadError?.stack ?? worker.loadError ?? ''));
if (worker.loadError) process.exit(1);
check('auto 模式下先尝试 native', worker.chrome.calls.some((c) => c.fn === 'connectNative'), JSON.stringify(worker.chrome.calls));
check('启动阶段没有抢先建 WebSocket', worker.FakeWebSocket.instances.length === 0, `instances=${worker.FakeWebSocket.instances.length}`);

console.log('\n--- 1b. bootstrap 期间的早期事件不能抢先发 hello ---');
const delayedWorker = await loadWorker({ storageDelay: 50, triggerEarlyActivation: true });
const delayedPort = delayedWorker.chrome.ports.at(-1);
const delayedHello = delayedPort?.sent.find((message) => message.type === 'hello');
check('storage bootstrap 延迟时仍只发送带 instance 的第一条 hello',
  typeof delayedHello?.instance === 'string' && delayedHello.instance.length === 16,
  JSON.stringify(delayedHello));

console.log('\n--- 1c. policy.js 缺失时给出可诊断错误 ---');
const missingPolicyWorker = await loadWorker({ skipPolicy: true });
const missingPolicyStatus = await missingPolicyWorker.status();
check('policy.js 缺失不会静默变成 TypeError',
  /policy\.js 未加载/.test(missingPolicyStatus?.lastError ?? '') && !/TypeError/.test(missingPolicyStatus?.lastError ?? ''),
  JSON.stringify(missingPolicyStatus));

/* ------------------------------------------------------------------- test 2 */

console.log('\n--- 2. native 正常：成为活动传输 ---');
const port = worker.chrome.ports.at(-1);
port.emitMessage({ type: 'hello-ack', server: 'test' });
await sleep(60);
let status = await worker.status();
check('activeTransport = native', status?.activeTransport === 'native', JSON.stringify(status));
check('hello 立即发出（不等对方先说话）', port.sent.some((m) => m.type === 'hello'), JSON.stringify(port.sent));

/* ------------------------------------------------------------------- test 3 */

console.log('\n--- 3. 未共享标签页：命令被拒 ---');
port.emitMessage({ type: 'cmd', id: 'c1', name: 'state', args: {} });
await sleep(200);
const denied = port.sent.find((m) => m.type === 'result' && m.id === 'c1');
check('返回 ok:false 而非执行', denied?.ok === false, JSON.stringify(denied));
check('错误文案可操作（提示去共享）', /共享/.test(denied?.error ?? ''), denied?.error);

/* ------------------------------------------------------------------- test 4 */

console.log('\n--- 4. 宿主从不应答：探测超时 → 但没有令牌时不连 WS ---');
const silent = await loadWorker();
const silentPort = silent.chrome.ports.at(-1);
check('已尝试 native', Boolean(silentPort));
await sleep(1200);                                  // probe window is 900ms
check('探测超时后主动断开端口', silentPort.disconnected === true, JSON.stringify(silentPort));
check('没有令牌就不建 WebSocket（回环端口不是信任边界）',
  silent.FakeWebSocket.instances.length === 0, `instances=${silent.FakeWebSocket.instances.length}`);
const noTokenStatus = await silent.status();
check('把可操作的提示留在 lastError 里',
  /令牌/.test(noTokenStatus?.lastError ?? ''), JSON.stringify(noTokenStatus?.lastError));

console.log('\n--- 4b. 用户粘贴令牌后，WS 回退应当成功（正向对照） ---');
const setTok = await new Promise((resolve) => {
  silent.chrome.runtime.onMessage.fire({ kind: 'setWsToken', token: 'test-token-1234567890' }, POPUP_SENDER, resolve);
});
check('popup 可以设置 WS 令牌', setTok?.ok === true && setTok?.hasToken === true, JSON.stringify(setTok));
await sleep(1200);
check('拿到令牌后建立了 WebSocket', silent.FakeWebSocket.instances.length > 0, `instances=${silent.FakeWebSocket.instances.length}`);
check('WS URL 里带上了令牌', /token=test-token-1234567890/.test(silent.FakeWebSocket.instances.at(-1)?.url ?? ''),
  String(silent.FakeWebSocket.instances.at(-1)?.url));
silent.FakeWebSocket.instances.at(-1)?.open();
await sleep(60);
status = await silent.status();
check('activeTransport = ws（回退成功）', status?.activeTransport === 'ws', JSON.stringify(status));
check('isolated-world 不能设置令牌（特权设置）', (await new Promise((resolve) => {
  silent.chrome.runtime.onMessage.fire({ kind: 'setWsToken', token: 'evil' }, ISOLATED_SENDER, resolve);
}))?.ok === false);

/* ------------------------------------------------------------------- test 5 */

console.log('\n--- 5. 曾经可用的宿主掉线：重试 native，而非降级 ---');
const nativeCallsBefore = worker.chrome.calls.filter((c) => c.fn === 'connectNative').length;
const wsBefore = worker.FakeWebSocket.instances.length;
port.die('Native host has exited');
await sleep(900);                                   // reconnect delay is 500ms
const nativeCallsAfter = worker.chrome.calls.filter((c) => c.fn === 'connectNative').length;
check('重新尝试 native', nativeCallsAfter > nativeCallsBefore, `${nativeCallsBefore} → ${nativeCallsAfter}`);
check('没有回退到 WebSocket', worker.FakeWebSocket.instances.length === wsBefore,
  `instances ${wsBefore} → ${worker.FakeWebSocket.instances.length}`);

console.log('\n--- 6. 完全接管：无需共享即可操作任意标签页 ---');
const say = (kind, payload, sender = POPUP_SENDER) => new Promise((resolve) => {
  let done = false;
  worker.chrome.runtime.onMessage.fire({ kind, ...payload }, sender, (reply) => { done = true; resolve(reply); });
  setTimeout(() => { if (!done) resolve(null); }, 250);
});
const sendCmd = async (id, name, args = {}) => {
  // Test 5 killed the original port, so always talk to the newest one the SW holds.
  const live = worker.chrome.ports.at(-1);
  live.emitMessage({ type: 'cmd', id, name, args });
  // 轮询而不是固定等 200ms：有些动作带 settle 延迟（例如点击后的导航复核要等 250ms）。
  for (let i = 0; i < 30; i += 1) {
    await sleep(100);
    const hit = live.sent.filter((m) => m.type === 'result' && m.id === id).at(-1);
    if (hit) return hit;
  }
  return undefined;
};

let reply = await say('setFullAccess', { value: true });
check('弹窗可开启完全接管', reply?.fullAccess === true, JSON.stringify(reply));
check('徽标变为 ALL', worker.chrome.badge === 'ALL', worker.chrome.badge);

console.log('\n--- 6b. 提权守卫：只有 popup 能改特权设置 ---');
const privBefore = (await say('status', {}))?.fullAccess;
let deniedBySender = await say('setFullAccess', { value: false }, ISOLATED_SENDER);
check('isolated-world 调 setFullAccess 被拒', deniedBySender?.ok === false && /forbidden/.test(deniedBySender.error ?? ''), JSON.stringify(deniedBySender));
const privAfter = (await say('status', {}))?.fullAccess;
check('被拒后 fullAccess 未被改动', privAfter === privBefore, `${privBefore} → ${privAfter}`);
deniedBySender = await say('setPolicy', { blockDomains: 'evil.com' }, ISOLATED_SENDER);
check('isolated-world 调 setPolicy 被拒', deniedBySender?.ok === false && /forbidden/.test(deniedBySender.error ?? ''), JSON.stringify(deniedBySender));
deniedBySender = await say('share', {}, ISOLATED_SENDER);
check('isolated-world 调 share 被拒', deniedBySender?.ok === false && /forbidden/.test(deniedBySender.error ?? ''), JSON.stringify(deniedBySender));
const eventSink = [
  ...worker.chrome.ports.flatMap((p) => p.sent ?? []),
  ...worker.FakeWebSocket.instances.flatMap((w) => w.sent ?? []),
];
check('拒绝动作被记成事件（可观测）', eventSink.some((m) => m.type === 'event' && m.name === 'privileged-rejected'),
  JSON.stringify(eventSink.filter((m) => m.type === 'event').slice(-3)));
const popupStillWorks = await say('status', {}, POPUP_SENDER);
check('popup 自己仍可正常调用（正向对照）', popupStillWorks?.fullAccess === true, JSON.stringify(popupStillWorks));

let res = await sendCmd('c2', 'state');
check('未共享也能读任意标签页', res?.ok === true, JSON.stringify(res));

console.log('\n--- 7. 完全接管：可以打开新标签页 ---');
res = await sendCmd('c3', 'open', { url: 'https://example.com/new' });
check('open 返回新标签页 id', res?.ok === true && res.result?.tabId === 99, JSON.stringify(res));
check('确实调用了 tabs.create', worker.chrome.calls.some((c) => c.fn === 'tabs.create'), JSON.stringify(worker.chrome.calls.at(-1)));

console.log('\n--- 8. 完全接管下黑名单仍然生效 ---');
await say('setPolicy', { allowDomains: '', blockDomains: 'blocked.com' });
res = await sendCmd('c4', 'open', { url: 'https://blocked.com/login' });
check('拒开黑名单域名', res?.ok === false && /黑名单/.test(res.error), JSON.stringify(res));
worker.chrome.tabUrl = 'https://blocked.com/secret';
res = await sendCmd('c5', 'state');
check('拒绝读取黑名单页面', res?.ok === false && /黑名单/.test(res.error), JSON.stringify(res));
worker.chrome.tabUrl = 'https://example.com/';

console.log('\n--- 9. Agent 无法自己提权 ---');
res = await sendCmd('c6', 'setFullAccess', { value: true });
check('桥接侧没有提权命令', res?.ok === false && /unknown command/.test(res.error), JSON.stringify(res));

console.log('\n--- 10. 关掉完全接管后回到共享模式 ---');
await say('setFullAccess', { value: false });
res = await sendCmd('c7', 'state');
check('重新要求共享（回到窄模式）', res?.ok === false && /共享/.test(res.error), JSON.stringify(res));

console.log('\n--- 10b. 窄授权 = origin 级委托（外部评审定的语义） ---');
// 在 github.com 上共享一个标签页
worker.chrome.tabUrl = 'https://github.com/fannis9/pagebridge';
await say('share', { tabId: 11 });
const countCalls = (fn) => worker.chrome.calls.filter((c) => c.fn === fn).length;
const updatesBefore = countCalls('tabs.update');
const createsBefore = countCalls('tabs.create');
const scriptsBefore = countCalls('scripting.executeScript');

res = await sendCmd('n1', 'navigate', { url: 'https://github.com/other/repo' });
check('同 origin 导航 → 允许', res?.ok === true, JSON.stringify(res));
check('  并真的调用了 tabs.update', countCalls('tabs.update') > updatesBefore);

const updatesAfterSameOrigin = countCalls('tabs.update');
res = await sendCmd('n2', 'navigate', { url: 'https://evil.example/steal' });
check('跨 origin 导航 → 事前拒绝', res?.ok === false && /origin/.test(res.error), JSON.stringify(res));
check('  且完全没有发起导航（不是事后撤销）', countCalls('tabs.update') === updatesAfterSameOrigin,
  `update 调用数 ${updatesAfterSameOrigin} → ${countCalls('tabs.update')}`);

await say('setPolicy', { blockDomains: 'blocked.com' });
res = await sendCmd('n3', 'navigate', { url: 'https://blocked.com/login' });
check('黑名单目标 → 拒绝（窄模式）', res?.ok === false && /黑名单/.test(res.error), JSON.stringify(res));

res = await sendCmd('n4', 'open', { url: 'https://github.com/new' });
check('同 origin 开新标签页 → 允许', res?.ok === true && res.result?.tabId === 99, JSON.stringify(res));
check('  并真的调用了 tabs.create', countCalls('tabs.create') > createsBefore);
const createsAfterSameOrigin = countCalls('tabs.create');
res = await sendCmd('n5', 'open', { url: 'https://google.com/' });
check('跨 origin 开新标签页 → 拒绝', res?.ok === false && /origin/.test(res.error), JSON.stringify(res));
check('  且没有真的开标签页', countCalls('tabs.create') === createsAfterSameOrigin);

res = await sendCmd('n6', 'eval', { code: 'location.href = "https://evil.example/"' });
check('窄模式下 MAIN eval → 拒绝（它是任意 JS 能力）', res?.ok === false && /ISOLATED|完全接管/.test(res.error), JSON.stringify(res));
check('  且没有注入执行', countCalls('scripting.executeScript') === scriptsBefore);
res = await sendCmd('n7', 'eval', { code: 'document.title', world: 'ISOLATED' });
check('窄模式下 ISOLATED eval → 允许（正向对照）', res?.ok === true, JSON.stringify(res));

res = await sendCmd('n8', 'state');
check('被拒之后共享依然有效（没有误伤）', res?.ok === true, JSON.stringify(res));

console.log('\n--- 10c. 动作之后的"事后收权"（click/form 可能让页面自己导航） ---');
worker.chrome.tabUrl = 'https://github.com/fannis9/pagebridge';
await say('share', { tabId: 11 });
res = await sendCmd('p1', 'click', { selector: '#link' });
check('同 origin 的点击 → 共享保留', res?.ok === true && res.result?.grantAlive !== false, JSON.stringify(res));

// 模拟"这一点让页面自己导航走了"
worker.chrome.tabUrl = 'https://evil.example/steal';
res = await sendCmd('p2', 'click', { selector: '#link' });
check('点击导致跨 origin → 自动撤销共享', res?.result?.grantAlive === false, JSON.stringify(res));
check('  结果里说明了原因', /origin|黑名单/.test(res?.result?.note ?? ''), JSON.stringify(res?.result?.note));
res = await sendCmd('p3', 'state');
check('  撤销之后读一下都要求重新共享', res?.ok === false && /共享/.test(res.error), JSON.stringify(res));

console.log('\n--- 11. 浏览器识别（Chrome/Edge 同目录同 ID，需要区分） ---');
check('Chrome UA → chrome', vm.runInContext('BROWSER_NAME', worker.context) === 'chrome',
  vm.runInContext('BROWSER_NAME', worker.context));
const edgeWorker = await loadWorker({ userAgent: EDGE_UA });
check('Edge UA → edge', vm.runInContext('BROWSER_NAME', edgeWorker.context) === 'edge',
  vm.runInContext('BROWSER_NAME', edgeWorker.context));
const edgePort = edgeWorker.chrome.ports.at(-1);
edgePort?.emitMessage({ type: 'hello-ack', server: 'test' });
await sleep(80);
const edgeReply = await new Promise((resolve) => {
  edgeWorker.chrome.runtime.onMessage.fire({ kind: 'grant' }, {}, resolve);
  setTimeout(() => resolve(null), 250);
});
check('hello 里带上了 browser=edge（桥接据此分辨）',
  edgePort?.sent.some((m) => m.type === 'hello' && m.browser === 'edge'),
  JSON.stringify(edgePort?.sent?.find((m) => m.type === 'hello')));

console.log(`\n${failures ? `✗ ${failures} 个断言失败` : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
