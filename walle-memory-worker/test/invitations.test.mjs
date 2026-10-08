import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// All fixtures are disposable. No Cloudflare account, persistent D1, external
// network, production credentials, or wrangler command is used by this suite.
const ADMIN = 'test-only-admin-key';
const PASSWORD = 'invitation-test-only-password-2026';
const digest = value => createHash('sha256').update(value).digest('hex');
const metadataFields = ['created_at', 'expires_at', 'id', 'label', 'max_uses', 'prefix', 'revoked_at', 'uses'];
let mf;
let db;
let serial = 0;
let old;
const uniqueEmail = label => `${label}-${++serial}@example.invalid`;
const uniqueIp = () => `198.51.${Math.floor(++serial / 250)}.${serial % 250 + 1}`;

function harness(mode = 'invite', withAdmin = true) {
  return new Miniflare(convertV4MiniflareOptions({
    cf: false, modules: true,
    scriptPath: new URL('../dist/index.js', import.meta.url).pathname,
    compatibilityDate: '2026-10-01', d1Databases: ['DB'],
    bindings: { ...(withAdmin ? { API_KEY: ADMIN } : {}), ...(mode == null ? {} : { REGISTRATION_MODE: mode }) },
    outboundService: () => new Response('External network disabled in invitation tests', { status: 403 }),
  }));
}

