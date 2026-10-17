import { consumeRateLimit } from './accounts';
import type { Tenant } from './store';
import { getOAuthAuthorizeHtml } from './oauth-ui';

export interface OAuthEnv {
  DB: D1Database;
  /** Canonical HTTPS origin, configured by the operator; never inferred from Host. */
  OAUTH_ISSUER?: string;
  /** Optional JSON array of exact origins for public OAuth protocol endpoints. */
  OAUTH_ALLOWED_ORIGINS?: string;
}

export const OAUTH_SCOPES = ['memory:read', 'memory:write', 'memory:delete', 'memory:gc'] as const;
export type OAuthScope = typeof OAUTH_SCOPES[number];
const AUTHORIZATION_SCOPES = [...OAUTH_SCOPES, 'offline_access'] as const;
type AuthorizationScope = typeof AUTHORIZATION_SCOPES[number];
export interface OAuthAccessContext { kind: 'oauth'; tokenHash: string; resource: string }
const NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
const ACCESS_MS = 10 * 60 * 1000;
const IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const GRANT_MS = 90 * 24 * 60 * 60 * 1000;
const REQUEST_MS = 10 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();
const BASE_HEADERS = {
  'Cache-Control': 'no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
};

class OAuthError extends Error {
  constructor(readonly error: string, readonly status = 400, readonly description = error, readonly retryAfter?: number) { super(description); }
}
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}
function raw(prefix: string): string {
  return prefix + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
}
async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function challenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function string(value: unknown, name: string, max = 2048): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || encoder.encode(value).length > max) {
    throw new OAuthError('invalid_request', 400, `invalid ${name}`);
  }
  return value;
}
function localhost(url: URL): boolean { return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
export function oauthIssuer(env: Pick<OAuthEnv, 'OAUTH_ISSUER'>): string {
  let url: URL;
  try { url = new URL(env.OAUTH_ISSUER ?? ''); }
  catch { throw new OAuthError('temporarily_unavailable', 503, 'OAuth issuer is not configured'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost(url))) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || env.OAUTH_ISSUER?.replace(/\/$/, '') !== url.origin) {
    throw new OAuthError('temporarily_unavailable', 503, 'OAuth issuer must be a canonical HTTPS origin');
  }
  return url.origin;
}
export function oauthResource(env: Pick<OAuthEnv, 'OAUTH_ISSUER'>): string { return oauthIssuer(env) + '/mcp'; }

/** Every store statement and its admission check use this predicate in one D1 batch. */
export function oauthAccessGuard(tokenHash: string, resource: string, tenantId: string, requiredScope: string): { sql: string; values: unknown[] } {
  const scope = requiredScope.startsWith('memory:') ? requiredScope : `memory:${requiredScope}`;
  return {
    sql: `EXISTS (SELECT 1 FROM oauth_access_tokens oat
      JOIN oauth_grants og ON og.id = oat.grant_id
      JOIN accounts oa ON oa.id = og.account_id
      JOIN tenants default_t ON default_t.id=og.space_id AND default_t.owner_account_id=og.account_id
      JOIN oauth_grant_spaces ogs ON ogs.grant_id = og.id
      JOIN tenants ot ON ot.id = ogs.space_id AND ot.owner_account_id = og.account_id
      JOIN oauth_clients oc ON oc.client_id = og.client_id
      WHERE oat.token_hash = ? AND og.resource = ? AND ot.id = ?
        AND oat.expires_at > ${NOW} AND og.expires_at > ${NOW} AND og.idle_expires_at > ${NOW}
        AND og.revoked_at IS NULL AND oa.disabled_at IS NULL
        AND EXISTS (SELECT 1 FROM json_each(oat.scopes) s WHERE s.type = 'text' AND s.value = ?)
        AND EXISTS (SELECT 1 FROM json_each(og.scopes) s WHERE s.type = 'text' AND s.value = ?))`,
    values: [tokenHash, resource, tenantId, scope, scope],
  };
}
export async function resolveOAuthAccess(db: D1Database, rawToken: string, resource: string): Promise<{
  tenant: Tenant; workspaces: (Tenant & { display_name: string; memory_type: string })[]; scopes: string[]; credential: OAuthAccessContext;
} | null> {
  if (!/^wma_[a-f0-9]{64}$/.test(rawToken)) return null;
  const tokenHash = await hash(rawToken);
  const row = await db.prepare(`SELECT t.id, t.name, t.created_at, tok.scopes
    FROM oauth_access_tokens tok JOIN oauth_grants g ON g.id = tok.grant_id
    JOIN accounts a ON a.id = g.account_id JOIN tenants t ON t.id = g.space_id AND t.owner_account_id = g.account_id
    JOIN oauth_clients c ON c.client_id = g.client_id
    WHERE tok.token_hash = ? AND g.resource = ? AND tok.expires_at > ${NOW}
      AND g.expires_at > ${NOW} AND g.idle_expires_at > ${NOW} AND g.revoked_at IS NULL AND a.disabled_at IS NULL`)
    .bind(tokenHash, resource).first<Tenant & { scopes: string }>();
  if (!row) return null;
  const { scopes, ...tenant } = row;
  const workspaces = await db.prepare(`SELECT t.id,t.name,t.display_name,t.memory_type,t.created_at
    FROM oauth_access_tokens tok JOIN oauth_grants g ON g.id=tok.grant_id
    JOIN oauth_grant_spaces gs ON gs.grant_id=g.id
    JOIN tenants t ON t.id=gs.space_id AND t.owner_account_id=g.account_id
    JOIN accounts a ON a.id=g.account_id
    WHERE tok.token_hash=? AND g.resource=? AND tok.expires_at>${NOW}
      AND g.expires_at>${NOW} AND g.idle_expires_at>${NOW} AND g.revoked_at IS NULL AND a.disabled_at IS NULL
    ORDER BY (t.id=g.space_id) DESC,t.created_at,t.id`).bind(tokenHash,resource)
    .all<Tenant & { display_name: string; memory_type: string }>();
  if (!workspaces.results.some(w => w.id === tenant.id)) return null;
  return { tenant, workspaces: workspaces.results, scopes: JSON.parse(scopes), credential: { kind: 'oauth', tokenHash, resource } };
}

