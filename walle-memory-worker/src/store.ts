export interface Tenant {
  id: string;
  name: string;
  created_at: number;
}

export interface MemoryEntry {
  key: string;
  tenant_id: string;
  value: string;
  description: string;
  access_count: number;
  last_accessed_at: number | null;
  updated_at: number;
  expires_at: number | null;
}

export interface KeySummary {
  key: string;
  description: string;
  updated_at: number;
  expires_at: number | null;
}

export interface MemoryCredential {
  keyHash: string;
  requiredScope: 'read' | 'write' | 'delete' | 'gc';
}

/** The credential changed after the router's initial authorization. */
export class CredentialExpiredError extends Error {
  constructor() { super('unauthorized'); }
}

const LIVE = '(expires_at IS NULL OR expires_at > ?)';
const SUMMARY = 'key, description, updated_at, expires_at';

export async function hashKey(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

/** Per-request store: no process globals, filesystem, native addons, or startup DDL. */
export class MemoryStore {
  constructor(private readonly db: D1Database, private readonly credential?: MemoryCredential) {}

  private memoryGuard(tenantId: string, now: number): { sql: string; values: unknown[] } {
    if (!this.credential) return { sql: '1', values: [] };
    const { keyHash, requiredScope } = this.credential;
    return {
      sql: `EXISTS (SELECT 1 FROM tenants authorization_t
        LEFT JOIN accounts authorization_a ON authorization_a.id = authorization_t.owner_account_id
        WHERE authorization_t.id = ? AND (
          EXISTS (SELECT 1 FROM api_keys authorization_k
            WHERE authorization_k.space_id = authorization_t.id
              AND authorization_k.account_id = authorization_t.owner_account_id
              AND authorization_a.id IS NOT NULL AND authorization_a.disabled_at IS NULL
              AND authorization_k.key_hash = ? AND authorization_k.revoked_at IS NULL
              AND (authorization_k.expires_at IS NULL OR authorization_k.expires_at > ?)
              AND EXISTS (SELECT 1 FROM json_each(authorization_k.scopes) authorization_scope
                WHERE authorization_scope.type = 'text' AND authorization_scope.value = ?))
          OR (authorization_t.api_key_hash = ? AND authorization_t.legacy_key_revoked_at IS NULL
            AND (authorization_t.owner_account_id IS NULL
              OR (authorization_a.id IS NOT NULL AND authorization_a.disabled_at IS NULL))
            AND NOT EXISTS (SELECT 1 FROM api_keys authorization_k WHERE authorization_k.key_hash = ?))
        ))`,
      values: [tenantId, keyHash, now, requiredScope, keyHash, keyHash],
    };
  }

  private async memoryBatch<T>(tenantId: string, now: number, statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (!this.credential) return this.db.batch<T>(statements);
    const guard = this.memoryGuard(tenantId, now);
    // The grant and guarded operations share one transaction. A failed grant
    // cannot read or mutate data: every memory statement also includes the guard.
    const [grant, ...results] = await this.db.batch<T>([
      this.db.prepare(`SELECT 1 AS allowed WHERE ${guard.sql}`).bind(...guard.values),
      ...statements,
    ]);
    if (grant.results.length === 0) throw new CredentialExpiredError();
    return results;
  }

  async createTenant(name: string): Promise<{ tenant: Tenant; apiKey: string }> {
    const tenant = { id: randomHex(8), name, created_at: Date.now() };
    const apiKey = randomHex(24);
    await this.db.prepare('INSERT INTO tenants (id, name, api_key_hash, created_at, display_name) VALUES (?, ?, ?, ?, ?)')
      .bind(tenant.id, name, await hashKey(apiKey), tenant.created_at, name).run();
    return { tenant, apiKey };
  }

  resolveTenant(raw: string): Promise<Tenant | null> {
    return hashKey(raw).then(hash => this.db.prepare('SELECT id, name, created_at FROM tenants WHERE api_key_hash = ?')
      .bind(hash).first<Tenant>());
  }

  async listTenants(): Promise<Tenant[]> {
    return (await this.db.prepare('SELECT id, name, created_at FROM tenants ORDER BY created_at ASC').all<Tenant>()).results;
  }

  async deleteTenant(id: string): Promise<boolean> {
    // ON DELETE CASCADE deletes memory and fires its FTS cleanup trigger atomically.
    return (await this.db.prepare('DELETE FROM tenants WHERE id = ?').bind(id).run()).meta.changes > 0;
  }

  async getEntry(tenantId: string, key: string): Promise<MemoryEntry | null> {
    const now = Date.now();
    const guard = this.memoryGuard(tenantId, now);
    // A D1 batch is a transaction. Preserve the original API's pre-increment metadata.
    const [read] = await this.memoryBatch<MemoryEntry>(tenantId, now, [
      this.db.prepare(`SELECT * FROM memory WHERE tenant_id = ? AND key = ? AND ${LIVE} AND ${guard.sql}`)
        .bind(tenantId, key, now, ...guard.values),
      this.db.prepare(`UPDATE memory SET access_count = access_count + 1, last_accessed_at = ?
        WHERE tenant_id = ? AND key = ? AND ${LIVE} AND ${guard.sql}`)
        .bind(now, tenantId, key, now, ...guard.values),
    ]);
    return read.results[0] ?? null;
  }

  async upsert(tenantId: string, key: string, value: string, description: string, ttlSeconds?: number): Promise<void> {
    const now = Date.now();
    const guard = this.memoryGuard(tenantId, now);
    await this.memoryBatch(tenantId, now, [this.db.prepare(`INSERT INTO memory (tenant_id, key, value, description, updated_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}
      ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value,
      description = excluded.description, updated_at = excluded.updated_at, expires_at = excluded.expires_at`)
      .bind(tenantId, key, value, description, now, ttlSeconds === undefined ? null : now + ttlSeconds * 1000, ...guard.values)]);
  }

  async deleteEntry(tenantId: string, key: string): Promise<boolean> {
    const now = Date.now();
    const guard = this.memoryGuard(tenantId, now);
    const [deleted] = await this.memoryBatch(tenantId, now, [
      this.db.prepare(`DELETE FROM memory WHERE tenant_id = ? AND key = ? AND ${guard.sql}`)
        .bind(tenantId, key, ...guard.values),
    ]);
    return deleted.meta.changes > 0;
  }

  async listKeys(tenantId: string, prefix?: string): Promise<KeySummary[]> {
    const now = Date.now();
    const guard = this.memoryGuard(tenantId, now);
    // Literal, case-sensitive prefix: avoids LIKE wildcard expansion and D1's 50-byte pattern limit.
    const statement = prefix
      ? this.db.prepare(`SELECT ${SUMMARY} FROM memory WHERE tenant_id = ? AND ${LIVE} AND ${guard.sql}
          AND substr(key, 1, length(?)) = ? ORDER BY access_count DESC, updated_at DESC`).bind(tenantId, now, ...guard.values, prefix, prefix)
      : this.db.prepare(`SELECT ${SUMMARY} FROM memory WHERE tenant_id = ? AND ${LIVE} AND ${guard.sql}
          ORDER BY access_count DESC, updated_at DESC`).bind(tenantId, now, ...guard.values);
    const [read] = await this.memoryBatch<KeySummary>(tenantId, now, [statement]);
    return read.results;
  }

  async searchKeys(tenantId: string, query: string): Promise<{ key: string; description: string }[]> {
    const now = Date.now();
    const guard = this.memoryGuard(tenantId, now);
    const [read] = await this.memoryBatch<{ key: string; description: string }>(tenantId, now, [this.db.prepare(`SELECT m.key, m.description FROM memory_fts f
      JOIN memory m ON m.rowid = f.rowid WHERE m.tenant_id = ?
      AND (m.expires_at IS NULL OR m.expires_at > ?) AND ${guard.sql} AND memory_fts MATCH ? LIMIT 20`)
      .bind(tenantId, now, ...guard.values, query)]);
    return read.results;
  }

  async getAllDescriptions(tenantId: string): Promise<KeySummary[]> {
    const now = Date.now();
    const guard = this.memoryGuard(tenantId, now);
    const [read] = await this.memoryBatch<KeySummary>(tenantId, now, [
      this.db.prepare(`SELECT ${SUMMARY} FROM memory WHERE tenant_id = ? AND ${LIVE} AND ${guard.sql} ORDER BY key`)
        .bind(tenantId, now, ...guard.values),
    ]);
    return read.results;
  }

  async deleteExpired(tenantId: string): Promise<number> {
    const now = Date.now();
    const guard = this.memoryGuard(tenantId, now);
    // D1 meta.changes includes FTS trigger writes; SQL changes() counts base rows.
    const [, count] = await this.memoryBatch<{ deleted: number }>(tenantId, now, [
      this.db.prepare(`DELETE FROM memory WHERE tenant_id = ? AND expires_at IS NOT NULL AND expires_at <= ? AND ${guard.sql}`)
        .bind(tenantId, now, ...guard.values),
      this.db.prepare('SELECT changes() AS deleted'),
    ]);
    return count.results[0].deleted;
  }
}
