#!/usr/bin/env node
/**
 * doctor.mjs —— 版本兼容自检（+ 能修的直接修）。
 *
 * 为什么需要它：这套东西和 DSH 之间有**几处不可消除的耦合**（DSH 私有的插件配置格式、
 * 不可见的 MCP 工具注入行为），任何一处变化都不会报错，只会"静默失灵"：
 *   - native messaging 启动脚本引用了 DSH 运行时 node → DSH 改布局就打不开
 *   - profile 里 MCP 启动命令引用了同一个路径 → 工具静默消失（failOnStartupError: false）
 *   - 扩展版本与仓库里的 manifest 不一致 → 你以为在测新代码
 * 所以"永久兼容"做不到，能永久做到的是：**一条命令在 30 秒内发现并修复**。
 *
 *   node dev/doctor.mjs           # 只检查，不改任何东西
 *   node dev/doctor.mjs --fix     # 修能安全修的（重生成启动脚本 / 重注册 native host）
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = join(HERE, '..');
const WIN = process.platform === 'win32';
const PROFILE = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop');
const FIX = process.argv.includes('--fix');
const UPDATE = process.argv.includes('--update');

/** 版本比较：v0.9.0 > v0.8.1；预发布后缀按字符串比较（够用即可）。 */
function compareVersions(a, b) {
  const split = (v) => String(v).replace(/^v/, '').split(/[.-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

const problems = [];
const notes = [];
const ok = (label, detail = '') => console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
const bad = (label, detail, fixable = false) => {
  console.log(`  ✗ ${label}${detail ? `\n      ${detail.replaceAll('\n', '\n      ')}` : ''}`);
  problems.push({ label, detail, fixable });
};
const info = (label, detail = '') => console.log(`  · ${label}${detail ? `  ${detail}` : ''}`);

/** 稳定的 node 候选（与 register-host.mjs 保持同一顺序）。 */
const stableNodeCandidates = [
  process.env.PAGE_BRIDGE_NODE,
  'C:\\Program Files\\nodejs\\node.exe',
  'C:\\Program Files (x86)\\nodejs\\node.exe',
].filter(Boolean);
const stableNode = stableNodeCandidates.find((p) => existsSync(p)) ?? null;

console.log(`page-bridge doctor  (${WIN ? 'windows' : process.platform}, ${FIX ? 'fix 模式' : '只检查'})\n`);

// ---------------------------------------------------------------- 1. 启动脚本
console.log('[1] native messaging 启动脚本');
const launcher = join(PROJECT, WIN ? 'native-host.cmd' : 'native-host.sh');
if (!existsSync(launcher)) {
  bad('启动脚本不存在', '原生通道未注册：跑 node register-host.mjs register', true);
} else {
  const text = readFileSync(launcher, 'utf8');
  const match = text.match(/"([^"]*node[^"]*)"/i);
  const nodeInLauncher = match ? match[1] : null;
  if (nodeInLauncher && /dsh-runtimes/i.test(nodeInLauncher)) {
    bad('启动脚本依赖 DSH 私有运行时路径', `${nodeInLauncher}\nDSH 改变运行时布局时，原生通道会静默失效。用 --fix 换成系统 node。`, true);
  } else if (!nodeInLauncher || !existsSync(nodeInLauncher)) {
    bad('启动脚本里的 node 不存在', nodeInLauncher ?? '（没找到 node 路径）', true);
  } else {
    ok('使用稳定的 node', nodeInLauncher);
  }
}

// ---------------------------------------------------------------- 2. profile 里的 MCP 启动命令
console.log('\n[2] profile 的 MCP 启动命令');
const patchFile = join(PROFILE, 'cordis.patch.yml');
let patchText = null;
if (!existsSync(patchFile)) {
  info('没有找到 cordis.patch.yml', patchFile);
} else {
  patchText = readFileSync(patchFile, 'utf8');
  const block = patchText.split(/^-\s/m).find((chunk) => chunk.includes('page-bridge-mcp'));
  const cmd = block ? (block.match(/command:\s*["']?([^"'\n]+)["']?/) ?? [])[1] : null;
  if (!block) {
    bad('profile 里没有 page-bridge-mcp 这一行', `检查 ${patchFile}`);
  } else if (cmd && /dsh-runtimes/i.test(cmd)) {
    bad('MCP 启动命令依赖 DSH 私有运行时路径', `${cmd}\n工具挂了不会报错（failOnStartupError: false），只会静默消失。`, false);
    if (stableNode) notes.push(`把 ${patchFile} 里 page-bridge-mcp 的 command 改成：\n${stableNode}`);
  } else if (cmd && !existsSync(cmd)) {
    bad('MCP 启动命令指向的 node 不存在', cmd, false);
  } else {
    ok('MCP 启动命令可用', cmd ?? '(未解析到 command)');
  }
}

// ---------------------------------------------------------------- 3. 扩展与桥接
console.log('\n[3] 扩展与桥接');
const manifestVersion = JSON.parse(readFileSync(join(PROJECT, 'extension', 'manifest.json'), 'utf8')).version;
let status = null;
try {
  const out = execFileSync(process.execPath, [join(PROJECT, 'page.mjs'), 'status', '--json'], {
    cwd: PROJECT,
    stdio: 'pipe',
    timeout: 20_000,
  }).toString();
  status = JSON.parse(out);
} catch (error) {
  bad('读不到桥接状态', String(error?.message ?? error).split('\n')[0]);
}
if (status) {
  if (!status.extensionConnected) bad('扩展未连接', '打开扩展弹窗点一下，或确认桥接在跑');
  else {
    ok('扩展已连接', `via=${status.clients?.[0]?.via ?? '?'}  instance=${status.clients?.[0]?.instance ?? '?'}`);
    const live = status.extensionVersion ?? status.clients?.[0]?.version;
    if (live && live !== manifestVersion) {
      bad('扩展版本与仓库不一致', `运行中 ${live} ≠ 仓库 manifest ${manifestVersion}（需要在扩展页点 ↻ 重载）`);
    } else if (live) {
      ok('扩展版本与仓库一致', live);
    }
  }
}

// ---------------------------------------------------------------- 4. 插件 SDK 版本（硬编码"测试过的版本"）
console.log('\n[4] DSH 插件 SDK 版本');
const TESTED_SDK = { '@deepseek-ai/dsh-mcp-client': '0.2.1-rc.5' };
const profilePkg = join(PROFILE, 'package.json');
if (!existsSync(profilePkg)) {
  info('没有找到 profile/package.json');
} else {
  const deps = JSON.parse(readFileSync(profilePkg, 'utf8')).dependencies ?? {};
  for (const [name, tested] of Object.entries(TESTED_SDK)) {
    const actual = deps[name];
    if (!actual) info(`${name} 未在 profile 依赖里`, '（若 MCP 行是手写的，这属正常）');
    else if (actual !== tested) {
      info(`${name} 版本变了`, `测试过 ${tested}，当前 ${actual} —— 留意 MCP 工具是否还在`);
    } else ok(`${name} 与测试过的版本一致`, actual);
  }
}

// ---------------------------------------------------------------- 5. 联网版本检查（只读）
//
// 只做"看"，不做"装"：自动下载并安装等于让机器在启动时执行远端代码，
// 而这个项目的整套安全模型都建立在"不信任远端"上。所以升级必须是**显式的一次动作**（--update）。
console.log('\n[5] 联网检查（GitHub 最新 release）');
const LOCAL_VERSION = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf8')).version;
const skipNetwork = process.argv.includes('--offline') || process.env.PAGE_BRIDGE_NO_NETWORK === '1';
let latestTag = null;
if (skipNetwork) {
  info('已跳过', '（--offline 或 PAGE_BRIDGE_NO_NETWORK=1）');
} else {
  try {
    const res = await fetch('https://api.github.com/repos/fannis9/dsh-page-bridge/releases/latest', {
      headers: { 'user-agent': 'page-bridge-doctor', accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const release = await res.json();
    latestTag = release.tag_name;
    const latest = String(latestTag).replace(/^v/, '');
    const order = compareVersions(latest, LOCAL_VERSION);
    if (order > 0) {
      bad('本机版本落后于最新 release', `本机 ${LOCAL_VERSION} < ${latestTag}\n升级：node dev/doctor.mjs --update\n${release.html_url}`);
    } else if (order < 0) {
      info('本机比最新 release 更新', `本机 ${LOCAL_VERSION} > ${latestTag}（开发中）`);
    } else {
      ok('已是最新 release', latestTag);
    }
  } catch (error) {
    info('联网检查失败（不影响下面的本地结论）', String(error?.message ?? error).split('\n')[0]);
  }
}

// ---------------------------------------------------------------- 更新（显式动作）
if (UPDATE) {
  console.log('\n更新：git pull --ff-only → 重注册 native host');
  try {
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: PROJECT, stdio: 'pipe' }).toString().trim();
    if (dirty) throw new Error('工作区不干净，先提交或 stash 再更新');
    // 本机 .gitconfig 里有按域名写死的代理；这里显式绕过，避免代理没开时连不上。
    const out = execFileSync(
      'git',
      ['-c', 'http.proxy=', '-c', 'http.https://github.com.proxy=', 'pull', '--ff-only'],
      { cwd: PROJECT, stdio: 'pipe', timeout: 60_000 },
    ).toString().trim();
    console.log(`  ${out || '(已是最新)'}`);
    const after = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf8')).version;
    console.log(`  更新后版本：${LOCAL_VERSION} → ${after}`);
    console.log('  接着重注册 native host（启动脚本换成系统 node）…');
    execFileSync(process.execPath, [join(PROJECT, 'register-host.mjs'), 'register', '--browser', 'edge'], {
      cwd: PROJECT,
      stdio: 'pipe',
      timeout: 60_000,
    });
    console.log('  ✓ 已重注册。若扩展仍显示旧版本，去 edge://extensions 点一次 ↻，并重启 DSH 让 MCP 行重新拉起');
  } catch (error) {
    console.log(`  ✗ 更新失败：${String(error?.message ?? error).split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------- 修复
console.log('');
if (FIX && problems.some((p) => p.fixable)) {
  console.log('修复：重生成启动脚本并重注册 native host…');
  const args = [join(PROJECT, 'register-host.mjs'), 'register'];
  if (process.argv.includes('--browser')) {
    const i = process.argv.indexOf('--browser');
    args.push('--browser', process.argv[i + 1]);
  }
  try {
    const out = execFileSync(process.execPath, args, { cwd: PROJECT, stdio: 'pipe', timeout: 60_000 }).toString();
    console.log(out.trim().split('\n').map((line) => `  ${line}`).join('\n'));
    console.log('  → 已重注册；若浏览器里扩展仍显示旧状态，重载一次扩展或重启浏览器');
  } catch (error) {
    console.log(`  ✗ 修复失败：${String(error?.message ?? error).split('\n')[0]}`);
  }
}

if (notes.length) {
  console.log('\n需要你手动改的（我没有自动动你的 profile）：');
  for (const note of notes) console.log(`  · ${note}`);
}

console.log('');
if (problems.length) {
  const fixable = problems.filter((p) => p.fixable).length;
  console.log(`✗ 发现 ${problems.length} 个问题（其中 ${fixable} 个可以 --fix 修）`);
  if (!FIX && fixable) console.log('  重跑：node dev/doctor.mjs --fix');
  process.exit(1);
}
console.log('✓ 全部通过 —— 路径与 DSH 版本解耦，扩展与仓库一致');
