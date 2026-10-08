import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Every database and credential in this file is disposable and stays in memory.
// No wrangler command, Cloudflare account, persistent D1 path, or network is used.
const ADMIN = 'test-only-admin-key';
const PASSWORD = 'test-only-long-password-2026';
const ALL_SCOPES = ['read', 'write', 'delete', 'gc'];
const digest = value => createHash('sha256').update(value).digest('hex');
let mf;
let db;
let nextId = 0;
let legacy;

async function request(path, {
  key, cookie, method = 'GET', body, raw, origin, headers = {}, ip = '192.0.2.1', base = 'http://localhost',
} = {}) {
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return mf.dispatchFetch(base + path, {
    method,
    headers: {
      'CF-Connecting-IP': ip,
      ...(key ? { 'X-Api-Key': key } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(origin === null ? {} : mutation ? { Origin: origin ?? base } : origin ? { Origin: origin } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

async function account(label = 'account') {
  const number = ++nextId;
  const email = `${label}-${number}@example.invalid`;
  const ip = `192.0.2.${number + 1}`;
  const response = await request('/admin/accounts', {
    key: ADMIN, method: 'POST', body: { email, display_name: label, password: PASSWORD }, ip,
  });
  assert.equal(response.status, 201, 'administrator can create a test account');
  const result = await response.json();
  const login = await request('/auth/login', { method: 'POST', body: { email, password: PASSWORD }, ip });
  assert.equal(login.status, 200, 'new account can log in');
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie?.startsWith('walle_session='), 'login issues the session cookie');
  return { ...result.account, email, ip, cookie: setCookie.split(';')[0], setCookie };
}

async function space(owner, display_name = 'Test space', memory_type = 'general') {
  const response = await request('/account/spaces', {
    cookie: owner.cookie, method: 'POST', body: { display_name, memory_type }, ip: owner.ip,
  });
  assert.equal(response.status, 201, 'account can create a memory space');
  return (await response.json()).space;
}

async function apiKey(owner, target, scopes = ALL_SCOPES, extras = {}) {
  const response = await request(`/account/spaces/${target.id}/keys`, {
    cookie: owner.cookie, method: 'POST', body: { label: 'Temporary test key', scopes, ...extras }, ip: owner.ip,
  });
  assert.equal(response.status, 201, 'owner can issue a temporary API key');
  const result = await response.json();
  assert.ok(typeof result.api_key === 'string' && result.api_key.length >= 32, 'key is returned on creation');
  return result;
}

const memoryPath = key => '/memory/' + encodeURIComponent(key);
const write = (key, name, value, description = 'test description', extras = {}) => request(memoryPath(name), {
  key, method: 'POST', body: { value, description, ...extras },
});
const json = async response => {
  assert.equal(response.status, 200);
  return response.json();
};
const rows = async sql => (await db.prepare(sql).all()).results;

async function waitFor(condition, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function applyMigration(name, targetDb = db) {
  const source = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
  for (const statement of source.split('-- statement-breakpoint').map(s => s.trim()).filter(Boolean)) {
    await targetDb.prepare(statement).run();
  }
}

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    modules: true,
    scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01',
    bindings: { API_KEY: ADMIN },
    d1Databases: ['DB'],
    outboundService: () => new Response('External network disabled in account tests', { status: 403 }),
  }));
  db = await mf.getD1Database('DB');
  const migrations = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  assert.equal(migrations[0], '0001_initial.sql');
  await applyMigration(migrations[0]);
  legacy = { id: 'preexisting-legacy', name: 'Preexisting legacy tenant', rawKey: 'temporary-legacy-test-key', created_at: 1700000000000 };
  await db.prepare('INSERT INTO tenants(id,name,api_key_hash,created_at) VALUES(?,?,?,?)')
    .bind(legacy.id, legacy.name, digest(legacy.rawKey), legacy.created_at).run();
  await db.prepare('INSERT INTO memory(key,tenant_id,value,description,access_count,last_accessed_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
    .bind('legacy/item', legacy.id, 'legacy value', 'migrationuniqueterm', 7, 1700000001000, 1700000002000, null).run();
  legacy.before = await db.prepare('SELECT * FROM memory WHERE tenant_id = ?').bind(legacy.id).first();
  assert.ok(migrations.length >= 2, 'account migration must be present');
  for (const name of migrations.slice(1)) await applyMigration(name);
});

after(async () => { await mf?.dispose(); });

test('account migration preserves legacy tenant IDs, hashes, memory counters and FTS', async () => {
  const row = await db.prepare('SELECT id,name,api_key_hash,created_at,owner_account_id,legacy_key_revoked_at FROM tenants WHERE id = ?').bind(legacy.id).first();
  assert.equal(row.id, legacy.id);
  assert.equal(row.name, legacy.name);
  assert.equal(row.api_key_hash === digest(legacy.rawKey), true, 'legacy hash is unchanged');
  assert.equal(row.created_at, legacy.created_at);
  assert.equal(row.owner_account_id, null);
  assert.equal(row.legacy_key_revoked_at, null);
  assert.deepEqual(await db.prepare('SELECT * FROM memory WHERE tenant_id = ?').bind(legacy.id).first(), legacy.before);
  const found = await json(await request('/memory/search?q=migrationuniqueterm', { key: legacy.rawKey }));
  assert.deepEqual(found.results.map(item => item.key), ['legacy/item']);
  assert.equal((await request('/memory', { key: legacy.rawKey })).status, 200);
});

test('registration is closed by default and admin account routes fail closed', async () => {
  assert.deepEqual(await json(await request('/auth/config')), { registration_mode: 'admin' });
  assert.equal((await request('/auth/register', { method: 'POST', body: {
    email: 'public@example.invalid', display_name: 'Public', password: PASSWORD,
  } })).status, 403);
  assert.equal((await request('/admin/accounts')).status, 401);
  assert.equal((await request('/admin/accounts', { method: 'POST', body: {} })).status, 401);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE email='public@example.invalid'").first()).count, 0);
  const unconfigured = new Miniflare(convertV4MiniflareOptions({
    cf: false, modules: true, scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'],
    outboundService: () => new Response('External network disabled in account tests', { status: 403 }),
  }));
  try {
    assert.equal((await unconfigured.dispatchFetch('http://localhost/admin/accounts')).status, 503);
  } finally { await unconfigured.dispose(); }
});

test('administrator creates normalized accounts and responses exclude password material', async () => {
  const owner = await account('normalized');
  const duplicate = await request('/admin/accounts', { key: ADMIN, method: 'POST', body: {
    email: `  ${owner.email.toUpperCase()}  `, display_name: 'Duplicate', password: PASSWORD,
  } });
  assert.equal(duplicate.status, 409);
  const list = await json(await request('/admin/accounts', { key: ADMIN }));
  const listed = list.accounts.find(item => item.id === owner.id);
  assert.deepEqual(Object.keys(listed).sort(), ['created_at', 'display_name', 'email', 'id']);
  assert.equal(listed.email, owner.email);
  const row = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(owner.id).first();
  assert.equal(JSON.stringify(row).includes(PASSWORD), false, 'password is never stored as plaintext');
  assert.match(row.password_hash, /^[a-f0-9]{64}$/);
  assert.match(row.password_salt, /^[a-f0-9]{64}$/);
  assert.ok(row.password_iterations >= 100000);
  const other = await account('distinct-salt');
  const otherRow = await db.prepare('SELECT password_hash,password_salt FROM accounts WHERE id=?').bind(other.id).first();
  assert.equal(row.password_hash === otherRow.password_hash, false, 'identical passwords get independent hashes');
  assert.equal(row.password_salt === otherRow.password_salt, false, 'each account gets its own salt');
  assert.equal((await request('/admin/accounts', { cookie: owner.cookie })).status, 401);
});

test('invalid account inputs and malformed auth JSON return controlled errors', async () => {
  for (const body of [
    { email: 'bad', display_name: 'Test', password: PASSWORD },
    { email: 'bad-password@example.invalid', display_name: 'Test', password: 'too-short' },
    { email: 'bad-name@example.invalid', display_name: '', password: PASSWORD },
    { email: 'oversize@example.invalid', display_name: 'Test', password: 'x'.repeat(1025) },
  ]) assert.equal((await request('/admin/accounts', { key: ADMIN, method: 'POST', body })).status, 400);
  for (const raw of ['null', '[]', '{']) {
    assert.equal((await request('/auth/login', { method: 'POST', raw, ip: '192.0.2.200' })).status, 400);
    assert.equal((await request('/admin/accounts', { key: ADMIN, method: 'POST', raw })).status, 400);
  }
});

test('login returns the same generic failure for nonexistent accounts and wrong passwords', async () => {
  const owner = await account('generic-login');
  const unknown = await request('/auth/login', { method: 'POST', body: { email: 'missing@example.invalid', password: PASSWORD }, ip: '192.0.2.201' });
  const wrong = await request('/auth/login', { method: 'POST', body: { email: owner.email, password: 'incorrect-long-test-password' }, ip: '192.0.2.202' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(await unknown.json(), await wrong.json());
  assert.equal(unknown.headers.has('set-cookie'), false);
  assert.equal(wrong.headers.has('set-cookie'), false);
  assert.equal((await request('/auth/me')).status, 401);
  assert.equal((await request('/auth/me', { cookie: 'walle_session=invalid' })).status, 401);
});

test('session cookies are protected and only hashed tokens are stored', async () => {
  const owner = await account('session-hash');
  assert.match(owner.setCookie, /HttpOnly/i);
  assert.match(owner.setCookie, /SameSite=Strict/i);
  assert.match(owner.setCookie, /Path=\//i);
  assert.match(owner.setCookie, /Max-Age=604800/i);
  const token = owner.cookie.slice('walle_session='.length);
  const session = await db.prepare('SELECT * FROM account_sessions WHERE account_id=?').bind(owner.id).first();
  assert.equal(session.token_hash === digest(token), true, 'database contains the token digest');
  assert.equal(JSON.stringify(session).includes(token), false, 'database never contains the raw session token');
  assert.equal(session.expires_at - session.created_at, 7 * 24 * 60 * 60 * 1000);
  const me = await json(await request('/auth/me', { cookie: owner.cookie }));
  assert.equal(me.account.id, owner.id);
  assert.equal(JSON.stringify(me).includes('password'), false);
  const secureLogin = await request('/auth/login', { base: 'https://localhost', method: 'POST', body: { email: owner.email, password: PASSWORD }, ip: owner.ip });
  assert.equal(secureLogin.status, 200);
  const secureCookie = secureLogin.headers.get('set-cookie');
  assert.match(secureCookie, /^__Host-walle_session=/);
  assert.match(secureCookie, /;\s*Secure(?:;|$)/i);
  assert.equal(/;\s*Domain=/i.test(secureCookie), false, 'host-bound cookie never sets Domain');
  assert.equal((await request('/auth/me', { base: 'https://localhost', cookie: secureCookie.split(';')[0] })).status, 200);
  assert.equal((await request('/auth/me', { base: 'https://localhost', cookie: owner.cookie })).status, 401, 'HTTPS never accepts the development cookie');
});

test('expired and logged-out sessions fail while CSRF rejection keeps the valid session', async () => {
  const owner = await account('session-lifecycle');
  const denied = await request('/auth/logout', { cookie: owner.cookie, method: 'POST', origin: 'https://attacker.invalid' });
  assert.equal(denied.status, 403);
  assert.equal((await request('/auth/me', { cookie: owner.cookie })).status, 200);
  const logout = await request('/auth/logout', { cookie: owner.cookie, method: 'POST' });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i);
  assert.equal((await request('/auth/me', { cookie: owner.cookie })).status, 401);
  const expired = await account('expired-session');
  await db.prepare('UPDATE account_sessions SET expires_at=1 WHERE account_id=?').bind(expired.id).run();
  assert.equal((await request('/auth/me', { cookie: expired.cookie })).status, 401);
});

test('auth and account mutations require same-origin requests', async () => {
  const owner = await account('csrf');
  for (const origin of [null, 'https://attacker.invalid']) {
    assert.equal((await request('/auth/login', { method: 'POST', origin, body: { email: owner.email, password: PASSWORD } })).status, 403);
    assert.equal((await request('/account/spaces', { cookie: owner.cookie, method: 'POST', origin, body: { display_name: 'Rejected', memory_type: 'general' } })).status, 403);
  }
  const target = await space(owner);
  const issued = await apiKey(owner, target);
  assert.equal((await request(`/account/spaces/${target.id}/keys`, { cookie: owner.cookie, method: 'POST', origin: 'https://attacker.invalid', body: { label: 'Rejected', scopes: ALL_SCOPES } })).status, 403);
  assert.equal((await request(`/account/spaces/${target.id}`, { cookie: owner.cookie, method: 'DELETE', origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request(`/account/spaces/${target.id}/keys/${issued.key.id}`, { cookie: owner.cookie, method: 'DELETE', origin: null })).status, 403);
  assert.equal((await request(`/account/spaces/${target.id}/revoke-legacy-key`, { cookie: owner.cookie, method: 'POST', origin: 'https://attacker.invalid' })).status, 403);
  assert.equal((await request('/account/spaces', { cookie: owner.cookie, method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' }, body: { display_name: 'Rejected', memory_type: 'general' } })).status, 403);
  assert.equal((await request('/account/spaces', { cookie: owner.cookie, method: 'POST', base: 'http://service.invalid', body: { display_name: 'Rejected', memory_type: 'general' } })).status, 403);
  assert.equal((await request('/memory', { key: issued.api_key })).status, 200, 'rejected revocation leaves the key active');
  assert.equal((await request('/account/spaces', { cookie: owner.cookie })).status, 200);
});

test('an account starts empty and cannot claim an existing legacy tenant', async () => {
  const owner = await account('empty-account');
  assert.deepEqual((await json(await request('/account/spaces', { cookie: owner.cookie }))).spaces, []);
  assert.equal((await request(`/account/spaces/${legacy.id}/keys`, { cookie: owner.cookie })).status, 404);
  assert.equal((await request(`/account/spaces/${legacy.id}/keys`, { cookie: owner.cookie, method: 'POST', body: { label: 'Stolen', scopes: ALL_SCOPES } })).status, 404);
  assert.equal((await request(`/admin/accounts/${owner.id}/spaces/${legacy.id}/claim`, { cookie: owner.cookie, method: 'POST', body: {} })).status, 401);
  const attempt = await request('/account/spaces', { cookie: owner.cookie, method: 'POST', body: {
    display_name: legacy.name, memory_type: 'general', id: legacy.id, tenant_id: legacy.id, owner_account_id: owner.id,
  }, ip: owner.ip });
  assert.equal(attempt.status, 201);
  const created = (await attempt.json()).space;
  assert.equal(created.id === legacy.id, false, 'provided ID cannot overwrite an existing tenant');
  assert.equal((await db.prepare('SELECT owner_account_id FROM tenants WHERE id=?').bind(legacy.id).first()).owner_account_id, null);
});

test('memory spaces have independent IDs and retain display labels and memory types', async () => {
  const owner = await account('space-metadata');
  const first = await space(owner, 'Same label', 'semantic');
  const second = await space(owner, 'Same label', 'episodic');
  assert.equal(first.id === second.id, false);
  assert.equal(first.name === second.name, false, 'internal tenant names are unique');
  assert.equal(first.display_name, 'Same label');
  assert.equal(first.memory_type, 'semantic');
  assert.equal(second.memory_type, 'episodic');
  assert.equal(first.legacy_key_active, false);
  const listed = (await json(await request('/account/spaces', { cookie: owner.cookie }))).spaces;
  assert.deepEqual(listed.map(item => item.id).sort(), [first.id, second.id].sort());
  const row = await db.prepare('SELECT * FROM tenants WHERE id=?').bind(first.id).first();
  assert.equal(row.owner_account_id, owner.id);
  assert.ok(row.legacy_key_revoked_at > 0);
  assert.equal((await request(`/account/spaces/${first.id}/revoke-legacy-key`, { cookie: owner.cookie, method: 'POST', body: {} })).status, 200);
  const after = await db.prepare('SELECT api_key_hash FROM tenants WHERE id=?').bind(first.id).first();
  assert.equal(after.api_key_hash === row.api_key_hash, true, 'already disabled placeholder hash remains stable');
});

test('cross-account management routes hide ownership with 404', async () => {
  const owner = await account('owner');
  const stranger = await account('stranger');
  const target = await space(owner);
  const issued = await apiKey(owner, target);
  for (const [path, method, body] of [
    [`/account/spaces/${target.id}/keys`, 'GET'],
    [`/account/spaces/${target.id}/keys`, 'POST', { label: 'Stolen', scopes: ALL_SCOPES }],
    [`/account/spaces/${target.id}/keys/${issued.key.id}`, 'DELETE'],
    [`/account/spaces/${target.id}/revoke-legacy-key`, 'POST', {}],
    [`/account/spaces/${target.id}`, 'DELETE'],
  ]) assert.equal((await request(path, { cookie: stranger.cookie, method, body, ip: stranger.ip })).status, 404);
  assert.equal((await request('/account/spaces', { key: issued.api_key })).status, 401);
  assert.equal((await request('/admin/accounts', { key: issued.api_key })).status, 401);
  assert.equal((await request('/memory', { cookie: owner.cookie })).status, 401);
  assert.equal((await request('/memory', { key: ADMIN })).status, 401);
  assert.equal((await db.prepare('SELECT owner_account_id FROM tenants WHERE id=?').bind(target.id).first()).owner_account_id, owner.id);
  assert.equal((await db.prepare('SELECT revoked_at FROM api_keys WHERE id=?').bind(issued.key.id).first()).revoked_at, null);
});

test('scoped API keys are shown once and persisted/listed only as hashes and metadata', async () => {
  const owner = await account('key-hash');
  const target = await space(owner);
  const issued = await apiKey(owner, target, ['read', 'write']);
  assert.equal(issued.key.space_id, target.id);
  assert.deepEqual(issued.key.scopes, ['read', 'write']);
  assert.equal(issued.key.revoked_at, null);
  assert.equal(issued.key.expires_at, null);
  const row = await db.prepare('SELECT * FROM api_keys WHERE id=?').bind(issued.key.id).first();
  assert.equal(row.key_hash === digest(issued.api_key), true, 'stored key is its SHA-256 digest');
  assert.equal(JSON.stringify(row).includes(issued.api_key), false, 'database does not contain the raw key');
  assert.equal(row.account_id, owner.id);
  const list = await json(await request(`/account/spaces/${target.id}/keys`, { cookie: owner.cookie }));
  assert.equal(JSON.stringify(list).includes(issued.api_key), false, 'list never returns the raw key');
  assert.equal(JSON.stringify(list).includes('key_hash'), false, 'list also hides internal hashes');
  assert.deepEqual(Object.keys(list.keys[0]).sort(), ['created_at', 'expires_at', 'id', 'label', 'prefix', 'revoked_at', 'scopes', 'space_id']);
});

test('invalid API key scopes and expiry are rejected before issuance', async () => {
  const owner = await account('invalid-key');
  const target = await space(owner);
  for (const body of [
    { label: 'Bad', scopes: [] }, { label: 'Bad', scopes: ['admin'] }, { label: 'Bad', scopes: 'read' },
    { label: 'Bad', scopes: ['read'], expires_at: 1 }, { label: '', scopes: ['read'] },
  ]) assert.equal((await request(`/account/spaces/${target.id}/keys`, { cookie: owner.cookie, method: 'POST', body, ip: owner.ip })).status, 400);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE space_id=?').bind(target.id).first()).count, 0);
});

test('same-account spaces isolate CRUD, search, list and summary for identical memory keys', async () => {
  const owner = await account('isolated-spaces');
  const first = await space(owner, 'First', 'semantic');
  const second = await space(owner, 'Second', 'episodic');
  const a = (await apiKey(owner, first)).api_key;
  const b = (await apiKey(owner, second)).api_key;
  assert.equal((await write(a, 'shared/key', 'first value', 'firstonlyuniqueterm')).status, 200);
  assert.equal((await write(b, 'shared/key', 'second value', 'secondonlyuniqueterm')).status, 200);
  assert.equal((await json(await request(memoryPath('shared/key'), { key: a }))).value, 'first value');
  assert.equal((await json(await request(memoryPath('shared/key'), { key: b }))).value, 'second value');
  assert.deepEqual((await json(await request('/memory/search?q=secondonlyuniqueterm', { key: a }))).results, []);
  assert.deepEqual((await json(await request('/memory/search?q=firstonlyuniqueterm', { key: b }))).results, []);
  const summary = await json(await request('/summary', { key: a }));
  assert.equal(summary.tenant, first.display_name, 'summary presents the human-readable space label');
  assert.deepEqual(summary.entries.map(item => item.description), ['firstonlyuniqueterm']);
  assert.ok(summary.entries.every(item => !('value' in item)));
  assert.deepEqual((await json(await request('/memory?prefix=shared%2F', { key: a }))).keys.map(item => item.description), ['firstonlyuniqueterm']);
  assert.equal((await request(memoryPath('shared/key'), { key: a, method: 'PUT', body: { value: 'updated first', description: 'updatedfirstuniqueterm' } })).status, 200);
  assert.equal((await json(await request(memoryPath('shared/key'), { key: b }))).value, 'second value');
  assert.equal((await request(memoryPath('shared/key'), { key: a, method: 'DELETE' })).status, 200);
  assert.equal((await request(memoryPath('shared/key'), { key: a })).status, 404);
  assert.equal((await request(memoryPath('shared/key'), { key: b })).status, 200);
});

test('partition identifiers in headers, query and body cannot override an API key', async () => {
  const owner = await account('partition-spoof');
  const victim = await account('partition-victim');
  const own = await space(owner);
  const other = await space(victim);
  const a = (await apiKey(owner, own)).api_key;
  const b = (await apiKey(victim, other)).api_key;
  await write(b, 'victim/item', 'private value', 'victimuniqueterm');
  const forged = { 'X-Tenant-Id': other.id, 'X-Space-Id': other.id, 'X-Account-Id': victim.id };
  const query = `?tenant_id=${other.id}&space_id=${other.id}&account_id=${victim.id}`;
  assert.equal((await request(memoryPath('victim/item') + query, { key: a, headers: forged })).status, 404);
  assert.deepEqual((await json(await request('/memory' + query, { key: a, headers: forged }))).keys, []);
  assert.deepEqual((await json(await request('/memory/search?q=victimuniqueterm&tenant_id=' + other.id, { key: a, headers: forged }))).results, []);
  assert.deepEqual((await json(await request('/summary' + query, { key: a, headers: forged }))).entries, []);
  assert.equal((await request(memoryPath('forged/item') + query, { key: a, method: 'POST', headers: forged, body: {
    value: 'own value', description: 'forgeduniqueterm', tenant_id: other.id, space_id: other.id, account_id: victim.id,
  } })).status, 200);
  const inserted = await db.prepare('SELECT tenant_id FROM memory WHERE key=?').bind('forged/item').first();
  assert.equal(inserted.tenant_id, own.id);
  assert.equal((await request(memoryPath('victim/item') + query, { key: a, method: 'DELETE', headers: forged })).status, 404);
  assert.equal((await request(memoryPath('victim/item'), { key: b })).status, 200);
});

test('read-only API keys allow reads and reject every memory mutation', async () => {
  const owner = await account('read-only');
  const target = await space(owner);
  const full = (await apiKey(owner, target)).api_key;
  const read = (await apiKey(owner, target, ['read'])).api_key;
  await write(full, 'protected', 'value', 'readuniqueterm');
  for (const path of ['/memory', memoryPath('protected'), '/summary', '/memory/search?q=readuniqueterm']) {
    assert.equal((await request(path, { key: read })).status, 200);
  }
  for (const [path, method, body] of [
    [memoryPath('protected'), 'POST', { value: 'changed', description: '' }],
    [memoryPath('protected'), 'PUT', { value: 'changed', description: '' }],
    [memoryPath('protected'), 'DELETE'], ['/memory/gc', 'POST', {}],
  ]) assert.equal((await request(path, { key: read, method, body })).status, 403);
  assert.equal((await json(await request(memoryPath('protected'), { key: full }))).value, 'value');
});

test('cookie identity cannot elevate a scoped key and rejected reads leave access counters unchanged', async () => {
  const owner = await account('mixed-identity');
  const target = await space(owner);
  const full = (await apiKey(owner, target)).api_key;
  const readOnly = (await apiKey(owner, target, ['read'])).api_key;
  const writeOnly = (await apiKey(owner, target, ['write'])).api_key;
  await write(full, 'mixed/item', 'protected value');
  assert.equal((await request(memoryPath('mixed/item'), { cookie: owner.cookie, key: readOnly, method: 'PUT', body: { value: 'changed', description: '' } })).status, 403);
  assert.equal((await request(memoryPath('mixed/item'), { cookie: owner.cookie, key: writeOnly })).status, 403);
  const row = await db.prepare('SELECT value,access_count,last_accessed_at FROM memory WHERE tenant_id=? AND key=?').bind(target.id, 'mixed/item').first();
  assert.equal(row.value, 'protected value');
  assert.equal(row.access_count, 0);
  assert.equal(row.last_accessed_at, null);
  assert.equal((await request('/auth/me', { key: full })).status, 401);
  assert.equal((await request('/auth/me', { cookie: `${owner.cookie}; ${owner.cookie}` })).status, 401);
});

test('a key ID from another owned space cannot be revoked through the wrong space path', async () => {
  const owner = await account('wrong-key-space');
  const first = await space(owner, 'First');
  const second = await space(owner, 'Second');
  const issued = await apiKey(owner, second);
  assert.equal((await request(`/account/spaces/${first.id}/keys/${issued.key.id}`, { cookie: owner.cookie, method: 'DELETE' })).status, 404);
  assert.equal((await request('/memory', { key: issued.api_key })).status, 200);
  assert.equal((await db.prepare('SELECT revoked_at FROM api_keys WHERE id=?').bind(issued.key.id).first()).revoked_at, null);
});

test('write-only, delete-only and GC-only permissions do not implicitly grant read access', async () => {
  const owner = await account('narrow-scopes');
  const target = await space(owner);
  const writeOnly = (await apiKey(owner, target, ['write'])).api_key;
  const deleteOnly = (await apiKey(owner, target, ['delete'])).api_key;
  const gcOnly = (await apiKey(owner, target, ['gc'])).api_key;
  assert.equal((await write(writeOnly, 'scope/item', 'value')).status, 200);
  for (const key of [writeOnly, deleteOnly, gcOnly]) {
    for (const path of ['/memory', memoryPath('scope/item'), '/summary', '/memory/search?q=test']) {
      assert.equal((await request(path, { key })).status, 403);
    }
  }
  assert.equal((await request(memoryPath('scope/item'), { key: writeOnly, method: 'DELETE' })).status, 403);
  assert.equal((await request('/memory/gc', { key: writeOnly, method: 'POST' })).status, 403);
  assert.equal((await write(deleteOnly, 'new', 'value')).status, 403);
  assert.equal((await request('/memory/gc', { key: deleteOnly, method: 'POST' })).status, 403);
  assert.equal((await request(memoryPath('scope/item'), { key: deleteOnly, method: 'DELETE' })).status, 200);
  assert.equal((await write(gcOnly, 'new', 'value')).status, 403);
  assert.equal((await request(memoryPath('scope/item'), { key: gcOnly, method: 'DELETE' })).status, 403);
  assert.equal((await request('/memory/gc', { key: gcOnly, method: 'POST' })).status, 200);
});

test('revocation and expiry invalidate keys without deleting memories', async () => {
  const owner = await account('key-lifecycle');
  const target = await space(owner);
  const revoked = await apiKey(owner, target);
  const expired = await apiKey(owner, target, ALL_SCOPES, { expires_at: Date.now() + 60_000 });
  const survivor = await apiKey(owner, target);
  await write(revoked.api_key, 'kept', 'surviving value');
  assert.equal((await request('/memory', { key: expired.api_key })).status, 200, 'key works before its expiry');
  assert.equal((await request(`/account/spaces/${target.id}/keys/${revoked.key.id}`, { cookie: owner.cookie, method: 'DELETE' })).status, 200);
  assert.equal((await request('/memory', { key: revoked.api_key })).status, 401);
  const row = await db.prepare('SELECT revoked_at FROM api_keys WHERE id=?').bind(revoked.key.id).first();
  assert.ok(row.revoked_at > 0);
  await db.prepare('UPDATE api_keys SET expires_at=1 WHERE id=?').bind(expired.key.id).run();
  assert.equal((await request('/memory', { key: expired.api_key })).status, 401);
  assert.equal((await json(await request(memoryPath('kept'), { key: survivor.api_key }))).value, 'surviving value');
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM memory WHERE tenant_id=?').bind(target.id).first()).count, 1);
});

test('a delayed memory write cannot commit after its key is revoked, expired or its account disabled', async () => {
  for (const mode of ['revoked', 'expired', 'disabled']) {
    const owner = await account('delayed-' + mode);
    const target = await space(owner);
    const issued = await apiKey(owner, target);
    const memoryKey = 'delayed/' + mode;
    const windowStart = Math.floor(Date.now() / 60000) * 60000;
    const buckets = [windowStart, windowStart + 60000].map(start => digest(`memory:${digest(issued.api_key)}:${start}`));
    let controller;
    let released = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({ start(value) {
      controller = value;
      // Send a first chunk so the runtime receives the headers and enters the
      // handler, but keep the JSON incomplete until authorization is removed.
      controller.enqueue(encoder.encode('{"value":"late test value","description":'));
    } });
    const release = () => {
      if (released) return;
      released = true;
      controller.enqueue(encoder.encode('"delayeduniqueterm"}'));
      controller.close();
    };
    const pending = mf.dispatchFetch('http://localhost' + memoryPath(memoryKey), {
      method: 'POST', headers: { 'X-Api-Key': issued.api_key, 'Content-Type': 'application/json' },
      body: stream, duplex: 'half',
    });
    try {
      // The memory limiter runs after initial credential and scope checks, but
      // before body parsing. Observing its atomic counter proves this is a
      // revoke-during-request test rather than a request with an invalid key.
      await waitFor(async () => {
        const row = await db.prepare('SELECT SUM(attempts) AS count FROM auth_rate_limits WHERE bucket_hash IN (?,?)').bind(...buckets).first();
        return row.count === 1;
      }, 'streamed request must complete initial authorization before credentials change');
      if (mode === 'revoked') {
        assert.equal((await request(`/account/spaces/${target.id}/keys/${issued.key.id}`, { cookie: owner.cookie, method: 'DELETE' })).status, 200);
      } else if (mode === 'expired') {
        await db.prepare('UPDATE api_keys SET expires_at=1 WHERE id=?').bind(issued.key.id).run();
      } else {
        await db.prepare('UPDATE accounts SET disabled_at=? WHERE id=?').bind(Date.now(), owner.id).run();
      }
      release();
      const response = await pending;
      assert.equal(response.status, 401, 'changed credentials reject a previously authenticated write');
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM memory WHERE tenant_id=? AND key=?').bind(target.id, memoryKey).first()).count, 0);
      assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH 'delayeduniqueterm'").first()).count, 0);
    } finally {
      release();
      await pending.catch(() => {});
    }
  }
});

test('revoked scoped credentials cannot fall back to a matching active legacy credential', async () => {
  const owner = await account('legacy-fallback');
  const target = await space(owner);
  const issued = await apiKey(owner, target);
  await db.prepare('UPDATE tenants SET api_key_hash=?,legacy_key_revoked_at=NULL WHERE id=?').bind(digest(issued.api_key), target.id).run();
  assert.equal((await request('/memory', { key: issued.api_key })).status, 200);
  await request(`/account/spaces/${target.id}/keys/${issued.key.id}`, { cookie: owner.cookie, method: 'DELETE' });
  assert.equal((await request('/memory', { key: issued.api_key })).status, 401);
});

test('disabling an account immediately rejects its sessions, scoped keys and claimed legacy keys', async () => {
  const owner = await account('disabled-owner');
  const target = await space(owner);
  const issued = await apiKey(owner, target);
  const legacyResponse = await request('/admin/tenants', { key: ADMIN, method: 'POST', body: { name: 'Disabled legacy owner' } });
  assert.equal(legacyResponse.status, 201);
  const old = await legacyResponse.json();
  assert.equal((await request(`/admin/accounts/${owner.id}/spaces/${old.tenant.id}/claim`, { key: ADMIN, method: 'POST', body: {} })).status, 200);
  await write(issued.api_key, 'kept', 'unchanged');
  await db.prepare('UPDATE accounts SET disabled_at=? WHERE id=?').bind(Date.now(), owner.id).run();
  assert.equal((await request('/auth/me', { cookie: owner.cookie })).status, 401);
  assert.equal((await request('/account/spaces', { cookie: owner.cookie })).status, 401);
  assert.equal((await request('/memory', { key: issued.api_key })).status, 401);
  assert.equal((await request('/memory', { key: old.api_key })).status, 401);
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: owner.email, password: PASSWORD }, ip: owner.ip })).status, 401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM memory WHERE tenant_id=?').bind(target.id).first()).count, 1);
});

test('expired memory is hidden and GC cannot delete another memory space', async () => {
  const owner = await account('scoped-gc');
  const first = await space(owner, 'GC first');
  const second = await space(owner, 'GC second');
  const a = (await apiKey(owner, first)).api_key;
  const b = (await apiKey(owner, second)).api_key;
  await write(a, 'expired', 'old', 'expireuniqueterm', { ttl_seconds: 60 });
  await write(b, 'expired', 'old', 'expireuniqueterm', { ttl_seconds: 60 });
  await db.prepare('UPDATE memory SET expires_at=1 WHERE tenant_id IN (?,?)').bind(first.id, second.id).run();
  assert.equal((await request(memoryPath('expired'), { key: a })).status, 404);
  assert.deepEqual((await json(await request('/memory', { key: a }))).keys, []);
  assert.deepEqual((await json(await request('/summary', { key: a }))).entries, []);
  assert.deepEqual((await json(await request('/memory/search?q=expireuniqueterm', { key: a }))).results, []);
  const gc = await json(await request('/memory/gc?tenant_id=' + second.id, { key: a, method: 'POST', body: { tenant_id: second.id } }));
  assert.equal(gc.deleted, 1);
  const remaining = await db.prepare('SELECT tenant_id FROM memory WHERE tenant_id IN (?,?)').bind(first.id, second.id).all();
  assert.deepEqual(remaining.results.map(row => row.tenant_id), [second.id]);
});

test('only an administrator can explicitly bind a legacy tenant and ownership cannot be stolen', async () => {
  const owner = await account('legacy-owner');
  const other = await account('legacy-other');
  const claim = await request(`/admin/accounts/${owner.id}/spaces/${legacy.id}/claim`, { key: ADMIN, method: 'POST', body: {
    display_name: 'Imported space', memory_type: 'semantic',
  } });
  assert.equal(claim.status, 200);
  const claimed = (await claim.json()).space;
  assert.equal(claimed.id, legacy.id);
  assert.equal(claimed.display_name, 'Imported space');
  assert.equal(claimed.legacy_key_active, true);
  assert.equal((await request('/memory', { key: legacy.rawKey })).status, 200);
  const scoped = await apiKey(owner, claimed);
  const item = await json(await request(memoryPath('legacy/item'), { key: scoped.api_key }));
  assert.equal(item.value, 'legacy value');
  assert.equal(item.access_count, 7);
  assert.equal((await request(`/admin/accounts/${other.id}/spaces/${legacy.id}/claim`, { key: ADMIN, method: 'POST', body: {} })).status, 409);
  assert.equal((await request(`/admin/accounts/${owner.id}/spaces/${legacy.id}/claim`, { key: ADMIN, method: 'POST', body: {} })).status, 200);
  assert.equal((await request(`/account/spaces/${legacy.id}/keys`, { cookie: other.cookie })).status, 404);
  assert.equal((await request(`/account/spaces/${legacy.id}/revoke-legacy-key`, { cookie: owner.cookie, method: 'POST', body: {} })).status, 200);
  assert.equal((await request('/memory', { key: legacy.rawKey })).status, 401);
  assert.equal((await request('/memory', { key: scoped.api_key })).status, 200);
  const after = await db.prepare('SELECT api_key_hash FROM tenants WHERE id=?').bind(legacy.id).first();
  assert.equal(after.api_key_hash === digest(legacy.rawKey), false, 'owner revocation destroys the old legacy hash');
  assert.equal(await db.prepare('SELECT id FROM tenants WHERE api_key_hash=?').bind(digest(legacy.rawKey)).first(), null, 'old Worker hash lookup also rejects the credential');
  assert.equal((await request(`/account/spaces/${legacy.id}/revoke-legacy-key`, { cookie: owner.cookie, method: 'POST', body: {} })).status, 200);
  assert.equal((await db.prepare('SELECT api_key_hash FROM tenants WHERE id=?').bind(legacy.id).first()).api_key_hash === after.api_key_hash, true, 'repeated owner revocation is idempotent');
});

test('concurrent administrator claims assign an unowned legacy tenant to only one account', async () => {
  const first = await account('concurrent-owner-a');
  const second = await account('concurrent-owner-b');
  const tenantResponse = await request('/admin/tenants', { key: ADMIN, method: 'POST', body: { name: 'Concurrent legacy claim' } });
  assert.equal(tenantResponse.status, 201);
  const tenant = (await tenantResponse.json()).tenant;
  const responses = await Promise.all([first, second].map(owner => request(`/admin/accounts/${owner.id}/spaces/${tenant.id}/claim`, {
    key: ADMIN, method: 'POST', body: {},
  })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const winner = responses[0].status === 200 ? first : second;
  const loser = responses[0].status === 200 ? second : first;
  const row = await db.prepare('SELECT owner_account_id FROM tenants WHERE id=?').bind(tenant.id).first();
  assert.equal(row.owner_account_id, winner.id);
  assert.equal((await request(`/account/spaces/${tenant.id}/keys`, { cookie: winner.cookie })).status, 200);
  assert.equal((await request(`/account/spaces/${tenant.id}/keys`, { cookie: loser.cookie })).status, 404);
});

test('administrator legacy-key revocation preserves its data and other legacy API compatibility', async () => {
  const created = await request('/admin/tenants', { key: ADMIN, method: 'POST', body: { name: 'Legacy compatibility' } });
  assert.equal(created.status, 201);
  const tenant = await created.json();
  await write(tenant.api_key, 'legacy-preserved', 'value', 'legacycompatuniqueterm');
  const response = await request(`/admin/tenants/${tenant.tenant.id}/revoke-legacy-key`, { key: ADMIN, method: 'POST', body: {} });
  assert.equal(response.status, 200);
  assert.equal((await request('/memory', { key: tenant.api_key })).status, 401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM memory WHERE tenant_id=?').bind(tenant.tenant.id).first()).count, 1);
  const after = await db.prepare('SELECT api_key_hash FROM tenants WHERE id=?').bind(tenant.tenant.id).first();
  assert.equal(after.api_key_hash === digest(tenant.api_key), false, 'admin revocation destroys the old legacy hash');
  assert.equal(await db.prepare('SELECT id FROM tenants WHERE api_key_hash=?').bind(digest(tenant.api_key)).first(), null, 'old Worker hash lookup also rejects the credential');
  assert.equal((await request(`/admin/tenants/${tenant.tenant.id}/revoke-legacy-key`, { key: ADMIN, method: 'POST', body: {} })).status, 200);
  assert.equal((await db.prepare('SELECT api_key_hash FROM tenants WHERE id=?').bind(tenant.tenant.id).first()).api_key_hash === after.api_key_hash, true, 'repeated admin revocation is idempotent');
});

test('deleting a space cascades its scoped keys, memory and FTS without touching another space', async () => {
  const owner = await account('delete-space');
  const target = await space(owner, 'Delete me');
  const keep = await space(owner, 'Keep me');
  const doomed = await apiKey(owner, target);
  const survivor = await apiKey(owner, keep);
  await write(doomed.api_key, 'doomed', 'value', 'spacecascadeuniqueterm');
  await write(survivor.api_key, 'survivor', 'value', 'keepuniqueterm');
  assert.equal((await request(`/account/spaces/${target.id}`, { cookie: owner.cookie, method: 'DELETE' })).status, 200);
  assert.equal((await request('/memory', { key: doomed.api_key })).status, 401);
  assert.equal((await request(`/account/spaces/${target.id}`, { cookie: owner.cookie, method: 'DELETE' })).status, 404);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM memory WHERE tenant_id=?').bind(target.id).first()).count, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM api_keys WHERE space_id=?').bind(target.id).first()).count, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH 'spacecascadeuniqueterm'").first()).count, 0);
  assert.equal((await request(memoryPath('survivor'), { key: survivor.api_key })).status, 200);
});

test('login identifier and IP limits return 429 and reset after the database window expires', async () => {
  const owner = await account('limited-login');
  const body = { email: owner.email, password: 'incorrect-long-test-password' };
  const ip = '198.51.100.70';
  let rejected = false;
  for (let i = 0; i < 12; i++) {
    const response = await request('/auth/login', { method: 'POST', body, ip });
    assert.ok([401, 429].includes(response.status));
    if (response.status === 429) {
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      rejected = true;
      break;
    }
  }
  assert.equal(rejected, true, 'repeated identifier failures are limited');
  const rates = await rows('SELECT * FROM auth_rate_limits');
  assert.ok(rates.length > 0);
  assert.equal(JSON.stringify(rates).includes(owner.email), false, 'limiter does not retain raw account identifiers');
  assert.equal(JSON.stringify(rates).includes(ip), false, 'limiter does not retain raw IP addresses');
  await db.prepare('UPDATE auth_rate_limits SET window_start=1,expires_at=1').run();
  assert.equal((await request('/auth/login', { method: 'POST', body: { email: owner.email, password: PASSWORD }, ip })).status, 200);
  let ipRejected = false;
  for (let i = 0; i < 22; i++) {
    const response = await request('/auth/login', { method: 'POST', body: { email: `missing-${i}@example.invalid`, password: PASSWORD }, ip: '198.51.100.71' });
    assert.ok([401, 429].includes(response.status));
    if (response.status === 429) {
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      ipRejected = true;
      break;
    }
  }
  assert.equal(ipRejected, true, 'multiple identifiers from one IP are also limited');
});

test('space and key creation limits are scoped to each account', async () => {
  const owner = await account('creation-limits');
  const other = await account('creation-other');
  const target = await space(owner, 'Key limit space');
  let spaceRejected = false;
  for (let i = 0; i < 21; i++) {
    const response = await request('/account/spaces', { cookie: owner.cookie, method: 'POST', body: { display_name: `Limited ${i}`, memory_type: 'general' }, ip: owner.ip });
    assert.ok([201, 429].includes(response.status));
    if (response.status === 429) { spaceRejected = true; break; }
  }
  assert.equal(spaceRejected, true);
  const otherSpace = await space(other, 'Independent allowance');
  let keyRejected = false;
  for (let i = 0; i < 31; i++) {
    const response = await request(`/account/spaces/${target.id}/keys`, { cookie: owner.cookie, method: 'POST', body: { label: `Limit ${i}`, scopes: ['read'] }, ip: owner.ip });
    assert.ok([201, 429].includes(response.status));
    if (response.status === 429) { keyRejected = true; break; }
  }
  assert.equal(keyRejected, true);
  await apiKey(other, otherSpace, ['read']);
});

test('the previous public registration setting fails closed after invitation registration is introduced', async () => {
  const publicMf = new Miniflare(convertV4MiniflareOptions({
    cf: false, modules: true, scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'], bindings: { REGISTRATION_MODE: 'public' },
    outboundService: () => new Response('External network disabled in account tests', { status: 403 }),
  }));
  try {
    const publicDb = await publicMf.getD1Database('DB');
    const migrations = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
    for (const name of migrations) await applyMigration(name, publicDb);
    const config = await publicMf.dispatchFetch('http://localhost/auth/config');
    assert.deepEqual(await config.json(), { registration_mode: 'admin' });
    const send = (email, ip = '203.0.113.1') => publicMf.dispatchFetch('http://localhost/auth/register', {
      method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email, display_name: 'Disposable public registration', password: PASSWORD }),
    });
    const denied = await send('closed-public@example.invalid');
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.has('set-cookie'), false);
    assert.equal((await publicDb.prepare('SELECT COUNT(*) AS count FROM accounts').first()).count, 0);
  } finally { await publicMf.dispose(); }
});

test('account dashboard discards a delayed key response after the user logs out', async () => {
  const html = await (await request('/account')).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  let openedSecrets = 0;
  let jsonEntered = false;
  let releaseJson;
  const payload = { key: { id: 'disposable-ui-key-id' }, api_key: 'disposable-ui-key-for-delayed-response' };
  const delayedJson = new Promise(resolve => { releaseJson = () => resolve(payload); });
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', className: '', disabled: false, hidden: false, open: false, children: [], listeners: {},
      addEventListener(type, handler) { this.listeners[type] = handler; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      setAttribute() {},
      querySelectorAll() { return id === 'key-form' ? [{ value: 'read' }] : []; },
      showModal() { this.open = true; if (id === 'secret-dialog') openedSecrets++; },
      close() { this.open = false; },
      classList: { add() {}, remove() {} },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      visibilityState: 'visible', getElementById: element,
      createElement: tag => element('created-' + tag + '-' + elements.size), addEventListener() {},
    },
    window: { addEventListener() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    TextEncoder, setTimeout, clearTimeout,
    fetch(path, options) {
      // Leave bootstrap pending; the test explicitly establishes its own
      // session and drives real form/logout handlers from the rendered script.
      if (path === '/auth/config' || path === '/auth/me') return new Promise(() => {});
      if (path === '/account/spaces/disposable-ui-space/keys' && options.method === 'POST') {
        return Promise.resolve({ ok: true, status: 201, json: () => { jsonEntered = true; return delayedJson; } });
      }
      if (path === '/auth/logout') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      throw new Error('unexpected mocked UI request');
    },
  });
  new vm.Script(script).runInContext(context);
  context.showAccount({ id: 'disposable-ui-account', display_name: 'Test account', email: 'ui@example.invalid' });
  vm.runInContext("state.spaces = [{id:'disposable-ui-space',display_name:'Test space',memory_type:'general'}]; state.selectedId = 'disposable-ui-space';", context);
  element('key-label').value = 'Temporary UI key';
  element('key-form').listeners.submit({ preventDefault() {} });
  try {
    await waitFor(() => jsonEntered, 'key issuance must be waiting on response JSON before logout');
    await element('logout').listeners.click();
    assert.equal(vm.runInContext('state.account === null', context), true);
    releaseJson();
    await waitFor(() => vm.runInContext('state.keyIssuing === false', context), 'delayed key handler must finish after logout');
    assert.equal(openedSecrets, 0, 'late secret never opens a dialog');
    assert.equal(element('secret-output').value.length, 0, 'late secret never reaches the DOM');
    assert.equal(payload.api_key.length, 0, 'late secret is erased from response data');
    assert.equal(element('account-section').hidden, true);
    assert.equal(element('auth-section').hidden, false);
    assert.equal(element('account-name').textContent, '');
  } finally { releaseJson(); }
});
