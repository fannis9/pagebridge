#!/usr/bin/env node
/**
 * Page Bridge — the hub between the browser extension and DSH tools.
 *
 * Two ways in:
 *   extension ──native messaging──▶ this process   (preferred: no local port for the browser)
 *   extension ──WebSocket────────▶ this process   (fallback when the host isn't registered)
 *   page.mjs / mcp-server.mjs ──HTTP──▶ this process  (loopback only)
 *
 * Native mode (`--native`) is how Chrome launches this file as a native messaging host:
 *   * stdout carries length-prefixed frames ONLY (all logs move to stderr),
 *   * if the port is already taken by an on-demand bridge, this process establishes an
 *     authenticated challenge-response relay: native messaging on one side, WebSocket
 *     client on the other. The native capability token never crosses that relay URL.
 *
 * Endpoints (127.0.0.1 only):
 *   GET  /                 usage text
 *   GET  /status           { connected, clients, lastEvent, ... }
 *   GET  /relay-challenge  one-time challenge used only by the local native relay
 *   GET  /events?limit=50  recent tab events (only the shared tab, see the extension)
 *   GET  /state            last pushed page summary
 *   POST /cmd              { name, args, waitMs, timeoutMs } → forwards to the extension
 *   WS   /ws               extension connection (fallback transport)
 *
 * No dependencies: WebSocket framing and native messaging framing are implemented here.
 */
import { createServer, request as httpRequest } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 单帧上限：超限即视为协议攻击/坏客户端，断连而不是无限缓冲。 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_WS_BUFFER_BYTES = MAX_FRAME_BYTES + 14; // 10-byte length + 4-byte mask
const WS_FRAME_IDLE_MS = 1_500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : (i >= 0 ? true : fallback);
};

/** Native messaging mode: Chrome launched us and owns stdin/stdout. */
const NATIVE = Boolean(flag('native', false));
const PORT = Number(flag('port', process.env.PAGE_BRIDGE_PORT ?? 8799));
const HOST = '127.0.0.1';
const LOG_FILE = flag('log', join(here, 'var', 'events.jsonl'));
const MAX_LOG_BYTES = Math.max(64 * 1024, Number(flag('max-log-bytes', process.env.PAGE_BRIDGE_MAX_LOG_BYTES ?? 5 * 1024 * 1024)) || 5 * 1024 * 1024);
/**
 * 本地控制面的能力令牌（capability token）。
 *
 * 127.0.0.1 不是信任边界：本机任何进程都能连回环端口。所以每一次 HTTP 调用、每一次 WS 握手
 * 都必须带上这个令牌。令牌放在桥接目录旁的 var/ 里（同一个用户的工具 page.mjs / mcp-server.mjs
 * 能读），这也正是"抢占端口的人读不到"的东西——relay 因此不会把扩展的 native 通道交给陌生人。
 */
const TOKEN_FILE = String(flag('token-file', process.env.PAGE_BRIDGE_TOKEN_FILE ?? join(here, 'var', 'bridge-token')));

function loadToken() {
  const explicit = flag('token', process.env.PAGE_BRIDGE_TOKEN ?? null);
  if (explicit && explicit !== true) return String(explicit);
  try {
    const existing = readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing) return existing;
  } catch { /* 还没生成过 */ }
  const fresh = randomBytes(32).toString('hex');
  try {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true });
    writeFileSync(TOKEN_FILE, `${fresh}\n`, { mode: 0o600 });
  } catch { /* 写不了就只在内存里用 */ }
  return fresh;
}

const TOKEN = loadToken();
const tokenFromRequest = (req, url) => {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const custom = req.headers['x-bridge-token'];
  if (typeof custom === 'string' && custom) return custom.trim();
  return url.searchParams.get('token');
};
const tokenMatches = (req, url) => tokenFromRequest(req, url) === TOKEN;
const AUTH_HINT = 'unauthorized：本地控制面需要能力令牌（Authorization: Bearer <token>；WS 用 ?token=）。'
  + '令牌文件由桥接自动生成，也可用 node page.mjs token 查看。';
const MAX_EVENTS = 500;
const RELAY_CHALLENGE_TTL_MS = 5_000;
const MAX_RELAY_CHALLENGES = 128;
/** Exit after this many minutes without any traffic (0 = never). On-demand startup. */
const IDLE_EXIT_MINUTES = NATIVE ? 0 : Number(flag('idle-exit', process.env.PAGE_BRIDGE_IDLE_MINUTES ?? 30));

