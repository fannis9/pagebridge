#!/usr/bin/env node
/**
 * native-e2e-test.mjs — end-to-end native messaging test with a REAL browser.
 *
 * An unpacked extension's ID is derived from its path, so loading E:\dsh\page-bridge\extension
 * into a throwaway Playwright profile should yield the same ID that register-host.mjs pinned
 * in allowed_origins — for Chrome AND Edge, since both are Chromium. This test proves it.
 *
 * Asserts: the extension's service worker reaches activeTransport === 'native', the browser
 * spawned the host, and the bridge reports a client with via === 'native'. It also prints the
 * ID the browser actually assigned, which is what must appear in allowed_origins.
 *
 * CI uses Playwright's bundled Chromium.  A system executable can still be selected for
 * local verification with DSH_BROWSER_EXECUTABLE (or by using --browser edge).
 *
 *   DSH_USE_BUNDLED_CHROMIUM=1 node dev/native-e2e-test.mjs --browser chrome
 *   node dev/native-e2e-test.mjs --browser edge  # local system Edge, when supported
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './playwright-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const EXTENSION = join(PROJECT, 'extension');
const MANIFEST_VERSION = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8')).version;

/**
 * 本地控制面自能力令牌收紧后要求 `Authorization: Bearer <token>`。
 * 这个 E2E 原先不带令牌 fetch /status，令牌上线后必然 401（browser-e2e 第一次真实运行即暴露此问题）。
 * 令牌文件就是桥接的默认位置：<repo>/var/bridge-token（扩展经 native messaging 拉起桥接时用的也是它）。
 */
