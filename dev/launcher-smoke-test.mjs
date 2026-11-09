#!/usr/bin/env node
/**
 * launcher-smoke-test.mjs —— 验证「浏览器实际会执行的那个启动脚本」本身能跑起来。
 *
 * 为什么单独测它：`native-framing-test.mjs` 直接 spawn `bridge.mjs`，所以**启动脚本**
 * （`native-host.cmd` / `.sh`，由 `register-host.mjs` 生成、内容是本机 node 的绝对路径）
 * 从来没进过 CI。改名那一轮 `browser-e2e` 连挂三次，最后卡在「宿主进程 (无)」——
 * 而 Chromium 不会告诉我们宿主为什么退出（stdout 多一个字节就会被杀掉）。
 * 这个脚本把那个黑盒变成日志里可读的几行：启动脚本内容、是否存活、stdout 是否干净、stderr 说了什么。
 *
 *   node dev/launcher-smoke-test.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === 'win32';
const launcher = join(ROOT, WIN ? 'native-host.cmd' : 'native-host.sh');

console.log(`launcher : ${launcher}`);
if (!existsSync(launcher)) {
  console.log('✗ 启动脚本不存在 —— 先跑 node register-host.mjs register');
  process.exit(1);
}
for (const line of readFileSync(launcher, 'utf8').split(/\r?\n/).filter(Boolean)) console.log(`   ${line}`);

// 必须经 shell 启动：Windows 上 .cmd 不能直接被 exec（Chromium 内部也是通过 shell 跑的）。
const child = spawn(launcher, [], { cwd: ROOT, shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

await new Promise((resolve) => setTimeout(resolve, 4000));
const alive = exited === null;
if (alive) child.kill();

console.log('');
console.log(`4 秒后仍存活  : ${alive ? '✓' : `✗ 已退出 ${JSON.stringify(exited)}`}`);
console.log(`stdout 字节数 : ${stdout.length}${stdout.length === 0 ? ' ✓（原生模式必须为空，否则会被浏览器杀掉）' : ' ✗（原生模式不允许任何 stdout 输出）'}`);
if (stderr) console.log(`stderr        : ${stderr.trim().split('\n').slice(0, 6).join('\n                ')}`);
if (!alive) console.log('\n↑ 上面 stderr 就是宿主退出前说的话 —— 通常直接是根因。');

process.exitCode = alive && stdout.length === 0 ? 0 : 1;
