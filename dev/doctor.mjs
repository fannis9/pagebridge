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