const BRIDGE_TOKEN_FILE = join(PROJECT, 'var', 'bridge-token');
const bridgeAuthHeaders = () => {
  try {
    const token = readFileSync(BRIDGE_TOKEN_FILE, 'utf8').trim();
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
};
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

/** Chromium 的未打包扩展 ID：路径字节（Windows 为 UTF-16LE）→ SHA256 前 16 字节 → 映射到 a-p。 */
function idForPath(rawPath) {
  const normalized = process.platform === 'win32' ? rawPath.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`) : rawPath;
  const bytes = process.platform === 'win32' ? Buffer.from(normalized, 'utf16le') : Buffer.from(normalized, 'utf8');
  return [...createHash('sha256').update(bytes).digest().subarray(0, 16).toString('hex')]
    .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
    .join('');
}
const BROWSER = String(flag('browser', process.env.DSH_BROWSER ?? 'chrome')).toLowerCase();
const CANDIDATES = {
  chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
  edge: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'],
};
const SYSTEM_EXECUTABLE = [process.env.DSH_BROWSER_EXECUTABLE, ...(CANDIDATES[BROWSER] ?? [])].find((p) => p && existsSync(p));
const USE_BUNDLED = process.env.DSH_USE_BUNDLED_CHROMIUM === '1';
const EXECUTABLE = USE_BUNDLED ? null : SYSTEM_EXECUTABLE;
const PROFILE = join(PROJECT, 'var', `pw-native-profile-${BROWSER}`);
const INTERNALS = BROWSER === 'edge' ? 'edge://' : 'chrome://';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!EXECUTABLE && !USE_BUNDLED) {
  console.error(`找不到 ${BROWSER} 的可执行文件（用 DSH_BROWSER_EXECUTABLE 指定，或设置 DSH_USE_BUNDLED_CHROMIUM=1）`);
  process.exit(2);
}

rmSync(PROFILE, { recursive: true, force: true });
console.log(`浏览器   : ${BROWSER} → ${EXECUTABLE ?? 'Playwright bundled Chromium'}`);
console.log(`扩展目录 : ${EXTENSION}\n`);

const context = await chromium.launchPersistentContext(PROFILE, {
  ...(EXECUTABLE ? { executablePath: EXECUTABLE } : {}),
  headless: false,
  args: [
    `--disable-extensions-except=${EXTENSION}`,
    `--load-extension=${EXTENSION}`,
    // Chrome 137+ ignores --load-extension unless this debugging switch is on.
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
  ],
});

try {
  // First ask the browser itself what is loaded: the extensions page keeps the truth in
  // shadow DOM, and this also reports the real extension ID — which is what allowed_origins
  // must match. On Edge the whole flow is expected to actually work.
  const inspect = await context.newPage();
  await inspect.goto(`${INTERNALS}extensions/`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await sleep(1500);
  const listed = await inspect.evaluate(() => {
    const walk = (root, out = []) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === 'EXTENSIONS-ITEM' && el.id) {
          out.push({ id: el.id, name: el.getAttribute('name') ?? el.shadowRoot?.querySelector('#name')?.textContent ?? '' });
        }
        if (el.shadowRoot) walk(el.shadowRoot, out);
      }
      return out;
    };
    return walk(document);
  });
  console.log(`${BROWSER} 已加载扩展: ${listed.length ? JSON.stringify(listed) : '(空！扩展没被加载)'}\n`);

  if (listed.length === 0) {
    check(`${BROWSER} 已加载未打包扩展`, false, '扩展列表为空；浏览器 E2E 不能以 SKIP 伪装成功');
    await context.close().catch(() => {});
    rmSync(PROFILE, { recursive: true, force: true });
    process.exit(1);
  }

  let worker = context.serviceWorkers()[0] ?? null;
  console.log(`启动时 service worker: ${worker?.url() ?? '(无)'}`);

  // Fall back to the ID this extension directory actually hashes to.
  const EXTENSION_ID = listed[0]?.id ?? process.env.DSH_EXTENSION_ID ?? idForPath(EXTENSION);
  // What the native host manifest actually allows — the ID must be in there.
  const hostManifest = join(
    process.env.APPDATA ?? '',
    BROWSER === 'edge' ? 'Microsoft\\Edge' : 'Google\\Chrome',
    'NativeMessagingHosts',
    'com.pagebridge.host.json',
  );
  let allowed = [];
  try {
    allowed = JSON.parse(readFileSync(hostManifest, 'utf8')).allowed_origins ?? [];
  } catch { /* not registered for this browser */ }
  console.log(`native host 清单: ${existsSync(hostManifest) ? hostManifest : '(不存在)'}`);
  console.log(`allowed_origins : ${allowed.join(', ') || '(空)'}`);
  check(`${BROWSER} 分配到的扩展 ID 在 allowed_origins 里`,
    allowed.includes(`chrome-extension://${EXTENSION_ID}/`),
    `ID=${EXTENSION_ID} allowed=${JSON.stringify(allowed)}`);
  const page = await context.newPage();
  let popupView = {};
  try {
    await page.goto(`chrome-extension://${EXTENSION_ID}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await sleep(3000);
    popupView = await page.evaluate(() => ({
      status: document.getElementById('statusText')?.textContent ?? null,
      endpoint: document.getElementById('endpoint')?.textContent ?? null,
      shareLabel: document.getElementById('shareLabel')?.textContent ?? null,
      out: document.getElementById('out')?.textContent ?? null,
      transportSelect: document.getElementById('transport')?.value ?? null,
    }));
    console.log(`弹窗显示（ID ${EXTENSION_ID}）: ${JSON.stringify(popupView, null, 2)}\n`);
  } catch (error) {
    console.log(`⚠️ 打开扩展页面失败：${String(error?.message ?? error).split('\n')[0]}\n`);
  }

  let sw = context.serviceWorkers()[0] ?? null;
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null);
  console.log(`service worker: ${sw?.url() ?? '(未捕获，只能靠弹窗与桥接判断)'}\n`);

  let state = null;
  if (sw) {
    const logs = [];
    sw.on('console', (msg) => logs.push(`${msg.type()}: ${msg.text()}`));    for (let i = 0; i < 20; i += 1) {
      try {
        state = await sw.evaluate(() => ({
          enabled,
          transport,
          activeTransport,
          connected: connected(),
          lastError,
          nativeHost: NATIVE_HOST,
        }));
      } catch (error) {
        state = { error: String(error?.message ?? error) };
      }
      if (state?.activeTransport) break;
      await sleep(400);
    }
    console.log(`SW 自述: ${JSON.stringify(state)}\n`);
    if (logs.length) console.log(`SW 控制台:\n  ${logs.join('\n  ')}\n`);
  }

  check('弹窗报告已连接', /已连接/.test(popupView.status ?? ''), popupView.status);
  check('连接方式为 native messaging', /native messaging/.test(popupView.status ?? ''), popupView.status);
  if (state) {
    check('SW 里 enabled 为真', state.enabled === true, JSON.stringify(state));
    check('SW 的 activeTransport = native', state.activeTransport === 'native', JSON.stringify(state));
  }
  check('端点显示 native host 名', /com\.pagebridge\.host/.test(popupView.endpoint ?? ''), popupView.endpoint);

  // The bridge is the ground truth: it must see a client whose via is 'native'.
  let status = null;
  try {
    status = await (await fetch('http://127.0.0.1:8799/status', { headers: bridgeAuthHeaders() })).json();
  } catch (error) {
    status = { error: String(error?.message ?? error) };
  }
  console.log(`桥接自述: ${JSON.stringify(status?.clients ?? status)}\n`);
  check('桥接看到 via=native 的客户端',
    Array.isArray(status?.clients) && status.clients.some((c) => c.via === 'native'),
    JSON.stringify(status));
  const liveClient = status?.clients?.find((c) => c.label === 'chrome-extension');
  check('桥接报告的 extensionVersion 与 manifest 一致', status?.extensionVersion === MANIFEST_VERSION,
    JSON.stringify({ expected: MANIFEST_VERSION, actual: status?.extensionVersion }));
  check('native client version 与 manifest 一致', liveClient?.version === MANIFEST_VERSION,
    JSON.stringify({ expected: MANIFEST_VERSION, actual: liveClient?.version }));
  check('native client instance 是 16 位标识', /^[0-9a-f]{16}$/i.test(liveClient?.instance ?? ''), JSON.stringify(liveClient));

  // Chrome must own the host process: a bridge.mjs --native child of chrome.exe.
  if (process.platform === 'win32') {
    const { execFileSync } = await import('node:child_process');
    const script = [
      "$rows = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'bridge\\.mjs' -and $_.CommandLine -match '--native' }",
      "foreach ($r in $rows) {",
      "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($r.ParentProcessId)\" -ErrorAction SilentlyContinue",
      "  $name = $p.Name",
      // Windows 的 native messaging host 由注册表指向的 native-host.cmd 启动，因此桥接的父进程是 cmd.exe，
      // 这是**预期形状**（不是缺陷）。父进程若是 shell，就再往上一层看真正拉起它的是不是浏览器。
      "  if ($name -match '^(cmd|conhost|powershell|pwsh)\\.exe$') {",
      "    $g = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\" -ErrorAction SilentlyContinue",
      "    $name = \"$name -> $($g.Name)\"",
      "  }",
      "  \"$($r.ProcessId)|$name\"",
      "}",
    ].join('; ');
    let out = '';
    try {
      out = execFileSync('pwsh', ['-NoProfile', '-Command', script], { stdio: 'pipe' }).toString().trim();
    } catch { /* ignore */ }
    console.log(`native host 进程: ${out || '(无)'}\n`);
    const parentPattern = USE_BUNDLED ? /(?:chrome|chromium|msedge)\.exe/i : /chrome\.exe/i;
    check('存在由 Chromium 浏览器拉起的 --native 进程', parentPattern.test(out), out || '没有找到');
  }
} finally {
  await context.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true });
}

console.log(`${failures ? `✗ ${failures} 个断言失败` : '✓ 全部通过'}`);
process.exit(failures ? 1 : 0);
