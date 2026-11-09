#!/usr/bin/env node
/**
 * check-syntax.mjs —— 与 CI 完全一致的语法检查（单一事实来源）。
 *
 * 起因：CI 用的是 `git ls-files '*.mjs' '*.js' | node --check`，而本地 `npm run check` 只列了 8 个入口。
 * 两者一旦不同步，就会出现"本地全绿、CI 一进来就红"——本轮 `extension/page-op/*.js` 片段正是这么翻的车。
 *
 * 规则：
 *   - 扫描仓库内所有 .mjs / .js（跳过 .git / node_modules / var）
 *   - **排除 extension/page-op/**：那些是 PAGE_OP 的函数体片段（顶层 return），不是独立模块；
 *     它们由 dev/page-op-regions-test.mjs 用 new Function 独立求值来验证
 *
 *   node dev/check-syntax.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'var']);
/** 函数体片段目录：不参与模块级语法检查（由 region 护栏覆盖）。 */
const SKIP_PREFIX = `extension${sep}page-op${sep}`;

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      continue;
    }
    if (!/\.(mjs|js)$/.test(entry.name)) continue;
    const rel = relative(ROOT, join(dir, entry.name));
    if (rel.startsWith(SKIP_PREFIX)) continue;
    files.push(rel);
  }
};
walk(ROOT);
files.sort();

const failures = [];
for (const file of files) {
  // stdio: 'ignore' —— 只要退出码，不抓输出（也避开受限沙箱里"管道 stdio 不可用"的限制）。
  const result = spawnSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'ignore' });
  if (result.status !== 0) failures.push(file);
}

console.log(`语法检查：扫描 ${files.length} 个模块文件（已排除 extension/page-op/ 片段）`);
if (failures.length) {
  for (const file of failures) console.log(`  ✗ ${file}`);
  console.log(`\n✗ ${failures.length} 个文件语法检查失败`);
  process.exit(1);
}
console.log('✓ 全部通过');
// 顺带确认"排除"是有依据的：片段文件应当确实不是独立模块（否则排除就是掩盖问题）。
const fragDir = join(ROOT, 'extension', 'page-op');
let fragments = [];
try { fragments = readdirSync(fragDir).filter((f) => f.endsWith('.js')); } catch { /* 目录不存在 */ }
const moduleLike = fragments.filter((f) => spawnSync(process.execPath, ['--check', join(fragDir, f)], { stdio: 'ignore' }).status === 0);
console.log(`（page-op 片段 ${fragments.length} 个，其中能当独立模块解析的 ${moduleLike.length} 个：${moduleLike.join(', ') || '无'}）`);

