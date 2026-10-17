# walle-memory

A self-hosted memory service for AI agents, with two deployment targets:

| Target | Runtime and storage | Identity and management |
| --- | --- | --- |
| [Docker / Node](walle-memory-server/) | Node 22, SQLite, `better-sqlite3` | Administrator-created tenants and tenant API keys. |
| [Cloudflare Workers](walle-memory-worker/README.md) | Workers, D1, Web Crypto | Accounts, owned spaces, scoped keys, invitation registration, and MCP with renewable OAuth connections. |

Both targets provide the memory API and dashboard at `/`. The Worker additionally provides `/account` for login, space management, and key issuance. Its default registration mode allows administrators to create accounts; setting `REGISTRATION_MODE=invite` allows registration with a valid invitation. Accounts and D1 migrations are specific to the Worker target.

Each key selects one tenant or space. Clients can share a store across machines and sessions, while separate keys keep personal, team, and project stores apart. The administrator key manages resources through `/admin/`; it is not a memory key. See [accounts and spaces](docs/ACCOUNTS_AND_SPACES.md), [invitation registration](docs/INVITATION_SIGNUP.md), and [release provenance](docs/RELEASE_PROVENANCE.md).

The Worker also offers `/mcp` with either OAuth authorization code + S256 PKCE or a space API key in `X-Api-Key`. OAuth connections retain selected workspaces, rotating refresh tokens and revocation in `/account`; API keys retain their single-space binding, scopes, expiry and revocation. Supplying both authentication headers is rejected. OAuth does not proxy a hidden API key. See [bot configuration and authentication rules](docs/MCP_API_KEY.md) and [MCP / OAuth setup](docs/OAUTH_MCP.md). The Node target and existing API-key REST clients keep their current authentication model.

## Memory model

Entries have a named key, a string value, and a short description. List and summary responses contain keys and descriptions so an agent can choose which values to fetch. `/summary` returns this index; the service does not call an LLM, generate summaries, create embeddings, or require a model API key.

Use keys such as `user/prefs/theme`, `project/alpha/goal`, or `context/work/current-task`. Prefixes organize entries; they do not grant a separate permission boundary within a space. Describe what an entry contains, for example `UI theme preference`, rather than repeating its value `dark`.

## Shared API

All paths below are relative to your deployment origin. Deployment hosts and credentials in examples are placeholders. Memory routes require a tenant key or, on Workers, a space key in `X-Api-Key`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/summary` | Tenant/space name and live key-description index. |
| `GET` | `/memory` | Live keys; optional `?prefix=user/` filter. |
| `GET` | `/memory/search?q=...` | FTS5 search of keys and descriptions, up to 20 results. |
| `GET` | `/memory/:key` | Read one entry and update its access count. |
| `POST` / `PUT` | `/memory/:key` | Create or replace `{value, description, ttl_seconds?}`. |
| `DELETE` | `/memory/:key` | Delete one entry. |
| `POST` | `/memory/gc` | Delete expired entries belonging to the caller. |
| `GET` | `/` | Browser memory dashboard. |
| `GET` | `/health` | Public liveness check. |

Encode a memory key as one URL path component. The `GET /memory/search` and `POST /memory/gc` routes have special meanings; avoid `search` or `gc` as standalone memory keys. Values and descriptions are strings; writes replace both fields. A positive `ttl_seconds` expires an entry after that interval. Omitting TTL on an update removes its previous expiry. Expired entries are hidden from reads, lists, search, and summary until GC removes them. Times use Unix milliseconds, and an absent expiry is `null`.

The targets have some input-validation differences; consult the [Worker guide](walle-memory-worker/README.md#security-and-compatibility-differences) before moving an existing client.

### Tenant administration

Both targets support these routes with the administrator `API_KEY` in `X-Api-Key`. With no configured key, administrator routes return 503; with an incorrect or missing key, they return 401.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/admin/tenants` | Create `{name}`; return a tenant and its one-time `api_key`. |
| `GET` | `/admin/tenants` | List tenant metadata without key material. |
| `DELETE` | `/admin/tenants/:id` | Delete a tenant and all of its memory. |

