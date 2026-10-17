import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Disposable, in-memory D1 only. No real account, API key, OAuth credential,
// browser session, Cloudflare configuration, or external network is used.
const BASE = 'http://localhost';
const RESOURCE = BASE + '/mcp';
const REDIRECT = 'https://client.example.invalid/callback';
const ADMIN = 'oauth-tests-disposable-admin-key';
const PASSWORD = 'oauth-tests-disposable-password-2026';
const SCOPES = ['memory:read', 'memory:write', 'memory:delete', 'memory:gc'];
const digest = value => createHash('sha256').update(value).digest('hex');
const pkce = () => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
let mf, db, client, otherClient, legacySnapshot, legacyKey, scopedSnapshot;
let nextId = 0;
let rpcId = 0;

async function request(path, options = {}) {
  const { method = 'GET', key, cookie, token, body, form, raw, origin, headers = {}, base = BASE } = options;
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return mf.dispatchFetch(base + path, {
    method,
    headers: {
      'CF-Connecting-IP': `192.0.2.${(++nextId % 240) + 1}`,
      ...(key ? { 'X-Api-Key': key } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(form !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' }
        : body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(origin === null ? {} : origin !== undefined ? { Origin: origin } : mutation ? { Origin: base } : {}),
      ...headers,
    },
    body: raw ?? (form !== undefined ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body)),
    redirect: 'manual',
  });
}
async function parsed(response, status = 200, label = 'request succeeds') {
  assert.equal(response.status, status, label);
  return response.json();
}
async function error(response, status, expected) {
  assert.equal(response.status, status);
  const result = await response.json();
  if (expected) assert.equal(result.error, expected);
  assert.equal('access_token' in result || 'refresh_token' in result, false, 'errors never issue tokens');
  return result;
}
async function account(label = 'owner') {
  const email = `${label}-${++nextId}@example.invalid`;
  const created = await parsed(await request('/admin/accounts', { method: 'POST', key: ADMIN,
    body: { email, display_name: label, password: PASSWORD } }), 201);
  const login = await request('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return { ...created.account, email, cookie };
}
async function space(owner, name = 'OAuth test space') {
  return (await parsed(await request('/account/spaces', { method: 'POST', cookie: owner.cookie,
    body: { display_name: name, memory_type: 'general' } }), 201)).space;
}
async function register(extra = {}) {
  return parsed(await request('/oauth/register', { method: 'POST', origin: null, body: {
    client_name: 'Disposable test client', redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra,
  } }), 201);
}
function authParams(clientInfo = client, proof = pkce(), extra = {}) {
  return { proof, params: {
    client_id: clientInfo.client_id, redirect_uri: clientInfo.redirect_uris[0], response_type: 'code', resource: RESOURCE,
    scope: SCOPES.join(' '), state: 'opaque-client-state-' + ++nextId,
    code_challenge_method: 'S256', code_challenge: proof.challenge, ...extra,
  } };
}
async function context(owner, options = {}) {
  const c = options.client ?? client;
  const { proof, params } = authParams(c, options.proof, options.params);
  const response = await request('/oauth/authorize/context?' + new URLSearchParams(params), {
    cookie: owner.cookie, origin: BASE, ...options.request,
  });
  return { proof, params, client: c, context: await parsed(response), owner };
}
function approve(pending, target, extras = {}, requestOptions = {}) {
  return request('/oauth/authorize', { method: 'POST', cookie: pending.owner.cookie,
    body: { request_id: pending.context.request_id, csrf_token: pending.context.csrf_token, space_id: target.id, approve: true, ...extras },
    ...requestOptions,
  });
}
async function authorizationCode(owner, target, options = {}) {
  const pending = await context(owner, options);
  const decision = await parsed(await approve(pending, target));
  const callback = new URL(decision.redirect_to);
  assert.equal(callback.origin + callback.pathname, new URL(pending.params.redirect_uri).origin + new URL(pending.params.redirect_uri).pathname);
  assert.equal(callback.searchParams.get('state'), pending.params.state);
  assert.equal(callback.searchParams.get('iss'), BASE);
  const code = callback.searchParams.get('code');
  assert.ok(code);
  return { ...pending, code, target };
}
function exchange(code, extra = {}, options = {}) {
  return request('/oauth/token', { method: 'POST', origin: null, form: {
    grant_type: 'authorization_code', code: code.code, code_verifier: code.proof.verifier,
    client_id: code.client.client_id, redirect_uri: code.params.redirect_uri, resource: RESOURCE, ...extra,
  }, ...options });
}
function refresh(grant, extra = {}, options = {}) {
  return request('/oauth/token', { method: 'POST', origin: null, form: {
    grant_type: 'refresh_token', refresh_token: grant.refresh_token, client_id: grant.client.client_id, resource: RESOURCE, ...extra,
  }, ...options });
}
async function fixture(options = {}) {
  const owner = options.owner ?? await account();
  const target = options.target ?? await space(owner);
  const code = await authorizationCode(owner, target, options);
  const tokens = await parsed(await exchange(code));
  const row = await db.prepare('SELECT grant_id FROM oauth_access_tokens WHERE token_hash=?').bind(digest(tokens.access_token)).first();
  assert.ok(row);
  return { ...code, ...tokens, grantId: row.grant_id };
}
function rpc(token, method, params = {}, options = {}) {
  return request('/mcp', { method: 'POST', token, origin: null,
    headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...options.headers },
    body: { jsonrpc: '2.0', id: ++rpcId, method, params }, ...options,
  });
}
async function rpcResult(response) {
  assert.equal(response.status, 200);
  const text = await response.text();
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: ')).slice(6)) : JSON.parse(text);
  assert.equal(payload.jsonrpc, '2.0');
  return payload;
}
async function tool(grant, name, args = {}, options = {}) {
  return rpcResult(await rpc(grant.access_token, 'tools/call', { name, arguments: args }, options));
}
function toolValue(result) {
  assert.equal(result.error, undefined, 'RPC succeeds');
  assert.notEqual(result.result?.isError, true, 'tool succeeds');
  assert.ok(result.result?.structuredContent, 'tool includes machine-readable structured content');
  assert.deepEqual(JSON.parse(result.result.content.find(item => item.type === 'text').text), result.result.structuredContent);
  return result.result.structuredContent;
}
function toolDenied(result, challenge) {
  assert.ok(result.error || result.result?.isError, 'forbidden tool request returns an error');
  if (challenge) assert.match(JSON.stringify(result.result?._meta?.['mcp/www_authenticate']), challenge);
}
async function revoke(grant, options = {}) {
  return request('/account/connections/' + grant.grantId, { method: 'DELETE', cookie: grant.owner.cookie, ...options });
}
async function count(sql, values = []) {
  return (await db.prepare(sql).bind(...values).first()).count;
}
async function waitFor(condition, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}
async function applyMigration(name, target = db) {
  const source = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
  for (const statement of source.split('-- statement-breakpoint').map(s => s.trim()).filter(Boolean)) await target.prepare(statement).run();
}
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    cf: false, modules: true, scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'],
    bindings: { API_KEY: ADMIN, OAUTH_ISSUER: BASE, OAUTH_ALLOWED_ORIGINS: JSON.stringify(['https://chatgpt.com']) },
    outboundService: () => new Response('External network disabled in OAuth tests', { status: 403 }),
  }));
  db = await mf.getD1Database('DB');
  const migrations = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  assert.ok(migrations.includes('0004_oauth.sql'));
  for (const name of migrations.filter(name => name < '0004_oauth.sql')) await applyMigration(name);
  const old = await parsed(await request('/admin/tenants', { method: 'POST', key: ADMIN, body: { name: 'legacy-before-oauth' } }), 201);
  legacyKey = old.api_key;
  await parsed(await request('/memory/preexisting', { method: 'POST', key: legacyKey,
    body: { value: 'Retained legacy data', description: 'oauthmigrationretained' } }));
  legacySnapshot = { tenant: await db.prepare('SELECT * FROM tenants WHERE id=?').bind(old.tenant.id).first(),
    entry: await db.prepare('SELECT * FROM memory WHERE tenant_id=?').bind(old.tenant.id).first() };
  const oldOwner = await account('preexisting-owner');
  const oldSpace = await space(oldOwner, 'Preexisting owned space');
  const oldScopedKey = await parsed(await request(`/account/spaces/${oldSpace.id}/keys`, { method: 'POST', cookie: oldOwner.cookie,
    body: { label: 'Preexisting scoped key', scopes: ['read', 'write'] } }), 201);
  await parsed(await request('/memory/owned-preexisting', { method: 'POST', key: oldScopedKey.api_key,
    body: { value: 'Retained scoped data', description: 'preserved account migration' } }));
  scopedSnapshot = { owner: oldOwner, target: oldSpace, key: oldScopedKey.api_key,
    account: await db.prepare('SELECT * FROM accounts WHERE id=?').bind(oldOwner.id).first(),
    session: await db.prepare('SELECT * FROM account_sessions WHERE account_id=?').bind(oldOwner.id).first(),
    keyRow: await db.prepare('SELECT * FROM api_keys WHERE id=?').bind(oldScopedKey.key.id).first(),
    tenant: await db.prepare('SELECT * FROM tenants WHERE id=?').bind(oldSpace.id).first(),
    entry: await db.prepare('SELECT * FROM memory WHERE tenant_id=?').bind(oldSpace.id).first() };
  for (const name of migrations.filter(name => name >= '0004_oauth.sql')) await applyMigration(name);
  client = await register();
  otherClient = await register({ client_name: 'Other disposable client' });
});
after(async () => { await mf?.dispose(); });

test('OAuth migration retains legacy tenants, keys, entries and search index', async () => {
  assert.deepEqual(await db.prepare('SELECT * FROM tenants WHERE id=?').bind(legacySnapshot.tenant.id).first(), legacySnapshot.tenant);
  assert.deepEqual(await db.prepare('SELECT * FROM memory WHERE tenant_id=?').bind(legacySnapshot.tenant.id).first(), legacySnapshot.entry);
  const search = await parsed(await request('/memory/search?q=oauthmigrationretained', { key: legacyKey }));
  assert.deepEqual(search.results.map(item => item.key), ['preexisting']);
  assert.equal((await request('/memory', { key: legacyKey })).status, 200);
});

test('OAuth migration retains existing accounts, sessions, spaces, scoped key hashes and memory', async () => {
  const old = scopedSnapshot;
  assert.deepEqual(await db.prepare('SELECT * FROM accounts WHERE id=?').bind(old.owner.id).first(), old.account);
  assert.deepEqual(await db.prepare('SELECT * FROM account_sessions WHERE account_id=?').bind(old.owner.id).first(), old.session);
  assert.deepEqual(await db.prepare('SELECT * FROM api_keys WHERE id=?').bind(old.keyRow.id).first(), old.keyRow);
  assert.deepEqual(await db.prepare('SELECT * FROM tenants WHERE id=?').bind(old.target.id).first(), old.tenant);
  assert.deepEqual(await db.prepare('SELECT * FROM memory WHERE tenant_id=?').bind(old.target.id).first(), old.entry);
  assert.equal((await request('/auth/me', { cookie: old.owner.cookie })).status, 200);
  assert.equal((await parsed(await request('/memory/owned-preexisting', { key: old.key }))).value, 'Retained scoped data');
});