// ---------------------------------------------------------------- 可移植性 lint
// dev/ 脚本会在 CI 的 Linux runner 上跑，但开发机是 Windows。曾经有两处写成
//   new URL('..', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\')
// 在 Linux 上路径变成 `home\runner\...`，脚本必然失败（log-rotation 与 ws-fuzz 都栽在这上面）。
// 用 fileURLToPath 才是正解 —— 这里直接静态拦下这种写法，避免同类问题再次进 CI。
//
// 规则被收窄成 AND：只有当**同时**出现 (a) 从 import.meta.url 取 .pathname 与
// (b) 把 '/' 替换成以反斜杠开头的串，才算 Windows 专用写法。
// 收窄的规则最怕"悄悄失效"，所以下面先用固定样本自测这条规则本身（正反两个方向），
// 再拿它去扫真实文件 —— 样本与真实扫描共用同一个函数，测的就是线上那条规则。
const isWindowsOnlyPath = (line) => {
  const urlPath = /new URL\([^)]*import\.meta\.url[^)]*\)\.pathname/.test(line);
  const windowsPathConversion = /(?:replaceAll|replace)\(\s*['"]\/['"]\s*,\s*['"][^'"]*\\/.test(line);
  return urlPath && windowsPathConversion;
};

const LINT_SAMPLES = [
  // [样本行, 是否应当被判定为违规, 说明]
  ["const ROOT = new URL('..', import.meta.url).pathname.replace(/^\\//, '').replaceAll('/', '\\\\');", true, '原始危险写法'],
  ["const p = new URL('..', import.meta.url).pathname.replace('/', '\\\\');", true, 'replace 变体'],
  ["const value = input.replaceAll('/', '-');", false, '普通字符串替换（曾被误报）'],
  ["const p = new URL('..', import.meta.url).pathname;", false, '只读 pathname，没有反斜杠转换'],
  ["const p = new URL(link).pathname.replaceAll('/', '-');", false, '与 import.meta.url 无关'],
];
const lintSelfTestFailures = LINT_SAMPLES.filter(([line, shouldFlag]) => isWindowsOnlyPath(line) !== shouldFlag);
if (lintSelfTestFailures.length) {
  console.log('\n✗ 可移植性 lint 自测失败（规则与预期不符）：');
  for (const [line, shouldFlag] of lintSelfTestFailures) console.log(`  ${shouldFlag ? '应报未报' : '不应报却报'}：${line}`);
  process.exit(1);
}
console.log(`✓ 可移植性 lint 自测通过（${LINT_SAMPLES.length} 个样本：${LINT_SAMPLES.filter((s) => s[1]).length} 个应报 / ${LINT_SAMPLES.filter((s) => !s[1]).length} 个不应报）`);

const offenders = [];
const lint = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) lint(join(dir, entry.name));
      continue;
    }
    if (!/\.(mjs|js)$/.test(entry.name)) continue;
    const rel = relative(ROOT, join(dir, entry.name));
    // 跳过 lint 自己（它当然包含这些模式），并跳过注释行（说明文字里可能会引用这种写法）。
    if (rel === join('dev', 'check-syntax.mjs')) continue;
    const text = readFileSync(join(dir, entry.name), 'utf8');
    for (const [index, line] of text.split('\n').entries()) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (isWindowsOnlyPath(line)) offenders.push(`${rel}:${index + 1}`);
    }
  }
};
lint(join(ROOT, 'dev'));
if (offenders.length) {
  console.log('\n✗ 发现 Windows 专用路径写法（CI 是 Linux，请改用 fileURLToPath）：');
  for (const item of offenders) console.log(`  ${item}`);
  process.exit(1);
}
console.log('✓ 可移植性 lint 通过（没有 .pathname + 反斜杠 的路径写法）');

// ---------------------------------------------------------------- 旧项目名残留检查
//
// 改名（DSH Page Bridge → Page Bridge）时最容易漏的是**正则里的转义写法**：
// `com\.dsh\.page_bridge` 不含裸字符串 `com.dsh.page_bridge`，所以按字符串替换会漏掉它 ——
// browser-e2e 就因此连续三次挂在一个"端点显示 native host 名"的断言上（tests 工作流却是绿的）。
// 这里在必跑 CI 里拦住任何形态的旧名（不只 *.md：历史评审记录允许保留当时的名字）。
const OLD_NAME_PATTERNS = [
  /dsh-page-bridge/i,
  /DSH Page Bridge/,
  /dsh_page_bridge/i,
  /com\\?\.dsh\\?\.page_bridge/i,
];
const staleNames = [];
for (const file of files) {
  // 跳过本文件：下面那行日志里会列出旧名（和可移植性 lint 跳过自己同理）。
  if (file.replaceAll('\\', '/') === 'dev/check-syntax.mjs') continue;
  const text = readFileSync(join(ROOT, file), 'utf8');
  text.split('\n').forEach((line, index) => {
    for (const pattern of OLD_NAME_PATTERNS) {
      if (pattern.test(line)) staleNames.push(`${file}:${index + 1}  ${pattern}  ${line.trim().slice(0, 90)}`);
    }
  });
}
if (staleNames.length) {
  console.log('\n✗ 发现旧项目名残留（改名时漏掉的转义写法最容易出现）：');
  for (const item of staleNames) console.log(`  ${item}`);
  process.exitCode = 1;
} else {
  console.log('✓ 旧项目名检查通过（dsh-page-bridge / DSH Page Bridge / com.dsh.page_bridge 含转义形）');
}
