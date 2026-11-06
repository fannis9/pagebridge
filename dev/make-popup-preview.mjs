#!/usr/bin/env node
/**
 * make-popup-preview.mjs — 渲染 extension/popup.html 到 docs/popup-preview.png
 *
 * 弹窗平时靠 chrome.runtime 与 service worker 通信；这里用一个"已连接（native messaging）
 * 且共享了一个标签页"的假状态喂给它，于是 README 的预览图展示的是**真实 UI**，
 * 既不需要开着浏览器、也不需要桥接在跑。headless 渲染 + 视图尺寸裁到内容高度。
 *
 *   node dev/make-popup-preview.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from './playwright-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
/** 版本号从 manifest 读，避免预览图里印着过期版本 */
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'));

const CHROME = [
  process.env.DSH_BROWSER_EXECUTABLE,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && existsSync(p));

/** 预览里要展示的状态：native 传输已连接、一个标签页被共享、策略为默认（空） */
const STATE = {
  version: MANIFEST.version,
  grant: {
    tabId: 349827257,
    origin: 'https://github.com',
    url: 'https://github.com/fannis9/pagebridge',
    title: 'GitHub - fannis9/pagebridge',
    grantedAt: Date.now(),
  },
};
STATE.status = {
  connected: true,
  enabled: true,
  fullAccess: false,
  transport: 'auto',
  activeTransport: 'native',
  wsUrl: 'ws://127.0.0.1:8799/ws',
  nativeHost: 'com.pagebridge.host',
  lastError: null,
  grant: STATE.grant,
};
STATE.grantStatus = {
  grant: STATE.grant,
  policy: { allowDomains: [], blockDomains: [] },
  current: {
    id: STATE.grant.tabId,
    url: STATE.grant.url,
    title: STATE.grant.title,
    shareable: true,
    alreadyShared: true,
  },
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 340, height: 760 }, deviceScaleFactor: 2 });
  // 在 popup.js 之前注入假的 chrome API（真实浏览器里 window.chrome 已存在，所以是合并）
  await page.addInitScript((state) => {
    const chromeApi = window.chrome ?? {};
    chromeApi.runtime = {
      getManifest: () => ({ version: state.version }),
      sendMessage: (msg, callback) => {
        const reply = state[msg?.kind] ?? { ok: true };
        if (typeof callback === 'function') setTimeout(() => callback(reply), 5);
        return Promise.resolve(reply);
      },
    };
    window.chrome = chromeApi;
  }, STATE);

  await page.goto(pathToFileURL(join(ROOT, 'extension', 'popup.html')).href, { waitUntil: 'load' });
  await page.waitForTimeout(500);

  const rendered = await page.evaluate(() => ({
    status: document.getElementById('statusText')?.textContent,
    endpoint: document.getElementById('endpoint')?.textContent,
    share: document.getElementById('shareLabel')?.textContent,
    height: Math.ceil(document.body.getBoundingClientRect().height),
  }));
  const height = Math.min(Math.max(rendered.height, 480), 900);
  await page.setViewportSize({ width: 340, height });
  await page.waitForTimeout(150);

  const out = join(ROOT, 'docs', 'popup-preview.png');
  await page.screenshot({ path: out });
  console.log(`已生成：${out}`);
  console.log(`  尺寸      : 340 × ${height}（2x 像素密度）`);
  console.log(`  文件大小  : ${(statSync(out).size / 1024).toFixed(1)} KB`);
  console.log(`  渲染出的状态行 : ${rendered.status}`);
  console.log(`  端点           : ${rendered.endpoint}`);
  console.log(`  共享卡片       : ${rendered.share}`);
} finally {
  await browser.close().catch(() => {});
}
