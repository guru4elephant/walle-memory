/** OAuth consent UI. Request metadata and session credentials are never embedded in HTML. */
export function getOAuthAuthorizeHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="referrer" content="no-referrer">
<title>连接记忆空间 · walle-memory</title>
<style>
:root { color-scheme:light; --bg:#f5f6f9; --text:#192334; --muted:#677287; --line:#e4e8ef; --accent:#3758ce; --danger:#ac2839; }
* { box-sizing:border-box; } [hidden] { display:none !important; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
main { max-width:640px; margin:auto; padding:40px 20px; }
.brand { color:var(--accent); font-weight:700; margin-bottom:18px; } .card { background:#fff; border:1px solid var(--line); border-radius:16px; padding:28px; }
h1,h2,p { margin:0; } h1 { font-size:26px; line-height:1.3; } h2 { font-size:17px; margin-top:24px; }
.muted,.hint { color:var(--muted); } .hint { font-size:13px; margin-top:7px; } .intro { margin-top:10px; }
.field { margin-top:18px; } label { display:block; font-weight:600; margin-bottom:6px; }
button,input,select { font:inherit; } input,select { width:100%; min-width:0; border:1px solid #ced5e1; border-radius:8px; padding:10px; background:#fff; color:var(--text); }
.workspace-choice { display:flex; gap:10px; align-items:center; padding:12px; border:1px solid var(--line); border-radius:9px; margin:8px 0; font-weight:400; } .workspace-choice input { width:18px; height:18px; flex:none; }
input:focus,select:focus { outline:2px solid #c4cff9; border-color:var(--accent); }
button { border:1px solid var(--line); background:#fff; border-radius:8px; padding:10px 16px; cursor:pointer; color:var(--text); }
button.primary { background:var(--accent); border-color:var(--accent); color:white; } button:disabled { opacity:.55; cursor:wait; }
button:focus-visible,a:focus-visible { outline:3px solid #a0b2f4; outline-offset:3px; }
.actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:24px; } a { color:var(--accent); text-underline-offset:3px; }
.notice { padding:13px 15px; background:#f5f7ff; border:1px solid #e0e6fb; border-radius:10px; margin-top:18px; font-size:13px; }
dl { margin:18px 0 0; } dt { font-size:12px; color:var(--muted); margin-top:11px; } dd { margin:0; overflow-wrap:anywhere; }
code { font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace; overflow-wrap:anywhere; }
ul { margin:10px 0 0; padding-left:21px; } li { margin:5px 0; }
.status { overflow-wrap:anywhere; margin-top:16px; color:var(--danger); } .status:empty { display:none; }
.footer { margin-top:20px; text-align:center; font-size:13px; }
@media(max-width:480px) { main { padding:24px 14px; } .card { padding:22px 18px; } h1 { font-size:23px; } .actions button { flex:1; } }
</style>
</head>
<body>
<main>
  <div class="brand">walle-memory</div>
  <section class="card" aria-labelledby="page-title">
    <h1 id="page-title">连接记忆空间</h1>
    <p class="intro muted">登录后，选择要授权给应用的空间并确认操作权限。</p>
    <p id="loading" class="hint" role="status">正在检查授权请求…</p>
    <section id="login-section" hidden>
      <h2>登录 Walle Memory 账户</h2>
      <p class="hint">使用你在此服务的账户。登录本身不会向应用授予权限。</p>
      <form id="login-form">
        <div class="field"><label for="email">邮箱</label><input id="email" type="email" autocomplete="username" required maxlength="254"></div>
        <div class="field"><label for="password">密码</label><input id="password" type="password" autocomplete="current-password" required maxlength="256"></div>
        <div class="actions"><button id="login-submit" type="submit" class="primary">登录并查看授权</button></div>
      </form>
      <p class="hint">还没有账户？请向管理员申请，或在<a href="/account" target="_blank" rel="noopener noreferrer">账户页</a>使用邀请码注册，再返回这里登录。</p>
    </section>
    <section id="consent-section" hidden>
      <h2><span id="client-name"></span> 请求连接</h2>
      <p class="hint">应用名称由注册方自行填写，并非身份认证标记。仅批准你刚刚发起的连接。</p>
      <dl><dt>应用标识</dt><dd><code id="client-id"></code></dd><dt>授权结果返回地址</dt><dd><code id="redirect-uri"></code></dd><dt>登录账户</dt><dd id="account-name"></dd><dt>访问服务</dt><dd><code id="resource"></code></dd></dl>
      <h2>允许的操作</h2><ul id="scope-list"></ul>
      <form id="consent-form">
        <div class="field"><label>授权哪些 workspace？</label><div id="space-choices" role="group" aria-label="选择授权空间"></div><p class="hint">请明确勾选一个或多个空间。以后新增空间需要重新授权，不会自动开放。</p></div><div class="field"><label for="space">默认 workspace</label><select id="space" required><option value="">请选择一个空间</option></select><p class="hint">连接后可在这些已勾选的 workspace 之间切换；未勾选的空间无法访问。默认空间用于未指定目标的旧调用。</p></div>
        <p id="no-spaces" class="notice" hidden>当前没有可用空间。请先在<a href="/account" target="_blank" rel="noopener noreferrer">账户页</a>创建空间，再重新加载此页。</p>
        <p class="notice">连接可自动续期，无需反复输入 API Key。连续 30 天未刷新或授权满 90 天后需要重新连接；你可随时在账户页的“已连接应用”中撤销。短期访问令牌有效期为 10 分钟。</p>
        <div class="actions"><button id="approve" class="primary" type="submit" disabled>允许连接</button><button id="deny" type="button">拒绝</button></div>
      </form>
    </section>
    <p id="status" class="status" role="alert" aria-live="polite"></p>
    <div id="retry-actions" class="actions" hidden><button id="retry" type="button">重新加载授权请求</button></div>
  </section>
  <p class="footer"><a href="/account" target="_blank" rel="noopener noreferrer">管理账户与已连接应用 ↗</a></p>
</main>
<script>
'use strict';
const $ = id => document.getElementById(id);
const scopeNames = { 'memory:read':'读取与检索记忆', 'memory:write':'新建和更新记忆', 'memory:delete':'删除记忆', 'memory:gc':'清理已到期的记忆', offline_access:'自动续期连接（可随时撤销）' };
let consent = null;
let selectedWorkspaces = new Set();
let generation = 0;
let submitting = false;
function setStatus(message) { $('status').textContent = message || ''; }
function failMessage(error) {
  return ({ 400:'授权请求无效或已失效。请从应用重新发起连接。', 401:'登录状态已过期，请重新登录。', 403:'无法批准此授权。请确认账户与空间仍然可用，并从应用重新连接。', 404:'授权请求或空间不存在，请从应用重新连接。', 409:'此授权请求已处理，请返回应用检查连接状态。', 410:'授权请求已过期，请从应用重新连接。', 429:'请求过于频繁，请稍后重试。', 503:'OAuth 连接尚未配置，请联系服务管理员。' })[error && error.status] || '连接中断，未能确认操作结果。请返回应用检查；需要时重新发起连接。';
}
function resetConsent() {
  consent = null; selectedWorkspaces.clear(); $('space-choices').replaceChildren(); $('consent-section').hidden = true; $('approve').disabled = true;
  ['client-name','client-id','redirect-uri','account-name','resource'].forEach(id => { $(id).textContent = ''; });
  $('scope-list').replaceChildren(); $('space').replaceChildren();
  const option = document.createElement('option'); option.value = ''; option.textContent = '请选择一个空间'; $('space').append(option);
}
async function request(path, method, body) {
  const headers = { Accept:'application/json', 'X-Walle-OAuth':'1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { method, headers, credentials:'same-origin', cache:'no-store', redirect:'error', body:body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) { const error = new Error('request failed'); error.status = response.status; throw error; }
  return response.json();
}
function renderConsent(data) {
  if (!data || typeof data.request_id !== 'string' || typeof data.csrf_token !== 'string' || !data.client || !Array.isArray(data.spaces) || !Array.isArray(data.scopes)) throw new Error('invalid response');
  consent = data;
  $('client-name').textContent = data.client.client_name || '未命名应用';
  $('client-id').textContent = data.client.client_id;
  $('redirect-uri').textContent = data.redirect_uri || '';
  $('resource').textContent = data.resource;
  $('account-name').textContent = data.account ? data.account.email : '';
  data.scopes.forEach(scope => { const item = document.createElement('li'); item.textContent = scopeNames[scope] || scope; $('scope-list').append(item); });
  data.spaces.forEach(space => {
    const label = document.createElement('label'); label.className = 'workspace-choice';
    const box = document.createElement('input'); box.type='checkbox'; box.value=space.id;
    box.addEventListener('change',()=>toggleWorkspace(space.id,box.checked));
    const name=document.createElement('span'); name.textContent=(space.display_name || space.name || space.id) + ' · ' + (space.memory_type || 'general');
    label.append(box,name); $('space-choices').append(label);
  });
  data.spaces.forEach(space => { const option = document.createElement('option'); option.value = space.id; option.textContent = (space.display_name || space.name || space.id) + ' · ' + (space.memory_type || 'general'); $('space').append(option); });
  $('space').value = ''; $('no-spaces').hidden = data.spaces.length > 0; $('space').disabled = data.spaces.length === 0;
  $('approve').disabled = true; $('login-section').hidden = true; $('consent-section').hidden = false;
}
async function loadContext() {
  const version = ++generation; resetConsent(); setStatus(''); $('loading').hidden = false; $('retry-actions').hidden = true; $('login-section').hidden = true;
  try {
    const data = await request('/oauth/authorize/context' + window.location.search,'GET');
    if (version !== generation) return;
    renderConsent(data);
  } catch (error) {
    if (version !== generation) return;
    if (error.status === 401) $('login-section').hidden = false;
    else { setStatus(failMessage(error)); $('retry-actions').hidden = false; }
  } finally { if (version === generation) $('loading').hidden = true; }
}
$('login-form').addEventListener('submit',async event => {
  event.preventDefault(); if (submitting) return; submitting = true; $('login-submit').disabled = true; setStatus('');
  const version = generation; const body = { email:$('email').value.trim(), password:$('password').value }; $('password').value = '';
  try { await request('/auth/login','POST',body); if (version === generation) await loadContext(); }
  catch (error) { if (version === generation) setStatus(error.status === 401 ? '邮箱或密码不正确，或账户不可用。' : failMessage(error)); }
  finally { body.password = ''; submitting = false; $('login-submit').disabled = false; }
});
function toggleWorkspace(id,checked) {
  if (!consent || !consent.spaces.some(space=>space.id===id) || submitting) return;
  if (checked) selectedWorkspaces.add(id); else selectedWorkspaces.delete(id);
  if (!selectedWorkspaces.has($('space').value)) $('space').value=selectedWorkspaces.values().next().value || '';
  updateApprove();
}
function updateApprove() { $('approve').disabled=submitting || !consent || selectedWorkspaces.size===0 || !selectedWorkspaces.has($('space').value); }
$('space').addEventListener('change',updateApprove);
async function decide(approve) {
  if (submitting || !consent) return;
  const spaceId = $('space').value;
  if (approve && (selectedWorkspaces.size===0 || !selectedWorkspaces.has(spaceId))) { setStatus('请勾选要授权的 workspace，并选择其中一个作为默认空间。'); return; }
  submitting = true; $('approve').disabled = true; $('deny').disabled = true; $('space').disabled = true; setStatus('');
  const version = generation; const body = { request_id:consent.request_id, csrf_token:consent.csrf_token, space_ids:[...selectedWorkspaces], default_space_id:spaceId, approve };
  // A consent attempt is never automatically replayed after an ambiguous network response.
  consent = null;
  try {
    const data = await request('/oauth/authorize','POST',body);
    if (version !== generation) return;
    const target = new URL(data.redirect_to);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(target.hostname))) throw new Error('invalid redirect');
    window.location.assign(target.href);
  } catch (error) {
    if (version !== generation) return;
    resetConsent(); setStatus(failMessage(error));
    if (error.status === 401) $('login-section').hidden = false;
    else $('retry-actions').hidden = false;
  } finally { body.csrf_token = ''; submitting = false; $('deny').disabled = false; }
}
$('consent-form').addEventListener('submit',event => { event.preventDefault(); decide(true); });
$('deny').addEventListener('click',() => decide(false));
$('retry').addEventListener('click',loadContext);
window.addEventListener('pagehide',() => { generation++; resetConsent(); $('password').value = ''; });
window.addEventListener('pageshow',event => { if (event.persisted) loadContext(); });
loadContext();
</script>
</body>
</html>`;
}
