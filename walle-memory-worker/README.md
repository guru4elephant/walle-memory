# walle-memory on Cloudflare Workers + D1

This directory is a separate deployment target alongside the existing [Docker / Node SQLite server](../README.md). Both share the memory dashboard, `X-Api-Key` header, memory REST paths, and millisecond timestamps. The Worker uses Web Crypto and asynchronous D1 prepared statements, without `better-sqlite3`, Node compatibility flags, or a writable filesystem.

The Worker adds `/account` login and management: one account can own multiple memory spaces, and each scoped key belongs to one space. Keys allow `read`, `write`, `delete`, and/or `gc`, with optional expiry and revocation. Only the creation response reveals a raw key. Registration defaults to administrator-created accounts. Only `REGISTRATION_MODE=invite` enables valid invitation registration; `public` and unknown values resolve to administrator mode. See [accounts and spaces](../docs/ACCOUNTS_AND_SPACES.md), [invitations](../docs/INVITATION_SIGNUP.md), and [release provenance](../docs/RELEASE_PROVENANCE.md).

`/mcp` accepts either OAuth Bearer authorization or a space key in `X-Api-Key`. OAuth retains S256 PKCE, selected workspaces, short-lived access tokens, rotating refresh tokens and connection revocation. Keys retain their single-space binding and memory scopes, with D1 transaction checks for both methods. Sending both headers is rejected. Configure the canonical `OAUTH_ISSUER` to enable either MCP method; see [bot configuration and authentication rules](../docs/MCP_API_KEY.md) and [the MCP / OAuth guide](../docs/OAUTH_MCP.md). Existing API-key REST authentication is unchanged.

## Local development

Use Node 24 LTS and npm. No Cloudflare account is needed for local development. From this directory:

```sh
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars
# Edit the ignored .dev.vars file with a local-only administrator value.
npm run db:migrate:local
npm run dev
```

Wrangler prints the local origin, normally `http://localhost:8787`. Open `/account`, create a local account with its administrator tools, then log in, create a space, and issue a scoped key. Use memory keys at `/`; the administrator key only authorizes `/admin/`. `.dev.vars` and local D1 state under `.wrangler/` are ignored by Git. To test invitation registration locally, set `REGISTRATION_MODE=invite` in `.dev.vars`.

```sh
npm test
```

The test command runs type checking, a `wrangler deploy --dry-run` build, and Miniflare/workerd tests with an ephemeral D1 database and synthetic credentials. It does not publish, use your development database, or access production. Tests cover memory CRUD/FTS/TTL/GC, tenant isolation, access counters, input bounds, account ownership, key scopes and lifecycle, session/CSRF protection, migration preservation, rate limits, concurrent claims, and invitation redemption rollback. See [validation commands](../docs/VALIDATION.md) for both service targets, optional browser fixtures, and the 58 mock tests for the local skill.

## Deploy a fresh instance

These steps create remote resources and publish a Worker. Use your intended Cloudflare account and confirm the configuration before running them. Hosts, database identifiers, and credentials must come from your own deployment; the checked-in database ID is an unusable placeholder.

1. Authenticate with a supported Wrangler login flow.
2. Choose Worker and database names; review `name`, `database_name`, and the `DB` binding in `wrangler.jsonc`.
3. Create a new database with `npx wrangler d1 create "<YOUR_DATABASE_NAME>"`.
4. Set its returned `database_id` in your deployment configuration.
5. Apply the migrations to this fresh database with `npm run db:migrate:remote`.
6. Save the administrator key with `npx wrangler secret put API_KEY`, entering it yourself at the interactive prompt, or use Cloudflare's supported dashboard flow.
7. Publish with `npm run deploy`. Set `REGISTRATION_MODE=invite` only if invitation registration is intended; otherwise leave it unset or use `admin`.
8. Verify `/health`, `/`, `/account`, configured registration mode, authorization, and CRUD/search/isolation with disposable test data before storing memories.

If storing the secret first requires an existing Worker, initially publish without it; administrator routes remain closed with 503. Then save the secret and verify them. Do not place the key in ordinary Worker variables, shell command arguments, or repository files. These instructions do not change plans or enable paid services automatically.

## Existing D1 database upgrades

Inspect the actual schema and migration history before applying anything. Back up using an appropriate tested D1 recovery method. These D1 migrations are unrelated to the Node target's startup schema.

