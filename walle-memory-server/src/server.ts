import { createServer, IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import {
  getEntry,
  upsert,
  deleteEntry,
  listKeys,
  searchKeys,
} from './store.js';
import { getDashboardHtml } from './dashboard.js';

const API_KEY = process.env.API_KEY;

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

function auth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!API_KEY) return true;
  const header = req.headers['x-api-key'];
  if (header === API_KEY) return true;
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

    if (!auth(req, res)) return;

    // GET /memory  — list keys (optional ?prefix=)
    if (method === 'GET' && pathname === '/memory') {
      const prefix = url.searchParams.get('prefix') ?? undefined;
      return send(res, 200, { keys: listKeys(prefix) });
    }

    // GET /memory/search?q=  — FTS search
    if (method === 'GET' && pathname === '/memory/search') {
      const q = url.searchParams.get('q');
      if (!q) return send(res, 400, { error: 'missing q param' });
      return send(res, 200, { results: searchKeys(q) });
    }

    // /memory/:key  routes
    const keyMatch = pathname.match(/^\/memory\/(.+)$/);
    if (keyMatch) {
      const key = decodeURIComponent(keyMatch[1]);

      if (method === 'GET') {
        const entry = getEntry(key);
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
        const { value, description } = body as Record<string, unknown>;
        if (typeof value !== 'string' || typeof description !== 'string') {
          return send(res, 400, { error: 'body must have string fields: value, description' });
        }
        upsert(key, value, description);
        return send(res, 200, { ok: true, key });
      }

      if (method === 'DELETE') {
        const deleted = deleteEntry(key);
        if (!deleted) return send(res, 404, { error: 'not found' });
        return send(res, 200, { ok: true, key });
      }
    }

    send(res, 404, { error: 'not found' });
  });
}