test('discovery advertises canonical OAuth resource, public code + S256 and refresh endpoints', async () => {
  const metadata = await parsed(await request('/.well-known/oauth-authorization-server'));
  assert.equal(metadata.issuer, BASE);
  assert.equal(metadata.authorization_endpoint, BASE + '/oauth/authorize');
  assert.equal(metadata.token_endpoint, BASE + '/oauth/token');
  assert.equal(metadata.registration_endpoint, BASE + '/oauth/register');
  assert.equal(metadata.revocation_endpoint, BASE + '/oauth/revoke');
  assert.deepEqual(metadata.response_types_supported, ['code']);
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(new Set(metadata.grant_types_supported), new Set(['authorization_code', 'refresh_token']));
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const protectedResource = await parsed(await request(path));
    assert.equal(protectedResource.resource, RESOURCE);
    assert.deepEqual(protectedResource.authorization_servers, [BASE]);
    assert.deepEqual(new Set(protectedResource.scopes_supported), new Set(SCOPES));
  }
  const noAuth = await rpc(undefined, 'tools/list');
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate'), /Bearer .*resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(noAuth.headers.get('cache-control'), /no-store/);
});

test('OAuth fails closed when issuer is absent and never derives issuer from Host', async () => {
  const unconfigured = new Miniflare(convertV4MiniflareOptions({ cf: false, modules: true,
    scriptPath: new URL('../dist/index.js', import.meta.url).pathname, compatibilityDate: '2026-10-01', d1Databases: ['DB'],
    outboundService: () => new Response('External network disabled', { status: 403 }),
  }));
  try {
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/mcp']) {
      assert.equal((await unconfigured.dispatchFetch(BASE + path)).status, 503);
    }
    assert.equal((await unconfigured.dispatchFetch(BASE + '/health')).status, 200);
  } finally { await unconfigured.dispose(); }
  const response = await request('/.well-known/oauth-authorization-server', { base: 'https://attacker.invalid' });
  assert.notEqual(response.status, 200, 'spoofed origin does not serve OAuth metadata');
});

test('dynamic registration enforces public-client code flow and safe exact callbacks', async () => {
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal('client_secret' in client, false);
  for (const extra of [
    { redirect_uris: ['https://client.example.invalid/callback#fragment'] },
    { redirect_uris: ['javascript:alert(1)'] }, { redirect_uris: ['https://user:password@client.example.invalid/callback'] },
    { redirect_uris: ['http://client.example.invalid/callback'] },
    { redirect_uris: [REDIRECT, REDIRECT] }, { redirect_uris: [] },
    { token_endpoint_auth_method: 'client_secret_post' }, { grant_types: ['client_credentials'] }, { response_types: ['token'] },
  ]) {
    const response = await request('/oauth/register', { method: 'POST', origin: null,
      body: { client_name: 'Rejected registration', redirect_uris: [REDIRECT], ...extra } });
    assert.equal(response.status, 400);
  }
});

test('authorization rejects missing PKCE, plain PKCE, mismatched resource, redirect, client and scopes', async () => {
  const owner = await account('bad-request');
  for (const extras of [
    { code_challenge_method: 'plain' }, { code_challenge: '' }, { code_challenge: 'invalid' },
    { resource: 'https://other.invalid/mcp' }, { resource: '' }, { redirect_uri: REDIRECT + '/suffix' },
    { redirect_uri: REDIRECT + '?changed=1' }, { client_id: 'unregistered-client' },
    { scope: 'memory:read admin' }, { scope: 'read' }, { response_type: 'token' },
  ]) {
    const { params } = authParams(client, undefined, extras);
    await error(await request('/oauth/authorize/context?' + new URLSearchParams(params), { cookie: owner.cookie, origin: BASE }), 400);
  }
  const { params } = authParams();
  const duplicate = new URLSearchParams(params); duplicate.append('resource', RESOURCE);
  await error(await request('/oauth/authorize/context?' + duplicate, { cookie: owner.cookie, origin: BASE }), 400);
  assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_grants WHERE account_id=?', [owner.id]), 0);
});

