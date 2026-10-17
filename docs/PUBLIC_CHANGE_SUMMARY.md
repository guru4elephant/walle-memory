# Worker feature and validation summary

The Worker target extends the account/space baseline with OAuth authorization-code + S256 PKCE, rotating refresh tokens, revocable grants, explicit multiple-workspace consent, ten MCP tools and an MCP Apps workbench.

`POST /mcp` accepts exactly one authentication method: OAuth Bearer or a space API key in `X-Api-Key`. Both headers together are rejected. Key authority is confined to its space and existing read/write/delete/gc scopes; expiry, revocation, account status and ownership are rechecked in the D1 transaction. OAuth failure never falls back to a key. REST and administrator authority remain separate.

The existing `0004` OAuth, `0005` workspace and `0006` memory-change migrations are included as source history; publishing repository files does not apply migrations. Reconcile each deployment's actual migration history before applying increments.

Local Worker validation passes 139 tests, TypeScript checking and the UI/Worker dry-run build with synthetic credentials and temporary D1 databases. Coverage includes OAuth lifecycle, workspace and scope isolation, in-flight revocation, REST, invitations, metadata, workbench editing, TTL and dual-credential ambiguity. See [validation commands](VALIDATION.md), [OAuth setup](OAUTH_MCP.md), [API-key clients](MCP_API_KEY.md) and [workbench implementation](WORKBENCH_MCP_APPS.md).

Private production downloads, deployment configuration, operation logs, account/workspace metadata, recovery snapshots and local absolute paths are excluded from this source tree. Examples use placeholders; tests do not require production credentials or real memories.