/** In native mode stdout is protocol-only, so every diagnostic goes to stderr. */
const log = (...args) => {
  if (NATIVE) console.error('[bridge]', ...args);
  else console.log('[bridge]', ...args);
};

let lastActivity = Date.now();
const touch = () => { lastActivity = Date.now(); };

/** Every client is a transport with the same shape:
 *   { label, via, browser, connectedAt, lastSeen, send(obj), close() }
 * @type {Set<{label: string, via: string, browser?: string, connectedAt: number, lastSeen?: number, send: (data: any) => void, close: () => void}>}
 */
const clients = new Set();
/** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout}>} */
const pending = new Map();
const events = [];
let lastState = null;
let lastEvent = null;
const relayChallenges = new Map();

function hmacHex(label, nonce) {
  return createHmac('sha256', TOKEN).update(`${label}:${nonce}`).digest('hex');
}

function safeHexEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function issueRelayChallenge() {
  const now = Date.now();
  for (const [nonce, expiresAt] of relayChallenges) {
    if (expiresAt <= now) relayChallenges.delete(nonce);
  }
  while (relayChallenges.size >= MAX_RELAY_CHALLENGES) relayChallenges.delete(relayChallenges.keys().next().value);
  const nonce = randomBytes(32).toString('hex');
  relayChallenges.set(nonce, now + RELAY_CHALLENGE_TTL_MS);
  return nonce;
}

function consumeRelayChallenge(nonce, proof) {
  const expiresAt = relayChallenges.get(nonce);
  relayChallenges.delete(nonce);
  return Boolean(expiresAt && expiresAt > Date.now() && safeHexEqual(proof, hmacHex('relay-client', nonce)));
}

function redactUrl(value) {
  try {
    const url = new URL(String(value));
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return String(value ?? '');
  }
}

/* ------------------------------------------------------------- persistence */

function remember(entry) {
  events.push(entry);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  lastEvent = entry;
  if (entry.name === 'page-pushed' && entry.state) lastState = entry.state;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    // Keep the in-memory API lossless, but avoid retaining query strings/fragments
    // (which commonly contain search terms or one-time tokens) in the persistent log.
    const logged = { ...entry };
    if (logged.tab?.url) logged.tab = { ...logged.tab, url: redactUrl(logged.tab.url) };
    if (logged.state?.url) logged.state = { ...logged.state, url: redactUrl(logged.state.url) };
    const line = `${JSON.stringify(logged)}\n`;
    const lineBytes = Buffer.byteLength(line);
    const currentSize = statSync(LOG_FILE, { throwIfNoEntry: false })?.size ?? 0;
    if (currentSize + lineBytes > MAX_LOG_BYTES) {
      // Rotate in place while retaining the newest history.  The previous implementation
      // replaced the whole file with one line, contradicting the README and losing useful
      // diagnostics exactly when the log was busiest.
      const keepBytes = Math.max(0, MAX_LOG_BYTES - lineBytes);
      let tail = Buffer.alloc(0);
      if (keepBytes > 0 && currentSize > 0) {
        const previous = readFileSync(LOG_FILE);
        tail = previous.subarray(Math.max(0, previous.length - keepBytes));
        const firstLine = tail.indexOf(0x0a);
        if (firstLine >= 0) tail = tail.subarray(firstLine + 1);
      }
      const next = Buffer.concat([tail, Buffer.from(line)]);
      writeFileSync(LOG_FILE, next.subarray(Math.max(0, next.length - MAX_LOG_BYTES)));
    } else appendFileSync(LOG_FILE, line);
  } catch { /* logging must never break the bridge */ }
}

/* --------------------------------------------------------- websocket frames */

