-- Opt-in invitation registration. Existing accounts, tenants and keys are unchanged.
CREATE TABLE registration_invitations (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER CHECK (expires_at IS NULL OR
    (typeof(expires_at) = 'integer' AND expires_at > created_at)),
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (typeof(max_uses) = 'integer' AND max_uses BETWEEN 1 AND 1000),
  uses INTEGER NOT NULL DEFAULT 0 CHECK (typeof(uses) = 'integer' AND uses BETWEEN 0 AND max_uses),
  revoked_at INTEGER,
  -- Server-generated nonce gates the account INSERT inside the same D1 batch.
  -- Never return this receipt or code_hash in an API response.
  last_redemption_id TEXT
);
-- statement-breakpoint
CREATE INDEX registration_invitations_active ON registration_invitations(revoked_at, expires_at);
-- statement-breakpoint
CREATE INDEX registration_invitations_created ON registration_invitations(created_at);