- [0001_initial.sql](migrations/0001_initial.sql) creates the original tenant, memory, and FTS schema for a fresh database.
- [0002_accounts_spaces_keys.sql](migrations/0002_accounts_spaces_keys.sql) adds accounts, sessions, scoped keys, rate-limit state, and tenant ownership metadata. Existing tenant IDs, key hashes, memory, access counters, TTL, and FTS survive. Existing tenants remain unowned with their legacy keys active until explicitly claimed or revoked; this migration does not create accounts or credentials.
- [0003_registration_invitations.sql](migrations/0003_registration_invitations.sql) adds the invitation table and two indexes. It does not create invitations or modify existing accounts, spaces, memories, sessions, or keys.
- [0004_oauth.sql](migrations/0004_oauth.sql) adds OAuth client, consent, grant, code, and token state. It does not create credentials or modify existing application data. Apply only this missing increment to an already upgraded database; see [OAuth migration boundaries](../docs/OAUTH_MCP.md#增量迁移与后续上线).

If a schema was previously applied manually, its presence does not imply that Wrangler's `d1_migrations` history records it. Reconcile that history before using the full migration directory. Apply only missing, reviewed changes; do not replay `0001` or `0002` over existing tables, or rerun `0003` after it is present. The [account migration guide](../docs/ACCOUNTS_AND_SPACES.md#6-d1-增量迁移与回滚限制) describes preservation and rollback limits. Deployment-specific historical facts are recorded separately in [release provenance](../docs/RELEASE_PROVENANCE.md).

Importing another SQLite database requires an explicit ownership mapping and FTS rebuild plan. Do not import FTS shadow tables blindly.

## Security and compatibility differences

- Administrator routes return 503 when `API_KEY` is missing/blank, or 401 for a wrong/missing key when configured. `/health`, `/`, and `/account` are public surfaces without embedded memory data or credentials.
- Legacy keys contain 24 random bytes; scoped keys use `wmk_` plus 32 random bytes. Only SHA-256 hashes are stored. Legacy revocation replaces its hash irreversibly so an old implementation cannot accept the revoked raw key by hash lookup.
- Memory authorization derives the space from the key. A username, space ID, or account cookie cannot select another space. Scoped mutations recheck key scope, expiry, revocation, and account status inside their D1 transaction.
- Deleting a tenant/space cascades to its memory and key metadata, including FTS cleanup. Revoking a key does not delete memory. GC removes only the caller's expired rows.
- Prefix matching is literal and case-sensitive, including `%` and `_`; long prefixes avoid D1's `LIKE`/`GLOB` pattern-size limit. The current Node target also uses literal, case-sensitive prefixes.
- FTS searches keys and descriptions only. Access-counter updates do not rebuild the FTS index. `/memory` and `/summary` return the entire live index without pagination.
- Malformed JSON objects, URL encodings, and FTS queries return controlled 400 errors. Invalid TTLs return 400. Positive fractional seconds are accepted; omitting TTL on an upsert clears a prior expiry.
- Bounds: 1 MiB memory request body; 1,024-byte key/prefix; 256 KiB value; 8 KiB description; 512-byte tenant name; 2,048-byte search expression. Account request bodies are limited to 16 KiB.
- Responses use `Cache-Control: no-store`. Dashboards include CSP/anti-framing headers and quote escaping. `/` stores the entered memory key in localStorage; `/account` uses an HttpOnly session and clears one-time keys on close, logout, or leaving the page. Failed mutations are not replayed with a replacement key.
- Memory requests are limited to 300/minute per key. Login, registration, space creation, key issuance, and invitation issuance have separate D1 counters. Budget these writes alongside memory and FTS writes.
- `/health` checks liveness, not D1 readiness or authenticated business behavior. Test a database-backed route after migrations.

## D1 operations and limits

Consult Cloudflare's current [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and [pricing](https://developers.cloudflare.com/d1/platform/pricing/) for your plan. Indexes, FTS triggers, successful reads that update access metadata, and rate-limit counters all contribute to storage or query usage. Load-test expected workloads and account for quota errors.

D1 `batch()` provides the transaction boundary for guarded memory changes and invitation redemption. Do not insert SQL `BEGIN`/`COMMIT` into Worker requests; see [D1 database transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/).

This schema uses FTS5 virtual tables. Review the current [export restrictions](https://developers.cloudflare.com/d1/best-practices/import-export-data/) before treating a full SQL export as a backup. Verify a logical base-table backup and FTS rebuild, or use [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) within its supported retention window. Removing FTS for an export interrupts search and requires coordinated recreation of its table, triggers, and index. Restoring older data can also restore obsolete credential state; review key revocation and sessions as part of recovery.