const acceptKey = (key) => createHash('sha1').update(key + WS_GUID).digest('base64');

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Client → server frames must be masked; used by relay mode. */
function encodeMaskedText(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function encodeControl(opcode) {
  return Buffer.from([0x80 | opcode, 0]);
}

function decodeFrames(state, chunk, { requireMask = false } = {}) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  if (state.buffer.length > MAX_WS_BUFFER_BYTES) throw new Error('websocket receive buffer too large');
  const messages = [];
  for (;;) {
    const buf = state.buffer;
    if (buf.length < 2) break;
    const fin = (buf[0] & 0x80) !== 0;
    const reserved = buf[0] & 0x70;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) break;
      length = buf.readUInt16BE(2); offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) break;
      length = Number(buf.readBigUInt64BE(2)); offset = 10;
    }
    if (reserved !== 0) throw new Error('websocket reserved bits are not supported');
    if (requireMask && !masked) throw new Error('client websocket frame is not masked');
    if (!fin) throw new Error('fragmented websocket frames are not supported');
    if (opcode >= 0x8 && length > 125) throw new Error('invalid websocket control frame');
    // 没有上限时，一个声称 2^60 字节的帧会让缓冲区无限增长（本机 DoS）。超限直接抛，调用方断连。
    if (length > MAX_FRAME_BYTES) throw new Error(`websocket frame too large: ${length} > ${MAX_FRAME_BYTES}`);
    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) break;
      mask = buf.subarray(offset, offset + 4); offset += 4;
    }
    if (buf.length < offset + length) break;
    const payload = Buffer.from(buf.subarray(offset, offset + length));
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    state.buffer = buf.subarray(offset + length);
    messages.push({ opcode, fin, payload });
  }
  return messages;
}

/* ------------------------------------------------------- native messaging io */

function encodeNativeFrame(data) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Feed stdin chunks in; calls onMessage(parsedJson) for each complete frame. */
function createNativeReader(stream, onMessage) {
  const state = { buffer: Buffer.alloc(0) };
  stream.on('data', (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    for (;;) {
      if (state.buffer.length < 4) return;
      const length = state.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        log(`native frame too large: ${length} > ${MAX_FRAME_BYTES}`);
        stream.destroy();
        return;
      }
      if (state.buffer.length < 4 + length) return;
      const payload = state.buffer.subarray(4, 4 + length);
      state.buffer = state.buffer.subarray(4 + length);
      let msg;
      try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
      onMessage(msg);
    }
  });
  return state;
}

const writeNativeFrame = (data) => {
  try { process.stdout.write(encodeNativeFrame(data)); } catch { /* ignore */ }
};

/* ----------------------------------------------------------------- dispatch */

function sendTo(client, data) {
  try { client.send(data); } catch { /* ignore */ }
}

function broadcast(data) {
  for (const client of clients) sendTo(client, data);
}

/**
 * Pick the client that should serve a command.
 *  1. an explicit `browser` pin always wins (tab ids are per-browser, so the caller must be
 *     able to say which browser it means),
 *  2. otherwise the browser whose window is actually focused,
 *  3. otherwise the one with the newest *meaningful* activity — heartbeats deliberately do
 *     not count, because with two browsers connected their 20s pings would otherwise make
 *     the target flip back and forth between them.
 */
function extensionClient(browser) {
  const list = [...clients].filter((c) => c.label === 'chrome-extension');
  if (list.length === 0) return null;
  if (browser) {
    // 支持 chrome@<instance 前缀>：同一个浏览器开多个 Profile 时，两个实例都会报 browser=chrome，
    // 只写 chrome 就指不定是谁（外部评审的第 9 条）。
    const [name, instance] = String(browser).split('@');
    return list.find((c) => (c.browser ?? 'unknown') === name
      && (!instance || String(c.instance ?? '').startsWith(instance))) ?? null;
  }
  if (list.length === 1) return list[0];
  const focused = list.filter((c) => c.focused === true);
  const pool = focused.length ? focused : list;
  return pool.sort((a, b) => (b.lastActive ?? b.connectedAt) - (a.lastActive ?? a.connectedAt))[0];
}

/** Which browsers are connected right now (for error messages and /status). */
const browsersOf = (list = [...clients]) => list.filter((c) => c.label === 'chrome-extension').map((c) => c.browser ?? 'unknown');

function dropClient(client, reason = '') {
  if (!clients.delete(client)) return;
  for (const [id, entry] of pending) {
    if (entry.client !== client) continue;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(new Error(`浏览器连接已断开${reason ? `：${reason}` : ''}`));
  }
  log(`client disconnected (${clients.size} left)${reason ? ` — ${reason}` : ''}`);
  try { client.close(); } catch { /* ignore */ }
}

