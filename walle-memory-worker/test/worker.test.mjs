import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const ADMIN = 'test-only-admin-key';
let mf;
let db;
let alice;
let bob;

async function request(path, { key, method = 'GET', body, raw } = {}) {
  return mf.dispatchFetch(`http://localhost${path}`, {
    method,
    headers: { ...(key ? { 'X-Api-Key': key } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

async function createTenant(name) {
  const response = await request('/admin/tenants', { key: ADMIN, method: 'POST', body: { name } });
  assert.equal(response.status, 201);
  return response.json();
}

const memoryPath = key => '/memory/' + encodeURIComponent(key);
const write = (key, value = 'value', description = 'searchable description', tenant = alice, ttl_seconds) =>
  request(memoryPath(key), { key: tenant.api_key, method: 'POST', body: { value, description, ttl_seconds } });

before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    modules: true,
    scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01',
    bindings: { API_KEY: ADMIN },
    d1Databases: ['DB'],
    outboundService: () => new Response('External network disabled in tests', { status: 403 }),
  }));
  db = await mf.getD1Database('DB');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
    const migration = await readFile(new URL(file, migrations), 'utf8');
    for (const statement of migration.split('-- statement-breakpoint')) {
      if (statement.trim()) await db.prepare(statement.trim()).run();
    }
  }
  alice = await createTenant('alice');
  bob = await createTenant('bob');
});

after(async () => { await mf?.dispose(); });

test('public health/dashboard and fail-closed authorization', async () => {
  assert.deepEqual(await (await request('/health')).json(), { ok: true });
  const dashboard = await request('/');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await dashboard.text();
  assert.match(html, /&quot;/);
  assert.match(html, /&#39;/);
  assert.equal((await request('/admin/tenants')).status, 401);
  assert.equal((await request('/admin/tenants', { key: alice.api_key })).status, 401);
  assert.equal((await request('/memory', { key: ADMIN })).status, 401);
  assert.equal((await request('/memory')).status, 401);
});

test('missing admin secret fails closed', async () => {
  const unconfigured = new Miniflare(convertV4MiniflareOptions({
    cf: false,
    modules: true,
    scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01',
    d1Databases: ['DB'],
  }));
  try {
    const response = await unconfigured.dispatchFetch('http://localhost/admin/tenants');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'admin API is not configured' });
  } finally { await unconfigured.dispose(); }
});

test('dashboard JavaScript parses and escapes quotes used in form attributes', async () => {
  const html = await (await request('/')).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { addEventListener() {} });
        return elements.get(id);
      },
    },
    localStorage: { getItem: () => '' },
    // Keep bootstrap pending: this test never sends network requests.
    fetch: () => new Promise(() => {}),
    setTimeout,
    clearTimeout,
  });
  new vm.Script(script).runInContext(context);
  assert.equal(context.esc('\"\'<> &'), '&quot;&#39;&lt;&gt; &amp;');
});

test('dashboard never retries a failed mutation with a replacement space key', async () => {
  const html = await (await request('/')).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let prompts = 0;
  let stored = 0;
  let mutations = 0;
  const context = vm.createContext({
    document: { getElementById: () => ({ addEventListener() {} }) },
    localStorage: { getItem: () => 'expired-test-key', setItem: () => stored++ },
    prompt: () => { prompts++; return 'different-space-test-key'; },
    fetch: (_path, options) => {
      if (options.method === 'GET') return new Promise(() => {});
      mutations++;
      return Promise.resolve({ status: 401 });
    },
    setTimeout, clearTimeout,
  });
  new vm.Script(script).runInContext(context);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    await assert.rejects(context.api(method, '/memory/same-key', { value: 'temporary' }), /retry explicitly/);
  }
  assert.equal(mutations, 3);
  assert.equal(prompts, 0);
  assert.equal(stored, 0);
});

