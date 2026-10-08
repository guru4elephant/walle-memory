export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>walle-memory</title>
<style>
:root {
  --bg: #f7f7f8;
  --surface: #ffffff;
  --surface2: #f0f0f2;
  --border: #e2e2e6;
  --text: #1a1a1e;
  --muted: #6b6b78;
  --accent: oklch(55% 0.18 250);
  --accent-hover: oklch(48% 0.18 250);
  --danger: oklch(52% 0.2 25);
  --radius-sm: 6px;
  --radius: 10px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font: 14px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden; }
#sidebar { width: 280px; min-width: 220px; border-right: 1px solid var(--border); display: flex; flex-direction: column; background: var(--surface); }
#search-wrap { padding: 12px; border-bottom: 1px solid var(--border); }
#search { width: 100%; padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; background: var(--surface2); outline: none; }
#search:focus { border-color: var(--accent); }
#key-list { flex: 1; overflow-y: auto; }
.key-item { padding: 10px 14px; cursor: pointer; border-bottom: 1px solid var(--border); }
.key-item:hover { background: var(--surface2); }
.key-item.active { background: oklch(96% 0.04 250); border-left: 3px solid var(--accent); }
.key-item .key-name { font-weight: 500; font-size: 13px; word-break: break-all; }
.key-item .key-desc { font-size: 12px; color: var(--muted); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
#toolbar { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: center; background: var(--surface); }
#toolbar h1 { font-size: 15px; font-weight: 600; }
#tenant-badge { font-size: 12px; padding: 3px 9px; border-radius: 20px; background: oklch(92% 0.06 250); color: oklch(38% 0.18 250); font-weight: 500; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; }
button { padding: 6px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); font: inherit; cursor: pointer; background: var(--surface); color: var(--text); }
button:hover { background: var(--surface2); }
button.primary { background: var(--accent); color: #fff; border-color: transparent; }
button.primary:hover { background: var(--accent-hover); }
button.danger { color: var(--danger); border-color: var(--danger); }
button.danger:hover { background: oklch(97% 0.02 25); }
#detail { flex: 1; overflow-y: auto; padding: 20px; }
.field { margin-bottom: 16px; }
label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 5px; }
input, textarea { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; background: var(--surface); outline: none; resize: vertical; }
input:focus, textarea:focus { border-color: var(--accent); }
textarea.value-area { min-height: 160px; font-family: ui-monospace, monospace; font-size: 13px; }
#empty { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--muted); flex-direction: column; gap: 10px; }
.meta-row { font-size: 12px; color: var(--muted); display: flex; gap: 20px; margin-top: 4px; }
#toast { position: fixed; bottom: 20px; right: 20px; background: #1a1a1e; color: #fff; padding: 10px 16px; border-radius: var(--radius); font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
#toast.show { opacity: 1; }
</style>
</head>
<body>
<div id="sidebar">
  <div id="search-wrap">
    <input id="search" type="search" placeholder="Search keys and descriptions..." autocomplete="off">
  </div>
  <div id="key-list"></div>
</div>
<div id="main">
  <div id="toolbar">
    <h1>walle-memory</h1>
    <span id="tenant-badge"></span>
    <button id="btn-new" class="primary">+ New</button>
    <button id="btn-refresh">Refresh</button>
    <button id="btn-switch">Switch Tenant</button>
  </div>
  <div id="detail">
    <div id="empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
      <span>Select a key or create a new one</span>
    </div>
  </div>
</div>
<div id="toast"></div>
<script>
const $ = id => document.getElementById(id);
let apiKey = localStorage.getItem('walle_api_key') || '';
let keys = [];
let currentKey = null;
let dirty = false;
let tenantVersion = 0;
let listVersion = 0;
let detailVersion = 0;
let saving = false;

async function api(method, path, body, retry = true) {
  const version = tenantVersion;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (version !== tenantVersion) throw new Error('Tenant changed; request ignored');
  if (res.status === 401) {
    // Never replay a mutation under a replacement tenant/space key.
    if (method !== 'GET') throw new Error('API key no longer valid; switch tenant and retry explicitly');
    if (!retry) throw new Error('Invalid API key');
    const key = prompt('Enter API key:');
    if (key === null) throw new Error('cancelled');
    apiKey = key;
    localStorage.setItem('walle_api_key', key);
    return api(method, path, body, false);
  }
  return res;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2000);
}

function ts(epoch) {
  if (!epoch) return '—';
  return new Date(epoch).toLocaleString();
}

async function loadTenant() {
  const version = tenantVersion;
  const res = await api('GET', '/summary');
  if (!res.ok) throw new Error('Failed to load tenant');
  const data = await res.json();
  if (version !== tenantVersion) return;
  const badge = $('tenant-badge');
  if (badge && data.tenant) badge.textContent = data.tenant;
}

async function loadKeys(query) {
  const version = ++listVersion;
  let res;
  if (query) {
    res = await api('GET', '/memory/search?q=' + encodeURIComponent(query));
    if (!res.ok) { toast('Search failed; check the query'); return; }
    const data = await res.json();
    if (version !== listVersion) return;
    keys = data.results ?? [];
  } else {
    res = await api('GET', '/memory');
    if (!res.ok) { toast('Failed to load entries'); return; }
    const data = await res.json();
    if (version !== listVersion) return;
    keys = data.keys ?? [];
  }
  renderList();
}

