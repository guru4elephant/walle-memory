# walle-memory

A self-hosted, multi-tenant memory service for AI agents.

Deploy once. Any agent, CLI, or desktop client that can make an HTTP request can
read and write the same memory store — across machines, sessions, and tools.
Tenants are isolated by API key, so personal memory stays separate from team
memory, and different projects can share the same instance without stepping on
each other.

```
┌─────────────────────────────────────────────────────────┐
│                    walle-memory (cloud)                 │
│                                                         │
│  tenant: alice          tenant: team-alpha              │
│  ┌──────────────┐       ┌──────────────────────────┐   │
│  │ user/prefs/… │       │ project/roadmap/…        │   │
│  │ context/…    │       │ context/last-standup/…   │   │
│  └──────────────┘       └──────────────────────────┘   │
└────────────────────┬────────────────────────────────────┘
                     │  REST API  (X-Api-Key per tenant)
        ┌────────────┼────────────────┐
        │            │                │
   Claude Code    agent loop     desktop app
   (any machine)  (any runtime)  (any OS)
```

## What it is

walle-memory stores named key/value pairs with one-line descriptions. The
descriptions are the point: every call to `GET /memory` returns only keys and
descriptions, so an agent can inject the full index into a system prompt and
decide which values to fetch — without reading everything up front.

The service does not call any LLM. There is no model API key, no
embeddings, and no summarization. All of that is the caller's job. This service
stays deliberately thin so it works equally well with Claude Code, a custom
Python agent, a mobile app, or a cron job.

## Why multi-tenant

A single deployment can serve many isolated tenants at once:

- **Personal vs. team** — your own memory (preferences, context, notes) lives in
  your tenant; a shared project's memory lives in a separate tenant with its own
  key that teammates can hold.
- **Agent vs. human** — give an automated agent its own tenant so its writes
  can't pollute your personal store.
- **Staging vs. production** — run one server, use separate tenant keys per
  environment.

Tenants are created via an admin API. The raw API key is returned exactly once;
after that only its SHA-256 hash is stored.

## API overview

### Admin routes (require `API_KEY` env var as `X-Api-Key`)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/admin/tenants` | Create tenant. Body: `{ name }`. Returns one-time `api_key`. |
| `GET` | `/admin/tenants` | List all tenants (no keys, only metadata). |
| `DELETE` | `/admin/tenants/:id` | Delete tenant and all its data. |

### Per-tenant routes (require tenant `X-Api-Key`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/summary` | All key+description pairs — designed for system prompt injection. |
| `GET` | `/memory` | List keys. Optional `?prefix=user/` filter. |
| `GET` | `/memory/search?q=` | Full-text search over keys and descriptions. |
| `GET` | `/memory/:key` | Read one entry (bumps access count). |
| `POST` | `/memory/:key` | Write or update. Body: `{ value, description, ttl_seconds? }`. |
| `DELETE` | `/memory/:key` | Remove an entry. |
| `POST` | `/memory/gc` | Delete all expired entries for this tenant. |
| `GET` | `/` | Web dashboard (API key handled client-side). |
| `GET` | `/health` | Liveness check. Always unauthenticated. |

### TTL (short-term memory)

Pass `ttl_seconds` on any write. The entry expires silently after that many
seconds. Useful for session context, temporary flags, or anything you want to
forget automatically.

```
3600    → 1 hour
86400   → 1 day
604800  → 1 week
        → omit for permanent
```

## Key naming convention

`namespace/topic/subtopic`, for example:

```
user/prefs/theme
user/prefs/language
project/alpha/goal
project/alpha/last-standup
context/work/current-task
```

## The `description` field

This is what makes the index useful. It tells an agent *what kind of
information* a key holds, so it can decide whether to fetch the full value
without reading everything.

- Good: `"用户 UI 主题偏好，影响所有渲染"`
- Bad: `"dark"` — that is the value, not a description of it

## Run

```bash
# First run — create the data directory and start
mkdir -p /data/walle-memory
API_KEY=your-admin-key docker compose up -d

# Create your first tenant
curl -X POST https://your-host/admin/tenants \
  -H "X-Api-Key: your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"name": "alice"}'
# → { "tenant": {...}, "api_key": "...48-char hex, save this..." }
```

The SQLite database lives in `/app/data/memory.db` inside the container,
mounted from the host — so it survives restarts and a backup is just a file
copy.

### Build and push

```bash
# From repo root (Dockerfile path is relative to root)
docker build --platform linux/amd64 \
  -f walle-memory-server/Dockerfile \
  -t your-registry/walle-memory:latest .
docker push your-registry/walle-memory:latest
```

### Pull and run on a remote host

```bash
API_KEY=your-admin-key docker compose pull
API_KEY=your-admin-key docker compose up -d --no-build
```

### Local development

```bash
cd walle-memory-server
npm install
npm run build
DB_PATH=./data/memory.db PORT=3800 npm start
```

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3800` | HTTP listen port. |
| `DB_PATH` | `walle-memory-server/data/memory.db` | SQLite file location. |
| `API_KEY` | *(unset)* | Admin key. If unset, `/admin/` routes are open. |

## Storage

Single SQLite file, WAL mode. Each memory entry tracks `access_count` and
`last_accessed_at` so agents can rank by recency or frequency. An FTS5 virtual
table (kept in sync by triggers) powers `/memory/search`. No migrations
framework — schema is created with `IF NOT EXISTS` on startup; columns added
in later versions are applied with `ALTER TABLE` at boot.
