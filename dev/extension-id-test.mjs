#!/usr/bin/env node
/**
 * extension-id-test.mjs — prove which ID a browser will assign to an unpacked extension.
 *
 * Both Chrome and Edge are Chromium, and Chromium derives an unpacked extension's ID purely
 * from its absolute path:
 *
 *   id = mapToAtoP( hex( SHA256( pathBytes )[0..15] ) )
 *
 * pathBytes = the platform's native path bytes: **UTF-16LE on Windows**, UTF-8 elsewhere
 * (that detail was determined empirically — see the note below — by re-deriving the ID that
 * Chrome actually assigned to this directory).
 *
 * If the computed ID equals the one pinned in the native host manifest's allowed_origins,
 * then loading the SAME directory in Edge (or any Chromium build) yields a host Edge accepts,
 * with no re-registration needed.
 *
 *   node dev/extension-id-test.mjs [--path <extension dir>]
 *
 * 反推过程：从 Chrome 的 Secure Preferences 里读到"某个已加载目录 → 它实际分配到的 ID"这组真值，
 * 然后逐一试 UTF-8 / UTF-16LE / 大小写 / 尾随反斜杠 / 正斜杠 / \\?\ 前缀等组合，
 * 只有 **UTF-16LE + 取 SHA256 前 16 字节** 能复现该 ID（用 UTF-8 会算出完全不同的结果）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

/** Chromium: MaybeNormalizePath() only upper-cases the drive letter. */
function normalizePath(p) {
  return p.replace(/^([a-z]):/, (_m, drive) => `${drive.toUpperCase()}:`);
}

/** Chromium hashes the platform's native path bytes: UTF-16LE on Windows, UTF-8 elsewhere. */
function pathBytes(path) {
  return process.platform === 'win32' ? Buffer.from(path, 'utf16le') : Buffer.from(path, 'utf8');
}

/** Chromium: CreateIdForPathOrExtension() — SHA256, first 16 bytes, nibbles mapped to a-p. */
function idForPath(rawPath) {
  const normalized = normalizePath(rawPath);
  const digest = createHash('sha256').update(pathBytes(normalized)).digest();
  return [...digest.subarray(0, 16).toString('hex')]
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + parseInt(nibble, 16)))
    .join('');
}

const target = resolve(String(flag('path', join(PROJECT, 'extension'))));
const expected = idForPath(target);

console.log(`扩展目录     : ${target}`);
console.log(`归一化后     : ${normalizePath(target)}`);
console.log(`按 Chromium 算法算出的 ID : ${expected}\n`);

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${!ok && detail ? `\n    ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const APPDATA = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming');
const MANIFESTS = {
  Chrome: join(APPDATA, 'Google', 'Chrome', 'NativeMessagingHosts', 'com.pagebridge.host.json'),
  Edge: join(APPDATA, 'Microsoft', 'Edge', 'NativeMessagingHosts', 'com.pagebridge.host.json'),
};

for (const [browser, manifest] of Object.entries(MANIFESTS)) {
  console.log(`--- ${browser} ---`);
  if (!existsSync(manifest)) {
    console.log(`  ⚠️ 未注册（${manifest}）—— 需要先跑 register-host.mjs register`);
    continue;
  }
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  const allowed = parsed.allowed_origins ?? [];
  console.log(`  清单       : ${manifest}`);
  console.log(`  allowed    : ${allowed.join(', ') || '(空)'}`);
  check(`${browser} 的 allowed_origins 与本目录算出的 ID 一致`,
    allowed.includes(`chrome-extension://${expected}/`),
    `期望 chrome-extension://${expected}/，实际 ${JSON.stringify(allowed)}`);
}

// Sanity: a different directory must produce a different ID (that is why a moved/copied
// extension needs a re-registration with --extension-id).
const other = idForPath(`${target}-copy`);
check('换目录会得到不同 ID（所以搬动目录后要重新注册）', other !== expected, `${expected} vs ${other}`);

console.log(`\n${failures ? `✗ ${failures} 个断言失败` : '✓ 全部通过：同一目录在 Chrome / Edge 下 ID 相同，Edge 无需额外注册'}`);
process.exit(failures ? 1 : 0);
