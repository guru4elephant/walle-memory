# Source provenance

The account/invitation baseline below describes PR #1 before OAuth. The local
OAuth/MCP extension starts from that PR head; its new build and validation are
recorded separately in [公开变更与验证摘要](PUBLIC_CHANGE_SUMMARY.md).
The separately authorized 2026-10-11 deployment is recorded in
[公开变更与验证摘要](PUBLIC_CHANGE_SUMMARY.md); the statements
below describe the original account/invitation PR baseline.

This change starts from repository main commit
`1a2856fd4cf807a3adfdd089bcca0f6ce793e6c2`, retaining the existing Node/SQLite
target under `walle-memory-server/`.

Workers source, migrations, configuration templates and regression tests come
from the latest invitation release source. Implementation files were compared
with the development source and match. The existing development bundle matches
the previously deployed invitation artifact exactly:

- Size: 114,263 bytes.
- SHA-256: `a1c1042b7f3b9fd37a38dce717903b6650a93aeba3edba23b0a5a1b262cb20ea`.

This is an artifact/source provenance statement, not a new deployment or a
guarantee about future live state. This PR does not deploy, alter remote D1
schema, create accounts, issue credentials or replay migrations. Production
configuration, database identifiers, recovery bookmarks, user records and
runtime logs are not committed.

`0001` bootstraps a fresh database, `0002` adds accounts/spaces/scoped keys, and
`0003` adds invitations. Existing databases must reconcile their actual schema
and migration history before applying only pending increments. Do not replay
all migrations onto a database initialized manually.

Profile skill Python scripts match the locally tested candidate; references
have been made repository-relative. Profile/secret examples are placeholders.
Tests use ephemeral databases, in-memory mock credentials and loopback endpoints.
See [validation commands](VALIDATION.md). Generated bundles, private deployment
evidence, screenshots, databases, archives and real profiles are excluded.
