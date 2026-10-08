import { getDashboardHtml } from '../../walle-memory-server/src/dashboard';
import { MemoryStore, CredentialExpiredError, hashKey } from './store';
import { handleAccountRequest, resolveMemoryAuth, consumeRateLimit } from './accounts';
import { getAccountDashboardHtml } from './account-dashboard';

export interface Env {
  DB: D1Database;
  API_KEY?: string;
  REGISTRATION_MODE?: string;
}

const MAX_BODY_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers });
}

function checkedString(value: unknown, field: string, maxBytes: number, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && !value.trim()) || value.includes('\0')) {
    throw new HttpError(400, `invalid ${field}`);
  }
  if (encoder.encode(value).byteLength > maxBytes) throw new HttpError(400, `${field} is too long`);
  return value;
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
  if (!request.body) throw new HttpError(400, 'invalid JSON');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'request body too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(data)); }
  catch { throw new HttpError(400, 'invalid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function decodedPart(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw new HttpError(400, 'invalid URL encoding'); }
}

async function adminAuthorized(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([hashKey(provided), hashKey(expected)]);
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (method === 'GET' && path === '/health') return json({ ok: true });
  if (method === 'GET' && (path === '/' || path === '/account')) {
    const html = path === '/account' ? getAccountDashboardHtml() : getDashboardHtml()
      .replace('<h1>walle-memory</h1>', '<h1>walle-memory</h1><a href="/account">Accounts &amp; Spaces</a>');
    return new Response(html, { headers: {
      ...headers,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    } });
  }

  const rawKey = request.headers.get('x-api-key') ?? '';
  if (rawKey.length > 512) throw new HttpError(401, 'unauthorized');
  const accountResponse = await handleAccountRequest(request, env);
  if (accountResponse) return accountResponse;
  if (path.startsWith('/admin/')) {
    const store = new MemoryStore(env.DB);
    // Never expose tenant creation/list/deletion when the secret is missing.
    if (!env.API_KEY?.trim()) throw new HttpError(503, 'admin API is not configured');
    if (!rawKey || !await adminAuthorized(rawKey, env.API_KEY)) throw new HttpError(401, 'unauthorized');
    if (path === '/admin/tenants' && method === 'GET') return json({ tenants: await store.listTenants() });
    if (path === '/admin/tenants' && method === 'POST') {
      const body = await bodyObject(request);
      const name = checkedString(body.name, 'name', 512, true).trim();
      try {
        const { tenant, apiKey } = await store.createTenant(name);
        return json({ tenant, api_key: apiKey }, 201);
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed: tenants.name/i.test(error.message)) {
          throw new HttpError(409, 'tenant name already exists');
        }
        throw error;
      }
    }
    const match = path.match(/^\/admin\/tenants\/(.+)$/);
    if (match && method === 'DELETE') {
      const id = checkedString(decodedPart(match[1]), 'tenant id', 128, true);
      if (!await store.deleteTenant(id)) throw new HttpError(404, 'tenant not found');
      return json({ ok: true, id });
    }
    throw new HttpError(404, 'not found');
  }

  if (!rawKey) throw new HttpError(401, 'unauthorized');
  const auth = await resolveMemoryAuth(env.DB, rawKey);
  if (!auth) throw new HttpError(401, 'unauthorized');
  const tenant = auth.tenant;
  const requiredScope = path === '/memory/gc' && method === 'POST' ? 'gc'
    : ((path === '/summary' || path === '/memory' || path.startsWith('/memory/')) && method === 'GET') ? 'read'
    : path.startsWith('/memory/') && (method === 'POST' || method === 'PUT') ? 'write'
    : path.startsWith('/memory/') && method === 'DELETE' ? 'delete' : null;
  if (requiredScope && !auth.scopes.includes(requiredScope)) throw new HttpError(403, 'API key lacks required permission');
  const keyHash = await hashKey(rawKey);
  const store = new MemoryStore(env.DB, requiredScope ? { keyHash, requiredScope } : undefined);
  if (requiredScope) {
    const retry = await consumeRateLimit(env.DB, 'memory:' + keyHash, 300, 60);
    if (retry !== null) return Response.json({ error: 'too many requests' }, {
      status: 429, headers: { ...headers, 'Retry-After': String(retry) },
    });
  }
  if (path === '/summary' && method === 'GET') return json({ tenant: tenant.name, entries: await store.getAllDescriptions(tenant.id) });
  if (path === '/memory' && method === 'GET') {
    const prefix = url.searchParams.get('prefix');
    return json({ keys: await store.listKeys(tenant.id, prefix === null ? undefined : checkedString(prefix, 'prefix', 1024)) });
  }
  if (path === '/memory/gc' && method === 'POST') return json({ ok: true, deleted: await store.deleteExpired(tenant.id) });
  if (path === '/memory/search' && method === 'GET') {
    const query = checkedString(url.searchParams.get('q'), 'q param', 2048, true);
    try { return json({ results: await store.searchKeys(tenant.id, query) }); }
    catch (error) {
      if (error instanceof Error && /fts5:|unterminated string|malformed MATCH|no such column:|syntax error/i.test(error.message)) {
        throw new HttpError(400, 'invalid full-text search query');
      }
      throw error;
    }
  }
  const match = path.match(/^\/memory\/(.+)$/);
  if (match) {
    const key = checkedString(decodedPart(match[1]), 'key', 1024, true);
    if (method === 'GET') {
      const entry = await store.getEntry(tenant.id, key);
      if (!entry) throw new HttpError(404, 'not found');
      return json(entry);
    }
    if (method === 'POST' || method === 'PUT') {
      const body = await bodyObject(request);
      const value = checkedString(body.value, 'value', 256 * 1024);
      const description = checkedString(body.description, 'description', 8 * 1024);
      const ttl = body.ttl_seconds;
      if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0 || !Number.isSafeInteger(Math.ceil(Date.now() + ttl * 1000)))) {
        throw new HttpError(400, 'ttl_seconds must be a finite positive number');
      }
      await store.upsert(tenant.id, key, value, description, ttl as number | undefined);
      return json({ ok: true, key });
    }
    if (method === 'DELETE') {
      if (!await store.deleteEntry(tenant.id, key)) throw new HttpError(404, 'not found');
      return json({ ok: true, key });
    }
  }
  throw new HttpError(404, 'not found');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof CredentialExpiredError) return json({ error: 'unauthorized' }, 401);
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      // Never log request bodies, API keys, or D1 error text (which can include bound data).
      console.error('walle-memory: request failed');
      return json({ error: 'internal server error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