/** Shared message handling for every transport. */
function handleMessage(client, msg) {
  touch();
  client.lastSeen = Date.now();
  // Heartbeats (and their pongs) must not count as activity, or two connected browsers
  // would take turns being "most recent" and commands would flip between them.
  if (msg.type !== 'ping' && msg.type !== 'pong') client.lastActive = Date.now();
  if (typeof msg.focused === 'boolean') client.focused = msg.focused;
  if (msg.type === 'hello') {
    client.label = msg.agent ?? 'unknown';
    if (msg.browser) client.browser = msg.browser;
    if (msg.instance) client.instance = String(msg.instance);
    // 记下扩展版本：外部的"这次重载到底生效没"就该是一个字段能回答的问题，
    // 而不是靠 since 时间戳 + 试一条会走 POLICY 的命令去反推。
    if (msg.version) client.version = String(msg.version);
    // A relay carries the extension's own hello over its WebSocket uplink, so record the
    // browser-side transport too: /status should say "native" even in relay mode.
    if (msg.via === 'native' && (client.via === 'ws' || client.via === 'relay')) client.via = 'native-relay';
    log(`hello from ${client.label}${client.browser ? ` (${client.browser}${client.instance ? `@${client.instance.slice(0, 8)}` : ''})` : ''} via ${client.via} v${msg.version ?? '?'}`);
    // 令牌只发给"身份可信"的通道：直接由 Chrome 拉起的 native 通道，或握手时出示过令牌的 WS。
    // 攻击者即使抢占端口/连上 WS，也拿不到它，因此无法把扩展骗到自己的通道上。
    const trusted = client.via === 'native' || client.trusted === true;
    sendTo(client, { type: 'hello-ack', server: 'pagebridge', via: client.via, ...(trusted ? { token: TOKEN } : {}) });
    return;
  }
  if (msg.type === 'ping') { sendTo(client, { type: 'pong', t: msg.t }); return; }
  if (msg.type === 'event') {
    remember({ name: msg.name, ts: msg.ts ?? Date.now(), tab: msg.tab, state: msg.state });
    return;
  }
  if (msg.type === 'result') {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error ?? 'extension error'));
  }
}

function clientKey(client) {
  if (!client) return null;
  return `${client.browser ?? 'unknown'}@${client.instance ?? client.connectedAt}`;
}

function findClient(key) {
  return [...clients].find((client) => client.label === 'chrome-extension' && clientKey(client) === key) ?? null;
}

