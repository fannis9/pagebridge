#!/usr/bin/env node
/**
 * register-host.mjs — register / inspect / remove the Chrome native messaging host.
 *
 * User-level only (no admin needed), and fully reversible:
 *
 *   node register-host.mjs status
 *   node register-host.mjs register [--browser chrome|edge|both] [--extension-id <id>]
 *   node register-host.mjs unregister
 *
 * What it does on Windows (mirrors mcp-chrome's approach):
 *   1. writes a launcher script next to this project (`native-host.cmd`),
 *   2. writes the host manifest into %APPDATA%\<Vendor>\NativeMessagingHosts\,
 *   3. points the registry key HKCU\Software\<Vendor>\NativeMessagingHosts\<name> at it.
 * On macOS/Linux it writes a shell launcher and the manifest into the per-user directory.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_NAME = 'com.dsh.page_bridge';
const EXTENSION_DIR = join(HERE, 'extension');
const WIN = process.platform === 'win32';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const action = (argv.find((a) => !a.startsWith('--')) ?? 'register').toLowerCase();
const browser = String(flag('browser', 'both')).toLowerCase();
const extraId = flag('extension-id', null);

/* ------------------------------------------------------------ extension id */

/**
 * Chromium derives an unpacked extension's ID purely from its absolute path:
 *   id = mapToAtoP( hex( SHA256( pathBytes )[0..15] ) )
 * with pathBytes = UTF-16LE on Windows, UTF-8 elsewhere, drive letter upper-cased.
 * Verified against a real Chrome profile (dev/extension-id-test.mjs) — which is exactly why
 * the same directory gets the SAME id in Chrome and Edge, and needs only one registration.
 */
function idForPath(rawPath) {
  const normalized = WIN ? rawPath.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`) : rawPath;
  const bytes = WIN ? Buffer.from(normalized, 'utf16le') : Buffer.from(normalized, 'utf8');
  return [...createHash('sha256').update(bytes).digest().subarray(0, 16).toString('hex')]
    .map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16)))
    .join('');
}

/** IDs of any copy of this extension a browser profile already records (different dir → different id). */
function discoveredIds() {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const roots = WIN
    ? [[join(local, 'Google', 'Chrome', 'User Data'), 'Chrome'], [join(local, 'Microsoft', 'Edge', 'User Data'), 'Edge']]
    : [[join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome'), 'Chrome'],
      [join(homedir(), 'Library', 'Application Support', 'Microsoft Edge'), 'Edge'],
      [join(homedir(), '.config', 'google-chrome'), 'Chrome'],
      [join(homedir(), '.config', 'microsoft-edge'), 'Edge']];
  const found = new Map();
  const wanted = EXTENSION_DIR.toLowerCase();
  for (const [root, label] of roots) {
    if (!existsSync(root)) continue;
    let profiles = [];
    try { profiles = readdirSync(root).filter((n) => n === 'Default' || n.startsWith('Profile ')); } catch { continue; }
    for (const profile of profiles) {
      for (const file of ['Secure Preferences', 'Preferences']) {
        const path = join(root, profile, file);
        if (!existsSync(path)) continue;
        try {
          const settings = JSON.parse(readFileSync(path, 'utf8'))?.extensions?.settings ?? {};
          for (const [id, entry] of Object.entries(settings)) {
            if (String(entry?.path ?? '').toLowerCase() === wanted) found.set(id, `${label} / ${profile}`);
          }
        } catch { /* unreadable profile: skip */ }
      }
    }
  }
  return found;
}

const pathId = idForPath(EXTENSION_DIR);
const discovered = discoveredIds();
const ids = new Map([[pathId, '由扩展目录路径推导']]);
for (const [id, where] of discovered) if (!ids.has(id)) ids.set(id, `profile 里已安装（${where}）`);
if (extraId) ids.set(String(extraId), '命令行 --extension-id 指定');
const origins = [...ids.keys()].map((id) => `chrome-extension://${id}/`);

const VENDORS = {
  chrome: { win: 'Google\\Chrome', mac: 'Google/Chrome', linux: '.config/google-chrome', label: 'Chrome' },
  edge: { win: 'Microsoft\\Edge', mac: 'Microsoft Edge', linux: '.config/microsoft-edge', label: 'Edge' },
};
const targets = browser === 'both' ? ['chrome', 'edge'] : [browser];
for (const target of targets) {
  if (!VENDORS[target]) {
    console.error(`未知浏览器：${target}（可用 chrome | edge | both）`);
    process.exit(1);
  }
}

/** Where Chrome looks for the manifest, per vendor. */
function manifestDir(vendor) {
  const v = VENDORS[vendor];
  if (WIN) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), v.win, 'NativeMessagingHosts');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', v.mac, 'NativeMessagingHosts');
  return join(homedir(), v.linux, 'NativeMessagingHosts');
}

const launcherPath = () => join(HERE, WIN ? 'native-host.cmd' : 'native-host.sh');
const manifestPath = (vendor) => join(manifestDir(vendor), `${HOST_NAME}.json`);
const registryKey = (vendor) => `HKCU\\Software\\${VENDORS[vendor].win}\\NativeMessagingHosts\\${HOST_NAME}`;

