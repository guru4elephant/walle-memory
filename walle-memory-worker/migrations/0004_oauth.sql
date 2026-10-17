-- OAuth credentials are opaque, hash-only, and independent of existing API keys.
-- Apply incrementally after 0003. No existing account, key or memory is rewritten.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris) AND json_type(redirect_uris) = 'array'),
  created_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE TABLE oauth_authorization_requests (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL REFERENCES account_sessions(token_hash) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  state TEXT,
  code_challenge TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  receipt TEXT
);
-- statement-breakpoint
CREATE INDEX oauth_requests_expiry ON oauth_authorization_requests(expires_at);
-- statement-breakpoint
CREATE INDEX oauth_requests_account ON oauth_authorization_requests(account_id, expires_at);
-- statement-breakpoint
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
-- statement-breakpoint
CREATE INDEX oauth_grants_account ON oauth_grants(account_id, created_at);
-- statement-breakpoint
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  receipt TEXT
);
-- statement-breakpoint
CREATE INDEX oauth_codes_expiry ON oauth_codes(expires_at);
-- statement-breakpoint
CREATE TABLE oauth_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  receipt TEXT
);
-- statement-breakpoint
CREATE INDEX oauth_refresh_grant ON oauth_refresh_tokens(grant_id);
-- statement-breakpoint
CREATE TABLE oauth_access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE INDEX oauth_access_expiry ON oauth_access_tokens(expires_at);
-- statement-breakpoint
CREATE INDEX oauth_access_grant ON oauth_access_tokens(grant_id);