function dispatch(name, args, { waitMs = 8000, timeoutMs = 20000, browser = null, targetKey = null } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      const client = targetKey ? findClient(targetKey) : extensionClient(browser);
      if (!client) {
        if ((browser || targetKey) && Date.now() - started < 1000) { setTimeout(attempt, 200); return; }
        if (browser || targetKey) {
          reject(new Error(`指定的浏览器 ${browser ?? targetKey} 当前没有连接扩展（已连接：${browsersOf().join(', ') || '无'}）`));
          return;
        }
        if (Date.now() - started >= waitMs) {
          reject(new Error('浏览器扩展未连接：请打开扩展图标点“重连”，或切换一次标签页让它自动重连'));
          return;
        }
        setTimeout(attempt, 250);
        return;
      }
      // 记住是谁接的这单：调用方（MCP 层）据此把随后的自动快照固定到同一个浏览器，
      // 否则动作在 Chrome 执行、用户在等待期间切到 Edge，快照就会拍到另一台（评审第 10 条）。
      const served = client.browser ?? null;
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`命令 ${name} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, {
        client,
        resolve: (value) => resolve({ result: value, browser: served, via: client.via }),
        reject,
        timer,
      });
      sendTo(client, { type: 'cmd', id, name, args });
    };
    attempt();
  });
}

/**
 * 同一个 (浏览器, 标签页) 上的命令串行执行。
 *
 * 并发下发时，"点击 A → 输入 B → 快照 → 点击 C" 的执行顺序与模型看到的顺序不再一致，
 * 而页面本身还在做 React 更新。队列把同一目标的顺序固定下来；不同目标互不阻塞。
 */
const queues = new Map();
function enqueue(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  let tail;
  tail = run.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  }, () => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  queues.set(key, tail);
  return run;
}

/* --------------------------------------------------------------- http layer */

const json = (res, code, body) => {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  let bytes = 0;
  let tooLarge = false;
  req.on('data', (chunk) => {
    if (tooLarge) return;
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES) {
      tooLarge = true;
      reject(new Error(`request body too large: ${bytes} > ${MAX_BODY_BYTES}`));
      req.destroy();
      return;
    }
    raw += chunk;
  });
  req.on('end', () => {
    if (tooLarge) return;
    try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
  });
  req.on('error', reject);
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

  // 认证先于一切：回环端口对本机所有进程可见，没有令牌就什么都不给。
  if (!tokenMatches(req, url)) {
    log(`http ${req.method} ${url.pathname} rejected (bad or missing token)`);
    json(res, 401, { ok: false, error: AUTH_HINT });
    return;
  }

  touch();

  if (url.pathname === '/relay-challenge' && req.method === 'GET') {
    // Challenge issuance is part of the authenticated relay handshake.  Keeping it
    // behind the same guard prevents local nonce-flood eviction of a real relay.
    json(res, 200, { nonce: issueRelayChallenge(), expiresMs: RELAY_CHALLENGE_TTL_MS });
    return;
  }

  if (url.pathname === '/shutdown' && req.method === 'POST') {
    json(res, 200, { ok: true, stopping: true });
    log('shutdown requested; exiting');
    setTimeout(() => process.exit(0), 50).unref();
    return;
  }

  if (url.pathname === '/status') {
    const effective = extensionClient(null);
    json(res, 200, {
      connected: clients.size > 0,
      extensionConnected: [...clients].some((c) => c.label === 'chrome-extension'),
      native: NATIVE,
      browsers: browsersOf(),
      effectiveBrowser: effective?.label === 'chrome-extension' ? (effective.browser ?? 'unknown') : null,
      // 当前生效的扩展版本（没有扩展连接时为 null）。用来回答"重载生效了吗"。
      extensionVersion: effective?.label === 'chrome-extension' ? (effective.version ?? null) : null,
      clients: [...clients].map((c) => ({
        label: c.label,
        via: c.via,
        browser: c.browser,
        instance: c.instance ?? null,
        version: c.version ?? null,
        focused: c.focused ?? null,
        since: new Date(c.connectedAt).toISOString(),
        lastSeen: c.lastSeen ? new Date(c.lastSeen).toISOString() : null,
        lastActive: c.lastActive ? new Date(c.lastActive).toISOString() : null,
      })),
      lastEvent,
      events: events.length,
      logFile: LOG_FILE,
    });
    return;
  }

  if (url.pathname === '/events') {
    const requested = Number(url.searchParams.get('limit') ?? 50);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(MAX_EVENTS, Math.trunc(requested))) : 50;
    json(res, 200, { total: events.length, events: events.slice(-limit) });
    return;
  }

  if (url.pathname === '/state') {
    json(res, 200, lastState ?? { pushed: false });
    return;
  }

  if (url.pathname === '/cmd' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!body?.name) { json(res, 400, { ok: false, error: 'missing name' }); return; }
      // 队列键 = (浏览器, 标签页)：同一个目标上的命令串行，不同目标并行。
      const selected = extensionClient(body.browser ?? null);
      const targetKey = clientKey(selected);
      const key = `${targetKey ?? `browser:${body.browser ?? 'auto'}`}#${body.args?.tabId ?? '*'}`;
      const served = await enqueue(key, () => dispatch(body.name, body.args ?? {}, {
        waitMs: Math.max(0, Math.min(60_000, Number(body.waitMs ?? 8000) || 0)),
        timeoutMs: Math.max(100, Math.min(120_000, Number(body.timeoutMs ?? 20_000) || 20_000)),
        browser: body.browser ?? null,
        targetKey,
      }));
      json(res, 200, { ok: true, result: served.result, browser: served.browser, via: served.via });
    } catch (error) {
      json(res, 503, { ok: false, error: String(error?.message ?? error) });
    }
    return;
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end([
    'Page Bridge',
    '',
    `GET  /status            连接状态`,
    `GET  /events?limit=50   最近的标签页事件（仅已共享标签页）`,
    `GET  /state             最近一次推送的页面摘要`,
    `POST /cmd               {"name":"state","args":{},"waitMs":8000,"timeoutMs":20000}`,
    `WS   /ws                扩展的备用连接入口（首选是 native messaging）`,
    '',
    `native mode: ${NATIVE ? 'on' : 'off'}    log: ${LOG_FILE}`,
  ].join('\n'));
});

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const key = req.headers['sec-websocket-key'];
  if (url.pathname !== '/ws' || !key) {
    socket.destroy();
    return;
  }
  const relayNonce = String(req.headers['x-bridge-relay-nonce'] ?? '');
  const relayProof = String(req.headers['x-bridge-relay-proof'] ?? '');
  const relay = relayNonce && relayProof && consumeRelayChallenge(relayNonce, relayProof);
  if (!relay && !tokenMatches(req, url)) {
    log('ws handshake rejected (bad or missing token)');
    try { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
    socket.destroy();
    return;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(String(key))}`,
    '', '',
  ].join('\r\n'));

  const state = { buffer: Buffer.alloc(0) };
  let partialFrameTimer = null;
  const refreshPartialFrameTimer = () => {
    if (partialFrameTimer) { clearTimeout(partialFrameTimer); partialFrameTimer = null; }
    if (state.buffer.length) {
      partialFrameTimer = setTimeout(() => dropClient(client, 'incomplete frame timeout'), WS_FRAME_IDLE_MS);
      partialFrameTimer.unref?.();
    }
  };
  const client = {
    label: 'unknown',
    via: relay ? 'relay' : 'ws',
    trusted: true,   // 走到这里说明 WS 握手出示过能力令牌，或 relay challenge 已通过
    connectedAt: Date.now(),
    send: (data) => { socket.write(encodeText(JSON.stringify(data))); },
    close: () => {
      try { socket.write(Buffer.concat([Buffer.from([0x88, 0x02]), Buffer.from([0x03, 0xe8])])); } catch { /* ignore */ }
      try { socket.end(); } catch { /* ignore */ }
    },
  };
  clients.add(client);
  log(`ws client connected (${clients.size} total)`);
  if (relay) socket.write(encodeText(JSON.stringify({
    type: 'relay-auth-ok',
    nonce: relayNonce,
    proof: hmacHex('relay-server', relayNonce),
  })));

  socket.on('data', (chunk) => {
    touch();
    let messages;
    try { messages = decodeFrames(state, chunk, { requireMask: true }); } catch { dropClient(client, 'bad frame'); return; }
    refreshPartialFrameTimer();
    for (const frame of messages) {
      if (frame.opcode === 0x8) { dropClient(client, 'closed by peer'); return; }
      if (frame.opcode === 0x9) { try { socket.write(encodeControl(0xA)); } catch { /* ignore */ } continue; }
      if (frame.opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { dropClient(client, 'invalid json'); return; }
      handleMessage(client, msg);
    }
  });

  socket.on('close', () => {
    if (partialFrameTimer) clearTimeout(partialFrameTimer);
    dropClient(client, 'socket closed');
  });
  socket.on('error', () => dropClient(client, 'socket error'));
});

/* ------------------------------------------------------------- native client */

/**
 * Register the Chrome-owned stdio channel as a first-class client. In native mode this
 * is the preferred transport: Chrome keeps the process alive while the port is open, so
 * the extension never has to poll a port and the browser side needs no listening socket.
 */
function startNativeClient() {
  const client = {
    label: 'chrome-extension',
    via: 'native',
    connectedAt: Date.now(),
    send: (data) => writeNativeFrame(data),
    close: () => { /* Chrome owns the pipe; nothing to close from our side */ },
  };
  clients.add(client);
  log('native channel ready (stdin/stdout)');

  createNativeReader(process.stdin, (msg) => handleMessage(client, msg));

  const goodbye = (why) => {
    clients.delete(client);
    log(`native channel ended (${why})`);
    // Chrome closed the pipe: nothing left to serve, so stop instead of lingering.
    if (NATIVE) process.exit(0);
  };
  process.stdin.on('end', () => goodbye('stdin end'));
  process.stdin.on('close', () => goodbye('stdin close'));
  process.stdin.resume();
  return client;
}

/* ------------------------------------------------------------------- modes */

/** Relay mode: another bridge already owns the port, so forward frames to it instead. */
function startRelay() {
  const key = randomBytes(16).toString('base64');
  const challengeRequest = httpRequest({
    host: HOST,
    port: PORT,
    path: '/relay-challenge',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  challengeRequest.on('response', (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        log(`relay challenge refused by the port owner (HTTP ${res.statusCode})`);
        process.exit(1);
        return;
      }
      try {
        const nonce = JSON.parse(raw).nonce;
        if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error('invalid relay nonce');
        connectRelay(nonce);
      } catch (error) {
        log(`relay challenge invalid: ${error.message}`);
        process.exit(1);
      }
    });
  });
  challengeRequest.on('error', (error) => {
    log(`relay challenge failed: ${error.message}`);
    process.exit(1);
  });
  challengeRequest.end();

  const connectRelay = (nonce) => {
    const handshake = httpRequest({
      host: HOST,
      port: PORT,
      path: '/ws',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
        'x-bridge-relay-nonce': nonce,
        'x-bridge-relay-proof': hmacHex('relay-client', nonce),
      },
    });

    handshake.on('upgrade', (res, socket, head) => {
      const accept = res.headers['sec-websocket-accept'];
      if (res.statusCode !== 101 || accept !== acceptKey(key)) {
        log('relay refused: invalid websocket handshake');
        socket.destroy();
        process.exit(1);
        return;
      }
      log(`relaying native messaging ⇄ ws://${HOST}:${PORT}/ws (authenticated relay)`);
      const state = { buffer: Buffer.alloc(0) };
      let authenticated = false;
      let stopped = false;
      const stop = (why) => {
        if (stopped) return;
        stopped = true;
        log(`relay stopped (${why})`);
        process.exit(0);
      };
      const fail = (why) => {
        if (stopped) return;
        stopped = true;
        log(`relay authentication failed (${why})`);
        try { socket.destroy(); } catch { /* ignore */ }
        process.exit(1);
      };
      const toBridge = (data) => { try { socket.write(encodeMaskedText(JSON.stringify(data))); } catch { /* ignore */ } };
      const onData = (chunk) => {
        let frames;
        try { frames = decodeFrames(state, chunk); } catch { fail('bad frame'); return; }
        for (const frame of frames) {
          if (frame.opcode !== 0x1) continue;
          let msg;
          try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { fail('invalid json'); return; }
          if (!authenticated) {
            if (msg.type !== 'relay-auth-ok' || msg.nonce !== nonce
              || !safeHexEqual(msg.proof, hmacHex('relay-server', nonce))) {
              fail('bad server proof');
              return;
            }
            authenticated = true;
            createNativeReader(process.stdin, toBridge);
            process.stdin.on('end', () => stop('stdin end'));
            process.stdin.on('close', () => stop('stdin close'));
            process.stdin.resume();
            continue;
          }
          writeNativeFrame(msg);
        }
      };
      socket.on('data', onData);
      if (head?.length) onData(head);
      socket.on('close', () => stop('bridge closed'));
      socket.on('error', () => stop('socket error'));
    });
    handshake.on('response', (res) => {
      res.resume();
      log(`relay refused by the port owner (HTTP ${res.statusCode})`);
      process.exit(1);
    });
    handshake.on('error', (error) => {
      log(`relay handshake failed: ${error.message}`);
      process.exit(1);
    });
    handshake.end();
  };
}

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE' && NATIVE) {
    // Normal on a warm machine: DSH already started a bridge on demand. Stay useful as a relay.
    server.close();
    startRelay();
    return;
  }
  log(`server error: ${error?.message ?? error}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`ready: http://${HOST}:${PORT}/  (ws: ws://${HOST}:${PORT}/ws)`);
  log(`event log: ${LOG_FILE}`);
  if (NATIVE) {
    log('mode: native messaging host (started by Chrome)');
    startNativeClient();
  } else {
    log(IDLE_EXIT_MINUTES > 0
      ? `idle exit: ${IDLE_EXIT_MINUTES} 分钟无流量后自行退出（--idle-exit 0 可关闭）`
      : 'idle exit: 已关闭（常驻）');
  }
});

if (IDLE_EXIT_MINUTES > 0) {
  setInterval(() => {
    if (pending.size > 0) return;
    if (Date.now() - lastActivity < IDLE_EXIT_MINUTES * 60_000) return;
    log(`${IDLE_EXIT_MINUTES} 分钟无流量，退出（下次需要时 page.mjs 会自动拉起）`);
    for (const client of [...clients]) dropClient(client, 'idle exit');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }, 30_000).unref();
}