function renderList() {
  const list = $('key-list');
  list.innerHTML = '';
  if (keys.length === 0) {
    list.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px">No entries found</div>';
    return;
  }
  keys.forEach(k => {
    const div = document.createElement('div');
    div.className = 'key-item' + (currentKey === k.key ? ' active' : '');
    const expiry = k.expires_at ? ' · expires ' + ts(k.expires_at) : '';
    div.innerHTML = '<div class="key-name">' + esc(k.key) + '</div>' +
      '<div class="key-desc">' + esc(k.description || '') + expiry + '</div>';
    div.onclick = () => run(() => selectKey(k.key));
    list.appendChild(div);
  });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function selectKey(key) {
  if (saving) return;
  if (dirty && !confirm('Discard unsaved changes?')) return;
  currentKey = key;
  dirty = false;
  const version = ++detailVersion;
  renderList();
  const res = await api('GET', '/memory/' + encodeURIComponent(key));
  if (!res.ok) { toast('Failed to load entry'); return; }
  const entry = await res.json();
  if (version !== detailVersion || currentKey !== key) return;
  renderDetail(entry, false);
}

function renderDetail(entry, isNew) {
  const detail = $('detail');
  detail.innerHTML = '';
  const form = document.createElement('div');
  form.innerHTML =
    '<div class="field"><label>Key</label>' +
    '<input id="f-key" value="' + esc(entry.key ?? '') + '"' + (isNew ? '' : ' readonly') + '></div>' +
    '<div class="field"><label>Description</label>' +
    '<input id="f-desc" value="' + esc(entry.description ?? '') + '"></div>' +
    '<div class="field"><label>Value</label>' +
    '<textarea id="f-val" class="value-area">' + esc(entry.value ?? '') + '</textarea></div>' +
    (!isNew ? '<div class="meta-row"><span>Updated: ' + ts(entry.updated_at) + '</span>' +
      '<span>Accessed: ' + entry.access_count + ' times</span>' +
      '<span>Last access: ' + ts(entry.last_accessed_at) + '</span>' +
      '<span>Expires: ' + (entry.expires_at ? ts(entry.expires_at) : 'never') + '</span></div>' : '') +
    '<div class="field"><label>TTL (seconds, blank = permanent)</label>' +
    '<input id="f-ttl" type="number" min="1" placeholder="e.g. 86400 for 1 day" value=""></div>' +
    '<div style="display:flex;gap:8px;margin-top:16px">' +
    '<button id="btn-save" class="primary">Save</button>' +
    (!isNew ? '<button id="btn-del" class="danger">Delete</button>' : '') +
    '</div>';
  detail.appendChild(form);
  ['f-key','f-desc','f-val','f-ttl'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('input', () => { dirty = true; });
  });
  $('btn-save').onclick = () => run(saveEntry);
  if (!isNew) $('btn-del').onclick = () => run(deleteEntry);
}

async function saveEntry() {
  if (saving) return;
  const version = detailVersion;
  const key = $('f-key').value.trim();
  const value = $('f-val').value;
  const description = $('f-desc').value.trim();
  if (!key) { toast('Key is required'); return; }
  if (!description) { toast('Description is required'); return; }
  const ttlRaw = $('f-ttl') ? $('f-ttl').value.trim() : '';
  const body = { value, description };
  if (ttlRaw) {
    body.ttl_seconds = Number(ttlRaw);
    if (!Number.isFinite(body.ttl_seconds) || body.ttl_seconds <= 0) { toast('TTL must be positive'); return; }
  }
  let res;
  saving = true;
  try { res = await api('POST', '/memory/' + encodeURIComponent(key), body); }
  finally { saving = false; }
  if (!res.ok) { toast('Save failed'); return; }
  dirty = false;
  currentKey = key;
  toast('Saved');
  await loadKeys($('search').value.trim());
  if (version === detailVersion) await selectKey(key);
}

async function deleteEntry() {
  if (saving) return;
  if (!confirm('Delete "' + currentKey + '"?')) return;
  let res;
  saving = true;
  try { res = await api('DELETE', '/memory/' + encodeURIComponent(currentKey)); }
  finally { saving = false; }
  if (!res.ok) { toast('Delete failed'); return; }
  toast('Deleted');
  currentKey = null;
  dirty = false;
  $('detail').innerHTML = '<div id="empty" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);flex-direction:column;gap:10px"><span>Select a key or create a new one</span></div>';
  await loadKeys($('search').value.trim());
}

$('btn-new').onclick = () => {
  if (saving) return;
  if (dirty && !confirm('Discard unsaved changes?')) return;
  currentKey = null;
  dirty = false;
  detailVersion++;
  renderList();
  renderDetail({ key: '', description: '', value: '' }, true);
};

$('btn-refresh').onclick = () => run(() => loadKeys($('search').value.trim()));

$('btn-switch').onclick = () => {
  if (saving) return;
  if (dirty && !confirm('Discard unsaved changes?')) return;
  localStorage.removeItem('walle_api_key');
  apiKey = '';
  currentKey = null;
  dirty = false;
  tenantVersion++;
  listVersion++;
  detailVersion++;
  clearTimeout(searchTimer);
  $('search').value = '';
  keys = [];
  renderList();
  const badge = $('tenant-badge');
  if (badge) badge.textContent = '';
  $('detail').innerHTML = '<div id="empty" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);flex-direction:column;gap:10px"><span>Select a key or create a new one</span></div>';
  run(() => loadTenant().then(() => loadKeys('')));
};

let searchTimer;
$('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => run(() => loadKeys(e.target.value.trim())), 300);
});

function run(action) {
  return Promise.resolve().then(action).catch(error => {
    if (error.message !== 'cancelled') toast(error.message || 'Request failed');
  });
}

run(() => loadTenant().then(() => loadKeys('')));
</script>
</body>
</html>`;
}
