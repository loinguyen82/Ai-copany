-- Apply once to an existing D1 database created before coordination fields existed.
ALTER TABLE tasks ADD COLUMN owner_agent TEXT;
ALTER TABLE tasks ADD COLUMN resource TEXT;
ALTER TABLE tasks ADD COLUMN depends_on TEXT;
ALTER TABLE tasks ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS resource_locks (
  resource TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner_agent TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_resource ON tasks(resource);
CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks(depends_on);
CREATE INDEX IF NOT EXISTS idx_resource_locks_task_id ON resource_locks(task_id);
