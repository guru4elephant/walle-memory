import { hashKey, type Tenant } from './store';

export interface AccountEnv {
  DB: D1Database;
  API_KEY?: string;
  /** Only 'invite' permits registration; every other value is administrator-only. */
  REGISTRATION_MODE?: string;
}

export interface Account {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
}

interface PasswordAccount extends Account {
  password_hash: string;
  password_salt: string;
  password_iterations: number;
}

export interface Space extends Tenant {
  display_name: string;
  memory_type: string;
  legacy_key_active: boolean;
}

export const MEMORY_SCOPES = ['read', 'write', 'delete', 'gc'] as const;
type Scope = typeof MEMORY_SCOPES[number];

interface KeyRow {
  id: string;
  space_id: string;
  label: string;
  prefix: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

interface Invitation {
  id: string;
  label: string;
  prefix: string;
  created_at: number;
  expires_at: number | null;
  max_uses: number;
  uses: number;
  revoked_at: number | null;
}

const ACCOUNT_COLUMNS = 'id, email, display_name, created_at';
const SPACE_COLUMNS = 'id, name, display_name, memory_type, created_at, legacy_key_revoked_at';
const KEY_COLUMNS = 'id, space_id, label, prefix, scopes, created_at, expires_at, revoked_at';
const INVITATION_COLUMNS = 'id, label, prefix, created_at, expires_at, max_uses, uses, revoked_at';
// Evaluate invitation expiry when D1 executes the statement, including queue time.
const SQL_NOW_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
// Production workerd limits WebCrypto PBKDF2 to 100,000 iterations. Persist the
// work factor with each password so a future supported upgrade can rehash it.
const PASSWORD_ITERATIONS = 100000;
const encoder = new TextEncoder();
const responseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

class AccountHttpError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) { super(message); }
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...responseHeaders, ...extraHeaders } });
}

function randomHex(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

function sameHash(a: string, b: string): boolean {
  let different = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) different |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return different === 0;
}

function checkedString(value: unknown, field: string, maxBytes: number, nonempty = true): string {
  if (typeof value !== 'string' || value.includes('\0') || (nonempty && !value.trim())) {
    throw new AccountHttpError(400, `invalid ${field}`);
  }
  if (encoder.encode(value).byteLength > maxBytes) throw new AccountHttpError(400, `${field} is too long`);
  return value;
}

function emailFrom(value: unknown): string {
  const email = checkedString(value, 'email', 254).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccountHttpError(400, 'invalid email');
  return email;
}

function passwordFrom(value: unknown, creating: boolean): string {
  const password = checkedString(value, 'password', 1024);
  if (creating && password.length < 12) throw new AccountHttpError(400, 'password must contain at least 12 characters');
  return password;
}

function memoryTypeFrom(value: unknown): string {
  const memoryType = checkedString(value, 'memory_type', 64).trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(memoryType)) {
    throw new AccountHttpError(400, 'memory_type must be a lowercase identifier');
  }
  return memoryType;
}

function idFrom(value: string): string {
  let id: string;
  try { id = decodeURIComponent(value); }
  catch { throw new AccountHttpError(400, 'invalid URL encoding'); }
  return checkedString(id, 'id', 128);
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new AccountHttpError(415, 'content-type must be application/json');
  }
  const maxBytes = 16 * 1024;
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new AccountHttpError(413, 'request body too large');
  if (!request.body) throw new AccountHttpError(400, 'invalid JSON');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AccountHttpError(413, 'request body too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new AccountHttpError(400, 'invalid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccountHttpError(400, 'body must be a JSON object');
  return body as Record<string, unknown>;
}

function assertSameOrigin(request: Request): void {
  const url = new URL(request.url);
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new AccountHttpError(403, 'same-origin request required');
  }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(localhost && url.protocol === 'http:')) {
    throw new AccountHttpError(403, 'HTTPS is required');
  }
}

function sessionCookieName(request: Request): string {
  // The __Host- prefix prevents a sibling domain from setting a parent-domain
  // session cookie. Browsers require HTTPS for this prefix, so local HTTP uses
  // a distinct development cookie that production requests never accept.
  return new URL(request.url).protocol === 'https:' ? '__Host-walle_session' : 'walle_session';
}