/**
 * 选一个"稳定"的 node：优先**系统安装的 node**，其次才是当前进程。
 *
 * 为什么不能用 process.execPath 了事：DSH 有时会用自带的运行时 node 跑本脚本，
 * 那个路径在 `~/.dsh/dsh-runtimes/dsh-primary-runtime/...` 下 —— 属于 DSH 私有布局，
 * 版本升级虽然通常是"原地换目录"，一旦它改了布局，写死这条路径的启动脚本就会失效，
 * 而 native messaging 的失败是静默的（浏览器只会说"连不上"）。
 * 系统 node 与 DSH 的更新完全无关，是解耦点。
 */
function stableNode() {
  if (!WIN) return process.execPath;
  const candidates = [
    process.env.PAGE_BRIDGE_NODE,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

function writeLauncher() {
  const target = launcherPath();
  const node = stableNode();
  const script = join(HERE, 'bridge.mjs');
  if (WIN && /dsh-runtimes/i.test(node)) {
    console.warn(
      `⚠ 没有找到系统 node，启动脚本仍然依赖 DSH 的运行时路径：\n    ${node}\n` +
        '  建议安装 Node.js（或设置 PAGE_BRIDGE_NODE）后重跑 register，否则 DSH 改布局时原生通道会静默失效。',
    );
  }
  if (WIN) {
    // No stdout noise: in native mode every frame on stdout must be protocol-only.
    writeFileSync(target, `@echo off\r\n"${node}" "${script}" --native\r\n`, 'utf8');
  } else {
    writeFileSync(target, `#!/bin/sh\nexec "${node}" "${script}" --native\n`, 'utf8');
    chmodSync(target, 0o755);
  }
  return target;
}

function writeManifest(vendor) {
  const dir = manifestDir(vendor);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    name: HOST_NAME,
    description: 'DSH Page Bridge — native messaging host (Chrome/Edge ⇄ DSH)',
    path: launcherPath(),
    type: 'stdio',
    allowed_origins: origins,
  };
  const file = manifestPath(vendor);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return file;
}

function registerWindows(vendor, file) {
  execFileSync('reg.exe', ['add', registryKey(vendor), '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { stdio: 'pipe' });
}

function unregisterWindows(vendor) {
  try {
    execFileSync('reg.exe', ['delete', registryKey(vendor), '/f'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function readRegistry(vendor) {
  try {
    const out = execFileSync('reg.exe', ['query', registryKey(vendor), '/ve'], { stdio: 'pipe' }).toString();
    const match = /REG_SZ\s+(.+)\s*$/m.exec(out);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function status() {
  console.log(`host name     : ${HOST_NAME}`);
  console.log(`扩展目录      : ${EXTENSION_DIR}`);
  for (const [id, why] of ids) console.log(`  将允许 ID   : ${id}  ← ${why}`);
  console.log(`launcher      : ${launcherPath()} ${existsSync(launcherPath()) ? '(存在)' : '(缺失)'}`);
  console.log(`bridge script : ${join(HERE, 'bridge.mjs')}`);
  console.log(`node          : ${process.execPath}`);
  for (const vendor of targets) {
    const file = manifestPath(vendor);
    const registered = WIN ? readRegistry(vendor) : (existsSync(file) ? file : null);
    console.log(`\n[${VENDORS[vendor].label}]`);
    console.log(`  manifest    : ${file} ${existsSync(file) ? '(存在)' : '(缺失)'}`);
    if (WIN) console.log(`  registry    : ${registryKey(vendor)} → ${registered ?? '(未注册)'}`);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        console.log(`  path 字段   : ${parsed.path}`);
        console.log(`  origins     : ${(parsed.allowed_origins ?? []).join(', ')}`);
      } catch { /* ignore */ }
    }
  }
}

if (action === 'status') {
  status();
  process.exit(0);
}

if (action === 'unregister') {
  for (const vendor of targets) {
    const removedFile = existsSync(manifestPath(vendor));
    rmSync(manifestPath(vendor), { force: true });
    const removedKey = WIN ? unregisterWindows(vendor) : false;
    console.log(`[${VENDORS[vendor].label}] 清单${removedFile ? '已删除' : '本就不存在'}${WIN ? `，注册表${removedKey ? '已删除' : '本就不存在'}` : ''}`);
  }
  console.log('\n已卸载（launcher 脚本保留，可随时重新 register）。扩展会自动回退到 WebSocket 传输。');
  process.exit(0);
}

if (action !== 'register') {
  console.error(`未知动作：${action}（可用 status | register | unregister）`);
  process.exit(1);
}

const launcher = writeLauncher();
console.log(`launcher 已写入：${launcher}`);
for (const vendor of targets) {
  const file = writeManifest(vendor);
  if (WIN) registerWindows(vendor, file);
  console.log(`[${VENDORS[vendor].label}] 清单已写入：${file}${WIN ? '，注册表已指向它' : ''}`);
}
console.log(`\n已注册。allowed_origins（Chrome 与 Edge 通用，因为同一目录 → 同一个 ID）：`);
for (const [id, why] of ids) console.log(`  chrome-extension://${id}/   ← ${why}`);
console.log('\n下一步：在 chrome://extensions（Edge 是 edge://extensions）里点一次 ↻ 重载扩展，');
console.log('        然后点扩展图标，连接状态应显示「已连接（native messaging，无本地端口）」。');
console.log('回退：node register-host.mjs unregister');