async function readBody(request: Request): Promise<string> {
  if (Number(request.headers.get('content-length')) > 16384) throw new OAuthError('invalid_request', 413, 'request body too large');
  if (!request.body) throw new OAuthError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 16384) { await reader.cancel(); throw new OAuthError('invalid_request', 413, 'request body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
async function object(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new OAuthError('invalid_request', 415, 'JSON content-type required');
  let body: unknown;
  try { body = JSON.parse(await readBody(request)); }
  catch (error) { if (error instanceof OAuthError) throw error; throw new OAuthError('invalid_request'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_request');
  return body as Record<string, unknown>;
}
function unique(params: URLSearchParams): void {
  const seen = new Set<string>();
  for (const [key] of params) { if (seen.has(key)) throw new OAuthError('invalid_request', 400, `duplicate ${key}`); seen.add(key); }
}
async function form(request: Request): Promise<URLSearchParams> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
    throw new OAuthError('invalid_request', 415, 'form content-type required');
  }
  if (request.headers.has('authorization')) throw new OAuthError('invalid_client', 401, 'public clients must not use client authentication');
  const params = new URLSearchParams(await readBody(request));
  unique(params);
  if (params.has('client_secret') || params.has('client_assertion')) throw new OAuthError('invalid_client', 401);
  return params;
}
function scopes(value: unknown, fallback = 'memory:read'): AuthorizationScope[] {
  const text = value === null || value === undefined ? fallback : string(value, 'scope', 256);
  const result = text.split(' ');
  if (!result.length || result.some(s => !(AUTHORIZATION_SCOPES as readonly string[]).includes(s)) || new Set(result).size !== result.length) {
    throw new OAuthError('invalid_scope');
  }
  if (!result.some(s => (OAUTH_SCOPES as readonly string[]).includes(s))) throw new OAuthError('invalid_scope');
  return result as AuthorizationScope[];
}
function sameOrigin(request: Request, issuer: string, context = false): void {
  const origin = request.headers.get('origin');
  if (new URL(request.url).origin !== issuer || request.headers.get('sec-fetch-site') === 'cross-site' ||
      (origin !== issuer && !(context && origin === null && request.headers.get('sec-fetch-site') === 'same-origin' && request.headers.get('x-walle-oauth') === '1'))) {
    throw new OAuthError('access_denied', 403, 'same-origin request required');
  }
}
function sessionHash(request: Request): Promise<string> {
  const name = new URL(request.url).protocol === 'https:' ? '__Host-walle_session' : 'walle_session';
  const values = (request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  const value = values.length === 1 ? values[0].slice(name.length + 1) : '';
  if (!/^[a-f0-9]{64}$/.test(value)) throw new OAuthError('login_required', 401, 'login required');
  return hash(value);
}
const SESSION = `EXISTS (SELECT 1 FROM account_sessions ss JOIN accounts aa ON aa.id = ss.account_id
  WHERE ss.token_hash = ? AND ss.account_id = ? AND ss.expires_at > ${NOW} AND aa.disabled_at IS NULL)`;
async function session(request: Request, db: D1Database): Promise<{ hash: string; id: string; email: string; display_name: string }> {
  const tokenHash = await sessionHash(request);
  const account = await db.prepare(`SELECT a.id, a.email, a.display_name FROM account_sessions s
    JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ? AND s.expires_at > ${NOW} AND a.disabled_at IS NULL`)
    .bind(tokenHash).first<{ id: string; email: string; display_name: string }>();
  if (!account) throw new OAuthError('login_required', 401, 'login required');
  return { hash: tokenHash, ...account };
}
async function limit(db: D1Database, bucket: string, count: number, seconds = 3600): Promise<void> {
  const retry = await consumeRateLimit(db, 'oauth:' + bucket, count, seconds);
  if (retry !== null) throw new OAuthError('temporarily_unavailable', 429, 'too many requests', retry);
}
function ip(request: Request): string { return (request.headers.get('cf-connecting-ip') ?? 'unknown').slice(0, 128); }

interface Client { client_id: string; client_name: string; redirect_uris: string }
async function client(db: D1Database, id: unknown): Promise<Client> {
  const value = string(id, 'client_id', 128);
  const row = await db.prepare('SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?').bind(value).first<Client>();
  if (!row) throw new OAuthError('invalid_client', 400, 'unknown client');
  return row;
}
async function register(request: Request, env: OAuthEnv, issuer: string): Promise<Response> {
  await limit(env.DB, `register:ip:${ip(request)}`, 10);
  await limit(env.DB, 'register:global', 100);
  const body = await object(request);
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata', 400, 'only public clients are supported');
  if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || !body.grant_types.includes('authorization_code') || body.grant_types.some(x => !['authorization_code', 'refresh_token'].includes(x)))) throw new OAuthError('invalid_client_metadata');
  if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== 'code')) throw new OAuthError('invalid_client_metadata');
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 || body.redirect_uris.length > 10) throw new OAuthError('invalid_redirect_uri');
  const redirects = body.redirect_uris.map(value => {
    const text = string(value, 'redirect_uri');
    let url: URL;
    try { url = new URL(text); } catch { throw new OAuthError('invalid_redirect_uri'); }
    const devHttp = new URL(issuer).protocol === 'http:' && localhost(url) && url.protocol === 'http:';
    if ((url.protocol !== 'https:' && !devHttp) || url.username || url.password || url.hash || text.includes('#')) throw new OAuthError('invalid_redirect_uri');
    return text;
  });
  if (new Set(redirects).size !== redirects.length) throw new OAuthError('invalid_redirect_uri');
  const name = body.client_name === undefined ? 'Unnamed application' : string(body.client_name, 'client_name', 128).trim();
  if (!name) throw new OAuthError('invalid_client_metadata');
  const id = raw('wmc_');
  const [, , inserted] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM oauth_grants WHERE id IN
      (SELECT id FROM oauth_grants WHERE expires_at <= ${NOW} LIMIT 100)`),
    // A finite quota must recover after abandoned registrations. Keep any client
    // with a durable grant or pending consent; cascade only stale request rows.
    env.DB.prepare(`DELETE FROM oauth_clients WHERE client_id IN
      (SELECT c.client_id FROM oauth_clients c WHERE c.created_at <= ${NOW} - 86400000
        AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.client_id)
        AND NOT EXISTS (SELECT 1 FROM oauth_authorization_requests r WHERE r.client_id = c.client_id
          AND r.consumed_at IS NULL AND r.expires_at > ${NOW}) LIMIT 100)`),
    env.DB.prepare(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
      SELECT ?, ?, ?, ${NOW} WHERE (SELECT count(*) FROM oauth_clients) < 1000`)
      .bind(id, name, JSON.stringify(redirects)),
  ]);
  if (inserted.meta.changes !== 1) throw new OAuthError('temporarily_unavailable', 503, 'client registration limit reached');
  return json({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name,
    redirect_uris: redirects, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, 201);
}

