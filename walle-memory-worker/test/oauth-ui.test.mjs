import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { getOAuthAuthorizeHtml } from '../src/oauth-ui.ts';
import { getAccountDashboardHtml } from '../src/account-dashboard.ts';

const scriptOf = html => html.match(/<script>([\s\S]*?)<\/script>/)[1];
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
const consentData = (suffix = 'one') => ({
  request_id: 'request-' + suffix, csrf_token: 'synthetic-csrf-' + suffix,
  client: { client_id: 'client-' + suffix, client_name: 'Local test application' },
  account: { id: 'local-account', email: 'local@example.invalid' },
  redirect_uri: 'https://client.example.invalid/callback', resource: 'https://memory.example.invalid/mcp',
  scopes: ['memory:read', 'memory:write', 'offline_access'],
  spaces: [{ id: 'space-' + suffix, display_name: 'Disposable space' }],
});

function browser(html, handler, search = '?client_id=local&state=preserve-me') {
  const elements = new Map(); const events = {}; const calls = []; const redirects = [];
  let sequence = 0;
  const element = id => {
    if (!elements.has(id)) {
      const item = {
        id, value: '', textContent: '', className: '', disabled: false, hidden: false, open: false, children: [], listeners: {},
        addEventListener(type, listener) { this.listeners[type] = listener; },
        append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
        setAttribute() {}, querySelectorAll() { return []; }, focus() {},
        showModal() { this.open = true; }, close() { this.open = false; }, classList: { add() {}, remove() {} },
      };
      Object.defineProperty(item, 'innerHTML', { set() { throw new Error('Untrusted HTML insertion'); } });
      elements.set(id, item);
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, createElement: tag => element('created-' + tag + '-' + sequence++), addEventListener() {}, visibilityState: 'visible' },
    window: { location: { search, assign: value => redirects.push(value) }, addEventListener: (name, callback) => { events[name] = callback; } },
    fetch: (path, options) => { calls.push({ path, options }); return handler(path, options, calls.length); },
    navigator: { clipboard: { writeText: async () => {} } }, URL, TextEncoder, setTimeout, clearTimeout,
  });
  new vm.Script(scriptOf(html)).runInContext(context);
  return { context, element, elements, events, calls, redirects };
}

test('OAuth and account HTML scripts parse and use unique element IDs', () => {
  for (const html of [getOAuthAuthorizeHtml(), getAccountDashboardHtml()]) {
    new vm.Script(scriptOf(html));
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    assert.doesNotMatch(scriptOf(html), /localStorage|sessionStorage|\.innerHTML\s*=/);
  }
});

