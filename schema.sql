CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  agent TEXT,
  owner_agent TEXT,
  resource TEXT,
  depends_on TEXT,
  approval_required INTEGER NOT NULL DEFAULT 1,
  plan_json TEXT,
  result_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_posts (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  audience TEXT,
  objective TEXT,
  source_notes TEXT,
  research_json TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_approval',
  fb_post_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);

CREATE TABLE IF NOT EXISTS resource_locks (
  resource TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  owner_agent TEXT NOT NULL,
  acquired_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_resource ON tasks(resource);
CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks(depends_on);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_posts_created_at ON content_posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_posts_status ON content_posts(status);
CREATE INDEX IF NOT EXISTS idx_resource_locks_task_id ON resource_locks(task_id);