test('tenant keys are returned once and only hashes are stored', async () => {
  assert.match(alice.api_key, /^[a-f0-9]{48}$/);
  const row = await db.prepare('SELECT * FROM tenants WHERE id = ?').bind(alice.tenant.id).first();
  assert.match(row.api_key_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(row.api_key_hash, alice.api_key);
  const list = await (await request('/admin/tenants', { key: ADMIN })).json();
  assert.equal(list.tenants.length, 2);
  assert.equal(JSON.stringify(list).includes('api_key'), false);
  assert.equal((await request('/admin/tenants', { key: ADMIN, method: 'POST', body: { name: 'alice' } })).status, 409);
});

test('CRUD preserves API shape and isolates identical keys between tenants', async () => {
  assert.equal((await write('shared/key', 'alice value')).status, 200);
  assert.equal((await write('shared/key', 'bob value', 'bobonly', bob)).status, 200);
  const first = await (await request(memoryPath('shared/key'), { key: alice.api_key })).json();
  assert.equal(first.value, 'alice value');
  assert.equal(first.tenant_id, alice.tenant.id);
  assert.equal(first.access_count, 0);
  assert.equal(first.last_accessed_at, null);
  const second = await (await request(memoryPath('shared/key'), { key: alice.api_key })).json();
  assert.equal(second.access_count, 1);
  assert.ok(second.last_accessed_at > 0);
  assert.equal((await (await request(memoryPath('shared/key'), { key: bob.api_key })).json()).value, 'bob value');
  assert.equal((await request('/memory/search?q=bobonly', { key: alice.api_key })).status, 200);
  assert.deepEqual((await (await request('/memory/search?q=bobonly', { key: alice.api_key })).json()).results, []);
  assert.equal((await request(memoryPath('shared/key'), { key: alice.api_key, method: 'PUT', body: { value: 'updated', description: 'new words' } })).status, 200);
  assert.equal((await request(memoryPath('shared/key'), { key: alice.api_key, method: 'DELETE' })).status, 200);
  assert.equal((await request(memoryPath('shared/key'), { key: alice.api_key })).status, 404);
  assert.equal((await request(memoryPath('shared/key'), { key: bob.api_key })).status, 200);
});

test('literal long, Unicode, percent and underscore prefixes work', async () => {
  const prefix = '项目/' + 'a'.repeat(70) + '%_/';
  const key = prefix + 'child';
  await write(key, '你好');
  await write('项目/' + 'a'.repeat(70) + 'other/child');
  const list = await (await request('/memory?prefix=' + encodeURIComponent(prefix), { key: alice.api_key })).json();
  assert.deepEqual(list.keys.map(item => item.key), [key]);
  assert.equal((await (await request(memoryPath(key), { key: alice.api_key })).json()).value, '你好');
});

test('summary contains descriptions but no values and is tenant scoped', async () => {
  const response = await request('/summary', { key: alice.api_key });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const summary = await response.json();
  assert.equal(summary.tenant, 'alice');
  assert.ok(summary.entries.length > 0);
  assert.ok(summary.entries.every(item => !('value' in item) && !('tenant_id' in item)));
  assert.ok(summary.entries.every(item => item.description !== 'bobonly'));
});

test('FTS follows inserts, description changes and deletes', async () => {
  await write('fts-test', 'notindexedvalue', 'olduniqueterm');
  const search = async q => (await (await request('/memory/search?q=' + encodeURIComponent(q), { key: alice.api_key })).json()).results;
  assert.equal((await search('olduniqueterm')).length, 1);
  assert.equal((await search('notindexedvalue')).length, 0);
  await write('fts-test', 'same value', 'newuniqueterm');
  assert.equal((await search('olduniqueterm')).length, 0);
  assert.equal((await search('newuniqueterm')).length, 1);
  // Reads must not alter the index. The schema limits the trigger to indexed columns.
  for (let i = 0; i < 3; i++) await request(memoryPath('fts-test'), { key: alice.api_key });
  assert.equal((await search('newuniqueterm')).length, 1);
  const trigger = await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_au'").first();
  assert.match(trigger.sql, /AFTER UPDATE OF key, description/);
  await request(memoryPath('fts-test'), { key: alice.api_key, method: 'DELETE' });
  assert.equal((await search('newuniqueterm')).length, 0);
});

test('TTL hides expired values and GC only deletes the calling tenant', async () => {
  await write('expiring', 'old', 'expireduniqueterm', alice, 1);
  await write('expiring', 'old', 'expireduniqueterm', bob, 1);
  await db.prepare("UPDATE memory SET expires_at = 1 WHERE key = 'expiring'").run();
  assert.equal((await request(memoryPath('expiring'), { key: alice.api_key })).status, 404);
  assert.deepEqual((await (await request('/memory/search?q=expireduniqueterm', { key: alice.api_key })).json()).results, []);
  const summary = await (await request('/summary', { key: alice.api_key })).json();
  assert.ok(summary.entries.every(item => item.key !== 'expiring'));
  const list = await (await request('/memory', { key: alice.api_key })).json();
  assert.ok(list.keys.every(item => item.key !== 'expiring'));
  const gc = await request('/memory/gc', { key: alice.api_key, method: 'POST' });
  assert.deepEqual(await gc.json(), { ok: true, deleted: 1 });
  const remaining = await db.prepare("SELECT tenant_id FROM memory WHERE key = 'expiring'").all();
  assert.deepEqual(remaining.results.map(row => row.tenant_id), [bob.tenant.id]);
  await request('/memory/gc', { key: bob.api_key, method: 'POST' });
});

test('omitting TTL on an upsert makes the entry permanent', async () => {
  await write('permanent', 'x', 'description', alice, 60);
  await write('permanent');
  assert.equal((await (await request(memoryPath('permanent'), { key: alice.api_key })).json()).expires_at, null);
});

test('bad bodies, TTLs, URL encodings and FTS syntax return controlled errors', async () => {
  for (const raw of ['null', '[]', 'false', '{']) {
    assert.equal((await request('/memory/bad', { key: alice.api_key, method: 'POST', raw })).status, 400);
    assert.equal((await request('/admin/tenants', { key: ADMIN, method: 'POST', raw })).status, 400);
  }
  for (const ttl_seconds of [0, -1, '60', null, 1e100]) {
    assert.equal((await request('/memory/bad', { key: alice.api_key, method: 'POST', body: { value: '', description: '', ttl_seconds } })).status, 400);
  }
  assert.equal((await request('/memory/%E0%A4%A', { key: alice.api_key })).status, 400);
  for (const query of ['"', '(', 'boguscolumn:test', 'hello OR']) {
    assert.equal((await request('/memory/search?q=' + encodeURIComponent(query), { key: alice.api_key })).status, 400);
  }
  assert.equal((await request('/memory/search', { key: alice.api_key })).status, 400);
  assert.equal((await request('/memory/bad', { key: alice.api_key, method: 'POST', body: { value: 'x'.repeat(256 * 1024 + 1), description: '' } })).status, 400);
  assert.equal((await request('/memory/bad', { key: alice.api_key, method: 'POST', raw: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
});

test('unknown routes return 404 and hostile strings remain data', async () => {
  assert.equal((await request('/missing', { key: alice.api_key })).status, 404);
  const key = 'quote/" onfocus="alert(1)';
  assert.equal((await write(key, '<script>evil</script>', '\"><img src=x onerror=alert(1)>')).status, 200);
  assert.equal((await (await request(memoryPath(key), { key: alice.api_key })).json()).key, key);
});

test('deleting a tenant cascades memory/FTS and revokes its key', async () => {
  const doomed = await createTenant('delete-me');
  await write('doomed', 'value', 'doomeduniqueterm', doomed);
  const response = await request('/admin/tenants/' + doomed.tenant.id, { key: ADMIN, method: 'DELETE' });
  assert.equal(response.status, 200);
  assert.equal((await request('/memory', { key: doomed.api_key })).status, 401);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM memory WHERE tenant_id = ?').bind(doomed.tenant.id).first()).count, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM memory_fts WHERE memory_fts MATCH 'doomeduniqueterm'").first()).count, 0);
  assert.equal((await request('/admin/tenants/' + doomed.tenant.id, { key: ADMIN, method: 'DELETE' })).status, 404);
  assert.equal((await request('/memory', { key: bob.api_key })).status, 200);
});
