-- Additive multi-workspace grants. Existing connections keep their original default.
CREATE TABLE oauth_grant_spaces (
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (grant_id, space_id)
);
-- statement-breakpoint
INSERT INTO oauth_grant_spaces (grant_id, space_id) SELECT id, space_id FROM oauth_grants;
-- statement-breakpoint
CREATE INDEX oauth_grant_spaces_space ON oauth_grant_spaces(space_id);
