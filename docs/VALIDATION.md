# Local validation

For the OAuth/MCP extension, see the [implementation guide](OAUTH_MCP.md) and
[公开变更与验证摘要](PUBLIC_CHANGE_SUMMARY.md).

These commands reproduce the repository's local checks. They are instructions,
not a record of a completed run. Record the commit, runtime versions, commands,
and results when validating a release. No production key, account, database, or
Keychain item is needed for the automated suites.

## Node / SQLite target

Use Node 22, matching [the Dockerfile](../walle-memory-server/Dockerfile). A native
`better-sqlite3` installation must match the active Node runtime; switching Node
versions requires reinstalling dependencies. From the repository root:

```sh
cd walle-memory-server
node --version
npm ci
npm test
```

`npm test` compiles TypeScript and runs the regression suite with an isolated
SQLite database, local HTTP server, and synthetic administrator/tenant keys.
It checks administrator fail-closed behavior, tenant isolation, scoped expired
entry GC, and dashboard handling. It does not deploy or open a production DB.

An optional container build uses the same Node 22 Dockerfile; it does not push an
image or start a service:

```sh
docker build --platform linux/amd64 \
  -f walle-memory-server/Dockerfile \
  -t walle-memory:validation .
```

Run that command from the repository root, rather than the server directory.

## Workers / D1 target

Use Node 24 LTS. From the repository root:

```sh
cd walle-memory-worker
node --version
npm ci --ignore-scripts
WRANGLER_LOG_PATH="$PWD/.wrangler/validation.log" npm test
```

The package script performs TypeScript checking, a Wrangler dry-run build into
`dist/`, then the Node test runner over `test/*.test.mjs`. Tests use ephemeral
Miniflare/workerd D1 databases and synthetic credentials. They do not require
Cloudflare authentication, apply remote migrations, or publish a Worker.

Coverage includes the original tenant/memory routes, preservation across `0002`
and `0003`, FTS triggers, literal prefixes, TTL/GC, ownership, scopes, key expiry
and revocation, session/CSRF rules, rate limits, concurrent legacy claims, and
invitation redemption limits and rollback. Generated local state, bundles, and
logs are ignored; keep them out of commits.

## Local profile skill

From the repository root, use Python 3:

```sh
python3 --version
python3 -m unittest discover -s tests -v
```

The 58 standard-library tests use fake credentials, mock Keychain APIs, and
loopback HTTP fixtures. They check explicit profile selection, isolation,
credential failures, input/error sanitization, enrollment restrictions, native
adapter calls, proxy refusal, and same-origin/cross-origin redirect rejection.
They do not read an existing secret, save a real Keychain item, or call an
authenticated production route. Passing mock tests does not establish actual
Keychain ACL behavior or authorize real profile bindings.

## Optional browser flows

These flows require a separately installed compatible `playwright-cli`. Build
the Worker first with `npm run build`. Then, from the Worker directory, start a
disposable administrator-mode fixture:

```sh
node test/ui-server.mjs
```

Keep that process running. In a second terminal at the repository root, replace
`<LOCAL_FIXTURE_URL>` with its printed loopback URL:

```sh
playwright-cli -s=walle-accounts-test open "<LOCAL_FIXTURE_URL>"
playwright-cli -s=walle-accounts-test run-code --filename=walle-memory-worker/test/ui-flow.js
playwright-cli -s=walle-accounts-test close
```

Stop the fixture and start a fresh one for invitation mode:

```sh
WALLE_UI_REGISTRATION_MODE=invite node test/ui-server.mjs
```

In the repository-root terminal, open the new printed loopback URL and run:

```sh
playwright-cli -s=walle-invitation-test open "<LOCAL_FIXTURE_URL>"
playwright-cli -s=walle-invitation-test run-code --filename=walle-memory-worker/test/ui-invitation-flow.js
playwright-cli -s=walle-invitation-test close
```

Stop the fixture after the flow. Fixtures use a temporary local D1 database and
synthetic credentials; `WALLE_UI_REGISTRATION_MODE` only affects that fixture.
The UI scripts generate local screenshots after clearing one-time key fields.
Treat screenshots and browser artifacts as local evidence and exclude them from
the repository. These browser checks do not verify production login, business
data, authentication CPU usage, or durability.