async function request(path, {
  method = 'GET', key, cookie, body, raw, ip = uniqueIp(), origin, headers = {},
} = {}, worker = mf) {
  return worker.dispatchFetch('http://localhost' + path, {
    method,
    headers: {
      'CF-Connecting-IP': ip,
      ...(key ? { 'X-Api-Key': key } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(origin === null ? {} : method === 'GET' ? {} : { Origin: origin ?? 'http://localhost' }),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

async function migrate(target, files) {
  const names = files ?? (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  for (const name of names) {
    const source = await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
    for (const sql of source.split('-- statement-breakpoint').map(value => value.trim()).filter(Boolean)) await target.prepare(sql).run();
  }
}

async function invitation(extras = {}, worker = mf) {
  const response = await request('/admin/invitations', { key: ADMIN, method: 'POST', body: { label: 'Temporary test invitation', ...extras } }, worker);
  assert.equal(response.status, 201, 'administrator can issue an invitation');
  const body = await response.json();
  assert.equal(typeof body.invitation_code, 'string');
  assert.equal(/^wmi_[a-f0-9]{64}$/.test(body.invitation_code), true, 'code has a strong random format');
  return body;
}

const register = (issued, { email = uniqueEmail('registration'), ...extras } = {}, options = {}) => request('/auth/register', {
  method: 'POST', body: { email, password: PASSWORD, display_name: 'Invited account', invitation_code: issued?.invitation_code, ...extras }, ...options,
});

async function invited(issued, email = uniqueEmail('invited')) {
  const response = await register(issued, { email });
  assert.equal(response.status, 201);
  const body = await response.json();
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie?.startsWith('walle_session='));
  return { ...body.account, cookie: setCookie.split(';')[0], setCookie };
}

async function stats(target = db) {
  return {
    accounts: (await target.prepare('SELECT COUNT(*) AS count FROM accounts').first()).count,
    sessions: (await target.prepare('SELECT COUNT(*) AS count FROM account_sessions').first()).count,
  };
}

const invitationRow = id => db.prepare('SELECT * FROM registration_invitations WHERE id=?').bind(id).first();
async function genericDenied(response) {
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'registration cannot be completed' });
  assert.equal(response.headers.has('set-cookie'), false);
}

before(async () => {
  mf = harness();
  db = await mf.getD1Database('DB');
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  assert.equal(files[2], '0003_registration_invitations.sql');
  await migrate(db, files.slice(0, 2));
  const salt = randomBytes(32);
  old = {
    accountId: 'existing-before-invitation', email: 'existing-migration@example.invalid',
    spaceId: 'space-before-invitation', legacyKey: randomBytes(24).toString('hex'),
    scopedKey: 'wmk_' + randomBytes(32).toString('hex'), session: randomBytes(32).toString('hex'),
  };
  await db.prepare(`INSERT INTO accounts(id,email,display_name,password_hash,password_salt,password_iterations,created_at)
    VALUES(?,?,?,?,?,?,?)`).bind(old.accountId, old.email, 'Existing account',
    pbkdf2Sync(PASSWORD, salt, 100000, 32, 'sha256').toString('hex'), salt.toString('hex'), 100000, 1700000000000).run();
  await db.prepare(`INSERT INTO tenants(id,name,api_key_hash,created_at,owner_account_id,display_name,memory_type)
    VALUES(?,?,?,?,?,?,?)`).bind(old.spaceId, 'Existing tenant', digest(old.legacyKey), 1700000000000, old.accountId, 'Existing space', 'semantic').run();
  await db.prepare(`INSERT INTO api_keys(id,space_id,account_id,key_hash,label,prefix,scopes,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind('old-scoped-key-id', old.spaceId, old.accountId, digest(old.scopedKey), 'Existing scoped key', old.scopedKey.slice(0, 12), JSON.stringify(['read', 'write', 'delete', 'gc']), 1700000000000).run();
  await db.prepare('INSERT INTO account_sessions(token_hash,account_id,created_at,expires_at) VALUES(?,?,?,?)')
    .bind(digest(old.session), old.accountId, Date.now(), Date.now() + 60_000).run();
  await db.prepare(`INSERT INTO memory(key,tenant_id,value,description,access_count,last_accessed_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).bind('migration/item', old.spaceId, 'Existing value', 'invitemigrationuniqueterm', 9, 1700000001000, 1700000002000).run();
  old.snapshots = {};
  for (const table of ['accounts', 'tenants', 'api_keys', 'account_sessions', 'memory']) old.snapshots[table] = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
  await migrate(db, files.slice(2));
});

// Keep rate-limit assertions independent without changing any invitation,
// account, session or memory fixture. Individual limit tests exercise a window.
beforeEach(async () => { await db.prepare('DELETE FROM auth_rate_limits').run(); });
after(async () => { await mf?.dispose(); });

test('0003 preserves existing account, session, scoped key, legacy key, memory and FTS', async () => {
  for (const table of Object.keys(old.snapshots)) assert.deepEqual((await db.prepare(`SELECT * FROM ${table}`).all()).results, old.snapshots[table]);
  assert.equal((await request('/auth/me', { cookie: 'walle_session=' + old.session })).status, 200);
  assert.equal((await request('/memory', { key: old.scopedKey })).status, 200);
  assert.equal((await request('/memory', { key: old.legacyKey })).status, 200);
  const search = await request('/memory/search?q=invitemigrationuniqueterm', { key: old.scopedKey });
  assert.equal(search.status, 200);
  assert.deepEqual((await search.json()).results.map(row => row.key), ['migration/item']);
  const login = await request('/auth/login', { method: 'POST', body: { email: old.email, password: PASSWORD } });
  assert.equal(login.status, 200);
});

test('only explicit invite mode enables registration; admin, public and unknown modes fail closed', async () => {
  assert.deepEqual(await (await request('/auth/config')).json(), { registration_mode: 'invite' });
  for (const mode of [undefined, 'admin', 'public', 'PUBLIC', 'unknown']) {
    // A worker with no mode binding is intentionally separate from the invite
    // fixture. No schema is needed for these fail-closed paths.
    const worker = harness(mode ?? null);
    try {
      assert.deepEqual(await (await request('/auth/config', {}, worker)).json(), { registration_mode: 'admin' });
      assert.equal((await request('/auth/register', { method: 'POST', body: { email: uniqueEmail('closed'), password: PASSWORD } }, worker)).status, 403);
    } finally { await worker.dispose(); }
  }
});

test('invitation management fails closed without the administrator secret', async () => {
  const worker = harness('invite', false);
  try {
    for (const [path, method, body] of [
      ['/admin/invitations', 'GET'], ['/admin/invitations', 'POST', { label: 'Denied' }], ['/admin/invitations/missing', 'DELETE'],
    ]) assert.equal((await request(path, { method, body }, worker)).status, 503);
  } finally { await worker.dispose(); }
});

test('invitation code is shown once and database/list responses contain only hashes or metadata', async () => {
  const issued = await invitation();
  assert.deepEqual(Object.keys(issued.invitation).sort(), metadataFields);
  assert.equal(issued.invitation.max_uses, 1);
  assert.equal(issued.invitation.uses, 0);
  assert.equal(issued.invitation.expires_at, null);
  assert.equal(issued.invitation.revoked_at, null);
  assert.equal(issued.invitation.prefix === issued.invitation_code.slice(0, 12), true);
  const row = await invitationRow(issued.invitation.id);
  assert.equal(row.code_hash === digest(issued.invitation_code), true);
  assert.equal(JSON.stringify(row).includes(issued.invitation_code), false, 'raw code is never stored');
  const response = await request('/admin/invitations', { key: ADMIN });
  assert.equal(response.status, 200);
  const list = await response.json();
  assert.equal(JSON.stringify(list).includes(issued.invitation_code), false, 'list never redisplays the code');
  const listed = list.invitations.find(value => value.id === issued.invitation.id);
  assert.deepEqual(Object.keys(listed).sort(), metadataFields);
  assert.equal('code_hash' in listed || 'last_redemption_id' in listed, false);
});

test('invitation validation rejects invalid limits, expiry, labels and malformed bodies', async () => {
  const before = (await db.prepare('SELECT COUNT(*) AS count FROM registration_invitations').first()).count;
  for (const max_uses of [0, -1, 1001, 1.5, '2']) assert.equal((await request('/admin/invitations', { key: ADMIN, method: 'POST', body: { label: 'Invalid', max_uses } })).status, 400);
  for (const expires_at of [1, -1, 1.5, String(Date.now() + 60_000)]) assert.equal((await request('/admin/invitations', { key: ADMIN, method: 'POST', body: { label: 'Invalid', expires_at } })).status, 400);
  for (const label of ['', null]) assert.equal((await request('/admin/invitations', { key: ADMIN, method: 'POST', body: { label } })).status, 400);
  for (const raw of ['null', '[]', '{']) assert.equal((await request('/admin/invitations', { key: ADMIN, method: 'POST', raw })).status, 400);
  assert.equal((await request('/admin/invitations', { key: ADMIN, method: 'POST', body: { label: 'Wrong content type' }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM registration_invitations').first()).count, before);
  const issued = await invitation({ max_uses: 1000, expires_at: Date.now() + 60_000 });
  assert.equal(issued.invitation.max_uses, 1000);
  assert.ok(issued.invitation.expires_at > Date.now());
});

test('valid invitation creates a normal account with an automatic protected session and no spaces', async () => {
  const issued = await invitation();
  const owner = await invited(issued);
  assert.match(owner.setCookie, /HttpOnly/i);
  assert.match(owner.setCookie, /SameSite=Strict/i);
  const me = await request('/auth/me', { cookie: owner.cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).account.id, owner.id);
  const spaces = await request('/account/spaces', { cookie: owner.cookie });
  assert.deepEqual((await spaces.json()).spaces, []);
  assert.equal((await invitationRow(issued.invitation.id)).uses, 1);
  const stored = await db.prepare('SELECT * FROM accounts WHERE id=?').bind(owner.id).first();
  assert.equal(JSON.stringify(stored).includes(PASSWORD), false);
  assert.equal((await request('/admin/accounts', { cookie: owner.cookie })).status, 401);
  assert.equal((await request(`/account/spaces/${old.spaceId}/keys`, { cookie: owner.cookie })).status, 404);
  assert.equal((await request(`/admin/accounts/${owner.id}/spaces/${old.spaceId}/claim`, { cookie: owner.cookie, method: 'POST', body: {} })).status, 401);
  assert.equal((await db.prepare('SELECT owner_account_id FROM tenants WHERE id=?').bind(old.spaceId).first()).owner_account_id, old.accountId);
});

test('missing and malformed invitation codes are generic failures with no account or session side effects', async () => {
  const baseline = await stats();
  for (const invitation_code of [undefined, null, '', 'wrong-code', 'wmi_' + '0'.repeat(64), 12]) {
    await genericDenied(await register(null, { invitation_code }));
  }
  assert.deepEqual(await stats(), baseline);
});

test('expired, revoked and exhausted invitations reject new accounts with the same generic response', async () => {
  for (const state of ['expired', 'revoked', 'exhausted']) {
    const issued = await invitation();
    if (state === 'expired') await db.prepare('UPDATE registration_invitations SET created_at=0,expires_at=1 WHERE id=?').bind(issued.invitation.id).run();
    if (state === 'revoked') assert.equal((await request('/admin/invitations/' + issued.invitation.id, { key: ADMIN, method: 'DELETE' })).status, 200);
    if (state === 'exhausted') await invited(issued);
    const baseline = await stats();
    const before = await invitationRow(issued.invitation.id);
    await genericDenied(await register(issued));
    assert.deepEqual(await stats(), baseline);
    assert.deepEqual(await invitationRow(issued.invitation.id), before);
  }
});

test('bad registration inputs, weak passwords and duplicate emails do not consume an invitation', async () => {
  const issued = await invitation({ max_uses: 10 });
  const baseline = await stats();
  for (const extras of [
    { password: 'weak' }, { password: 'x'.repeat(1025) }, { display_name: '' }, { display_name: null },
    { email: 'invalid-email' }, { email: `  ${old.email.toUpperCase()}  ` },
  ]) {
    const response = await register(issued, extras);
    assert.equal(response.status, 400);
    assert.equal(response.headers.has('set-cookie'), false);
  }
  for (const raw of ['null', '[]', '{']) assert.equal((await request('/auth/register', { method: 'POST', raw })).status, 400);
  assert.equal((await request('/auth/register', { method: 'POST', raw: 'x'.repeat(16 * 1024 + 1) })).status, 413);
  assert.equal((await register(issued, {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.deepEqual(await stats(), baseline);
  const row = await invitationRow(issued.invitation.id);
  assert.equal(row.uses, 0);
  assert.equal(row.last_redemption_id, null);
  await invited(issued);
  assert.equal((await invitationRow(issued.invitation.id)).uses, 1);
});

test('concurrent single-use and multi-use redemptions succeed exactly max_uses times', async () => {
  for (const max_uses of [1, 3]) {
    const issued = await invitation({ max_uses });
    const baseline = await stats();
    const emails = Array.from({ length: 8 }, () => uniqueEmail('concurrent'));
    const responses = await Promise.all(emails.map(email => register(issued, { email }, { ip: uniqueIp() })));
    assert.equal(responses.filter(response => response.status === 201).length, max_uses);
    assert.equal(responses.filter(response => response.status === 400).length, emails.length - max_uses);
    for (const response of responses) if (response.status !== 201) await genericDenied(response);
    assert.equal((await invitationRow(issued.invitation.id)).uses, max_uses);
    const after = await stats();
    assert.equal(after.accounts - baseline.accounts, max_uses);
    assert.equal(after.sessions - baseline.sessions, max_uses);
  }
});

test('concurrent registration of one normalized email consumes only one invitation use', async () => {
  const issued = await invitation({ max_uses: 10 });
  const email = uniqueEmail('same-email');
  const baseline = await stats();
  const responses = await Promise.all([email, ` ${email.toUpperCase()} `].map(value => register(issued, { email: value }, { ip: uniqueIp() })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 400]);
  assert.equal((await invitationRow(issued.invitation.id)).uses, 1);
  const after = await stats();
  assert.equal(after.accounts - baseline.accounts, 1);
  assert.equal(after.sessions - baseline.sessions, 1);
});

test('account and session INSERT faults roll back invitation use, receipt, account and session together', async () => {
  for (const target of ['accounts', 'account_sessions']) {
    const issued = await invitation();
    const email = uniqueEmail('fault-' + target);
    const before = await invitationRow(issued.invitation.id);
    const baseline = await stats();
    const predicate = target === 'accounts' ? `NEW.email = '${email}'`
      : `EXISTS (SELECT id FROM accounts WHERE id=NEW.account_id AND email='${email}')`;
    await db.prepare(`CREATE TRIGGER invitation_test_fault BEFORE INSERT ON ${target}
      WHEN ${predicate} BEGIN SELECT RAISE(ABORT, 'temporary invitation test fault'); END`).run();
    try {
      await genericDenied(await register(issued, { email }));
      assert.deepEqual(await stats(), baseline);
      assert.deepEqual(await invitationRow(issued.invitation.id), before, 'receipt and use counter roll back');
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE email=?').bind(email).first()).count, 0);
    } finally { await db.prepare('DROP TRIGGER invitation_test_fault').run(); }
    await invited(issued, email);
    assert.equal((await invitationRow(issued.invitation.id)).uses, 1, 'the same code remains redeemable after the fault is removed');
  }
});

test('revocation racing concurrent redemptions preserves exact account/session/use counts', async () => {
  const issued = await invitation({ max_uses: 4 });
  const baseline = await stats();
  const redemptions = Array.from({ length: 6 }, () => register(issued, {}, { ip: uniqueIp() }));
  const revoke = request('/admin/invitations/' + issued.invitation.id, { key: ADMIN, method: 'DELETE' });
  const responses = await Promise.all(redemptions);
  assert.equal((await revoke).status, 200);
  assert.ok(responses.every(response => [201, 400].includes(response.status)));
  const successes = responses.filter(response => response.status === 201).length;
  assert.ok(successes <= 4);
  const row = await invitationRow(issued.invitation.id);
  assert.equal(row.uses, successes);
  assert.ok(row.revoked_at > 0);
  const after = await stats();
  assert.equal(after.accounts - baseline.accounts, successes);
  assert.equal(after.sessions - baseline.sessions, successes);
  await genericDenied(await register(issued));
});

test('revocation is idempotent, rejects further redemption and does not delete existing accounts', async () => {
  const issued = await invitation({ max_uses: 2 });
  const owner = await invited(issued);
  const path = '/admin/invitations/' + issued.invitation.id;
  assert.equal((await request(path, { key: ADMIN, method: 'DELETE' })).status, 200);
  const before = await invitationRow(issued.invitation.id);
  assert.equal((await request(path, { key: ADMIN, method: 'DELETE' })).status, 200);
  assert.deepEqual(await invitationRow(issued.invitation.id), before);
  await genericDenied(await register(issued));
  assert.equal((await request('/auth/me', { cookie: owner.cookie })).status, 200);
  assert.equal((await request('/admin/invitations/missing', { key: ADMIN, method: 'DELETE' })).status, 404);
});

test('cookie, scoped key, legacy key and invitation code cannot authorize invitation management', async () => {
  const issued = await invitation();
  for (const credentials of [
    {}, { cookie: 'walle_session=' + old.session }, { key: old.scopedKey }, { key: old.legacyKey }, { key: issued.invitation_code },
  ]) for (const [path, method, body] of [
    ['/admin/invitations', 'GET'], ['/admin/invitations', 'POST', { label: 'Denied' }], ['/admin/invitations/' + issued.invitation.id, 'DELETE'],
  ]) assert.equal((await request(path, { ...credentials, method, body })).status, 401);
  for (const path of ['/memory', '/summary', '/auth/me', '/account/spaces', '/admin/accounts']) assert.equal((await request(path, { key: issued.invitation_code })).status, 401);
  assert.equal((await invitationRow(issued.invitation.id)).uses, 0);
  assert.equal((await invitationRow(issued.invitation.id)).revoked_at, null);
});

test('registration requires same-origin JSON and cannot take invitation credentials from a header or query', async () => {
  const issued = await invitation();
  for (const origin of [null, 'https://attacker.invalid']) assert.equal((await register(issued, {}, { origin })).status, 403);
  assert.equal((await register(issued, {}, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  await genericDenied(await request('/auth/register?invitation_code=' + encodeURIComponent(issued.invitation_code), {
    method: 'POST', key: issued.invitation_code, body: { email: uniqueEmail('header-code'), password: PASSWORD },
  }));
  assert.equal((await invitationRow(issued.invitation.id)).uses, 0);
});

test('registration IP and email limits are separate, return Retry-After and do not consume failed codes', async () => {
  const issued = await invitation({ max_uses: 20 });
  for (let i = 0; i < 5; i++) assert.equal((await register(issued, {}, { ip: '203.0.113.90' })).status, 201);
  const ipLimited = await register(issued, {}, { ip: '203.0.113.90' });
  assert.equal(ipLimited.status, 429);
  assert.ok(Number(ipLimited.headers.get('retry-after')) > 0);
  assert.equal((await invitationRow(issued.invitation.id)).uses, 5);
  const email = uniqueEmail('email-limit');
  for (let i = 0; i < 3; i++) await genericDenied(await register(null, { email, invitation_code: 'wmi_' + '0'.repeat(64) }, { ip: uniqueIp() }));
  const emailLimited = await register(issued, { email: ` ${email.toUpperCase()} ` }, { ip: uniqueIp() });
  assert.equal(emailLimited.status, 429);
  assert.ok(Number(emailLimited.headers.get('retry-after')) > 0);
  assert.equal((await invitationRow(issued.invitation.id)).uses, 5);
  await db.prepare('UPDATE auth_rate_limits SET window_start=1,expires_at=1').run();
  assert.equal((await register(issued, { email }, { ip: '203.0.113.90' })).status, 201);
  assert.equal((await invitationRow(issued.invitation.id)).uses, 6);
});

test('administrator invitation creation has a fixed window limit', async () => {
  for (let i = 0; i < 30; i++) assert.equal((await request('/admin/invitations', { key: ADMIN, method: 'POST', body: { label: `Rate test ${i}` } })).status, 201);
  const limited = await request('/admin/invitations', { key: ADMIN, method: 'POST', body: { label: 'Over limit' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  await db.prepare('UPDATE auth_rate_limits SET window_start=1,expires_at=1').run();
  assert.equal((await request('/admin/invitations', { key: ADMIN, method: 'POST', body: { label: 'New window' } })).status, 201);
});

test('active invitation quota excludes revoked, expired and exhausted invitations', async () => {
  const worker = harness();
  try {
    const target = await worker.getD1Database('DB');
    await migrate(target);
    const now = Date.now();
    for (let i = 0; i < 100; i++) await target.prepare(`INSERT INTO registration_invitations(id,label,prefix,code_hash,created_at,max_uses)
      VALUES(?,?,?,?,?,?)`).bind('quota-' + i, 'Quota fixture', 'fixture-prefix', digest('disposable-quota-code-' + i), now, 1).run();
    assert.equal((await request('/admin/invitations', { key: ADMIN, method: 'POST', body: { label: 'Over quota' } }, worker)).status, 409);
    assert.equal((await request('/admin/invitations/quota-0', { key: ADMIN, method: 'DELETE' }, worker)).status, 200);
    await invitation({}, worker);
    await target.prepare("UPDATE registration_invitations SET created_at=0,expires_at=1 WHERE id='quota-1'").run();
    await invitation({}, worker);
    await target.prepare("UPDATE registration_invitations SET uses=max_uses WHERE id='quota-2'").run();
    await invitation({}, worker);
  } finally { await worker.dispose(); }
});

test('invited accounts can log in/out and keep their memory spaces isolated', async () => {
  const issued = await invitation({ max_uses: 2 });
  const owners = [await invited(issued), await invited(issued)];
  const spaces = [];
  const keys = [];
  for (const owner of owners) {
    const created = await request('/account/spaces', { cookie: owner.cookie, method: 'POST', body: { display_name: 'Invited space', memory_type: 'episodic' } });
    assert.equal(created.status, 201);
    const space = (await created.json()).space;
    spaces.push(space);
    const response = await request(`/account/spaces/${space.id}/keys`, { cookie: owner.cookie, method: 'POST', body: { label: 'Test key', scopes: ['read', 'write'] } });
    assert.equal(response.status, 201);
    keys.push((await response.json()).api_key);
  }
  for (let i = 0; i < 2; i++) assert.equal((await request('/memory/same', { key: keys[i], method: 'POST', body: { value: `Invited value ${i}`, description: `invitedisolation${i}` } })).status, 200);
  const value = await request('/memory/same', { key: keys[0] });
  assert.equal((await value.json()).value, 'Invited value 0');
  const search = await request('/memory/search?q=invitedisolation1', { key: keys[0] });
  assert.deepEqual((await search.json()).results, []);
  assert.equal((await request(`/account/spaces/${spaces[1].id}/keys`, { cookie: owners[0].cookie })).status, 404);
  const logout = await request('/auth/logout', { cookie: owners[0].cookie, method: 'POST' });
  assert.equal(logout.status, 200);
  assert.equal((await request('/auth/me', { cookie: owners[0].cookie })).status, 401);
  const login = await request('/auth/login', { method: 'POST', body: { email: owners[0].email, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).account.id, owners[0].id);
  assert.equal((await request('/auth/me', { cookie: owners[1].cookie })).status, 200);
});

test('account UI erases an invitation code returned after logout while response JSON is delayed', async () => {
  const script = (await (await request('/account')).text()).match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  let secretDialogs = 0;
  let jsonEntered = false;
  let release;
  const payload = { invitation: { id: 'disposable-invitation-ui-id', label: 'UI invitation' }, invitation_code: 'wmi_' + '1'.repeat(64) };
  const delayed = new Promise(resolve => { release = () => resolve(payload); });
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', className: '', disabled: false, hidden: false, open: false, children: [], listeners: {},
      addEventListener(type, handler) { this.listeners[type] = handler; },
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute() {}, querySelectorAll() { return []; },
      showModal() { this.open = true; if (id === 'invitation-secret-dialog') secretDialogs++; }, close() { this.open = false; },
      classList: { add() {}, remove() {} },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { visibilityState: 'visible', getElementById: element, createElement: tag => element('created-' + tag + '-' + elements.size), addEventListener() {} },
    window: { addEventListener() {} }, navigator: { clipboard: { writeText: async () => {} } }, TextEncoder, setTimeout, clearTimeout,
    fetch(path, options) {
      if (path === '/auth/config' || path === '/auth/me') return new Promise(() => {});
      if (path === '/admin/invitations' && options.method === 'POST') return Promise.resolve({ ok: true, status: 201, json: () => { jsonEntered = true; return delayed; } });
      if (path === '/auth/logout') return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      throw new Error('unexpected mocked invitation UI request');
    },
  });
  new vm.Script(script).runInContext(context);
  context.showAccount({ id: 'disposable-invitation-ui-account', email: 'ui@example.invalid', display_name: 'UI account' });
  element('admin-details').open = true;
  element('admin-key').value = ADMIN;
  element('invitation-label').value = 'UI invitation';
  element('invitation-max-uses').value = '1';
  element('admin-invitation-form').listeners.submit({ preventDefault() {} });
  const deadline = Date.now() + 3000;
  try {
    while (!jsonEntered && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(jsonEntered, true, 'invitation issuance is awaiting JSON before logout');
    assert.equal(element('admin-key').value.length, 0, 'administrator secret is cleared from the input');
    await element('logout').listeners.click();
    release();
    while (element('invitation-create').disabled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(element('invitation-create').disabled, false);
    assert.equal(secretDialogs, 0, 'late invitation never opens a dialog');
    assert.equal(element('invitation-secret-output').value.length, 0);
    assert.equal(payload.invitation_code.length, 0, 'late bearer credential is erased');
    assert.equal(vm.runInContext('state.account === null', context), true);
  } finally { release(); }
});
