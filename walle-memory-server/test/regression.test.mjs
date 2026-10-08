import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let server;
let base;
let dir;
let store;
const ADMIN = 'local-node-test-admin';

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'walle-node-test-'));
  process.env.DB_PATH = join(dir, 'memory.db');
  process.env.API_KEY = ADMIN;
  store = await import('../dist/store.js');
  const { createMemoryServer } = await import('../dist/server.js');
  server = createMemoryServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('Node HTTP health, dashboard and admin authorization still work', async () => {
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/admin/tenants')).status, 401);
  assert.equal((await fetch(base + '/admin/tenants', { headers: { 'X-Api-Key': ADMIN } })).status, 200);
});

test('Node store isolates tenants, searches and matches literal prefixes', () => {
  const a = store.createTenant('a');
  const b = store.createTenant('b');
  store.upsert(a.tenant.id, 'literal%_key', 'a', 'uniqueterm');
  store.upsert(a.tenant.id, 'literalotherkey', 'x', 'not indexed');
  store.upsert(b.tenant.id, 'literal%_key', 'b', 'anotherterm');
  assert.equal(store.getEntry(a.tenant.id, 'literal%_key').value, 'a');
  assert.equal(store.getEntry(b.tenant.id, 'literal%_key').value, 'b');
  assert.deepEqual(store.listKeys(a.tenant.id, 'literal%_').map(row => row.key), ['literal%_key']);
  assert.equal(store.searchKeys(a.tenant.id, 'uniqueterm').length, 1);
  assert.equal(store.searchKeys(b.tenant.id, 'uniqueterm').length, 0);
  assert.equal(store.deleteTenant(a.tenant.id), true);
  assert.equal(store.getEntry(a.tenant.id, 'literal%_key'), undefined);
  assert.equal(store.searchKeys(a.tenant.id, 'uniqueterm').length, 0);
  assert.equal(store.getEntry(b.tenant.id, 'literal%_key').value, 'b');
});

test('Node GC deletes only the calling tenant and reports base rows', () => {
  const a = store.createTenant('gc-a');
  const b = store.createTenant('gc-b');
  store.upsert(a.tenant.id, 'expired', 'a', 'gcuniqueterm', -1);
  store.upsert(b.tenant.id, 'expired', 'b', 'gcuniqueterm', -1);
  assert.equal(store.deleteExpired(a.tenant.id), 1);
  assert.equal(store.deleteExpired(a.tenant.id), 0);
  assert.equal(store.deleteExpired(b.tenant.id), 1);
});

test('Node admin routes fail closed with no configured key', async () => {
  delete process.env.API_KEY;
  const { createMemoryServer } = await import('../dist/server.js?without-admin-key');
  const unconfigured = createMemoryServer();
  await new Promise(resolve => unconfigured.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + unconfigured.address().port + '/admin/tenants');
    assert.equal(response.status, 503);
  } finally { await new Promise(resolve => unconfigured.close(resolve)); }
});
