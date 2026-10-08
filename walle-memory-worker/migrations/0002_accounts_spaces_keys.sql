-- Incremental migration for the deployed Workers/D1 schema from 0001_initial.sql.
-- Existing tenants retain their names, memory, and legacy key hashes. They remain
-- unowned until an administrator explicitly assigns one to an account.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations >= 100000),
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
);
-- statement-breakpoint
ALTER TABLE tenants ADD COLUMN owner_account_id TEXT REFERENCES accounts(id);
-- statement-breakpoint
ALTER TABLE tenants ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
-- statement-breakpoint
ALTER TABLE tenants ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'general';
-- statement-breakpoint
ALTER TABLE tenants ADD COLUMN legacy_key_revoked_at INTEGER;
-- statement-breakpoint
UPDATE tenants SET display_name = name;
-- statement-breakpoint
CREATE INDEX tenants_owner ON tenants(owner_account_id, created_at);
-- statement-breakpoint
CREATE TABLE account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE INDEX account_sessions_expiry ON account_sessions(expires_at);
-- statement-breakpoint
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  scopes TEXT NOT NULL CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER
);
-- statement-breakpoint
CREATE INDEX api_keys_space ON api_keys(space_id, account_id, created_at);
-- statement-breakpoint
CREATE TABLE auth_rate_limits (
  bucket_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  expires_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);