test('consent requires the current login, exact Origin, CSRF nonce and an owned space', async () => {
  const owner = await account('consent-owner'), stranger = await account('consent-stranger');
  const target = await space(owner), foreign = await space(stranger);
  const pending = await context(owner);
  assert.deepEqual(pending.context.spaces.map(item => item.id), [target.id]);
  assert.equal(pending.context.account.id, owner.id);
  assert.deepEqual(pending.context.scopes, SCOPES);
  const req = await db.prepare('SELECT * FROM oauth_authorization_requests WHERE id=?').bind(pending.context.request_id).first();
  assert.equal(req.csrf_hash === digest(pending.context.csrf_token), true);
  assert.equal(JSON.stringify(req).includes(pending.context.csrf_token), false);
  for (const origin of [null, 'https://attacker.invalid', 'https://chatgpt.com']) {
    assert.equal((await approve(pending, target, {}, { origin })).status, 403);
  }
  assert.equal((await approve(pending, target, {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await approve(pending, target, { csrf_token: 'bad-csrf' })).status, 403);
  assert.equal((await approve(pending, target, {}, { cookie: stranger.cookie })).status, 403);
  assert.equal((await approve(pending, target, {}, { cookie: undefined })).status, 401);
  assert.equal((await approve(pending, foreign)).status, 403);
  assert.equal((await approve(pending, target, { scope: SCOPES.join(' ') })).status, 400);
  assert.equal((await approve(pending, target, { resource: 'https://other.invalid/mcp' })).status, 400);
  const first = await approve(pending, target);
  assert.equal(first.status, 200, 'invalid attempts did not consume a legitimate consent');
  assert.equal((await approve(pending, target)).status, 403, 'consent cannot be replayed');
  assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_grants WHERE account_id=?', [owner.id]), 1);
});

test('authorization context protects session information; denial consumes consent without issuing credentials', async () => {
  const owner = await account('consent-deny'), target = await space(owner);
  const { params } = authParams();
  const path = '/oauth/authorize/context?' + new URLSearchParams(params);
  assert.equal((await request(path, { origin: BASE })).status, 401);
  assert.equal((await request(path, { cookie: owner.cookie, origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request(path, { cookie: owner.cookie, origin: null })).status, 403);
  const pending = await context(owner);
  const denied = await parsed(await approve(pending, target, { approve: false }));
  const callback = new URL(denied.redirect_to);
  assert.equal(callback.searchParams.get('error'), 'access_denied');
  assert.equal(callback.searchParams.has('code'), false);
  assert.equal(callback.searchParams.get('state'), pending.params.state);
  assert.equal((await approve(pending, target)).status, 403);
  assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_grants WHERE account_id=?', [owner.id]), 0);
});

test('expired consent and replaced or expired login sessions cannot approve authorization', async () => {
  for (const mode of ['request-expired', 'session-expired', 'session-replaced', 'disabled']) {
    const owner = await account(mode), target = await space(owner), pending = await context(owner);
    if (mode === 'request-expired') await db.prepare('UPDATE oauth_authorization_requests SET expires_at=1 WHERE id=?').bind(pending.context.request_id).run();
    if (mode === 'session-expired') await db.prepare('UPDATE account_sessions SET expires_at=1 WHERE account_id=?').bind(owner.id).run();
    if (mode === 'disabled') await db.prepare('UPDATE accounts SET disabled_at=1 WHERE id=?').bind(owner.id).run();
    if (mode === 'session-replaced') {
      const login = await request('/auth/login', { method: 'POST', body: { email: owner.email, password: PASSWORD } });
      assert.equal(login.status, 200); owner.cookie = login.headers.get('set-cookie').split(';')[0];
    }
    assert.ok([401, 403].includes((await approve(pending, target)).status), mode);
    assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_grants WHERE account_id=?', [owner.id]), 0);
  }
});

test('valid S256 exchange issues short lived hash-only credentials bound to selected space', async () => {
  const grant = await fixture();
  assert.match(grant.token_type, /^bearer$/i);
  assert.equal(grant.expires_in, 600);
  assert.deepEqual(new Set(grant.scope.split(' ')), new Set(SCOPES));
  assert.ok(grant.access_token.length >= 40 && grant.refresh_token.length >= 40);
  assert.equal(grant.access_token === grant.refresh_token, false);
  const code = await db.prepare('SELECT * FROM oauth_codes WHERE code_hash=?').bind(digest(grant.code)).first();
  const access = await db.prepare('SELECT * FROM oauth_access_tokens WHERE token_hash=?').bind(digest(grant.access_token)).first();
  const refreshRow = await db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash=?').bind(digest(grant.refresh_token)).first();
  const family = await db.prepare('SELECT * FROM oauth_grants WHERE id=?').bind(grant.grantId).first();
  assert.ok(code.consumed_at > 0);
  assert.equal(access.expires_at - access.created_at, 600000);
  assert.equal(family.space_id, grant.target.id);
  assert.equal(family.account_id, grant.owner.id);
  assert.equal(family.client_id, client.client_id);
  assert.equal(family.resource, RESOURCE);
  for (const secret of [grant.code, grant.access_token, grant.refresh_token, grant.proof.verifier]) {
    assert.equal(JSON.stringify([code, access, refreshRow, family]).includes(secret), false, 'raw credentials never persist');
  }
  assert.equal(await count('SELECT COUNT(*) AS count FROM api_keys WHERE space_id=?', [grant.target.id]), 0, 'OAuth never issues a hidden API key');
  assert.equal((await rpc(grant.access_token, 'tools/list')).status, 200);
});

test('code exchange enforces verifier, client, redirect, resource and single use without consuming on bad bindings', async () => {
  const owner = await account('code-bindings'), target = await space(owner), code = await authorizationCode(owner, target);
  for (const extra of [
    { code_verifier: 'short' }, { code_verifier: 'z'.repeat(64) }, { code_verifier: '' },
    { client_id: otherClient.client_id }, { redirect_uri: REDIRECT + '?other=1' },
    { resource: 'https://other.invalid/mcp' }, { resource: '' },
    { scope: SCOPES.join(' ') + ' admin' },
  ]) {
    const response = await exchange(code, extra);
    assert.equal(response.status, 400);
  }
  const issued = await parsed(await exchange(code));
  assert.ok(issued.access_token);
  await error(await exchange(code), 400, 'invalid_grant');
  assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_access_tokens WHERE grant_id=(SELECT grant_id FROM oauth_codes WHERE code_hash=?)', [digest(code.code)]), 1);
});

test('expired, disabled, deleted and revoked grants cannot exchange a pending code', async () => {
  for (const mode of ['code-expired', 'disabled', 'space-deleted', 'revoked']) {
    const owner = await account('exchange-' + mode), target = await space(owner), code = await authorizationCode(owner, target);
    if (mode === 'code-expired') await db.prepare('UPDATE oauth_codes SET expires_at=1 WHERE code_hash=?').bind(digest(code.code)).run();
    if (mode === 'disabled') await db.prepare('UPDATE accounts SET disabled_at=1 WHERE id=?').bind(owner.id).run();
    if (mode === 'space-deleted') assert.equal((await request('/account/spaces/' + target.id, { method: 'DELETE', cookie: owner.cookie })).status, 200);
    if (mode === 'revoked') await db.prepare('UPDATE oauth_grants SET revoked_at=1 WHERE account_id=?').bind(owner.id).run();
    await error(await exchange(code), 400, 'invalid_grant');
    assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_access_tokens a JOIN oauth_grants g ON a.grant_id=g.id WHERE g.account_id=?', [owner.id]), 0);
  }
});

test('simultaneous authorization and code redemption each have exactly one winner', async () => {
  const owner = await account('concurrent-code'), target = await space(owner), pending = await context(owner);
  const decisions = await Promise.all(Array.from({ length: 6 }, () => approve(pending, target)));
  assert.equal(decisions.filter(item => item.status === 200).length, 1);
  assert.equal(decisions.filter(item => item.status === 403).length, 5);
  const callback = new URL((await decisions.find(item => item.status === 200).json()).redirect_to);
  const code = { ...pending, code: callback.searchParams.get('code') };
  const redeemed = await Promise.all(Array.from({ length: 6 }, () => exchange(code)));
  assert.equal(redeemed.filter(item => item.status === 200).length, 1);
  assert.equal(redeemed.filter(item => item.status === 400).length, 5);
  assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_grants WHERE account_id=?', [owner.id]), 1);
  assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_access_tokens a JOIN oauth_grants g ON a.grant_id=g.id WHERE g.account_id=?', [owner.id]), 1);
});

test('refresh rotates credentials, permits scope narrowing and prevents later escalation', async () => {
  const grant = await fixture();
  const rotated = await parsed(await refresh(grant, { scope: 'memory:read' }));
  assert.equal(rotated.refresh_token === grant.refresh_token, false);
  assert.equal(rotated.access_token === grant.access_token, false);
  assert.equal(rotated.scope, 'memory:read');
  assert.ok((await db.prepare('SELECT consumed_at FROM oauth_refresh_tokens WHERE token_hash=?').bind(digest(grant.refresh_token)).first()).consumed_at > 0);
  const narrowed = { ...grant, ...rotated };
  assert.equal((await refresh(narrowed, { scope: 'memory:read memory:write' })).status, 400);
  assert.equal((await refresh(narrowed, { scope: 'admin' })).status, 400);
  toolDenied(await tool(narrowed, 'memory_put', { key: 'scope-escalation', value: 'forbidden', description: 'forbidden' }), /insufficient_scope/);
  const next = await parsed(await refresh(narrowed));
  assert.equal(next.scope, 'memory:read', 'omitting scope cannot restore dropped permission');
  assert.equal((await rpc(next.access_token, 'tools/list')).status, 200);
  assert.equal(await count('SELECT COUNT(*) AS count FROM memory WHERE tenant_id=?', [grant.target.id]), 0);
});

test('refresh tokens cannot be used by another client or resource and bad bindings do not revoke the owner', async () => {
  const grant = await fixture();
  for (const extra of [{ client_id: otherClient.client_id }, { resource: 'https://other.invalid/mcp' }, { resource: '' }]) {
    assert.equal((await refresh(grant, extra)).status, 400);
    assert.equal((await rpc(grant.access_token, 'tools/list')).status, 200);
  }
  const first = await parsed(await refresh(grant));
  assert.ok(first.access_token);
});

test('refresh replay revokes the whole family, including newly issued access and refresh tokens', async () => {
  const grant = await fixture();
  const rotated = await parsed(await refresh(grant));
  assert.equal((await rpc(rotated.access_token, 'tools/list')).status, 200);
  await error(await refresh(grant), 400, 'invalid_grant');
  assert.equal((await rpc(grant.access_token, 'tools/list')).status, 401);
  assert.equal((await rpc(rotated.access_token, 'tools/list')).status, 401);
  await error(await refresh({ ...grant, ...rotated }), 400, 'invalid_grant');
  assert.ok((await db.prepare('SELECT revoked_at FROM oauth_grants WHERE id=?').bind(grant.grantId).first()).revoked_at > 0);
});

test('parallel refresh has a single winner; detected reuse revokes the resulting token family', async () => {
  const grant = await fixture();
  const responses = await Promise.all(Array.from({ length: 8 }, () => refresh(grant)));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status === 400).length, 7);
  const winner = await responses.find(response => response.status === 200).json();
  assert.equal((await rpc(winner.access_token, 'tools/list')).status, 401);
  await error(await refresh({ ...grant, ...winner }), 400, 'invalid_grant');
  assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_refresh_tokens WHERE grant_id=?', [grant.grantId]), 2);
});

test('connections list hides credentials, isolates account ownership and supports immediate family revocation', async () => {
  const grant = await fixture(), stranger = await account('foreign-revoker');
  const connections = await parsed(await request('/account/connections', { cookie: grant.owner.cookie }));
  assert.equal(connections.connections.length, 1);
  const item = connections.connections[0];
  assert.equal(item.id, grant.grantId);
  assert.equal(item.client_id, client.client_id);
  assert.equal(item.space_id, grant.target.id);
  assert.deepEqual(item.scopes, SCOPES);
  for (const secret of [grant.access_token, grant.refresh_token, grant.code]) assert.equal(JSON.stringify(connections).includes(secret), false);
  assert.deepEqual((await parsed(await request('/account/connections', { cookie: stranger.cookie }))).connections, []);
  assert.equal((await request('/account/connections', { cookie: grant.owner.cookie, origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request('/account/connections', { cookie: grant.owner.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await revoke(grant, { cookie: stranger.cookie })).status, 404);
  assert.equal((await revoke(grant, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await revoke(grant, { origin: null })).status, 403);
  assert.equal((await request('/account/connections', { token: grant.access_token })).status, 401);
  assert.equal((await rpc(grant.access_token, 'tools/list')).status, 200);
  assert.equal((await revoke(grant)).status, 200);
  assert.equal((await rpc(grant.access_token, 'tools/list')).status, 401);
  await error(await refresh(grant), 400, 'invalid_grant');
});

test('RFC7009 revocation is client-bound, idempotent and revokes access or refresh token families', async () => {
  for (const hint of ['access_token', 'refresh_token']) {
    const grant = await fixture();
    const form = { token: grant[hint], token_type_hint: hint, client_id: otherClient.client_id };
    assert.equal((await request('/oauth/revoke', { method: 'POST', origin: null, form })).status, 200);
    assert.equal((await rpc(grant.access_token, 'tools/list')).status, 200, 'foreign client cannot revoke a known token');
    form.client_id = client.client_id;
    assert.equal((await request('/oauth/revoke', { method: 'POST', origin: null, form })).status, 200);
    assert.equal((await request('/oauth/revoke', { method: 'POST', origin: null, form })).status, 200);
    assert.equal((await rpc(grant.access_token, 'tools/list')).status, 401);
    await error(await refresh(grant), 400, 'invalid_grant');
  }
  assert.equal((await request('/oauth/revoke', { method: 'POST', origin: null,
    form: { token: 'unknown-disposable-token', client_id: client.client_id } })).status, 200);
});

test('OAuth durability survives session logout, while token, family, idle and account expiry revoke access', async () => {
  const grant = await fixture();
  assert.equal((await request('/auth/logout', { method: 'POST', cookie: grant.owner.cookie })).status, 200);
  assert.equal((await rpc(grant.access_token, 'tools/list')).status, 200, 'persistent grant is independent of browser cookie lifetime');
  assert.equal((await refresh(grant)).status, 200);
  for (const mode of ['access-expired', 'refresh-expired', 'grant-expired', 'idle-expired', 'disabled', 'deleted']) {
    const current = await fixture();
    if (mode === 'access-expired') await db.prepare('UPDATE oauth_access_tokens SET expires_at=1 WHERE token_hash=?').bind(digest(current.access_token)).run();
    if (mode === 'refresh-expired') await db.prepare('UPDATE oauth_refresh_tokens SET expires_at=1 WHERE token_hash=?').bind(digest(current.refresh_token)).run();
    if (mode === 'grant-expired') await db.prepare('UPDATE oauth_grants SET expires_at=1 WHERE id=?').bind(current.grantId).run();
    if (mode === 'idle-expired') await db.prepare('UPDATE oauth_grants SET idle_expires_at=1 WHERE id=?').bind(current.grantId).run();
    if (mode === 'disabled') await db.prepare('UPDATE accounts SET disabled_at=1 WHERE id=?').bind(current.owner.id).run();
    if (mode === 'deleted') assert.equal((await request('/account/spaces/' + current.target.id, { method: 'DELETE', cookie: current.owner.cookie })).status, 200);
    if (mode !== 'refresh-expired') assert.equal((await rpc(current.access_token, 'tools/list')).status, 401, mode);
    if (mode === 'access-expired') assert.equal((await refresh(current)).status, 200, 'refresh replaces expired short-lived access');
    else await error(await refresh(current), 400, 'invalid_grant');
  }
});

test('MCP accepts space API keys while REST, sessions and OAuth token families stay separate', async () => {
  const grant = await fixture();
  const key = await parsed(await request(`/account/spaces/${grant.target.id}/keys`, { method: 'POST', cookie: grant.owner.cookie,
    body: { label: 'Disposable independent key', scopes: ['read', 'write', 'delete', 'gc'] } }), 201);
  for (const raw of [grant.access_token, grant.refresh_token]) {
    assert.equal((await request('/memory', { key: raw })).status, 401);
    assert.equal((await request('/memory', { token: raw })).status, 401);
  }
  assert.equal((await rpc(undefined, 'tools/list', {}, { key: key.api_key })).status, 200);
  for (const options of [{ cookie: grant.owner.cookie }, { key: ADMIN }, { token: key.api_key }, { token: grant.refresh_token }]) {
    assert.equal((await rpc(undefined, 'tools/list', {}, options)).status, 401);
  }
  assert.equal((await request('/memory', { key: key.api_key })).status, 200);
  assert.equal((await revoke(grant)).status, 200);
  assert.equal((await request('/memory/regression', { method: 'POST', key: key.api_key,
    body: { value: 'API keys stay compatible', description: 'rest regression' } })).status, 200);
});

test('MCP supports modern and legacy initialization, tool metadata and calls without session state', async () => {
  const grant = await fixture();
  for (const version of ['2025-03-26', '2025-11-25']) {
    const initialized = await rpcResult(await rpc(grant.access_token, 'initialize', {
      protocolVersion: version, capabilities: {}, clientInfo: { name: 'disposable-integration-client', version: '1.0.0' },
    }, { headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version } }));
    assert.equal(initialized.result.protocolVersion, version);
    assert.ok(initialized.result.capabilities.tools);
    const listed = await rpcResult(await rpc(grant.access_token, 'tools/list', {}, {
      headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': version },
    }));
    assert.deepEqual(new Set(listed.result.tools.map(item => item.name)), new Set([
      'memory_list', 'memory_get', 'memory_search', 'memory_summary', 'memory_put', 'memory_delete', 'memory_gc', 'memory_workspaces', 'memory_workbench', 'memory_update',
    ]));
    for (const item of listed.result.tools) {
      assert.equal(item.inputSchema.additionalProperties, false);
      assert.ok(item._meta.securitySchemes.some(scheme => scheme.type === 'oauth2'));
    }
    assert.deepEqual(toolValue(await tool(grant, 'memory_list')), { keys: [] });
  }
});

test('MCP rejects hostile Origin, unsupported methods and ambient query credentials', async () => {
  const grant = await fixture();
  assert.equal((await rpc(grant.access_token, 'tools/list', {}, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await rpc(grant.access_token, 'tools/list', {}, { base: 'http://rebound.invalid' })).status, 403);
  assert.equal((await rpc(grant.access_token, 'tools/list', {}, { origin: 'https://chatgpt.com' })).status, 200);
  assert.equal((await rpc(grant.access_token, 'tools/list', {}, { origin: BASE })).status, 200);
  assert.equal((await request('/mcp', { token: grant.access_token })).status, 405);
  assert.equal((await request('/mcp', { method: 'DELETE', token: grant.access_token, origin: null })).status, 405);
  assert.equal((await request('/mcp?access_token=' + encodeURIComponent(grant.access_token), { method: 'POST',
    body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }, headers: { Accept: 'application/json, text/event-stream' } })).status, 401);
  assert.equal((await request('/oauth/token', { method: 'POST', origin: 'https://attacker.invalid', form: {
    grant_type: 'refresh_token', refresh_token: grant.refresh_token, client_id: client.client_id, resource: RESOURCE,
  } })).status, 403);
});

test('every MCP operation derives its space from token; concurrent callers keep keys, values, counters and FTS isolated', async () => {
  const owner = await account('two-spaces');
  const first = await fixture({ owner, target: await space(owner, 'First space') });
  const second = await fixture({ owner, target: await space(owner, 'Second space') });
  await Promise.all(Array.from({ length: 6 }, async (_, i) => {
    toolValue(await tool(first, 'memory_put', { key: 'shared/' + i, value: 'first-' + i, description: 'firstspaceuniqueterm' }));
    toolValue(await tool(second, 'memory_put', { key: 'shared/' + i, value: 'second-' + i, description: 'secondspaceuniqueterm' }));
  }));
  for (const [grant, prefix, foreignTerm] of [[first, 'first-', 'secondspaceuniqueterm'], [second, 'second-', 'firstspaceuniqueterm']]) {
    const values = await Promise.all(Array.from({ length: 6 }, (_, i) => tool(grant, 'memory_get', { key: 'shared/' + i })));
    values.forEach((result, i) => assert.equal(toolValue(result).entry.value, prefix + i));
    assert.deepEqual(toolValue(await tool(grant, 'memory_search', { query: foreignTerm })).results, []);
    assert.equal(toolValue(await tool(grant, 'memory_list', { prefix: 'shared/' })).keys.length, 6);
    assert.equal(toolValue(await tool(grant, 'memory_summary')).entries.length, 6);
  }
  for (const field of ['tenant_id', 'space_id', 'account_id', 'namespace']) {
    toolDenied(await tool(first, 'memory_put', { key: 'overridden', value: 'forbidden', description: 'forbidden', [field]: second.target.id }));
    toolDenied(await tool(first, 'memory_list', { [field]: second.target.id }));
  }
  for (const grant of [first, second]) {
    const counters = (await db.prepare('SELECT access_count FROM memory WHERE tenant_id=?').bind(grant.target.id).all()).results;
    assert.deepEqual(counters.map(row => row.access_count), [1, 1, 1, 1, 1, 1], 'each reader only increments its own space');
  }
  toolValue(await tool(first, 'memory_delete', { key: 'shared/0' }));
  assert.equal(toolValue(await tool(second, 'memory_get', { key: 'shared/0' })).entry.value, 'second-0');
  await db.prepare('UPDATE memory SET expires_at=1 WHERE tenant_id IN (?,?)').bind(first.target.id, second.target.id).run();
  assert.equal(toolValue(await tool(first, 'memory_gc')).deleted, 5);
  assert.equal(await count('SELECT COUNT(*) AS count FROM memory WHERE tenant_id=?', [second.target.id]), 6);
  assert.equal(await count("SELECT COUNT(*) AS count FROM memory WHERE key='overridden'"), 0);
});

test('least-privilege tools enforce each OAuth scope and never read or modify another space', async () => {
  const owner = await account('least-privilege'), target = await space(owner);
  const readOnly = await fixture({ owner, target, params: { scope: 'memory:read' } });
  const writeOnly = await fixture({ owner, target, params: { scope: 'memory:write' } });
  toolValue(await tool(writeOnly, 'memory_put', { key: 'limited', value: 'retained', description: 'scoped' }));
  toolDenied(await tool(writeOnly, 'memory_get', { key: 'limited' }), /insufficient_scope/);
  toolDenied(await tool(writeOnly, 'memory_list'), /insufficient_scope/);
  assert.equal(toolValue(await tool(readOnly, 'memory_get', { key: 'limited' })).entry.value, 'retained');
  for (const [name, args] of [
    ['memory_put', { key: 'limited', value: 'changed', description: 'forbidden' }], ['memory_delete', { key: 'limited' }], ['memory_gc', {}],
  ]) toolDenied(await tool(readOnly, name, args), /insufficient_scope/);
  assert.equal((await db.prepare('SELECT value FROM memory WHERE tenant_id=? AND key=?').bind(target.id, 'limited').first()).value, 'retained');
});

test('already authenticated MCP writes cannot commit after revocation, expiration, account disable or space deletion', async () => {
  for (const mode of ['revoked', 'access-expired', 'grant-expired', 'disabled', 'space-deleted', 'ownership-transferred']) {
    const grant = await fixture();
    const memoryKey = 'delayed/' + mode;
    const windowStart = Math.floor(Date.now() / 60000) * 60000;
    const buckets = [windowStart, windowStart + 60000].map(start => digest(`mcp:${digest(grant.access_token)}:${start}`));
    let controller, released = false;
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: {
      name: 'memory_put', arguments: { key: memoryKey, value: 'late write', description: 'oauthinflightuniqueterm' },
    } });
    const stream = new ReadableStream({ start(value) { controller = value; controller.enqueue(new TextEncoder().encode(body.slice(0, -1))); } });
    const release = () => { if (!released) { released = true; controller.enqueue(new TextEncoder().encode('}')); controller.close(); } };
    const pending = mf.dispatchFetch(RESOURCE, { method: 'POST', headers: {
      Authorization: 'Bearer ' + grant.access_token, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25',
    }, body: stream, duplex: 'half' });
    try {
      // The limiter runs after Bearer validation and before parsing the complete
      // body. Its committed counter proves initial auth finished before revoke.
      await waitFor(async () => (await db.prepare('SELECT SUM(attempts) AS count FROM auth_rate_limits WHERE bucket_hash IN (?,?)').bind(...buckets).first()).count === 1,
        'MCP must reach its post-authentication limiter before credential invalidation');
      if (mode === 'revoked') assert.equal((await revoke(grant)).status, 200);
      if (mode === 'access-expired') await db.prepare('UPDATE oauth_access_tokens SET expires_at=1 WHERE token_hash=?').bind(digest(grant.access_token)).run();
      if (mode === 'grant-expired') await db.prepare('UPDATE oauth_grants SET expires_at=1 WHERE id=?').bind(grant.grantId).run();
      if (mode === 'disabled') await db.prepare('UPDATE accounts SET disabled_at=1 WHERE id=?').bind(grant.owner.id).run();
      if (mode === 'space-deleted') assert.equal((await request('/account/spaces/' + grant.target.id, { method: 'DELETE', cookie: grant.owner.cookie })).status, 200);
      if (mode === 'ownership-transferred') {
        const newOwner = await account('transferred-owner');
        await db.prepare('UPDATE tenants SET owner_account_id=? WHERE id=?').bind(newOwner.id, grant.target.id).run();
      }
      release();
      const response = await pending;
      if (response.status === 200) toolDenied(await rpcResult(response), /invalid_token/);
      else assert.equal(response.status, 401);
      assert.equal(await count('SELECT COUNT(*) AS count FROM memory WHERE tenant_id=? AND key=?', [grant.target.id, memoryKey]), 0);
      assert.equal(await count("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH 'oauthinflightuniqueterm'"), 0);
    } finally { release(); await pending.catch(() => {}); }
  }
});

test('bad proof or client on consumed credentials cannot revoke the legitimate authorization', async () => {
  const grant = await fixture();
  for (const extra of [{ code_verifier: 'x'.repeat(64) }, { client_id: otherClient.client_id },
    { resource: 'https://other.invalid/mcp' }, { redirect_uri: REDIRECT + '?other=1' }]) {
    assert.equal((await exchange(grant, extra)).status, 400);
    assert.equal((await rpc(grant.access_token, 'tools/list')).status, 200);
  }
  const rotated = await parsed(await refresh(grant));
  for (const extra of [{ client_id: otherClient.client_id }, { resource: 'https://other.invalid/mcp' }]) {
    assert.equal((await refresh(grant, extra)).status, 400);
    assert.equal((await rpc(rotated.access_token, 'tools/list')).status, 200);
  }
  assert.equal((await refresh({ ...grant, ...rotated })).status, 200);
  // Correctly bound code replay is compromise evidence even after refresh.
  await error(await exchange(grant), 400, 'invalid_grant');
  assert.equal((await rpc(grant.access_token, 'tools/list')).status, 401);
  assert.equal((await rpc(rotated.access_token, 'tools/list')).status, 401);
});

test('ownership transfer invalidates old access and refresh even when the space still exists', async () => {
  const grant = await fixture(), recipient = await account('new-owner');
  await db.prepare('UPDATE tenants SET owner_account_id=? WHERE id=?').bind(recipient.id, grant.target.id).run();
  assert.equal((await rpc(grant.access_token, 'tools/list')).status, 401);
  await error(await refresh(grant), 400, 'invalid_grant');
  assert.equal(await count('SELECT COUNT(*) AS count FROM tenants WHERE id=? AND owner_account_id=?', [grant.target.id, recipient.id]), 1);
});

test('MCP SDK modern per-request negotiation supports discover, tool listing and calls', async () => {
  const grant = await fixture();
  const headers = { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28' };
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'disposable-modern-client', version: '1.0.0' } };
  const discovered = await rpcResult(await rpc(grant.access_token, 'server/discover', { _meta }, { headers: { ...headers, 'Mcp-Method': 'server/discover' } }));
  assert.ok(discovered.result.supportedVersions.includes('2026-07-28'));
  assert.ok(discovered.result.capabilities.tools);
  const listed = await rpcResult(await rpc(grant.access_token, 'tools/list', { _meta }, { headers: { ...headers, 'Mcp-Method': 'tools/list' } }));
  assert.equal(listed.result.tools.length, 10);
  const called = await rpcResult(await rpc(grant.access_token, 'tools/call', { _meta, name: 'memory_list', arguments: {} }, { headers: { ...headers, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'memory_list' } }));
  assert.deepEqual(toolValue(called), { keys: [] });
});

test('OAuth protocol errors reject malformed, duplicate, oversized and wrong-content-type token requests', async () => {
  const grant = await fixture();
  for (const raw of ['grant_type=refresh_token&grant_type=authorization_code', 'grant_type=client_credentials', 'grant_type=password']) {
    assert.equal((await request('/oauth/token', { method: 'POST', origin: null, raw,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 400);
  }
  assert.equal((await request('/oauth/token', { method: 'POST', origin: null,
    body: { grant_type: 'refresh_token', refresh_token: grant.refresh_token, client_id: client.client_id, resource: RESOURCE } })).status, 415);
  assert.equal((await request('/oauth/token', { method: 'POST', origin: null, raw: 'x'.repeat(70000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 413);
  const valid = await refresh(grant);
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get('cache-control'), /no-store/);
  assert.match(valid.headers.get('pragma'), /no-cache/);
});

test('offline_access is consented explicitly alongside memory scope and cannot confer memory permission by itself', async () => {
  const grant = await fixture({ params: { scope: 'memory:read offline_access' } });
  assert.deepEqual(new Set(grant.scope.split(' ')), new Set(['memory:read', 'offline_access']));
  assert.equal((await refresh(grant)).status, 200);
  const { params } = authParams(client, undefined, { scope: 'offline_access' });
  await error(await request('/oauth/authorize/context?' + new URLSearchParams(params), { cookie: grant.owner.cookie, origin: BASE }), 400, 'invalid_scope');
});

test('abandoned client registrations expire without deleting active grants, pending consent or fresh registrations', async () => {
  const activeClient = await register({ client_name: 'Active cleanup survivor' });
  const pendingClient = await register({ client_name: 'Pending cleanup survivor' });
  const staleClient = await register({ client_name: 'Abandoned cleanup target' });
  const freshClient = await register({ client_name: 'Fresh cleanup survivor' });
  const expiredClient = await register({ client_name: 'Expired cleanup target' });
  const active = await fixture({ client: activeClient });
  const expired = await fixture({ client: expiredClient });
  const pendingOwner = await account('pending-cleanup'), pendingSpace = await space(pendingOwner);
  const pending = await context(pendingOwner, { client: pendingClient });
  await db.prepare('UPDATE oauth_clients SET created_at=1 WHERE client_id IN (?,?,?,?)')
    .bind(activeClient.client_id, pendingClient.client_id, staleClient.client_id, expiredClient.client_id).run();
  await db.prepare('UPDATE oauth_grants SET expires_at=1 WHERE id=?').bind(expired.grantId).run();
  await register({ client_name: 'Cleanup trigger' });
  for (const item of [activeClient, pendingClient, freshClient]) {
    assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_clients WHERE client_id=?', [item.client_id]), 1);
  }
  for (const item of [staleClient, expiredClient]) {
    assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_clients WHERE client_id=?', [item.client_id]), 0);
  }
  assert.equal((await rpc(active.access_token, 'tools/list')).status, 200);
  assert.equal((await approve(pending, pendingSpace)).status, 200);
  assert.equal((await rpc(expired.access_token, 'tools/list')).status, 401);
});

test('OAuth authorization error redirects preserve state only for validated registered callbacks', async () => {
  const { params } = authParams(client, undefined, { scope: 'unknown-scope' });
  const known = await request('/oauth/authorize?' + new URLSearchParams(params));
  assert.equal(known.status, 302);
  const location = new URL(known.headers.get('location'));
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get('error'), 'invalid_scope');
  assert.equal(location.searchParams.get('state'), params.state);
  assert.equal(location.searchParams.get('iss'), BASE);
  const foreign = await request('/oauth/authorize?' + new URLSearchParams({ ...params, redirect_uri: 'https://attacker.invalid/callback' }));
  assert.equal(foreign.status, 400);
  assert.equal(foreign.headers.has('location'), false);
  const unknown = await request('/oauth/authorize?' + new URLSearchParams({ ...params, client_id: 'unknown-client' }));
  assert.equal(unknown.status, 400);
  assert.equal(unknown.headers.has('location'), false);
});

test('connected-app history never hides an older active grant behind recent revocations', async () => {
  const grant = await fixture();
  const now = Date.now();
  await db.prepare(`WITH RECURSIVE recent(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM recent WHERE n<201)
    INSERT INTO oauth_grants(id,account_id,space_id,client_id,resource,scopes,created_at,expires_at,idle_expires_at,revoked_at)
    SELECT ? || n,?,?,?,?,'["memory:read"]',?,?,?,? FROM recent`)
    .bind('revoked-history-' + ++nextId + '-', grant.owner.id, grant.target.id, client.client_id, RESOURCE,
      now + 1000, now + 86400000, now + 86400000, now).run();
  const history = (await parsed(await request('/account/connections', { cookie: grant.owner.cookie }))).connections;
  assert.ok(history.some(item => item.id === grant.grantId && item.revoked_at === null));
  assert.equal((await revoke(grant)).status, 200, 'the old active grant remains discoverable and revocable');
});

test('MCP browser preflight supports required modern protocol headers without credentialed CORS', async () => {
  const allowed = await request('/mcp', { method: 'OPTIONS', origin: 'https://chatgpt.com', headers: {
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'authorization,content-type,mcp-protocol-version,mcp-method,mcp-name',
  } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://chatgpt.com');
  assert.equal(allowed.headers.has('access-control-allow-credentials'), false);
  const advertised = allowed.headers.get('access-control-allow-headers').toLowerCase().split(',').map(value => value.trim());
  for (const name of ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-method', 'mcp-name']) assert.ok(advertised.includes(name));
  const rejected = await request('/mcp', { method: 'OPTIONS', origin: 'https://attacker.invalid' });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.has('access-control-allow-origin'), false);
});

test('unsafe or unbounded OAuth browser origin configuration fails closed', async () => {
  for (const value of ['not json', '["http://nonloopback.invalid"]', '["https://client.invalid/path"]',
    JSON.stringify(Array.from({ length: 21 }, (_, i) => `https://client${i}.invalid`))]) {
    const invalid = new Miniflare(convertV4MiniflareOptions({ cf: false, modules: true,
      scriptPath: new URL('../dist/index.js', import.meta.url).pathname, compatibilityDate: '2026-10-01', d1Databases: ['DB'],
      bindings: { OAUTH_ISSUER: BASE, OAUTH_ALLOWED_ORIGINS: value },
      outboundService: () => new Response('External network disabled', { status: 403 }),
    }));
    try { assert.equal((await invalid.dispatchFetch(RESOURCE, { method: 'OPTIONS' })).status, 503); }
    finally { await invalid.dispose(); }
  }
});

test('D1 mint failure rolls back authorization-code consumption and every partial token write', async () => {
  const owner = await account('code-rollback'), target = await space(owner);
  const code = await authorizationCode(owner, target);
  const before = await db.prepare('SELECT * FROM oauth_codes WHERE code_hash=?').bind(digest(code.code)).first();
  await db.prepare("CREATE TRIGGER oauth_test_code_mint_failure BEFORE INSERT ON oauth_access_tokens BEGIN SELECT RAISE(ABORT,'simulated mint failure'); END").run();
  try {
    assert.equal((await exchange(code)).status, 500);
    assert.deepEqual(await db.prepare('SELECT * FROM oauth_codes WHERE code_hash=?').bind(digest(code.code)).first(), before,
      'failed token insertion must leave code unused with no consumption receipt');
    assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_access_tokens WHERE grant_id=?', [before.grant_id]), 0);
    assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_refresh_tokens WHERE grant_id=?', [before.grant_id]), 0);
  } finally { await db.prepare('DROP TRIGGER oauth_test_code_mint_failure').run(); }
  const issued = await parsed(await exchange(code));
  assert.equal((await rpc(issued.access_token, 'tools/list')).status, 200, 'unconsumed code is usable after transient storage failure');
});

test('D1 refresh mint failure rolls back token consumption, rotation and idle-extension as one transaction', async () => {
  const grant = await fixture();
  await db.prepare('UPDATE oauth_grants SET idle_expires_at=? WHERE id=?').bind(Date.now() + 3 * 86400000, grant.grantId).run();
  const beforeGrant = await db.prepare('SELECT * FROM oauth_grants WHERE id=?').bind(grant.grantId).first();
  const beforeRefresh = await db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash=?').bind(digest(grant.refresh_token)).first();
  await db.prepare("CREATE TRIGGER oauth_test_refresh_mint_failure BEFORE INSERT ON oauth_access_tokens BEGIN SELECT RAISE(ABORT,'simulated mint failure'); END").run();
  try {
    assert.equal((await refresh(grant)).status, 500);
    assert.deepEqual(await db.prepare('SELECT * FROM oauth_grants WHERE id=?').bind(grant.grantId).first(), beforeGrant,
      'failed refresh cannot extend the grant idle lifetime');
    assert.deepEqual(await db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash=?').bind(digest(grant.refresh_token)).first(), beforeRefresh,
      'failed refresh cannot consume the source token');
    assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_refresh_tokens WHERE grant_id=?', [grant.grantId]), 1);
    assert.equal(await count('SELECT COUNT(*) AS count FROM oauth_access_tokens WHERE grant_id=?', [grant.grantId]), 1);
  } finally { await db.prepare('DROP TRIGGER oauth_test_refresh_mint_failure').run(); }
  assert.equal((await refresh(grant)).status, 200, 'rolled-back refresh remains usable');
  assert.equal((await rpc(grant.access_token, 'tools/list')).status, 200, 'transient failure was not mistaken for replay');
});

async function multiFixture() {
  const owner=await account('multi-owner');
  const first=await space(owner,'Daily work'),second=await space(owner,'Project notes'),unselected=await space(owner,'Unselected space');
  const pending=await context(owner);
  const decision=await parsed(await request('/oauth/authorize',{method:'POST',cookie:owner.cookie,body:{request_id:pending.context.request_id,csrf_token:pending.context.csrf_token,space_ids:[first.id,second.id],default_space_id:second.id,approve:true}}));
  const code={...pending,code:new URL(decision.redirect_to).searchParams.get('code')};
  const tokens=await parsed(await exchange(code));
  const row=await db.prepare('SELECT grant_id FROM oauth_access_tokens WHERE token_hash=?').bind(digest(tokens.access_token)).first();
  return {...code,...tokens,grantId:row.grant_id,first,second,unselected,target:second};
}

test('multi-workspace consent permits only selected spaces and keeps an explicit default',async()=>{
 const g=await multiFixture();
 const ws=toolValue(await tool(g,'memory_workspaces'));
 assert.deepEqual(new Set(ws.workspaces.map(w=>w.id)),new Set([g.first.id,g.second.id]));
 assert.equal(ws.default_workspace_id,g.second.id);
 toolValue(await tool(g,'memory_put',{workspace_id:g.first.id,key:'shared-key',value:'alpha',description:'First workspace'}));
 toolValue(await tool(g,'memory_put',{workspace_id:g.second.id,key:'shared-key',value:'beta',description:'Second workspace'}));
 assert.equal(toolValue(await tool(g,'memory_get',{workspace_id:g.first.id,key:'shared-key'})).entry.value,'alpha');
 assert.equal(toolValue(await tool(g,'memory_get',{key:'shared-key'})).entry.value,'beta');
 for(const name of ['memory_get','memory_list','memory_summary','memory_workbench','memory_delete','memory_gc']){
   toolDenied(await tool(g,name,{workspace_id:g.unselected.id,...(name==='memory_get'||name==='memory_delete'?{key:'shared-key'}:{})}));
 }
 toolDenied(await tool(g,'memory_put',{workspace_id:g.unselected.id,key:'shared-key',value:'forbidden',description:'forbidden'}));
 assert.equal(await count('SELECT count(*) AS count FROM memory WHERE tenant_id=?',[g.unselected.id]),0);
 const connections=await parsed(await request('/account/connections',{cookie:g.owner.cookie}));
 assert.equal(connections.connections.find(x=>x.id===g.grantId).spaces.length,2);
 const fresh=await parsed(await refresh(g));
 assert.equal(toolValue(await tool({...g,...fresh},'memory_workspaces')).workspaces.length,2);
});

test('multi-workspace consent rejects empty, duplicate, excessive and foreign selections atomically',async()=>{
 const owner=await account('selection-owner'),mine=await space(owner),foreign=await space(await account('foreign-owner'));
 for(const selection of [[],[mine.id,mine.id],Array(101).fill(mine.id),[mine.id,foreign.id]]){
   const pending=await context(owner);
   const response=await request('/oauth/authorize',{method:'POST',cookie:owner.cookie,body:{request_id:pending.context.request_id,csrf_token:pending.context.csrf_token,approve:true,space_ids:selection}});
   assert.ok([400,403].includes(response.status));
   assert.equal(await count('SELECT count(*) AS count FROM oauth_grants WHERE account_id=?',[owner.id]),0);
   const row=await db.prepare('SELECT consumed_at FROM oauth_authorization_requests WHERE id=?').bind(pending.context.request_id).first();
   assert.equal(row.consumed_at,null);
 }
 const pending=await context(owner);
 await error(await request('/oauth/authorize',{method:'POST',cookie:owner.cookie,body:{request_id:pending.context.request_id,csrf_token:pending.context.csrf_token,approve:true,space_ids:[mine.id],default_space_id:foreign.id}}),400,'invalid_request');
});

test('secondary workspace ownership is rechecked and cannot be recovered by passing an ID',async()=>{
 const g=await multiFixture(),other=await account('transfer-target');
 toolValue(await tool(g,'memory_put',{workspace_id:g.first.id,key:'private',value:'before',description:'protected'}));
 await db.prepare('UPDATE tenants SET owner_account_id=? WHERE id=?').bind(other.id,g.first.id).run();
 const ws=toolValue(await tool(g,'memory_workspaces'));
 assert.deepEqual(ws.workspaces.map(w=>w.id),[g.second.id]);
 toolDenied(await tool(g,'memory_get',{workspace_id:g.first.id,key:'private'}));
 toolDenied(await tool(g,'memory_put',{workspace_id:g.first.id,key:'private',value:'after',description:'forbidden'}));
 assert.equal((await db.prepare('SELECT value FROM memory WHERE tenant_id=? AND key=?').bind(g.first.id,'private').first()).value,'before');
});

test('workbench filters and pages live index, logs changes, and does not log reads',async()=>{
 const g=await multiFixture();
 for(const [key,value,description] of [['tasks/a','one','待办：整理数据'],['tasks/b','two','已完成：模型测试'],['user/style','three','偏好：自然表达']])
  toolValue(await tool(g,'memory_put',{workspace_id:g.first.id,key,value,description}));
 const result=toolValue(await tool(g,'memory_workbench',{workspace_id:g.first.id,prefix:'tasks/',limit:1}));
 assert.equal(result.total,2);assert.equal(result.entries.length,1);assert.equal(result.has_more,true);
 assert.equal(result.workspaces.length,2);assert.equal(result.changes.length,3);
 const next=toolValue(await tool(g,'memory_workbench',{workspace_id:g.first.id,prefix:'tasks/',limit:1,offset:1}));
 assert.notEqual(next.entries[0].key,result.entries[0].key);
 const search=toolValue(await tool(g,'memory_workbench',{workspace_id:g.first.id,query:'模型'}));assert.deepEqual(search.entries.map(e=>e.key),['tasks/b']);
 toolValue(await tool(g,'memory_get',{workspace_id:g.first.id,key:'tasks/a'}));
 assert.equal(toolValue(await tool(g,'memory_workbench',{workspace_id:g.first.id})).changes.length,3);
 toolValue(await tool(g,'memory_put',{workspace_id:g.first.id,key:'tasks/a',value:'updated',description:'进行中：整理数据'}));
 toolValue(await tool(g,'memory_delete',{workspace_id:g.first.id,key:'tasks/b'}));
 const changes=toolValue(await tool(g,'memory_workbench',{workspace_id:g.first.id}));
 assert.equal(changes.changes.length,5);assert.ok(changes.changes.some(x=>x.operation==='deleted'&&x.key==='tasks/b'));
 assert.ok(changes.changes.some(x=>x.operation==='updated'&&x.key==='tasks/a'));
 assert.equal(toolValue(await tool(g,'memory_workbench',{workspace_id:g.second.id})).changes.length,0);
});

test('MCP App resource is discoverable, self-contained and linked from the workbench tool',async()=>{
 const g=await fixture();
 const listed=await rpcResult(await rpc(g.access_token,'tools/list'));
 const workbench=listed.result.tools.find(t=>t.name==='memory_workbench');
 assert.equal(workbench._meta.ui.resourceUri,'ui://walle-memory/workbench-v1.html');
 const resources=await rpcResult(await rpc(g.access_token,'resources/list'));
 assert.ok(resources.result.resources.some(r=>r.uri===workbench._meta.ui.resourceUri));
 const resource=await rpcResult(await rpc(g.access_token,'resources/read',{uri:workbench._meta.ui.resourceUri}));
 const content=resource.result.contents[0];assert.equal(content.mimeType,'text/html;profile=mcp-app');
 assert.match(content.text,/<h1>Walle Memory<\/h1>/);assert.doesNotMatch(content.text,/API key \(hidden\)|X-Api-Key/);
 assert.deepEqual(content._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
});

test('in-flight secondary writes revalidate the default and selected workspace at commit',async()=>{
 for(const mode of ['default-transfer','secondary-transfer','grant-space-removed']){
  const g=await multiFixture(),recipient=await account('inflight-recipient');
  const start=Math.floor(Date.now()/60000)*60000;
  const buckets=[start,start+60000].map(x=>digest(`mcp:${digest(g.access_token)}:${x}`));
  const payload=JSON.stringify({jsonrpc:'2.0',id:++rpcId,method:'tools/call',params:{name:'memory_put',arguments:{workspace_id:g.first.id,key:'late',value:'forbidden late write',description:'must never appear'}}});
  let controller,released=false;
  const stream=new ReadableStream({start(c){controller=c;c.enqueue(new TextEncoder().encode(payload.slice(0,-1)));}});
  const release=()=>{if(!released){released=true;controller.enqueue(new TextEncoder().encode('}'));controller.close();}};
  const pending=mf.dispatchFetch(RESOURCE,{method:'POST',headers:{Authorization:'Bearer '+g.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:stream,duplex:'half'});
  try{
   await waitFor(async()=>(await db.prepare('SELECT SUM(attempts) AS count FROM auth_rate_limits WHERE bucket_hash IN (?,?)').bind(...buckets).first()).count===1,'MCP authentication completed before workspace change');
   if(mode==='grant-space-removed')await db.prepare('DELETE FROM oauth_grant_spaces WHERE grant_id=? AND space_id=?').bind(g.grantId,g.first.id).run();
   else await db.prepare('UPDATE tenants SET owner_account_id=? WHERE id=?').bind(recipient.id,mode==='default-transfer'?g.second.id:g.first.id).run();
   release();const response=await pending;
   if(response.status===200)toolDenied(await rpcResult(response),/invalid_token/);else assert.equal(response.status,401);
   assert.equal(await count("SELECT count(*) AS count FROM memory WHERE tenant_id=? AND key='late'",[g.first.id]),0);
  }finally{release();await pending.catch(()=>{});}
 }
});

test('0005 backfills existing single-workspace OAuth credentials without changing data or expanding access',async()=>{
 const g=await fixture();toolValue(await tool(g,'memory_put',{key:'retained',value:'retained body',description:'retained summary'}));
 const isolated=new Miniflare(convertV4MiniflareOptions({cf:false,modules:true,scriptPath:new URL('../dist/index.js',import.meta.url).pathname,compatibilityDate:'2026-10-01',d1Databases:['DB'],bindings:{OAUTH_ISSUER:BASE},outboundService:()=>new Response('disabled',{status:403})}));
 try{
  const old=await isolated.getD1Database('DB');
  for(const name of ['0001_initial.sql','0002_accounts_spaces_keys.sql','0003_registration_invitations.sql','0004_oauth.sql'])await applyMigration(name,old);
  const selections=[['accounts','id',g.owner.id],['tenants','id',g.target.id],['oauth_clients','client_id',g.client.client_id],['oauth_grants','id',g.grantId],['oauth_access_tokens','token_hash',digest(g.access_token)],['memory','tenant_id',g.target.id]];
  const snapshots=[];
  for(const [table,column,id]of selections){const row=await db.prepare(`SELECT * FROM ${table} WHERE ${column}=?`).bind(id).first();const columns=Object.keys(row);await old.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...Object.values(row)).run();snapshots.push({table,column,id,row});}
  await applyMigration('0005_oauth_workspaces.sql',old);await applyMigration('0006_memory_changes.sql',old);
  assert.deepEqual((await old.prepare('SELECT space_id FROM oauth_grant_spaces WHERE grant_id=?').bind(g.grantId).all()).results,[{space_id:g.target.id}]);
  for(const {table,column,id,row}of snapshots)assert.deepEqual(await old.prepare(`SELECT * FROM ${table} WHERE ${column}=?`).bind(id).first(),row);
  assert.equal((await old.prepare('SELECT count(*) AS n FROM memory_changes').first()).n,0,'old updates are not fabricated as history');
  const response=await isolated.dispatchFetch(RESOURCE,{method:'POST',headers:{Authorization:'Bearer '+g.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'memory_workspaces',arguments:{}}})});
  const value=toolValue(await rpcResult(response));assert.equal(value.workspaces.length,1);assert.equal(value.default_workspace_id,g.target.id);
 }finally{await isolated.dispose();}
});


test('existing-record edits preserve exact expiry and counters and produce one update event',async()=>{
 const g=await fixture();toolValue(await tool(g,'memory_put',{key:'edit/ttl',value:'old',description:'old summary',ttl_seconds:3600}));
 const before=toolValue(await tool(g,'memory_get',{key:'edit/ttl'})).entry;
 const result=toolValue(await tool(g,'memory_update',{key:before.key,value:'new',description:'new summary',expected_updated_at:before.updated_at}));
 assert.equal(result.ok,true);assert.equal(result.entry.expires_at,before.expires_at);assert.equal(result.entry.access_count,before.access_count+1);assert.ok(result.entry.updated_at>before.updated_at);
 const after=toolValue(await tool(g,'memory_get',{key:before.key})).entry;assert.equal(after.value,'new');assert.equal(after.description,'new summary');assert.equal(after.expires_at,before.expires_at);
 const history=toolValue(await tool(g,'memory_workbench')).changes;assert.equal(history.length,2);assert.equal(history[0].operation,'updated');
 const listed=await rpcResult(await rpc(g.access_token,'tools/list'));const edit=listed.result.tools.find(t=>t.name==='memory_update');
 assert.equal(edit.annotations.readOnlyHint,false);assert.equal(edit._meta['openai/widgetAccessible'],true);assert.ok(edit._meta.ui.visibility.includes('app'));assert.deepEqual(edit._meta.securitySchemes,[{type:'oauth2',scopes:['memory:write']}]);
});

test('concurrent edits from one revision cannot overwrite each other',async()=>{
 const g=await fixture();toolValue(await tool(g,'memory_put',{key:'edit/race',value:'base',description:'base'}));
 const before=toolValue(await tool(g,'memory_get',{key:'edit/race'})).entry;
 const results=await Promise.all(['first','second'].map(async value=>toolValue(await tool(g,'memory_update',{key:before.key,value,description:value,expected_updated_at:before.updated_at}))));
 assert.equal(results.filter(r=>r.ok).length,1);assert.deepEqual(results.filter(r=>!r.ok).map(r=>r.reason),['conflict']);
 const current=toolValue(await tool(g,'memory_get',{key:before.key})).entry;assert.equal(current.value,results.find(r=>r.ok).entry.value);
 assert.equal(toolValue(await tool(g,'memory_workbench')).changes.length,2);
});

test('edits never create deleted, expired or unknown records or widen workspace and scope',async()=>{
 const g=await multiFixture();
 const args={key:'edit/live',value:'new',description:'new',expected_updated_at:0};
 assert.equal(toolValue(await tool(g,'memory_update',args)).reason,'missing_or_expired');
 toolValue(await tool(g,'memory_put',{workspace_id:g.first.id,key:args.key,value:'old',description:'old',ttl_seconds:3600}));
 const before=toolValue(await tool(g,'memory_get',{workspace_id:g.first.id,key:args.key})).entry;
 const actual={...args,workspace_id:g.first.id,expected_updated_at:before.updated_at};
 toolDenied(await tool(g,'memory_update',{...actual,workspace_id:g.unselected.id}));
 const readOnly=await fixture({owner:g.owner,target:g.first,params:{scope:'memory:read'}});
 toolDenied(await tool(readOnly,'memory_update',{...actual,workspace_id:g.first.id}),/insufficient_scope/);
 await db.prepare('UPDATE memory SET expires_at=1 WHERE tenant_id=? AND key=?').bind(g.first.id,args.key).run();
 assert.equal(toolValue(await tool(g,'memory_update',actual)).reason,'missing_or_expired');
 assert.equal((await db.prepare('SELECT value,expires_at FROM memory WHERE tenant_id=? AND key=?').bind(g.first.id,args.key).first()).expires_at,1);
 toolValue(await tool(g,'memory_delete',{workspace_id:g.first.id,key:args.key}));
 assert.equal(toolValue(await tool(g,'memory_update',actual)).reason,'missing_or_expired');
 assert.equal(await count('SELECT count(*) AS count FROM memory WHERE tenant_id=? AND key=?',[g.first.id,args.key]),0);
});

// API-key MCP fixtures reuse only the disposable account/D1 setup above.
async function mcpKey(owner, target, scopes = ['read', 'write', 'delete', 'gc']) {
  return parsed(await request(`/account/spaces/${target.id}/keys`, { method: 'POST', cookie: owner.cookie,
    body: { label: 'Disposable bot fixture', scopes, expires_at: Date.now() + 3600000 } }), 201);
}
const keyRpc = (key, method, params = {}, options = {}) => rpc(undefined, method, params, {
  ...options, key, headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...options.headers },
});
const keyTool = async (key, name, args = {}, options = {}) => rpcResult(await keyRpc(key, 'tools/call', { name, arguments: args }, options));

test('API-key MCP initializes both protocol versions, retains all ten Chinese tools and has key-specific metadata', async () => {
  const g = await fixture(), issued = await mcpKey(g.owner, g.target);
  for (const version of ['2025-03-26', '2025-11-25']) {
    const initialized = await rpcResult(await keyRpc(issued.api_key, 'initialize', {
      protocolVersion: version, capabilities: {}, clientInfo: { name: 'fake-bot', version: '1' },
    }, { headers: { 'MCP-Protocol-Version': version } }));
    assert.equal(initialized.result.protocolVersion, version);
    const listed = await rpcResult(await keyRpc(issued.api_key, 'tools/list'));
    assert.equal(listed.result.tools.length, 10);
    for (const item of listed.result.tools) {
      assert.match(item.description, /[\u4e00-\u9fff]/);
      assert.deepEqual(item._meta.securitySchemes, [{ type: 'apiKey', in: 'header', name: 'X-Api-Key' }]);
    }
  }
  const spaces = toolValue(await keyTool(issued.api_key, 'memory_workspaces'));
  assert.deepEqual(spaces.workspaces.map(w => w.id), [g.target.id]);
  assert.equal(spaces.workspaces[0].display_name, g.target.display_name);
  assert.equal(spaces.default_workspace_id, g.target.id);
  assert.deepEqual(spaces.permissions, SCOPES);
  const resource = await rpcResult(await keyRpc(issued.api_key, 'resources/read', { uri: 'ui://walle-memory/workbench-v1.html' }));
  assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.equal(JSON.stringify(resource).includes(issued.api_key), false);
  assert.equal((await rpc(g.access_token, 'tools/list')).status, 200);
  assert.equal((await request('/memory', { key: issued.api_key })).status, 200);
});

test('API-key CRUD, search, update conflicts, workbench and scoped GC keep the bound space isolated', async () => {
  const g = await fixture(), other = await space(g.owner, 'Same owner foreign space');
  const foreignOwner = await account('foreign-key-owner'), foreign = await space(foreignOwner);
  const issued = await mcpKey(g.owner, g.target);
  toolValue(await keyTool(issued.api_key, 'memory_put', { key: 'bot/item', value: 'fixture old', description: 'bottestuniqueterm', ttl_seconds: 3600 }));
  const before = toolValue(await keyTool(issued.api_key, 'memory_get', { key: 'bot/item' })).entry;
  assert.deepEqual(toolValue(await keyTool(issued.api_key, 'memory_list')).keys.map(k => k.key), ['bot/item']);
  assert.deepEqual(toolValue(await keyTool(issued.api_key, 'memory_summary')).entries.map(k => k.key), ['bot/item']);
  assert.equal(toolValue(await keyTool(issued.api_key, 'memory_search', { query: 'bottestuniqueterm' })).results.length, 1);
  const args = { key: 'bot/item', value: 'fixture edited', description: 'fixture summary', expected_updated_at: before.updated_at };
  assert.equal(toolValue(await keyTool(issued.api_key, 'memory_update', args)).ok, true);
  assert.equal(toolValue(await keyTool(issued.api_key, 'memory_update', args)).reason, 'conflict');
  assert.equal(toolValue(await keyTool(issued.api_key, 'memory_get', { key: 'bot/item' })).entry.expires_at, before.expires_at);
  assert.equal(toolValue(await keyTool(issued.api_key, 'memory_workbench')).workspace.id, g.target.id);
  for (const target of [other, foreign]) for (const [name, arguments_] of [
    ['memory_get', { key: 'bot/item' }], ['memory_list', {}], ['memory_summary', {}], ['memory_search', { query: 'fixture' }],
    ['memory_put', { key: 'cross', value: 'forbidden', description: 'forbidden' }], ['memory_update', args],
    ['memory_delete', { key: 'bot/item' }], ['memory_gc', {}], ['memory_workbench', {}],
  ]) toolDenied(await keyTool(issued.api_key, name, { ...arguments_, workspace_id: target.id }));
  for (const field of ['tenant_id', 'space_id', 'account_id', 'namespace']) {
    toolDenied(await keyTool(issued.api_key, 'memory_put', { key: 'cross', value: 'forbidden', description: 'forbidden', [field]: other.id }));
  }
  assert.equal(await count("SELECT count(*) AS count FROM memory WHERE key='cross'"), 0);
  await db.prepare('UPDATE memory SET expires_at=1 WHERE tenant_id=?').bind(g.target.id).run();
  await db.prepare('INSERT INTO memory (tenant_id,key,value,description,updated_at,expires_at) VALUES (?,?,?,?,?,?)')
    .bind(other.id, 'foreign-expired', 'retained', 'retained', 1, 1).run();
  assert.equal(toolValue(await keyTool(issued.api_key, 'memory_gc')).deleted, 1);
  assert.equal(await count('SELECT count(*) AS count FROM memory WHERE tenant_id=?', [other.id]), 1);
  toolValue(await keyTool(issued.api_key, 'memory_put', { key: 'delete/me', value: 'fixture', description: 'fixture' }));
  assert.equal(toolValue(await keyTool(issued.api_key, 'memory_delete', { key: 'delete/me' })).deleted, true);
});

test('each API-key scope permits only its operation and never triggers OAuth reauthorization', async () => {
  const g = await fixture();
  const cases = [
    ['read', 'memory_summary', {}], ['read', 'memory_workspaces', {}], ['read', 'memory_workbench', {}],
    ['read', 'memory_list', {}], ['read', 'memory_get', { key: 'scope' }], ['read', 'memory_search', { query: 'fixture' }],
    ['write', 'memory_put', { key: 'scope', value: 'fixture', description: 'fixture' }],
    ['write', 'memory_update', { key: 'missing', value: 'fixture', description: 'fixture', expected_updated_at: 0 }],
    ['delete', 'memory_delete', { key: 'scope' }], ['gc', 'memory_gc', {}],
  ];
  for (const scope of ['read', 'write', 'delete', 'gc']) {
    const issued = await mcpKey(g.owner, g.target, [scope]);
    for (const [required, name, args] of cases) {
      const response = await keyTool(issued.api_key, name, args);
      if (required === scope) toolValue(response);
      else {
        toolDenied(response);
        assert.equal(response.result._meta?.['mcp/www_authenticate'], undefined);
      }
    }
  }
});

test('credential selection rejects missing, malformed, duplicated, query, cookie and administrator credentials', async () => {
  const g = await fixture(), issued = await mcpKey(g.owner, g.target);
  for (const headers of [
    {}, { 'X-Api-Key': '' }, { 'X-Api-Key': 'fake-unknown-key' }, { 'X-Api-Key': 'x'.repeat(513) },
    { 'X-Api-Key': issued.api_key + ', ' + issued.api_key }, { 'X-Api-Key': 'invalid key' },
    { Authorization: 'Bearer ' + issued.api_key }, { Authorization: 'Basic fake' },
    { Authorization: 'Bearer ' + g.access_token + ', Bearer ' + g.access_token },
    { 'X-Api-Key': g.access_token }, { 'X-Api-Key': g.refresh_token }, { 'X-Api-Key': ADMIN }, { Cookie: g.owner.cookie },
  ]) assert.equal((await keyRpc(undefined, 'tools/list', {}, { headers })).status, 401);
  for (const query of ['api_key=', 'key=', 'access_token=']) {
    assert.equal((await request('/mcp?' + query + encodeURIComponent(issued.api_key), { method: 'POST', origin: null,
      headers: { Accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' } })).status, 401);
  }
  assert.equal((await keyRpc(undefined, 'tools/list')).headers.get('www-authenticate')?.startsWith('Bearer '), true);
  assert.equal((await keyRpc('invalid-key', 'tools/list')).headers.get('www-authenticate'), null);
  for (const path of ['/admin/tenants', '/admin/accounts']) assert.equal((await request(path, { key: issued.api_key })).status, 401);
});

test('any two authentication headers are ambiguous even if one is empty, invalid, expired or revoked', async () => {
  const g = await fixture(), issued = await mcpKey(g.owner, g.target);
  const { default: worker } = await import('../dist/index.js');
  for (const authorization of ['Bearer ' + g.access_token, 'Bearer invalid', '', 'Basic fake']) {
    for (const key of [issued.api_key, '', 'invalid-key', 'x'.repeat(513)]) {
      const headers = { Authorization: authorization, 'X-Api-Key': key };
      // Miniflare's loopback HTTP bridge removes empty header values. Exercise
      // the real built Worker directly when testing header presence with ''.
      const response = authorization && key
        ? await keyRpc(undefined, 'tools/list', {}, { headers })
        : await worker.fetch(new Request(RESOURCE, { method: 'POST', headers }), { OAUTH_ISSUER: BASE, DB: db });
      assert.equal(response.status, 400, `two headers: authorization length ${authorization.length}, key length ${key.length}`);
      await error(response, 400, 'multiple authentication methods');
    }
  }
  for (const mode of ['expired', 'revoked']) {
    const invalid = await mcpKey(g.owner, g.target);
    await db.prepare(mode === 'expired' ? 'UPDATE api_keys SET expires_at=1 WHERE id=?' : 'UPDATE api_keys SET revoked_at=1 WHERE id=?')
      .bind(invalid.key.id).run();
    assert.equal((await keyRpc(invalid.api_key, 'tools/list', {}, { token: g.access_token })).status, 400);
    assert.equal((await rpc(g.access_token, 'tools/list')).status, 200);
  }
  await revoke(g);
  assert.equal((await keyRpc(issued.api_key, 'tools/list', {}, { token: g.access_token })).status, 400);
  assert.equal((await rpc(g.access_token, 'tools/list')).status, 401);
  assert.equal((await keyRpc(issued.api_key, 'tools/list')).status, 200, 'independent key is still valid without the rejected bearer');
});

test('expired, revoked, transferred, deleted and disabled API-key authorities fail closed', async () => {
  for (const mode of ['expired', 'revoked', 'transferred', 'deleted', 'disabled']) {
    const g = await fixture(), issued = await mcpKey(g.owner, g.target);
    assert.equal((await keyRpc(issued.api_key, 'tools/list')).status, 200);
    if (mode === 'expired') await db.prepare('UPDATE api_keys SET expires_at=1 WHERE id=?').bind(issued.key.id).run();
    if (mode === 'revoked') assert.equal((await request(`/account/spaces/${g.target.id}/keys/${issued.key.id}`, { method: 'DELETE', cookie: g.owner.cookie })).status, 200);
    if (mode === 'disabled') await db.prepare('UPDATE accounts SET disabled_at=1 WHERE id=?').bind(g.owner.id).run();
    if (mode === 'transferred') await db.prepare('UPDATE tenants SET owner_account_id=? WHERE id=?').bind((await account('new-owner')).id, g.target.id).run();
    if (mode === 'deleted') await db.prepare('DELETE FROM tenants WHERE id=?').bind(g.target.id).run();
    assert.equal((await keyRpc(issued.api_key, 'tools/list')).status, 401, mode);
  }
});

test('legacy space keys preserve only their existing single-space memory authority and cannot bypass scoped revocation', async () => {
  const legacy = await parsed(await request('/admin/tenants', { method: 'POST', key: ADMIN, body: { name: 'mcp-key-legacy-fixture' } }), 201);
  assert.equal(toolValue(await keyTool(legacy.api_key, 'memory_workspaces')).workspaces.length, 1);
  toolValue(await keyTool(legacy.api_key, 'memory_put', { key: 'legacy', value: 'fixture', description: 'fixture' }));
  assert.equal((await request('/admin/tenants', { key: legacy.api_key })).status, 401);
  await db.prepare('UPDATE tenants SET legacy_key_revoked_at=1 WHERE id=?').bind(legacy.tenant.id).run();
  assert.equal((await keyRpc(legacy.api_key, 'tools/list')).status, 401);
  const g = await fixture(), issued = await mcpKey(g.owner, g.target, ['read']);
  await db.prepare('UPDATE tenants SET api_key_hash=? WHERE id=?').bind(digest(issued.api_key), g.target.id).run();
  await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE id=?').bind(issued.key.id).run();
  assert.equal((await keyRpc(issued.api_key, 'tools/list')).status, 401, 'revoked scoped key cannot fall back to legacy');
});

test('in-flight MCP key reads and writes recheck revocation, expiry, scope, owner and account in the D1 transaction', async () => {
  for (const mode of ['revoked', 'expired', 'scope', 'transferred', 'disabled']) for (const operation of ['read', 'write']) {
    const g = await fixture(), issued = await mcpKey(g.owner, g.target);
    toolValue(await keyTool(issued.api_key, 'memory_put', { key: 'race', value: 'original', description: 'original' }));
    const previous = await db.prepare('SELECT * FROM memory WHERE tenant_id=?').bind(g.target.id).first();
    const previousChanges = await count('SELECT count(*) AS count FROM memory_changes WHERE tenant_id=?', [g.target.id]);
    const start = Math.floor(Date.now() / 60000) * 60000;
    const buckets = [start, start + 60000].map(x => digest(`memory:${digest(issued.api_key)}:${x}`));
    const attempts = async () => (await db.prepare('SELECT SUM(attempts) AS count FROM auth_rate_limits WHERE bucket_hash IN (?,?)').bind(...buckets).first()).count;
    const priorAttempts = await attempts();
    const params = operation === 'read' ? { name: 'memory_get', arguments: { key: 'race' } }
      : { name: 'memory_update', arguments: { key: 'race', value: 'forbidden late write', description: 'forbidden', expected_updated_at: previous.updated_at } };
    const payload = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params });
    let controller, released = false;
    const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(payload.slice(0, -1))); } });
    const release = () => { if (!released) { released = true; controller.enqueue(new TextEncoder().encode('}')); controller.close(); } };
    const pending = mf.dispatchFetch(RESOURCE, { method: 'POST', headers: { 'X-Api-Key': issued.api_key, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }, body: stream, duplex: 'half' });
    try {
      await waitFor(async () => await attempts() === priorAttempts + 1, 'key resolved before credential state changes');
      if (mode === 'revoked') await db.prepare('UPDATE api_keys SET revoked_at=1 WHERE id=?').bind(issued.key.id).run();
      if (mode === 'expired') await db.prepare('UPDATE api_keys SET expires_at=1 WHERE id=?').bind(issued.key.id).run();
      if (mode === 'scope') await db.prepare('UPDATE api_keys SET scopes=? WHERE id=?').bind(JSON.stringify([operation === 'read' ? 'write' : 'read']), issued.key.id).run();
      if (mode === 'disabled') await db.prepare('UPDATE accounts SET disabled_at=1 WHERE id=?').bind(g.owner.id).run();
      if (mode === 'transferred') await db.prepare('UPDATE tenants SET owner_account_id=? WHERE id=?').bind((await account('inflight-new-owner')).id, g.target.id).run();
      release();
      const denied = await rpcResult(await pending);
      toolDenied(denied);
      assert.equal(denied.result._meta?.['mcp/www_authenticate'], undefined);
      assert.doesNotMatch(JSON.stringify(denied), /original|forbidden late write/);
      assert.deepEqual(await db.prepare('SELECT * FROM memory WHERE tenant_id=?').bind(g.target.id).first(), previous);
      assert.equal(await count('SELECT count(*) AS count FROM memory_changes WHERE tenant_id=?', [g.target.id]), previousChanges);
    } finally { release(); await pending.catch(() => {}); }
  }
});

test('API-key MCP and REST share rate limits and retain exact Origin and host restrictions', async () => {
  const g = await fixture(), issued = await mcpKey(g.owner, g.target, ['read']);
  const preflight = await request('/mcp', { method: 'OPTIONS', origin: 'https://chatgpt.com' });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Api-Key/);
  for (const origin of [BASE, 'https://chatgpt.com']) assert.equal((await keyRpc(issued.api_key, 'tools/list', {}, { origin })).status, 200);
  assert.equal((await keyRpc(issued.api_key, 'tools/list', {}, { origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await keyRpc(issued.api_key, 'tools/list', {}, { base: 'http://rebound.invalid' })).status, 403);
  const modern = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'fake-key-bot', version: '1' } };
  assert.equal((await keyRpc(issued.api_key, 'tools/list', { _meta: modern }, { headers: { 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'tools/list' } })).status, 200);
  const modernCall = await rpcResult(await keyRpc(issued.api_key, 'tools/call', { _meta: modern, name: 'memory_list', arguments: {} }, {
    headers: { 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'tools/call', 'MCP-Name': 'memory_list' },
  }));
  assert.deepEqual(toolValue(modernCall), { keys: [] });
  const windowStart = Math.floor(Date.now() / 60000) * 60000;
  for (const start of [windowStart, windowStart + 60000]) await db.prepare('INSERT OR REPLACE INTO auth_rate_limits (bucket_hash,window_start,attempts,expires_at) VALUES (?,?,?,?)')
    .bind(digest(`memory:${digest(issued.api_key)}:${start}`), start, 300, start + 120000).run();
  assert.equal((await keyRpc(issued.api_key, 'tools/list')).status, 429);
  assert.equal((await request('/memory', { key: issued.api_key })).status, 429);
  assert.equal((await rpc(g.access_token, 'tools/list')).status, 200, 'independent OAuth authority has its own bucket');
});
