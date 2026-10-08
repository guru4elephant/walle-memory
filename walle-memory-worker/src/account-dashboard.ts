/** Standalone account UI. All state, including one-time credentials, stays in memory. */
export function getAccountDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<title>账户与记忆空间 · walle-memory</title>
<style>
:root { color-scheme: light; --bg:#f5f6f9; --surface:#fff; --text:#192334; --muted:#677287; --line:#e4e8ef; --accent:#3758ce; --accent-soft:#edf1ff; --danger:#ac2839; --green:#23684b; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
a { color:var(--accent); text-underline-offset:3px; }
button,input,select,textarea { font:inherit; }
button { border:1px solid var(--line); background:var(--surface); color:var(--text); border-radius:8px; padding:8px 13px; cursor:pointer; }
button:hover:not(:disabled) { background:#f1f3f8; }
button:disabled { opacity:.55; cursor:wait; }
button.primary { background:var(--accent); border-color:var(--accent); color:white; }
button.primary:hover:not(:disabled) { background:#2948b5; }
button.danger { color:var(--danger); border-color:#e8bbc2; }
button:focus-visible,a:focus-visible,summary:focus-visible { outline:3px solid #a0b2f4; outline-offset:3px; }
input,select,textarea { width:100%; min-width:0; border:1px solid #ced5e1; border-radius:8px; padding:9px 11px; background:white; color:var(--text); }
input:focus,select:focus,textarea:focus { outline:2px solid #c4cff9; border-color:var(--accent); }
input[type="checkbox"] { width:17px; height:17px; accent-color:var(--accent); }
input[type="password"] { font-family:inherit; }
label { display:block; font-weight:600; margin-bottom:5px; }
label.check { display:flex; gap:8px; align-items:center; font-weight:400; margin:0; }
fieldset { border:0; padding:0; margin:0; min-width:0; }
legend { font-weight:600; margin-bottom:8px; padding:0; }
h1,h2,h3,p { margin:0; }
h1 { font-size:26px; line-height:1.3; letter-spacing:-.03em; }
h2 { font-size:18px; line-height:1.4; }
h3 { font-size:15px; }
.topbar { background:var(--surface); border-bottom:1px solid var(--line); }
.topbar-inner { max-width:1120px; margin:auto; padding:18px 28px; display:flex; align-items:center; justify-content:space-between; gap:16px; }
.brand { display:flex; gap:10px; align-items:center; font-weight:700; text-decoration:none; color:var(--text); }
.brand-mark { display:grid; place-items:center; width:30px; height:30px; border-radius:9px; background:var(--accent); color:white; font-size:17px; }
.navlink { font-size:13px; }
main { max-width:1120px; padding:34px 28px 48px; margin:auto; }
.intro { margin-bottom:24px; }
.intro p { color:var(--muted); margin-top:8px; max-width:650px; }
.card { background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:22px; }
.muted { color:var(--muted); }
.hint { font-size:12px; color:var(--muted); margin-top:6px; }
.small { font-size:12px; }
.stack { display:grid; gap:16px; }
.row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.spread { justify-content:space-between; }
.field { margin-top:15px; }
.two-fields { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.actions { margin-top:18px; display:flex; gap:9px; flex-wrap:wrap; align-items:center; }
.notice { background:#f7f8fc; border:1px solid var(--line); border-radius:8px; padding:11px 13px; font-size:13px; }
.status { margin-top:14px; min-height:0; font-size:13px; overflow-wrap:anywhere; }
.status:empty { display:none; }
.status.error { color:var(--danger); }
.status.success { color:var(--green); }
.auth-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:22px; max-width:820px; }
.auth-context { padding:26px; background:var(--accent-soft); border-radius:14px; }
.auth-context ol { padding-left:20px; margin:18px 0 0; }
.auth-context li { margin:12px 0; }
.workspace { display:grid; grid-template-columns:300px minmax(0,1fr); gap:20px; align-items:start; margin-top:20px; }
.account-row { padding:16px 20px; }
.account-info { min-width:0; overflow-wrap:anywhere; }
.account-info strong { display:block; }
.space-list { display:grid; gap:7px; margin-top:16px; }
.space-button { display:block; text-align:left; width:100%; padding:11px 12px; }
.space-button strong { display:block; overflow-wrap:anywhere; }
.space-button .small { display:block; color:var(--muted); margin-top:2px; }
.space-button.active { background:var(--accent-soft); border-color:#b6c5fb; color:#2645ae; }
.space-button.active .small { color:#5269b2; }
.space-form { margin-top:20px; padding-top:18px; border-top:1px solid var(--line); }
.space-heading { display:flex; gap:12px; align-items:start; justify-content:space-between; }
.space-heading h2 { overflow-wrap:anywhere; }
.badge { display:inline-flex; align-items:center; font-size:11px; font-weight:600; padding:2px 8px; border:1px solid var(--line); border-radius:20px; background:#f5f7fa; white-space:nowrap; }
.badge.good { background:#ecf7f0; color:var(--green); border-color:#cee6d7; }
.badge.warn { background:#fff6e9; color:#895813; border-color:#ecd9ba; }
.legacy-note { margin-top:16px; background:#fffaf2; border:1px solid #eee1cc; border-radius:8px; padding:13px; }
.legacy-note button { margin-top:9px; }
.section-divider { margin-top:22px; padding-top:21px; border-top:1px solid var(--line); }
.scopes { display:flex; flex-wrap:wrap; gap:12px 20px; margin-top:14px; }
.key-list { display:grid; gap:10px; margin-top:14px; }
.key-card { border:1px solid var(--line); border-radius:10px; padding:14px; }
.key-title { display:flex; flex-wrap:wrap; gap:7px; align-items:center; }
.key-title strong { overflow-wrap:anywhere; }
.key-meta { display:flex; flex-wrap:wrap; gap:4px 16px; margin-top:7px; color:var(--muted); font-size:12px; }
.key-prefix { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; }
.empty-state { padding:24px 10px; text-align:center; color:var(--muted); }
.admin { margin-top:26px; padding:0; overflow:hidden; }
.admin summary { cursor:pointer; padding:18px 22px; font-weight:600; }
.admin-body { border-top:1px solid var(--line); padding:22px; }
.admin-grid { display:grid; grid-template-columns:1fr 1fr; gap:28px; margin-top:22px; }
.admin-key { max-width:570px; }
.admin-list { max-height:145px; overflow:auto; margin-top:12px; display:grid; gap:6px; }
.admin-list .choice { text-align:left; width:100%; font-size:12px; overflow-wrap:anywhere; }
.admin-list .choice.active { border-color:#b6c5fb; background:var(--accent-soft); }
code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:12px; overflow-wrap:anywhere; }
dialog { color:var(--text); border:1px solid var(--line); border-radius:16px; padding:24px; max-width:540px; width:calc(100% - 32px); box-shadow:0 24px 80px #10204b35; }
dialog::backdrop { background:#17244370; }
dialog p { margin-top:10px; }
.secret-output { margin-top:15px; font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:13px; min-height:96px; resize:none; }
[hidden] { display:none !important; }
@media (max-width:800px) { .workspace { grid-template-columns:1fr; } .space-list { grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); } .admin-grid { grid-template-columns:1fr; gap:26px; } }
@media (max-width:580px) { main { padding:25px 16px 32px; } .topbar-inner { padding:15px 16px; } h1 { font-size:23px; } .card { padding:18px; } .auth-grid,.two-fields { grid-template-columns:1fr; } .auth-context { padding:20px; } .topbar .brand { font-size:13px; } .navlink { font-size:12px; } .account-row { gap:14px; } .admin summary,.admin-body { padding:18px; } }
</style>
</head>
<body>
<header class="topbar"><div class="topbar-inner"><a class="brand" href="/account"><span class="brand-mark" aria-hidden="true">w</span>walle-memory</a><a class="navlink" href="/">打开记忆工作台 ↗</a></div></header>
<main>
  <div class="intro"><h1>账户与记忆空间</h1><p>按用途管理独立的记忆空间，为每个应用签发指定权限的 API Key。</p></div>
  <div id="page-status" class="status" role="status" aria-live="polite"></div>
  <section id="auth-section" class="auth-grid">
    <div class="card">
      <div class="row spread"><h2 id="auth-title">登录账户</h2><button id="auth-toggle" type="button" hidden>邀请码注册</button></div>
      <p id="registration-note" class="hint">正在读取注册设置…</p>
      <form id="auth-form">
        <div id="registration-name-field" class="field" hidden><label for="auth-name">显示名称（可选）</label><input id="auth-name" maxlength="128" autocomplete="nickname"></div>
        <div class="field"><label for="auth-email">邮箱</label><input id="auth-email" type="email" required maxlength="254" autocomplete="username"></div>
        <div class="field"><label for="auth-password">密码</label><input id="auth-password" type="password" required maxlength="256" autocomplete="current-password"></div>
        <div id="registration-invitation-field" class="field" hidden><label for="auth-invitation-code">邀请码</label><input id="auth-invitation-code" type="password" maxlength="512" autocomplete="off" spellcheck="false"><p class="hint">请输入管理员提供的邀请码。提交后会从输入框清除。</p></div>
        <div class="actions"><button id="auth-submit" class="primary" type="submit">登录</button></div>
        <p id="auth-status" class="status" role="status" aria-live="polite"></p>
      </form>
    </div>
    <aside class="auth-context"><h2>给不同记忆留出空间</h2><ol><li><strong>使用自己的账号</strong><br><span class="muted">登录后只管理属于自己的空间。</span></li><li><strong>按用途划分空间</strong><br><span class="muted">工作知识、事件记录与应用状态可分别管理。</span></li><li><strong>为应用签发 Key</strong><br><span class="muted">每个 Key 限定一个空间，可设置权限、到期时间并随时撤销。</span></li></ol></aside>
  </section>
  <section id="account-section" hidden>
    <div class="card account-row row spread"><div class="account-info"><strong id="account-name"></strong><span id="account-email" class="muted small"></span></div><div class="row"><button id="refresh-spaces" type="button">刷新空间</button><button id="logout" type="button">退出登录</button></div></div>
    <div class="workspace">
      <aside class="card"><h2>我的空间</h2><p class="hint">每个空间的数据和检索独立。</p><div id="space-list" class="space-list"></div>
        <form id="space-form" class="space-form"><h3>创建空间</h3><div class="field"><label for="space-name">空间名称</label><input id="space-name" required maxlength="128" placeholder="例如：工作知识"></div><div class="field"><label for="space-type">记忆类型</label><input id="space-type" required maxlength="64" value="general" list="memory-types" pattern="[a-z](?:[a-z0-9_]|-){0,63}"><p class="hint">以小写字母开头，使用小写字母、数字、下划线或连字符。</p></div><div class="actions"><button id="space-submit" class="primary" type="submit">创建空间</button></div><p id="space-status" class="status" role="status" aria-live="polite"></p></form>
      </aside>
      <section class="card"><div id="no-space" class="empty-state"><h2>还没有记忆空间</h2><p>创建第一个空间，再为应用签发 Key。</p></div><div id="space-detail" hidden>
        <div class="space-heading"><div><h2 id="selected-space-name"></h2><p class="hint">类型 <span id="selected-space-type"></span></p></div><span class="badge">独立分区</span></div>
        <p class="hint">空间 ID：<code id="selected-space-id"></code></p>
        <div id="legacy-warning" class="legacy-note" hidden><strong>旧租户 Key 仍然有效</strong><p class="small muted">绑定账号后，原 Key 继续拥有此空间的完整访问权限。先更新应用使用新 Key，再停用旧 Key。</p><button id="revoke-legacy" class="danger" type="button">停用旧租户 Key</button></div>
        <form id="key-form" class="section-divider"><h3>签发 API Key</h3><div class="two-fields"><div class="field"><label for="key-label">Key 名称</label><input id="key-label" required maxlength="128" placeholder="例如：笔记助手"></div><div class="field"><label for="key-expiry">到期时间（可选）</label><input id="key-expiry" type="datetime-local"><p class="hint">按当前设备时区；留空表示长期有效。</p></div></div><fieldset class="scopes"><legend>允许的操作</legend><label class="check"><input type="checkbox" name="scope" value="read" checked>读取与检索</label><label class="check"><input type="checkbox" name="scope" value="write" checked>写入</label><label class="check"><input type="checkbox" name="scope" value="delete">删除</label><label class="check"><input type="checkbox" name="scope" value="gc">清理到期记忆</label></fieldset><div class="actions"><button id="key-submit" class="primary" type="submit">签发 Key</button><span class="hint">完整 Key 只显示一次。</span></div><p id="key-status" class="status" role="status" aria-live="polite"></p></form>
        <div class="section-divider"><div class="row spread"><h3>已签发的 Key</h3><button id="refresh-keys" type="button">刷新列表</button></div><div id="key-list" class="key-list"></div><p id="keys-status" class="status" role="status" aria-live="polite"></p></div>
        <div class="notice section-divider">在 <a href="/">记忆工作台</a> 输入已保存的 Key 即可读写此空间。账户页不会自动把 Key 传到其他页面。旧工作台会记住输入的 Key，仅在可信设备上使用。</div>
      </div></section>
    </div>
  </section>
  <details id="admin-details" class="card admin"><summary>管理员工具</summary><div class="admin-body"><p class="muted small">使用服务端管理员 Key 创建账号，或为已有租户指定账号归属。管理员 Key 每次请求后从输入框清除。</p>
    <div class="field admin-key"><label for="admin-key">管理员 Key（仅用于下一次操作）</label><input id="admin-key" type="password" autocomplete="off" spellcheck="false" maxlength="512" placeholder="X-Api-Key"><p class="hint">读取列表、创建账号、绑定空间和管理邀请码前分别输入，不会保存在浏览器存储中。</p></div>
    <div class="actions"><button id="admin-load" type="button">加载账号与租户列表</button></div><p id="admin-status" class="status" role="status" aria-live="polite"></p>
    <div class="admin-grid"><section><h3>创建账号</h3><form id="admin-account-form"><div class="field"><label for="admin-name">显示名称</label><input id="admin-name" required maxlength="128" autocomplete="off"></div><div class="field"><label for="admin-email">邮箱</label><input id="admin-email" type="email" required maxlength="254" autocomplete="off"></div><div class="field"><label for="admin-password">初始密码</label><input id="admin-password" type="password" required minlength="12" maxlength="256" autocomplete="new-password"><p class="hint">至少 12 个字符。通过安全方式交给账号使用者。</p></div><div class="actions"><button id="admin-create" class="primary" type="submit">创建账号</button></div><p id="admin-account-status" class="status" role="status" aria-live="polite"></p></form></section>
    <section><h3>绑定已有租户</h3><p class="hint">仅能绑定尚无归属的租户，或更新所选账号已有的绑定。不会转移其他账号的空间。</p><form id="admin-claim-form"><div class="field"><label for="claim-account">账号 ID</label><input id="claim-account" required maxlength="128" autocomplete="off"><div id="admin-accounts" class="admin-list"></div></div><div class="field"><label for="claim-tenant">旧租户 ID</label><input id="claim-tenant" required maxlength="128" autocomplete="off"><div id="admin-tenants" class="admin-list"></div></div><div class="two-fields"><div class="field"><label for="claim-name">空间显示名称（可选）</label><input id="claim-name" maxlength="128" autocomplete="off"></div><div class="field"><label for="claim-type">记忆类型（可选）</label><input id="claim-type" maxlength="64" list="memory-types" pattern="[a-z](?:[a-z0-9_]|-){0,63}"></div></div><div class="actions"><button id="admin-claim" class="primary" type="submit">绑定到账号</button><button id="admin-revoke-legacy" class="danger" type="button">停用所选租户旧 Key</button></div><p id="admin-claim-status" class="status" role="status" aria-live="polite"></p></form></section></div>
    <section class="section-divider"><div class="row spread"><h3>邀请码管理</h3><button id="invitation-load" type="button">加载邀请码列表</button></div><p class="hint">只有提供管理员 Key 才能创建、加载或撤销。邀请码模式开启后，受邀用户可在此页面注册。</p>
      <form id="admin-invitation-form"><div class="two-fields"><div class="field"><label for="invitation-label">邀请名称</label><input id="invitation-label" required maxlength="128" autocomplete="off" placeholder="例如：团队成员"></div><div class="field"><label for="invitation-max-uses">最多注册人数</label><input id="invitation-max-uses" type="number" required min="1" max="1000" step="1" value="1"><p class="hint">默认 1 人；允许 1 至 1000 人。</p></div></div><div class="field admin-key"><label for="invitation-expiry">到期时间（可选）</label><input id="invitation-expiry" type="datetime-local"><p class="hint">按当前设备时区；留空表示长期有效。</p></div><div class="actions"><button id="invitation-create" class="primary" type="submit">创建邀请码</button><span class="hint">完整邀请码只显示一次。</span></div></form>
      <p id="invitation-status" class="status" role="status" aria-live="polite"></p><div id="invitation-list" class="key-list"><p class="hint">输入管理员 Key 后加载列表。</p></div>
    </section>
  </div></details>
</main>
<datalist id="memory-types"><option value="general"><option value="semantic"><option value="episodic"><option value="procedural"></datalist>
<dialog id="secret-dialog" aria-labelledby="secret-title"><h2 id="secret-title">保存这枚 API Key</h2><p id="secret-context" class="muted"></p><p class="small">完整 Key 只显示这一次。关闭窗口、切换到其他页面或退出登录后会清除，服务端只保存哈希。请保存到你的安全凭据管理工具。</p><label for="secret-output" class="field">完整 API Key</label><textarea id="secret-output" class="secret-output" readonly autocomplete="off" spellcheck="false"></textarea><div class="actions"><button id="copy-key" class="primary" type="button">复制 Key</button><button id="close-secret" type="button">关闭并清除</button></div><p id="secret-status" class="status" role="status" aria-live="polite"></p></dialog>
<dialog id="invitation-secret-dialog" aria-labelledby="invitation-secret-title"><h2 id="invitation-secret-title">保存这份邀请码</h2><p id="invitation-secret-context" class="muted"></p><p class="small">完整邀请码只显示这一次。请手动选中并保存，通过安全方式提供给受邀用户。关闭窗口、切换页面或登录状态变化后会清除。此代码用于注册账户，不能调用记忆 API。</p><label for="invitation-secret-output" class="field">完整邀请码</label><textarea id="invitation-secret-output" class="secret-output" readonly autocomplete="off" spellcheck="false"></textarea><div class="actions"><button id="close-invitation-secret" type="button">关闭并清除</button></div><p id="invitation-secret-status" class="status" role="status" aria-live="polite"></p></dialog>
<dialog id="confirm-dialog" aria-labelledby="confirm-title"><h2 id="confirm-title"></h2><p id="confirm-description" class="muted"></p><div class="actions"><button id="confirm-action" class="danger" type="button">确认撤销</button><button id="confirm-cancel" type="button">取消</button></div></dialog>
<script>
'use strict';
const $ = id => document.getElementById(id);
const state = { account:null, spaces:[], selectedId:null, authVersion:0, spacesVersion:0, keysVersion:0, secretVersion:0, secretIssuing:null, invitationsVersion:0, invitations:[], registrationMode:'admin', registering:false, keyIssuing:false, adminAccounts:[], adminTenants:[] };
const scopeNames = { read:'读取', write:'写入', delete:'删除', gc:'清理' };
let confirmation = null;

function status(id, message, kind) {
  const el = $(id);
  el.textContent = message || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}
function errorMessage(error) {
  if (error && error.stale) return '';
  if (error && error.local) return error.message;
  const messages = { 400:'请检查输入内容、权限、人数和到期时间。', 401:'身份验证失败，请检查凭据或重新登录。', 403:'没有执行此操作的权限，或当前未开放邀请码注册。', 404:'账号、空间、Key 或邀请码不存在，请刷新后重试。', 409:'邮箱已使用，或此租户已属于其他账号。', 410:'邀请码已过期或不可用。', 413:'输入内容过长。', 429:'请求过于频繁，请稍后再试。', 503:'此功能尚未配置，请联系管理员。' };
  return messages[error && error.status] || '请求未完成，请检查连接后重试。';
}
function localError(message) { const error = new Error(message); error.local = true; return error; }
function staleError() { const error = new Error('stale'); error.stale = true; return error; }
function scrubCredentials(data) {
  if (!data || typeof data !== 'object') return;
  if ('api_key' in data) data.api_key = '';
  if ('invitation_code' in data) data.invitation_code = '';
}
async function api(method, path, body, adminKey, accountRequired) {
  const version = state.authVersion;
  const headers = { Accept:'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (adminKey) headers['X-Api-Key'] = adminKey;
  const res = await fetch(path, { method, headers, body:body === undefined ? undefined : JSON.stringify(body), credentials:'same-origin', cache:'no-store' });
  if (accountRequired && version !== state.authVersion) throw staleError();
  if (!res.ok) {
    if (res.status === 401 && accountRequired) {
      clearAccount();
      status('auth-status','登录状态已过期，请重新登录。','error');
    }
    const error = new Error('request failed'); error.status = res.status; throw error;
  }
  const data = await res.json();
  const secretResponse = data && typeof data === 'object' && ('api_key' in data || 'invitation_code' in data);
  if ((accountRequired || secretResponse) && version !== state.authVersion) {
    scrubCredentials(data);
    throw staleError();
  }
  return data;
}
async function run(buttonId, statusId, task) {
  const button = $(buttonId); if (button.disabled) return;
  button.disabled = true; status(statusId,'');
  try { await task(); } catch (error) { status(statusId,errorMessage(error),'error'); }
  finally { button.disabled = false; }
}
function textElement(tag, text, className) {
  const el = document.createElement(tag); el.textContent = text == null ? '' : String(text); if (className) el.className = className; return el;
}
function dateText(value) {
  if (!value) return '无'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '未知' : date.toLocaleString();
}
function displayName(item) { return item.display_name || item.name || item.email || item.id; }
function selectedSpace() { return state.spaces.find(space => space.id === state.selectedId); }
function wipeKeyDialog() { $('secret-output').value = ''; $('secret-context').textContent = ''; status('secret-status',''); }
function wipeInvitationDialog() { $('invitation-secret-output').value = ''; $('invitation-secret-context').textContent = ''; status('invitation-secret-status',''); }
function clearSecret() {
  state.secretVersion++;
  wipeKeyDialog(); wipeInvitationDialog();
  if ($('secret-dialog').open) $('secret-dialog').close();
  if ($('invitation-secret-dialog').open) $('invitation-secret-dialog').close();
}
function clearInvitations() { state.invitationsVersion++; state.invitations = []; $('invitation-list').replaceChildren(); status('invitation-status',''); }
function closeConfirmation() { confirmation = null; if ($('confirm-dialog').open) $('confirm-dialog').close(); }
function clearAccount() {
  state.authVersion++; state.spacesVersion++; state.keysVersion++; state.account = null; state.spaces = []; state.selectedId = null;
  clearSecret(); clearInvitations(); closeConfirmation(); $('auth-invitation-code').value = ''; $('account-name').textContent = ''; $('account-email').textContent = ''; $('space-list').replaceChildren(); $('key-list').replaceChildren();
  $('account-section').hidden = true; $('auth-section').hidden = false;
  $('space-name').value = ''; $('key-label').value = ''; $('key-expiry').value = '';
  ['selected-space-name','selected-space-type','selected-space-id'].forEach(id => { $(id).textContent = ''; });
}
function showAccount(account) {
  clearSecret(); clearInvitations(); $('auth-invitation-code').value = '';
  state.authVersion++; state.account = account;
  $('account-name').textContent = displayName(account); $('account-email').textContent = account.email;
  $('auth-section').hidden = true; $('account-section').hidden = false; status('page-status','');
}
function renderSpaces() {
  const list = $('space-list'); list.replaceChildren();
  if (!state.spaces.length) list.append(textElement('p','还没有空间。','hint'));
  state.spaces.forEach(space => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'space-button' + (space.id === state.selectedId ? ' active' : ''); button.disabled = state.keyIssuing;
    button.setAttribute('aria-pressed',String(space.id === state.selectedId)); button.append(textElement('strong',displayName(space)),textElement('span',space.memory_type || 'general','small'));
    button.addEventListener('click',() => { if (!state.keyIssuing) selectSpace(space.id); }); list.append(button);
  });
  const space = selectedSpace(); $('no-space').hidden = Boolean(space); $('space-detail').hidden = !space;
  if (space) {
    $('selected-space-name').textContent = displayName(space); $('selected-space-type').textContent = space.memory_type || 'general'; $('selected-space-id').textContent = space.id; $('legacy-warning').hidden = !space.legacy_key_active;
  }
}
function selectSpace(id) {
  state.selectedId = id; state.keysVersion++; clearSecret(); status('key-status',''); status('keys-status',''); $('key-list').replaceChildren(); renderSpaces();
  if (selectedSpace()) loadKeys().catch(error => status('keys-status',errorMessage(error),'error'));
}
async function loadSpaces(preferredId) {
  const version = state.authVersion;
  const spacesVersion = ++state.spacesVersion;
  const data = await api('GET','/account/spaces',undefined,undefined,true);
  if (version !== state.authVersion || spacesVersion !== state.spacesVersion) throw staleError();
  state.spaces = Array.isArray(data.spaces) ? data.spaces : [];
  const previousId = preferredId || state.selectedId;
  state.selectedId = state.spaces.some(space => space.id === previousId) ? previousId : (state.spaces[0] ? state.spaces[0].id : null);
  renderSpaces();
  if (state.selectedId) await loadKeys(); else $('key-list').replaceChildren();
}
async function loadKeys() {
  const space = selectedSpace(); if (!space) return;
  const version = ++state.keysVersion; status('keys-status','');
  const data = await api('GET','/account/spaces/' + encodeURIComponent(space.id) + '/keys',undefined,undefined,true);
  if (version !== state.keysVersion || space.id !== state.selectedId) throw staleError();
  const list = $('key-list'); list.replaceChildren();
  const keys = Array.isArray(data.keys) ? data.keys : [];
  if (!keys.length) { list.append(textElement('p','尚未签发 Key。','empty-state')); return; }
  keys.forEach(key => {
    const card = textElement('div','','key-card'); const title = textElement('div','','key-title'); title.append(textElement('strong',key.label || '未命名 Key'));
    const expired = key.expires_at && key.expires_at <= Date.now(); const inactive = Boolean(key.revoked_at || expired);
    title.append(textElement('span',key.revoked_at ? '已撤销' : expired ? '已到期' : '有效','badge' + (inactive ? '' : ' good')));
    const metadata = textElement('div','','key-meta'); metadata.append(textElement('span','前缀 ' + (key.prefix || '—'),'key-prefix'),textElement('span','权限 ' + (Array.isArray(key.scopes) ? key.scopes.map(scope => scopeNames[scope] || scope).join('、') : '—')));
    const dates = textElement('div','','key-meta'); dates.append(textElement('span','签发 ' + dateText(key.created_at)),textElement('span','到期 ' + dateText(key.expires_at)));
    if (key.revoked_at) dates.append(textElement('span','撤销 ' + dateText(key.revoked_at)));
    card.append(title,metadata,dates);
    if (!key.revoked_at) {
      const actions = textElement('div','','actions'); const button = textElement('button','撤销','danger'); button.type = 'button';
      button.addEventListener('click',() => confirmAction('撤销此 API Key？','“' + (key.label || '未命名 Key') + '”将立即失效，使用它的应用需要更换 Key。',async () => {
        button.disabled = true;
        try { await api('DELETE','/account/spaces/' + encodeURIComponent(space.id) + '/keys/' + encodeURIComponent(key.id),undefined,undefined,true); if (space.id === state.selectedId) await loadKeys(); status('keys-status','Key 已撤销。','success'); }
        catch (error) { status('keys-status',errorMessage(error),'error'); } finally { button.disabled = false; }
      })); actions.append(button); card.append(actions);
    }
    list.append(card);
  });
}
function confirmAction(title, description, task) {
  confirmation = task; $('confirm-title').textContent = title; $('confirm-description').textContent = description; $('confirm-dialog').showModal();
}
function configureAuth() {
  const registering = state.registrationMode === 'invite' && state.registering;
  $('auth-title').textContent = registering ? '使用邀请码创建账户' : '登录账户'; $('auth-submit').textContent = registering ? '创建账户并登录' : '登录';
  $('auth-toggle').hidden = state.registrationMode !== 'invite'; $('auth-toggle').textContent = registering ? '返回登录' : '邀请码注册';
  $('registration-name-field').hidden = !registering; $('auth-name').required = false;
  $('registration-invitation-field').hidden = !registering; $('auth-invitation-code').required = registering;
  if (!registering) $('auth-invitation-code').value = '';
  $('auth-password').autocomplete = registering ? 'new-password' : 'current-password'; $('auth-password').minLength = registering ? 12 : 1;
  $('registration-note').textContent = state.registrationMode === 'invite' ? (registering ? '需要有效邀请码，并设置至少 12 个字符的密码。' : '已有账号可直接登录；持有管理员邀请码可创建账户。') : '当前由管理员创建账号，请向管理员获取登录信息。';
}
function takeAdminKey() {
  const key = $('admin-key').value; $('admin-key').value = '';
  if (!key) throw localError('请先输入管理员 Key；每次操作都需重新输入。');
  return key;
}
function renderAdminLists() {
  const accounts = $('admin-accounts'); const tenants = $('admin-tenants'); accounts.replaceChildren(); tenants.replaceChildren();
  state.adminAccounts.forEach(account => {
    const button = textElement('button',displayName(account) + ' · ' + account.email,'choice'); button.type = 'button';
    button.setAttribute('aria-label','选择账号 ' + account.email);
    button.addEventListener('click',() => { $('claim-account').value = account.id; accounts.querySelectorAll('button').forEach(el => el.classList.remove('active')); button.classList.add('active'); }); accounts.append(button);
  });
  state.adminTenants.forEach(tenant => {
    const owner = tenant.account_id || tenant.owner_account_id;
    const button = textElement('button',displayName(tenant) + ' · ' + tenant.id + (owner ? ' · 已有归属' : ''),'choice'); button.type = 'button';
    button.setAttribute('aria-label','选择租户 ' + displayName(tenant));
    button.addEventListener('click',() => { $('claim-tenant').value = tenant.id; $('claim-name').value = displayName(tenant); $('claim-type').value = tenant.memory_type || 'general'; tenants.querySelectorAll('button').forEach(el => el.classList.remove('active')); button.classList.add('active'); }); tenants.append(button);
  });
}
function renderInvitations() {
  const list = $('invitation-list'); list.replaceChildren();
  if (!state.invitations.length) { list.append(textElement('p','暂无邀请码。','hint')); return; }
  state.invitations.forEach(invitation => {
    const expired = invitation.expires_at && invitation.expires_at <= Date.now();
    const exhausted = invitation.uses >= invitation.max_uses; const inactive = Boolean(invitation.revoked_at || expired || exhausted);
    const card = textElement('div','','key-card'); const title = textElement('div','','key-title');
    title.append(textElement('strong',invitation.label || '未命名邀请'),textElement('span',invitation.revoked_at ? '已撤销' : expired ? '已到期' : exhausted ? '次数已用尽' : '可使用','badge' + (inactive ? '' : ' good')));
    const metadata = textElement('div','','key-meta'); metadata.append(textElement('span','前缀 ' + (invitation.prefix || '—'),'key-prefix'),textElement('span','已注册 ' + invitation.uses + ' / ' + invitation.max_uses + ' 人'));
    const dates = textElement('div','','key-meta'); dates.append(textElement('span','创建 ' + dateText(invitation.created_at)),textElement('span','到期 ' + dateText(invitation.expires_at)));
    if (invitation.revoked_at) dates.append(textElement('span','撤销 ' + dateText(invitation.revoked_at)));
    card.append(title,metadata,dates);
    if (!invitation.revoked_at) {
      const button = textElement('button','撤销邀请码','danger'); button.type = 'button'; const actions = textElement('div','','actions');
      button.addEventListener('click',() => {
        if (!$('admin-key').value) { status('invitation-status','请先输入管理员 Key，再撤销邀请码。','error'); $('admin-key').focus(); return; }
        confirmAction('撤销此邀请码？','“' + (invitation.label || '未命名邀请') + '”将不能继续注册账户，已经创建的账号保持有效。',async () => {
        button.disabled = true; status('invitation-status',''); const version = state.authVersion; const listVersion = state.invitationsVersion;
        try {
          const key = takeAdminKey(); await api('DELETE','/admin/invitations/' + encodeURIComponent(invitation.id),undefined,key);
          if (version !== state.authVersion || listVersion !== state.invitationsVersion) throw staleError();
          invitation.revoked_at = Date.now(); renderInvitations(); status('invitation-status','邀请码已撤销，已注册的账号不受影响。','success');
        } catch (error) { status('invitation-status',errorMessage(error),'error'); } finally { button.disabled = false; }
        });
      }); actions.append(button); card.append(actions);
    }
    list.append(card);
  });
}
async function loadInvitations() {
  const key = takeAdminKey(); const version = state.authVersion; const listVersion = ++state.invitationsVersion;
  const data = await api('GET','/admin/invitations',undefined,key);
  if (version !== state.authVersion || listVersion !== state.invitationsVersion || !$('admin-details').open) throw staleError();
  state.invitations = Array.isArray(data.invitations) ? data.invitations : []; renderInvitations();
  status('invitation-status','已加载 ' + state.invitations.length + ' 份邀请。','success');
}

$('auth-toggle').addEventListener('click',() => { if (state.registrationMode !== 'invite') return; clearSecret(); state.registering = !state.registering; $('auth-password').value = ''; $('auth-invitation-code').value = ''; status('auth-status',''); configureAuth(); });
$('auth-form').addEventListener('submit',event => {
  event.preventDefault(); run('auth-submit','auth-status',async () => {
    const registering = state.registrationMode === 'invite' && state.registering;
    const body = { email:$('auth-email').value.trim(), password:$('auth-password').value };
    if (registering) {
      body.invitation_code = $('auth-invitation-code').value.trim();
      if (!body.invitation_code) { body.password = ''; $('auth-password').value = ''; $('auth-invitation-code').value = ''; throw localError('请输入管理员提供的邀请码。'); }
      if ($('auth-name').value.trim()) body.display_name = $('auth-name').value.trim();
    }
    clearSecret(); $('auth-password').value = ''; $('auth-invitation-code').value = '';
    let data;
    try { data = await api('POST',registering ? '/auth/register' : '/auth/login',body); }
    catch (error) {
      if (registering && [400,403,410].includes(error.status)) throw localError('无法注册，请检查邮箱、密码和邀请码。邀请码可能已过期、撤销或次数用尽。');
      if (registering && error.status === 409) throw localError('此邮箱已注册，请返回登录或联系管理员。');
      throw error;
    }
    finally { body.password = ''; if ('invitation_code' in body) body.invitation_code = ''; }
    showAccount(data.account); await loadSpaces(); status('auth-status','');
  });
});
$('logout').addEventListener('click',() => run('logout','page-status',async () => {
  clearSecret(); closeConfirmation();
  await api('POST','/auth/logout',{}); clearAccount(); status('auth-status','已退出登录。','success');
}));
$('refresh-spaces').addEventListener('click',() => run('refresh-spaces','page-status',() => loadSpaces()));
$('refresh-keys').addEventListener('click',() => run('refresh-keys','keys-status',() => loadKeys()));
$('space-form').addEventListener('submit',event => {
  event.preventDefault(); run('space-submit','space-status',async () => {
    const data = await api('POST','/account/spaces',{ display_name:$('space-name').value.trim(), memory_type:$('space-type').value.trim() },undefined,true);
    $('space-name').value = ''; await loadSpaces(data.space.id); status('space-status','空间已创建。','success');
  });
});
$('key-form').addEventListener('submit',event => {
  event.preventDefault(); run('key-submit','key-status',async () => {
    if (state.secretIssuing) throw localError('另一份凭据正在签发，请稍后再试。');
    const space = selectedSpace(); if (!space) throw localError('请先选择空间。');
    const accountId = state.account && state.account.id; const accountVersion = state.authVersion;
    const scopes = Array.from($('key-form').querySelectorAll('input[name="scope"]:checked')).map(input => input.value);
    if (!scopes.length) throw localError('至少选择一项操作权限。');
    const expires = $('key-expiry').value ? new Date($('key-expiry').value).getTime() : null;
    if (expires !== null && (!Number.isFinite(expires) || expires <= Date.now())) throw localError('到期时间必须晚于当前时间。');
    const label = $('key-label').value.trim();
    if (new TextEncoder().encode(label).byteLength > 128) throw localError('Key 名称最多 128 字节，请缩短名称。');
    const secretVersion = state.secretVersion; state.secretIssuing = 'key'; state.keyIssuing = true; renderSpaces();
    try {
      const data = await api('POST','/account/spaces/' + encodeURIComponent(space.id) + '/keys',{ label, scopes, expires_at:expires },undefined,true);
      if (typeof data.api_key !== 'string' || !data.api_key) throw localError('已提交签发请求，但未收到完整 Key。请刷新列表并撤销后重试。');
      if (!state.account || state.account.id !== accountId || state.authVersion !== accountVersion || state.selectedId !== space.id) {
        data.api_key = ''; throw staleError();
      }
      if (document.visibilityState !== 'visible' || secretVersion !== state.secretVersion) {
        data.api_key = '';
        try { await loadKeys(); } catch { /* A later refresh can recover metadata. */ }
        throw localError('Key 已签发，但页面离开期间完整 Key 已清除。请从列表撤销，再重新签发。');
      }
      clearSecret(); $('secret-output').value = data.api_key; data.api_key = ''; $('secret-context').textContent = '空间：' + displayName(space) + ' · Key：' + label; $('secret-dialog').showModal();
      $('key-label').value = ''; $('key-expiry').value = ''; status('key-status','Key 已签发，请保存当前窗口中的完整 Key。','success');
      try { await loadKeys(); } catch (error) { status('keys-status',errorMessage(error),'error'); }
    } finally { state.secretIssuing = null; state.keyIssuing = false; renderSpaces(); }
  });
});
$('revoke-legacy').addEventListener('click',() => {
  const space = selectedSpace(); if (!space) return;
  confirmAction('停用旧租户 Key？','原 Key 将立即失效且无法恢复。请先确认应用已切换到新签发的 Key。空间内的记忆不会删除。',() => run('revoke-legacy','key-status',async () => {
    await api('POST','/account/spaces/' + encodeURIComponent(space.id) + '/revoke-legacy-key',{},undefined,true); await loadSpaces(space.id); status('key-status','旧租户 Key 已停用。','success');
  }));
});
$('copy-key').addEventListener('click',() => run('copy-key','secret-status',async () => {
  const key = $('secret-output').value; if (!key) return;
  try { await navigator.clipboard.writeText(key); if ($('secret-dialog').open) status('secret-status','已复制。请保存到安全位置。','success'); }
  catch { $('secret-output').focus(); $('secret-output').select(); status('secret-status','浏览器未允许复制，已选中 Key，请手动复制。','error'); }
}));
$('close-secret').addEventListener('click',clearSecret);
$('secret-dialog').addEventListener('close',wipeKeyDialog);
$('secret-dialog').addEventListener('cancel',event => { event.preventDefault(); clearSecret(); });
$('close-invitation-secret').addEventListener('click',clearSecret);
$('invitation-secret-dialog').addEventListener('close',wipeInvitationDialog);
$('invitation-secret-dialog').addEventListener('cancel',event => { event.preventDefault(); clearSecret(); });
$('confirm-cancel').addEventListener('click',closeConfirmation);
$('confirm-dialog').addEventListener('close',() => { confirmation = null; });
$('confirm-dialog').addEventListener('cancel',event => { event.preventDefault(); closeConfirmation(); });
$('confirm-action').addEventListener('click',() => { const task = confirmation; closeConfirmation(); if (task) Promise.resolve().then(task).catch(error => status('page-status',errorMessage(error),'error')); });
document.addEventListener('visibilitychange',() => { if (document.visibilityState === 'hidden') { clearSecret(); $('admin-key').value = ''; $('auth-password').value = ''; $('admin-password').value = ''; $('auth-invitation-code').value = ''; } });
window.addEventListener('pagehide',() => { clearSecret(); $('admin-key').value = ''; $('auth-password').value = ''; $('admin-password').value = ''; $('auth-invitation-code').value = ''; closeConfirmation(); });
$('admin-details').addEventListener('toggle',() => { if (!$('admin-details').open) { clearSecret(); clearInvitations(); closeConfirmation(); $('admin-key').value = ''; $('admin-password').value = ''; } });
$('invitation-load').addEventListener('click',() => run('invitation-load','invitation-status',loadInvitations));
$('admin-invitation-form').addEventListener('submit',event => {
  event.preventDefault(); run('invitation-create','invitation-status',async () => {
    if (state.secretIssuing) throw localError('另一份凭据正在签发，请稍后再试。');
    const label = $('invitation-label').value.trim();
    if (!label || new TextEncoder().encode(label).byteLength > 128) throw localError('请输入邀请名称，最多 128 字节。');
    const maxUses = Number($('invitation-max-uses').value || '1');
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1000) throw localError('最多注册人数必须是 1 至 1000 的整数。');
    const expiresAt = $('invitation-expiry').value ? new Date($('invitation-expiry').value).getTime() : null;
    if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) throw localError('到期时间必须晚于当前时间。');
    const key = takeAdminKey(); const authVersion = state.authVersion; const secretVersion = state.secretVersion; const listVersion = state.invitationsVersion;
    state.secretIssuing = 'invitation';
    try {
      const data = await api('POST','/admin/invitations',{ label, max_uses:maxUses, expires_at:expiresAt },key);
      if (authVersion !== state.authVersion) { scrubCredentials(data); throw staleError(); }
      if (document.visibilityState !== 'visible' || secretVersion !== state.secretVersion || listVersion !== state.invitationsVersion || !$('admin-details').open) {
        scrubCredentials(data);
        throw localError('邀请码已创建，但页面或登录状态已变化，完整邀请码已清除。请加载列表、撤销此邀请后重新创建。');
      }
      if (!data.invitation || typeof data.invitation_code !== 'string' || !data.invitation_code) {
        scrubCredentials(data); throw localError('已提交创建请求，但未收到完整邀请码。请加载列表、撤销后重试。');
      }
      clearSecret(); $('invitation-secret-output').value = data.invitation_code; scrubCredentials(data);
      $('invitation-secret-context').textContent = '邀请：' + data.invitation.label + ' · 最多 ' + data.invitation.max_uses + ' 人 · 到期：' + dateText(data.invitation.expires_at);
      $('invitation-secret-dialog').showModal();
      state.invitations = [data.invitation,...state.invitations.filter(invitation => invitation.id !== data.invitation.id)]; renderInvitations();
      $('invitation-label').value = ''; $('invitation-max-uses').value = '1'; $('invitation-expiry').value = '';
      status('invitation-status','邀请码已创建，请保存当前窗口中的完整邀请码。','success');
    } finally { state.secretIssuing = null; }
  });
});
$('admin-load').addEventListener('click',() => run('admin-load','admin-status',async () => {
  const key = takeAdminKey();
  const results = await Promise.allSettled([api('GET','/admin/accounts',undefined,key),api('GET','/admin/tenants',undefined,key)]);
  if (results[0].status === 'fulfilled') state.adminAccounts = results[0].value.accounts || [];
  if (results[1].status === 'fulfilled') state.adminTenants = results[1].value.tenants || [];
  renderAdminLists(); const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  status('admin-status','已加载 ' + state.adminAccounts.length + ' 个账号与 ' + state.adminTenants.length + ' 个租户。','success');
}));
$('admin-account-form').addEventListener('submit',event => {
  event.preventDefault(); run('admin-create','admin-account-status',async () => {
    const key = takeAdminKey(); const body = { email:$('admin-email').value.trim(), display_name:$('admin-name').value.trim(), password:$('admin-password').value }; $('admin-password').value = '';
    let data; try { data = await api('POST','/admin/accounts',body,key); } finally { body.password = ''; }
    $('admin-name').value = ''; $('admin-email').value = ''; $('claim-account').value = data.account.id;
    state.adminAccounts.push(data.account); renderAdminLists(); status('admin-account-status','账号已创建：' + data.account.email + '。可在右侧绑定旧租户。','success');
  });
});
$('admin-claim-form').addEventListener('submit',event => {
  event.preventDefault(); run('admin-claim','admin-claim-status',async () => {
    const key = takeAdminKey(); const accountId = $('claim-account').value.trim(); const tenantId = $('claim-tenant').value.trim(); const body = {};
    if ($('claim-name').value.trim()) body.display_name = $('claim-name').value.trim(); if ($('claim-type').value.trim()) body.memory_type = $('claim-type').value.trim();
    const data = await api('POST','/admin/accounts/' + encodeURIComponent(accountId) + '/spaces/' + encodeURIComponent(tenantId) + '/claim',body,key);
    status('admin-claim-status','已绑定空间“' + displayName(data.space) + '”。原租户 Key 仍按当前状态生效。','success');
    if (state.account && state.account.id === accountId) await loadSpaces(data.space.id);
  });
});
$('admin-revoke-legacy').addEventListener('click',() => {
  const tenantId = $('claim-tenant').value.trim();
  if (!tenantId) { status('admin-claim-status','请先选择或输入旧租户 ID。','error'); return; }
  confirmAction('停用所选租户的旧 Key？','租户 ' + tenantId + ' 的原 Key 将立即失效且无法恢复。请先确认使用该 Key 的应用已完成切换。',() => run('admin-revoke-legacy','admin-claim-status',async () => {
    const key = takeAdminKey();
    await api('POST','/admin/tenants/' + encodeURIComponent(tenantId) + '/revoke-legacy-key',{},key);
    status('admin-claim-status','所选租户的旧 Key 已停用。','success');
    if (state.spaces.some(space => space.id === tenantId)) await loadSpaces(tenantId);
  }));
});
async function initialize() {
  const version = state.authVersion;
  const results = await Promise.allSettled([api('GET','/auth/config'),api('GET','/auth/me')]);
  if (results[0].status === 'fulfilled') state.registrationMode = results[0].value.registration_mode === 'invite' ? 'invite' : 'admin';
  configureAuth();
  if (version !== state.authVersion) return;
  if (results[1].status === 'fulfilled' && results[1].value.account) {
    showAccount(results[1].value.account);
    try { await loadSpaces(); } catch (error) { status('page-status',errorMessage(error),'error'); }
  } else if (results[1].status === 'rejected' && results[1].reason.status !== 401) status('page-status',errorMessage(results[1].reason),'error');
  if (results[0].status === 'rejected') status('auth-status','暂时无法读取注册设置，请稍后重试。','error');
}
initialize().catch(error => status('page-status',errorMessage(error),'error'));
</script>
</body>
</html>`;
}
