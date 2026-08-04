export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Tiny hyperscript. h('div', {class:'x'}, 'text', h('b', null, 'bold')) */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Limits how many promises run at once, so ARM doesn't throttle us. */
export class Pool {
  constructor(size = 4) {
    this.size = size;
    this.active = 0;
    this.queue = [];
  }
  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this._drain();
    });
  }
  async all(items, fn) {
    return Promise.all(items.map((item, i) => this.run(() => fn(item, i))));
  }
  _drain() {
    while (this.active < this.size && this.queue.length) {
      const { fn, resolve, reject } = this.queue.shift();
      this.active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          this.active--;
          this._drain();
        });
    }
  }
}

/** Decodes a JWT payload. No signature check — this is display only. */
export function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const decoded = decodeURIComponent(
      Array.from(json)
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function tokenSummary(token) {
  if (!token) return null;
  const claims = decodeJwt(token);
  if (!claims) return { valid: false };
  const expiresInMs = claims.exp ? claims.exp * 1000 - Date.now() : null;
  return {
    valid: true,
    audience: claims.aud,
    tenant: claims.tid,
    user: claims.upn || claims.unique_name || claims.appid || claims.oid,
    expiresAt: claims.exp ? new Date(claims.exp * 1000) : null,
    expiresInMs,
    expired: expiresInMs !== null && expiresInMs <= 0,
    audienceOk: typeof claims.aud === 'string' && claims.aud.includes('management')
  };
}

export function fmtCountdown(ms) {
  if (ms === null || ms === undefined) return '';
  if (ms <= 0) return 'expired';
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
  return `${mins}m ${String(secs).padStart(2, '0')}s left`;
}

export function shortId(resourceId) {
  if (!resourceId) return '';
  const parts = String(resourceId).split('/');
  return parts[parts.length - 1];
}

/** Groups an array into a Map keyed by fn(item). */
export function groupBy(items, fn) {
  const map = new Map();
  for (const item of items) {
    const key = fn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
