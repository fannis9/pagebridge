/**
 * Page Bridge — domain and page policy.
 *
 * Kept dependency-free so it can be loaded by the MV3 service worker and tested
 * directly by dev/grant-policy-test.mjs.
 */
// #region grant-policy
const DSH_POLICY = (() => {
  const normalizePattern = (raw) => String(raw ?? '')
    .trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/^\./, '')
    .replace(/\.$/, '');
  const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
  const originOf = (url) => { try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return ''; } };
  /** `example.com` matches itself and subdomains; `*.example.com` matches subdomains only. */
  const matches = (host, pattern) => {
    const p = normalizePattern(pattern);
    if (!p || !host) return false;
    if (p.startsWith('*.')) {
      const base = p.slice(2);
      return host === base || host.endsWith(`.${base}`);
    }
    return host === p || host.endsWith(`.${p}`);
  };
  /**
   * Decide whether a URL may be read/operated.
   * An empty allowlist means "everything except the blocklist"; a non-empty allowlist
   * turns the mode into default-deny.
   */
  const isDomainAllowed = (url, allow = [], block = []) => {
    const host = hostOf(url);
    if (!host) return true;
    if (block.some((p) => matches(host, p))) return false;
    if (allow.length === 0) return true;
    return allow.some((p) => matches(host, p));
  };
  /** Non-web schemes cannot be injected into; callers report them as protected pages. */
  const isProtected = (url) => !/^https?:/i.test(String(url ?? ''));
  const sanitizeList = (value) => {
    const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,;]+/);
    const out = [];
    for (const item of raw) {
      const p = normalizePattern(item);
      if (p && !out.includes(p)) out.push(p);
    }
    return out;
  };
  return { normalizePattern, hostOf, originOf, matches, isDomainAllowed, isProtected, sanitizeList };
})();
// #endregion grant-policy

globalThis.DSH_POLICY = DSH_POLICY;