interface Authorization {
  client: Client; redirect_uri: string; resource: string; scopes: AuthorizationScope[]; state: string | null; code_challenge: string;
}
function redirect(uri: string, issuer: string, state: string | null, values: Record<string, string>): string {
  const url = new URL(uri);
  // Do not allow registered callback query parameters to inject response fields.
  for (const key of ['code', 'state', 'iss', 'error', 'error_description']) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  return url.href;
}
async function authorization(params: URLSearchParams, env: OAuthEnv): Promise<Authorization> {
  unique(params);
  const c = await client(env.DB, params.get('client_id'));
  const uri = string(params.get('redirect_uri'), 'redirect_uri');
  if (!(JSON.parse(c.redirect_uris) as string[]).includes(uri)) throw new OAuthError('invalid_request', 400, 'redirect_uri is not registered');
  if (params.get('response_type') !== 'code') throw new OAuthError('unsupported_response_type');
  if (params.get('resource') !== oauthResource(env)) throw new OAuthError('invalid_target');
  const codeChallenge = string(params.get('code_challenge'), 'code_challenge', 128);
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new OAuthError('invalid_request', 400, 'S256 PKCE is required');
  const state = params.has('state') ? string(params.get('state'), 'state', 2048) : null;
  return { client: c, redirect_uri: uri, resource: oauthResource(env), scopes: scopes(params.get('scope')), state, code_challenge: codeChallenge };
}
async function authorizationContext(request: Request, env: OAuthEnv, issuer: string): Promise<Response> {
  sameOrigin(request, issuer, true);
  const a = await authorization(new URL(request.url).searchParams, env);
  const s = await session(request, env.DB);
  await limit(env.DB, `authorize:${s.id}`, 60);
  const id = raw('wmq_'), csrf = raw('csrf_');
  const [_, inserted, available] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM oauth_authorization_requests WHERE id IN
      (SELECT id FROM oauth_authorization_requests WHERE expires_at <= ${NOW} LIMIT 100)`),
    env.DB.prepare(`INSERT INTO oauth_authorization_requests
      (id, session_hash, account_id, client_id, redirect_uri, resource, scopes, state, code_challenge, csrf_hash, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NOW}, ${NOW} + ${REQUEST_MS}
      WHERE ${SESSION} AND EXISTS (SELECT 1 FROM oauth_clients WHERE client_id = ?)
        AND (SELECT count(*) FROM oauth_authorization_requests WHERE account_id = ? AND consumed_at IS NULL AND expires_at > ${NOW}) < 100`)
      .bind(id, s.hash, s.id, a.client.client_id, a.redirect_uri, a.resource, JSON.stringify(a.scopes), a.state, a.code_challenge, await hash(csrf), s.hash, s.id, a.client.client_id, s.id),
    env.DB.prepare(`SELECT id, name, display_name, memory_type, created_at FROM tenants
      WHERE owner_account_id = ? AND ${SESSION} ORDER BY created_at`).bind(s.id, s.hash, s.id),
  ]);
  if (inserted.meta.changes !== 1) throw new OAuthError('access_denied', 403, 'session expired or authorization limit reached');
  return json({ request_id: id, csrf_token: csrf, account: { id: s.id, email: s.email, display_name: s.display_name },
    client: { client_id: a.client.client_id, client_name: a.client.client_name }, redirect_uri: a.redirect_uri, scopes: a.scopes, resource: a.resource, spaces: available.results });
}

interface AuthorizationRow { id: string; account_id: string; client_id: string; redirect_uri: string; state: string | null; resource: string; scopes: string; code_challenge: string }
async function authorize(request: Request, env: OAuthEnv, issuer: string): Promise<Response> {
  sameOrigin(request, issuer);
  const s = await session(request, env.DB);
  const body = await object(request);
  const id = string(body.request_id, 'request_id', 128), csrfHash = await hash(string(body.csrf_token, 'csrf_token', 128));
  if (typeof body.approve !== 'boolean') throw new OAuthError('invalid_request', 400, 'approve must be boolean');
  if (body.scopes !== undefined || body.scope !== undefined || body.resource !== undefined || body.client_id !== undefined) throw new OAuthError('invalid_request');
  let spaceIds: string[] = [];
  let spaceId = '';
  if (body.approve) {
    if (body.space_ids !== undefined && body.space_id !== undefined) throw new OAuthError('invalid_request');
    const selection = body.space_ids === undefined ? [body.space_id] : body.space_ids;
    if (!Array.isArray(selection) || selection.length < 1 || selection.length > 100) throw new OAuthError('invalid_request',400,'select 1–100 workspaces');
    spaceIds = selection.map(value => string(value,'space_id',128));
    if (new Set(spaceIds).size !== spaceIds.length) throw new OAuthError('invalid_request',400,'duplicate workspace');
    spaceId = body.default_space_id === undefined ? spaceIds[0] : string(body.default_space_id,'default_space_id',128);
    if (!spaceIds.includes(spaceId)) throw new OAuthError('invalid_request',400,'default workspace must be selected');
  }
  const receipt = raw('receipt_'), grantId = raw('wmg_'), code = raw('wmac_');
  const spaceGuard = body.approve ? `AND NOT EXISTS (SELECT 1 FROM json_each(?) selected
      WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id=selected.value AND t.owner_account_id=r.account_id))
    AND (SELECT count(*) FROM oauth_grants g WHERE g.account_id = r.account_id AND g.revoked_at IS NULL AND g.expires_at > ${NOW} AND g.idle_expires_at > ${NOW}) < 100` : '';
  const bindings: unknown[] = [receipt, id, s.hash, s.id, csrfHash, s.hash, s.id];
  if (body.approve) bindings.push(JSON.stringify(spaceIds));
  const statements = [env.DB.prepare(`UPDATE oauth_authorization_requests AS r SET consumed_at = ${NOW}, receipt = ?
    WHERE r.id = ? AND r.session_hash = ? AND r.account_id = ? AND r.csrf_hash = ? AND r.consumed_at IS NULL
      AND r.expires_at > ${NOW} AND ${SESSION} ${spaceGuard}`).bind(...bindings)];
  if (body.approve) {
    statements.push(env.DB.prepare(`INSERT INTO oauth_grants
      (id, account_id, space_id, client_id, resource, scopes, created_at, expires_at, idle_expires_at)
      SELECT ?, account_id, ?, client_id, resource, scopes, ${NOW}, ${NOW} + ${GRANT_MS}, ${NOW} + ${IDLE_MS}
      FROM oauth_authorization_requests WHERE id = ? AND receipt = ?`).bind(grantId, spaceId, id, receipt));
    statements.push(env.DB.prepare(`INSERT INTO oauth_grant_spaces (grant_id,space_id)
      SELECT ?,selected.value FROM oauth_authorization_requests r,json_each(?) selected
      WHERE r.id=? AND r.receipt=?`).bind(grantId,JSON.stringify(spaceIds),id,receipt));
    statements.push(env.DB.prepare(`INSERT INTO oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
      SELECT ?, ?, redirect_uri, code_challenge, ${NOW} + ${CODE_MS} FROM oauth_authorization_requests
      WHERE id = ? AND receipt = ?`).bind(await hash(code), grantId, id, receipt));
  }
  statements.push(env.DB.prepare(`SELECT id, account_id, client_id, redirect_uri, state, resource, scopes, code_challenge
    FROM oauth_authorization_requests WHERE id = ? AND receipt = ?`).bind(id, receipt));
  const result = await env.DB.batch<AuthorizationRow>(statements);
  const row = result[result.length - 1].results[0];
  if (!row) throw new OAuthError('access_denied', 403, 'authorization request expired, invalid, or already used');
  return json({ redirect_to: redirect(row.redirect_uri, issuer, row.state, body.approve ? { code } : { error: 'access_denied' }) });
}

// D1 time is used at credential consumption, including requests delayed in its queue.
const LIVE_GRANT = `g.revoked_at IS NULL AND g.expires_at > ${NOW} AND g.idle_expires_at > ${NOW}
  AND EXISTS (SELECT 1 FROM accounts a JOIN tenants t ON t.owner_account_id = a.id
    WHERE a.id = g.account_id AND a.disabled_at IS NULL AND t.id = g.space_id)
  AND EXISTS (SELECT 1 FROM oauth_clients c WHERE c.client_id = g.client_id)`;

async function token(request: Request, env: OAuthEnv): Promise<Response> {
  await limit(env.DB, `token:ip:${ip(request)}`, 120, 60);
  const params = await form(request);
  const c = await client(env.DB, params.get('client_id'));
  const resource = string(params.get('resource'), 'resource');
  if (resource !== oauthResource(env)) throw new OAuthError('invalid_target');
  const grantType = params.get('grant_type');
  if (grantType !== 'authorization_code' && grantType !== 'refresh_token') throw new OAuthError('unsupported_grant_type');
  const receipt = raw('receipt_'), access = raw('wma_'), refresh = raw('wmr_');
  const accessHash = await hash(access), refreshHash = await hash(refresh);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`DELETE FROM oauth_access_tokens WHERE token_hash IN
      (SELECT token_hash FROM oauth_access_tokens WHERE expires_at <= ${NOW} LIMIT 100)`),
    env.DB.prepare(`DELETE FROM oauth_grants WHERE id IN
      (SELECT id FROM oauth_grants WHERE expires_at <= ${NOW} LIMIT 100)`),
  ];
  if (grantType === 'authorization_code') {
    if (params.has('scope')) throw new OAuthError('invalid_request', 400, 'scope is fixed by authorization');
    const code = string(params.get('code'), 'code', 128), verifier = string(params.get('code_verifier'), 'code_verifier', 128);
    if (!/^wmac_[a-f0-9]{64}$/.test(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError('invalid_grant');
    const redirectUri = string(params.get('redirect_uri'), 'redirect_uri');
    const codeChallenge = await challenge(verifier), sourceHash = await hash(code);
    // Only replay with the correct client, resource, redirect and PKCE proof
    // revokes the family; an unrelated caller cannot revoke a stolen code.
    statements.push(env.DB.prepare(`UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ${NOW})
      WHERE client_id = ? AND resource = ? AND id IN
        (SELECT grant_id FROM oauth_codes WHERE code_hash = ? AND redirect_uri = ? AND code_challenge = ? AND consumed_at IS NOT NULL)`)
      .bind(c.client_id, resource, sourceHash, redirectUri, codeChallenge));
    statements.push(env.DB.prepare(`UPDATE oauth_codes SET consumed_at = ${NOW}, receipt = ?
      WHERE code_hash = ? AND redirect_uri = ? AND code_challenge = ? AND consumed_at IS NULL AND expires_at > ${NOW}
        AND EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = oauth_codes.grant_id
          AND g.client_id = ? AND g.resource = ? AND ${LIVE_GRANT})`)
      .bind(receipt, sourceHash, redirectUri, codeChallenge, c.client_id, resource));
    statements.push(env.DB.prepare(`INSERT INTO oauth_refresh_tokens (token_hash, grant_id, scopes, created_at, expires_at)
      SELECT ?, g.id, g.scopes, ${NOW}, MIN(g.expires_at, ${NOW} + ${IDLE_MS})
      FROM oauth_codes src JOIN oauth_grants g ON g.id = src.grant_id WHERE src.code_hash = ? AND src.receipt = ?`)
      .bind(refreshHash, sourceHash, receipt));
  } else {
    const value = string(params.get('refresh_token'), 'refresh_token', 128);
    if (!/^wmr_[a-f0-9]{64}$/.test(value)) throw new OAuthError('invalid_grant');
    const sourceHash = await hash(value);
    const narrowed = params.has('scope') ? JSON.stringify(scopes(params.get('scope'))) : null;
    statements.push(env.DB.prepare(`UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ${NOW})
      WHERE client_id = ? AND resource = ? AND id IN
        (SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = ? AND consumed_at IS NOT NULL)`)
      .bind(c.client_id, resource, sourceHash));
    statements.push(env.DB.prepare(`UPDATE oauth_refresh_tokens SET consumed_at = ${NOW}, receipt = ?
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ${NOW}
        AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM json_each(?) requested
          WHERE NOT EXISTS (SELECT 1 FROM json_each(oauth_refresh_tokens.scopes) original WHERE original.value = requested.value)))
        AND EXISTS (SELECT 1 FROM oauth_grants g WHERE g.id = oauth_refresh_tokens.grant_id
          AND g.client_id = ? AND g.resource = ? AND ${LIVE_GRANT})`)
      .bind(receipt, sourceHash, narrowed, narrowed, c.client_id, resource));
    statements.push(env.DB.prepare(`UPDATE oauth_grants SET idle_expires_at = MIN(expires_at, ${NOW} + ${IDLE_MS})
      WHERE id IN (SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = ? AND receipt = ?)`)
      .bind(sourceHash, receipt));
    statements.push(env.DB.prepare(`INSERT INTO oauth_refresh_tokens (token_hash, grant_id, scopes, created_at, expires_at)
      SELECT ?, g.id, COALESCE(?, src.scopes), ${NOW}, MIN(g.expires_at, ${NOW} + ${IDLE_MS})
      FROM oauth_refresh_tokens src JOIN oauth_grants g ON g.id = src.grant_id WHERE src.token_hash = ? AND src.receipt = ?`)
      .bind(refreshHash, narrowed, sourceHash, receipt));
  }
  statements.push(env.DB.prepare(`INSERT INTO oauth_access_tokens (token_hash, grant_id, scopes, created_at, expires_at)
    SELECT ?, src.grant_id, src.scopes, ${NOW}, MIN(g.expires_at, g.idle_expires_at, ${NOW} + ${ACCESS_MS})
    FROM oauth_refresh_tokens src JOIN oauth_grants g ON g.id = src.grant_id WHERE src.token_hash = ?`)
    .bind(accessHash, refreshHash));
  statements.push(env.DB.prepare(`SELECT scopes, MAX(0, CAST((expires_at - ${NOW}) / 1000 AS INTEGER)) AS expires_in
    FROM oauth_access_tokens WHERE token_hash = ?`).bind(accessHash));
  const results = await env.DB.batch<{ scopes: string; expires_in: number }>(statements);
  const issued = results[results.length - 1].results[0];
  // Scope broadening does not consume a valid refresh token. Keep invalid opaque
  // credentials indistinguishable instead of revealing token existence.
  if (!issued) throw new OAuthError('invalid_grant');
  return json({ access_token: access, token_type: 'Bearer', expires_in: issued.expires_in,
    refresh_token: refresh, scope: (JSON.parse(issued.scopes) as string[]).join(' ') });
}

async function revoke(request: Request, env: OAuthEnv): Promise<Response> {
  await limit(env.DB, `revoke:ip:${ip(request)}`, 120, 60);
  const params = await form(request);
  const c = await client(env.DB, params.get('client_id'));
  const tokenHash = await hash(string(params.get('token'), 'token', 256));
  await env.DB.prepare(`UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ${NOW})
    WHERE client_id = ? AND (id IN (SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash = ?)
      OR id IN (SELECT grant_id FROM oauth_access_tokens WHERE token_hash = ?))`)
    .bind(c.client_id, tokenHash, tokenHash).run();
  // RFC 7009 deliberately returns the same success for an unknown token.
  return new Response(null, { status: 200, headers: BASE_HEADERS });
}

async function connections(request: Request, env: OAuthEnv, issuer: string): Promise<Response> {
  const origin = request.headers.get('origin');
  if ((origin !== null && origin !== issuer) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new OAuthError('access_denied', 403, 'same-origin request required');
  }
  const s = await session(request, env.DB);
  const path = new URL(request.url).pathname;
  if (request.method === 'GET' && path === '/account/connections') {
    const result = await env.DB.prepare(`SELECT g.id, g.client_id, c.client_name, g.space_id, t.name AS space_name,
      t.display_name AS space_display_name,
      (SELECT json_group_array(json_object('id',st.id,'name',st.name,'display_name',st.display_name,'memory_type',st.memory_type))
        FROM oauth_grant_spaces gs JOIN tenants st ON st.id=gs.space_id AND st.owner_account_id=g.account_id
        WHERE gs.grant_id=g.id) AS spaces, g.scopes, g.created_at, g.expires_at, g.idle_expires_at, g.revoked_at
      FROM oauth_grants g JOIN oauth_clients c ON c.client_id = g.client_id
      JOIN tenants t ON t.id = g.space_id AND t.owner_account_id = g.account_id
      WHERE g.account_id = ? AND ${SESSION}
      ORDER BY (g.revoked_at IS NULL AND g.expires_at > ${NOW} AND g.idle_expires_at > ${NOW}) DESC,
        g.created_at DESC LIMIT 200`).bind(s.id, s.hash, s.id)
      .all<{ scopes: string } & Record<string, unknown>>();
    return json({ connections: result.results.map(row => ({ ...row, scopes: JSON.parse(row.scopes), spaces: JSON.parse(String(row.spaces ?? '[]')) })) });
  }
  const match = path.match(/^\/account\/connections\/([^/]+)$/);
  if (match && request.method === 'DELETE') {
    sameOrigin(request, issuer);
    let id: string;
    try { id = string(decodeURIComponent(match[1]), 'connection id', 128); }
    catch { throw new OAuthError('invalid_request'); }
    const result = await env.DB.prepare(`UPDATE oauth_grants SET revoked_at = COALESCE(revoked_at, ${NOW})
      WHERE id = ? AND account_id = ? AND ${SESSION}`).bind(id, s.id, s.hash, s.id).run();
    if (result.meta.changes === 0) throw new OAuthError('invalid_request', 404, 'connection not found');
    return json({ ok: true, id });
  }
  throw new OAuthError('invalid_request', 405, 'method not allowed');
}

export function oauthAllowedOrigins(env: OAuthEnv): string[] {
  if (!env.OAUTH_ALLOWED_ORIGINS) return [];
  let values: unknown;
  try { values = JSON.parse(env.OAUTH_ALLOWED_ORIGINS); } catch { throw new OAuthError('temporarily_unavailable', 503, 'invalid OAuth origin configuration'); }
  if (!Array.isArray(values) || values.length > 20 || values.some(value => {
    if (typeof value !== 'string') return true;
    try { const u = new URL(value); return u.origin !== value || (u.protocol !== 'https:' && !(u.protocol === 'http:' && localhost(u))); }
    catch { return true; }
  })) throw new OAuthError('temporarily_unavailable', 503, 'invalid OAuth origin configuration');
  return values as string[];
}
function protocolOrigin(request: Request, env: OAuthEnv, issuer: string): Record<string, string> {
  const allowed = oauthAllowedOrigins(env);
  const origin = request.headers.get('origin');
  if (origin === null || origin === issuer) return {};
  if (!allowed.includes(origin)) throw new OAuthError('access_denied', 403, 'origin is not allowed');
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600' };
}

/** Route OAuth before the account router. API keys never become OAuth tokens. */
export async function handleOAuthRequest(request: Request, env: OAuthEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const relevant = path.startsWith('/oauth/') || path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp' ||
    path === '/account/connections' || path.startsWith('/account/connections/');
  if (!relevant) return null;
  let cors: Record<string, string> = {};
  try {
    const issuer = oauthIssuer(env), resource = oauthResource(env);
    if (new URL(request.url).origin !== issuer) throw new OAuthError('invalid_request', 421, 'canonical OAuth issuer required');
    const protocol = ['/oauth/register', '/oauth/token', '/oauth/revoke'].includes(path) || path.startsWith('/.well-known/');
    if (protocol) cors = protocolOrigin(request, env, issuer);
    if (request.method === 'OPTIONS' && protocol) return new Response(null, { status: 204, headers: { ...BASE_HEADERS, ...cors } });
    let response: Response;
    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      response = json({ issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token',
        registration_endpoint: issuer + '/oauth/register', revocation_endpoint: issuer + '/oauth/revoke',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'], scopes_supported: AUTHORIZATION_SCOPES,
        authorization_response_iss_parameter_supported: true, resource_indicators_supported: true });
    } else if (request.method === 'GET' && (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp')) {
      response = json({ resource, resource_name: 'Walle Memory', authorization_servers: [issuer], scopes_supported: OAUTH_SCOPES,
        bearer_methods_supported: ['header'] });
    } else if (request.method === 'POST' && path === '/oauth/register') response = await register(request, env, issuer);
    else if (request.method === 'POST' && path === '/oauth/token') response = await token(request, env);
    else if (request.method === 'POST' && path === '/oauth/revoke') response = await revoke(request, env);
    else if (request.method === 'GET' && path === '/oauth/authorize/context') response = await authorizationContext(request, env, issuer);
    else if (request.method === 'POST' && path === '/oauth/authorize') response = await authorize(request, env, issuer);
    else if (request.method === 'GET' && path === '/oauth/authorize') {
      try { await authorization(new URL(request.url).searchParams, env); }
      catch (error) {
        // Exact registered callback validation precedes every OAuth error redirect.
        if (!(error instanceof OAuthError)) throw error;
        const params = new URL(request.url).searchParams;
        try {
          unique(params);
          const c = await client(env.DB, params.get('client_id'));
          const uri = string(params.get('redirect_uri'), 'redirect_uri');
          if (!(JSON.parse(c.redirect_uris) as string[]).includes(uri)) throw error;
          const state = params.has('state') ? string(params.get('state'), 'state', 2048) : null;
          return new Response(null, { status: 302, headers: { ...BASE_HEADERS,
            Location: redirect(uri, issuer, state, { error: error.error, error_description: error.description }) } });
        } catch { throw error; }
      }
      response = new Response(getOAuthAuthorizeHtml(), { headers: { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
    } else if (path === '/account/connections' || path.startsWith('/account/connections/')) response = await connections(request, env, issuer);
    else throw new OAuthError('invalid_request', 404, 'not found');
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    return json({ error: error.error, error_description: error.description }, error.status,
      { ...cors, ...(error.retryAfter === undefined ? {} : { 'Retry-After': String(error.retryAfter) }) });
  }
}
