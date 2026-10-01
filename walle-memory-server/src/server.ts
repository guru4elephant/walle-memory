import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import {
  getEntry,
  upsert,
  deleteEntry,
  listKeys,
  searchKeys,
  getAllDescriptions,
  deleteExpired,
  createTenant,
  resolveTenant,
  listTenants,
  deleteTenant,
  Tenant,
} from './store.js';
import { getDashboardHtml } from './dashboard.js';

const ADMIN_KEY = process.env.API_KEY;

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/** Returns the resolved tenant, or undefined if unauthorised (and sends 401). */
function authTenant(req: IncomingMessage, res: ServerResponse): Tenant | undefined {
  const rawKey = req.headers['x-api-key'];
  if (typeof rawKey !== 'string' || !rawKey) {
    send(res, 401, { error: 'unauthorized' });
    return undefined;
  }
  const tenant = resolveTenant(rawKey);
  if (!tenant) {
    send(res, 401, { error: 'unauthorized' });
    return undefined;
  }
  return tenant;
}

/** Returns true when the request carries the admin key. */
function authAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (!ADMIN_KEY) return true;
  if (req.headers['x-api-key'] === ADMIN_KEY) return true;
  send(res, 401, { error: 'unauthorized' });
  return false;
}

export function createMemoryServer(): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // GET /  — dashboard (unauthenticated; JS side handles the API key)
    if (method === 'GET' && pathname === '/') {
      const html = getDashboardHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      return res.end(html);
    }

    // GET /health  — unauthenticated, used by docker healthcheck
    if (method === 'GET' && pathname === '/health') {
      return send(res, 200, { ok: true });
    }

    // ── Admin routes (require ADMIN_KEY) ───────────────────────────────────

    if (pathname.startsWith('/admin/')) {
      if (!authAdmin(req, res)) return;

      // POST /admin/tenants  — create a new tenant, returns the one-time API key
      if (method === 'POST' && pathname === '/admin/tenants') {
        let body: unknown;
        try { body = JSON.parse(await readBody(req)); } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
        const { name } = body as Record<string, unknown>;
        if (typeof name !== 'string' || !name.trim()) {
          return send(res, 400, { error: 'body must have string field: name' });
        }
        try {
          const { tenant, apiKey } = createTenant(name.trim());
          return send(res, 201, { tenant, api_key: apiKey });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('UNIQUE')) return send(res, 409, { error: 'tenant name already exists' });
          throw e;
        }
      }

      // GET /admin/tenants  — list all tenants (no api keys, they're hashed)
      if (method === 'GET' && pathname === '/admin/tenants') {
        return send(res, 200, { tenants: listTenants() });
      }

      // DELETE /admin/tenants/:id
      const tenantMatch = pathname.match(/^\/admin\/tenants\/(.+)$/);
      if (tenantMatch && method === 'DELETE') {
        const id = decodeURIComponent(tenantMatch[1]);
        const deleted = deleteTenant(id);
        if (!deleted) return send(res, 404, { error: 'tenant not found' });
        return send(res, 200, { ok: true, id });
      }

      return send(res, 404, { error: 'not found' });
    }

    // ── Tenant-scoped memory routes (require valid tenant API key) ─────────

    const tenant = authTenant(req, res);
    if (!tenant) return;
    const tenantId = tenant.id;

    // POST /memory/gc  — delete all expired entries (global, admin-like but any tenant can call)
    if (method === 'POST' && pathname === '/memory/gc') {
      const count = deleteExpired();
      return send(res, 200, { ok: true, deleted: count });
    }

    // GET /summary  — all key+description pairs for this tenant (for agent system prompts)
    if (method === 'GET' && pathname === '/summary') {
      return send(res, 200, { tenant: tenant.name, entries: getAllDescriptions(tenantId) });
    }

    // GET /memory  — list keys (optional ?prefix=)
    if (method === 'GET' && pathname === '/memory') {
      const prefix = url.searchParams.get('prefix') ?? undefined;
      return send(res, 200, { keys: listKeys(tenantId, prefix) });
    }

    // GET /memory/search?q=  — FTS search
    if (method === 'GET' && pathname === '/memory/search') {
      const q = url.searchParams.get('q');
      if (!q) return send(res, 400, { error: 'missing q param' });
      return send(res, 200, { results: searchKeys(tenantId, q) });
    }

    // /memory/:key  routes
    const keyMatch = pathname.match(/^\/memory\/(.+)$/);
    if (keyMatch) {
      const key = decodeURIComponent(keyMatch[1]);

      if (method === 'GET') {
        const entry = getEntry(tenantId, key);
        if (!entry) return send(res, 404, { error: 'not found' });
        return send(res, 200, entry);
      }

      if (method === 'POST' || method === 'PUT') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
        const { value, description, ttl_seconds } = body as Record<string, unknown>;
        if (typeof value !== 'string' || typeof description !== 'string') {
          return send(res, 400, { error: 'body must have string fields: value, description' });
        }
        const ttl = typeof ttl_seconds === 'number' && ttl_seconds > 0 ? ttl_seconds : undefined;
        upsert(tenantId, key, value, description, ttl);
        return send(res, 200, { ok: true, key });
      }

      if (method === 'DELETE') {
        const deleted = deleteEntry(tenantId, key);
        if (!deleted) return send(res, 404, { error: 'not found' });
        return send(res, 200, { ok: true, key });
      }
    }

    send(res, 404, { error: 'not found' });
  });
}
