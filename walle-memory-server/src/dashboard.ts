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
#toolbar h1 { font-size: 15px; font-weight: 600; flex: 1; }
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
    <button id="btn-new" class="primary">+ New</button>
    <button id="btn-refresh">Refresh</button>
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

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    const key = prompt('Enter API key:');
    if (key === null) throw new Error('cancelled');
    apiKey = key;
    localStorage.setItem('walle_api_key', key);
    return api(method, path, body);
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

async function loadKeys(query) {
  let res;
  if (query) {
    res = await api('GET', '/memory/search?q=' + encodeURIComponent(query));
    const data = await res.json();
    keys = data.results ?? [];
  } else {
    res = await api('GET', '/memory');
    const data = await res.json();
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
    div.innerHTML = '<div class="key-name">' + esc(k.key) + '</div>' +
      '<div class="key-desc">' + esc(k.description || '') + '</div>';
    div.onclick = () => selectKey(k.key);
    list.appendChild(div);
  });
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function selectKey(key) {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  currentKey = key;
  dirty = false;
  renderList();
  const res = await api('GET', '/memory/' + encodeURIComponent(key));
  if (!res.ok) { toast('Failed to load entry'); return; }
  const entry = await res.json();
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
      '<span>Last access: ' + ts(entry.last_accessed_at) + '</span></div>' : '') +
    '<div style="display:flex;gap:8px;margin-top:16px">' +
    '<button id="btn-save" class="primary">Save</button>' +
    (!isNew ? '<button id="btn-del" class="danger">Delete</button>' : '') +
    '</div>';
  detail.appendChild(form);
  ['f-key','f-desc','f-val'].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('input', () => { dirty = true; });
  });
  $('btn-save').onclick = saveEntry;
  if (!isNew) $('btn-del').onclick = deleteEntry;
}

async function saveEntry() {
  const key = $('f-key').value.trim();
  const value = $('f-val').value;
  const description = $('f-desc').value.trim();
  if (!key) { toast('Key is required'); return; }
  if (!description) { toast('Description is required'); return; }
  const res = await api('POST', '/memory/' + encodeURIComponent(key), { value, description });
  if (!res.ok) { toast('Save failed'); return; }
  dirty = false;
  currentKey = key;
  toast('Saved');
  await loadKeys($('search').value.trim());
  await selectKey(key);
}

async function deleteEntry() {
  if (!confirm('Delete "' + currentKey + '"?')) return;
  const res = await api('DELETE', '/memory/' + encodeURIComponent(currentKey));
  if (!res.ok) { toast('Delete failed'); return; }
  toast('Deleted');
  currentKey = null;
  dirty = false;
  $('detail').innerHTML = '<div id="empty" style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);flex-direction:column;gap:10px"><span>Select a key or create a new one</span></div>';
  await loadKeys($('search').value.trim());
}

$('btn-new').onclick = () => {
  if (dirty && !confirm('Discard unsaved changes?')) return;
  currentKey = null;
  dirty = false;
  renderList();
  renderDetail({ key: '', description: '', value: '' }, true);
};

$('btn-refresh').onclick = () => loadKeys($('search').value.trim());

let searchTimer;
$('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadKeys(e.target.value.trim()), 300);
});

loadKeys('');
</script>
</body>
</html>`;
}
