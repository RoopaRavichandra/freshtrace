const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
const localNow = () => { const d = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4); return d.toISOString().slice(0, 16); };
const toISO = (local) => local ? new Date(local).toISOString() : '';
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.blob();
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
function say(el, text, err) { el.className = 'msg' + (err ? ' err' : ''); el.textContent = text; el.classList.remove('hide'); }
const header = (sub) => `<header class="top"><a href="/">🌱 FreshTrace</a><small>${sub || 'Farm to Table, Tracked'}</small></header>`;
