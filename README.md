# walle-memory

A small centralized key/value memory service for AI agents.

Agents across different machines and sessions share one memory store over a
simple HTTP API. It stores, retrieves, and searches memory entries — nothing
else. Deciding *what* to remember, writing descriptions, and summarizing the
index are the caller's job; this service deliberately stays out of it.

## Design

Two layers keep the injected context small as the store grows:

1. **Index** — every entry carries a one-line `description` written by the
   caller. Listing entries (`GET /memory`) returns only keys and descriptions,
   so a few hundred entries still fit comfortably in a prompt.
2. **Values** — full content is fetched per key on demand (`GET /memory/:key`).

The caller (an external agent) reads the index once per task, decides which
keys matter, and fetches those. Generating a natural-language summary of the
index is intentionally *not* part of this service — no LLM is called here, and
no model API key is required.

## API

All endpoints take an optional `X-Api-Key` header (required only if `API_KEY`
is set).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness check. Always unauthenticated. |
| `GET` | `/memory` | List keys. Optional `?prefix=user/` filter. |
| `GET` | `/memory/:key` | Read one entry. |
| `POST` | `/memory/:key` | Write or update. Body: `{ value, description }`. |
| `DELETE` | `/memory/:key` | Remove an entry. |
| `GET` | `/memory/search?q=` | Full-text search over keys and descriptions. |

See [`.claude/skills/walle-memory.md`](.claude/skills/walle-memory.md) for the
full reference, key-naming conventions, and usage patterns. That file is also
usable as an agent skill directly.

### Key naming

`namespace/topic/subtopic`, for example `user/prefs/theme`,
`project/alpha/goal`, `context/work/last-standup`.

### The `description` field

`description` is what makes the index useful — it says what *kind* of
information a key holds, not what the value is.

- Good: `"用户主题偏好，影响 UI 渲染"`
- Bad: `"dark"` (that is the value)

## Run

```bash
mkdir -p /data/walle-memory
WALLE_MEMORY_API_KEY=your-key docker compose up -d
```

The SQLite database is created automatically on first start. Data lives in
`/app/data/memory.db` inside the container, mounted from the host via the
volume in `docker-compose.yml` — so it survives container rebuilds, and a
backup is just a copy of that file.

### Build and push the image

```bash
docker compose build
docker push iregistry.baidu-int.com/acg-agi/walle-memory:latest
```

The image is built for `linux/amd64` explicitly, since development happens on
Apple Silicon.

On the target host, skip the build and pull the published image:

```bash
WALLE_MEMORY_API_KEY=your-key docker compose pull
WALLE_MEMORY_API_KEY=your-key docker compose up -d --no-build
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
| `API_KEY` | *(unset)* | If set, all endpoints except `/health` require `X-Api-Key`. |

## Storage

Single SQLite file, WAL mode. One table holds entries plus an `access_count`
and `last_accessed_at` per key, so callers can rank by recency or frequency.
An FTS5 virtual table (kept in sync by triggers) backs `/memory/search`.

No migrations framework — the schema is created with `IF NOT EXISTS` on
startup.