test('consent requires an explicit space and renders client metadata as text', async () => {
  const data = consentData();
  const malicious = '<img src=x onerror=alert(1)>';
  data.client.client_name = malicious; data.spaces[0].display_name = malicious;
  const ui = browser(getOAuthAuthorizeHtml(), async (path, options) => path.startsWith('/oauth/authorize/context') ? response(data) : response({ redirect_to: data.redirect_uri + '?code=synthetic' }));
  await settle();
  assert.equal(ui.element('client-name').textContent, malicious);
  assert.equal(ui.element('redirect-uri').textContent, data.redirect_uri);
  assert.equal(ui.element('scope-list').children[0].textContent, '读取与检索记忆');
  assert.equal(ui.element('scope-list').children[2].textContent, '自动续期连接（可随时撤销）');
  assert.equal(ui.element('space').children[1].textContent, malicious + ' · general');
  assert.equal(ui.element('space').value, '');
  assert.equal(ui.element('approve').disabled, true);
  assert.equal(ui.calls[0].options.headers['X-Walle-OAuth'], '1');
  assert.equal(ui.calls[0].path, '/oauth/authorize/context?client_id=local&state=preserve-me');
  await ui.context.decide(true);
  assert.equal(ui.calls.length, 1, 'programmatic submission cannot bypass selection');
  ui.element('space').value = 'other-space';
  await ui.context.decide(true);
  assert.equal(ui.calls.length, 1, 'unlisted space cannot be submitted');
  ui.context.toggleWorkspace('space-one',true); ui.element('space').listeners.change();
  assert.equal(ui.element('approve').disabled, false);
  await ui.context.decide(true);
  const approval = ui.calls[1];
  assert.equal(approval.path, '/oauth/authorize');
  assert.deepEqual(JSON.parse(approval.options.body), { request_id: data.request_id, csrf_token: data.csrf_token, space_ids: ['space-one'], default_space_id:'space-one', approve: true });
  assert.equal(approval.options.credentials, 'same-origin');
  assert.equal(approval.options.redirect, 'error');
  assert.equal(approval.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(ui.redirects, [data.redirect_uri + '?code=synthetic']);
});

test('login clears the password before the network response and requires later consent', async () => {
  const pendingLogin = deferred(); let contextCalls = 0;
  const ui = browser(getOAuthAuthorizeHtml(), async path => {
    if (path === '/auth/login') return pendingLogin.promise;
    return ++contextCalls === 1 ? response({}, 401) : response(consentData());
  });
  await settle(); assert.equal(ui.element('login-section').hidden, false);
  ui.element('email').value = 'local@example.invalid'; ui.element('password').value = 'synthetic-local-password';
  const submit = ui.element('login-form').listeners.submit({ preventDefault() {} });
  assert.equal(ui.element('password').value, '');
  assert.equal(ui.element('login-submit').disabled, true);
  assert.equal(ui.calls[1].path, '/auth/login');
  pendingLogin.resolve(response({ account: { id: 'local-account' } })); await submit;
  assert.equal(ui.element('login-section').hidden, true);
  assert.equal(ui.element('consent-section').hidden, false);
  assert.equal(ui.element('approve').disabled, true);
  assert.equal(ui.calls.filter(call => call.path === '/oauth/authorize').length, 0);
});

test('denial works without a space and failed consent is not automatically replayed', async () => {
  const data = consentData(); data.spaces = [];
  const ui = browser(getOAuthAuthorizeHtml(), async path => path.startsWith('/oauth/authorize/context') ? response(data) : response({}, 409));
  await settle();
  assert.equal(ui.element('no-spaces').hidden, false);
  await ui.context.decide(false);
  assert.deepEqual(JSON.parse(ui.calls[1].options.body), { request_id: data.request_id, csrf_token: data.csrf_token, space_ids: [], default_space_id:'', approve: false });
  await ui.context.decide(false);
  assert.equal(ui.calls.length, 2, 'a consumed or uncertain request is never silently replayed');
  assert.equal(ui.element('consent-section').hidden, true);
  assert.equal(ui.element('retry-actions').hidden, false);
  assert.deepEqual(ui.redirects, []);
});

test('a newer context supersedes delayed metadata and leaving clears pending consent', async () => {
  const first = deferred(); let count = 0;
  const ui = browser(getOAuthAuthorizeHtml(), async () => ++count === 1 ? first.promise : response(consentData('new')));
  await ui.context.loadContext();
  first.resolve(response(consentData('old'))); await settle();
  assert.equal(ui.element('client-id').textContent, 'client-new');
  ui.element('password').value = 'synthetic-local-password'; ui.events.pagehide();
  assert.equal(ui.element('password').value, '');
  assert.equal(ui.element('client-id').textContent, '');
  assert.equal(ui.element('consent-section').hidden, true);
  await ui.context.decide(false);
  assert.equal(ui.calls.length, 2);
});

test('leaving while context is pending never restores consent from its response', async () => {
  const pending = deferred(); const ui = browser(getOAuthAuthorizeHtml(), () => pending.promise);
  ui.events.pagehide(); pending.resolve(response(consentData())); await settle();
  assert.equal(ui.element('consent-section').hidden, true);
  assert.equal(ui.element('client-id').textContent, '');
});

test('OAuth UI refuses executable redirect schemes returned in malformed responses', async () => {
  const ui = browser(getOAuthAuthorizeHtml(), async path => path.startsWith('/oauth/authorize/context') ? response(consentData()) : response({ redirect_to: 'javascript:alert(1)' }));
  await settle(); await ui.context.decide(false);
  assert.deepEqual(ui.redirects, []);
  assert.equal(ui.element('retry-actions').hidden, false);
});

test('connected apps render safely and revoke only the chosen grant with a JSON mutation', async () => {
  const connection = { id: 'grant-one', client_id: 'client-one', client_name: '<script>untrusted</script>', space_id: 'space-one', space_display_name: 'Local space', scopes: ['memory:read'], created_at: Date.now(), expires_at: Date.now() + 60000, idle_expires_at: Date.now() + 30000, revoked_at: null };
  const ui = browser(getAccountDashboardHtml(), async (path, options) => {
    if (path === '/auth/config' || path === '/auth/me') return new Promise(() => {});
    if (path === '/account/connections' && options.method === 'GET') return response({ connections: [connection] });
    if (path === '/account/connections/grant-one' && options.method === 'DELETE') { connection.revoked_at = Date.now(); return response({ ok: true }); }
    throw new Error('Unexpected UI request');
  });
  ui.context.showAccount({ id: 'local-account', email: 'local@example.invalid' });
  await ui.context.loadConnections();
  const card = ui.element('connection-list').children[0];
  assert.equal(card.children[0].children[0].textContent, connection.client_name);
  assert.equal(card.children[1].children[1].textContent, '权限 读取');
  card.children[4].children[0].listeners.click();
  assert.equal(ui.element('confirm-dialog').open, true);
  ui.element('confirm-action').listeners.click(); await settle();
  const mutation = ui.calls.find(call => call.options.method === 'DELETE');
  assert.equal(mutation.path, '/account/connections/grant-one');
  assert.equal(mutation.options.headers['Content-Type'], 'application/json');
  assert.equal(mutation.options.credentials, 'same-origin');
  assert.equal(ui.element('connection-list').children[0].children[0].children[1].textContent, '已撤销');
});

test('connected app metadata arriving after logout is discarded', async () => {
  const pending = deferred(); const ui = browser(getAccountDashboardHtml(), async path => {
    if (path === '/auth/config' || path === '/auth/me') return new Promise(() => {});
    if (path === '/account/connections') return pending.promise;
    throw new Error('Unexpected UI request');
  });
  ui.context.showAccount({ id: 'local-account', email: 'local@example.invalid' });
  const load = ui.context.loadConnections(); ui.context.clearAccount();
  pending.resolve(response({ connections: [{ id: 'old-grant', client_name: 'Old account app' }] }));
  await assert.rejects(load, error => error.stale === true);
  assert.equal(ui.element('connection-list').children.length, 0);
  assert.equal(ui.element('account-section').hidden, true);
});

test('OAuth UI explicitly selects multiple workspaces and sends a selected default only',async()=>{
 const data=consentData();data.spaces.push({id:'space-two',display_name:'Second space'});
 const ui=browser(getOAuthAuthorizeHtml(),async path=>path.startsWith('/oauth/authorize/context')?response(data):response({redirect_to:data.redirect_uri}));
 await settle();
 assert.equal(ui.element('space-choices').children.length,2);
 ui.context.toggleWorkspace('space-one',true);ui.context.toggleWorkspace('space-two',true);
 ui.element('space').value='space-two';ui.element('space').listeners.change();
 assert.equal(ui.element('approve').disabled,false);
 await ui.context.decide(true);
 assert.deepEqual(JSON.parse(ui.calls[1].options.body),{request_id:data.request_id,csrf_token:data.csrf_token,space_ids:['space-one','space-two'],default_space_id:'space-two',approve:true});
});