function sessionCookie(request: Request, raw: string, maxAge = SESSION_SECONDS): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${sessionCookieName(request)}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function readSessionToken(request: Request): string | null {
  const name = sessionCookieName(request);
  const matches = (request.headers.get('cookie') ?? '').split(';')
    .map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const raw = matches[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}

async function sessionAccount(request: Request, db: D1Database): Promise<Account> {
  const raw = readSessionToken(request);
  if (!raw) throw new AccountHttpError(401, 'login required');
  const account = await db.prepare(`SELECT a.id, a.email, a.display_name, a.created_at
    FROM account_sessions s JOIN accounts a ON a.id = s.account_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND a.disabled_at IS NULL`)
    .bind(await hashKey(raw), Date.now()).first<Account>();
  if (!account) throw new AccountHttpError(401, 'login required');
  return account;
}

async function passwordHash(password: string, salt: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  const saltBytes = new Uint8Array(salt.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const hash = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

/** Fixed windows, atomic D1 counters, and bounded cleanup. Returns seconds to retry. */
export async function consumeRateLimit(db: D1Database, bucket: string, limit: number, windowSeconds: number): Promise<number | null> {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const bucketHash = await hashKey(`${bucket}:${windowStart}`);
  const [, , count] = await db.batch<{ attempts: number }>([
    db.prepare(`DELETE FROM auth_rate_limits WHERE bucket_hash IN
      (SELECT bucket_hash FROM auth_rate_limits WHERE expires_at <= ? LIMIT 100)`).bind(now),
    db.prepare(`INSERT INTO auth_rate_limits (bucket_hash, window_start, attempts, expires_at)
      VALUES (?, ?, 1, ?) ON CONFLICT(bucket_hash) DO UPDATE SET attempts = attempts + 1`)
      .bind(bucketHash, windowStart, windowStart + windowMs),
    db.prepare('SELECT attempts FROM auth_rate_limits WHERE bucket_hash = ?').bind(bucketHash),
  ]);
  return count.results[0].attempts > limit ? Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) : null;
}

async function enforceRateLimit(db: D1Database, bucket: string, limit: number, windowSeconds: number): Promise<void> {
  const retry = await consumeRateLimit(db, bucket, limit, windowSeconds);
  if (retry !== null) throw new AccountHttpError(429, 'too many requests', retry);
}

async function authenticationRateLimit(request: Request, db: D1Database, email: string, register: boolean): Promise<void> {
  // CF overwrites this header at its edge. Never accept a spoofable forwarded IP.
  const ip = (request.headers.get('cf-connecting-ip') ?? 'unknown').slice(0, 128);
  if (register) {
    await enforceRateLimit(db, `register:ip:${ip}`, 5, 3600);
    await enforceRateLimit(db, `register:email:${email}`, 3, 3600);
  } else {
    await enforceRateLimit(db, `login:ip:${ip}`, 20, 900);
    await enforceRateLimit(db, `login:email:${email}`, 10, 900);
  }
}

async function createAccount(db: D1Database, body: Record<string, unknown>): Promise<Account> {
  const email = emailFrom(body.email);
  const password = passwordFrom(body.password, true);
  const displayName = body.display_name === undefined ? email.split('@')[0] : checkedString(body.display_name, 'display_name', 512).trim();
  const account = { id: randomHex(16), email, display_name: displayName, created_at: Date.now() };
  const salt = randomHex(32);
  try {
    await db.prepare(`INSERT INTO accounts
      (id, email, display_name, password_hash, password_salt, password_iterations, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(account.id, email, displayName, await passwordHash(password, salt), salt, PASSWORD_ITERATIONS, account.created_at).run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed: accounts.email/i.test(error.message)) {
      throw new AccountHttpError(409, 'account cannot be created with this email');
    }
    throw error;
  }
  return account;
}

function registrationMode(env: AccountEnv): 'admin' | 'invite' {
  // Previous/unknown modes must not enable invitation-free registration.
  return env.REGISTRATION_MODE === 'invite' ? 'invite' : 'admin';
}

function registrationDenied(): AccountHttpError {
  return new AccountHttpError(400, 'registration cannot be completed');
}

async function registerWithInvitation(request: Request, db: D1Database, body: Record<string, unknown>): Promise<Response> {
  const code = body.invitation_code;
  // The code is a bearer credential. Accept it only in this bounded JSON body.
  if (typeof code !== 'string' || !/^wmi_[a-f0-9]{64}$/.test(code)) throw registrationDenied();
  const codeHash = await hashKey(code);
  const available = await db.prepare(`SELECT id FROM registration_invitations
    WHERE code_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ${SQL_NOW_MS}) AND uses < max_uses`)
    .bind(codeHash).first<{ id: string }>();
  if (!available) throw registrationDenied();

  const email = emailFrom(body.email);
  const password = passwordFrom(body.password, true);
  const displayName = body.display_name === undefined ? email.split('@')[0] : checkedString(body.display_name, 'display_name', 512).trim();
  const salt = randomHex(32);
  const hash = await passwordHash(password, salt);
  // Recheck expiry after the KDF. The precheck is only a cheap rejection path.
  const now = Date.now();
  const account = { id: randomHex(16), email, display_name: displayName, created_at: now };
  const sessionToken = randomHex(32);
  const sessionHash = await hashKey(sessionToken);
  const redemptionId = randomHex(32);
  try {
    // D1 batches are transactions: a missing/expired/revoked/exhausted invitation
    // makes the conditional UPDATE affect zero rows. The following unconditional
    // INSERT then violates password_hash NOT NULL and rolls back the whole batch.
    // A duplicate email or a failed session INSERT also rolls back the usage count.
    // No INSERT SELECT with zero rows or OR IGNORE may bypass this failure gate.
    await db.batch([
      db.prepare(`UPDATE registration_invitations SET uses = uses + 1, last_redemption_id = ?
        WHERE id = ? AND code_hash = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ${SQL_NOW_MS}) AND uses < max_uses`)
        .bind(redemptionId, available.id, codeHash),
      db.prepare(`INSERT INTO accounts
        (id, email, display_name, password_hash, password_salt, password_iterations, created_at)
        VALUES (?, ?, ?, CASE WHEN EXISTS (
          SELECT id FROM registration_invitations WHERE id = ? AND code_hash = ? AND last_redemption_id = ?
        ) THEN ? ELSE NULL END, ?, ?, ?)`)
        .bind(account.id, email, displayName, available.id, codeHash, redemptionId, hash, salt, PASSWORD_ITERATIONS, now),
      db.prepare('INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(sessionHash, account.id, now, now + SESSION_SECONDS * 1000),
    ]);
  } catch {
    // Do not expose email uniqueness, invite state, receipt, hash, or D1 bound data.
    throw registrationDenied();
  }
  return json({ account }, 201, { 'Set-Cookie': sessionCookie(request, sessionToken) });
}

async function startSession(request: Request, db: D1Database, account: Account, status = 200): Promise<Response> {
  const raw = randomHex(32);
  const now = Date.now();
  await db.batch([
    db.prepare(`DELETE FROM account_sessions WHERE token_hash IN
      (SELECT token_hash FROM account_sessions WHERE expires_at <= ? LIMIT 100)`).bind(now),
    db.prepare('INSERT INTO account_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await hashKey(raw), account.id, now, now + SESSION_SECONDS * 1000),
  ]);
  return json({ account }, status, { 'Set-Cookie': sessionCookie(request, raw) });
}

function publicSpace(row: Tenant & { display_name: string; memory_type: string; legacy_key_revoked_at: number | null }): Space {
  const { legacy_key_revoked_at, ...space } = row;
  return { ...space, legacy_key_active: legacy_key_revoked_at === null };
}

async function ownedSpace(db: D1Database, accountId: string, spaceId: string): Promise<Space> {
  const row = await db.prepare(`SELECT ${SPACE_COLUMNS} FROM tenants WHERE id = ? AND owner_account_id = ?`)
    .bind(spaceId, accountId).first<Tenant & { display_name: string; memory_type: string; legacy_key_revoked_at: number | null }>();
  if (!row) throw new AccountHttpError(404, 'space not found');
  return publicSpace(row);
}

function publicKey(row: KeyRow): Omit<KeyRow, 'scopes'> & { scopes: string[] } {
  return { ...row, scopes: JSON.parse(row.scopes) as string[] };
}

function scopesFrom(value: unknown): Scope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MEMORY_SCOPES.length
    || value.some(scope => typeof scope !== 'string' || !MEMORY_SCOPES.includes(scope as Scope))) {
    throw new AccountHttpError(400, 'scopes must contain read, write, delete, or gc');
  }
  return [...new Set(value)] as Scope[];
}

async function adminAuthorized(request: Request, env: AccountEnv): Promise<void> {
  if (!env.API_KEY?.trim()) throw new AccountHttpError(503, 'admin API is not configured');
  const raw = request.headers.get('x-api-key') ?? '';
  if (!raw || raw.length > 512 || !sameHash(await hashKey(raw), await hashKey(env.API_KEY))) {
    throw new AccountHttpError(401, 'unauthorized');
  }
}

/** Resolve only memory credentials. Cookies never authorize the memory API. */
export async function resolveMemoryAuth(db: D1Database, rawKey: string): Promise<{ tenant: Tenant; scopes: string[] } | null> {
  if (!rawKey || rawKey.length > 512) return null;
  const hash = await hashKey(rawKey);
  const row = await db.prepare(`SELECT t.id, t.display_name AS name, t.created_at, k.scopes
    FROM api_keys k JOIN tenants t ON t.id = k.space_id
    JOIN accounts a ON a.id = k.account_id AND a.id = t.owner_account_id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)
      AND a.disabled_at IS NULL`).bind(hash, Date.now()).first<Tenant & { scopes: string }>();
  if (row) {
    const { scopes, ...tenant } = row;
    const parsed: unknown = JSON.parse(scopes);
    if (!Array.isArray(parsed) || parsed.some(scope => !MEMORY_SCOPES.includes(scope as Scope))) return null;
    return { tenant, scopes: parsed as string[] };
  }
  // A revoked/expired scoped credential must never regain access through legacy.
  if (await db.prepare('SELECT id FROM api_keys WHERE key_hash = ?').bind(hash).first()) return null;
  const tenant = await db.prepare(`SELECT t.id, t.name, t.created_at FROM tenants t
    LEFT JOIN accounts a ON a.id = t.owner_account_id
    WHERE t.api_key_hash = ? AND t.legacy_key_revoked_at IS NULL
      AND (t.owner_account_id IS NULL OR a.disabled_at IS NULL)`).bind(hash).first<Tenant>();
  return tenant ? { tenant, scopes: [...MEMORY_SCOPES] } : null;
}

async function routeAccount(request: Request, env: AccountEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const db = env.DB;
  if (path === '/auth/config' && method === 'GET') {
    return json({ registration_mode: registrationMode(env) });
  }
  if (path.startsWith('/auth/')) {
    if (path === '/auth/me' && method === 'GET') return json({ account: await sessionAccount(request, db) });
    if (method !== 'POST' || !['/auth/login', '/auth/register', '/auth/logout'].includes(path)) {
      throw new AccountHttpError(404, 'not found');
    }
    assertSameOrigin(request);
    if (path === '/auth/logout') {
      const raw = readSessionToken(request);
      if (raw) await db.prepare('DELETE FROM account_sessions WHERE token_hash = ?').bind(await hashKey(raw)).run();
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
    }
    if (path === '/auth/register' && registrationMode(env) !== 'invite') {
      throw new AccountHttpError(403, 'registration is disabled');
    }
    const body = await bodyObject(request);
    const email = emailFrom(body.email);
    await authenticationRateLimit(request, db, email, path === '/auth/register');
    if (path === '/auth/register') return registerWithInvitation(request, db, body);
    const password = passwordFrom(body.password, false);
    const stored = await db.prepare(`SELECT ${ACCOUNT_COLUMNS}, password_hash, password_salt, password_iterations
      FROM accounts WHERE email = ? AND disabled_at IS NULL`).bind(email).first<PasswordAccount>();
    // Match the expensive path for unknown accounts to reduce timing enumeration.
    const actual = await passwordHash(password, stored?.password_salt ?? '00'.repeat(32), stored?.password_iterations ?? PASSWORD_ITERATIONS);
    if (!stored || !sameHash(actual, stored.password_hash)) throw new AccountHttpError(401, 'invalid email or password');
    const { password_hash: _hash, password_salt: _salt, password_iterations: _iterations, ...account } = stored;
    return startSession(request, db, account);
  }

  const adminAccounts = path === '/admin/accounts' || path.startsWith('/admin/accounts/');
  const adminInvitations = path === '/admin/invitations' || path.startsWith('/admin/invitations/');
  const adminLegacy = path.match(/^\/admin\/tenants\/([^/]+)\/revoke-legacy-key$/);
  if (adminAccounts || adminInvitations || adminLegacy) {
    await adminAuthorized(request, env);
    if (path === '/admin/invitations' && method === 'GET') {
      return json({ invitations: (await db.prepare(`SELECT ${INVITATION_COLUMNS}
        FROM registration_invitations ORDER BY created_at ASC`).all<Invitation>()).results });
    }
    if (path === '/admin/invitations' && method === 'POST') {
      await enforceRateLimit(db, 'invitation-create:admin', 30, 3600);
      const body = await bodyObject(request);
      const label = checkedString(body.label, 'label', 128).trim();
      const maxUses = body.max_uses === undefined ? 1 : body.max_uses;
      if (typeof maxUses !== 'number' || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000) {
        throw new AccountHttpError(400, 'max_uses must be an integer from 1 to 1000');
      }
      const now = Date.now();
      const expiresAt = body.expires_at ?? null;
      if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= now)) {
        throw new AccountHttpError(400, 'expires_at must be a future Unix timestamp in milliseconds');
      }
      const raw = `wmi_${randomHex(32)}`;
      const invitation: Invitation = {
        id: randomHex(16), label, prefix: raw.slice(0, 12), created_at: now,
        expires_at: expiresAt as number | null, max_uses: maxUses, uses: 0, revoked_at: null,
      };
      const inserted = await db.prepare(`INSERT INTO registration_invitations
        (id, label, prefix, code_hash, created_at, expires_at, max_uses, uses, revoked_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, 0, NULL WHERE
          (SELECT count(*) FROM registration_invitations WHERE revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > ${SQL_NOW_MS}) AND uses < max_uses) < 100`)
        .bind(invitation.id, label, invitation.prefix, await hashKey(raw), now, expiresAt, maxUses).run();
      if (inserted.meta.changes === 0) throw new AccountHttpError(409, 'active invitation limit reached');
      return json({ invitation, invitation_code: raw }, 201);
    }
    const revokeInvitation = path.match(/^\/admin\/invitations\/([^/]+)$/);
    if (revokeInvitation && method === 'DELETE') {
      const id = idFrom(revokeInvitation[1]);
      const result = await db.prepare(`UPDATE registration_invitations
        SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`).bind(Date.now(), id).run();
      if (result.meta.changes === 0) throw new AccountHttpError(404, 'invitation not found');
      return json({ ok: true, id });
    }
    if (path === '/admin/accounts' && method === 'GET') {
      return json({ accounts: (await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at ASC`).all<Account>()).results });
    }
    if (path === '/admin/accounts' && method === 'POST') return json({ account: await createAccount(db, await bodyObject(request)) }, 201);
    const claim = path.match(/^\/admin\/accounts\/([^/]+)\/spaces\/([^/]+)\/claim$/);
    if (claim && method === 'POST') {
      const accountId = idFrom(claim[1]);
      const spaceId = idFrom(claim[2]);
      if (!await db.prepare('SELECT id FROM accounts WHERE id = ? AND disabled_at IS NULL').bind(accountId).first()) {
        throw new AccountHttpError(404, 'account not found');
      }
      const body = request.body ? await bodyObject(request) : {};
      const displayName = body.display_name === undefined ? null : checkedString(body.display_name, 'display_name', 512).trim();
      const memoryType = body.memory_type === undefined ? null : memoryTypeFrom(body.memory_type);
      const updated = await db.prepare(`UPDATE tenants SET owner_account_id = ?,
        display_name = COALESCE(?, display_name), memory_type = COALESCE(?, memory_type)
        WHERE id = ? AND (owner_account_id IS NULL OR owner_account_id = ?)
          AND EXISTS (SELECT id FROM accounts WHERE id = ? AND disabled_at IS NULL)`)
        .bind(accountId, displayName, memoryType, spaceId, accountId, accountId).run();
      if (updated.meta.changes === 0) {
        if (!await db.prepare('SELECT id FROM tenants WHERE id = ?').bind(spaceId).first()) throw new AccountHttpError(404, 'space not found');
        throw new AccountHttpError(409, 'space is already assigned to another account');
      }
      return json({ space: await ownedSpace(db, accountId, spaceId) });
    }
    if (adminLegacy && method === 'POST') {
      const id = idFrom(adminLegacy[1]);
      // Also destroy the active legacy hash so rolling back to a Worker that
      // ignores legacy_key_revoked_at cannot restore the revoked credential.
      const result = await db.prepare(`UPDATE tenants SET
        api_key_hash = CASE WHEN legacy_key_revoked_at IS NULL THEN ? ELSE api_key_hash END,
        legacy_key_revoked_at = COALESCE(legacy_key_revoked_at, ?) WHERE id = ?`)
        .bind(await hashKey(randomHex(32)), Date.now(), id).run();
      if (result.meta.changes === 0) throw new AccountHttpError(404, 'space not found');
      return json({ ok: true, id });
    }
    throw new AccountHttpError(404, 'not found');
  }

  if (path !== '/account' && !path.startsWith('/account/')) return null;
  const account = await sessionAccount(request, db);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) assertSameOrigin(request);
  if (path === '/account/spaces' && method === 'GET') {
    const rows = await db.prepare(`SELECT ${SPACE_COLUMNS} FROM tenants WHERE owner_account_id = ? ORDER BY created_at ASC`)
      .bind(account.id).all<Tenant & { display_name: string; memory_type: string; legacy_key_revoked_at: number | null }>();
    return json({ spaces: rows.results.map(publicSpace) });
  }
  if (path === '/account/spaces' && method === 'POST') {
    await enforceRateLimit(db, `space-create:account:${account.id}`, 20, 3600);
    const body = await bodyObject(request);
    const displayName = checkedString(body.display_name, 'display_name', 512).trim();
    const memoryType = memoryTypeFrom(body.memory_type ?? 'general');
    const space = { id: randomHex(16), name: `space_${randomHex(16)}`, display_name: displayName, memory_type: memoryType, created_at: Date.now(), legacy_key_active: false };
    const result = await db.prepare(`INSERT INTO tenants
      (id, name, api_key_hash, created_at, owner_account_id, display_name, memory_type, legacy_key_revoked_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE
        (SELECT count(*) FROM tenants WHERE owner_account_id = ?) < 100`)
      .bind(space.id, space.name, await hashKey(randomHex(32)), space.created_at, account.id, displayName, memoryType, space.created_at, account.id).run();
    if (result.meta.changes === 0) throw new AccountHttpError(409, 'space limit reached');
    return json({ space }, 201);
  }
  const spaceMatch = path.match(/^\/account\/spaces\/([^/]+)$/);
  if (spaceMatch && method === 'DELETE') {
    const id = idFrom(spaceMatch[1]);
    // Ownership is checked in the mutation itself, including cascading memory/key deletion.
    const result = await db.prepare('DELETE FROM tenants WHERE id = ? AND owner_account_id = ?').bind(id, account.id).run();
    if (result.meta.changes === 0) throw new AccountHttpError(404, 'space not found');
    return json({ ok: true, id });
  }
  const legacyMatch = path.match(/^\/account\/spaces\/([^/]+)\/revoke-legacy-key$/);
  if (legacyMatch && method === 'POST') {
    const id = idFrom(legacyMatch[1]);
    const result = await db.prepare(`UPDATE tenants SET
      api_key_hash = CASE WHEN legacy_key_revoked_at IS NULL THEN ? ELSE api_key_hash END,
      legacy_key_revoked_at = COALESCE(legacy_key_revoked_at, ?)
      WHERE id = ? AND owner_account_id = ?`)
      .bind(await hashKey(randomHex(32)), Date.now(), id, account.id).run();
    if (result.meta.changes === 0) throw new AccountHttpError(404, 'space not found');
    return json({ ok: true, id });
  }
  const keysMatch = path.match(/^\/account\/spaces\/([^/]+)\/keys$/);
  if (keysMatch && ['GET', 'POST'].includes(method)) {
    const spaceId = idFrom(keysMatch[1]);
    await ownedSpace(db, account.id, spaceId);
    if (method === 'GET') {
      const rows = await db.prepare(`SELECT ${KEY_COLUMNS} FROM api_keys
        WHERE space_id = ? AND account_id = ? AND EXISTS
          (SELECT id FROM tenants WHERE id = ? AND owner_account_id = ?) ORDER BY created_at ASC`)
        .bind(spaceId, account.id, spaceId, account.id).all<KeyRow>();
      return json({ keys: rows.results.map(publicKey) });
    }
    await enforceRateLimit(db, `key-create:account:${account.id}`, 30, 3600);
    const body = await bodyObject(request);
    const label = checkedString(body.label, 'label', 128).trim();
    const scopes = scopesFrom(body.scopes);
    const now = Date.now();
    const expiresAt = body.expires_at ?? null;
    if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= now)) {
      throw new AccountHttpError(400, 'expires_at must be a future Unix timestamp in milliseconds');
    }
    const raw = `wmk_${randomHex(32)}`;
    const key = { id: randomHex(16), space_id: spaceId, label, prefix: raw.slice(0, 12), scopes, created_at: now, expires_at: expiresAt as number | null, revoked_at: null };
    const result = await db.prepare(`INSERT INTO api_keys
      (id, space_id, account_id, key_hash, label, prefix, scopes, created_at, expires_at, revoked_at)
      SELECT ?, id, ?, ?, ?, ?, ?, ?, ?, NULL FROM tenants WHERE id = ? AND owner_account_id = ?
        AND (SELECT count(*) FROM api_keys WHERE space_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)) < 100`)
      .bind(key.id, account.id, await hashKey(raw), label, key.prefix, JSON.stringify(scopes), now, expiresAt, spaceId, account.id, spaceId, now).run();
    if (result.meta.changes === 0) throw new AccountHttpError(409, 'active key limit reached or space no longer available');
    return json({ key, api_key: raw }, 201);
  }
  const revokeMatch = path.match(/^\/account\/spaces\/([^/]+)\/keys\/([^/]+)$/);
  if (revokeMatch && method === 'DELETE') {
    const spaceId = idFrom(revokeMatch[1]);
    const id = idFrom(revokeMatch[2]);
    const result = await db.prepare(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ? AND space_id = ? AND account_id = ? AND EXISTS
        (SELECT id FROM tenants WHERE id = ? AND owner_account_id = ?)`)
      .bind(Date.now(), id, spaceId, account.id, spaceId, account.id).run();
    if (result.meta.changes === 0) throw new AccountHttpError(404, 'key not found');
    return json({ ok: true, id });
  }
  throw new AccountHttpError(404, 'not found');
}

/** Returns null only when a request belongs to the existing memory/admin router. */
export async function handleAccountRequest(request: Request, env: AccountEnv): Promise<Response | null> {
  try { return await routeAccount(request, env); }
  catch (error) {
    if (!(error instanceof AccountHttpError)) throw error;
    return json({ error: error.message }, error.status, error.retryAfter === undefined ? {} : { 'Retry-After': String(error.retryAfter) });
  }
}
