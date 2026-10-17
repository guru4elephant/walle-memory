-- Records changes from both REST and MCP. Access-counter updates do not log changes.
-- History begins at this migration; earlier entries retain their last updated_at only.
CREATE TABLE memory_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('created','updated','deleted')),
  description TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE INDEX memory_changes_tenant_time ON memory_changes(tenant_id, changed_at DESC, id DESC);
-- statement-breakpoint
CREATE TRIGGER memory_changes_insert AFTER INSERT ON memory BEGIN
  INSERT INTO memory_changes(tenant_id,key,operation,description,changed_at)
  VALUES(NEW.tenant_id,NEW.key,'created',NEW.description,NEW.updated_at);
END;
-- statement-breakpoint
CREATE TRIGGER memory_changes_update AFTER UPDATE OF value,description,expires_at ON memory BEGIN
  INSERT INTO memory_changes(tenant_id,key,operation,description,changed_at)
  VALUES(NEW.tenant_id,NEW.key,'updated',NEW.description,NEW.updated_at);
END;
-- statement-breakpoint
CREATE TRIGGER memory_changes_delete AFTER DELETE ON memory BEGIN
  INSERT INTO memory_changes(tenant_id,key,operation,description,changed_at)
  SELECT OLD.tenant_id,OLD.key,'deleted',OLD.description,
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id);
END;
-- statement-breakpoint
CREATE INDEX memory_workspace_updates ON memory(tenant_id,updated_at DESC,key);