Tenant API keys are random 24-byte values. Only SHA-256 hashes are stored, and the creation response reveals the raw key once. The Worker adds scoped keys with `read`, `write`, `delete`, and `gc` permissions, expiry, and revocation.

```http
POST /admin/tenants
Content-Type: application/json
X-Api-Key: <ADMIN_KEY>

{"name":"example-tenant"}
```

Save a newly returned key privately. Do not include real keys in commands, repository files, ordinary chat, or logs. The browser dashboard at `/` stores its entered memory key in same-origin localStorage; use it only on a trusted device and origin. Use `/account` to manage Worker accounts and scoped keys.

## Run the Docker / Node target

The Dockerfile uses Node 22. Compose builds a local image by default, mounts `/data/walle-memory` on the host into `/app/data`, and maps port 3800. Review those paths and set `WALLE_MEMORY_IMAGE` if you use your own registry image.

Set the Compose administrator variable yourself. For example, in an interactive Bash terminal, this prompts without putting the key into a command argument or shell history:

```bash
read -r -s -p 'Admin API key: ' WALLE_MEMORY_API_KEY
export WALLE_MEMORY_API_KEY
mkdir -p /data/walle-memory
docker compose up -d --build
```

Open `/` on your deployment host. Create tenants using the administrator API; there is no account page in this target. Missing `WALLE_MEMORY_API_KEY` leaves administrator routes closed.

To build an image for your own registry, replace the registry placeholder:

```sh
docker build --platform linux/amd64 \
  -f walle-memory-server/Dockerfile \
  -t "<YOUR_REGISTRY>/walle-memory:latest" .
docker push "<YOUR_REGISTRY>/walle-memory:latest"
```

For local development, use Node 22 and a local-only administrator value supplied through `API_KEY` in your environment:

```sh
cd walle-memory-server
npm ci
npm run build
DB_PATH=./data/memory.db PORT=3800 npm start
```

| Node environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3800` | HTTP listen port. |
| `DB_PATH` | `walle-memory-server/data/memory.db` | SQLite file. |
| `API_KEY` | Unset | Administrator key; Compose supplies it from `WALLE_MEMORY_API_KEY`. |

The Node target uses a SQLite file in WAL mode, FTS5 triggers, and startup schema initialization. Use a SQLite-consistent backup method; copying only the main file while writes are active can omit WAL data. D1 migration files do not apply to this database.

## Run the Workers target

Follow [walle-memory-worker/README.md](walle-memory-worker/README.md) for local D1 development, fresh deployment, and incremental migrations. Remote deployment requires your own Cloudflare account and database binding. The checked-in database ID is a placeholder; store the administrator key using the supported interactive Wrangler secrets flow.

## Local Codex skill

[`skills/walle-memory-profiles/`](skills/walle-memory-profiles/SKILL.md) contains a Python standard-library client that requires an explicit `--user` profile alias. Each alias references one space key in macOS Keychain. The server selects the space from that key; the alias is not an account identity or a cross-space access parameter. Missing profiles or credentials fail without selecting another user.

The skill supports list, get, put, search, summary, delete, and expired-entry GC. Delete and GC require an explicit local target confirmation and their respective server scopes. It rejects redirects, key arguments, and plaintext credential fallbacks. See its [setup guide](skills/walle-memory-profiles/references/setup.md) for installation and user-entered Keychain enrollment. Installation alone does not configure profile mappings or authorize saving/using real keys. A local skill does not automatically become a cloud tool; other devices need access to a task running on the Mac or a separately configured connection.

The repository includes 58 standard-library mock tests under [`tests/`](tests/) for profile isolation, credential failures, sanitization, Keychain behavior, and redirect refusal. They use synthetic credentials and local HTTP fixtures. [Validation commands](docs/VALIDATION.md) cover the two service targets and skill; run them in the stated runtimes before claiming a new result.

## MCP Apps 工作台候选版

Walle Memory 工作台、多 workspace OAuth 授权和日常场景说明已部署到公网。实现及使用见 [工作台说明](docs/WORKBENCH_MCP_APPS.md)，本次发布与验收边界见 [公开变更与验证摘要](docs/PUBLIC_CHANGE_SUMMARY.md)。
