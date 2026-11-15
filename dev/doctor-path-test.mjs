#!/usr/bin/env node
/** Regression: two MCP clients pointing at different clones must not pass doctor. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = mkdtempSync(join(tmpdir(), 'pagebridge-doctor-path-'));
const profile = join(fixture, 'profile');
const codex = join(fixture, 'config.toml');
const launcher = join(fixture, 'native-host.cmd');
const manifest = join(fixture, 'host.json');
const wrong = join(fixture, 'other-copy');
mkdirSync(profile);
const run = () => spawnSync(process.execPath, [join(project, 'dev', 'doctor.mjs'), '--offline'], {
  cwd: project,
  env: {
    ...process.env,
    DSH_PROFILE_DIR: profile,
    PAGE_BRIDGE_CODEX_CONFIG: codex,
    PAGE_BRIDGE_HOST_MANIFEST: manifest,
  },
  encoding: 'utf8',
  timeout: 30_000,
});
try {
  writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: page-bridge-mcp\n      config:\n        command: "${process.execPath}"\n        args:\n          - "${join(wrong, 'mcp-server.mjs')}"\n`);
  writeFileSync(codex, `[mcp_servers.page-bridge]\ncommand = "node"\nargs = ['${join(project, 'mcp-server.mjs')}']\n`);
  writeFileSync(launcher, `@echo off\n"${process.execPath}" "${join(wrong, 'bridge.mjs')}" --native\n`);
  writeFileSync(manifest, JSON.stringify({ path: launcher }));
  const result = run();
  const output = result.stdout + result.stderr;
  if (result.status !== 1 || !output.includes('DSH 指向另一份仓库')
      || !output.includes('浏览器 native host 指向另一份仓库')
      || !output.includes('Codex 使用本仓库')) {
    throw new Error(`路径分叉未被正确检出 (exit ${result.status}):\n${output}`);
  }
  writeFileSync(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: page-bridge-mcp\n      config:\n        command: "${process.execPath}"\n        args:\n          - "${join(project, 'mcp-server.mjs')}"\n`);
  writeFileSync(codex, `[mcp_servers.page-bridge]\ncommand = "node"\nargs = ['${join(wrong, 'mcp-server.mjs')}']\n`);
  writeFileSync(launcher, `@echo off\n"${process.execPath}" "${join(project, 'bridge.mjs')}" --native\n`);
  const codexResult = run();
  const codexOutput = codexResult.stdout + codexResult.stderr;
  if (codexResult.status !== 1 || !codexOutput.includes('Codex 指向另一份仓库')
      || !codexOutput.includes('DSH 使用本仓库')
      || !codexOutput.includes('浏览器 native host 使用本仓库')) {
    throw new Error(`Codex 路径分叉未被正确检出 (exit ${codexResult.status}):\n${codexOutput}`);
  }
  console.log('✓ DSH、Codex 或 native host 指向其它副本时 doctor 均能报错');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
